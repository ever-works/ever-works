jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));

import {
    GitHubPrReviewBridgeService,
    extractGitHubWorkspaceRef,
} from './github-pr-review-bridge.service';

/** Flush the fire-and-forget review promise chain. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const BINDING = { userId: 'user-1', webhookSecret: 'sec', matchedBy: 'binding' as const };

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
        const installBindings = {
            findByWorkspace: jest.fn().mockResolvedValue(null),
            record: jest.fn().mockResolvedValue(null),
        };
        const service = new GitHubPrReviewBridgeService(
            userPluginRepository as any,
            pluginSettingsService as any,
            eventIngestService as any,
            prReviewService as any,
            installBindings as any,
        );
        return {
            service,
            userPluginRepository,
            pluginSettingsService,
            eventIngestService,
            prReviewService,
            installBindings,
        };
    }

    /**
     * Per-installation binding.
     *
     * The receiver used to resolve "the oldest enabled install
     * platform-wide" and attribute EVERY inbound delivery to that one
     * platform user — a multi-tenant data-isolation defect (a second
     * customer's repository had its diffs reviewed under, and billed to,
     * the first customer's account). These cases pin the replacement.
     */
    describe('resolveBinding', () => {
        function twoInstalls(overrides: { sharedSecret?: boolean } = {}) {
            const ctx = createService();
            ctx.userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u-a', enabled: true, createdAt: new Date('2026-01-01') },
                { userId: 'u-disabled', enabled: false, createdAt: new Date('2025-01-01') },
                { userId: 'u-b', enabled: true, createdAt: new Date('2026-02-01') },
            ]);
            ctx.pluginSettingsService.getSettings.mockImplementation(
                async (_pluginId: string, opts: { userId: string }) => ({
                    webhookSecret: overrides.sharedSecret ? 'shared' : `sec-${opts.userId}`,
                }),
            );
            return ctx;
        }

        it('routes each installation to its OWN owner when two installs exist', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockImplementation(
                async (_provider: string, key: string) =>
                    key === 'owner:octo'
                        ? { userId: 'u-a' }
                        : key === 'owner:acme'
                          ? { userId: 'u-b' }
                          : null,
            );

            await expect(
                service.resolveBinding({ workspace: { keys: ['owner:octo'] } }),
            ).resolves.toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-a', webhookSecret: 'sec-u-a', matchedBy: 'binding' },
            });
            await expect(
                service.resolveBinding({ workspace: { keys: ['owner:acme'] } }),
            ).resolves.toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-b', webhookSecret: 'sec-u-b', matchedBy: 'binding' },
            });
        });

        it('prefers the installation id over the repository owner key', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockImplementation(
                async (_provider: string, key: string) =>
                    key === 'installation:99' ? { userId: 'u-b' } : { userId: 'u-a' },
            );

            const result = await service.resolveBinding({
                workspace: { keys: ['installation:99', 'owner:octo'] },
            });
            expect(result).toMatchObject({ status: 'resolved', binding: { userId: 'u-b' } });
        });

        it('REFUSES an unknown installation instead of guessing an owner', async () => {
            const { service } = twoInstalls();
            await expect(
                service.resolveBinding({ workspace: { keys: ['owner:stranger'] } }),
            ).resolves.toEqual({ status: 'unresolved', reason: 'unknown-workspace' });
        });

        it('REFUSES when the bound install is disabled — never re-points at another tenant', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockResolvedValue({ userId: 'u-disabled' });
            await expect(
                service.resolveBinding({ workspace: { keys: ['owner:octo'] } }),
            ).resolves.toEqual({ status: 'unresolved', reason: 'bound-install-unavailable' });
        });

        it('resolves by unique signature proof — each install has its own webhook secret', async () => {
            const { service } = twoInstalls();
            const result = await service.resolveBinding({
                workspace: { keys: ['owner:stranger'] },
                verifySignature: (secret) => secret === 'sec-u-b',
            });
            expect(result).toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-b', matchedBy: 'signature' },
            });
        });

        it('REFUSES when several installs share a webhook secret', async () => {
            const { service } = twoInstalls({ sharedSecret: true });
            const result = await service.resolveBinding({
                workspace: { keys: ['owner:stranger'] },
                verifySignature: () => true,
            });
            expect(result).toEqual({ status: 'unresolved', reason: 'ambiguous-install' });
        });

        it('legacy single-install path still works (and is flagged as the fallback)', async () => {
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

            const result = await service.resolveBinding({
                workspace: { keys: ['owner:octo'], label: 'octo' },
            });
            expect(result).toMatchObject({
                status: 'resolved',
                binding: {
                    userId: 'u-older',
                    webhookSecret: 's3cr3t',
                    matchedBy: 'single-install',
                },
            });
        });

        it('reports not-configured (fail-closed 401 upstream) when no install carries a secret', async () => {
            const { service, userPluginRepository } = createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u1', enabled: true, createdAt: new Date() },
            ]);
            await expect(service.resolveBinding()).resolves.toEqual({ status: 'not-configured' });
        });
    });

    describe('recordBinding', () => {
        it('persists the installation→user binding after a fallback match', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-older',
                webhookSecret: 's',
                matchedBy: 'single-install',
                workspace: { keys: ['owner:octo'], label: 'octo' },
            });
            expect(installBindings.record).toHaveBeenCalledWith({
                provider: 'github',
                externalWorkspaceId: 'owner:octo',
                userId: 'u-older',
                pluginId: 'github',
                externalWorkspaceName: 'octo',
            });
        });

        it('is a no-op when the binding already came from the table', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-a',
                webhookSecret: 's',
                matchedBy: 'binding',
                workspace: { keys: ['owner:octo'] },
            });
            expect(installBindings.record).not.toHaveBeenCalled();
        });

        it('swallows a repository failure (a verified webhook must not 500)', async () => {
            const { service, installBindings } = createService();
            installBindings.record.mockRejectedValue(new Error('db down'));
            await expect(
                service.recordBinding({
                    userId: 'u-a',
                    webhookSecret: 's',
                    matchedBy: 'single-install',
                    workspace: { keys: ['owner:octo'] },
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe('extractGitHubWorkspaceRef', () => {
        it('prefers the App installation id, then the repository owner', () => {
            expect(
                extractGitHubWorkspaceRef({
                    installation: { id: 99 },
                    repository: { full_name: 'Octo/site' },
                } as any),
            ).toEqual({ keys: ['installation:99', 'owner:octo'], label: 'Octo' });
        });

        it('falls back to the repository owner for a user-configured webhook', () => {
            expect(
                extractGitHubWorkspaceRef({ repository: { full_name: 'octo/site' } } as any),
            ).toEqual({ keys: ['owner:octo'], label: 'octo' });
        });

        it('falls back to the organization login (org-level webhook / ping)', () => {
            expect(extractGitHubWorkspaceRef({ organization: { login: 'Acme' } } as any)).toEqual({
                keys: ['owner:acme'],
                label: 'Acme',
            });
        });

        it('returns undefined when the delivery names no installation at all', () => {
            expect(extractGitHubWorkspaceRef({ zen: 'x' } as any)).toBeUndefined();
            expect(extractGitHubWorkspaceRef(undefined)).toBeUndefined();
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
