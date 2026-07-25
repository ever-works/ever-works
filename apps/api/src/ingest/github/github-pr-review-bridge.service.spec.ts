jest.mock('@ever-works/agent/ingest', () => ({ EventIngestService: class {} }));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));

import { GitHubPrReviewBridgeService } from './github-pr-review-bridge.service';

/** Flush the fire-and-forget review promise chain. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const BINDING = { userId: 'user-1', webhookSecret: 'sec' };

function prOpenedBody(overrides: Record<string, unknown> = {}) {
    return {
        action: 'opened',
        repository: { full_name: 'octo/site' },
        sender: { login: 'octocat', type: 'User' },
        pull_request: {
            number: 7,
            title: 'Add landing page',
            html_url: 'https://example.com/octo/site/pull/7',
            head: { sha: 'abc123', ref: 'feat/landing' },
            base: { ref: 'main' },
            user: { login: 'octocat', type: 'User' },
        },
        ...overrides,
    };
}

function mentionCommentBody(overrides: Record<string, unknown> = {}) {
    return {
        action: 'created',
        repository: { full_name: 'octo/site' },
        issue: {
            number: 7,
            title: 'Add landing page',
            pull_request: { url: 'https://example.com/api/pulls/7' },
        },
        comment: {
            id: 42,
            body: '@ever-works is this migration safe to roll back?',
            html_url: 'https://example.com/octo/site/pull/7#issuecomment-42',
            user: { login: 'octocat', type: 'User' },
        },
        ...overrides,
    };
}

describe('GitHubPrReviewBridgeService', () => {
    function createService() {
        const userPluginRepository = { findByPlugin: jest.fn().mockResolvedValue([]) };
        const pluginSettingsService = { getSettings: jest.fn().mockResolvedValue({}) };
        const eventIngestService = {
            ingest: jest.fn().mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0 }),
        };
        const prReviewService = {
            reviewPullRequest: jest.fn().mockResolvedValue({
                status: 'posted',
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
                summary: 'LGTM',
                comments: [],
                commentId: 1,
                context: { work: false, kb: false, memory: false },
            }),
        };
        const service = new GitHubPrReviewBridgeService(
            userPluginRepository as any,
            pluginSettingsService as any,
            eventIngestService as any,
            prReviewService as any,
        );
        return {
            service,
            userPluginRepository,
            pluginSettingsService,
            eventIngestService,
            prReviewService,
        };
    }

    describe('resolveBinding', () => {
        it('returns the oldest enabled install with a webhookSecret', async () => {
            const { service, userPluginRepository, pluginSettingsService } = createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u-newer', enabled: true, createdAt: new Date('2026-02-01') },
                { userId: 'u-older', enabled: true, createdAt: new Date('2026-01-01') },
                { userId: 'u-disabled', enabled: false, createdAt: new Date('2025-01-01') },
            ]);
            pluginSettingsService.getSettings.mockImplementation(
                async (_pluginId: string, opts: { userId: string }) =>
                    opts.userId === 'u-older' ? { webhookSecret: 's3cr3t' } : {},
            );
            const binding = await service.resolveBinding();
            expect(binding).toEqual({ userId: 'u-older', webhookSecret: 's3cr3t' });
        });

        it('returns null when no enabled install carries a secret (fail-closed input)', async () => {
            const { service, userPluginRepository } = createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u1', enabled: true, createdAt: new Date() },
            ]);
            await expect(service.resolveBinding()).resolves.toBeNull();
        });
    });

    describe('pull_request events', () => {
        it('ingests a github.pr envelope and triggers a review on first sight', async () => {
            const { service, eventIngestService, prReviewService } = createService();
            const result = await service.handleEvent(BINDING, 'pull_request', prOpenedBody());
            await flush();

            expect(result.ingested).toEqual({ inserted: 1, duplicates: 0, rejected: 0 });
            const [userId, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(envelopes[0]).toMatchObject({
                source: 'github',
                kind: 'github.pr',
                sourceEventId: 'pr:octo/site#7@abc123',
                sourceUrl: 'https://example.com/octo/site/pull/7',
            });
            expect(prReviewService.reviewPullRequest).toHaveBeenCalledWith({
                userId: 'user-1',
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
            });
        });

        it('does NOT trigger a review on a duplicate delivery (dedupe → 0 inserts)', async () => {
            const { service, eventIngestService, prReviewService } = createService();
            eventIngestService.ingest.mockResolvedValue({
                inserted: 0,
                duplicates: 1,
                rejected: 0,
            });
            await service.handleEvent(BINDING, 'pull_request', prOpenedBody());
            await flush();
            expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
        });

        it('ignores non-review actions (closed) entirely', async () => {
            const { service, eventIngestService } = createService();
            const result = await service.handleEvent(
                BINDING,
                'pull_request',
                prOpenedBody({ action: 'closed' }),
            );
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('reviews each pushed revision once — synchronize with a new head SHA', async () => {
            const { service, eventIngestService } = createService();
            await service.handleEvent(
                BINDING,
                'pull_request',
                prOpenedBody({
                    action: 'synchronize',
                    pull_request: {
                        number: 7,
                        title: 'Add landing page',
                        html_url: 'https://example.com/octo/site/pull/7',
                        head: { sha: 'def456' },
                        user: { login: 'octocat' },
                    },
                }),
            );
            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes[0].sourceEventId).toBe('pr:octo/site#7@def456');
        });

        it('carries the repo workHint so the spine can route the event to a Work', async () => {
            const { service, eventIngestService } = createService();
            await service.handleEvent(BINDING, 'pull_request', prOpenedBody());
            await flush();

            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes[0].workHint).toEqual({ kind: 'repo', externalId: 'octo/site' });
        });
    });

    describe('@ever-works mention loop', () => {
        it('routes a PR comment mention into a review with the comment as instruction', async () => {
            const { service, eventIngestService, prReviewService } = createService();
            await service.handleEvent(BINDING, 'issue_comment', mentionCommentBody());
            await flush();

            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes[0]).toMatchObject({
                kind: 'github.mention',
                sourceEventId: 'comment:octo/site:42',
                workHint: { kind: 'repo', externalId: 'octo/site' },
            });
            expect(prReviewService.reviewPullRequest).toHaveBeenCalledWith({
                userId: 'user-1',
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
                instruction: 'is this migration safe to roll back?',
            });
        });

        it('skips comments without an @ever-works mention', async () => {
            const { service, eventIngestService } = createService();
            const body = mentionCommentBody();
            (body.comment as any).body = 'looks good to me';
            const result = await service.handleEvent(BINDING, 'issue_comment', body);
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('skips bot-authored comments (never echoes its own replies)', async () => {
            const { service, eventIngestService } = createService();
            const body = mentionCommentBody();
            (body.comment as any).user = { login: 'ever-works[bot]', type: 'Bot' };
            const result = await service.handleEvent(BINDING, 'issue_comment', body);
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('skips issue comments that are not on a pull request', async () => {
            const { service, eventIngestService } = createService();
            const body = mentionCommentBody();
            (body.issue as any).pull_request = undefined;
            const result = await service.handleEvent(BINDING, 'issue_comment', body);
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('handles pull_request_review_comment mentions (thread on a diff line)', async () => {
            const { service, prReviewService } = createService();
            await service.handleEvent(BINDING, 'pull_request_review_comment', {
                action: 'created',
                repository: { full_name: 'octo/site' },
                pull_request: { number: 9, title: 'Refactor' },
                comment: {
                    id: 77,
                    body: '@ever-works why was this loop unrolled?',
                    user: { login: 'octocat', type: 'User' },
                },
            });
            await flush();
            expect(prReviewService.reviewPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 9,
                    instruction: 'why was this loop unrolled?',
                }),
            );
        });
    });

    it('ignores unknown event names', async () => {
        const { service, eventIngestService } = createService();
        const result = await service.handleEvent(BINDING, 'workflow_run', {
            repository: { full_name: 'octo/site' },
        });
        expect(result.ingested).toBeNull();
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('a review failure never rejects the webhook path', async () => {
        const { service, prReviewService } = createService();
        prReviewService.reviewPullRequest.mockRejectedValue(new Error('AI provider down'));
        await expect(service.handleEvent(BINDING, 'pull_request', prOpenedBody())).resolves.toEqual(
            { ingested: { inserted: 1, duplicates: 0, rejected: 0 } },
        );
        await flush();
    });
});
