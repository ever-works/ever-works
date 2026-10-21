import { FLEET_TOOL_NO_CREDITS_SENTENCE } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import {
    buildFleetCoreTools,
    decorateFleetTool,
    decorateFleetTools,
    fleetToolErrorFromThrow,
    normalizeFleetToolReply,
    redactFleetToolResult,
} from '../fleet-tool-factory';

/** FL-19 T-04 — annotations, the no-credits sentence, redaction, typed refusals, the core tools. */

const NODE_ID = '11111111-2222-4333-8444-555555555555';

function tool(name: string, invoke: TaskToolDescriptor['invoke']): TaskToolDescriptor {
    return {
        name,
        description: 'Does a thing.',
        parameters: { type: 'object', properties: {}, required: [] },
        invoke,
    };
}

describe('decorateFleetTool', () => {
    it('annotates a catalogued tool and appends the no-credits sentence (FR-2, FR-25)', () => {
        const decorated = decorateFleetTool(tool('fleet_services_action', async () => ({ ok: true })));
        expect(decorated.annotations).toEqual({
            destructive: true,
            confirmationClass: 'confirm',
            category: 'machine.admin',
            permissionFamily: 'services',
        });
        expect(decorated.description.endsWith(FLEET_TOOL_NO_CREDITS_SENTENCE)).toBe(true);
    });

    it('leaves the legacy list_fleet_nodes and non-fleet tools untouched (FR-3)', () => {
        const legacy = tool('list_fleet_nodes', async () => ({ nodes: [] }));
        const other = tool('createTask', async () => ({}));
        expect(decorateFleetTools([legacy, other])).toEqual([legacy, other]);
    });

    it('redacts secrets in every string of a result', async () => {
        const secret = 'ghp_' + 'a'.repeat(36);
        const decorated = decorateFleetTool(
            tool('fleet_logs_read', async () => ({ lines: [`token=${secret}`], nested: { value: secret } })),
        );
        const reply = JSON.stringify(await decorated.invoke({}));
        expect(reply).not.toContain(secret);
    });

    it('types a free-text refusal and a throw (FR-5)', async () => {
        const refused = decorateFleetTool(tool('fleet_ports_list', async () => ({ error: 'Fleet node x not found' })));
        expect(await refused.invoke({})).toEqual({ error: { code: 'not_found', hint: 'Fleet node x not found' } });

        const thrown = decorateFleetTool(
            tool('fleet_ports_list', async () => {
                throw Object.assign(new Error('nope'), { getStatus: () => 403 });
            }),
        );
        expect(await thrown.invoke({})).toEqual({ error: { code: 'permission_denied', hint: 'nope' } });
    });

    it('passes a typed refusal through unchanged', () => {
        const typed = { error: { code: 'consent_missing', hint: 'start it with --manage' } };
        expect(normalizeFleetToolReply(typed)).toBe(typed);
    });

    it('reads the CONTRACTS §8 envelope off an HttpException body', () => {
        const err = { getResponse: () => ({ error: { code: 'busy', hint: 'Ana holds control', details: { who: 'Ana' } } }) };
        expect(fleetToolErrorFromThrow(err)).toEqual({
            error: { code: 'busy', hint: 'Ana holds control', details: { who: 'Ana' } },
        });
    });

    it('keeps non-string values and dates as they are', () => {
        const at = new Date('2026-10-21T00:00:00Z');
        expect(redactFleetToolResult({ n: 1, b: true, at, list: [1, 'x'] })).toEqual({ n: 1, b: true, at, list: [1, 'x'] });
    });
});

describe('buildFleetCoreTools', () => {
    const nodes = [
        { id: NODE_ID, name: 'build-01', kind: 'node', status: 'online', viewerRole: 'owner' },
        { id: 'n2', name: 'shared-mac', kind: 'desktop-node', status: 'offline', viewerRole: 'org-member' },
    ];
    const service = {
        listVisibleForUser: jest.fn().mockResolvedValue(nodes),
        getVisibleForUser: jest.fn().mockResolvedValue({ view: nodes[0], role: 'owner' }),
    };

    it('offers fleet_status and the operations tools only when their ports are bound', () => {
        const bare = buildFleetCoreTools({ userId: 'u1', agentId: 'a1', service: service as never }).map((t) => t.name);
        expect(bare).toEqual(['fleet_nodes_list', 'fleet_nodes_get']);
        const full = buildFleetCoreTools({
            userId: 'u1',
            agentId: 'a1',
            service: service as never,
            status: { status: jest.fn() },
            operations: { get: jest.fn(), listForUser: jest.fn() },
        }).map((t) => t.name);
        expect(full).toEqual([
            'fleet_status',
            'fleet_nodes_list',
            'fleet_nodes_get',
            'fleet_operations_get',
            'fleet_operations_list',
        ]);
    });

    it('answers fleet_status as the Agent owner', async () => {
        const status = { status: jest.fn().mockResolvedValue({ computers: [] }) };
        const [statusTool] = buildFleetCoreTools({ userId: 'owner-9', agentId: 'a1', service: service as never, status });
        await statusTool.invoke({});
        expect(status.status).toHaveBeenCalledWith('owner-9');
    });

    it('filters fleet_nodes_list by scope, kind and status and refuses bad filters', async () => {
        const list = buildFleetCoreTools({ userId: 'u1', agentId: 'a1', service: service as never })[0];
        expect(await list.invoke({ scope: 'own' })).toEqual({ nodes: [nodes[0]], total: 1 });
        expect(await list.invoke({ status: 'offline' })).toEqual({ nodes: [nodes[1]], total: 1 });
        expect(await list.invoke({ kind: 'robot' })).toMatchObject({ error: { code: 'invalid' } });
    });

    it('refuses a malformed node id before any read', async () => {
        const get = buildFleetCoreTools({ userId: 'u1', agentId: 'a1', service: service as never })[1];
        service.getVisibleForUser.mockClear();
        expect(await get.invoke({ nodeId: 'build-01' })).toMatchObject({ error: { code: 'invalid' } });
        expect(service.getVisibleForUser).not.toHaveBeenCalled();
        expect(await get.invoke({ nodeId: NODE_ID })).toEqual({ node: nodes[0], role: 'owner' });
    });

    it('reports every operation state and whether it finished', async () => {
        const operations = {
            get: jest.fn().mockReturnValue({ id: 'op1', state: 'interrupted' }),
            listForUser: jest.fn().mockReturnValue([]),
        };
        const tools = buildFleetCoreTools({ userId: 'u1', agentId: 'a1', service: service as never, operations });
        const get = tools.find((t) => t.name === 'fleet_operations_get')!;
        const list = tools.find((t) => t.name === 'fleet_operations_list')!;
        expect(await get.invoke({ operationId: 'op1' })).toEqual({
            operation: { id: 'op1', state: 'interrupted' },
            finished: true,
        });
        expect(operations.get).toHaveBeenCalledWith('op1', 'u1');
        await list.invoke({ state: 'cancelled', limit: 500 });
        expect(operations.listForUser).toHaveBeenCalledWith('u1', { state: 'cancelled', limit: 100 });
        expect(await list.invoke({ state: 'paused' })).toMatchObject({ error: { code: 'invalid' } });
    });
});
