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
