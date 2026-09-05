jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
// The bridge injects two tasks-domain services by class. Mocking the
// subpath keeps this unit suite from loading TasksDomainModule's entire
// import graph (facades → agent-plugins → …) just to obtain two tokens.
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TaskGitLinkService: class {},
    TaskReviewRejectionService: class {},
}));

import {
    GITHUB_PUSH_COMMITS_MAX,
    GitHubPrReviewBridgeService,
    extractGitHubWorkspaceRef,
    isGitActivityDelivery,
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
            recordIfAbsent: jest.fn().mockResolvedValue(null),
        };
        // Orchestration M9 - the durable rejection recorder.
        const rejections = {
            recordPullRequestRejection: jest.fn().mockResolvedValue({ id: 'rej-1' }),
        };
        // Git activity ingestion (audit item j) - branch/PR -> Task.
        const taskLinks = {
            findByBranch: jest.fn().mockResolvedValue(null),
            findByPullRequest: jest.fn().mockResolvedValue(null),
        };
        const service = new GitHubPrReviewBridgeService(
            userPluginRepository as any,
            pluginSettingsService as any,
            eventIngestService as any,
            prReviewService as any,
            installBindings as any,
            rejections as any,
            taskLinks as any,
        );
        return {
            service,
            userPluginRepository,
            pluginSettingsService,
            eventIngestService,
            prReviewService,
            installBindings,
            rejections,
            taskLinks,
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
        /**
         * This used to assert `record` — the RE-POINTING write. It must
         * not be: on the `single-install` / `signature` paths the HMAC
         * proves the sender knows THEIR OWN webhook secret, while the
         * workspace key beside it (`owner:<login>`) was read out of the
         * still-unverified body. Any tenant with an enabled `github`
         * install can sign a body naming another org, and `record` would
         * hand them that org's binding — after which app-signed
         * deliveries for the real owner's installation were attributed to
         * the squatter. Insert-only is the write these paths have
         * evidence for.
         */
        it('CLAIMS the installation→user binding insert-only after a fallback match', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-older',
                webhookSecret: 's',
                matchedBy: 'single-install',
                workspace: { keys: ['owner:octo'], label: 'octo' },
            });
            expect(installBindings.recordIfAbsent).toHaveBeenCalledWith({
                provider: 'github',
                externalWorkspaceId: 'owner:octo',
                userId: 'u-older',
                pluginId: 'github',
                externalWorkspaceName: 'octo',
            });
            expect(installBindings.record).not.toHaveBeenCalled();
        });

        it('never takes a workspace key away from the account that already holds it', async () => {
            const { service, installBindings } = createService();
            installBindings.recordIfAbsent.mockResolvedValue({
                userId: 'victim',
                externalWorkspaceId: 'owner:victim-org',
            });

            await service.recordBinding({
                userId: 'squatter',
                webhookSecret: 'squatter-secret',
                matchedBy: 'signature',
                workspace: { keys: ['owner:victim-org'], label: 'victim-org' },
            });

            // Insert-only, and the holder came back — nothing re-pointed.
            expect(installBindings.record).not.toHaveBeenCalled();
        });

        it('RE-POINTS only for an app-install match, whose owner came from platform state', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-app',
                webhookSecret: 'app-secret',
                matchedBy: 'app-install',
                workspace: { keys: ['installation:4242'], label: 'octo' },
            });
            expect(installBindings.record).toHaveBeenCalledWith(
                expect.objectContaining({ externalWorkspaceId: 'installation:4242' }),
            );
            expect(installBindings.recordIfAbsent).not.toHaveBeenCalled();
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
            installBindings.recordIfAbsent.mockRejectedValue(new Error('db down'));
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

        /**
         * The body is attacker-shaped until the signature verifies.
         * A type-narrow `typeof id === 'number'` check found no id in
         * `{"installation":{"id":"4242"}}` and returned a ref WITHOUT the
         * installation key, so the exact-binding step had nothing to look
         * up — while `GitHubAppSyncService.handleWebhook` `String()`s the
         * very same field and acts on it. That divergence is a way to
         * blind the ownership check to the id the delivery is about to
         * act on, so both JSON forms must normalize to one key.
         */
        it('normalizes a STRING installation id to the same key as the number', () => {
            expect(extractGitHubWorkspaceRef({ installation: { id: '4242' } } as any)).toEqual(
                extractGitHubWorkspaceRef({ installation: { id: 4242 } } as any),
            );
            expect(extractGitHubWorkspaceRef({ installation: { id: ' 004242 ' } } as any)).toEqual({
                keys: ['installation:4242'],
            });
        });

        it('ignores an installation id that is not a positive integer', () => {
            for (const id of ['', 'abc', '4242abc', '-1', '0', 0, -5, 1.5, NaN, {}, []]) {
                expect(extractGitHubWorkspaceRef({ installation: { id } } as any)).toBeUndefined();
            }
        });
    });

    /**
     * A stored binding is a much weaker claim than a live HMAC. On the
     * install-secret path `owner:<login>` keys are written from an
     * unverified body, so one tenant can squat a workspace key they do
     * not hold — and a squatted row used to resolve every delivery for
     * that key to the squatter, whose secret then failed verification,
     * 401ing the real owner's webhook forever with no way to evict it.
     */
    describe('resolveBinding: the signature outranks a stored binding', () => {
        it('falls through to the signature proof when the bound install cannot verify', async () => {
            const { service, installBindings, userPluginRepository, pluginSettingsService } =
                createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'squatter', enabled: true, createdAt: new Date('2026-01-01') },
                { userId: 'victim', enabled: true, createdAt: new Date('2026-02-01') },
            ]);
            pluginSettingsService.getSettings.mockImplementation(
                async (_id: string, opts: { userId: string }) => ({
                    webhookSecret: `${opts.userId}-secret`,
                }),
            );
            installBindings.findByWorkspace.mockResolvedValue({
                userId: 'squatter',
                externalWorkspaceId: 'owner:victim-org',
            });

            const resolution = await service.resolveBinding({
                workspace: { keys: ['owner:victim-org'] },
                // Only the victim's real secret verifies this delivery.
                verifySignature: (secret: string) => secret === 'victim-secret',
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'victim', matchedBy: 'signature' },
            });
        });

        it('still trusts the binding when it DOES verify the delivery', async () => {
            const { service, installBindings, userPluginRepository, pluginSettingsService } =
                createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'owner-a', enabled: true, createdAt: new Date('2026-01-01') },
                { userId: 'owner-b', enabled: true, createdAt: new Date('2026-02-01') },
            ]);
            pluginSettingsService.getSettings.mockImplementation(
                async (_id: string, opts: { userId: string }) => ({
                    webhookSecret: `${opts.userId}-secret`,
                }),
            );
            installBindings.findByWorkspace.mockResolvedValue({
                userId: 'owner-a',
                externalWorkspaceId: 'owner:acme',
            });

            const resolution = await service.resolveBinding({
                workspace: { keys: ['owner:acme'] },
                verifySignature: (secret: string) => secret === 'owner-a-secret',
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'owner-a', matchedBy: 'binding' },
            });
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

    /**
     * Git activity ingestion (audit item j).
     *
     * Pushes, the commits inside them and merged pull requests used to be
     * dropped on the floor, so the Activity feed showed none of them.
     * They now take the SAME receiver→envelope→spine path every other
     * kind takes, and they deliberately never enter the review loop.
     */
    describe('git activity ingestion (audit item j)', () => {
        const SHA_BEFORE = '1'.repeat(40);
        const SHA_HEAD = '2'.repeat(40);
        const SHA_FIRST = '3'.repeat(40);
        const SHA_MERGE = '4'.repeat(40);

        function commit(id: string, message: string, over: Record<string, unknown> = {}) {
            return {
                id,
                message,
                url: `https://example.com/octo/site/commit/${id}`,
                distinct: true,
                timestamp: '2026-07-25T10:00:00Z',
                author: { name: 'Octo Cat', username: 'octocat' },
                added: ['a.ts'],
                removed: [],
                modified: ['b.ts'],
                ...over,
            };
        }

        function pushBody(over: Record<string, unknown> = {}) {
            return {
                ref: 'refs/heads/ever/task-t-42',
                before: SHA_BEFORE,
                after: SHA_HEAD,
                created: false,
                deleted: false,
                forced: false,
                compare: 'https://example.com/octo/site/compare/aaa...bbb',
                repository: { full_name: 'octo/site' },
                pusher: { name: 'octocat' },
                sender: { login: 'octocat', type: 'User' },
                head_commit: commit(SHA_HEAD, 'feat: add landing page\n\nwith a body'),
                commits: [
                    commit(SHA_FIRST, 'chore: scaffold'),
                    commit(SHA_HEAD, 'feat: add landing page\n\nwith a body'),
                ],
                ...over,
            };
        }

        function mergedPrBody(over: Record<string, unknown> = {}) {
            return {
                action: 'closed',
                repository: { full_name: 'octo/site' },
                sender: { login: 'octocat', type: 'User' },
                pull_request: {
                    number: 7,
                    title: 'Add landing page',
                    html_url: 'https://example.com/octo/site/pull/7',
                    head: { sha: SHA_HEAD, ref: 'ever/task-t-42' },
                    base: { ref: 'main' },
                    merged: true,
                    merged_at: '2026-07-25T11:00:00.000Z',
                    merge_commit_sha: SHA_MERGE,
                    merged_by: { login: 'maintainer', type: 'User' },
                },
                ...over,
            };
        }

        it('claims pushes and MERGED pull requests, nothing else', () => {
            expect(isGitActivityDelivery('push', {})).toBe(true);
            expect(isGitActivityDelivery('pull_request', mergedPrBody() as never)).toBe(true);
            // `closed` fires for abandoned PRs too — those merged nothing.
            expect(
                isGitActivityDelivery(
                    'pull_request',
                    mergedPrBody({
                        pull_request: { number: 7, merged: false },
                    }) as never,
                ),
            ).toBe(false);
            expect(isGitActivityDelivery('pull_request', prOpenedBody() as never)).toBe(false);
            expect(isGitActivityDelivery('issue_comment', mentionCommentBody() as never)).toBe(
                false,
            );
        });

        it('a push webhook produces one push row plus one row per new commit', async () => {
            const { service, eventIngestService } = createService();

            const result = await service.handleEvent(BINDING, 'push', pushBody());

            expect(result.ingested).toEqual({ inserted: 1, duplicates: 0, rejected: 0 });
            const [userId, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(envelopes.map((e: any) => e.kind)).toEqual([
                'github.push',
                'github.commit',
                'github.commit',
            ]);
            expect(envelopes[0]).toMatchObject({
                source: 'github',
                sourceEventId: `push:octo/site@${SHA_HEAD}:ever/task-t-42`,
                sourceUrl: 'https://example.com/octo/site/compare/aaa...bbb',
                actor: { name: 'octocat' },
                subject: { type: 'branch', externalId: 'octo/site@ever/task-t-42' },
                workHint: { kind: 'repo', externalId: 'octo/site' },
            });
            expect(envelopes[0].payload).toMatchObject({
                repoFullName: 'octo/site',
                ref: 'refs/heads/ever/task-t-42',
                branch: 'ever/task-t-42',
                before: SHA_BEFORE,
                after: SHA_HEAD,
                commitCount: 2,
            });
            expect(envelopes[1]).toMatchObject({
                kind: 'github.commit',
                sourceEventId: `commit:octo/site@${SHA_FIRST}`,
                subject: { type: 'commit', externalId: SHA_FIRST, title: 'chore: scaffold' },
                sourceUrl: `https://example.com/octo/site/commit/${SHA_FIRST}`,
                workHint: { kind: 'repo', externalId: 'octo/site' },
            });
            // The subject line is the title; the full message + the file
            // count ride in the payload.
            expect(envelopes[2].payload).toMatchObject({
                sha: SHA_HEAD,
                branch: 'ever/task-t-42',
                message: 'feat: add landing page\n\nwith a body',
                filesChanged: 2,
            });
        });

        it('maps the push to the Task that owns the branch', async () => {
            const { service, eventIngestService, taskLinks } = createService();
            taskLinks.findByBranch.mockResolvedValue({
                workId: 'work-1',
                taskId: 'task-1',
                taskSlug: 'T-42',
            });

            await service.handleEvent(BINDING, 'push', pushBody());

            expect(taskLinks.findByBranch).toHaveBeenCalledWith({
                userId: 'user-1',
                owner: 'octo',
                repo: 'site',
                branch: 'ever/task-t-42',
            });
            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            for (const envelope of envelopes) {
                expect(envelope.payload).toMatchObject({ taskId: 'task-1', taskSlug: 'T-42' });
            }
        });

        it('an unmatched repo is ignored without throwing', async () => {
            const { service, eventIngestService, taskLinks } = createService();

            // 1. A repository that maps to no Work / no Task: the rows are
            //    still ingested (user-scoped), just without a Task link.
            await expect(service.handleEvent(BINDING, 'push', pushBody())).resolves.toMatchObject({
                ingested: { inserted: 1 },
            });
            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes[0].payload.taskId).toBeUndefined();

            // 2. A delivery naming no repository at all cannot be attributed
            //    to anything: a clean no-op, never an exception.
            eventIngestService.ingest.mockClear();
            taskLinks.findByBranch.mockClear();
            await expect(
                service.handleEvent(BINDING, 'push', pushBody({ repository: undefined })),
            ).resolves.toEqual({ ingested: null });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
            expect(taskLinks.findByBranch).not.toHaveBeenCalled();
        });

        it('ignores tag refs and branch deletions', async () => {
            const { service, eventIngestService } = createService();

            await expect(
                service.handleEvent(BINDING, 'push', pushBody({ ref: 'refs/tags/v1.2.3' })),
            ).resolves.toEqual({ ingested: null });
            await expect(
                service.handleEvent(BINDING, 'push', pushBody({ deleted: true, commits: [] })),
            ).resolves.toEqual({ ingested: null });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('skips commits already announced on another ref (distinct: false)', async () => {
            const { service, eventIngestService } = createService();

            await service.handleEvent(
                BINDING,
                'push',
                pushBody({
                    commits: [
                        commit(SHA_FIRST, 'chore: scaffold', { distinct: false }),
                        commit(SHA_HEAD, 'feat: add landing page'),
                    ],
                }),
            );

            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes).toHaveLength(2);
            expect(envelopes[0].payload.commitCount).toBe(1);
            expect(envelopes[1].payload.sha).toBe(SHA_HEAD);
        });

        it('caps the commit fan-out so one push cannot flood the feed', async () => {
            const { service, eventIngestService } = createService();
            const many = Array.from({ length: GITHUB_PUSH_COMMITS_MAX + 5 }, (_, i) =>
                commit(String(i).padStart(40, '0'), `chore: step ${i}`),
            );

            await service.handleEvent(BINDING, 'push', pushBody({ commits: many }));

            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes).toHaveLength(GITHUB_PUSH_COMMITS_MAX + 1);
            expect(envelopes[0].payload.commitCount).toBe(GITHUB_PUSH_COMMITS_MAX);
        });

        it('a merged pull request produces one github.merge row mapped to its Task', async () => {
            const { service, eventIngestService, taskLinks } = createService();
            taskLinks.findByPullRequest.mockResolvedValue({
                workId: 'work-1',
                taskId: 'task-1',
                taskSlug: 'T-42',
            });

            const result = await service.handleEvent(BINDING, 'pull_request', mergedPrBody());

            expect(result.ingested).toEqual({ inserted: 1, duplicates: 0, rejected: 0 });
            expect(taskLinks.findByPullRequest).toHaveBeenCalledWith({
                userId: 'user-1',
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
            });
            const [, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(envelopes).toHaveLength(1);
            expect(envelopes[0]).toMatchObject({
                kind: 'github.merge',
                sourceEventId: `merge:octo/site#7@${SHA_MERGE}`,
                occurredAt: '2026-07-25T11:00:00.000Z',
                actor: { name: 'maintainer' },
                subject: { type: 'pull_request', externalId: 'octo/site#7' },
                sourceUrl: 'https://example.com/octo/site/pull/7',
                workHint: { kind: 'repo', externalId: 'octo/site' },
            });
            expect(envelopes[0].payload).toMatchObject({
                repoFullName: 'octo/site',
                prNumber: 7,
                mergeCommitSha: SHA_MERGE,
                baseRef: 'main',
                headRef: 'ever/task-t-42',
                mergedBy: 'maintainer',
                taskId: 'task-1',
            });
        });

        it('never enters the review loop — the code already landed', async () => {
            const { service, prReviewService } = createService();

            await service.handleEvent(BINDING, 'push', pushBody());
            await service.handleEvent(BINDING, 'pull_request', mergedPrBody());
            await flush();

            expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
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

    describe('pull_request_review -> durable rejection (orchestration M9)', () => {
        function reviewBody(over: Record<string, unknown> = {}) {
            return {
                action: 'submitted',
                repository: { full_name: 'octo/site' },
                pull_request: { number: 9, html_url: 'https://github.com/octo/site/pull/9' },
                review: {
                    id: 1,
                    state: 'changes_requested',
                    body: 'the migration has no down()',
                    user: { login: 'octocat', type: 'User' },
                },
                ...over,
            };
        }

        it('records a changes_requested review as rejection feedback', async () => {
            const { service, rejections } = createService();
            await service.handleEvent(BINDING, 'pull_request_review', reviewBody());
            expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: BINDING.userId,
                    owner: 'octo',
                    repo: 'site',
                    prNumber: 9,
                    feedback: 'the migration has no down()',
                    reviewerLabel: 'octocat',
                }),
            );
        });

        it('never routes a review into the review loop - the loop reviews, it does not react', async () => {
            const { service, prReviewService, eventIngestService } = createService();
            const result = await service.handleEvent(BINDING, 'pull_request_review', reviewBody());
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
            await flush();
            expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
        });

        it('ignores an approval - only a rejection carries feedback for the next run', async () => {
            const { service, rejections } = createService();
            await service.handleEvent(
                BINDING,
                'pull_request_review',
                reviewBody({ review: { id: 1, state: 'approved', body: 'ship it' } }),
            );
            expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
        });

        it('ignores a BOT reviewer - the loop must not treat its own output as human feedback', async () => {
            const { service, rejections } = createService();
            await service.handleEvent(
                BINDING,
                'pull_request_review',
                reviewBody({
                    review: {
                        id: 1,
                        state: 'changes_requested',
                        body: 'automated nit',
                        user: { login: 'ever-works[bot]', type: 'Bot' },
                    },
                }),
            );
            expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
        });

        it('ignores a rejection with an empty body - it would prepend nothing useful', async () => {
            const { service, rejections } = createService();
            await service.handleEvent(
                BINDING,
                'pull_request_review',
                reviewBody({
                    review: { id: 1, state: 'changes_requested', body: '   ', user: {} },
                }),
            );
            expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
        });

        it('a recorder failure never rejects the webhook path', async () => {
            const { service, rejections } = createService();
            rejections.recordPullRequestRejection.mockRejectedValue(new Error('db down'));
            await expect(
                service.handleEvent(BINDING, 'pull_request_review', reviewBody()),
            ).resolves.toEqual({ ingested: null });
        });
    });

    /**
     * Trusted review bots (self-build fleet, finding R16).
     *
     * The bridge used to drop EVERY bot-authored review and comment. That
     * kept the loop from echoing itself — and also kept CodeRabbit,
     * Copilot, Codex and Greptile verdicts from ever becoming Task
     * feedback, so a human relayed each finding by hand. Now an
     * allow-listed reviewer bot's `changes_requested` review, inline
     * findings and summary comments are recorded exactly as a human's
     * would be, while the platform's own identity and unknown bots are
     * still dropped at the door. Bodies below are the literal shapes the
     * bots post on this repository (captured with `gh api`).
     */
    describe('trusted review bots (R16)', () => {
        const ORIGINAL_TRUSTED = process.env.GITHUB_TRUSTED_REVIEW_BOTS;
        const ORIGINAL_SLUG = process.env.GITHUB_APP_SLUG;

        beforeEach(() => {
            delete process.env.GITHUB_TRUSTED_REVIEW_BOTS;
            delete process.env.GITHUB_APP_SLUG;
        });

        afterAll(() => {
            if (ORIGINAL_TRUSTED === undefined) delete process.env.GITHUB_TRUSTED_REVIEW_BOTS;
            else process.env.GITHUB_TRUSTED_REVIEW_BOTS = ORIGINAL_TRUSTED;
            if (ORIGINAL_SLUG === undefined) delete process.env.GITHUB_APP_SLUG;
            else process.env.GITHUB_APP_SLUG = ORIGINAL_SLUG;
        });

        /** A CodeRabbit inline finding, as posted on ever-works/ever-works#2344. */
        const CODERABBIT_MAJOR_FINDING = [
            '_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_',
            '',
            '<details>',
            '<summary>🔎 Supported by static analysis</summary>',
            '',
            '🤖 get_repo_knowledge executed:',
            '',
            'Length of output: 33708',
            '',
            '</details>',
            '',
            'The migration drops the column without a guard, so a partially applied database cannot converge.',
        ].join('\n');

        function botReview(login: string, over: Record<string, unknown> = {}) {
            return {
                action: 'submitted',
                repository: { full_name: 'octo/site' },
                pull_request: { number: 9, html_url: 'https://github.com/octo/site/pull/9' },
                review: {
                    id: 1,
                    state: 'changes_requested',
                    body: '**Actionable comments posted: 2**\n\n<details>\n<summary>🧹 Nitpick comments (1)</summary>\n\nx\n\n</details>',
                    user: { login, type: 'Bot' },
                },
                ...over,
            };
        }

        function botReviewComment(login: string, body: string, over: Record<string, unknown> = {}) {
            return {
                action: 'created',
                repository: { full_name: 'octo/site' },
                pull_request: {
                    number: 9,
                    title: 'Add severity',
                    html_url: 'https://github.com/octo/site/pull/9',
                },
                comment: {
                    id: 501,
                    body,
                    html_url: 'https://github.com/octo/site/pull/9#discussion_r501',
                    path: 'apps/api/src/migrations/1788100000000-AddSeverity.ts',
                    line: 144,
                    original_line: 60,
                    pull_request_review_id: 1,
                    user: { login, type: 'Bot' },
                },
                ...over,
            };
        }

        function botIssueComment(login: string, body: string, over: Record<string, unknown> = {}) {
            return {
                action: 'created',
                repository: { full_name: 'octo/site' },
                issue: {
                    number: 9,
                    title: 'Add severity',
                    html_url: 'https://github.com/octo/site/pull/9',
                    pull_request: { url: 'https://example.com/api/pulls/9' },
                },
                comment: {
                    id: 601,
                    body,
                    html_url: 'https://github.com/octo/site/pull/9#issuecomment-601',
                    user: { login, type: 'Bot' },
                },
                ...over,
            };
        }

        describe('pull_request_review', () => {
            it('⭐ records a changes_requested review from an allow-listed bot as rejection feedback', async () => {
                const { service, rejections } = createService();
                const result = await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('coderabbitai[bot]'),
                );
                expect(result).toEqual({ ingested: null });
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: BINDING.userId,
                        owner: 'octo',
                        repo: 'site',
                        prNumber: 9,
                        reviewerLabel: 'coderabbitai[bot]',
                        reviewerKind: 'bot',
                        feedback: '**Actionable comments posted: 2**',
                    }),
                );
            });

            it('still drops a bot that is not on the list', async () => {
                for (const login of ['github-actions[bot]', 'dependabot[bot]']) {
                    const { service, rejections } = createService();
                    await service.handleEvent(BINDING, 'pull_request_review', botReview(login));
                    expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                }
            });

            it('⭐ still drops the platform identity — even when an operator lists it as trusted', async () => {
                // THE security property of this slice: the loop must never
                // read its own output as reviewer feedback, and the
                // allow-list cannot be used to make it.
                process.env.GITHUB_TRUSTED_REVIEW_BOTS = 'ever-works[bot],coderabbitai[bot]';
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('ever-works[bot]'),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                // The same list still works for everyone else on it.
                await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('coderabbitai[bot]'),
                );
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledTimes(1);
            });

            it('derives the self identity from GITHUB_APP_SLUG', async () => {
                process.env.GITHUB_APP_SLUG = 'acme';
                process.env.GITHUB_TRUSTED_REVIEW_BOTS = 'acme[bot]';
                const { service, rejections } = createService();
                await service.handleEvent(BINDING, 'pull_request_review', botReview('acme[bot]'));
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
            });

            it('leaves a human review exactly as before, tagged human with no severity', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('octocat', {
                        review: {
                            id: 1,
                            state: 'changes_requested',
                            body: 'the migration has no down()',
                            user: { login: 'octocat', type: 'User' },
                        },
                    }),
                );
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        feedback: 'the migration has no down()',
                        reviewerLabel: 'octocat',
                        reviewerKind: 'human',
                        severity: null,
                    }),
                );
            });

            it('ignores a trusted bot that merely COMMENTED — its findings arrive as inline comments', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('coderabbitai[bot]', {
                        review: {
                            id: 1,
                            state: 'commented',
                            body: '**Actionable comments posted: 2**',
                            user: { login: 'coderabbitai[bot]', type: 'Bot' },
                        },
                    }),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
            });

            it('GITHUB_TRUSTED_REVIEW_BOTS=none restores the drop-every-bot posture', async () => {
                process.env.GITHUB_TRUSTED_REVIEW_BOTS = 'none';
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review',
                    botReview('coderabbitai[bot]'),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
            });
        });

        describe('platform identity (adversarial)', () => {
            it('⭐ still drops the platform identity on BOTH comment paths — even when listed as trusted', async () => {
                process.env.GITHUB_TRUSTED_REVIEW_BOTS = 'ever-works[bot],coderabbitai[bot]';
                const { service, rejections, eventIngestService, prReviewService } =
                    createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment('ever-works[bot]', CODERABBIT_MAJOR_FINDING),
                );
                await service.handleEvent(
                    BINDING,
                    'issue_comment',
                    botIssueComment('Ever-Works[bot]', '@ever-works please rebase.'),
                );
                await flush();
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
                expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
            });

            it('a slug misconfigured as `ever-works[bot]` or `@ever-works` still names the platform identity', async () => {
                for (const slug of ['ever-works[bot]', '@Ever-Works', ' ever-works ']) {
                    process.env.GITHUB_APP_SLUG = slug;
                    process.env.GITHUB_TRUSTED_REVIEW_BOTS = 'ever-works[bot]';
                    const { service, rejections } = createService();
                    await service.handleEvent(
                        BINDING,
                        'pull_request_review',
                        botReview('ever-works[bot]'),
                    );
                    expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                }
            });

            it('drops look-alikes of the platform identity that nobody listed', async () => {
                for (const login of [
                    'ever-works-bot[bot]',
                    'everworks[bot]',
                    'ever-works-ai[bot]',
                ]) {
                    const { service, rejections, eventIngestService } = createService();
                    await service.handleEvent(BINDING, 'pull_request_review', botReview(login));
                    await service.handleEvent(
                        BINDING,
                        'issue_comment',
                        botIssueComment(login, '@ever-works please rebase.'),
                    );
                    expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                    expect(eventIngestService.ingest).not.toHaveBeenCalled();
                }
            });

            it('still drops an @ever-works mention from an unlisted bot — neither feedback nor a review', async () => {
                const { service, rejections, eventIngestService, prReviewService } =
                    createService();
                await service.handleEvent(
                    BINDING,
                    'issue_comment',
                    botIssueComment('dependabot[bot]', '@ever-works is this migration safe?'),
                );
                await flush();
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
                expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
            });

            it('records an allow-listed bot finding that carries no severity marker — unstated, never dropped', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment(
                        'coderabbitai[bot]',
                        'The migration drops the column without a guard.',
                    ),
                );
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({ reviewerKind: 'bot', severity: null }),
                );
            });
        });

        describe('pull_request_review_comment (inline findings)', () => {
            it('⭐ records a CodeRabbit Major finding with severity, location, and no static-analysis dump', async () => {
                const { service, rejections, eventIngestService } = createService();
                const result = await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment('coderabbitai[bot]', CODERABBIT_MAJOR_FINDING),
                );
                expect(result).toEqual({ ingested: null });
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledTimes(1);
                const [input] = rejections.recordPullRequestRejection.mock.calls[0];
                expect(input).toMatchObject({
                    userId: BINDING.userId,
                    owner: 'octo',
                    repo: 'site',
                    prNumber: 9,
                    reviewerLabel: 'coderabbitai[bot]',
                    reviewerKind: 'bot',
                    severity: 'major',
                    prUrl: 'https://github.com/octo/site/pull/9#discussion_r501',
                });
                expect(input.feedback).toMatch(
                    /^apps\/api\/src\/migrations\/1788100000000-AddSeverity\.ts:144 — /,
                );
                expect(input.feedback).toContain('cannot converge');
                expect(input.feedback).not.toContain('Length of output');
                expect(input.feedback).not.toContain('<details>');
            });

            it('maps Codex P1 → critical and Greptile P2 → major', async () => {
                const codex = createService();
                await codex.service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment(
                        'chatgpt-codex-connector[bot]',
                        '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Cast metadata before using JSON operator**\n\nThe JSON operator is applied to a text column.',
                    ),
                );
                expect(codex.rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        severity: 'critical',
                        reviewerLabel: 'chatgpt-codex-connector[bot]',
                        feedback: expect.stringContaining(
                            'Cast metadata before using JSON operator',
                        ),
                    }),
                );

                const greptile = createService();
                await greptile.service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment(
                        'greptile-apps[bot]',
                        '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg?v=9" align="top"></a> The `import type` statement appears after the export block.',
                    ),
                );
                expect(greptile.rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        severity: 'major',
                        reviewerLabel: 'greptile-apps[bot]',
                        feedback: expect.stringContaining('The `import type` statement'),
                    }),
                );
            });

            it('records a Copilot inline comment (login `Copilot`, no marker) with severity null', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment(
                        'Copilot',
                        'The retry loop never backs off, so a flaky provider is hammered.',
                    ),
                );
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        reviewerLabel: 'Copilot',
                        reviewerKind: 'bot',
                        severity: null,
                    }),
                );
            });

            it('never reviews its reviewers — a bot comment stays out of the mention loop even when it says @ever-works', async () => {
                const { service, rejections, prReviewService, eventIngestService } =
                    createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment('coderabbitai[bot]', '@ever-works please rebase.'),
                );
                await flush();
                expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledTimes(1);
            });

            it('drops an edited bot comment — only `created` carries a new finding', async () => {
                const { service, rejections, eventIngestService } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment('coderabbitai[bot]', CODERABBIT_MAJOR_FINDING, {
                        action: 'edited',
                    }),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
            });

            it('still drops an inline comment from an unlisted bot', async () => {
                const { service, rejections, eventIngestService } = createService();
                await service.handleEvent(
                    BINDING,
                    'pull_request_review_comment',
                    botReviewComment('github-actions[bot]', CODERABBIT_MAJOR_FINDING),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                expect(eventIngestService.ingest).not.toHaveBeenCalled();
            });

            it('a recorder failure on the bot path still answers the webhook', async () => {
                const { service, rejections } = createService();
                rejections.recordPullRequestRejection.mockRejectedValue(new Error('db down'));
                await expect(
                    service.handleEvent(
                        BINDING,
                        'pull_request_review_comment',
                        botReviewComment('coderabbitai[bot]', CODERABBIT_MAJOR_FINDING),
                    ),
                ).resolves.toEqual({ ingested: null });
            });
        });

        describe('issue_comment (summaries)', () => {
            it('records the CodeRabbit summary comment on a pull request', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'issue_comment',
                    botIssueComment(
                        'coderabbitai[bot]',
                        '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\n## Summary by CodeRabbit\n\n- Adds severity to rejections.\n\n<!-- end of auto-generated comment: summarize by coderabbit.ai -->',
                    ),
                );
                expect(rejections.recordPullRequestRejection).toHaveBeenCalledWith(
                    expect.objectContaining({
                        prNumber: 9,
                        reviewerLabel: 'coderabbitai[bot]',
                        reviewerKind: 'bot',
                        severity: null,
                        feedback: '## Summary by CodeRabbit\n\n- Adds severity to rejections.',
                        prUrl: 'https://github.com/octo/site/pull/9#issuecomment-601',
                    }),
                );
            });

            it('drops rate-limit and status chatter — there is nothing in it to fix', async () => {
                for (const body of [
                    '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n>\n> **Next included review available in 34 minutes.**',
                    '<!-- greptile-status -->\nToo many files changed for review.',
                    'You have reached your Codex usage limits for code reviews.',
                ]) {
                    const { service, rejections } = createService();
                    await service.handleEvent(
                        BINDING,
                        'issue_comment',
                        botIssueComment('coderabbitai[bot]', body),
                    );
                    expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
                }
            });

            it('drops a bot comment on a plain issue — only PR threads carry review feedback', async () => {
                const { service, rejections } = createService();
                const body = botIssueComment(
                    'coderabbitai[bot]',
                    '## Summary by CodeRabbit\n\n- x',
                );
                (body.issue as any).pull_request = undefined;
                await service.handleEvent(BINDING, 'issue_comment', body);
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
            });

            it('drops a comment that is nothing but markup once stripped', async () => {
                const { service, rejections } = createService();
                await service.handleEvent(
                    BINDING,
                    'issue_comment',
                    botIssueComment(
                        'coderabbitai[bot]',
                        '<!-- walkthrough_start -->\n<details>\n<summary>x</summary>\ny\n</details>\n<!-- walkthrough_end -->',
                    ),
                );
                expect(rejections.recordPullRequestRejection).not.toHaveBeenCalled();
            });
        });
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
