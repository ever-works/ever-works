import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fleetAPI` agent-affinity helpers — the endpoint shape.
 *
 * Two things are pinned. First, the path is relative to `/api` (no
 * leading `/api`), the same double-prefix guard every other `lib/api`
 * spec carries. Second, the agent id — which arrives from a Server
 * Action argument, i.e. from the browser — is encoded as ONE path
 * segment, so a crafted value carrying `/` or `..` cannot be
 * dot-segment-normalised by `fetch` onto a different `/api/*` route
 * under the caller's own bearer.
 */

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
    // Fleet hub (FL-01): the needs-a-look reader throws the API tier's error type.
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
        }
    },
}));

async function importApi() {
    return import('./fleet');
}

const AGENT_ID = '5d2f7a1e-2c4b-4c8e-9a1f-0b3c6d7e8f90';
const BINDING = {
    agentId: AGENT_ID,
    nodeId: 'node-1',
    organizationId: 'org-1',
    createdAt: null,
    updatedAt: null,
};

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue(BINDING);
    serverMutationMock.mockResolvedValue(BINDING);
});
afterEach(() => vi.resetModules());

describe('fleetAPI agent affinity — endpoint shape', () => {
    it('getAgentAffinity GETs /fleet/agents/:id/node-affinity WITHOUT a leading /api', async () => {
        const { fleetAPI } = await importApi();
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toEqual(BINDING);
        expect(serverFetchMock).toHaveBeenCalledWith(`/fleet/agents/${AGENT_ID}/node-affinity`);
    });

    /** Unbound is a JSON `null` on the wire; `serverFetch` may collapse it to `undefined`. */
    it('getAgentAffinity answers null for an unbound agent, whichever way the body arrives', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(null);
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toBeNull();
        serverFetchMock.mockResolvedValueOnce(undefined);
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toBeNull();
    });

    it('setAgentAffinity PUTs the node id to the same resource', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.setAgentAffinity(AGENT_ID, 'node-1');
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: `/fleet/agents/${AGENT_ID}/node-affinity`,
            data: { nodeId: 'node-1' },
            method: 'PUT',
            wrapInData: false,
        });
    });

    it('clearAgentAffinity DELETEs the same resource', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.clearAgentAffinity(AGENT_ID);
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: `/fleet/agents/${AGENT_ID}/node-affinity`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    });

    it('encodes the agent id as one path segment so a crafted value cannot reach another route', async () => {
        const { fleetAPI } = await importApi();
        const crafted = 'x/../../agents';
        const expected = `/fleet/agents/${encodeURIComponent(crafted)}/node-affinity`;
        expect(expected).not.toContain('/../');

        await fleetAPI.getAgentAffinity(crafted);
        expect(serverFetchMock).toHaveBeenCalledWith(expected);

        await fleetAPI.setAgentAffinity(crafted, 'node-1');
        expect(serverMutationMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ endpoint: expected, method: 'PUT' }),
        );

        await fleetAPI.clearAgentAffinity(crafted);
        expect(serverMutationMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ endpoint: expected, method: 'DELETE' }),
        );
    });
});

/**
 * Fleet hub (FL-01) — the visible-node list, the needs-a-look reads (with
 * the partial marker the API sets when a producer was skipped, spec U11)
 * and the two owner-only PATCH writes.
 */
describe('fleetAPI hub reads and writes — endpoint shape', () => {
    const response = (body: unknown, init: { status?: number; partial?: boolean } = {}) =>
        new Response(JSON.stringify(body), {
            status: init.status ?? 200,
            headers: init.partial ? { 'X-Fleet-Partial': 'true' } : {},
        });

    it('listVisibleNodes asks for scope=visible; listNodes stays owner-only', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValue([]);
        await fleetAPI.listVisibleNodes();
        expect(serverFetchMock).toHaveBeenLastCalledWith('/fleet/nodes?scope=visible');
        await fleetAPI.listNodes();
        expect(serverFetchMock).toHaveBeenLastCalledWith('/fleet/nodes');
    });

    it('needsALook reads the list and the partial marker off the raw response', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(response([{ id: 'a' }], { partial: true }));
        await expect(fleetAPI.needsALook()).resolves.toEqual({
            items: [{ id: 'a' }],
            partial: true,
        });
        expect(serverFetchMock).toHaveBeenLastCalledWith('/fleet/needs-a-look', {
            rawResponse: true,
            cache: 'no-store',
        });

        serverFetchMock.mockResolvedValueOnce(response([]));
        await expect(fleetAPI.needsALook()).resolves.toEqual({ items: [], partial: false });
    });

    it('needsALook reports an unreadable 2xx body as partial, never as a complete empty list', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
        await expect(fleetAPI.needsALook()).resolves.toEqual({ items: [], partial: true });
        serverFetchMock.mockResolvedValueOnce(response({ items: [] }));
        await expect(fleetAPI.needsALook()).resolves.toEqual({ items: [], partial: true });
    });

    it('needsALook throws on a failed read so the block can say so (U11)', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(response({ message: 'boom' }, { status: 500 }));
        await expect(fleetAPI.needsALook()).rejects.toThrow(/Could not load what needs a look/);
    });

    it('nodeNeedsALook encodes the node id as one path segment', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(response([]));
        await fleetAPI.nodeNeedsALook('x/../../nodes');
        expect(serverFetchMock).toHaveBeenLastCalledWith(
            `/fleet/nodes/${encodeURIComponent('x/../../nodes')}/needs-a-look`,
            { rawResponse: true, cache: 'no-store' },
        );
    });

    it('setFavorite and setPolicyFamilies PATCH the node with one field each', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.setFavorite('node-1', true);
        expect(serverMutationMock).toHaveBeenLastCalledWith({
            endpoint: '/fleet/nodes/node-1',
            data: { isFavorite: true },
            method: 'PATCH',
            wrapInData: false,
        });
        await fleetAPI.setPolicyFamilies('node-1', { sessions: 'org-admins' });
        expect(serverMutationMock).toHaveBeenLastCalledWith({
            endpoint: '/fleet/nodes/node-1',
            data: { controlPolicyFamilies: { sessions: 'org-admins' } },
            method: 'PATCH',
            wrapInData: false,
        });
    });
});

describe('fleetAPI node acts — Fleet hub (FL-01)', () => {
    it('removes with no body field when no typed name is sent (exactly as before)', async () => {
        const { fleetAPI } = await importApi();
        serverMutationMock.mockResolvedValue(undefined);
        await fleetAPI.deleteNode('node-1');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/fleet/nodes/node-1',
                data: {},
                method: 'DELETE',
            }),
        );
    });

    it('sends the typed name as confirmName (CONTRACTS §2.2)', async () => {
        const { fleetAPI } = await importApi();
        serverMutationMock.mockResolvedValue(undefined);
        await fleetAPI.deleteNode('node-1', { confirmName: 'build-01' });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ data: { confirmName: 'build-01' }, method: 'DELETE' }),
        );
    });

    it('encodes the node id as one path segment on read, update and remove', async () => {
        const { fleetAPI } = await importApi();
        serverMutationMock.mockResolvedValue(undefined);
        await fleetAPI.nodeDetail('../kill-switch');
        await fleetAPI.updateNode('../kill-switch', { name: 'x' });
        await fleetAPI.deleteNode('../kill-switch');
        expect(serverFetchMock).toHaveBeenCalledWith('/fleet/nodes/..%2Fkill-switch');
        for (const call of serverMutationMock.mock.calls) {
            expect((call[0] as { endpoint: string }).endpoint).toBe(
                '/fleet/nodes/..%2Fkill-switch',
            );
        }
    });
});
