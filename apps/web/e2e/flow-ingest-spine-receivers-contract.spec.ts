import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Event-ingest spine (Wave 6, feature k) + the Slack / GitHub receivers
 * (Wave 6 f, Wave 7 g) — API CONTRACT. All three shipped without e2e.
 *
 * ── Routes ─────────────────────────────────────────────────────────
 *   POST /api/ingest/events        (auth) 202 { inserted, duplicates,
 *                                              rejected }
 *        Dedupe identity is (owner, source, sourceEventId) — a retry is
 *        a no-op and the `duplicates` counter says so. Caps: ≤100
 *        envelopes per call, ≤32 KB serialized payload each.
 *   POST /api/ingest/slack/events  (@Public) signature-verified, FAILS
 *        CLOSED — with no configured install everything is 401,
 *        INCLUDING the url_verification handshake (Slack signs it too).
 *   POST /api/ingest/slack/commands (@Public) the slash-command twin:
 *        form-encoded, same v0 HMAC, same fail-closed posture.
 *   POST /api/ingest/github/events (@Public) signature-verified, fails
 *        closed the same way; a missing `x-github-event` header is 400.
 *
 * The receivers are the highest-risk surface the program shipped: they
 * are public, they take third-party payloads, and their only guard is
 * an HMAC. The invariant asserted here is that no unsigned or
 * wrongly-signed delivery is ever ACCEPTED, whatever the install's
 * configuration state is.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function ingest(request: APIRequestContext, token: string, events: unknown[]) {
    return request.post(`${API_BASE}/api/ingest/events`, {
        headers: authedHeaders(token),
        data: { events },
    });
}

/** A minimal VALID envelope (every required field, nothing else). */
function envelope(overrides: Record<string, unknown> = {}) {
    const id = uniq();
    return {
        id: `env-${id}`,
        source: 'slack-connector',
        sourceEventId: `evt-${id}`,
        kind: 'slack.message',
        occurredAt: new Date().toISOString(),
        payload: { text: 'hello from e2e' },
        ...overrides,
    };
}

test.describe('POST /api/ingest/events', () => {
    test('accepts a batch with 202 and reports inserted / duplicates / rejected', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const one = envelope();

        const first = await ingest(request, u.access_token, [one]);
        expect(first.status(), `ingest body=${await first.text().catch(() => '')}`).toBe(202);
        const firstBody = await first.json();
        expect(firstBody.inserted).toBe(1);
        expect(firstBody.duplicates).toBe(0);
        expect(firstBody.rejected).toBe(0);
    });

    test('re-posting the same (source, sourceEventId) is a no-op counted as a duplicate', async ({
        request,
    }) => {
        // Retries are the normal case for connectors — the dedupe identity
        // must absorb them instead of doubling a user's feed.
        const u = await registerUserViaAPI(request);
        const one = envelope();

        const first = await ingest(request, u.access_token, [one]);
        expect(first.status()).toBe(202);
        expect((await first.json()).inserted).toBe(1);

        // A DIFFERENT envelope id, same dedupe identity — still a duplicate.
        const retry = await ingest(request, u.access_token, [
            { ...one, id: `env-retry-${uniq()}` },
        ]);
        expect(retry.status()).toBe(202);
        const retryBody = await retry.json();
        expect(retryBody.inserted).toBe(0);
        expect(retryBody.duplicates).toBe(1);
    });

    test('dedupe is PER OWNER — the same source event may land for two accounts', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const shared = envelope();

        const forA = await ingest(request, a.access_token, [shared]);
        expect(forA.status()).toBe(202);
        expect((await forA.json()).inserted).toBe(1);

        const forB = await ingest(request, b.access_token, [shared]);
        expect(forB.status()).toBe(202);
        expect(
            (await forB.json()).inserted,
            'a second owner is not blocked by the first owner’s dedupe row',
        ).toBe(1);
    });

    test('the envelope DTO is validated field by field', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const empty = await ingest(request, u.access_token, []);
        expect(empty.status(), 'an empty batch is rejected (ArrayNotEmpty)').toBe(400);

        const cases: Array<[string, Record<string, unknown>]> = [
            ['id', envelope({ id: '' })],
            ['source', envelope({ source: '' })],
            ['sourceEventId', envelope({ sourceEventId: '' })],
            ['kind', envelope({ kind: '' })],
            ['occurredAt', envelope({ occurredAt: 'yesterday' })],
            ['payload', envelope({ payload: 'not-an-object' })],
            ['workId', envelope({ workId: 'not-a-uuid' })],
            ['sourceUrl', envelope({ sourceUrl: 'x'.repeat(2049) })],
        ];
        for (const [field, bad] of cases) {
            const res = await ingest(request, u.access_token, [bad]);
            expect(res.status(), `envelope.${field}`).toBe(400);
            expect(errText(await res.json()), `envelope.${field} message`).toContain(field);
        }

        const unknownKey = await ingest(request, u.access_token, [
            { ...envelope(), bogusField: 1 },
        ]);
        expect(unknownKey.status()).toBe(400);
        expect(errText(await unknownKey.json())).toContain('should not exist');
    });

    test('the batch (100) and payload (32 KB) caps are enforced at the edge', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const hundred = Array.from({ length: 100 }, () => envelope());
        const atCap = await ingest(request, u.access_token, hundred);
        expect(atCap.status(), 'exactly 100 envelopes is accepted').toBe(202);

        const overCap = await ingest(request, u.access_token, [...hundred, envelope()]);
        expect(overCap.status(), '101 envelopes is rejected').toBe(400);

        const oversizedPayload = await ingest(request, u.access_token, [
            envelope({ payload: { blob: 'x'.repeat(33 * 1024) } }),
        ]);
        expect(oversizedPayload.status(), 'a >32 KB payload is rejected').toBe(400);
        expect(errText(await oversizedPayload.json())).toContain('payload');
    });

    test('anonymous ingest is 401 — events are always owner-scoped', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/events`, {
            data: { events: [envelope()] },
        });
        expect(res.status()).toBe(401);
    });
});

test.describe('POST /api/ingest/slack/events — fail-closed signature verification', () => {
    const slackBody = { type: 'url_verification', challenge: `e2e-${Date.now()}` };

    test('an unsigned url_verification handshake is refused and the challenge is NOT echoed', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/ingest/slack/events`, { data: slackBody });
        expect(res.status(), `slack returned ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect(await res.text()).not.toContain(slackBody.challenge);
    });

    test('a garbage signature + timestamp is refused (never 2xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/slack/events`, {
            headers: {
                'x-slack-signature': 'v0=deadbeef',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
            },
            data: { type: 'event_callback', event: { type: 'app_mention', text: '@works hi' } },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('a STALE timestamp is refused even with a signature header present', async ({
        request,
    }) => {
        // ±300s tolerance — a replayed delivery from an hour ago must not
        // be accepted regardless of what the signature says.
        const res = await request.post(`${API_BASE}/api/ingest/slack/events`, {
            headers: {
                'x-slack-signature': 'v0=deadbeef',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000) - 3600),
            },
            data: { type: 'event_callback', event: { type: 'app_mention', text: '@works hi' } },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});

/**
 * The slash command is the second Slack route. It is form-encoded rather
 * than JSON and its response body is user-visible, but its guard is the
 * SAME v0 HMAC — so the same invariant applies: no unsigned or
 * wrongly-signed invocation is ever accepted.
 */
test.describe('POST /api/ingest/slack/commands — fail-closed signature verification', () => {
    /** Slack delivers slash commands as `application/x-www-form-urlencoded`. */
    const commandForm = {
        team_id: 'T-E2E',
        channel_id: 'C-E2E',
        user_id: 'U-E2E',
        command: '/works',
        text: 'what shipped today?',
        trigger_id: `e2e-${Date.now()}`,
    };

    test('an unsigned slash command is refused (never 2xx, never a 500)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/slack/commands`, {
            form: commandForm,
        });
        expect(res.status(), `slack commands returned ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('a garbage signature is refused', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/slack/commands`, {
            headers: {
                'x-slack-signature': 'v0=deadbeef',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
            },
            form: commandForm,
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('a STALE timestamp is refused even with a signature header present', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/ingest/slack/commands`, {
            headers: {
                'x-slack-signature': 'v0=deadbeef',
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000) - 3600),
            },
            form: commandForm,
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('POST /api/ingest/github/events — fail-closed signature verification', () => {
    test('a missing x-github-event header is a 400 before anything else runs', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/ingest/github/events`, {
            data: { zen: 'e2e' },
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('GitHub event header');
    });

    test('an unsigned ping is refused — the handshake is signed too', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/github/events`, {
            headers: { 'x-github-event': 'ping' },
            data: { zen: 'e2e' },
        });
        expect(res.status()).toBe(401);
    });

    test('a wrongly-signed pull_request delivery is refused (never 2xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/ingest/github/events`, {
            headers: {
                'x-github-event': 'pull_request',
                'x-hub-signature-256': 'sha256=deadbeef',
            },
            data: { action: 'opened', pull_request: { number: 1 } },
        });
        expect(res.status()).toBe(401);
        expect(errText(await res.json())).toMatch(/signature|not configured/i);
    });

    test('the receiver is not reachable with a platform session either — it is signature-only', async ({
        request,
    }) => {
        // Presenting a valid user token must NOT substitute for a valid
        // webhook signature: the route is @Public() and its ONLY credential
        // is the HMAC.
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/ingest/github/events`, {
            headers: { ...authedHeaders(u.access_token), 'x-github-event': 'ping' },
            data: { zen: 'e2e' },
        });
        expect(res.status()).toBe(401);
    });
});
