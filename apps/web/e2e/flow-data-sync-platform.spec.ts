import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Data-sync + platform-sync — real multi-step API orchestration (EW-628 / EW-120).
 *
 * Drives the live data-repo instant-sync surface and the platform-secret
 * ingest / webhook-secret rotation surfaces end-to-end. Every shape below
 * was probed against the running API before being asserted.
 *
 * The assigned theme talks about a "dispatch tick" with a
 * `{ due, dispatched, skipped, failed }` shape — that summary
 * (`DataSyncDispatchSummary`) is produced by `DataSyncDispatcherService.dispatchDue`,
 * which is an INTERNAL cron-only service with NO HTTP route. The real public
 * surface that exercises the same three-gate machinery and surfaces the same
 * per-Work outcomes (dispatched / skipped / failed) is the operator force-sync
 * endpoint `POST /api/works/:id/sync` (Phase 6, AC-10). We orchestrate that
 * endpoint and verify the recorded outcome in the activity feed — the same
 * observable artifact the dispatcher would have produced.
 *
 * Verified live behaviour (throwaway users, sqlite in-memory):
 *
 *   Flow 1 — force-sync outcome envelope + activity-feed record
 *     POST /api/works/:id/sync on an owned Work with NO connected git account
 *       -> 202 { status: 'failed', errorClass: 'unknown',
 *                errorTail: 'No connected account found for user ... with provider github' }
 *     -> records a `data_sync_failed` activity row (action 'data-sync.failed',
 *        status 'failed', summary 'Sync failed: unknown', details.kind 'failed',
 *        details.source 'manual').
 *     Access gates (probed):
 *       - non-owner       -> 403 { status: 'error', message: 'You do not have permission to sync this work' }
 *       - unauthenticated -> 401 { message: 'Unauthorized', statusCode: 401 }
 *       - unknown work id -> 404 { status: 'error', message: 'Work not found' }
 *
 *   Flow 2 — idempotency / duplicate-suppression (retry-backoff gate)
 *     A first failing dispatch writes the `data-sync:retry-after:<workId>` cache
 *     key. A second dispatch in the same window is SUPPRESSED at gate 1:
 *       -> 202 { status: 'skipped', reason: 'retry-backoff' }
 *     This is the real de-dup contract: re-dispatching the same Work does not
 *     re-run the render while a recent attempt is still backing off.
 *
 *   Flow 3 — platform-sync secret rotate + platform-secret ingest gate
 *     Gated by PLATFORM_ENCRYPTION_KEY (webhook secret envelope) and
 *     PLATFORM_API_SECRET_TOKEN (ingest bearer), both set in the e2e API env.
 *     - POST /api/webhooks                      -> 201 { subscription, signingSecret } (raw secret, once)
 *     - POST /api/webhooks/:id/rotate-secret     -> 200 { subscription, signingSecret } (NEW secret; previous irretrievable)
 *     - rotate on a non-uuid id                  -> 400 'Validation failed (uuid is expected)'
 *     - rotate on an unknown uuid                -> 404 'Webhook subscription not found'
 *     - POST /api/activity-log/ingest (no token) -> 401 'Missing Bearer token'
 *     - ... (wrong token)                        -> 401 'Invalid bearer token'
 *     - ... (correct token, pull-mode Work)      -> 409 { error: 'mode-mismatch', mode: 'pull', message }
 *     - ... (correct token, unknown Work)        -> 404 'Work <id> not found'
 *
 * All mutations run on FRESH registered API users (never the shared seeded UI
 * user) so the in-memory DB stays clean for sibling specs, and assertions use
 * generous timeouts + tolerant matchers.
 */

// The platform-wide ingest bearer — pinned deterministically in the e2e API
// env (apps/api/.env). The PlatformSecretGuard compares against
// process.env.PLATFORM_API_SECRET_TOKEN with timingSafeEqual.
const PLATFORM_API_SECRET_TOKEN = 'e2e-platform-secret-token-deterministic-32+chars';

const WEBSITE_ACTION = 'website_user_registered';

function uuid(): string {
    // Web Crypto is available in the Playwright (Node) test runtime.
    return globalThis.crypto.randomUUID();
}

/** Build a minimally-valid ingest payload for a given Work. */
function ingestPayload(workId: string, eventId = uuid()) {
    return {
        workId,
        eventId,
        actionType: WEBSITE_ACTION,
        occurredAt: new Date().toISOString(),
        summary: 'e2e platform-sync ingest probe',
    };
}

test.describe('Data-sync — force-sync dispatch outcome + recorded activity', () => {
    test('owned Work dispatch surfaces the three-gate outcome envelope and records a data_sync activity row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Data Sync Dispatch ${Date.now()}`,
        });
        expect(work.id, 'created work should expose an id').toBeTruthy();

        // Dispatch: same code path the cron dispatcher fans out into. With no
        // connected git account the render gate (gate 3) throws and the service
        // converts it into a terminal `failed` outcome — the endpoint still
        // returns 202 ACCEPTED (the run was accepted, then failed inside the
        // lock). This is exactly one of the per-Work outcomes the dispatch tick
        // counts in its { dispatched, skipped, failed } summary.
        const res = await request.post(`${API_BASE}/api/works/${work.id}/sync`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), `force-sync body=${await res.text().catch(() => '')}`).toBe(202);
        const body = await res.json();

        // The public envelope is a discriminated union keyed on `status`:
        //   'enqueued' (success) | 'skipped' (gate reason) | 'failed' (errorClass)
        expect(['enqueued', 'skipped', 'failed']).toContain(body.status);

        // In the CI / no-git-account environment the render gate fails with a
        // stable low-cardinality errorClass and an errorTail naming the missing
        // git account. Assert the truthful platform behaviour rather than a
        // success we cannot reach without a real GitHub connection.
        if (body.status === 'failed') {
            expect(typeof body.errorClass).toBe('string');
            expect(body.errorClass.length).toBeGreaterThan(0);
            expect(typeof body.errorTail).toBe('string');
            // The seeded user has no connected git provider in e2e.
            expect(body.errorTail).toMatch(/No connected account|github|not found/i);
        } else if (body.status === 'skipped') {
            // A residual gate from a prior run in the shared DB is acceptable.
            expect(typeof body.reason).toBe('string');
        } else {
            // Unexpected-but-valid happy path (a git account WAS connected).
            expect(body).toMatchObject({ status: 'enqueued', outcome: 'success' });
            expect(body).toHaveProperty('stats');
        }

        // Observable outcome: the dispatch wrote a `data_sync_*` activity row
        // scoped to this Work, with source 'manual' (the force-sync transport).
        const feedRow = await expect
            .poll(
                async () => {
                    const r = await request.get(`${API_BASE}/api/activity-log?workId=${work.id}`, {
                        headers: authedHeaders(owner.access_token),
                    });
                    if (!r.ok()) return undefined;
                    const json = await r.json();
                    return (json.activities ?? []).find(
                        (a: { actionType?: string; action?: string }) =>
                            (a.actionType ?? '').startsWith('data_sync_') ||
                            (a.action ?? '').startsWith('data-sync.'),
                    );
                },
                {
                    timeout: 20_000,
                    message: 'force-sync should record a data_sync_* activity row for the Work',
                },
            )
            .toBeTruthy();
        void feedRow;

        // Re-read once more (outside the poll) to make concrete assertions on
        // the recorded row's shape.
        const listRes = await request.get(`${API_BASE}/api/activity-log?workId=${work.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const list = await listRes.json();
        const dataSyncRow = (list.activities ?? []).find((a: { actionType?: string }) =>
            (a.actionType ?? '').startsWith('data_sync_'),
        );
        expect(dataSyncRow, 'a data_sync_* row should be present in the feed').toBeTruthy();
        // The action namespace + the typed details payload are the contract the
        // web SyncEventRow renderer consumes.
        expect(dataSyncRow.action).toMatch(/^data-sync\./);
        expect(['success', 'skipped', 'failed']).toContain(dataSyncRow.details?.kind);
        expect(dataSyncRow.details?.source).toBe('manual');
    });

    test('access gates: non-owner 403, unauthenticated 401, unknown work 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Data Sync Gates ${Date.now()}`,
        });

        // Non-owner -> 403 with the stable ownership message (the controller
        // gates ownership before delegating to the service so a stranger can't
        // even learn the Work exists via a 2xx).
        const forbidden = await request.post(`${API_BASE}/api/works/${work.id}/sync`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(forbidden.status()).toBe(403);
        const forbiddenBody = await forbidden.json();
        expect(forbiddenBody).toMatchObject({ status: 'error' });
        expect(forbiddenBody.message).toMatch(/do not have permission/i);

        // Unauthenticated -> 401 (global JWT guard).
        const unauth = await request.post(`${API_BASE}/api/works/${work.id}/sync`);
        expect(unauth.status()).toBe(401);

        // Unknown work id -> 404 with the stable not-found envelope.
        const missing = await request.post(
            `${API_BASE}/api/works/00000000-0000-0000-0000-000000000000/sync`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(missing.status()).toBe(404);
        const missingBody = await missing.json();
        expect(missingBody).toMatchObject({ status: 'error' });
        expect(missingBody.message).toMatch(/not found/i);
    });
});

test.describe('Data-sync — idempotency / duplicate-suppression (retry-backoff gate)', () => {
    test('re-dispatching the same Work within the backoff window is suppressed', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Data Sync Idempotency ${Date.now()}`,
        });

        const dispatch = () =>
            request.post(`${API_BASE}/api/works/${work.id}/sync`, {
                headers: authedHeaders(owner.access_token),
            });

        // First dispatch: render gate runs (and fails, with no connected git
        // account), which writes the `data-sync:retry-after:<workId>` cache key.
        const first = await dispatch();
        expect(first.status()).toBe(202);
        const firstBody = await first.json();
        // The first attempt actively ran a gate (not pre-suppressed). It is
        // either 'failed' (render gate threw) or — if a residual backoff from a
        // prior shared-DB run is still live — already 'skipped'. Either way it
        // is a valid terminal outcome and we proceed to assert suppression.
        expect(['failed', 'skipped', 'enqueued']).toContain(firstBody.status);

        // Second dispatch in the same window MUST be suppressed at gate 1
        // (retry-backoff). This is the duplicate-suppression contract: a freshly
        // re-dispatched Work does not re-run the render while a recent attempt
        // is still backing off. Poll because the cache write from the first
        // attempt settles asynchronously.
        await expect
            .poll(
                async () => {
                    const r = await dispatch();
                    if (r.status() !== 202) return `http-${r.status()}`;
                    const b = await r.json();
                    return b.status === 'skipped' ? b.reason : `not-skipped:${b.status}`;
                },
                {
                    timeout: 20_000,
                    message:
                        'a duplicate dispatch in the backoff window should be skipped with reason retry-backoff',
                },
            )
            .toBe('retry-backoff');

        // The suppressed duplicate is also recorded as a skipped row in the feed
        // (source 'manual', reason 'retry-backoff') — the truthful observable
        // artifact of a de-duplicated dispatch.
        const listRes = await request.get(`${API_BASE}/api/activity-log?workId=${work.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const list = await listRes.json();
        const skippedRow = (list.activities ?? []).find(
            (a: { actionType?: string; details?: { reason?: string } }) =>
                a.actionType === 'data_sync_skipped' && a.details?.reason === 'retry-backoff',
        );
        expect(
            skippedRow,
            'a data_sync_skipped row with reason retry-backoff should record the suppressed duplicate',
        ).toBeTruthy();
        expect(skippedRow.details?.source).toBe('manual');
    });
});

test.describe('Platform sync — webhook secret rotate + platform-secret ingest gate', () => {
    test('rotate-secret issues a fresh signing secret and gates by subscription id', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        // Create a subscription — the RAW signing secret is returned ONCE here.
        const createRes = await request.post(`${API_BASE}/api/webhooks`, {
            headers: authedHeaders(owner.access_token),
            data: { url: 'https://webhook.site/e2e-data-sync-platform' },
        });
        expect(createRes.status(), `create body=${await createRes.text().catch(() => '')}`).toBe(
            201,
        );
        const created = await createRes.json();
        expect(created.subscription?.id, 'create should return a subscription id').toBeTruthy();
        expect(created.subscription.status).toBe('active');
        expect(typeof created.signingSecret).toBe('string');
        expect(created.signingSecret.length).toBeGreaterThan(20);
        const subId: string = created.subscription.id;
        const firstSecret: string = created.signingSecret;

        // Rotate -> 200 with a NEW raw secret. The previous one is irretrievable.
        const rotateRes = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(rotateRes.status(), `rotate body=${await rotateRes.text().catch(() => '')}`).toBe(
            200,
        );
        const rotated = await rotateRes.json();
        expect(rotated.subscription?.id).toBe(subId);
        expect(typeof rotated.signingSecret).toBe('string');
        expect(rotated.signingSecret.length).toBeGreaterThan(20);
        // The rotation actually changed the secret (the encryption is keyed by
        // PLATFORM_ENCRYPTION_KEY; the raw value is freshly generated each time).
        expect(rotated.signingSecret).not.toBe(firstSecret);

        // A second rotation produces yet another distinct secret.
        const rotateAgainRes = await request.post(
            `${API_BASE}/api/webhooks/${subId}/rotate-secret`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(rotateAgainRes.status()).toBe(200);
        const rotatedAgain = await rotateAgainRes.json();
        expect(rotatedAgain.signingSecret).not.toBe(rotated.signingSecret);

        // Rotating a non-uuid id is rejected by ParseUUIDPipe (400).
        const badId = await request.post(`${API_BASE}/api/webhooks/not-a-uuid/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(badId.status()).toBe(400);
        expect((await badId.json()).message).toMatch(/uuid is expected/i);

        // Rotating an unknown (well-formed) uuid is masked as 404 — same
        // enumeration-defense as cross-account access.
        const unknownId = await request.post(
            `${API_BASE}/api/webhooks/00000000-0000-0000-0000-000000000000/rotate-secret`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknownId.status()).toBe(404);
        expect((await unknownId.json()).message).toMatch(/not found/i);

        // Cross-account rotation is also masked as 404 (stranger cannot tell the
        // subscription exists).
        const stranger = await registerUserViaAPI(request);
        const crossAccount = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(crossAccount.status()).toBe(404);
    });

    test('platform-secret ingest: 401 without/with wrong token, then documented 409 / 404 with the real token', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Platform Ingest ${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // No bearer -> 401 'Missing Bearer token' (PlatformSecretGuard).
        const noAuth = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            data: ingestPayload(work.id),
        });
        expect(noAuth.status()).toBe(401);
        expect((await noAuth.json()).message).toMatch(/missing bearer token/i);

        // Wrong bearer -> 401 'Invalid bearer token'.
        const wrongAuth = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: 'Bearer definitely-not-the-platform-token' },
            data: ingestPayload(work.id),
        });
        expect(wrongAuth.status()).toBe(401);
        expect((await wrongAuth.json()).message).toMatch(/invalid bearer token/i);

        // Correct bearer + a pull-mode Work (the default) -> the documented 409
        // mode-mismatch. The ingest endpoint only accepts push-mode events; a
        // freshly-created Work defaults to activitySyncMode 'pull'.
        const eventId = uuid();
        const modeMismatch = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
            data: ingestPayload(work.id, eventId),
        });
        expect(
            modeMismatch.status(),
            `ingest body=${await modeMismatch.text().catch(() => '')}`,
        ).toBe(409);
        const mismatchBody = await modeMismatch.json();
        expect(mismatchBody).toMatchObject({ error: 'mode-mismatch', mode: 'pull' });
        expect(mismatchBody.message).toMatch(/push-mode/i);

        // The mode gate runs BEFORE the (workId, eventId) idempotency write, so
        // replaying the SAME eventId for the same pull-mode Work stays a 409 —
        // no row is created and the idempotency contract is never reached for a
        // non-push Work. Asserting the replay confirms the gate ordering.
        const replay = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
            data: ingestPayload(work.id, eventId),
        });
        expect(replay.status()).toBe(409);
        expect(await replay.json()).toMatchObject({ error: 'mode-mismatch' });

        // Correct bearer + unknown Work -> 404 (checked before the mode gate).
        const unknownWork = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
            data: ingestPayload('00000000-0000-0000-0000-000000000000'),
        });
        expect(unknownWork.status()).toBe(404);
        expect((await unknownWork.json()).message).toMatch(/not found/i);

        // Correct bearer + invalid actionType -> 400 with the enum message
        // (DTO validation runs at the pipe before the controller body).
        const badAction = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
            data: { ...ingestPayload(work.id), actionType: 'not_a_real_action' },
        });
        expect(badAction.status()).toBe(400);
        const badActionBody = await badAction.json();
        const messages = Array.isArray(badActionBody.message)
            ? badActionBody.message.join(' ')
            : String(badActionBody.message);
        expect(messages).toMatch(/actionType must be one of/i);
    });
});
