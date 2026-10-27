import { APP_PRIVATE_COPY_MAX_SIZE_KB, APP_UPSTREAM_SYNC_BRANCH } from '@ever-works/contracts';
import { GitOperationNotSupportedError } from '../../facades/git.facade';
import { AppUpstreamPrivateCopyAdapter } from '../app-upstream-private-copy.adapter';

/**
 * APW-02 T48 (FR-63, ACC-02-27) — `AppUpstreamPrivateCopyAdapter`, the binding of
 * `APP_UPSTREAM_PRIVATE_COPY_PORT`.
 *
 * The adapter decides almost nothing, and that is the point: the git work is the plugin's, the
 * sync decisions are the sync run's. What it must get right is WHOSE credential, WHICH
 * repository and WHICH commit:
 *
 * - every facade call carries the Work owner's `userId`, the Work id and the GitHub provider;
 * - the move only ever targets the Work's own private copy (the row's repository, matched
 *   exactly), and pushes exactly the `headSha` it was handed onto `ever-works/upstream-sync`;
 * - the upstream branch the move fetches is the one the run's compare just counted;
 * - a provider without the capability surfaces `GitOperationNotSupportedError`, which the sync
 *   run maps to `failed/provider_unsupported` — the same answer as before the binding existed.
 */

const WORK_ID = 'work-1';
const USER_ID = 'user-1';
const HEAD = 'a'.repeat(40);

const ROW = {
    workId: WORK_ID,
    relation: 'private-copy',
    dataOwner: 'ever-works',
    dataRepo: 'app-copy',
    dataDefaultBranch: 'main',
    upstreamOwner: 'upstream-org',
    upstreamRepo: 'app',
    upstreamDefaultBranch: 'trunk',
};

function make(options: { row?: Record<string, unknown> | null; owner?: string | null } = {}) {
    const git = {
        getRepositoryCopyDivergence: jest.fn().mockResolvedValue({
            aheadBy: 1,
            behindBy: 9,
            upstreamHeadSha: HEAD,
            copyHeadSha: 'c'.repeat(40),
            mergeBaseSha: 'f'.repeat(40),
            capped: false,
        }),
        moveRepositoryCopyBranch: jest
            .fn()
            .mockResolvedValue({ outcome: 'moved', pushedSha: HEAD }),
    };
    const rows = {
        findByWorkId: jest.fn().mockResolvedValue(options.row === undefined ? ROW : options.row),
    };
    const works = {
        findById: jest
            .fn()
            .mockResolvedValue(
                options.owner === null ? null : { userId: options.owner ?? USER_ID },
            ),
    };
    const adapter = new AppUpstreamPrivateCopyAdapter(git as never, rows as never, works as never);
    return { adapter, git, rows, works };
}

const COMPARE_INPUT = {
    workId: WORK_ID,
    owner: 'ever-works',
    repo: 'app-copy',
    branch: 'main',
    upstreamOwner: 'upstream-org',
    upstreamRepo: 'app',
    upstreamBranch: 'release',
};

describe('AppUpstreamPrivateCopyAdapter.compare (APW-02 T48)', () => {
    it('reads the drift through the facade with the owner credential, capped at 10 000 and 500 MB', async () => {
        const { adapter, git } = make();

        await expect(adapter.compare(COMPARE_INPUT)).resolves.toEqual({
            aheadBy: 1,
            behindBy: 9,
            upstreamHeadSha: HEAD,
            capped: false,
        });
        expect(git.getRepositoryCopyDivergence).toHaveBeenCalledWith(
            {
                sourceOwner: 'upstream-org',
                sourceRepo: 'app',
                sourceBranch: 'release',
                targetOwner: 'ever-works',
                targetRepo: 'app-copy',
                targetBranch: 'main',
                maxCommits: 10_000,
                maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
            },
            { userId: USER_ID, providerId: 'github', workId: WORK_ID },
        );
    });

    it('answers null (→ failed/not_found) when the Work has no owner to act as', async () => {
        const { adapter, git } = make({ owner: null });
        await expect(adapter.compare(COMPARE_INPUT)).resolves.toBeNull();
        expect(git.getRepositoryCopyDivergence).not.toHaveBeenCalled();
    });

    it('lets the facade refusal through for a provider without the capability', async () => {
        const { adapter, git } = make();
        git.getRepositoryCopyDivergence.mockRejectedValue(
            new GitOperationNotSupportedError('getRepositoryCopyDivergence', 'other'),
        );
        await expect(adapter.compare(COMPARE_INPUT)).rejects.toBeInstanceOf(
            GitOperationNotSupportedError,
        );
    });
});

describe('AppUpstreamPrivateCopyAdapter.moveSyncBranch (APW-02 T48)', () => {
    const MOVE_INPUT = { workId: WORK_ID, owner: 'ever-works', repo: 'app-copy', headSha: HEAD };

    it('pushes the given sha onto the sync branch of the Work’s own copy, from the compared branch', async () => {
        const { adapter, git } = make();
        await adapter.compare(COMPARE_INPUT);

        await expect(adapter.moveSyncBranch(MOVE_INPUT)).resolves.toBe('moved');
        expect(git.moveRepositoryCopyBranch).toHaveBeenCalledWith(
            {
                sourceOwner: 'upstream-org',
                sourceRepo: 'app',
                // The branch the compare counted, not the row's default.
                sourceBranch: 'release',
                targetOwner: 'ever-works',
                targetRepo: 'app-copy',
                targetBaseBranch: 'main',
                branchName: APP_UPSTREAM_SYNC_BRANCH,
                headSha: HEAD,
                maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
            },
            { userId: USER_ID, providerId: 'github', workId: WORK_ID },
        );
    });

    it('falls back to the upstream default branch when no compare ran in this process', async () => {
        const { adapter, git } = make();
        await adapter.moveSyncBranch(MOVE_INPUT);
        expect(git.moveRepositoryCopyBranch.mock.calls[0][0].sourceBranch).toBe('trunk');
    });

    it('maps the plugin’s up_to_date to moved and not_fast_forward to not_fast_forward', async () => {
        const { adapter, git } = make();
        git.moveRepositoryCopyBranch.mockResolvedValueOnce({
            outcome: 'up_to_date',
            pushedSha: HEAD,
        });
        await expect(adapter.moveSyncBranch(MOVE_INPUT)).resolves.toBe('moved');
        git.moveRepositoryCopyBranch.mockResolvedValueOnce({
            outcome: 'not_fast_forward',
            pushedSha: null,
        });
        await expect(adapter.moveSyncBranch(MOVE_INPUT)).resolves.toBe('not_fast_forward');
    });

    it('never pushes into a repository that is not the Work’s own private copy', async () => {
        for (const make_ of [
            () => make({ row: null }),
            () => make({ row: { ...ROW, relation: 'fork' } }),
            () => make({ row: { ...ROW, upstreamOwner: null } }),
        ]) {
            const { adapter, git } = make_();
            await expect(adapter.moveSyncBranch(MOVE_INPUT)).rejects.toMatchObject({
                reason: 'not_found',
            });
            expect(git.moveRepositoryCopyBranch).not.toHaveBeenCalled();
        }
        const { adapter, git } = make();
        await expect(
            adapter.moveSyncBranch({ ...MOVE_INPUT, owner: 'someone-else', repo: 'app-copy' }),
        ).rejects.toMatchObject({ reason: 'not_found' });
        expect(git.moveRepositoryCopyBranch).not.toHaveBeenCalled();
    });

    it('matches the copy’s coordinates case-insensitively, as GitHub does', async () => {
        const { adapter, git } = make();
        await expect(
            adapter.moveSyncBranch({ ...MOVE_INPUT, owner: 'Ever-Works', repo: 'App-Copy' }),
        ).resolves.toBe('moved');
        expect(git.moveRepositoryCopyBranch).toHaveBeenCalledTimes(1);
    });
});
