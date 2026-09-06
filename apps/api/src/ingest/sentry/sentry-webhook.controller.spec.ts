import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { SentryIncidentSource } from './sentry-incident.source';
import { SentryInstallBindingService } from './sentry-install-binding.service';
import { computeSentrySignature } from './sentry-signature.util';
import { SentryWebhookController } from './sentry-webhook.controller';

const CLIENT_SECRET = 'sentry-integration-client-secret';
const CLAIMED_UUID = '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f';
const UNCLAIMED_UUID = '00000000-0000-4000-8000-000000000000';
/** A marker that must never show up in any log line. */
const BODY_MARKER = 'stack-frame-with-user-email@example.com';

function issueBody(action = 'created', overrides: Record<string, unknown> = {}) {
    return {
        action,
        installation: { uuid: CLAIMED_UUID },
        actor: { type: 'user', id: 1, name: 'Ada' },
        data: {
            issue: {
                id: '4501',
                shortId: 'EVER-WORKS-1X',
                title: 'TypeError: Cannot read properties of undefined',
                culprit: `apps/api/src/tasks/tasks.service.ts in create ${BODY_MARKER}`,
                level: 'error',
                status: 'unresolved',
                permalink: 'https://sentry.io/organizations/ever-co/issues/4501/',
                firstSeen: '2026-08-30T09:00:00.000Z',
                lastSeen: '2026-09-01T12:00:00.000Z',
                project: { id: 77, slug: 'ever-works-api', name: 'Ever Works API' },
            },
        },
        ...overrides,
    };
}

function installationBody(action: 'created' | 'deleted', uuid = CLAIMED_UUID) {
    return {
        action,
        installation: { uuid },
        actor: { type: 'user', id: 1, name: 'Ada' },
        data: { installation: { uuid, status: action === 'deleted' ? 'deleted' : 'installed' } },
    };
}

/**
 * The controller is a thin shell over the source, the binding service and
 * the spine, so the first two are built for REAL (with fake repositories)
 * rather than mocked — a shell that no longer reaches the signature check
 * or the owner lookup would otherwise pass a mocked spec.
 */
describe('SentryWebhookController (POST /api/ingest/sentry/events)', () => {
    const originalSecret = process.env.SENTRY_WEBHOOK_CLIENT_SECRET;

    beforeEach(() => {
        process.env.SENTRY_WEBHOOK_CLIENT_SECRET = CLIENT_SECRET;
    });

    afterEach(() => {
        if (originalSecret === undefined) {
            delete process.env.SENTRY_WEBHOOK_CLIENT_SECRET;
        } else {
            process.env.SENTRY_WEBHOOK_CLIENT_SECRET = originalSecret;
        }
        jest.restoreAllMocks();
    });

    function createController(
        claims: Array<{ uuid: string; userId: string }> = [
            { uuid: CLAIMED_UUID, userId: 'user-a' },
        ],
    ) {
        const bindings = new Map<string, { userId: string }>(
            claims.map((c) => [`sentry|installation:${c.uuid}`, { userId: c.userId }]),
        );
        const bindingRepo = {
            findByWorkspace: jest.fn(async (provider: string, key: string) => {
                const row = bindings.get(`${provider}|${key}`);
                return row ? { provider, externalWorkspaceId: key, userId: row.userId } : null;
            }),
            record: jest.fn(),
            findByUser: jest.fn(),
            remove: jest.fn(async (provider: string, key: string) =>
                bindings.delete(`${provider}|${key}`),
            ),
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
                        subject: { title?: string };
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
        const controller = new SentryWebhookController(
            new SentryIncidentSource(),
            new SentryInstallBindingService(bindingRepo as never),
            eventIngestService as never,
        );
        return { controller, eventIngestService, bindingRepo, bindings };
    }

    function signedRequest(bodyObj: unknown, secret = CLIENT_SECRET) {
        const rawBody = JSON.stringify(bodyObj);
        return {
            req: { body: bodyObj, rawBody },
            signature: computeSentrySignature(secret, rawBody),
        };
    }

    it('throws BadRequestException when the raw body is missing', async () => {
        const { controller, eventIngestService } = createController();
        await expect(
            controller.receiveEvents({ body: {}, rawBody: undefined } as never, 'abc', 'issue'),
        ).rejects.toThrow(BadRequestException);
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the resource header is missing', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, signature, undefined)).rejects.toThrow(
            BadRequestException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when SENTRY_WEBHOOK_CLIENT_SECRET is unset — even for a signed delivery', async () => {
        delete process.env.SENTRY_WEBHOOK_CLIENT_SECRET;
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, signature, 'issue')).rejects.toThrow(
            UnauthorizedException,
        );
        await expect(controller.receiveEvents(req as never, signature, 'issue')).rejects.toThrow(
            'not configured',
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('rejects a missing signature with 401 and files nothing', async () => {
        const { controller, eventIngestService } = createController();
        const { req } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, undefined, 'issue')).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('rejects a bad signature with 401 and files nothing', async () => {
        const { controller, eventIngestService } = createController();
        const { req } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, 'deadbeef', 'issue')).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('rejects a delivery signed with a different secret (tampered body)', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody(), 'someone-elses-secret');
        await expect(controller.receiveEvents(req as never, signature, 'issue')).rejects.toThrow(
            UnauthorizedException,
        );
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('rejects a GitHub-style `sha256=` prefixed digest — Sentry’s scheme is the bare hex', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());
        await expect(
            controller.receiveEvents(req as never, `sha256=${signature}`, 'issue'),
        ).rejects.toThrow(UnauthorizedException);
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('ingests a verified issue delivery as an incident for the account that claimed the installation', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());

        await expect(controller.receiveEvents(req as never, signature, 'issue')).resolves.toEqual({
            ok: true,
        });

        expect(eventIngestService.ingest).toHaveBeenCalledTimes(1);
        const [userId, envelopes] = eventIngestService.ingest.mock.calls[0];
        expect(userId).toBe('user-a');
        expect(envelopes[0]).toMatchObject({
            source: 'sentry',
            kind: 'incident',
            subject: { type: 'issue', externalId: '4501' },
            workHint: { kind: 'tracker-team', externalId: 'ever-works-api' },
            payload: {
                provider: 'sentry',
                level: 'error',
                project: 'ever-works-api',
                url: 'https://sentry.io/organizations/ever-co/issues/4501/',
            },
        });
    });

    it('accepts the resource header case-insensitively', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());
        await controller.receiveEvents(req as never, signature, 'Issue');
        expect(eventIngestService.ingest).toHaveBeenCalledTimes(1);
    });

    it('treats a replayed (identical) delivery as a duplicate — no second insert', async () => {
        const { controller, eventIngestService } = createController();
        const { req, signature } = signedRequest(issueBody());

        await controller.receiveEvents(req as never, signature, 'issue');
        await controller.receiveEvents(req as never, signature, 'issue');

        const results = await Promise.all(
            eventIngestService.ingest.mock.results.map((r) => r.value),
        );
        expect(results[0]).toMatchObject({ inserted: 1, duplicates: 0 });
        expect(results[1]).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it('keeps an oversized delivery inside the spine payload budget (only the picked fields travel)', async () => {
        const { controller, eventIngestService } = createController();
        const body = issueBody('created');
        (body.data.issue as Record<string, unknown>).title = 'T'.repeat(200_000);
        (body.data.issue as Record<string, unknown>).metadata = { stack: 'x'.repeat(300_000) };
        const { req, signature } = signedRequest(body);

        await controller.receiveEvents(req as never, signature, 'issue');

        const [, envelopes] = eventIngestService.ingest.mock.calls[0];
        expect(Buffer.byteLength(JSON.stringify(envelopes[0].payload), 'utf8')).toBeLessThan(
            32 * 1024,
        );
        expect((envelopes[0].subject.title as string).length).toBe(500);
    });

    describe('owner attribution — the claim decides, never the payload', () => {
        it('an unclaimed installation is a 200 no-op that files nothing', async () => {
            const { controller, eventIngestService } = createController();
            const { req, signature } = signedRequest(
                issueBody('created', { installation: { uuid: UNCLAIMED_UUID } }),
            );

            await expect(
                controller.receiveEvents(req as never, signature, 'issue'),
            ).resolves.toEqual({
                ok: true,
                ignored: 'unknown-workspace',
            });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('a delivery cannot select a user through anything but a claimed installation uuid', async () => {
            const { controller, eventIngestService } = createController([
                { uuid: CLAIMED_UUID, userId: 'user-a' },
            ]);
            // Names user-b's org everywhere it can, but carries no claimed uuid.
            const { req, signature } = signedRequest(
                issueBody('created', {
                    installation: { uuid: UNCLAIMED_UUID },
                    actor: { type: 'user', id: 2, name: 'user-b' },
                    data: {
                        issue: {
                            ...issueBody().data.issue,
                            project: { id: 1, slug: 'user-b-project' },
                        },
                        installation: { uuid: UNCLAIMED_UUID, organization: { slug: 'user-b' } },
                    },
                }),
            );

            await expect(
                controller.receiveEvents(req as never, signature, 'issue'),
            ).resolves.toEqual({
                ok: true,
                ignored: 'unknown-workspace',
            });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('a malformed installation uuid is a no-op, not a lookup', async () => {
            const { controller, eventIngestService, bindingRepo } = createController();
            const { req, signature } = signedRequest(
                issueBody('created', { installation: { uuid: 'installation:evil' } }),
            );
            await expect(
                controller.receiveEvents(req as never, signature, 'issue'),
            ).resolves.toEqual({
                ok: true,
                ignored: 'unknown-workspace',
            });
            expect(bindingRepo.findByWorkspace).not.toHaveBeenCalled();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });
    });

    describe('installation lifecycle', () => {
        it('a SIGNED installation.deleted removes the binding — later deliveries are ignored', async () => {
            const { controller, eventIngestService, bindings } = createController();
            const gone = signedRequest(installationBody('deleted'));

            await expect(
                controller.receiveEvents(gone.req as never, gone.signature, 'installation'),
            ).resolves.toEqual({ ok: true });
            expect(bindings.has(`sentry|installation:${CLAIMED_UUID}`)).toBe(false);

            const later = signedRequest(issueBody());
            await expect(
                controller.receiveEvents(later.req as never, later.signature, 'issue'),
            ).resolves.toEqual({ ok: true, ignored: 'unknown-workspace' });
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });

        it('an UNSIGNED installation.deleted is rejected and the binding stays', async () => {
            const { controller, bindings } = createController();
            const { req } = signedRequest(installationBody('deleted'));
            await expect(
                controller.receiveEvents(req as never, undefined, 'installation'),
            ).rejects.toThrow(UnauthorizedException);
            expect(bindings.has(`sentry|installation:${CLAIMED_UUID}`)).toBe(true);
        });

        it('installation.created binds nothing — the owner claims the uuid through the authenticated endpoint', async () => {
            const { controller, bindingRepo } = createController([]);
            const { req, signature } = signedRequest(installationBody('created'));
            await expect(
                controller.receiveEvents(req as never, signature, 'installation'),
            ).resolves.toEqual({ ok: true });
            expect(bindingRepo.record).not.toHaveBeenCalled();
        });
    });

    it('acknowledges non-incident resources (error / comment / metric_alert) without ingesting', async () => {
        const { controller, eventIngestService } = createController();
        for (const resource of ['error', 'comment', 'metric_alert']) {
            const { req, signature } = signedRequest(issueBody());
            await expect(
                controller.receiveEvents(req as never, signature, resource),
            ).resolves.toEqual({
                ok: true,
            });
        }
        expect(eventIngestService.ingest).not.toHaveBeenCalled();
    });

    it('never logs the delivery body (stack frames / user context)', async () => {
        const seenLines: string[] = [];
        for (const level of ['log', 'warn', 'error', 'debug'] as const) {
            jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
                seenLines.push(String(message));
            });
        }
        const { controller } = createController();
        const ok = signedRequest(issueBody());
        await controller.receiveEvents(ok.req as never, ok.signature, 'issue');
        const unknown = signedRequest(
            issueBody('created', { installation: { uuid: UNCLAIMED_UUID } }),
        );
        await controller.receiveEvents(unknown.req as never, unknown.signature, 'issue');

        expect(seenLines.length).toBeGreaterThan(0);
        for (const line of seenLines) {
            expect(line).not.toContain(BODY_MARKER);
            // …and not the installation uuid either: it is the whole claim
            // credential for this receiver, and these lines are shipped to
            // the log sink. A prefix is enough to correlate a delivery.
            expect(line).not.toContain(UNCLAIMED_UUID);
        }
        expect(seenLines.some((line) => line.includes(UNCLAIMED_UUID.slice(0, 8)))).toBe(true);
    });

    it('surfaces an ingest failure so Sentry retries (the spine dedupes the retry)', async () => {
        const { controller, eventIngestService } = createController();
        eventIngestService.ingest.mockRejectedValueOnce(new Error('db down'));
        const { req, signature } = signedRequest(issueBody());
        await expect(controller.receiveEvents(req as never, signature, 'issue')).rejects.toThrow(
            'db down',
        );
    });
});
