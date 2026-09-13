import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { JiraEventsController } from './jira-events.controller';
import { JiraIssueBridgeService } from './jira-issue-bridge.service';
import { computeJiraSignature } from './jira-signature.util';

const ACME_SECRET = 'acme-webhook-secret';
const GLOBEX_SECRET = 'globex-webhook-secret';

function issueBody(overrides: Record<string, unknown> = {}) {
    return {
        timestamp: 1756728000000,
        webhookEvent: 'jira:issue_created',
        issue_event_type_name: 'issue_created',
        user: {
            self: 'https://acme.atlassian.net/rest/api/2/user?accountId=abc',
            displayName: 'Ada',
        },
        issue: {
            id: '10001',
            key: 'ENG-42',
            self: 'https://acme.atlassian.net/rest/api/2/issue/10001',
            fields: {
                summary: 'Login button does nothing on Safari',
                created: '2026-09-01T10:00:00.000+0000',
                updated: '2026-09-01T10:00:00.000+0000',
                status: { name: 'To Do' },
                project: { key: 'ENG', name: 'Engineering' },
            },
        },
        ...overrides,
    };
}

/**
 * The controller is a thin shell over `JiraIssueBridgeService`, so the
 * bridge is built for REAL here (with fake repositories) rather than
 * mocked — a shell that no longer reaches the resolver / signature check
 * would otherwise pass a mocked spec.
 */
describe('JiraEventsController (POST /api/ingest/jira/events)', () => {
    function createController(
        installs: Array<{ userId: string; baseUrl: string; webhookSecret?: string }> = [
            {
                userId: 'user-acme',
                baseUrl: 'https://acme.atlassian.net',
                webhookSecret: ACME_SECRET,
            },
        ],
    ) {
        const userPluginRepository = {
            findByPlugin: jest.fn().mockResolvedValue(
                installs.map((i, index) => ({
                    userId: i.userId,
                    enabled: true,
                    createdAt: new Date(1_700_000_000_000 + index * 1000),
                })),
            ),
        };
        const pluginSettingsService = {
            getSettings: jest.fn(async (_id: string, opts: { userId: string }) => {
                const install = installs.find((i) => i.userId === opts.userId);
                return install
                    ? { baseUrl: install.baseUrl, webhookSecret: install.webhookSecret }
                    : {};
            }),
        };
        // A tiny in-memory spine: dedupe on (userId, source, sourceEventId).
        const seen = new Set<string>();
        const eventIngestService = {
            ingest: jest.fn(
                async (
                    userId: string,
                    envelopes: Array<{
                        source: string;
                        sourceEventId: string;
                        payload: Record<string, unknown>;
                    }>,
                ) => {
                    let inserted = 0;
                    let duplicates = 0;
                    for (const envelope of envelopes) {
                        const key = `${userId}|${envelope.source}|${envelope.sourceEventId}`;
                        if (seen.has(key)) duplicates += 1;
                        else {
                            seen.add(key);
                            inserted += 1;
                        }
                    }
                    return { inserted, duplicates, rejected: 0, filtered: 0 };
                },
            ),
        };
        const bindings = new Map<string, { userId: string }>();
        const installBindings = {
            findByWorkspace: jest.fn(async (_p: string, key: string) => bindings.get(key) ?? null),
            record: jest.fn(async (data: { externalWorkspaceId: string; userId: string }) => {
                bindings.set(data.externalWorkspaceId, { userId: data.userId });
                return data;
            }),
        };
        const bridge = new JiraIssueBridgeService(
            userPluginRepository as never,
            pluginSettingsService as never,
            eventIngestService as never,
            installBindings as never,
        );
        const controller = new JiraEventsController(bridge);
        return { controller, bridge, eventIngestService, installBindings, bindings };
    }

    function signedRequest(bodyObj: unknown, secret = ACME_SECRET) {
        const rawBody = JSON.stringify(bodyObj);
        return {
            req: { body: bodyObj, rawBody },
            signature: computeJiraSignature(secret, rawBody),
        };
    }

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, eventIngestService } = createController();
        await expect(
            controller.receiveEvents({ body: {}, rawBody: undefined } as never, 'sha256=x'),
        ).rejects.toThrow(BadRequestException);
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when no install carries a webhook secret', async () => {
        const { controller, eventIngestService } = createController([
            { userId: 'user-acme', baseUrl: 'https://acme.atlassian.net' },
        ]);
        const { req, signature } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, signature)).rejects.toThrow(
            UnauthorizedException,
        );
        // The 401 body is INDISTINGUISHABLE from the bad-signature one.
        // This used to assert 'not configured', which told an
        // unauthenticated prober that no account on this deployment has
        // an enabled jira-connector install with a webhook secret — a
        // per-deployment tenant oracle held by anyone who can POST.
        await expect(controller.receiveEvents(req as never, signature)).rejects.toThrow(
            'Invalid Jira webhook signature',
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('rejects an UNSIGNED delivery (webhook created without a secret) with 401 and files nothing', async () => {
        const { controller, eventIngestService, installBindings } = createController();
        const { req } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, undefined)).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
        expect(installBindings.record).not.toHaveBeenCalled();
    });

    it('rejects a bad signature with 401 and never records a binding or ingests', async () => {
        const { controller, eventIngestService, installBindings } = createController();
        const { req } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, 'sha256=deadbeef')).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
        expect(installBindings.record).not.toHaveBeenCalled();
    });

    it('rejects a delivery signed with a different secret (tampered / wrong site)', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody(), 'someone-elses-secret');
        await expect(controller.receiveEvents(req as never, signature)).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('ingests a validly signed issue delivery under the site owner and records the binding', async () => {
        const { controller, eventIngestService, installBindings } = createController();
        const { req, signature } = signedRequest(issueBody());

        await expect(controller.receiveEvents(req as never, signature)).resolves.toEqual({
            ok: true,
        });

        expect(eventIngestService.ingest).toHaveBeenCalledTimes(1);
        const [userId, envelopes] = eventIngestService.ingest.mock.calls[0];
        expect(userId).toBe('user-acme');
        expect(envelopes[0]).toMatchObject({
            source: 'jira-connector',
            kind: 'jira.issue',
            subject: { type: 'issue', externalId: '10001' },
            workHint: { kind: 'tracker-team', externalId: 'ENG' },
        });
        expect(installBindings.record).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'jira',
                externalWorkspaceId: 'site:acme.atlassian.net',
                userId: 'user-acme',
            }),
        );
    });

    it('treats a replayed (identical) delivery as a duplicate — no second insert', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());

        await controller.receiveEvents(req as never, signature);
        await controller.receiveEvents(req as never, signature);

        const results = await Promise.all(
            eventIngestService.ingest.mock.results.map((r) => r.value),
        );
        expect(results[0]).toMatchObject({ inserted: 1, duplicates: 0 });
        expect(results[1]).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it('caps an oversized description so the envelope stays inside the spine payload budget', async () => {
        const { controller, eventIngestService } = createController();
        const body = issueBody();
        (body.issue.fields as Record<string, unknown>).description = 'x'.repeat(200_000);
        const { req, signature } = signedRequest(body);

        await controller.receiveEvents(req as never, signature);

        const [, envelopes] = eventIngestService.ingest.mock.calls[0];
        const bytes = Buffer.byteLength(JSON.stringify(envelopes[0].payload), 'utf8');
        expect(bytes).toBeLessThan(32 * 1024);
        expect((envelopes[0].payload.description as string).length).toBe(4000);
    });

    it('refuses an unknown site as a 200 no-op — never a 500, never a guess', async () => {
        const { controller, eventIngestService, installBindings } = createController([
            {
                userId: 'user-acme',
                baseUrl: 'https://acme.atlassian.net',
                webhookSecret: ACME_SECRET,
            },
            {
                userId: 'user-globex',
                baseUrl: 'https://globex.atlassian.net',
                webhookSecret: GLOBEX_SECRET,
            },
        ]);
        const { req, signature } = signedRequest(
            issueBody({
                user: { self: 'https://initech.atlassian.net/rest/api/2/user' },
                issue: {
                    id: '1',
                    key: 'X-1',
                    self: 'https://initech.atlassian.net/rest/api/2/issue/1',
                    fields: {},
                },
            }),
            'a-third-secret',
        );

        await expect(controller.receiveEvents(req as never, signature)).resolves.toEqual({
            ok: true,
            ignored: 'unknown-workspace',
        });
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
        expect(installBindings.record).not.toHaveBeenCalled();
    });

    /**
     * The binding decides the target account; the payload cannot. A
     * delivery that names Globex's site but is signed with Acme's secret
     * selects Globex's install (site-match) and then FAILS Globex's HMAC —
     * it is never attributed to Acme, and never to Globex either.
     */
    it('a forged self-link cannot choose the target user — the delivery must carry that user’s signature', async () => {
        const { controller, eventIngestService, installBindings } = createController([
            {
                userId: 'user-acme',
                baseUrl: 'https://acme.atlassian.net',
                webhookSecret: ACME_SECRET,
            },
            {
                userId: 'user-globex',
                baseUrl: 'https://globex.atlassian.net',
                webhookSecret: GLOBEX_SECRET,
            },
        ]);
        const forged = issueBody({
            user: { self: 'https://globex.atlassian.net/rest/api/2/user' },
            issue: {
                id: '999',
                key: 'GLX-1',
                self: 'https://globex.atlassian.net/rest/api/2/issue/999',
                fields: { summary: 'planted', project: { key: 'GLX' } },
            },
        });
        const { req, signature } = signedRequest(forged, ACME_SECRET);

        await expect(controller.receiveEvents(req as never, signature)).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
        expect(installBindings.record).not.toHaveBeenCalled();

        // …while the same body signed with Globex's own secret lands for Globex.
        const genuine = signedRequest(forged, GLOBEX_SECRET);
        await controller.receiveEvents(genuine.req as never, genuine.signature);
        expect(eventIngestService.ingest.mock.calls[0][0]).toBe('user-globex');
    });

    it('acknowledges a signed non-issue event (comment, worklog) without ingesting', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody({ webhookEvent: 'comment_created' }));
        await expect(controller.receiveEvents(req as never, signature)).resolves.toEqual({
            ok: true,
        });
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('surfaces an ingest failure so Jira redelivers (the spine dedupes the retry)', async () => {
        const { controller, eventIngestService } = createController();
        eventIngestService.ingest.mockRejectedValueOnce(new Error('db down'));
        const { req, signature } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, signature)).rejects.toThrow('db down');
    });
});
