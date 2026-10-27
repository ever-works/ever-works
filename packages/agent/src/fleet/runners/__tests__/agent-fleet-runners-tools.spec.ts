import { fleetActionsRunnerInstallSummary } from '@ever-works/contracts';
import { fleetMachineError } from '../../machine/fleet-machine.errors';
import { buildFleetRunnersTools, FLEET_RUNNERS_ACTION_PROPOSAL_KIND } from '../agent-fleet-runners-tools';

/**
 * Actions runners on computers (FL-18, T-19, spec FR-29, FR-30, S8) — the
 * Agent tools: an install, a stop, a restart and a remove are HELD as an
 * approval titled with the confirmation's own sentence (target, count, mode,
 * computer, "no credits are spent"), never run by the Agent; a start runs at
 * once; a refusal other than the confirmation is the tool's answer; without an
 * approval queue a held act fails closed.
 */

const OWNER = 'owner-1';
const AGENT = 'agent-1';

function tools(opts: { proposals?: boolean } = {}) {
    const summary = fleetActionsRunnerInstallSummary({ count: 2, target: 'acme/api', mode: 'service', computer: 'build-01' });
    const service = {
        list: jest.fn(async () => ({ node: { id: 'n', name: 'build-01' }, runners: [] })),
        listAll: jest.fn(async () => []),
        install: jest.fn(async () => {
            throw fleetMachineError('confirmation_required', 'send confirm: true to confirm', { class: 'confirm', summary });
        }),
        control: jest.fn(async (_caller: unknown, _node: string, _runner: string, action: string) => {
            if (action === 'start') return { runnerId: 'r', operationId: 'job-1', jobId: 'job-1' };
            if (action === 'remove') {
                throw fleetMachineError('confirmation_required', 'type build-01-1 to confirm', {
                    class: 'confirm-destructive',
                    summary: 'Remove build-01-1? Deregisters it from acme/api, uninstalls the service and deletes its folder on build-01.',
                });
            }
            throw fleetMachineError('confirmation_required', 'send confirm: true to confirm', {
                class: 'confirm',
                summary: 'Stop build-01-1? It stops taking jobs until you start it. A job in progress finishes first.',
            });
        }),
    };
    const proposals = {
        propose: jest.fn(async () => ({ id: 'proposal-1', status: 'pending' as const })),
    };
    const built = buildFleetRunnersTools({
        userId: OWNER,
        agentId: AGENT,
        runId: 'run-1',
        service: service as never,
        proposals: opts.proposals === false ? null : (proposals as never),
    });
    const byName = new Map(built.map((tool) => [tool.name, tool]));
    return { byName, service, proposals, summary };
}

describe('fleet_runners_* Agent tools (FL-18 P1)', () => {
    it('offers list, install, action and remove', () => {
        expect([...tools().byName.keys()]).toEqual([
            'fleet_runners_list',
            'fleet_runners_install',
            'fleet_runners_action',
            'fleet_runners_remove',
        ]);
    });

    it('holds an install as an approval titled with target, count, mode, computer and "no credits are spent"', async () => {
        const { byName, proposals, service, summary } = tools();
        const answer = await byName.get('fleet_runners_install')!.invoke({
            nodeId: 'node-1',
            scope: 'repo',
            target: 'acme/api',
            count: 2,
        });
        expect(answer).toMatchObject({ held: true, proposalId: 'proposal-1' });
        expect(service.install).toHaveBeenCalledWith(
            { kind: 'agent', agentId: AGENT, ownerUserId: OWNER },
            'node-1',
            expect.objectContaining({ fields: {} }),
        );
        const call = (proposals.propose.mock.calls[0] as unknown[])[1] as { title: string; payload: Record<string, unknown> };
        expect(call.title).toBe(summary);
        expect(call.title).toContain('acme/api');
        expect(call.title).toContain('build-01');
        expect(call.title).toContain('2 Actions runners');
        expect(call.title).toContain('as services');
        expect(call.title).toContain('no credits are spent');
        expect(call.payload).toMatchObject({ kind: FLEET_RUNNERS_ACTION_PROPOSAL_KIND, verb: 'install', agentId: AGENT, nodeId: 'node-1' });
    });

    it('runs a start at once and holds a stop and a remove', async () => {
        const { byName, proposals } = tools();
        expect(await byName.get('fleet_runners_action')!.invoke({ nodeId: 'n', runnerId: 'r', action: 'start' })).toMatchObject({
            jobId: 'job-1',
        });
        expect(await byName.get('fleet_runners_action')!.invoke({ nodeId: 'n', runnerId: 'r', action: 'stop' })).toMatchObject({
            held: true,
        });
        expect(
            await byName.get('fleet_runners_remove')!.invoke({ nodeId: 'n', runnerId: 'r', name: 'build-01-1' }),
        ).toMatchObject({ held: true });
        expect(proposals.propose).toHaveBeenCalledTimes(2);
    });

    it('answers a refusal that is not the confirmation (the act is never held)', async () => {
        const { byName, service, proposals } = tools();
        service.install.mockRejectedValueOnce(fleetMachineError('kill_switch', 'clear it under Settings → Fleet'));
        expect(
            await byName.get('fleet_runners_install')!.invoke({ nodeId: 'n', scope: 'repo', target: 'acme/api' }),
        ).toMatchObject({ error: { code: 'kill_switch' } });
        expect(proposals.propose).not.toHaveBeenCalled();
    });

    it('fails closed without an approval queue, and validates its arguments', async () => {
        const { byName } = tools({ proposals: false });
        expect(
            await byName.get('fleet_runners_install')!.invoke({ nodeId: 'n', scope: 'repo', target: 'acme/api' }),
        ).toMatchObject({ error: { code: 'confirmation_required' } });
        expect(await byName.get('fleet_runners_install')!.invoke({ nodeId: 'n', scope: 'repo', target: 'not a repo' })).toMatchObject({
            error: { code: 'invalid' },
        });
        expect(await byName.get('fleet_runners_action')!.invoke({ nodeId: 'n', runnerId: 'r', action: 'remove' })).toMatchObject({
            error: { code: 'invalid' },
        });
    });
});
