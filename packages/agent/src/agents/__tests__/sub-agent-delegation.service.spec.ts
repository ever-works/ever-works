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

    /**
     * Server-derived depth (judgment layer G9).
     *
     * The depth ceiling was inert in production: it is evaluated against
     * `request.depth`, which every caller declared as 0, so
     * `depth >= maxDepth` could never be true. The resolver is what makes
     * the cap real — and the direction of its authority is the thing that
     * must not be got backwards.
     */
    describe('depth resolution', () => {
        const resolver = (value: number | null | Promise<never>) => ({
            resolveDepth: jest
                .fn()
                .mockImplementation(() =>
                    value instanceof Promise ? value : Promise.resolve(value),
                ),
        });

        it('RAISES a caller-declared 0 to the resolved depth and refuses', async () => {
            // The whole attack: a caller that declares 0 on every hop.
            const child = runner();
            const service = new SubAgentDelegationService(child, resolver(3));

            const result = await service.delegate(request({ depth: 0 }), { parentScope });

            expect(result).toMatchObject({ status: 'refused', refusalCode: 'depth-exceeded' });
            expect(child.run).not.toHaveBeenCalled();
        });

        it('NEVER lowers a declared depth', async () => {
            // A stale or wrong resolver reading must not remove a bound the
            // caller honestly declared.
            const child = runner();
            const service = new SubAgentDelegationService(child, resolver(0));

            const result = await service.delegate(request({ depth: 3 }), { parentScope });

            expect(result).toMatchObject({ status: 'refused', refusalCode: 'depth-exceeded' });
            expect(child.run).not.toHaveBeenCalled();
        });

        it('passes the RAISED depth through to the runner on an admitted delegation', async () => {
            const child = runner();
            const service = new SubAgentDelegationService(child, resolver(2));

            await service.delegate(request({ depth: 0 }), { parentScope });

            const passed = child.run.mock.calls[0][0] as SubAgentDelegationRequest;
            // The child must be stamped one deeper than the TRUE depth, not
            // one deeper than the fiction the caller sent.
            expect(passed.depth).toBe(2);
        });

        it('leaves the request untouched when the depth is unresolvable', async () => {
            const child = runner();
            const service = new SubAgentDelegationService(child, resolver(null));

            await service.delegate(request({ depth: 1 }), { parentScope });

            const passed = child.run.mock.calls[0][0] as SubAgentDelegationRequest;
            expect(passed.depth).toBe(1);
        });

        it('treats a throwing resolver as unresolvable rather than an error', async () => {
            // A resolver outage must not convert a delegation into a
            // failure — the declared depth simply stands.
            const child = runner();
            const service = new SubAgentDelegationService(child, {
                resolveDepth: jest.fn().mockRejectedValue(new Error('db down')),
            });

            const result = await service.delegate(request({ depth: 0 }), { parentScope });

            expect(result).toMatchObject({ status: 'completed' });
            expect(child.run).toHaveBeenCalled();
        });

        it('ignores a nonsense resolved depth', async () => {
            const child = runner();
            const service = new SubAgentDelegationService(child, resolver(-4 as number));

            await service.delegate(request({ depth: 1 }), { parentScope });

            const passed = child.run.mock.calls[0][0] as SubAgentDelegationRequest;
            expect(passed.depth).toBe(1);
        });

        it('behaves exactly as before when no resolver is bound', async () => {
            // Additive: an install without the resolver keeps today's
            // semantics rather than refusing everything.
            const child = runner();
            const result = await new SubAgentDelegationService(child).delegate(
                request({ depth: 0 }),
                { parentScope },
            );

            expect(result).toMatchObject({ status: 'completed' });
        });
    });
});
