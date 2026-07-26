import { AgentRunRepository } from './agent-run.repository';

/**
 * Run telemetry — `AgentRunRepository.addTokens`.
 *
 * The accumulator behind `agent_runs.totalTokens`. Deliberately a
 * read-modify-write rather than a raw `SET col = col + :delta`: the
 * three supported drivers (postgres / better-sqlite3 / mysql) do not
 * share an identifier-quoting style for a camelCase column, and a
 * single run's tool loop is the only writer.
 */
describe('AgentRunRepository.addTokens', () => {
    let repository: { findOne: jest.Mock; update: jest.Mock };
    let runs: AgentRunRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn().mockResolvedValue({ id: 'r1', totalTokens: null }),
            update: jest.fn().mockResolvedValue(undefined),
        };
        runs = new AgentRunRepository(repository as never);
    });

    it('treats a NULL counter as zero so the first round-trip lands', async () => {
        await runs.addTokens('r1', 120);
        expect(repository.update).toHaveBeenCalledWith('r1', { totalTokens: 120 });
    });

    it('accumulates onto an existing counter (re-entering the loop keeps counting)', async () => {
        repository.findOne.mockResolvedValue({ id: 'r1', totalTokens: 120 });
        await runs.addTokens('r1', 45);
        expect(repository.update).toHaveBeenCalledWith('r1', { totalTokens: 165 });
    });

    it('reads the run owner-agnostically by id and selects only what it needs', async () => {
        await runs.addTokens('r1', 5);
        expect(repository.findOne).toHaveBeenCalledWith({
            where: { id: 'r1' },
            select: { id: true, totalTokens: true },
        });
    });

    it('is a no-op for a missing row', async () => {
        repository.findOne.mockResolvedValue(null);
        await runs.addTokens('gone', 10);
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('ignores non-positive and non-finite deltas without touching the DB', async () => {
        await runs.addTokens('r1', 0);
        await runs.addTokens('r1', -5);
        await runs.addTokens('r1', Number.NaN);
        expect(repository.findOne).not.toHaveBeenCalled();
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('truncates a fractional delta to keep the int column honest', async () => {
        await runs.addTokens('r1', 12.9);
        expect(repository.update).toHaveBeenCalledWith('r1', { totalTokens: 12 });
    });
});
