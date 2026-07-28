import type { SubAgentDelegationRequest, SubAgentScope } from '@ever-works/contracts';
import { SubAgentDelegationService } from '../sub-agent-delegation.service';
import type { SubAgentDelegationRunner } from '../sub-agent-delegation.port';

/**
 * Judgment layer G9 — delegation contract at the service seam.
 *
 * The pure rules (scope algebra, depth/fan-out caps) are pinned in the
 * contracts spec; this file pins the SERVICE behaviour: the runner only
 * ever sees a validated + narrowed request, an unbound runner is a typed
 * refusal, and a runner that throws or returns garbage still produces a
 * result a parent can branch on.
 */
describe('SubAgentDelegationService', () => {
    const parentScope: SubAgentScope = {
        allowedTools: ['read_file', 'write_file'],
        allowedPaths: ['packages/agent'],
        workId: 'work-1',
        organizationId: 'org-1',
        networkAccess: false,
    };

    const request = (over: Partial<SubAgentDelegationRequest> = {}): SubAgentDelegationRequest => ({
        delegationId: 'del-1',
        parentAgentId: 'agent-1',
        parentRunId: 'run-1',
        depth: 0,
        objective: 'Summarize the failing test output',
        scope: { allowedTools: ['read_file', 'deploy'] },
        ...over,
    });

    const runner = (
        impl?: SubAgentDelegationRunner['run'],
    ): SubAgentDelegationRunner & { run: jest.Mock } => ({
        run: jest.fn(
            impl ??
                (async (req: SubAgentDelegationRequest) => ({
                    delegationId: req.delegationId,
                    status: 'completed' as const,
                    summary: 'done',
                    output: { answer: 42 },
                })),
        ),
    });

    it('hands the runner the NARROWED request, never the one it was given', async () => {
        const child = runner();
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
        });
        expect(result).toMatchObject({
            delegationId: 'del-1',
            status: 'completed',
            output: { answer: 42 },
        });
        const passed = child.run.mock.calls[0][0] as SubAgentDelegationRequest;
        // `deploy` was asked for and is NOT in the parent scope — it is gone.
        expect(passed.scope.allowedTools).toEqual(['read_file']);
        expect(passed.scope.workId).toBe('work-1');
        expect(passed.scope.networkAccess).toBe(false);
    });

    it('refuses with no-runner (and never throws) when nothing is bound', async () => {
        const result = await new SubAgentDelegationService().delegate(request(), { parentScope });
        expect(result).toMatchObject({
            delegationId: 'del-1',
            status: 'refused',
            refusalCode: 'no-runner',
            output: null,
        });
    });

    it('refuses past the depth ceiling WITHOUT touching the runner', async () => {
        const child = runner();
        const result = await new SubAgentDelegationService(child).delegate(request({ depth: 3 }), {
            parentScope,
        });
        expect(result).toMatchObject({ status: 'refused', refusalCode: 'depth-exceeded' });
        expect(child.run).not.toHaveBeenCalled();
    });

    it('refuses past the sibling fan-out cap WITHOUT touching the runner', async () => {
        const child = runner();
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
            siblingCount: 5,
        });
        expect(result).toMatchObject({ status: 'refused', refusalCode: 'fanout-exceeded' });
        expect(child.run).not.toHaveBeenCalled();
    });

    it('refuses when the narrowed scope grants nothing', async () => {
        const child = runner();
        const result = await new SubAgentDelegationService(child).delegate(
            request({ scope: { allowedTools: ['deploy'] } }),
            { parentScope },
        );
        expect(result).toMatchObject({ status: 'refused', refusalCode: 'scope-empty' });
        expect(child.run).not.toHaveBeenCalled();
    });

    it('turns a thrown runner into a typed failed result', async () => {
        const child = runner(async () => {
            throw new Error('child run crashed');
        });
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
        });
        expect(result).toEqual({
            delegationId: 'del-1',
            status: 'failed',
            summary: 'child run crashed',
            output: null,
        });
    });

    it('normalizes an unknown status and a missing summary', async () => {
        const child = runner(async () => ({ status: 'weird', output: undefined }) as never);
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
        });
        expect(result).toMatchObject({
            status: 'failed',
            summary: 'delegation failed',
            output: null,
        });
    });

    it('re-stamps the delegationId so a runner cannot break correlation', async () => {
        const child = runner(async () => ({
            delegationId: 'somebody-elses-id',
            status: 'completed' as const,
            summary: 'done',
            output: {},
        }));
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
        });
        expect(result.delegationId).toBe('del-1');
    });

    it('carries an escalated result through untouched', async () => {
        const child = runner(async () => ({
            delegationId: 'del-1',
            status: 'escalated' as const,
            summary: 'needs a human',
            escalationReasonCode: 'awaiting-input' as const,
            output: null,
        }));
        const result = await new SubAgentDelegationService(child).delegate(request(), {
            parentScope,
        });
        expect(result).toMatchObject({
            status: 'escalated',
            escalationReasonCode: 'awaiting-input',
        });
    });

    it('preflights without dispatching', async () => {
        const child = runner();
        const service = new SubAgentDelegationService(child);
        expect(service.preflight(request({ depth: 9 }), { parentScope })).toMatchObject({
            ok: false,
            refusalCode: 'depth-exceeded',
        });
        expect(child.run).not.toHaveBeenCalled();
    });
});
