jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));

import {
    JIRA_ISSUE_EVENT_KIND,
    JiraIssueBridgeService,
    extractJiraSiteRef,
    jiraSiteHost,
    jiraTextOf,
} from './jira-issue-bridge.service';

const SITE = 'https://acme.atlassian.net';

function issueBody(
    overrides: Record<string, unknown> = {},
    fieldOverrides: Record<string, unknown> = {},
) {
    return {
        timestamp: 1756728000000,
        webhookEvent: 'jira:issue_created',
        issue_event_type_name: 'issue_created',
        user: {
            self: `${SITE}/rest/api/2/user?accountId=abc`,
            accountId: 'abc',
            displayName: 'Ada',
        },
        issue: {
            id: '10001',
            key: 'ENG-42',
            self: `${SITE}/rest/api/2/issue/10001`,
            fields: {
                summary: 'Login button does nothing on Safari',
                description: 'Steps: open /login on Safari 17.',
                created: '2026-09-01T10:00:00.000+0000',
                updated: '2026-09-01T10:00:00.000+0000',
                status: { name: 'To Do' },
                issuetype: { name: 'Bug' },
                priority: { name: 'High' },
                project: { id: '10000', key: 'ENG', name: 'Engineering' },
                assignee: { displayName: 'Ada' },
                reporter: { displayName: 'Grace' },
                labels: ['frontend'],
                ...fieldOverrides,
            },
        },
        ...overrides,
    };
}

function adf(text: string) {
    return {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    };
}

describe('jiraSiteHost / extractJiraSiteRef', () => {
    it('reads the https site host off the API self-links and keys it as site:<host>', () => {
        expect(extractJiraSiteRef(issueBody())).toEqual({
            keys: ['site:acme.atlassian.net'],
            host: 'acme.atlassian.net',
            label: 'acme.atlassian.net',
        });
        expect(extractJiraSiteRef({ user: { self: `${SITE}/rest/api/2/user` } })?.host).toBe(
            'acme.atlassian.net',
        );
    });

    it('refuses non-https, credentialed, loopback and private hosts', () => {
        expect(jiraSiteHost('http://acme.atlassian.net/x')).toBeUndefined();
        expect(jiraSiteHost('https://user:pass@acme.atlassian.net')).toBeUndefined();
        expect(jiraSiteHost('https://localhost/rest')).toBeUndefined();
        expect(jiraSiteHost('https://10.0.0.5/rest')).toBeUndefined();
        expect(jiraSiteHost('https://169.254.169.254/latest')).toBeUndefined();
        expect(jiraSiteHost('https://jira.internal/rest')).toBeUndefined();
        expect(jiraSiteHost('not a url')).toBeUndefined();
        expect(extractJiraSiteRef({})).toBeUndefined();
        expect(extractJiraSiteRef(undefined)).toBeUndefined();
    });

    it('lower-cases the host so two spellings of one site bind once', () => {
        expect(jiraSiteHost('https://ACME.Atlassian.NET/rest')).toBe('acme.atlassian.net');
    });
});

describe('jiraTextOf', () => {
    it('flattens ADF and passes strings through', () => {
        expect(jiraTextOf(adf('hello world'))).toBe('hello world');
        expect(jiraTextOf('plain')).toBe('plain');
        expect(jiraTextOf(undefined)).toBe('');
        expect(jiraTextOf(null)).toBe('');
    });
});

describe('JiraIssueBridgeService', () => {
    function createService(
        installs: Array<{
            userId: string;
            enabled?: boolean;
            createdAt?: Date;
            settings?: Record<string, unknown>;
        }> = [],
    ) {
        const userPluginRepository = {
            findByPlugin: jest.fn().mockResolvedValue(
                installs.map((i, index) => ({
                    userId: i.userId,
                    enabled: i.enabled ?? true,
                    createdAt: i.createdAt ?? new Date(1_700_000_000_000 + index * 1000),
                })),
            ),
        };
        const pluginSettingsService = {
            getSettings: jest.fn(async (_pluginId: string, opts: { userId: string }) => {
                return installs.find((i) => i.userId === opts.userId)?.settings ?? {};
            }),
        };
        const eventIngestService = {
            ingest: jest
                .fn()
                .mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0, filtered: 0 }),
        };
        const bindings = new Map<string, { userId: string }>();
        const installBindings = {
            findByWorkspace: jest.fn(
                async (_provider: string, key: string) => bindings.get(key) ?? null,
            ),
            record: jest.fn(async (data: { externalWorkspaceId: string; userId: string }) => {
                bindings.set(data.externalWorkspaceId, { userId: data.userId });
                return data;
            }),
        };
        const service = new JiraIssueBridgeService(
            userPluginRepository as never,
            pluginSettingsService as never,
            eventIngestService as never,
            installBindings as never,
        );
        return {
            service,
            userPluginRepository,
            pluginSettingsService,
            eventIngestService,
            installBindings,
            bindings,
        };
    }

    const ACME = { userId: 'user-acme', settings: { baseUrl: SITE, webhookSecret: 'acme-secret' } };
    const GLOBEX = {
        userId: 'user-globex',
        settings: { baseUrl: 'https://globex.atlassian.net', webhookSecret: 'globex-secret' },
    };

    describe('resolveBinding', () => {
        it('fails closed (not-configured) when no install carries a webhook secret', async () => {
            const { service } = createService([
                { userId: 'user-nosecret', settings: { baseUrl: SITE } },
                {
                    userId: 'user-disabled',
                    enabled: false,
                    settings: { baseUrl: SITE, webhookSecret: 's' },
                },
            ]);
            await expect(
                service.resolveBinding({ workspace: extractJiraSiteRef(issueBody()) }),
            ).resolves.toEqual({ status: 'not-configured' });
        });

        it('prefers an exact site binding over everything else', async () => {
            const { service, bindings } = createService([ACME, GLOBEX]);
            bindings.set('site:acme.atlassian.net', { userId: 'user-globex' });

            const resolution = await service.resolveBinding({
                workspace: extractJiraSiteRef(issueBody()),
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'user-globex', matchedBy: 'binding' },
            });
        });

        it('refuses (never re-attributes) when the bound install is gone or lost its secret', async () => {
            const { service, bindings } = createService([ACME]);
            bindings.set('site:acme.atlassian.net', { userId: 'user-departed' });

            await expect(
                service.resolveBinding({ workspace: extractJiraSiteRef(issueBody()) }),
            ).resolves.toEqual({ status: 'unresolved', reason: 'bound-install-unavailable' });
        });

        it('selects the install whose configured baseUrl names the delivery site (site-match)', async () => {
            const { service } = createService([ACME, GLOBEX]);

            const resolution = await service.resolveBinding({
                workspace: extractJiraSiteRef(issueBody()),
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: {
                    userId: 'user-acme',
                    webhookSecret: 'acme-secret',
                    matchedBy: 'site-match',
                },
            });
        });

        it('a forged self-link only SELECTS a secret — it cannot steer a delivery to another user without that user’s signature', async () => {
            const { service } = createService([ACME, GLOBEX]);
            // Attacker (or misconfigured site) names Globex's host, but the
            // delivery is signed with Acme's secret.
            const forged = issueBody({
                issue: { id: '1', self: 'https://globex.atlassian.net/rest/api/2/issue/1' },
            });
            const resolution = await service.resolveBinding({
                workspace: extractJiraSiteRef(forged),
                verifySignature: (secret) => secret === 'acme-secret',
            });
            // Site-match picks Globex; the receiver then verifies with
            // Globex's secret and 401s. Nothing is ever attributed to Acme.
            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'user-globex', matchedBy: 'site-match' },
            });
        });

        it('falls back to the single configured install when no site matches (legacy path)', async () => {
            const { service } = createService([GLOBEX]);

            const resolution = await service.resolveBinding({
                workspace: extractJiraSiteRef(issueBody()),
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'user-globex', matchedBy: 'single-install' },
            });
        });

        it('uses a UNIQUE signature match when several installs share one site', async () => {
            const { service } = createService([
                ACME,
                {
                    userId: 'user-acme-2',
                    settings: { baseUrl: SITE, webhookSecret: 'acme-2-secret' },
                },
            ]);

            const resolution = await service.resolveBinding({
                workspace: extractJiraSiteRef(issueBody()),
                verifySignature: (secret) => secret === 'acme-2-secret',
            });

            expect(resolution).toMatchObject({
                status: 'resolved',
                binding: { userId: 'user-acme-2', matchedBy: 'signature' },
            });
        });

        it('refuses when several installs share a secret (ambiguous) or none matches (unknown)', async () => {
            const shared = createService([
                { userId: 'a', settings: { baseUrl: SITE, webhookSecret: 'same' } },
                { userId: 'b', settings: { baseUrl: SITE, webhookSecret: 'same' } },
            ]);
            await expect(
                shared.service.resolveBinding({
                    workspace: extractJiraSiteRef(issueBody()),
                    verifySignature: () => true,
                }),
            ).resolves.toEqual({ status: 'unresolved', reason: 'ambiguous-install' });

            const none = createService([ACME, GLOBEX]);
            await expect(
                none.service.resolveBinding({
                    workspace: extractJiraSiteRef(
                        issueBody({
                            issue: {
                                id: '1',
                                self: 'https://initech.atlassian.net/rest/api/2/issue/1',
                            },
                        }),
                    ),
                    verifySignature: () => false,
                }),
            ).resolves.toEqual({ status: 'unresolved', reason: 'unknown-workspace' });
        });
    });

    describe('recordBinding', () => {
        it('records a verified site-match / single-install binding and skips an existing one', async () => {
            const { service, installBindings } = createService([ACME]);
            const workspace = extractJiraSiteRef(issueBody());

            await service.recordBinding({
                userId: 'user-acme',
                webhookSecret: 's',
                matchedBy: 'site-match',
                workspace,
            });
            expect(installBindings.record).toHaveBeenCalledWith({
                provider: 'jira',
                externalWorkspaceId: 'site:acme.atlassian.net',
                userId: 'user-acme',
                pluginId: 'jira-connector',
                externalWorkspaceName: 'acme.atlassian.net',
            });

            installBindings.record.mockClear();
            await service.recordBinding({
                userId: 'user-acme',
                webhookSecret: 's',
                matchedBy: 'binding',
                workspace,
            });
            expect(installBindings.record).not.toHaveBeenCalled();
        });

        it('never throws when the write fails — the delivery already verified and handled', async () => {
            const { service, installBindings } = createService([ACME]);
            installBindings.record.mockRejectedValue(new Error('db down'));
            await expect(
                service.recordBinding({
                    userId: 'user-acme',
                    webhookSecret: 's',
                    matchedBy: 'site-match',
                    workspace: extractJiraSiteRef(issueBody()),
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe('normalize', () => {
        const { service } = createService([ACME]);

        it('turns jira:issue_created into a jira.issue envelope shaped like the pull path', () => {
            const envelope = service.normalize(issueBody());
            expect(envelope).toMatchObject({
                source: 'jira-connector',
                kind: JIRA_ISSUE_EVENT_KIND,
                sourceEventId: '10001:2026-09-01T10:00:00.000Z',
                occurredAt: '2026-09-01T10:00:00.000Z',
                actor: { name: 'Ada' },
                subject: {
                    type: 'issue',
                    externalId: '10001',
                    title: 'Login button does nothing on Safari',
                },
                workHint: { kind: 'tracker-team', externalId: 'ENG', label: 'Engineering' },
                sourceUrl: `${SITE}/browse/ENG-42`,
                payload: {
                    issueId: '10001',
                    issueKey: 'ENG-42',
                    projectKey: 'ENG',
                    summary: 'Login button does nothing on Safari',
                    description: 'Steps: open /login on Safari 17.',
                    status: 'To Do',
                    issueType: 'Bug',
                    priority: 'High',
                    assignee: 'Ada',
                    reporter: 'Grace',
                    labels: ['frontend'],
                    changeType: 'created',
                    eventType: 'issue_created',
                    url: `${SITE}/browse/ENG-42`,
                    createdAt: '2026-09-01T10:00:00.000Z',
                    updatedAt: '2026-09-01T10:00:00.000Z',
                },
            });
        });

        it('detects a transition from the changelog status item', () => {
            const envelope = service.normalize(
                issueBody(
                    {
                        webhookEvent: 'jira:issue_updated',
                        issue_event_type_name: 'issue_generic',
                        changelog: {
                            items: [
                                { field: 'status', fromString: 'To Do', toString: 'In Progress' },
                            ],
                        },
                    },
                    { status: { name: 'In Progress' }, updated: '2026-09-01T11:00:00.000+0000' },
                ),
            );
            expect(envelope).toMatchObject({
                sourceEventId: '10001:2026-09-01T11:00:00.000Z',
                payload: {
                    changeType: 'transitioned',
                    status: 'In Progress',
                    statusFrom: 'To Do',
                    statusTo: 'In Progress',
                },
            });
        });

        it('marks a plain update (no status change) as updated', () => {
            const envelope = service.normalize(
                issueBody(
                    {
                        webhookEvent: 'jira:issue_updated',
                        changelog: { items: [{ field: 'summary' }] },
                    },
                    { updated: '2026-09-01T11:00:00.000+0000' },
                ),
            );
            expect(envelope?.payload.changeType).toBe('updated');
        });

        it('keys a deletion on the delivery time so it cannot collide with the last update', () => {
            const envelope = service.normalize(
                // 1788260400000 ms = 2026-09-01T11:00:00.000Z
                issueBody({ webhookEvent: 'jira:issue_deleted', timestamp: 1788260400000 }),
            );
            expect(envelope?.sourceEventId).toBe('10001:deleted:2026-09-01T11:00:00.000Z');
            expect(envelope?.payload.changeType).toBe('deleted');
        });

        it('keeps the same subject across create / transition / delete (one issue, many revisions)', () => {
            const created = service.normalize(issueBody());
            const moved = service.normalize(
                issueBody(
                    {
                        webhookEvent: 'jira:issue_updated',
                        changelog: { items: [{ field: 'status' }] },
                    },
                    { updated: '2026-09-02T09:00:00.000+0000' },
                ),
            );
            expect(moved?.subject?.externalId).toBe(created?.subject?.externalId);
            expect(moved?.sourceEventId).not.toBe(created?.sourceEventId);
        });

        it('flattens an ADF description and caps long text', () => {
            const rich = service.normalize(issueBody({}, { description: adf('rich text') }));
            expect(rich?.payload.description).toBe('rich text');

            const long = service.normalize(
                issueBody({}, { description: 'd'.repeat(20_000), summary: 's'.repeat(900) }),
            );
            expect((long?.payload.description as string).length).toBe(4000);
            expect(long?.subject?.title).toHaveLength(500);
        });

        /**
         * The envelope is written straight into `ingested_events`, whose
         * columns are narrow (actorName 200, subjectExternalId 200,
         * sourceUrl 2048). A value that overflows one of them fails the
         * INSERT, and on this receiver a failed insert is a 500 that Jira
         * redelivers forever — so the width has to be enforced HERE, not
         * assumed from Jira's own limits (display names run to 255).
         */
        it('⭐ keeps an over-long display name, issue id and issue key inside the column widths', () => {
            const envelope = service.normalize(
                issueBody({
                    user: {
                        self: `${SITE}/rest/api/2/user?accountId=abc`,
                        displayName: 'D'.repeat(255),
                    },
                    issue: {
                        id: '9'.repeat(400),
                        key: `ENG-${'4'.repeat(4000)}`,
                        self: `${SITE}/rest/api/2/issue/1`,
                        fields: { summary: 'wide', updated: '2026-09-01T10:00:00.000+0000' },
                    },
                }),
            );

            expect(envelope?.actor?.name).toHaveLength(200);
            expect(envelope?.subject?.externalId).toHaveLength(200);
            expect((envelope?.sourceUrl ?? '').length).toBeLessThanOrEqual(2048);
            expect(envelope?.sourceEventId.length).toBeLessThanOrEqual(200);
        });

        it('ignores non-issue webhook events and issues without an id', () => {
            expect(service.normalize(issueBody({ webhookEvent: 'comment_created' }))).toBeNull();
            expect(
                service.normalize(issueBody({ webhookEvent: 'jira:worklog_updated' })),
            ).toBeNull();
            expect(service.normalize(issueBody({ issue: { key: 'ENG-1' } }))).toBeNull();
            expect(service.normalize({})).toBeNull();
        });

        it('leaves the deep link off when the self-link host is not a public https host', () => {
            const envelope = service.normalize(
                issueBody({
                    user: { self: 'http://localhost/rest/api/2/user' },
                    issue: {
                        id: '7',
                        key: 'ENG-7',
                        self: 'https://10.0.0.9/rest/api/2/issue/7',
                        fields: {},
                    },
                }),
            );
            expect(envelope?.sourceUrl).toBeUndefined();
            expect(envelope?.payload.url).toBeUndefined();
        });

        it('never hands the spine an unparsable occurredAt', () => {
            const envelope = service.normalize(
                issueBody({}, { updated: 'garbage', created: 'garbage' }),
            );
            expect(Number.isNaN(Date.parse(envelope?.occurredAt ?? ''))).toBe(false);
        });
    });

    describe('handleEvent', () => {
        it('ingests under the binding owner, never a user named in the payload', async () => {
            const { service, eventIngestService } = createService([ACME]);
            const result = await service.handleEvent(
                { userId: 'user-acme', webhookSecret: 's', matchedBy: 'site-match' },
                issueBody({
                    user: {
                        self: `${SITE}/rest/api/2/user`,
                        accountId: 'user-globex',
                        displayName: 'X',
                    },
                }),
            );
            expect(result.ingested).toMatchObject({ inserted: 1 });
            const [userId, envelopes] = eventIngestService.ingest.mock.calls[0];
            expect(userId).toBe('user-acme');
            expect(envelopes[0]).toMatchObject({ kind: JIRA_ISSUE_EVENT_KIND });
        });

        it('files nothing for a delivery the normalizer skips', async () => {
            const { service, eventIngestService } = createService([ACME]);
            await expect(
                service.handleEvent(
                    { userId: 'user-acme', webhookSecret: 's', matchedBy: 'site-match' },
                    issueBody({ webhookEvent: 'comment_created' }),
                ),
            ).resolves.toEqual({ ingested: null });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });
    });
});
