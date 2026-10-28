// The same heavy-tree doubles as `github-issue-intake.service.spec.ts`: the webhook dispatcher
// imports the GitHub App sync service, whose module graph reaches the API's NotificationsModule →
// AuthModule → the ESM-only `better-auth`, which this CJS Jest cannot parse (this spec, added in
// 547001604, never loaded).
jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));

import {
    GITHUB_PR_INTAKE_ACTIONS,
    GitHubPrIntakeService,
    normalizeGitHubPullRequest,
    type GitHubPullRequestWebhookBody,
} from './github-pr-intake.service';

/**
 * FL-15 P3 — the pull-request intake (spec FR-17, ACC-FL15-11): each owned
 * action becomes a `github.pr` envelope with the logins the "about me"
 * matcher reads; the subject is the bridge's `<owner/repo>#<number>`; the
 * bridge's own actions (`opened`, `synchronize`) are never duplicated.
 */

const body = (patch: Partial<GitHubPullRequestWebhookBody> = {}): GitHubPullRequestWebhookBody => ({
    action: 'review_requested',
    repository: { full_name: 'acme/api' },
    sender: { login: 'lead' },
    requested_reviewer: { login: 'nina' },
    pull_request: {
        number: 912,
        title: 'Fix the cookie',
        html_url: 'https://github.com/acme/api/pull/912',
        state: 'open',
        user: { login: 'sam' },
        assignees: [{ login: 'nina' }],
        requested_reviewers: [{ login: 'nina' }],
        head: { ref: 'fix-cookie', sha: 'abc', repo: { full_name: 'sam/api', fork: true } },
        base: { ref: 'main', repo: { full_name: 'acme/api' } },
        maintainer_can_modify: true,
        author_association: 'contributor',
        updated_at: '2026-10-21T12:00:00Z',
    },
    ...patch,
});

describe('normalizeGitHubPullRequest', () => {
    it('turns a review request into a github.pr envelope naming the reviewer', () => {
        const envelope = normalizeGitHubPullRequest(body())!;
        expect(envelope.kind).toBe('github.pr');
        expect(envelope.subject).toEqual(
            expect.objectContaining({ type: 'pull_request', externalId: 'acme/api#912' }),
        );
        expect(envelope.payload).toEqual(
            expect.objectContaining({
                action: 'review_requested',
                requestedReviewer: 'nina',
                author: 'sam',
                assignees: ['nina'],
                headRef: 'fix-cookie',
                headRepo: 'sam/api',
                fork: true,
                maintainerCanModify: true,
                baseRef: 'main',
                authorAssociation: 'CONTRIBUTOR',
            }),
        );
        expect(envelope.sourceEventId).toBe(
            'pr-intake:acme/api#912@review_requested:nina:2026-10-21T12:00:00.000Z',
        );
    });

    it.each(GITHUB_PR_INTAKE_ACTIONS)('owns %s', (action) => {
        expect(normalizeGitHubPullRequest(body({ action }))).not.toBeNull();
    });

    it('leaves the review bridge its own actions', () => {
        expect(normalizeGitHubPullRequest(body({ action: 'opened' }))).toBeNull();
        expect(normalizeGitHubPullRequest(body({ action: 'synchronize' }))).toBeNull();
    });

    it('names the assignee on an assignment and keeps a same-repo branch writable', () => {
        const envelope = normalizeGitHubPullRequest(
            body({
                action: 'assigned',
                assignee: { login: 'nina' },
                pull_request: {
                    ...body().pull_request,
                    head: { ref: 'x', repo: { full_name: 'acme/api', fork: false } },
                },
            }),
        )!;
        expect(envelope.payload).toEqual(
            expect.objectContaining({ assignee: 'nina', fork: false }),
        );
    });

    it('refuses a delivery without a repository or a number', () => {
        expect(normalizeGitHubPullRequest(body({ repository: {} }))).toBeNull();
        expect(normalizeGitHubPullRequest(body({ pull_request: { title: 'x' } }))).toBeNull();
    });
});

describe('GitHubPrIntakeService', () => {
    it('registers on the one dispatcher and ingests for the bound user', async () => {
        const dispatcher = { registerConsumer: jest.fn() };
        const ingest = { ingest: jest.fn(async () => ({ inserted: 1, deduped: 0 })) };
        const service = new GitHubPrIntakeService(dispatcher as never, ingest as never);
        service.onModuleInit();
        expect(dispatcher.registerConsumer).toHaveBeenCalledWith(service);
        await service.handle({ userId: 'u-1' } as never, 'pull_request', body() as never);
        expect(ingest.ingest).toHaveBeenCalledWith('u-1', [
            expect.objectContaining({ kind: 'github.pr' }),
        ]);
        const skipped = await service.handle({ userId: 'u-1' } as never, 'issues', body() as never);
        expect(skipped.ingested).toBeNull();
    });
});
