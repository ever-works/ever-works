import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook delivery-side DEEP coverage — `/api/webhooks` (outbound
 * subscriptions + the `webhook_deliveries` read/replay surface).
 *
 * This file owns the delivery-RECORD and pause/resume LIFECYCLE contracts
 * that the existing webhook specs deliberately leave uncovered. Every
 * status / body / field below was probed against the LIVE sqlite e2e API
 * (port 3100, NODE_ENV=production web / API in local-env URL mode) with
 * throwaway users before being asserted.
 *
 * PROBED CONTRACTS (live-verified):
 *   POST /api/webhooks { url } → 201 { subscription:{ id, accountId, workId:null,
 *        url, status:'active', consecutiveFailures:0, lastDeliveryAt:null,
 *        createdAt, updatedAt }, signingSecret }.
 *   POST /api/webhooks/:id/test → 200 { deliveryId, outcome, status:null, ok:false }
 *        for an unreachable receiver; outcome ∈ the documented bucket set,
 *        never 'success'.
 *   GET  /api/webhooks/deliveries → 200 { deliveries:[ FULL delivery view ] }
 *        ordered MOST-RECENT-FIRST. Each row:
 *        { id, subscriptionId, event, status:'failed', attempts:1,
 *          lastResponseStatus:null, lastOutcome:<bucket>, lastError:<string>,
 *          durationMs:<number>, triggerRunId:null, lastAttemptAt, createdAt,
 *          updatedAt }. status is one of pending|delivered|failed|retrying;
 *        for an unreachable receiver it settles to 'failed' with attempts>=1.
 *   POST /api/webhooks/deliveries/:id/redeliver → 202 { deliveryId:<NEW>,
 *        enqueued:true, runId:null } and the new row REUSES the original
 *        `event` name (webhook.test) — not a fresh producer event.
 *   POST /api/webhooks/deliveries/<absent-uuid>/redeliver → 404
 *        { message:'Webhook delivery not found' } (NOT 5xx; mirrors the
 *        subscription enumeration cover).
 *   PATCH /api/webhooks/:id { status:'active' } → 400
 *        'Resuming a paused subscription is not supported yet; recreate the
 *        subscription' (resume is intentionally a hard 400, not a no-op).
 *   PATCH /api/webhooks/:id {} (empty) → 400 'status must be one of: paused'.
 *   PATCH /api/webhooks/:id { status:'deleted' } → 400 DTO array message
 *        ['status must be one of the following values: paused, active'].
 *   PATCH /api/webhooks/:id { status:'paused' } → 200 view status:'paused';
 *        the paused row then DISAPPEARS from GET /api/webhooks (the list is
 *        active-only) yet rotate-secret (200) / test-fire (200) / delete (204)
 *        still resolve it — findOwn is NOT status-gated, only the LIST is.
 *
 * NON-DUPLICATION — read FIRST, NOT re-pinned here:
 *   - sec-pin-webhook-ownership.spec.ts owns the WRITE-side ownership matrix
 *     (workId binding gate, findOwn 404-mask on PATCH/DELETE/rotate/test,
 *     delete lifecycle, the create/list secret-hygiene field set).
 *   - flow-work-webhook-signatures.spec.ts owns the HMAC signing-secret
 *     contract (secret is a real HMAC key, rotation changes the signature,
 *     rotation uniqueness, payload-bound signatures) + the inbound github-app
 *     receiver + the cross-account 404 matrix on rotate/test/delete.
 *   - webhook-delivery-retry.spec.ts owns the test-fire → bucket → "row shows
 *     up in listing (id/subscriptionId)" probe and the bogus-URL/SSRF create
 *     gate. It does NOT assert the full delivery-VIEW field set/types, the
 *     ordering, or the redeliver-event-reuse.
 *   - webhook-redelivery.spec.ts owns "redeliver returns 202 + a DIFFERENT
 *     deliveryId" and "bogus id is 4xx". It does NOT pin the 404 message,
 *     event-name reuse, or that the redelivered row lists.
 *   - webhook-secret-rotation.spec.ts probes the github-app rotate path (a
 *     DIFFERENT surface) for hash-leak safety — unrelated to /api/webhooks.
 *   This file therefore owns: the delivery-VIEW record contract, the
 *   pause/resume PATCH branch matrix, the active-only-list vs verbs-still-
 *   resolve invariant, and the redeliver event-reuse + 404-message.
 *
 * ISOLATION: every mutation test registers a FRESH user via
 * registerUserViaAPI; URLs carry a per-test unique suffix (test-title +
 * per-test counter, no module-scope clock). Throttles are per-USER buckets
 * (create 10/min, test/rotate 5/min, patch 20/min, redeliver 10/min) so
 * fresh-user-per-test stays far under every limit. All assertions are
 * API-contract level — no UI navigation. Receivers are unreachable hosts so
 * NO real outbound delivery is required (keyless / no-Redis CI safe); we
 * assert the RECORD + bucket, never live delivery.
 */

const WEBHOOKS = `${API_BASE}/api/webhooks`;
const DELIVERIES = `${WEBHOOKS}/deliveries`;

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

/** Per-test monotonic counter — unique URL suffixes without a module-scope clock. */
let seq = 0;
function uniqUrl(tag: string): string {
    seq += 1;
    return `https://webhook.invalid.ever.works/${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSubscription(
    request: APIRequestContext,
    token: string,
    tag: string,
): Promise<{ id: string; signingSecret: string }> {
    const res = await request.post(WEBHOOKS, {
        headers: authedHeaders(token),
        data: { url: uniqUrl(tag) },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
        subscription: { id: string; status: string };
        signingSecret: string;
    };
    expect(body.subscription.status).toBe('active');
    return { id: body.subscription.id, signingSecret: body.signingSecret };
}

async function testFire(
    request: APIRequestContext,
    token: string,
    subId: string,
): Promise<{ deliveryId: string; outcome: string; ok: boolean }> {
    const res = await request.post(`${WEBHOOKS}/${subId}/test`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

async function listDeliveries(request: APIRequestContext, token: string): Promise<DeliveryView[]> {
    const res = await request.get(DELIVERIES, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { deliveries: DeliveryView[] };
    expect(Array.isArray(body.deliveries)).toBe(true);
    return body.deliveries;
}

test.describe('Webhook deliveries — delivery RECORD contract', () => {
    test('test-fire delivery row carries the full delivery-view field set with correct types', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rec-shape');
        const fire = await testFire(request, u.access_token, sub.id);

        // The inline fire result contract: unreachable receiver ⇒ documented
        // non-success bucket, ok=false, no upstream HTTP status.
        expect(DELIVERY_OUTCOMES.has(fire.outcome)).toBe(true);
        expect(fire.outcome).not.toBe('success');
        expect(fire.ok).toBe(false);

        const rows = await listDeliveries(request, u.access_token);
        const row = rows.find((d) => d.id === fire.deliveryId);
        expect(row, 'test-fire delivery missing from listing').toBeTruthy();

        // Field SET — exact keys, no extra/secret material leaks into the row.
        expect(Object.keys(row as object).sort()).toEqual(
            [
                'attempts',
                'createdAt',
                'durationMs',
                'event',
                'id',
                'lastAttemptAt',
                'lastError',
                'lastOutcome',
                'lastResponseStatus',
                'status',
                'subscriptionId',
                'triggerRunId',
                'updatedAt',
            ].sort(),
        );

        // Field TYPES + the recorded values for an unreachable test fire.
        expect(row!.subscriptionId).toBe(sub.id);
        expect(row!.event).toBe('webhook.test');
        expect(DELIVERY_STATUSES.has(row!.status)).toBe(true);
        expect(typeof row!.attempts).toBe('number');
        expect(row!.attempts).toBeGreaterThanOrEqual(1);
        // Unreachable receiver: no upstream HTTP status, no Trigger run (in-process).
        expect(row!.lastResponseStatus).toBeNull();
        expect(row!.triggerRunId).toBeNull();
        // The settled bucket is recorded on both lastOutcome and lastError.
        expect(DELIVERY_OUTCOMES.has(row!.lastOutcome as string)).toBe(true);
        expect(typeof row!.lastError).toBe('string');
        expect(typeof row!.durationMs).toBe('number');
        expect(row!.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof row!.createdAt).toBe('string');
        expect(typeof row!.updatedAt).toBe('string');
    });

    test('an unreachable receiver settles the delivery to a terminal failed state with attempts recorded', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rec-failed');
        const fire = await testFire(request, u.access_token, sub.id);

        // dispatchTestFire awaits the orchestrator, so by the time the 200
        // returns the row is already settled — no polling needed.
        const rows = await listDeliveries(request, u.access_token);
        const row = rows.find((d) => d.id === fire.deliveryId);
        expect(row).toBeTruthy();
        expect(row!.status).toBe('failed');
        expect(row!.attempts).toBeGreaterThanOrEqual(1);
        expect(row!.lastAttemptAt, 'a settled attempt must stamp lastAttemptAt').not.toBeNull();
    });

    test('deliveries listing is ordered most-recent-first across multiple fires', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rec-order');

        const first = await testFire(request, u.access_token, sub.id);
        const second = await testFire(request, u.access_token, sub.id);
        expect(first.deliveryId).not.toBe(second.deliveryId);

        const rows = await listDeliveries(request, u.access_token);
        const idxSecond = rows.findIndex((d) => d.id === second.deliveryId);
        const idxFirst = rows.findIndex((d) => d.id === first.deliveryId);
        expect(idxSecond, 'second fire missing from listing').toBeGreaterThanOrEqual(0);
        expect(idxFirst, 'first fire missing from listing').toBeGreaterThanOrEqual(0);
        // Most-recent-first: the later fire sorts ahead of the earlier one.
        expect(idxSecond).toBeLessThan(idxFirst);
    });

    test('deliveries listing is empty for a fresh account and only ever contains the caller rows', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        // Fresh account B has no deliveries.
        expect(await listDeliveries(request, b.access_token)).toHaveLength(0);

        // A fires; B's listing stays empty and A's contains exactly that row.
        const sub = await createSubscription(request, a.access_token, 'rec-scope');
        const fire = await testFire(request, a.access_token, sub.id);

        const bRows = await listDeliveries(request, b.access_token);
        expect(bRows.some((d) => d.id === fire.deliveryId)).toBe(false);

        const aRows = await listDeliveries(request, a.access_token);
        expect(aRows.map((d) => d.id)).toContain(fire.deliveryId);
    });
});

test.describe('Webhook deliveries — redeliver reuses the original event', () => {
    test('redeliver creates a fresh row that REUSES the original event name and lists', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'rd-reuse');
        const original = await testFire(request, u.access_token, sub.id);

        const res = await request.post(`${DELIVERIES}/${original.deliveryId}/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(202);
        const body = (await res.json()) as {
            deliveryId: string;
            enqueued: boolean;
            runId: string | null;
        };
        expect(body.enqueued).toBe(true);
        expect(body.deliveryId).not.toBe(original.deliveryId);
        // No Trigger.dev configured in e2e ⇒ in-process dispatch ⇒ null runId.
        expect(body.runId).toBeNull();

        const rows = await listDeliveries(request, u.access_token);
        const redelivered = rows.find((d) => d.id === body.deliveryId);
        const orig = rows.find((d) => d.id === original.deliveryId);
        expect(redelivered, 'redelivered row missing from listing').toBeTruthy();
        expect(orig, 'original row missing from listing').toBeTruthy();
        // The redelivered row reuses the ORIGINAL event + subscription — it is
        // a replay of the stored payload, not a freshly-minted producer event.
        expect(redelivered!.event).toBe(orig!.event);
        expect(redelivered!.event).toBe('webhook.test');
        expect(redelivered!.subscriptionId).toBe(sub.id);
    });

    test('redeliver of an absent (but well-formed) delivery id → 404 with the exact not-found message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        // NOT 5xx — the dispatcher masks not-found-or-not-yours and the
        // service raises a clean NotFound.
        expect(res.status()).toBe(404);
        expect(((await res.json()) as { message?: string }).message).toBe(
            'Webhook delivery not found',
        );
    });

    test('redeliver with a malformed (non-UUID) delivery id → 400 at ParseUUIDPipe', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${DELIVERIES}/not-a-uuid/redeliver`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(400);
        expect(((await res.json()) as { message?: string }).message).toBe(
            'Validation failed (uuid is expected)',
        );
    });

    test('redeliver is auth-gated — anonymous → 401', async ({ playwright }) => {
        // Fresh context — no storageState, no inherited cookies.
        const anon = await playwright.request.newContext();
        try {
            const res = await anon.post(`${DELIVERIES}/${ABSENT_UUID}/redeliver`, {});
            expect(res.status()).toBe(401);
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('Webhook subscription — pause / resume PATCH branch matrix', () => {
    test('PATCH { status:active } is a hard 400 (resume intentionally unsupported)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'patch-resume');
        const res = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'active' },
        });
        expect(res.status()).toBe(400);
        expect(((await res.json()) as { message?: string }).message).toBe(
            'Resuming a paused subscription is not supported yet; recreate the subscription',
        );
    });

    test('PATCH with an empty body → 400 "status must be one of: paused"', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'patch-empty');
        const res = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status()).toBe(400);
        expect(((await res.json()) as { message?: string }).message).toBe(
            'status must be one of: paused',
        );
    });

    test('PATCH with an unknown status enum → 400 at the DTO (array message)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'patch-enum');
        const res = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'deleted' },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { message?: string | string[] };
        // The class-validator @IsIn gate fires before the controller branch, so
        // the message is the DTO array form, distinct from the controller's
        // hand-thrown string messages above.
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.message).toContain(
            'status must be one of the following values: paused, active',
        );
    });

    test('pause removes the row from the active list, but rotate / test-fire / delete still resolve it', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'patch-lifecycle');

        // Pause → 200 view with status:'paused'.
        const paused = await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });
        expect(paused.status()).toBe(200);
        expect(((await paused.json()) as { status: string }).status).toBe('paused');

        // The list endpoint is ACTIVE-ONLY — the paused row disappears from it.
        const listRes = await request.get(WEBHOOKS, { headers: authedHeaders(u.access_token) });
        expect(listRes.status()).toBe(200);
        const subs = ((await listRes.json()) as { subscriptions: Array<{ id: string }> })
            .subscriptions;
        expect(subs.map((s) => s.id)).not.toContain(sub.id);

        // findOwn is NOT status-gated — every per-subscription verb still
        // resolves the paused row by id.
        const rotate = await request.post(`${WEBHOOKS}/${sub.id}/rotate-secret`, {
            headers: authedHeaders(u.access_token),
        });
        expect(rotate.status()).toBe(200);
        const rotateBody = (await rotate.json()) as {
            subscription: { id: string; status: string };
            signingSecret: string;
        };
        expect(rotateBody.subscription.id).toBe(sub.id);
        // Rotation does not silently resurrect a paused subscription.
        expect(rotateBody.subscription.status).toBe('paused');
        expect(typeof rotateBody.signingSecret).toBe('string');

        const fire = await request.post(`${WEBHOOKS}/${sub.id}/test`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fire.status()).toBe(200);
        const fireBody = (await fire.json()) as { outcome: string; ok: boolean };
        expect(DELIVERY_OUTCOMES.has(fireBody.outcome)).toBe(true);
        expect(fireBody.outcome).not.toBe('success');

        const del = await request.delete(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(204);
    });

    test('test-fire against a PAUSED subscription still records a delivery row in the listing', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const sub = await createSubscription(request, u.access_token, 'patch-paused-fire');
        await request.patch(`${WEBHOOKS}/${sub.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'paused' },
        });

        const fire = await testFire(request, u.access_token, sub.id);
        const rows = await listDeliveries(request, u.access_token);
        const row = rows.find((d) => d.id === fire.deliveryId);
        expect(row, 'paused-subscription test-fire must still record a delivery').toBeTruthy();
        expect(row!.subscriptionId).toBe(sub.id);
        expect(row!.event).toBe('webhook.test');
    });
});
