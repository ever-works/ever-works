import type { CreatePROptions, GitDiffResult, ListPullRequestsOptions } from '@ever-works/plugin';
import {
    GitFacadeService,
    GitOperationNotSupportedError,
    type GitFacadeError,
    type MemberAccountTokenOptions,
} from '../git.facade';

/**
 * APW-09 T4 — the member token and the T1-T3 facade pass-throughs.
 *
 * Two contracts are under test here, and both are load-bearing:
 *
 *  1. **The member token is member-scoped, structurally.** APW-09's upstream
 *     pull requests are opened, prepared and fast-forwarded with the member's
 *     OWN credential (FR-24, plan §2.3). The two Work-scoped short-circuits of
 *     `resolvePluginAndToken` — the `ever-works-git` platform PAT and the
 *     GitHub App installation token — must therefore be unreachable from
 *     `getMemberAccountToken`. "Unreachable" is asserted twice: the input type
 *     has no `workId`, and both resolvers are spied on, with a positive
 *     control proving the spies DO fire on the Work-scoped path. Without that
 *     control a green `not.toHaveBeenCalled()` would prove only that the spy
 *     was attached to something.
 *
 *  2. **An absent optional provider method is a refusal, not a crash.** Every
 *     method below is optional on `IGitProviderPlugin`, and the lazy-plugin
 *     proxy over-reports optional methods, so the facade materialises the
 *     method off the resolved plugin and raises the typed
 *     `GitOperationNotSupportedError` (→ 409 by NAME in
 *     `FacadeExceptionFilter`) rather than a bare `GitFacadeError` (→ 500) or
 *     a TypeError. The one exception is `getInteractionLimit`, whose absence
 *     answers `null` — the same "cannot tell" its provider answers on a
 *     403/404, and never the fabricated `'none'` G16 forbids.
 */

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;
const MEMBER = { userId: 'user-1', providerId: 'github' } as const;

const BRANCH = { name: 'upstream-pr/widgets-1a2b', sha: SHA, protected: false };

const DIFF: GitDiffResult = {
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
    truncated: false,
    totalFiles: 1,
    totalAdditions: 1,
    totalDeletions: 0,
    patchBytes: 0,
};

function makeFacade() {
    const authAccountRepository = {
        findConnectedProviderAccount: jest.fn().mockResolvedValue(null),
        findProviderAccount: jest.fn().mockResolvedValue(null),
    };
    const settingsService = { getResolvedSettings: jest.fn().mockResolvedValue({}) };
    const workRepository = { findById: jest.fn().mockResolvedValue(null) };

    const facade = new GitFacadeService(
        {} as never,
        authAccountRepository as never,
        settingsService as never,
        workRepository as never,
        {} as never,
    );

    return { facade, authAccountRepository, settingsService, workRepository };
}

/**
 * The private members this spec has to reach: the two Work-scoped resolvers it
 * spies on, and the plugin resolution it stubs for the pass-through assertions
 * (those are not about credential resolution).
 */
type FacadeInternals = {
    tryResolveEverWorksGitPlatformToken: (options: unknown) => Promise<string | null>;
    getInstallationTokenForWork: (options: unknown) => Promise<string | null>;
    resolvePlugin: (providerId: string, userId?: string, workId?: string) => Promise<unknown>;
    resolvePluginAndToken: (options: unknown) => Promise<{ plugin: unknown; token: string }>;
};

function internals(facade: GitFacadeService): FacadeInternals {
    return facade as unknown as FacadeInternals;
}

/** Resolve a plugin with a known token, bypassing credential lookup. */
function withPlugin(facade: GitFacadeService, plugin: Record<string, unknown>): GitFacadeService {
    internals(facade).resolvePluginAndToken = jest
        .fn()
        .mockResolvedValue({ plugin: { id: 'github', ...plugin }, token: 'member-token' });
    return facade;
}

describe('GitFacadeService — the member account token (APW-09 FR-24)', () => {
    it("returns the member's connected provider account token", async () => {
        const { facade, authAccountRepository, settingsService } = makeFacade();
        authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
            accessToken: 'gho_member_oauth',
        });

        await expect(facade.getMemberAccountToken(MEMBER)).resolves.toBe('gho_member_oauth');

        expect(authAccountRepository.findConnectedProviderAccount).toHaveBeenCalledWith(
            'user-1',
            'github',
            { usePluginProviderId: true, requiredScopes: ['repo'] },
        );
        // The account answered, so the settings PAT is not consulted at all.
        expect(settingsService.getResolvedSettings).not.toHaveBeenCalled();
    });

    it("falls back to the member's own plugin-settings PAT, with no Work scope", async () => {
        const { facade, settingsService } = makeFacade();
        settingsService.getResolvedSettings.mockResolvedValue({
            accessToken: { value: 'ghp_member_pat' },
        });

        await expect(facade.getMemberAccountToken(MEMBER)).resolves.toBe('ghp_member_pat');

        expect(settingsService.getResolvedSettings).toHaveBeenCalledWith('github', {
            userId: 'user-1',
            workId: undefined,
            includeSecrets: true,
        });
    });

    it('returns null when the member has neither an account nor a PAT', async () => {
        const { facade } = makeFacade();
        await expect(facade.getMemberAccountToken(MEMBER)).resolves.toBeNull();
    });

    it('never calls the two Work-scoped resolvers', async () => {
        const { facade, authAccountRepository } = makeFacade();
        authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
            accessToken: 'gho_member_oauth',
        });
        const platformSpy = jest.spyOn(internals(facade), 'tryResolveEverWorksGitPlatformToken');
        const installationSpy = jest.spyOn(internals(facade), 'getInstallationTokenForWork');

        await expect(facade.getMemberAccountToken(MEMBER)).resolves.toBe('gho_member_oauth');

        expect(platformSpy).not.toHaveBeenCalled();
        expect(installationSpy).not.toHaveBeenCalled();
    });

    it('ignores a workId an over-eager caller smuggles in', async () => {
        const { facade, authAccountRepository, workRepository } = makeFacade();
        authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
            accessToken: 'gho_member_oauth',
        });
        const platformSpy = jest.spyOn(internals(facade), 'tryResolveEverWorksGitPlatformToken');
        const installationSpy = jest.spyOn(internals(facade), 'getInstallationTokenForWork');

        // There is no `workId` on `MemberAccountTokenOptions`; this is what a
        // caller would pass if it believed otherwise.
        const smuggled = {
            ...MEMBER,
            workId: 'work-1',
        } as unknown as MemberAccountTokenOptions;

        await expect(facade.getMemberAccountToken(smuggled)).resolves.toBe('gho_member_oauth');

        expect(platformSpy).not.toHaveBeenCalled();
        expect(installationSpy).not.toHaveBeenCalled();
        // Not even the Work row is read: this credential has no Work scope.
        expect(workRepository.findById).not.toHaveBeenCalled();
    });

    it('positive control: the Work-scoped path DOES call both resolvers', async () => {
        const { facade, authAccountRepository } = makeFacade();
        authAccountRepository.findConnectedProviderAccount.mockResolvedValue(null);
        internals(facade).resolvePlugin = jest.fn().mockResolvedValue({ id: 'github' });
        const platformSpy = jest.spyOn(internals(facade), 'tryResolveEverWorksGitPlatformToken');
        const installationSpy = jest.spyOn(internals(facade), 'getInstallationTokenForWork');

        // `getUser` is an ordinary Work-scoped facade call, so
        // `resolvePluginAndToken` runs: the platform PAT first, then the App
        // installation token, before it falls back to the member account. Both
        // are the very calls the assertions above expect to be missing, so a
        // spy that cannot see THEM cannot be trusted when it reports nothing
        // on the member path. The call ends in `NoGitCredentialsError` because
        // neither credential exists — which is the point: both spies fired on
        // the way there.
        await expect(facade.getUser(OPTIONS)).rejects.toMatchObject({
            name: 'NoGitCredentialsError',
        });

        expect(platformSpy).toHaveBeenCalledWith(OPTIONS);
        expect(installationSpy).toHaveBeenCalledWith(OPTIONS);
    });
});

describe('GitFacadeService — APW-09 T3 pass-throughs (branch at a sha, fast-forward)', () => {
    it('delegates createBranchFromSha with the resolved token', async () => {
        const { facade } = makeFacade();
        const createBranchFromSha = jest.fn().mockResolvedValue(BRANCH);
        withPlugin(facade, { createBranchFromSha });

        await expect(
            facade.createBranchFromSha(
                'member',
                'widgets',
                'upstream-pr/widgets-1a2b',
                SHA,
                OPTIONS,
            ),
        ).resolves.toEqual(BRANCH);

        expect(createBranchFromSha).toHaveBeenCalledWith(
            'member',
            'widgets',
            'upstream-pr/widgets-1a2b',
            SHA,
            'member-token',
        );
    });

    it('raises GitOperationNotSupportedError — and NOT a bare GitFacadeError — when createBranchFromSha is absent', async () => {
        const { facade } = makeFacade();
        withPlugin(facade, {});

        const failure = (await facade
            .createBranchFromSha('member', 'widgets', 'b', SHA, OPTIONS)
            .then(() => null)
            .catch((error: unknown) => error)) as GitFacadeError;

        expect(failure).toBeInstanceOf(GitOperationNotSupportedError);
        expect(failure.constructor).toBe(GitOperationNotSupportedError);
        // `GitOperationNotSupportedError` IS a `GitFacadeError` subclass, so
        // `toBeInstanceOf(GitFacadeError)` could never fail and would prove
        // nothing. What the API boundary reads is the NAME:
        // `FacadeExceptionFilter` maps this name to 409 and an unmapped one —
        // the bare `GitFacadeError` this must never be — to a 500.
        expect(failure.name).toBe('GitOperationNotSupportedError');
        expect(failure.name).not.toBe('GitFacadeError');
        expect(failure).toMatchObject({
            operation: 'createBranchFromSha',
            provider: 'github',
        });
    });

    it('delegates updateBranchRef as a fast-forward only, with the resolved token', async () => {
        const { facade } = makeFacade();
        const updateBranchRef = jest.fn().mockResolvedValue(BRANCH);
        withPlugin(facade, { updateBranchRef });

        await expect(
            facade.updateBranchRef(
                'member',
                'widgets',
                'upstream-pr/widgets-1a2b',
                SHA,
                { force: false },
                OPTIONS,
            ),
        ).resolves.toEqual(BRANCH);

        expect(updateBranchRef).toHaveBeenCalledWith(
            'member',
            'widgets',
            'upstream-pr/widgets-1a2b',
            SHA,
            { force: false },
            'member-token',
        );
    });

    it('raises GitOperationNotSupportedError when updateBranchRef is absent', async () => {
        const { facade } = makeFacade();
        withPlugin(facade, {});

        await expect(
            facade.updateBranchRef('member', 'widgets', 'b', SHA, { force: false }, OPTIONS),
        ).rejects.toMatchObject({
            name: 'GitOperationNotSupportedError',
            operation: 'updateBranchRef',
        });
    });
});

describe('GitFacadeService — APW-09 T2 pass-throughs (reviews, review comments, interaction limit)', () => {
    const REVIEW = {
        id: 7,
        author: 'reviewer-1',
        state: 'changes_requested' as const,
        body: 'please split this',
        submittedAt: '2026-09-17T10:00:00Z',
    };

    const COMMENT = {
        id: 9,
        author: 'reviewer-1',
        body: 'this line',
        path: 'src/a.ts',
        line: 12,
        createdAt: '2026-09-17T10:01:00Z',
    };

    it('delegates listPullRequestReviews and forwards the provider answer verbatim', async () => {
        const { facade } = makeFacade();
        const listPullRequestReviews = jest.fn().mockResolvedValue([REVIEW]);
        withPlugin(facade, { listPullRequestReviews });

        await expect(
            facade.listPullRequestReviews('upstream', 'project', 41, OPTIONS),
        ).resolves.toEqual([REVIEW]);
        expect(listPullRequestReviews).toHaveBeenCalledWith(
            'upstream',
            'project',
            41,
            'member-token',
        );
    });

    it('throws GitOperationNotSupportedError when the provider cannot list reviews', async () => {
        const { facade } = makeFacade();
        withPlugin(facade, {});

        // Not `[]`: an empty list would claim "nobody reviewed", which is a
        // different fact from "this provider cannot answer".
        await expect(
            facade.listPullRequestReviews('upstream', 'project', 41, OPTIONS),
        ).rejects.toMatchObject({
            name: 'GitOperationNotSupportedError',
            operation: 'listPullRequestReviews',
        });
    });

    it('delegates listPullRequestReviewComments', async () => {
        const { facade } = makeFacade();
        const listPullRequestReviewComments = jest.fn().mockResolvedValue([COMMENT]);
        withPlugin(facade, { listPullRequestReviewComments });

        await expect(
            facade.listPullRequestReviewComments('upstream', 'project', 41, OPTIONS),
        ).resolves.toEqual([COMMENT]);
        expect(listPullRequestReviewComments).toHaveBeenCalledWith(
            'upstream',
            'project',
            41,
            'member-token',
        );
    });

    it('throws GitOperationNotSupportedError when the provider cannot list review comments', async () => {
        const { facade } = makeFacade();
        withPlugin(facade, {});

        await expect(
            facade.listPullRequestReviewComments('upstream', 'project', 41, OPTIONS),
        ).rejects.toMatchObject({
            name: 'GitOperationNotSupportedError',
            operation: 'listPullRequestReviewComments',
        });
    });

    it('forwards each interaction-limit answer verbatim, including null', async () => {
        const { facade } = makeFacade();
        const getInteractionLimit = jest
            .fn()
            .mockResolvedValueOnce('contributors_only')
            .mockResolvedValueOnce(null);
        withPlugin(facade, { getInteractionLimit });

        await expect(facade.getInteractionLimit('upstream', 'project', OPTIONS)).resolves.toBe(
            'contributors_only',
        );
        // G16: the provider's own 403/404 answer is "cannot tell", and it must
        // never be rewritten into `'none'` on the way out.
        await expect(
            facade.getInteractionLimit('upstream', 'project', OPTIONS),
        ).resolves.toBeNull();
    });

    it('answers null — never `none` — when the provider has no such read', async () => {
        const { facade } = makeFacade();
        withPlugin(facade, {});

        const answer = await facade.getInteractionLimit('upstream', 'project', OPTIONS);

        expect(answer).toBeNull();
        expect(answer).not.toBe('none');
    });
});

describe('GitFacadeService — APW-09 T1 fields ride the existing pass-throughs', () => {
    it('createPullRequest forwards the caller options object by identity', async () => {
        const { facade } = makeFacade();
        const createPullRequest = jest.fn().mockResolvedValue({ number: 41 });
        withPlugin(facade, { createPullRequest });

        // The fields T1 adds to `CreatePROptions`. The cast is the point: the
        // facade forwards the OBJECT, so a field it has never heard of — today
        // `headOwner` / `headRepo` / `maintainerCanModify` — reaches the
        // provider untouched, with no facade change when T1 lands.
        const prOptions = {
            owner: 'upstream',
            repo: 'project',
            title: 'Fix the widget',
            body: 'body',
            head: 'upstream-pr/widgets-1a2b',
            base: 'main',
            headOwner: 'member',
            headRepo: 'project',
            maintainerCanModify: true,
        } as unknown as CreatePROptions;

        await facade.createPullRequest(prOptions, OPTIONS);

        const forwarded = createPullRequest.mock.calls[0][0];
        expect(forwarded).toBe(prOptions);
        expect(forwarded).toMatchObject({
            headOwner: 'member',
            headRepo: 'project',
            maintainerCanModify: true,
        });
        expect(createPullRequest).toHaveBeenCalledWith(prOptions, 'member-token');
    });

    it('listPullRequests forwards `head` on the list options unchanged', async () => {
        const { facade } = makeFacade();
        const listPullRequests = jest.fn().mockResolvedValue([]);
        withPlugin(facade, { listPullRequests });

        const listOptions = {
            state: 'all',
            head: 'member:upstream-pr/widgets-1a2b',
        } as unknown as ListPullRequestsOptions;

        await facade.listPullRequests('upstream', 'project', listOptions, OPTIONS);

        expect(listPullRequests.mock.calls[0][2]).toBe(listOptions);
        expect(listPullRequests).toHaveBeenCalledWith(
            'upstream',
            'project',
            listOptions,
            'member-token',
        );
    });

    it('the reads return the provider result object untouched', async () => {
        const { facade } = makeFacade();
        // `totalCommits` (T1) and `headRepoFullName` (T1) are mapped inside the
        // provider; the facade must not rebuild the object on the way out.
        const diff = { ...DIFF, totalCommits: 3 };
        const getPullRequestDiff = jest.fn().mockResolvedValue(diff);
        const headRepoFullName = 'member/project';
        const getPullRequest = jest.fn().mockResolvedValue({ number: 41, headRepoFullName });
        withPlugin(facade, { getPullRequestDiff, getPullRequest });

        const diffResult = await facade.getPullRequestDiff(
            'upstream',
            'project',
            41,
            undefined,
            OPTIONS,
        );
        const prResult = await facade.getPullRequest('upstream', 'project', 41, OPTIONS);

        expect(diffResult).toBe(diff);
        expect((diffResult as unknown as { totalCommits: number }).totalCommits).toBe(3);
        expect(prResult).toEqual({ number: 41, headRepoFullName });
        expect((prResult as unknown as { headRepoFullName: string }).headRepoFullName).toBe(
            'member/project',
        );
    });
});
