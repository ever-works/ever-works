import type { FleetCommandView } from '@ever-works/contracts';
import { buildFleetCommandTools, FLEET_COMMAND_PROPOSAL_KIND } from '../agent-fleet-command-tools';
import { fleetCommandError } from '../fleet-command.errors';
import { FleetCommandProposalListener } from '../fleet-command-proposal.listener';

/**
 * FL-12 P2 (spec FR-20, S5, CONTRACTS R-33) — the Agent's `commands` tools:
 * a run is NEVER executed by the tool (it is held for the owner's approval,
 * and refused when there is no approval queue); the reads see only
 * Agent-requested Commands; an approval by a person — and only a person —
 * runs exactly the held command as the Agent.
 */

const NODE = '11111111-1111-4111-8111-111111111111';

function view(over: Partial<FleetCommandView> = {}): FleetCommandView {
    return {
        id: 'c1',
        userId: 'u1',
        command: 'uptime',
        commandRedacted: false,
        cwd: null,
        timeoutSec: 600,
        requestedBy: 'agent',
        state: 'done',
        nodeIds: [NODE],
        createdAt: '2026-10-21T10:00:00.000Z',
        updatedAt: '2026-10-21T10:00:01.000Z',
        runs: [],
        summary: { total: 0, running: 0, succeeded: 0, failed: 0, timedOut: 0, longestMs: 0 },
        ...over,
    };
}

function tools(overrides: { proposals?: unknown; service?: Record<string, jest.Mock> } = {}) {
    const service = {
        listRecent: jest.fn().mockResolvedValue({ commands: [view()] }),
        get: jest.fn().mockResolvedValue(view()),
        cancel: jest.fn().mockResolvedValue(view({ state: 'cancelled' })),
        ...(overrides.service ?? {}),
    };
    const proposals =
        overrides.proposals === undefined
            ? { propose: jest.fn().mockResolvedValue({ id: 'p1', status: 'pending' }) }
            : overrides.proposals;
    const list = buildFleetCommandTools({
        userId: 'u1',
        agentId: 'a1',
        runId: 'r1',
        service: service as never,
        proposals: proposals as never,
    });
    const byName = (name: string) => list.find((tool) => tool.name === name)!;
    return { service, proposals: proposals as { propose: jest.Mock } | null, byName };
}

describe('fleet_commands_run', () => {
    it('holds the command for the owner instead of running it', async () => {
        const { byName, proposals, service } = tools();
        const result = await byName('fleet_commands_run').invoke({ nodeIds: [NODE], command: 'df -h', timeoutSec: 60 });
        expect(result).toMatchObject({ held: true, proposalId: 'p1' });
        expect(proposals!.propose).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                agentId: 'a1',
                runId: 'r1',
                payload: {
                    kind: FLEET_COMMAND_PROPOSAL_KIND,
                    agentId: 'a1',
                    command: 'df -h',
                    nodeIds: [NODE],
                    timeoutSec: 60,
                },
            }),
        );
        expect(service.get).not.toHaveBeenCalled();
    });

    it('refuses (never runs) without an approval queue', async () => {
        const { byName } = tools({ proposals: null });
        expect(await byName('fleet_commands_run').invoke({ nodeIds: [NODE], command: 'df -h' })).toMatchObject({
            error: { code: 'confirmation_required' },
        });
    });

    it('refuses an empty command and too many computers', async () => {
        const { byName } = tools();
        expect(await byName('fleet_commands_run').invoke({ nodeIds: [NODE], command: '  ' })).toMatchObject({
            error: { code: 'invalid' },
        });
        const many = Array.from({ length: 51 }, (_, index) => `n${index}`);
        expect(await byName('fleet_commands_run').invoke({ nodeIds: many, command: 'ls' })).toMatchObject({
            error: { code: 'limit_exceeded' },
        });
    });
});

describe('the reads and the cancel', () => {
    it('lists only Agent-requested Commands', async () => {
        const { byName, service } = tools();
        await byName('fleet_commands_list').invoke({ limit: 3 });
        expect(service.listRecent).toHaveBeenCalledWith({ userId: 'u1', agentId: 'a1' }, 3, { requestedBy: 'agent' });
    });

    it('treats a Command a person ran as unknown', async () => {
        const { byName, service } = tools({
            service: { get: jest.fn().mockResolvedValue(view({ requestedBy: 'user' })) },
        });
        expect(await byName('fleet_commands_get').invoke({ commandId: 'c1' })).toMatchObject({
            error: { code: 'not_found' },
        });
        expect(await byName('fleet_commands_cancel').invoke({ commandId: 'c1' })).toMatchObject({
            error: { code: 'not_found' },
        });
        expect(service.cancel).not.toHaveBeenCalled();
    });

    it('carries the service refusal', async () => {
        const { byName } = tools({
            service: { get: jest.fn().mockRejectedValue(fleetCommandError('not_found', 'no such command')) },
        });
        expect(await byName('fleet_commands_get').invoke({ commandId: 'c9' })).toEqual({
            error: { code: 'not_found', hint: 'no such command' },
        });
    });
});

describe('FleetCommandProposalListener', () => {
    const event = (over: Record<string, unknown> = {}) =>
        ({
            proposalId: 'p1',
            userId: 'u1',
            agentId: 'a1',
            actionType: 'other',
            status: 'approved',
            decidedVia: 'user',
            decidedById: 'u1',
            payload: { kind: FLEET_COMMAND_PROPOSAL_KIND, agentId: 'a1', command: 'uptime', nodeIds: [NODE] },
            ...over,
        }) as never;

    it('runs the approved command as the Agent, confirmed', async () => {
        const run = jest.fn().mockResolvedValue(view());
        await new FleetCommandProposalListener({ run } as never).handleProposalDecided(event());
        expect(run).toHaveBeenCalledWith(
            { userId: 'u1', agentId: 'a1' },
            { command: 'uptime', nodeIds: [NODE], confirm: true },
        );
    });

    it('does nothing for a rejection, a guardrail decision, another kind or another Agent', async () => {
        const run = jest.fn();
        const listener = new FleetCommandProposalListener({ run } as never);
        await listener.handleProposalDecided(event({ status: 'rejected' }));
        await listener.handleProposalDecided(event({ decidedVia: 'guardrail', decidedById: null }));
        await listener.handleProposalDecided(event({ payload: { kind: 'fleet-machine-action' } }));
        await listener.handleProposalDecided(
            event({ payload: { kind: FLEET_COMMAND_PROPOSAL_KIND, agentId: 'a2', command: 'uptime', nodeIds: [NODE] } }),
        );
        expect(run).not.toHaveBeenCalled();
    });
});
