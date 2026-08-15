import { AgentRunRepository } from './agent-run.repository';

/**
 * Session detail (Feature K) — `mergeFilesTouched`, the only writer of
 * `workspaceMeta.filesTouched`.
 *
 * It merges into a JSON column the workspace-provision path also owns, so
 * the contracts that matter are: the provision audit survives the merge,
 * repeated tool calls do not grow the list, the cap is hard, and a
 * no-op write is skipped entirely (this runs on EVERY run's exit path).
 */
describe('AgentRunRepository — mergeFilesTouched (Feature K)', () => {
    let repository: { findOne: jest.Mock; update: jest.Mock; createQueryBuilder: jest.Mock };
    let runs: AgentRunRepository;

    const provision = {
        provider: 'worktree',
        path: '/w/1',
        baseSha: 'abc',
        branchRef: 'task/x',
        reused: false,
    };

    /** The `workspaceMeta` object handed to the last `update` call. */
    function written(): Record<string, unknown> {
        const [, patch] = repository.update.mock.calls[repository.update.mock.calls.length - 1];
        return patch.workspaceMeta;
    }

    beforeEach(() => {
        repository = {
            findOne: jest.fn().mockResolvedValue({ id: 'r1', workspaceMeta: { ...provision } }),
            update: jest.fn().mockResolvedValue(undefined),
            createQueryBuilder: jest.fn(),
        };
        runs = new AgentRunRepository(repository as never);
    });

    afterEach(() => jest.restoreAllMocks());

    it('⭐ appends paths while preserving the workspace-provision audit', async () => {
        await runs.mergeFilesTouched('r1', ['src/a.ts', 'src/b.ts']);
        expect(written()).toEqual({ ...provision, filesTouched: ['src/a.ts', 'src/b.ts'] });
    });

    it('⭐ de-duplicates against what is already stored and keeps insertion order', async () => {
        repository.findOne.mockResolvedValue({
            id: 'r1',
            workspaceMeta: { ...provision, filesTouched: ['src/a.ts'] },
        });
        await runs.mergeFilesTouched('r1', ['src/a.ts', 'src/b.ts', 'src/b.ts']);
        expect((written().filesTouched as string[]) ?? []).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('⭐ skips the write entirely when nothing new arrived', async () => {
        repository.findOne.mockResolvedValue({
            id: 'r1',
            workspaceMeta: { ...provision, filesTouched: ['src/a.ts'] },
        });
        await runs.mergeFilesTouched('r1', ['src/a.ts']);
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('enforces the cap and drops malformed entries', async () => {
        await runs.mergeFilesTouched(
            'r1',
            ['', ...Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`)],
            4,
        );
        expect(written().filesTouched).toEqual([
            'src/f0.ts',
            'src/f1.ts',
            'src/f2.ts',
            'src/f3.ts',
        ]);
    });

    it('writes filesTouched onto runs that never provisioned a workspace', async () => {
        repository.findOne.mockResolvedValue({ id: 'r1', workspaceMeta: null });
        await runs.mergeFilesTouched('r1', ['HEARTBEAT.md']);
        expect(written()).toEqual({ filesTouched: ['HEARTBEAT.md'] });
    });

    it('is a no-op for an empty path list or a missing run row', async () => {
        await runs.mergeFilesTouched('r1', []);
        expect(repository.findOne).not.toHaveBeenCalled();

        repository.findOne.mockResolvedValue(null);
        await runs.mergeFilesTouched('gone', ['src/a.ts']);
        expect(repository.update).not.toHaveBeenCalled();
    });
});
