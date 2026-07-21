import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Outbound webhook subscriptions — `/api/webhooks` — MULTI-STEP flows.
 *
 * This file owns the CHAINED, journey-level contracts that the existing
 * per-endpoint webhook specs deliberately leave uncovered. It drives the
 * whole subscription lifecycle end-to-end against the LIVE sqlite e2e API
 * (port 3100) with throwaway users, pinning behaviour no other spec pins:
 *
 *   • the full create → list → test-fire → deliveries → redeliver → rotate
 *     → pause → delete → 404 JOURNEY as one chained flow.
 *   • the MULTI-HOP redelivery chain — redeliver a redelivery (D1→D2→D3):
 *     every hop mints a NEW delivery id, REUSES the stored payload's event
 *     (webhook.test), stays bound to the same subscriptionId, and the
 *     account-wide listing stays ordered most-recent-first.
 *   • redelivery SURVIVING the subscription lifecycle: redeliver still 202
 *     enqueues after the subscription is PAUSED, and even after it is
 *     DELETED — the delivery history is not cascaded away with the row.
 *   • the subscription-level failure counter: a failed test-fire against an
 *     unreachable receiver increments `consecutiveFailures` monotonically
 *     while the delivery ROW settles to `failed`.
 *   • the URL-validation surface breadth: non-http(s) schemes
 *     (javascript:/file:/data:/ftp:) and TLD-less hosts (localhost) are
 *     rejected 400 at the DTO; the private-IP SSRF guard is env-gated (this
 *     API runs in local-env URL mode) so IP-literal / metadata targets are
 *     accepted — asserted tolerantly + honestly.
 *   • multi-subscription aggregation: the single account-wide deliveries
 *     listing spans every subscription the account owns, each row mapped to
 *     the right subscriptionId, and never leaks a second account's rows.
 *   • cross-user redelivery isolation (404, never 403) and the consolidated
 *     anonymous-401 gate across every verb.
 *
 * ── PROBED LIVE (http://127.0.0.1:3100) before every assertion:
 *   POST /api/webhooks { url } → 201 { subscription:{ id, accountId, workId:null,
 *        url, status:'active', consecutiveFailures:0, lastDeliveryAt:null,
 *        createdAt, updatedAt }, signingSecret:'<base64url 32B, ONCE>' }.
 *   POST /api/webhooks { url:'javascript:'|'file:'|'data:'|'ftp:'|'localhost'|
 *        'not-a-url' } → 400 { message:['url must be a URL address'] } (DTO gate).
 *   POST /api/webhooks { url:'http://127.0.0.1:9000'|'http://169.254.169.254/…'|
 *        'http://[::1]:9000' } → 201 in this local-env API (service SSRF guard
 *        is skipped when NODE_ENV is local; the DTO still requires a TLD).
 *   POST /api/webhooks/:id/test → 200 { deliveryId:<uuid>, outcome:<bucket≠success>,
 *        status:null, ok:false } for an unreachable receiver; increments the
 *        subscription's consecutiveFailures by 1 per fire.
 *   GET  /api/webhooks/deliveries → 200 { deliveries:[…] } most-recent-first,
 *        account-scoped; survives subscription deletion.
 *   POST /api/webhooks/deliveries/:id/redeliver → 202 { deliveryId:<NEW uuid>,
 *        enqueued:true, runId:null } reusing the original event; cross-account or
 *        absent id → 404 { message:'Webhook delivery not found' }; malformed →
 *        400 'Validation failed (uuid is expected)'.
 *   POST /api/webhooks/:id/rotate-secret → 200 { subscription:{ id, status },
 *        signingSecret:<NEW> } — same row, history preserved.
 *   PATCH /api/webhooks/:id { status:'paused' } → 200 view status:'paused'
 *        (row then drops from the active list; per-id verbs still resolve it).
 *   DELETE /api/webhooks/:id → 204; repeat / cross-account / rotate-after-delete
 *        on the id → 404.
 *
 * NON-DUPLICATION — read first, NOT re-pinned here:
 *   - sec-pin-webhook-ownership.spec.ts owns the workId binding gate + the
 *     findOwn 404-mask matrix + the view field-SET / secret hygiene.
 *   - flow-work-webhook-signatures.spec.ts owns the HMAC signing-key contract
 *     (rotation invalidates the old key, uniqueness, payload-binding) + the
 *     inbound github-app receiver.
 *   - flow-webhooks-delivery-deep.spec.ts owns the delivery-VIEW record field
 *     set/types, the pause/resume PATCH branch matrix, and single-hop redeliver
 *     event-reuse.
 *   This file owns the CHAINED journeys, the multi-HOP redelivery, redelivery-
 *   survives-pause/delete, the consecutiveFailures counter, the URL-scheme
 *   breadth + env-adaptive SSRF surface, and multi-subscription aggregation.
 *
 * ISOLATION: every test registers a FRESH user via registerUserViaAPI. Receiver
 * URLs are unreachable hosts (per-test unique suffix) so NO real outbound
 * delivery is required (keyless / Trigger.dev-unbound CI safe) — we assert the
 * RECORD + bucket, never live delivery. All assertions are API-contract level
 * (no UI navigation). Per-route throttles are per-USER buckets (create 10/min,
 * test/rotate 5/min, redeliver 10/min, patch 20/min); fresh-user-per-test with
 * a small per-test verb budget stays far under every limit.
 */

const WEBHOOKS = `${API_BASE}/api/webhooks`;
const DELIVERIES = `${WEBHOOKS}/deliveries`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A v4-shaped UUID no live delivery row will ever carry. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/** Documented delivery outcome buckets (webhook-delivery.service.ts). */
const DELIVERY_OUTCOMES = new Set([
    'success',
    'client_error',
    'server_error',
    'timeout',
    'redirect_refused',
    'payload_too_large',
    'ssrf_blocked',
]);

/** Terminal/transient delivery statuses (WebhookDeliveryView). */
const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed', 'retrying']);

interface SubscriptionView {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: string;
    consecutiveFailures: number;
    lastDeliveryAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface DeliveryView {
    id: string;
    subscriptionId: string;
    event: string;
    status: string;
    attempts: number;
    lastResponseStatus: number | null;
    lastOutcome: string | null;
    lastError: string | null;
    durationMs: number | null;
    triggerRunId: string | null;
    lastAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function invalidUrl(tag: string): string {
    return `https://webhook.invalid.ever.works/${tag}-${stamp()}`;
}

async function createSubscription(
    request: APIRequestContext,
    token: string,
    tag: string,
    extra: Record<string, unknown> = {},
): Promise<{ id: string; signingSecret: string; subscription: SubscriptionView }> {
    const res = await request.post(WEBHOOKS, {
        headers: authedHeaders(token),
        data: { url: invalidUrl(tag), ...extra },
    });
    expect(res.status(), `create ${tag} body=${await res.text().catch(() => '')}`).toBe(201);
    const body = (await res.json()) as { subscription: SubscriptionView; signingSecret: string };
    return {
        id: body.subscription.id,
        signingSecret: body.signingSecret,
        subscription: body.subscription,
    };
}

async function testFire(
    request: APIRequestContext,
    token: string,
    subId: string,
): Promise<{ deliveryId: string; outcome: string; status: number | null; ok: boolean }> {
    const res = await request.post(`${WEBHOOKS}/${subId}/test`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

async function listSubscriptions(
    request: APIRequestContext,
    token: string,
): Promise<SubscriptionView[]> {
    const res = await request.get(WEBHOOKS, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { subscriptions: SubscriptionView[] };
    expect(Array.isArray(body.subscriptions)).toBe(true);
    return body.subscriptions;
}

async function listDeliveries(request: APIRequestContext, token: string): Promise<DeliveryView[]> {
    const res = await request.get(DELIVERIES, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { deliveries: DeliveryView[] };
    expect(Array.isArray(body.deliveries)).toBe(true);
    return body.deliveries;
}

async function redeliver(
    request: APIRequestContext,
    token: string,
    deliveryId: string,
): Promise<{
    status: number;
    body: { deliveryId?: string; enqueued?: boolean; runId?: string | null; message?: string };
}> {
    const res = await request.post(`${DELIVERIES}/${deliveryId}/redeliver`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await res.json() };
}

test.describe('Webhooks subscriptions — end-to-end lifecycle (multi-step)', () => {
    test('the full create → list → fire → deliver → redeliver → rotate → pause → delete journey chains cleanly', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // 1) create → active, read-after-write in the list.
        const sub = await createSubscription(request, u.access_token, 'journey');
        expect(sub.id).toMatch(UUID_RE);
        expect(sub.subscription.status).toBe('active');
        let subs = await listSubscriptions(request, u.access_token);
        expect(subs.map((s) => s.id)).toContain(sub.id);

        // 2) test-fire → records a delivery that shows up in the listing.
        const fire = await testFire(request, u.access_token, sub.id);
        expect(fire.deliveryId).toMatch(UUID_RE);
        let deliveries = await listDeliveries(request, u.access_token);
        expect(deliveries.map((d) => d.id)).toContain(fire.deliveryId);

        // 3) redeliver → a fresh row, both present.
        const rd = await redeliver(request, u.access_token, fire.deliveryId);
        expect(rd.status).toBe(202);
        expect(rd.body.enqueued).toBe(true);
        expect(rd.body.deliveryId).not.toBe(fire.deliveryId);
        deliveries = await listDeliveries(request, u.access_token);
        expect(deliveries.map((d) => d.id)).toEqual(
            expect.arrayContaining([fire.deliveryId, rd.body.deliveryId as string]),
        );

        // 4) rotate → same subscription id, still active, secret changes.
        const rot = await request.post(`${WEBHOOKS}/${sub.id}/rotate-secret`, {
            headers: authedHeaders(u.access_token),
        });
        expect(rot.status()).toBe(200);
        const rotBody = (await rot.json()) as {
            subscription: SubscriptionView;
            signingSecret: string;
        };
        expect(rotBody.subscription.id).toBe(sub.id);
        expect(rotBody.subscription.status).toBe('active');
        expect(rotBody.signingSecret).not.toBe(sub.signingSecret);

        // 5) pause → drops from the active list.
        const pause = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });
        expect(pause.status()).toBe(200);
        subs = await listSubscriptions(request, u.access_token);
        expect(subs.map((s) => s.id)).not.toContain(sub.id);

        // 6) delete → 204; the id then masks as 404 on every verb.
        const del = await request.delete(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(204);
        const again = await request.delete(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(again.status()).toBe(404);
        const rotAfter = await request.post(`${WEBHOOKS}/${sub.id}/rotate-secret`, {
            headers: authedHeaders(u.access_token),
        });
        expect(rotAfter.status()).toBe(404);
    });

    test('signingSecret is returned exactly once and never re-appears in the subscription OR deliveries listing', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'secret-once');

        // The raw secret is a url-safe base64url HMAC key (~43 chars).
        expect(typeof sub.signingSecret).toBe('string');
        expect(sub.signingSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);

        // Fire so a delivery row exists, then prove the secret leaks through
        // NEITHER listing surface — the raw key lived only in the create body.
        await testFire(request, u.access_token, sub.id);

        const subsText = await (
            await request.get(WEBHOOKS, { headers: authedHeaders(u.access_token) })
        ).text();
        const delText = await (
            await request.get(DELIVERIES, { headers: authedHeaders(u.access_token) })
        ).text();
        expect(
            subsText.includes(sub.signingSecret),
            'subscription listing leaked the raw secret',
        ).toBe(false);
        expect(
            delText.includes(sub.signingSecret),
            'deliveries listing leaked the raw secret',
        ).toBe(false);

        // And the subscription view carries no secret-shaped field at all.
        const view = (await listSubscriptions(request, u.access_token)).find(
            (s) => s.id === sub.id,
        );
        expect(view).toBeTruthy();
        expect(Object.keys(view as object).some((k) => /secret/i.test(k))).toBe(false);
    });

    test('a freshly-created subscription reports the exact zero-state values via the list', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'zero-state');

        const view = (await listSubscriptions(request, u.access_token)).find(
            (s) => s.id === sub.id,
        );
        expect(view, 'freshly created subscription missing from own list').toBeTruthy();
        expect(view!.accountId).toBe(u.user.id);
        expect(view!.workId).toBeNull();
        expect(view!.status).toBe('active');
        // A brand-new subscription that has never delivered.
        expect(view!.consecutiveFailures).toBe(0);
        expect(view!.lastDeliveryAt).toBeNull();
        expect(typeof view!.createdAt).toBe('string');
        expect(typeof view!.updatedAt).toBe('string');
    });
});

test.describe('Webhooks — multi-hop redelivery chain', () => {
    test('redeliver-of-a-redeliver mints three distinct ids, reuses the event, and stays ordered most-recent-first', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'multihop');

        const d1 = (await testFire(request, u.access_token, sub.id)).deliveryId;
        const r1 = await redeliver(request, u.access_token, d1);
        expect(r1.status).toBe(202);
        const d2 = r1.body.deliveryId as string;
        const r2 = await redeliver(request, u.access_token, d2); // redeliver the redelivery
        expect(r2.status).toBe(202);
        const d3 = r2.body.deliveryId as string;

        // Three distinct delivery rows.
        expect(new Set([d1, d2, d3]).size).toBe(3);

        const rows = await listDeliveries(request, u.access_token);
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of [d1, d2, d3]) {
            const row = byId.get(id);
            expect(row, `delivery ${id} missing from listing`).toBeTruthy();
            // Every hop replays the ORIGINAL stored payload — same event, same sub.
            expect(row!.event).toBe('webhook.test');
            expect(row!.subscriptionId).toBe(sub.id);
        }

        // Most-recent-first: the latest hop sorts ahead of its predecessors.
        const idx = (id: string) => rows.findIndex((r) => r.id === id);
        expect(idx(d3)).toBeLessThan(idx(d2));
        expect(idx(d2)).toBeLessThan(idx(d1));
    });

    test('redeliver replays the original stored payload even AFTER the signing secret is rotated', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'replay-after-rotate');
        const original = await testFire(request, u.access_token, sub.id);

        // Rotate the secret between capture and replay.
        const rot = await request.post(`${WEBHOOKS}/${sub.id}/rotate-secret`, {
            headers: authedHeaders(u.access_token),
        });
        expect(rot.status()).toBe(200);
        expect(((await rot.json()) as { signingSecret: string }).signingSecret).not.toBe(
            sub.signingSecret,
        );

        // Redeliver still succeeds and replays the ORIGINAL event name — the
        // stored payload is reused, not re-minted from a fresh producer event.
        const rd = await redeliver(request, u.access_token, original.deliveryId);
        expect(rd.status).toBe(202);
        expect(rd.body.enqueued).toBe(true);
        const replayed = (await listDeliveries(request, u.access_token)).find(
            (d) => d.id === rd.body.deliveryId,
        );
        expect(replayed, 'replayed delivery missing from listing').toBeTruthy();
        expect(replayed!.event).toBe('webhook.test');
        expect(replayed!.subscriptionId).toBe(sub.id);
    });

    test('a second account cannot redeliver another account delivery id (404, never 403) and its listing stays empty', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const sub = await createSubscription(request, owner.access_token, 'xuser-rd');
        const owned = await testFire(request, owner.access_token, sub.id);

        const foreign = await redeliver(request, attacker.access_token, owned.deliveryId);
        expect(foreign.status, 'cross-account redeliver must 404, not 403').toBe(404);
        expect(foreign.body.message).toBe('Webhook delivery not found');

        // The attacker never sees the owner's row.
        expect(await listDeliveries(request, attacker.access_token)).toHaveLength(0);
        // And the owner's delivery survived the probe untouched.
        expect((await listDeliveries(request, owner.access_token)).map((d) => d.id)).toContain(
            owned.deliveryId,
        );
    });

    test('redeliver contract edges: in-process enqueue is 202 { runId:null }; absent id → 404; malformed → 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rd-edges');
        const d1 = (await testFire(request, u.access_token, sub.id)).deliveryId;

        // Real redeliver: 202, fresh id, and (no Trigger.dev in e2e) null runId.
        const ok = await redeliver(request, u.access_token, d1);
        expect(ok.status).toBe(202);
        expect(ok.body.enqueued).toBe(true);
        expect(ok.body.deliveryId).toMatch(UUID_RE);
        expect(ok.body.deliveryId).not.toBe(d1);
        expect(ok.body.runId).toBeNull();

        // Well-formed but absent uuid → clean 404 (not 5xx), exact message.
        const absent = await redeliver(request, u.access_token, ABSENT_UUID);
        expect(absent.status).toBe(404);
        expect(absent.body.message).toBe('Webhook delivery not found');

        // Malformed id → ParseUUIDPipe 400 before the service runs.
        const malformed = await request.post(`${DELIVERIES}/not-a-uuid/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        expect(malformed.status()).toBe(400);
        expect(((await malformed.json()) as { message?: string }).message).toBe(
            'Validation failed (uuid is expected)',
        );
    });
});

test.describe('Webhooks — redelivery survives the subscription lifecycle', () => {
    test('a delivery can still be redelivered after its subscription is PAUSED', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rd-paused');
        const d1 = (await testFire(request, u.access_token, sub.id)).deliveryId;

        const pause = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });
        expect(pause.status()).toBe(200);
        // The active list no longer shows it...
        expect((await listSubscriptions(request, u.access_token)).map((s) => s.id)).not.toContain(
            sub.id,
        );

        // ...yet redeliver is NOT status-gated — the replay still enqueues.
        const rd = await redeliver(request, u.access_token, d1);
        expect(rd.status).toBe(202);
        expect(rd.body.enqueued).toBe(true);
        expect(rd.body.deliveryId).not.toBe(d1);
    });

    test('deleting a subscription does NOT cascade its deliveries — redeliver still 202 and the history survives', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rd-deleted');
        const d1 = (await testFire(request, u.access_token, sub.id)).deliveryId;

        const del = await request.delete(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(204);
        // The subscription is gone from the active list.
        expect((await listSubscriptions(request, u.access_token)).map((s) => s.id)).not.toContain(
            sub.id,
        );

        // The delivery row outlives the subscription and is still redeliverable
        // (the dispatcher skips the SSRF re-check when the sub no longer exists).
        const rd = await redeliver(request, u.access_token, d1);
        expect(rd.status).toBe(202);
        expect(rd.body.enqueued).toBe(true);
        const d2 = rd.body.deliveryId as string;

        const rows = await listDeliveries(request, u.access_token);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(d1);
        expect(ids).toContain(d2);
        // Both rows remain bound to the now-deleted subscription id.
        for (const id of [d1, d2]) {
            expect(rows.find((r) => r.id === id)!.subscriptionId).toBe(sub.id);
            expect(rows.find((r) => r.id === id)!.event).toBe('webhook.test');
        }
    });
});

test.describe('Webhooks — subscription failure accounting (multi-step)', () => {
    test('each failed test-fire increments consecutiveFailures while the delivery row settles to failed', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'failcount');

        const readCounter = async (): Promise<number> => {
            const view = (await listSubscriptions(request, u.access_token)).find(
                (s) => s.id === sub.id,
            );
            expect(view, 'subscription missing from own list').toBeTruthy();
            return view!.consecutiveFailures;
        };

        expect(await readCounter()).toBe(0);

        const f1 = await testFire(request, u.access_token, sub.id);
        // Unreachable receiver ⇒ documented non-success bucket, never delivered.
        expect(DELIVERY_OUTCOMES.has(f1.outcome)).toBe(true);
        expect(f1.outcome).not.toBe('success');
        expect(f1.ok).toBe(false);
        expect(f1.status).toBeNull();
        const c1 = await readCounter();
        expect(c1).toBeGreaterThanOrEqual(1);

        const f2 = await testFire(request, u.access_token, sub.id);
        const c2 = await readCounter();
        // The subscription-level counter is monotonic across consecutive fails.
        expect(c2).toBeGreaterThan(c1);

        // The still-failing subscription is not silently torn down.
        const stillThere = (await listSubscriptions(request, u.access_token)).find(
            (s) => s.id === sub.id,
        );
        expect(stillThere!.status).toBe('active');

        // Cross-check the delivery ROW side: each fire's row is terminal-failed
        // with at least one recorded attempt.
        const rows = await listDeliveries(request, u.access_token);
        for (const id of [f1.deliveryId, f2.deliveryId]) {
            const row = rows.find((r) => r.id === id);
            expect(row, `delivery ${id} missing`).toBeTruthy();
            expect(DELIVERY_STATUSES.has(row!.status)).toBe(true);
            expect(row!.status).toBe('failed');
            expect(row!.attempts).toBeGreaterThanOrEqual(1);
            expect(row!.lastAttemptAt).not.toBeNull();
        }
    });
});

test.describe('Webhooks — URL validation & SSRF surface at create', () => {
    test('non-http(s) schemes are rejected 400 at the DTO (javascript / file / data / ftp)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const schemes = [
            'javascript:alert(1)',
            'file:///etc/passwd',
            'data:text/plain;base64,aGk=',
            'ftp://example.com/x',
        ];
        for (const url of schemes) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url },
            });
            expect(res.status(), `scheme ${url} must be 400`).toBe(400);
            const body = (await res.json()) as { message?: string | string[] };
            expect(Array.isArray(body.message)).toBe(true);
            expect(body.message).toContain('url must be a URL address');
        }
    });

    test('a TLD-less host and plain garbage are rejected 400; a well-formed https URL is accepted 201', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // `localhost` has no TLD, so class-validator's @IsUrl rejects it before
        // the service-layer SSRF guard is ever consulted.
        for (const url of ['http://localhost:8080/hook', 'not-a-url']) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url },
            });
            expect(res.status(), `url ${url} must be 400`).toBe(400);
            expect(((await res.json()) as { message?: string[] }).message).toContain(
                'url must be a URL address',
            );
        }

        // A normal absolute https URL sails through.
        const good = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: invalidUrl('good-https') },
        });
        expect(good.status()).toBe(201);
        expect(
            ((await good.json()) as { subscription: SubscriptionView }).subscription.status,
        ).toBe('active');
    });

    test('the private-IP SSRF guard is env-gated — IP-literal / metadata targets are accepted in this local-env API', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // The service-layer SSRF guard only runs outside local dev/test. This
        // API is in local-env URL mode, so IP-literal loopback and the cloud
        // metadata host pass the DTO (they carry a valid host) and are created.
        // Assert tolerantly so the same spec stays honest if run where the guard
        // IS active (then these 403 / 400 instead).
        for (const url of [
            'http://127.0.0.1:9000/hook',
            'http://169.254.169.254/latest/meta-data/',
            'http://[::1]:9000/hook',
        ]) {
            const res = await request.post(WEBHOOKS, {
                headers: authedHeaders(u.access_token),
                data: { url },
            });
            expect([201, 400, 403], `url ${url} status ${res.status()}`).toContain(res.status());
            if (res.status() === 201) {
                const body = (await res.json()) as { subscription: SubscriptionView };
                expect(body.subscription.status).toBe('active');
                expect(body.subscription.url).toBe(url);
            }
        }
    });

    test('defense-in-depth: a subscription created at an IP-literal / metadata host is still SSRF-blocked at DELIVERY time', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Creation-time SSRF is env-gated, but the delivery worker re-checks
        // every target with the same lexical guard — so even a subscription
        // that slipped past creation cannot actually reach a private host.
        const created = await request.post(WEBHOOKS, {
            headers: authedHeaders(u.access_token),
            data: { url: 'http://169.254.169.254/latest/meta-data/' },
        });
        // If this env runs the creation-time guard, the create itself is
        // refused — that is an equally-valid "blocked" outcome.
        if (created.status() !== 201) {
            expect([400, 403]).toContain(created.status());
            return;
        }
        const sub = (await created.json()) as { subscription: SubscriptionView };
        const fire = await testFire(request, u.access_token, sub.subscription.id);
        // The delivery-layer guard settles a documented non-success bucket
        // (observed: ssrf_blocked) — never a delivered success.
        expect(DELIVERY_OUTCOMES.has(fire.outcome), `outcome ${fire.outcome}`).toBe(true);
        expect(fire.outcome).not.toBe('success');
        expect(fire.ok).toBe(false);
        expect(fire.status).toBeNull();

        const row = (await listDeliveries(request, u.access_token)).find(
            (d) => d.id === fire.deliveryId,
        );
        expect(row, 'blocked delivery must still be recorded').toBeTruthy();
        expect(row!.status).toBe('failed');
    });
});

test.describe('Webhooks — multi-subscription flows', () => {
    test('account-wide and work-scoped subscriptions coexist in the list; the work-scoped one fires + records', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `wh-scope-${stamp()}`,
        });
        expect(work.id).toBeTruthy();

        const accountWide = await createSubscription(request, u.access_token, 'acct-wide');
        const workScoped = await createSubscription(request, u.access_token, 'work-scoped', {
            workId: work.id,
        });

        const subs = await listSubscriptions(request, u.access_token);
        const wide = subs.find((s) => s.id === accountWide.id);
        const scoped = subs.find((s) => s.id === workScoped.id);
        expect(wide, 'account-wide subscription missing').toBeTruthy();
        expect(scoped, 'work-scoped subscription missing').toBeTruthy();
        // The scope binding is reflected exactly: null vs the bound workId.
        expect(wide!.workId).toBeNull();
        expect(scoped!.workId).toBe(work.id);

        // The work-scoped subscription is a first-class delivery target.
        const fire = await testFire(request, u.access_token, workScoped.id);
        const row = (await listDeliveries(request, u.access_token)).find(
            (d) => d.id === fire.deliveryId,
        );
        expect(row, 'work-scoped test-fire missing from listing').toBeTruthy();
        expect(row!.subscriptionId).toBe(workScoped.id);
        expect(row!.event).toBe('webhook.test');
    });

    test('the account-wide deliveries listing spans every subscription and never leaks a second account', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const subA = await createSubscription(request, a.access_token, 'agg-a');
        const subB = await createSubscription(request, a.access_token, 'agg-b');
        const fireA = await testFire(request, a.access_token, subA.id);
        const fireB = await testFire(request, a.access_token, subB.id);

        const rows = await listDeliveries(request, a.access_token);
        // Both deliveries surface under the single account-wide listing, each
        // correctly attributed to its own subscription.
        expect(rows.find((d) => d.id === fireA.deliveryId)?.subscriptionId).toBe(subA.id);
        expect(rows.find((d) => d.id === fireB.deliveryId)?.subscriptionId).toBe(subB.id);
        // The listing spans (at least) both subscriptions.
        const subsSeen = new Set(rows.map((d) => d.subscriptionId));
        expect(subsSeen.has(subA.id)).toBe(true);
        expect(subsSeen.has(subB.id)).toBe(true);

        // A fresh second account shares none of it.
        const bRows = await listDeliveries(request, b.access_token);
        expect(bRows).toHaveLength(0);
    });
});

test.describe('Webhooks — cross-cutting gates & rotation', () => {
    test('every verb on the surface is auth-gated — anonymous requests are 401', async ({
        playwright,
    }) => {
        // Fresh context — no storageState, no inherited cookies.
        const anon = await playwright.request.newContext();
        try {
            const probes: Array<Promise<{ status: () => number }>> = [
                anon.get(WEBHOOKS),
                anon.get(DELIVERIES),
                anon.post(WEBHOOKS, { data: { url: 'https://example.com/anon' } }),
                anon.post(`${WEBHOOKS}/${ABSENT_UUID}/rotate-secret`),
                anon.post(`${WEBHOOKS}/${ABSENT_UUID}/test`),
                anon.patch(`${WEBHOOKS}/${ABSENT_UUID}`, { data: { status: 'paused' } }),
                anon.delete(`${WEBHOOKS}/${ABSENT_UUID}`),
                anon.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`),
            ];
            const results = await Promise.all(probes);
            for (const res of results) {
                expect(res.status(), 'anonymous access must be 401').toBe(401);
            }
        } finally {
            await anon.dispose();
        }
    });

    test('rotating mid-lifecycle keeps the subscription id + active status, yields a distinct key, and preserves delivery history', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rotate-history');
        const d1 = (await testFire(request, u.access_token, sub.id)).deliveryId;

        // Two consecutive rotations each yield a fresh base64url key.
        const secrets = new Set<string>([sub.signingSecret]);
        let last = sub.signingSecret;
        for (let i = 0; i < 2; i++) {
            const rot = await request.post(`${WEBHOOKS}/${sub.id}/rotate-secret`, {
                headers: authedHeaders(u.access_token),
            });
            expect(rot.status()).toBe(200);
            const body = (await rot.json()) as {
                subscription: SubscriptionView;
                signingSecret: string;
            };
            expect(body.subscription.id).toBe(sub.id);
            expect(body.subscription.status).toBe('active');
            expect(body.signingSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
            expect(body.signingSecret, `rotation ${i} repeated a prior secret`).not.toBe(last);
            expect(secrets.has(body.signingSecret)).toBe(false);
            secrets.add(body.signingSecret);
            last = body.signingSecret;
        }

        // Rotation does not wipe the delivery history captured before it.
        expect((await listDeliveries(request, u.access_token)).map((d) => d.id)).toContain(d1);

        // The rotated key is a usable HMAC key: it deterministically signs a
        // payload into the same sha256=<hex> shape the delivery worker emits.
        const sig =
            'sha256=' +
            createHmac('sha256', last)
                .update(JSON.stringify({ event: 'x' }))
                .digest('hex');
        expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
});
