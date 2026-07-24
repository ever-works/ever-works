import { AgentRunRepository } from './agent-run.repository';

/**
 * FU-3 — terminal-transition CAS.
 *
 * `markFailed` / `markCompleted` / `markDispatchFailed` must never overwrite a
 * status a concurrent writer already committed. Before this, all three were a
 * `findOne` + unconditional `update(runId, …)` keyed on the primary key alone.
 */
describe('AgentRunRepository — terminal transitions', () => {
    let queryBuilder: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        execute: jest.Mock;
        // Sweep path: findStuckNonTerminal is a SELECT terminating in getMany.
        select: jest.Mock;
        orderBy: jest.Mock;
        limit: jest.Mock;
        getMany: jest.Mock;
    };
    let repository: {
        findOne: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let runs: AgentRunRepository;
    let warn: jest.SpyInstance;

    /** The `status IN (...)` guard the CAS relies on, as passed to andWhere. */
    function statusGuard(): string[] | undefined {
        const call = queryBuilder.andWhere.mock.calls.find(([sql]) =>
            String(sql).includes('status IN'),
        );
        return call?.[1]?.statuses;
    }

    beforeEach(() => {
        queryBuilder = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
            select: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        };
        repository = {
            // startedAt drives durationMs; null keeps the arithmetic out of the way.
            findOne: jest.fn().mockResolvedValue({ id: 'r1', startedAt: null }),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };
        runs = new AgentRunRepository(repository as never);
        warn = jest.spyOn((runs as never as { logger: { warn: () => void } }).logger, 'warn');
        warn.mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    describe('markFailed', () => {
        it('only transitions a non-terminal run', async () => {
            await runs.markFailed('r1', 'boom');
            expect(statusGuard()).toEqual(['queued', 'running']);
            expect(queryBuilder.set).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'failed', errorMessage: 'boom' }),
            );
        });

        it('warns instead of failing silently when the CAS matches nothing', async () => {
            // A worker flipped the row terminal between our read and the update.
            // There is no agent_runs sweeper, so a silent no-op is unrecoverable.
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            repository.findOne.mockResolvedValue({ id: 'r1', status: 'cancelled' });
            await expect(runs.markFailed('r1', 'boom')).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("already 'cancelled'"));
        });

        it('reports a missing row distinctly from an already-terminal one', async () => {
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            repository.findOne.mockResolvedValue(null);
            await runs.markFailed('r1', 'boom');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
        });

        it('does not warn on a successful transition', async () => {
            await runs.markFailed('r1', 'boom');
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('markCompleted', () => {
        it('only transitions a non-terminal run', async () => {
            await runs.markCompleted('r1', 'all done');
            expect(statusGuard()).toEqual(['queued', 'running']);
            expect(queryBuilder.set).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'completed', summary: 'all done' }),
            );
        });

        it('cannot resurrect a cancelled run', async () => {
            // finalize() runs even after a user cancel, because cancelling does
            // not stop the Trigger.dev worker. Guarding markFailed alone would
            // leave this branch still stomping `cancelled` -> `completed`.
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            repository.findOne.mockResolvedValue({ id: 'r1', status: 'cancelled' });
            await runs.markCompleted('r1', 'all done');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("already 'cancelled'"));
        });
    });

    describe('markDispatchFailed', () => {
        it('is queued-only, so a run a worker already started is never stomped', async () => {
            await runs.markDispatchFailed('r1', 'dispatch-failed: Trigger.dev down');
            // `running` MUST be absent: an enqueue that threw on a client-side
            // timeout may still have been accepted, in which case the worker is
            // already executing and owns the row.
            expect(statusGuard()).toEqual(['queued']);
            expect(statusGuard()).not.toContain('running');
        });

        it('sets the failure reason verbatim', async () => {
            await runs.markDispatchFailed('r1', 'enqueue-failed: nope');
            expect(queryBuilder.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'failed',
                    errorMessage: 'enqueue-failed: nope',
                }),
            );
        });

        it('no-ops with a warning once the run is running', async () => {
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            repository.findOne.mockResolvedValue({ id: 'r1', status: 'running' });
            await runs.markDispatchFailed('r1', 'dispatch-failed: timeout');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("already 'running'"));
        });
    });

    describe('setTriggerRunId', () => {
        it('only stamps a row that has none, so it cannot clobber markStarted', async () => {
            await runs.setTriggerRunId('r1', 'run_abc');
            expect(queryBuilder.set).toHaveBeenCalledWith({ triggerRunId: 'run_abc' });
            // The worker can reach markStarted before this stamp commits. Both
            // write the same value, so whichever lands second must no-op rather
            // than overwrite.
            expect(
                queryBuilder.andWhere.mock.calls.some(([sql]) =>
                    String(sql).includes('triggerRunId IS NULL'),
                ),
            ).toBe(true);
        });
    });

    describe('markStarted', () => {
        it('CAS-guards the claim so a cancelled run is never resurrected', async () => {
            const ok = await runs.markStarted('r1', 'run_abc');
            expect(ok).toBe(true);
            // Must allow queued|running, NOT queued-only: heartbeat re-resolves
            // an already-running row via findInFlightForAgent on retry.
            expect(statusGuard()).toEqual(['queued', 'running']);
        });

        it('returns false and warns when the run was cancelled first', async () => {
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            repository.findOne.mockResolvedValue({ id: 'r1', status: 'cancelled' });
            await expect(runs.markStarted('r1', 'run_abc')).resolves.toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("already 'cancelled'"));
        });

        it('does not erase an enqueue-time triggerRunId when the worker passes null', async () => {
            await runs.markStarted('r1', null);
            const patch = queryBuilder.set.mock.calls[0][0];
            expect(patch).not.toHaveProperty('triggerRunId');
            expect(patch.status).toBe('running');
        });
    });

    describe('cancel', () => {
        beforeEach(() => {
            repository.findOne.mockResolvedValue({
                id: 'r1',
                status: 'running',
                triggerRunId: 'run_abc',
            });
        });

        it('returns triggerRunId so the caller can cancel the remote run', async () => {
            // Without this the endpoint has no id to cancel and silently
            // degrades to a DB-only cancel.
            await expect(runs.cancel('r1', 'u1')).resolves.toEqual(
                expect.objectContaining({ found: true, triggerRunId: 'run_abc' }),
            );
        });

        it('returns triggerRunId for an already-terminal run too', async () => {
            repository.findOne.mockResolvedValue({
                id: 'r1',
                status: 'completed',
                triggerRunId: 'run_abc',
            });
            await expect(runs.cancel('r1', 'u1')).resolves.toEqual({
                found: true,
                previousStatus: 'completed',
                triggerRunId: 'run_abc',
            });
        });

        it('re-reads triggerRunId when the CAS loses, since markStarted may have stamped it', async () => {
            repository.findOne
                .mockResolvedValueOnce({ id: 'r1', status: 'queued', triggerRunId: null })
                .mockResolvedValueOnce({ id: 'r1', status: 'running', triggerRunId: 'run_late' });
            queryBuilder.execute.mockResolvedValue({ affected: 0 });
            await expect(runs.cancel('r1', 'u1')).resolves.toEqual({
                found: true,
                previousStatus: 'running',
                triggerRunId: 'run_late',
            });
        });

        it('reports found:false without a triggerRunId for an unknown run', async () => {
            repository.findOne.mockResolvedValue(null);
            await expect(runs.cancel('r1', 'u1')).resolves.toEqual({ found: false });
        });
    });

    describe('stuck-run sweep', () => {
        it('scans both non-terminal statuses on an age predicate that covers queued and running', async () => {
            const cutoff = new Date('2026-01-01T00:00:00Z');
            await runs.findStuckNonTerminal(cutoff, 200);
            // This is a SELECT, so the status filter is the leading `where`,
            // not an `andWhere` like the CAS updates — statusGuard() would miss it.
            const whereCall = queryBuilder.where.mock.calls.find(([sql]) =>
                String(sql).includes('status IN'),
            );
            expect(whereCall?.[1]?.statuses).toEqual(['queued', 'running']);
            // COALESCE, because startedAt is NULL while queued — one predicate
            // must cover both statuses or the queued half is never swept.
            expect(
                queryBuilder.andWhere.mock.calls.some(([sql]) => String(sql).includes('COALESCE')),
            ).toBe(true);
            expect(queryBuilder.limit).toHaveBeenCalledWith(200);
        });

        it('CAS-guards the bulk update so a run that finished first is never re-stamped', async () => {
            queryBuilder.execute.mockResolvedValue({ affected: 2 });
            await runs.markStuckFailed(['r1', 'r2'], 'stuck-timeout: x');
            expect(statusGuard()).toEqual(['queued', 'running']);
            expect(queryBuilder.set).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'failed', errorMessage: 'stuck-timeout: x' }),
            );
        });

        it('returns rows actually affected, not the number of ids passed', async () => {
            // A worker winning the race must not be counted as swept.
            queryBuilder.execute.mockResolvedValue({ affected: 1 });
            await expect(
                runs.markStuckFailed(['r1', 'r2', 'r3'], 'stuck-timeout: x'),
            ).resolves.toBe(1);
        });

        it('issues no query at all for an empty id list', async () => {
            // TypeORM renders `IN (:...ids)` as invalid SQL for an empty array,
            // so this is a runtime break, not a compile one.
            repository.createQueryBuilder.mockClear();
            await expect(runs.markStuckFailed([], 'stuck-timeout: x')).resolves.toBe(0);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });
    });

    describe('durationMs', () => {
        it('is derived from startedAt when the run had started', async () => {
            const startedAt = new Date(Date.now() - 5_000);
            repository.findOne.mockResolvedValue({ id: 'r1', startedAt });
            await runs.markFailed('r1', 'boom');
            const patch = queryBuilder.set.mock.calls[0][0];
            expect(patch.durationMs).toBeGreaterThanOrEqual(5_000);
        });

        it('is null for a run that never started', async () => {
            await runs.markFailed('r1', 'boom');
            expect(queryBuilder.set).toHaveBeenCalledWith(
                expect.objectContaining({ durationMs: null }),
            );
        });
    });
});
