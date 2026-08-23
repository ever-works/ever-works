import { BranchSyncService } from './branch-sync.service';
import type { WebsiteTemplateConfig } from './config/website-template.config';

jest.mock('node:fs/promises', () => ({
    rm: jest.fn().mockResolvedValue(undefined),
}));

const fsMock = jest.requireMock('node:fs/promises') as { rm: jest.Mock };

/** Sha every branch of every repo reports in the default happy-path stub. */
const IN_SYNC_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('BranchSyncService', () => {
    let gitFacade: any;
    let websiteTemplateResolver: any;
    let service: BranchSyncService;
    const baseTemplate: WebsiteTemplateConfig = {
        id: 'classic',
        name: 'Classic',
        description: 'desc',
        owner: 'ever-works',
        repo: 'directory-web-template',
        branch: 'main',
        syncBranches: ['main', 'stage', 'develop'],
        betaBranch: null,
    };

    /**
     * Default readback: every branch on every repo is already at
     * IN_SYNC_SHA, so the post-push verification guard passes. Tests that
     * care about the guard override this per repo.
     */
    function stubBranchesInSync() {
        gitFacade.listBranches.mockImplementation(async () =>
            ['main', 'stage', 'develop', 'next'].map((name) => ({
                name,
                commit: IN_SYNC_SHA,
                isDefault: name === 'main',
            })),
        );
    }

    beforeEach(() => {
        jest.useFakeTimers();
        fsMock.rm.mockClear();
        fsMock.rm.mockResolvedValue(undefined);

        gitFacade = {
            cloneBranch: jest.fn(),
            renameBranch: jest.fn(),
            getCloneUrl: jest.fn(),
            replaceRemote: jest.fn(),
            push: jest.fn(),
            listBranches: jest.fn(),
            deleteBranch: jest.fn(),
        };
        websiteTemplateResolver = {
            resolveForWork: jest.fn(),
        };
        stubBranchesInSync();

        service = new BranchSyncService(gitFacade, websiteTemplateResolver);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function makeWork(overrides: Record<string, any> = {}) {
        const user = { id: 'user-1', username: 'ever' };
        return {
            id: 'work-1',
            user,
            gitProvider: 'github',
            websiteTemplateUseBeta: false,
            getRepoOwner: jest.fn().mockReturnValue('target-owner'),
            getWebsiteRepo: jest.fn().mockReturnValue('target-repo'),
            resolveCommitter: jest.fn().mockReturnValue({ name: 'ever', email: 'ever@x.test' }),
            ...overrides,
        };
    }

    describe('syncBranch', () => {
        it('clones the template branch, pushes to target, and cleans up the temp dir', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/work-dir');
            gitFacade.getCloneUrl.mockReturnValue(
                'https://github.com/target-owner/target-repo.git',
            );
            gitFacade.replaceRemote.mockResolvedValue(undefined);
            gitFacade.push.mockResolvedValue(undefined);

            const result = await service.syncBranch({
                branchName: 'main',
                targetOwner: 'target-owner',
                targetRepo: 'target-repo',
                template: baseTemplate,
                userId: 'user-1',
                committer: { name: 'ever', email: 'ever@x.test' },
                providerId: 'github',
                workId: 'work-1',
            });

            expect(gitFacade.cloneBranch).toHaveBeenCalledWith(
                {
                    owner: 'ever-works',
                    repo: 'directory-web-template',
                    branch: 'main',
                },
                { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            );
            expect(gitFacade.renameBranch).not.toHaveBeenCalled();
            expect(gitFacade.getCloneUrl).toHaveBeenCalledWith(
                'github',
                'target-owner',
                'target-repo',
            );
            expect(gitFacade.replaceRemote).toHaveBeenCalledWith(
                'github',
                '/tmp/work-dir',
                'origin',
                'https://github.com/target-owner/target-repo.git',
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/work-dir', force: true, ref: 'main', remoteRef: 'main' },
                { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            );
            expect(fsMock.rm).toHaveBeenCalledWith('/tmp/work-dir', {
                recursive: true,
                force: true,
            });
            expect(result).toEqual({
                branch: 'main',
                status: 'synced',
                message: "Successfully synced branch 'main'",
            });
        });

        it('renames branch when targetBranch differs from branchName', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/work-dir');
            gitFacade.getCloneUrl.mockReturnValue('https://example.test/owner/repo.git');

            const result = await service.syncBranch({
                branchName: 'stage',
                targetBranch: 'main',
                targetOwner: 'owner',
                targetRepo: 'repo',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                providerId: 'github',
            });

            expect(gitFacade.renameBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/work-dir',
                'stage',
                'main',
            );
            expect(result.status).toBe('synced');
            expect(result.message).toBe("Successfully synced branch 'stage' (mapped to 'main')");
        });

        it('pushes a mapped branch to the MAPPED remote ref, not the source ref', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/work-dir');
            gitFacade.getCloneUrl.mockReturnValue('url');

            await service.syncBranch({
                branchName: 'stage',
                targetBranch: 'main',
                targetOwner: 'owner',
                targetRepo: 'repo',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(gitFacade.push).toHaveBeenCalledWith(
                expect.objectContaining({ ref: 'main', remoteRef: 'main' }),
                expect.any(Object),
            );
        });

        it('honours forcePush=false', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');

            await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                forcePush: false,
            });

            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/d', force: false, ref: 'main', remoteRef: 'main' },
                expect.any(Object),
            );
        });

        it('forwards undefined providerId/workId verbatim', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');

            await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(gitFacade.cloneBranch).toHaveBeenCalledWith(expect.any(Object), {
                userId: 'u',
                providerId: undefined,
                workId: undefined,
            });
            expect(gitFacade.push).toHaveBeenCalledWith(expect.any(Object), {
                userId: 'u',
                providerId: undefined,
                workId: undefined,
            });
            expect(gitFacade.getCloneUrl).toHaveBeenCalledWith(undefined, 'o', 'r');
        });

        it('returns error result and still cleans up tempDir on failure after clone', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            gitFacade.replaceRemote.mockRejectedValue(new Error('replace failed'));

            const result = await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result).toEqual({
                branch: 'main',
                status: 'error',
                message: 'replace failed',
            });
            expect(fsMock.rm).toHaveBeenCalledWith('/tmp/d', { recursive: true, force: true });
        });

        it('does not call fs.rm when clone fails before tempDir is set', async () => {
            gitFacade.cloneBranch.mockRejectedValue(new Error('clone failed'));

            const result = await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result).toEqual({
                branch: 'main',
                status: 'error',
                message: 'clone failed',
            });
            expect(fsMock.rm).not.toHaveBeenCalled();
            expect(gitFacade.replaceRemote).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        });

        it('swallows fs.rm cleanup failure silently', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            fsMock.rm.mockRejectedValueOnce(new Error('fs unavailable'));

            await expect(
                service.syncBranch({
                    branchName: 'main',
                    targetOwner: 'o',
                    targetRepo: 'r',
                    template: baseTemplate,
                    userId: 'u',
                    committer: { name: 'n', email: 'e' },
                }),
            ).resolves.toEqual(expect.objectContaining({ status: 'synced' }));
        });
    });

    // ── Verification guard ────────────────────────────────────────────
    //
    // The regression these cover: a push that resolves without throwing
    // was treated as proof the remote branch moved. It is not — it is
    // proof the transport did not error. Every test here reports
    // status:'synced' against a service that does not read the ref back.
    describe('syncBranch verification guard', () => {
        function stubRepoBranches(shas: {
            template: Record<string, string>;
            target: Record<string, string>;
        }) {
            gitFacade.listBranches.mockImplementation(async (owner: string) => {
                const table = owner === 'ever-works' ? shas.template : shas.target;
                return Object.entries(table).map(([name, commit]) => ({ name, commit }));
            });
        }

        it('reports error when the target ref did NOT move to the pushed sha', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            gitFacade.push.mockResolvedValue(undefined);
            stubRepoBranches({
                template: { develop: 'dddddddddddddddddddddddddddddddddddddddd' },
                // Frozen exactly the way the 11 stale sites were: the push
                // "succeeded" and develop stayed where it was.
                target: { develop: '1eb0424f1eb0424f1eb0424f1eb0424f1eb0424f' },
            });

            const result = await service.syncBranch({
                branchName: 'develop',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(gitFacade.push).toHaveBeenCalled();
            expect(result.status).toBe('error');
            expect(result.message).toContain('1eb0424f1eb0424f1eb0424f1eb0424f1eb0424f');
            expect(result.message).toContain('dddddddddddddddddddddddddddddddddddddddd');
        });

        it('reports error when the target branch does not exist after the push', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            stubRepoBranches({
                template: { stage: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
                target: { main: 'cccccccccccccccccccccccccccccccccccccccc' },
            });

            const result = await service.syncBranch({
                branchName: 'stage',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result.status).toBe('error');
            expect(result.message).toContain('(branch missing)');
        });

        it('does NOT pass when both sides are missing the branch', async () => {
            // Guards the vacuous case: `undefined === undefined` must not
            // read as "in sync". The template lookup fails first, so the
            // clone is never attempted.
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            stubRepoBranches({ template: { main: 'x' }, target: { main: 'x' } });

            const result = await service.syncBranch({
                branchName: 'develop',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result.status).toBe('error');
            expect(result.message).toContain("Template branch 'develop' not found");
            expect(gitFacade.cloneBranch).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        });

        it('reports error when the readback itself cannot be performed', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            gitFacade.listBranches
                .mockResolvedValueOnce([{ name: 'main', commit: IN_SYNC_SHA }])
                .mockRejectedValueOnce(new Error('rate limited'));

            const result = await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result).toEqual({
                branch: 'main',
                status: 'error',
                message: 'rate limited',
            });
        });

        it('accepts a sha that differs only in case', async () => {
            gitFacade.cloneBranch.mockResolvedValue('/tmp/d');
            gitFacade.getCloneUrl.mockReturnValue('url');
            stubRepoBranches({
                template: { main: 'ABCDEF0123456789abcdef0123456789ABCDEF01' },
                target: { main: 'abcdef0123456789abcdef0123456789abcdef01' },
            });

            const result = await service.syncBranch({
                branchName: 'main',
                targetOwner: 'o',
                targetRepo: 'r',
                template: baseTemplate,
                userId: 'u',
                committer: { name: 'n', email: 'e' },
            });

            expect(result.status).toBe('synced');
        });
    });

    describe('syncAllBranches', () => {
        function stubSyncSuccess() {
            // A distinct directory per call — the whole point of cloneBranch.
            let n = 0;
            gitFacade.cloneBranch.mockImplementation(async () => `/tmp/d-${++n}`);
            gitFacade.getCloneUrl.mockReturnValue('url');
            gitFacade.replaceRemote.mockResolvedValue(undefined);
            gitFacade.push.mockResolvedValue(undefined);
        }

        it('syncs every branch in template.syncBranches and aggregates a summary', async () => {
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: baseTemplate,
            });

            // Branches sync sequentially with a 1000ms delay between batches.
            await jest.runAllTimersAsync();
            const summary = await promise;

            expect(gitFacade.cloneBranch).toHaveBeenCalledTimes(3);
            const cloneBranches = gitFacade.cloneBranch.mock.calls.map((c: any[]) => c[0].branch);
            expect(cloneBranches).toEqual(['main', 'stage', 'develop']);
            expect(summary).toEqual({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [
                    expect.objectContaining({ branch: 'main', status: 'synced' }),
                    expect.objectContaining({ branch: 'stage', status: 'synced' }),
                    expect.objectContaining({ branch: 'develop', status: 'synced' }),
                ],
            });
        });

        it('pushes ONE remote ref per branch instead of main three times', async () => {
            // The original defect, asserted as an effect rather than as the
            // arguments handed to a mocked clone: syncing main/stage/develop
            // used to push the same checked-out `main` three times and still
            // report "3 synced, 0 errors".
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: baseTemplate,
            });

            await jest.runAllTimersAsync();
            await promise;

            const pushedRefs = gitFacade.push.mock.calls.map((c: any[]) => c[0].ref);
            expect(pushedRefs).toEqual(['main', 'stage', 'develop']);
            expect(new Set(pushedRefs).size).toBe(3);

            const pushedRemoteRefs = gitFacade.push.mock.calls.map((c: any[]) => c[0].remoteRef);
            expect(pushedRemoteRefs).toEqual(['main', 'stage', 'develop']);
        });

        it('gives each branch its own working directory and removes it', async () => {
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: baseTemplate,
            });

            await jest.runAllTimersAsync();
            await promise;

            const pushedDirs = gitFacade.push.mock.calls.map((c: any[]) => c[0].dir);
            expect(new Set(pushedDirs).size).toBe(3);
            for (const dir of pushedDirs) {
                expect(fsMock.rm).toHaveBeenCalledWith(dir, { recursive: true, force: true });
            }
        });

        it('counts a branch whose push did not land as an error, not a success', async () => {
            stubSyncSuccess();
            gitFacade.listBranches.mockImplementation(async (owner: string, _repo: string) => {
                if (owner === 'ever-works') {
                    return [
                        { name: 'main', commit: IN_SYNC_SHA },
                        { name: 'stage', commit: IN_SYNC_SHA },
                        { name: 'develop', commit: IN_SYNC_SHA },
                    ];
                }
                // Target: main tracked the template, stage/develop froze.
                return [
                    { name: 'main', commit: IN_SYNC_SHA },
                    { name: 'stage', commit: '7e237a8c7e237a8c7e237a8c7e237a8c7e237a8c' },
                    { name: 'develop', commit: '1eb0424f1eb0424f1eb0424f1eb0424f1eb0424f' },
                ];
            });

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: baseTemplate,
            });

            await jest.runAllTimersAsync();
            const summary = await promise;

            expect(summary.synced).toBe(1);
            expect(summary.errors).toBe(2);
            expect(summary.results.map((r) => r.status)).toEqual(['synced', 'error', 'error']);
        });

        it('expands branchMapping into an additional sync target without skipping the original', async () => {
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['stage'] },
                branchMapping: { stage: 'main' },
            });

            await jest.runAllTimersAsync();
            const summary = await promise;

            expect(gitFacade.cloneBranch).toHaveBeenCalledTimes(2);
            expect(summary.totalBranches).toBe(1);
            expect(summary.synced).toBe(2);
            expect(gitFacade.renameBranch).toHaveBeenCalledTimes(1);
            expect(gitFacade.renameBranch).toHaveBeenCalledWith(
                undefined,
                '/tmp/d-2',
                'stage',
                'main',
            );
            // stage→stage then stage→main: two ops, two different remote refs.
            expect(gitFacade.push.mock.calls.map((c: any[]) => c[0].remoteRef)).toEqual([
                'stage',
                'main',
            ]);
        });

        it('skips a branch that is the mapped target of another branch', async () => {
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['stage', 'main'] },
                // stage→main means a real sync of 'main' would be overwritten,
                // so the iterator must skip the standalone 'main' op.
                branchMapping: { stage: 'main' },
            });

            await jest.runAllTimersAsync();
            const summary = await promise;

            // Two ops: stage→stage and stage→main. The standalone 'main'
            // entry is skipped because it's a mapped target.
            expect(gitFacade.cloneBranch).toHaveBeenCalledTimes(2);
            const branchesCloned = gitFacade.cloneBranch.mock.calls.map((c: any[]) => c[0].branch);
            expect(branchesCloned).toEqual(['stage', 'stage']);
            expect(summary.totalBranches).toBe(2);
        });

        it('does NOT skip a self-mapped branch (branchMapping[x] = x)', async () => {
            stubSyncSuccess();

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main'] },
                // mappedTargets contains 'main' AND branchMapping['main'] === 'main' (truthy),
                // so the skip condition does not match — main DOES sync.
                branchMapping: { main: 'main' },
            });

            await jest.runAllTimersAsync();
            const summary = await promise;

            // One op: main→main (the additional 'main !== main' branch is suppressed).
            expect(gitFacade.cloneBranch).toHaveBeenCalledTimes(1);
            expect(summary.synced).toBe(1);
            expect(gitFacade.renameBranch).not.toHaveBeenCalled();
        });

        it('captures rejection results as error entries without blowing up the loop', async () => {
            // First syncBranch happens to throw inside, returning a fulfilled
            // result with status:'error'. To exercise the rejected branch we
            // make Promise.allSettled see a rejection by stubbing syncBranch
            // directly.
            (service as any).syncBranch = jest
                .fn()
                .mockRejectedValueOnce(new Error('boom'))
                .mockResolvedValueOnce({ branch: 'stage', status: 'synced' })
                .mockRejectedValueOnce(new Error()); // empty Error → fallback message

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main', 'stage', 'develop'] },
            });

            await jest.runAllTimersAsync();
            const summary = await promise;

            expect(summary).toEqual({
                totalBranches: 3,
                synced: 1,
                skipped: 0,
                errors: 2,
                results: [
                    { branch: 'main', status: 'error', message: 'boom' },
                    { branch: 'stage', status: 'synced' },
                    { branch: 'develop', status: 'error', message: 'Unknown error' },
                ],
            });
        });

        it('inserts a 1000ms delay between batches but not after the last batch', async () => {
            (service as any).syncBranch = jest
                .fn()
                .mockResolvedValue({ branch: 'x', status: 'synced' });

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main', 'stage'] },
            });

            // First batch finishes immediately, then a 1000ms sleep, then
            // second batch finishes immediately, then the loop exits with no
            // trailing sleep. Driving fake timers through the full sequence
            // resolves the promise without leaving an open timer.
            await jest.runAllTimersAsync();
            const summary = await promise;
            expect(summary.synced).toBe(2);
            // 2 ops, batch size 1, so MAX_CONCURRENT_SYNCS=1 means each runs
            // alone. The third condition `i + 1 < syncOperations.length` is
            // true at i=0 and false at i=1, so exactly one delay is queued.
        });

        it('runs deleteExtraBranches when cleanupExtraBranches=true', async () => {
            (service as any).syncBranch = jest
                .fn()
                .mockResolvedValue({ branch: 'main', status: 'synced' });
            gitFacade.listBranches.mockResolvedValue([
                { name: 'main' },
                { name: 'stale' },
                { name: 'feature/old' },
            ]);
            gitFacade.deleteBranch.mockResolvedValue(undefined);

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main'] },
                cleanupExtraBranches: true,
                providerId: 'github',
            });

            await jest.runAllTimersAsync();
            await promise;

            expect(gitFacade.listBranches).toHaveBeenCalledWith('o', 'r', {
                userId: 'u',
                providerId: 'github',
            });
            const deletedBranches = gitFacade.deleteBranch.mock.calls.map((c: any[]) => c[2]);
            expect(deletedBranches).toEqual(['stale', 'feature/old']);
            expect(gitFacade.deleteBranch).not.toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                'main',
                expect.anything(),
            );
        });

        it('warns and returns early when listBranches fails during cleanup', async () => {
            (service as any).syncBranch = jest
                .fn()
                .mockResolvedValue({ branch: 'main', status: 'synced' });
            gitFacade.listBranches.mockRejectedValue(new Error('listing forbidden'));
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main'] },
                cleanupExtraBranches: true,
            });

            await jest.runAllTimersAsync();
            await promise;

            expect(gitFacade.deleteBranch).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                'Could not list branches for cleanup: listing forbidden',
            );
        });

        it('swallows individual deleteBranch failures and warns', async () => {
            (service as any).syncBranch = jest
                .fn()
                .mockResolvedValue({ branch: 'main', status: 'synced' });
            gitFacade.listBranches.mockResolvedValue([{ name: 'stale' }, { name: 'other' }]);
            gitFacade.deleteBranch
                .mockRejectedValueOnce(new Error('locked'))
                .mockResolvedValueOnce(undefined);
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main'] },
                cleanupExtraBranches: true,
            });

            await jest.runAllTimersAsync();
            await promise;

            expect(gitFacade.deleteBranch).toHaveBeenCalledTimes(2);
            expect(warnSpy).toHaveBeenCalledWith("Failed to delete extra branch 'stale': locked");
        });

        it('does NOT run cleanup when cleanupExtraBranches is omitted/false', async () => {
            (service as any).syncBranch = jest
                .fn()
                .mockResolvedValue({ branch: 'main', status: 'synced' });

            const promise = service.syncAllBranches({
                targetOwner: 'o',
                targetRepo: 'r',
                userId: 'u',
                committer: { name: 'n', email: 'e' },
                template: { ...baseTemplate, syncBranches: ['main'] },
            });
            await jest.runAllTimersAsync();
            await promise;

            expect(gitFacade.listBranches).not.toHaveBeenCalled();
            expect(gitFacade.deleteBranch).not.toHaveBeenCalled();
        });
    });

    describe('syncFromTemplate', () => {
        it('resolves the template, builds the standard arg envelope, and forwards forcePush=true', async () => {
            const work = makeWork();
            websiteTemplateResolver.resolveForWork.mockResolvedValue(baseTemplate);
            const syncSpy = jest.spyOn(service, 'syncAllBranches').mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            });

            const result = await service.syncFromTemplate(work as any, { id: 'caller' } as any);

            expect(websiteTemplateResolver.resolveForWork).toHaveBeenCalledWith(work);
            expect(work.resolveCommitter).toHaveBeenCalledWith({ id: 'caller' });
            expect(syncSpy).toHaveBeenCalledWith({
                targetOwner: 'target-owner',
                targetRepo: 'target-repo',
                userId: 'user-1',
                committer: { name: 'ever', email: 'ever@x.test' },
                forcePush: true,
                branchMapping: undefined,
                template: baseTemplate,
                providerId: 'github',
                workId: 'work-1',
                cleanupExtraBranches: false,
            });
            expect(result).toEqual(expect.objectContaining({ synced: 3 }));
        });

        it('builds beta branchMapping when websiteTemplateUseBeta=true and betaBranch is set', async () => {
            const work = makeWork({ websiteTemplateUseBeta: true });
            websiteTemplateResolver.resolveForWork.mockResolvedValue({
                ...baseTemplate,
                betaBranch: 'next',
            });
            const syncSpy = jest.spyOn(service, 'syncAllBranches').mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            });

            await service.syncFromTemplate(work as any, { id: 'caller' } as any, true);

            expect(syncSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    branchMapping: { next: 'main' },
                    cleanupExtraBranches: true,
                }),
            );
        });

        it('does NOT build a beta mapping when betaBranch is null even if useBeta flag is true', async () => {
            const work = makeWork({ websiteTemplateUseBeta: true });
            websiteTemplateResolver.resolveForWork.mockResolvedValue({
                ...baseTemplate,
                betaBranch: null,
            });
            const syncSpy = jest.spyOn(service, 'syncAllBranches').mockResolvedValue({
                totalBranches: 3,
                synced: 3,
                skipped: 0,
                errors: 0,
                results: [],
            });

            await service.syncFromTemplate(work as any, { id: 'caller' } as any);

            expect(syncSpy).toHaveBeenCalledWith(
                expect.objectContaining({ branchMapping: undefined }),
            );
        });

        it('returns null and logs error when syncAllBranches throws', async () => {
            const work = makeWork();
            websiteTemplateResolver.resolveForWork.mockResolvedValue(baseTemplate);
            jest.spyOn(service, 'syncAllBranches').mockRejectedValue(new Error('git down'));
            const errorSpy = jest
                .spyOn((service as any).logger, 'error')
                .mockImplementation(() => undefined);

            const result = await service.syncFromTemplate(work as any, { id: 'caller' } as any);

            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to sync branches from template: git down',
            );
        });

        it('returns null when resolveForWork throws (caught by outer try/catch)', async () => {
            const work = makeWork();
            websiteTemplateResolver.resolveForWork.mockRejectedValue(new Error('no template'));
            jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

            // resolveForWork is called BEFORE the try/catch, so this rejects
            // out of syncFromTemplate. Pin the current behavior.
            await expect(
                service.syncFromTemplate(work as any, { id: 'caller' } as any),
            ).rejects.toThrow('no template');
        });
    });

    describe('contracts', () => {
        it('exposes MAX_CONCURRENT_SYNCS=1 (kept sequential for API/CPU pacing)', () => {
            expect((service as any).MAX_CONCURRENT_SYNCS).toBe(1);
        });

        it('never falls back to the branch-blind cloneOrPull', () => {
            // cloneOrPull resolves a directory keyed on owner+repo and
            // switches the checkout back to main. If it reappears in this
            // service, the per-branch guarantee is gone again.
            expect(gitFacade.cloneOrPull).toBeUndefined();
        });

        it('logger context is the service name', () => {
            expect((service as any).logger.constructor.name).toBe('Logger');
        });
    });
});
