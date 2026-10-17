import { UpstreamPullRequestOpenService } from '../upstream-pull-request-open.service';

/** APW-09 — `POST /api/works/:id/upstream-pr` over the cross-repository PR facade. */

function work(type = 'app_fork') {
    return {
        id: 'w1',
        userId: 'owner',
        kind: 'app',
        sourceRepository: {
            type,
            owner: 'me',
            repo: 'helpdesk',
            upstream: { owner: 'example-org', repo: 'helpdesk', defaultBranch: 'main' },
        },
        getRepoOwner: () => 'me',
        getDataRepo: () => 'helpdesk-data',
        getWebsiteRepo: () => 'helpdesk',
    };
}

function build(w = work()) {
    const works = { findById: jest.fn(async () => w) };
    const tasks = {
        findById: jest.fn(async (id: string) =>
            id === 't1'
                ? {
                      id: 't1',
                      workId: 'w1',
                      branchRef: 'ever-works/t-1',
                      title: 'Change: Add dark mode',
                  }
                : null,
        ),
    };
    const credentials = {
        resolveForPublishingMember: jest.fn(async () => ({
            usable: true,
            workId: 'w1',
            memberUserId: 'editor',
            credential: { userId: 'editor', providerId: 'github', token: 'tok' },
        })),
    };
    const git = {
        createPullRequest: jest.fn(async () => ({
            number: 7,
            url: 'https://github.com/example-org/helpdesk/pull/7',
        })),
    };
    const service = new UpstreamPullRequestOpenService(
        works as never,
        tasks as never,
        credentials as never,
        git as never,
    );
    return { service, git, credentials };
}

describe('UpstreamPullRequestOpenService (APW-09)', () => {
    it("opens a draft PR from the fork's Task branch with the caller's own credential", async () => {
        const { service, git, credentials } = build();
        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });
        expect(result).toMatchObject({
            status: 'opened',
            httpStatus: 201,
            number: 7,
            head: 'me:ever-works/t-1',
            base: 'main',
            upstream: 'example-org/helpdesk',
            draft: true,
        });
        expect(credentials.resolveForPublishingMember).toHaveBeenCalledWith('w1', 'editor');
        expect(git.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'example-org',
                repo: 'helpdesk',
                head: 'ever-works/t-1',
                headOwner: 'me',
                base: 'main',
                title: 'Add dark mode',
                draft: true,
                maintainerCanModify: true,
            }),
            expect.objectContaining({ token: 'tok', providerId: 'github' }),
        );
    });

    it('refuses a private copy (no fork network) and a missing branch', async () => {
        await expect(
            build(work('app_private_copy')).service.open({
                workId: 'w1',
                callerUserId: 'u',
                branch: 'x',
            }),
        ).resolves.toMatchObject({ status: 'refused', code: 'notAFork' });
        await expect(
            build().service.open({ workId: 'w1', callerUserId: 'u' }),
        ).resolves.toMatchObject({
            status: 'refused',
            code: 'branchRequired',
        });
    });
});

describe('UpstreamPullRequestOpenService operator controls (APW-09 FR-41 / FR-46)', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it('refuses everything while the kill switch is off', async () => {
        process.env.APP_WORKS_UPSTREAM_PRS_ENABLED = 'false';
        const { service, git } = build();
        await expect(
            service.open({ workId: 'w1', callerUserId: 'u', branch: 'x' }),
        ).resolves.toMatchObject({
            code: 'upstreamPaused',
        });
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });

    it('refuses a denied upstream, case-insensitively', async () => {
        process.env.APP_WORKS_UPSTREAM_DENY_LIST = 'other/thing, Example-Org/Helpdesk';
        const { service, git } = build();
        await expect(
            service.open({ workId: 'w1', callerUserId: 'u', branch: 'x' }),
        ).resolves.toMatchObject({
            code: 'deniedUpstream',
        });
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });
});
