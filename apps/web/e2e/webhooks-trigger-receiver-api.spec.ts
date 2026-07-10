import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'crypto';
import { loadSeed } from './helpers/seed';

/**
 * EW-743 (#1533 + #1537 + #1542) — Trigger.dev webhook receiver at
 * `POST /api/webhooks/trigger/:tenantId`.
 *
 * HTTP-only: this spec uses Playwright's `request` fixture; no browser
 * is launched. The receiver is documented in
 * `apps/api/src/webhooks/trigger-webhook.controller.ts`.
 *
 * # Stack-up requirement
 *
 * Before running locally:
 *
 *   1. Bring up the API only:
 *        pnpm dev:api                            # API on :3100
 *      (the web app is NOT required for this file — it issues raw
 *      HTTP POSTs straight at the API.)
 *   2. Seed a tenant runtime config row that carries a resolvable
 *      `credentialsSecretRef` whose underlying bag has a
 *      `webhookSecret` string. Export the tenant + secret:
 *        export TEST_TENANT_ID="<uuid-of-seeded-tenant>"
 *        export TEST_TRIGGER_WEBHOOK_SECRET="<the-bag-webhookSecret>"
 *      Plus a second tenant id that has NO webhook secret configured
 *      for the "tenant exists but bag missing field" case:
 *        export TEST_TENANT_ID_NO_SECRET="<uuid-of-other-seeded-tenant>"
 *   3. Cases that depend on a missing var skip themselves with a
 *      clear message.
 *
 * The API base URL defaults to `http://localhost:3100` and can be
 * overridden via `PLAYWRIGHT_API_BASE_URL`.
 *
 * # Coverage map (12 cases)
 *
 *   - valid HMAC + known tenant + valid envelope → 200
 *   - missing X-Trigger-Signature header → 400
 *   - invalid signature → 401
 *   - unknown tenant (random UUID) → 404
 *   - tenant exists but webhookSecret bag absent → 401
 *   - signature prefix variants: missing prefix, upper-case sha256, lower-case sha256
 *   - malformed JSON body → 400
 *   - oversized body (1 MB+) → returns 4xx or 413 (documents behaviour)
 *   - one of the 5 supported event_type values → 200
 *   - unsupported event_type → 200 (router drops, doesn't 5xx)
 *   - same event posted twice → both 200 (no idempotency rejection at receiver)
 *   - 10 concurrent valid POSTs → all 200
 */

// EW-743 Phase A — env vars take precedence (CI sharding / manual
// override), otherwise fall back to the seed file written by the
// `global-setup.ts` setup project. When BOTH are absent every case
// self-skips with a clear message.
const seed = loadSeed();
const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? seed?.apiBase ?? 'http://localhost:3100';
const TENANT_ID = process.env.TEST_TENANT_ID || seed?.tenantId || '';
const WEBHOOK_SECRET = process.env.TEST_TRIGGER_WEBHOOK_SECRET || seed?.webhookSecret || '';
const TENANT_ID_NO_SECRET = process.env.TEST_TENANT_ID_NO_SECRET || seed?.tenantIdNoSecret || '';

const url = (tenantId: string) => `${API_BASE}/api/webhooks/trigger/${tenantId}`;

function sign(rawBody: string, secret: string): string {
    const hex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return `sha256=${hex}`;
}

function buildEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
    const body = {
        id: randomUUID(),
        type: 'alert.run.succeeded',
        event_type: 'alert.run.succeeded',
        tenant_id: TENANT_ID,
        created_at: new Date().toISOString(),
        payload: { ok: true },
        ...overrides,
    };
    return JSON.stringify(body);
}

async function postRaw(
    request: APIRequestContext,
    tenantId: string,
    rawBody: string,
    signature: string | null,
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };
    if (signature !== null) headers['x-trigger-signature'] = signature;
    return request.post(url(tenantId), {
        headers,
        data: rawBody,
    });
}

function requireSeededTenant() {
    test.skip(
        !TENANT_ID || !WEBHOOK_SECRET,
        'TEST_TENANT_ID + TEST_TRIGGER_WEBHOOK_SECRET must be set — see file header.',
    );
}

test.describe('Trigger.dev webhook receiver — API only (#1533, #1537, #1542)', () => {
    test.setTimeout(60_000);

    test('valid HMAC + known tenant + valid envelope → 200', async ({ request }) => {
        requireSeededTenant();
        const body = buildEnvelope();
        const res = await postRaw(request, TENANT_ID, body, sign(body, WEBHOOK_SECRET));
        expect(res.status(), 'valid signed delivery must be accepted').toBe(200);
        const json = await res.json().catch(() => ({}));
        expect(json).toMatchObject({ ok: true });
    });

    test('missing X-Trigger-Signature header → 400', async ({ request }) => {
        requireSeededTenant();
        const body = buildEnvelope();
        const res = await postRaw(request, TENANT_ID, body, null);
        expect(res.status()).toBe(400);
    });

    test('invalid signature (right shape, wrong secret) → 401', async ({ request }) => {
        requireSeededTenant();
        const body = buildEnvelope();
        const wrongSig = sign(body, 'definitely-not-the-real-secret');
        const res = await postRaw(request, TENANT_ID, body, wrongSig);
        expect(res.status()).toBe(401);
    });

    test('unknown tenant (random UUID) → 404', async ({ request }) => {
        requireSeededTenant();
        const fake = randomUUID();
        const body = buildEnvelope({ tenant_id: fake });
        // Sign with the REAL secret so the test isolates the 404-on-unknown-tenant
        // path (the controller 404s before any signature check).
        const res = await postRaw(request, fake, body, sign(body, WEBHOOK_SECRET));
        expect(res.status()).toBe(404);
    });

    test('tenant exists but webhookSecret bag absent → 401', async ({ request }) => {
        test.skip(
            !TENANT_ID_NO_SECRET,
            'TEST_TENANT_ID_NO_SECRET not set — need a seeded tenant whose secret bag has no webhookSecret.',
        );
        const body = buildEnvelope({ tenant_id: TENANT_ID_NO_SECRET });
        // Any signature will do — server fails closed on missing secret
        // BEFORE compare.
        const res = await postRaw(request, TENANT_ID_NO_SECRET, body, sign(body, 'whatever'));
        expect(res.status()).toBe(401);
    });

    test('signature prefix variants: missing prefix and upper-case both rejected; lower-case accepted', async ({
        request,
    }) => {
        requireSeededTenant();
        const body = buildEnvelope();
        const goodHex = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');

        // (1) missing `sha256=` prefix — bare hex
        const noPrefix = await postRaw(request, TENANT_ID, body, goodHex);
        expect(noPrefix.status(), 'bare hex must be rejected').toBe(401);

        // (2) upper-case scheme — `SHA256=...` does NOT match
        // `startsWith('sha256=')`, rejected
        const upperPrefix = await postRaw(request, TENANT_ID, body, `SHA256=${goodHex}`);
        expect(upperPrefix.status(), 'upper-case scheme must be rejected').toBe(401);

        // (3) canonical lower-case `sha256=...` is accepted
        const good = await postRaw(request, TENANT_ID, body, `sha256=${goodHex}`);
        expect(good.status(), 'canonical scheme must be accepted').toBe(200);
    });

    test('malformed JSON body → 400', async ({ request }) => {
        requireSeededTenant();
        const raw = '{ this is : not, json ]';
        const res = await postRaw(request, TENANT_ID, raw, sign(raw, WEBHOOK_SECRET));
        expect(res.status()).toBe(400);
    });

    test('oversized body (~1 MB) → 4xx (documents server-side body-size behaviour)', async ({
        request,
    }) => {
        requireSeededTenant();
        // Construct a ~1 MB payload. Default NestJS body-parser limit is
        // 100kb unless explicitly raised; the assertion accepts either
        // 4xx (rejected at parser / pipe) or 200 (server explicitly
        // allows large bodies) — it ALWAYS asserts no 5xx.
        const huge = 'x'.repeat(1_048_576);
        const body = buildEnvelope({ payload: { huge } });
        const res = await postRaw(request, TENANT_ID, body, sign(body, WEBHOOK_SECRET));
        expect(res.status(), 'oversized body must not 5xx').toBeLessThan(500);
        expect([200, 400, 413]).toContain(res.status());
    });

    test('one of the 5 supported event_type values → 200', async ({ request }) => {
        requireSeededTenant();
        const supported = [
            'alert.run.succeeded',
            'alert.run.failed',
            'alert.run.cancelled',
            'alert.deployment.success',
            'alert.deployment.failed',
        ];
        for (const eventType of supported) {
            const body = buildEnvelope({ type: eventType, event_type: eventType });
            const res = await postRaw(request, TENANT_ID, body, sign(body, WEBHOOK_SECRET));
            expect(res.status(), `event_type=${eventType} must accept`).toBe(200);
        }
    });

    test('unsupported event_type → 200 (router drops; receiver still 200)', async ({ request }) => {
        requireSeededTenant();
        const body = buildEnvelope({
            type: 'completely.made.up.event',
            event_type: 'completely.made.up.event',
        });
        const res = await postRaw(request, TENANT_ID, body, sign(body, WEBHOOK_SECRET));
        // Router drops unknown event types but the receiver still
        // returns 200 (a 5xx would loop the upstream into infinite
        // retries — see controller comment).
        expect(res.status()).toBe(200);
    });

    test('same event posted twice → both 200 (no receiver-layer idempotency rejection)', async ({
        request,
    }) => {
        requireSeededTenant();
        const body = buildEnvelope();
        const sig = sign(body, WEBHOOK_SECRET);
        const r1 = await postRaw(request, TENANT_ID, body, sig);
        const r2 = await postRaw(request, TENANT_ID, body, sig);
        expect(r1.status()).toBe(200);
        expect(r2.status()).toBe(200);
    });

    test('10 concurrent valid POSTs → all 200, no race', async ({ request }) => {
        requireSeededTenant();
        const responses = await Promise.all(
            Array.from({ length: 10 }, () => {
                const body = buildEnvelope();
                return postRaw(request, TENANT_ID, body, sign(body, WEBHOOK_SECRET));
            }),
        );
        for (const res of responses) {
            expect(res.status(), 'every concurrent delivery must 200').toBe(200);
        }
    });
});
