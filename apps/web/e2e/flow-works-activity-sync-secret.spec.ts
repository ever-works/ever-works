import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-activity-sync-secret.spec.ts — the per-Work Activity-Feed
 * "pull transport" HMAC secret ROTATION endpoint, end-to-end:
 *
 *   POST /api/works/:id/activity-sync/rotate-secret
 *     (apps/api/src/works/works.controller.ts -> rotateActivitySyncSecret)
 *
 * Server flow (read from the controller, NOT guessed):
 *   1. workOwnershipService.ensureAccess(id, userId)  — runs FIRST, so the
 *      authz gate fires BEFORE existence/mode are even considered.
 *      (work-ownership.service.ts: missing work -> NotFoundException(404);
 *       non-creator with no membership row -> ForbiddenException(403).)
 *   2. workRepository.findById(id) — 404 NotFound when null.
 *   3. work.activitySyncMode !== 'pull' -> ConflictException(409)
 *      { error:'mode-mismatch', mode, message }.
 *   4. platformSyncSecretService.rotate(id) — on success returns
 *      { status:'success', redeployRequired:true }. The new secret is
 *      persisted AES-256-GCM-ENCRYPTED on the Work row
 *      (work.platformSyncSecretEncrypted) and is DELIBERATELY NOT echoed in
 *      the HTTP response — it only reaches the deployed site at the next
 *      deploy, hence `redeployRequired:true`. A rotate() failure (e.g. a
 *      missing PLATFORM_ENCRYPTION_KEY) is caught and re-thrown as a 409
 *      { error:'rotation-unavailable' } so the contract stays < 500.
 *
 * GROUND TRUTH — every status / body shape below was LIVE-PROBED with curl
 * against the running sqlite-in-memory CI driver (http://127.0.0.1:3100,
 * REQUIRE_EMAIL_VERIFICATION off, throttles raised, keyless) on 2026-06-12,
 * BEFORE any assertion. Probed matrix:
 *   - unauth POST                       -> 401
 *   - POST with a garbage bearer token  -> 401
 *   - GET (wrong verb, route unregistered) -> 404
 *   - own PULL-mode work (the default!) -> 200 {status:'success',redeployRequired:true}
 *   - repeat rotation on same work      -> 200 / 200 (idempotent, same body)
 *   - foreign work (user B -> user A's) -> 403 {status:'error',message:'You do not have permission...'}
 *   - nonexistent work id               -> 404 {status:'error',message:"Work with id '...' not found"}
 *   - PUSH-mode work (set via PATCH)    -> 409 {error:'mode-mismatch',mode:'push',message:...}
 *   - response body                     -> NEVER contains the secret; only {status,redeployRequired}
 *
 * KEY PROBED FACT: a freshly-created Work defaults to activitySyncMode='pull',
 * so the HAPPY PATH is reachable on the keyless CI stack with NO git remote —
 * the secret persists encrypted on the row; rotation does NOT require a deploy
 * or any external service to succeed.
 *
 * NON-DUPLICATION — work-schedule.spec.ts already pins two SHALLOW cases of
 * this endpoint: (a) unauth-on-a-fake-id -> 401, and (b) own-work responds
 * < 500. webhook-secret-rotation.spec.ts pins the ADJACENT github-app
 * rotate-secret surface (a different endpoint family) for the no-hash-leak
 * pattern. This file pins the GAPS neither covers: the exact 200 success
 * SHAPE, the secret-non-echo SAFETY contract on the real success body, the
 * cross-user 403 (IDOR) authz gate, the nonexistent-work 404, the push-mode
 * 409 mode-mismatch typed error, repeated-rotation idempotency, and the
 * garbage-token / wrong-verb negatives. It reuses the api.ts helpers and the
 * header-comment style (PROBED CONTRACTS) per house rules.
 */

const ROTATE_PATH = (id: string) => `${API_BASE}/api/works/${id}/activity-sync/rotate-secret`;

// A long base64/hex blob that would look like a raw signing secret if echoed.
// Matches 32+ contiguous secret-shaped chars (base64url or hex).
const SECRET_SHAPED = /[A-Za-z0-9+/_-]{32,}={0,2}/;

test.describe('Works activity-sync rotate-secret — auth + negatives', () => {
    test('unauth POST -> 401', async ({ request }) => {
        const res = await request.post(ROTATE_PATH('any-id'));
        expect(res.status()).toBe(401);
    });

    test('POST with a garbage bearer token -> 401', async ({ request }) => {
        const res = await request.post(ROTATE_PATH('any-id'), {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(res.status()).toBe(401);
    });

    test('wrong verb (GET) on the rotate route -> 404 (route is POST-only)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-verb-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        const res = await request.get(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(404);
    });

    test('nonexistent work id -> 404 with typed not-found message', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(ROTATE_PATH('does-not-exist-xyz'), {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body).toMatchObject({ status: 'error' });
        expect(String(body.message)).toContain('not found');
    });
});

test.describe('Works activity-sync rotate-secret — success contract', () => {
    test('own pull-mode work (default) -> 200 {status:success, redeployRequired:true}', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-ok-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        const res = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: 'success', redeployRequired: true });
    });

    test('success body does NOT echo the rotated secret (no secret-shaped blob)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-noecho-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        const res = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const raw = await res.text();
        // The contract is deliberately secret-LESS: the new value persists
        // AES-256-GCM-encrypted on the row and reaches the site only at the
        // next deploy. So the body must carry NO long secret-shaped token,
        // and must NOT carry the encrypted-column name or any 'secret' key.
        expect(raw).not.toMatch(SECRET_SHAPED);
        expect(raw.toLowerCase()).not.toContain('platformsyncsecret');
        expect(raw.toLowerCase()).not.toContain('encrypted');
        const body = JSON.parse(raw) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['redeployRequired', 'status']);
    });

    test('repeated rotation is idempotent — same 200 body each call', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-idem-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        const first = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        const second = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(first.status()).toBe(200);
        expect(second.status()).toBe(200);
        const a = await first.json();
        const b = await second.json();
        expect(a).toEqual({ status: 'success', redeployRequired: true });
        expect(b).toEqual(a);
    });
});

test.describe('Works activity-sync rotate-secret — authz + mode gates', () => {
    test('foreign work rotate (IDOR) -> 403, never leaks success', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `e2e-asrs-idor-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        const attacker = await registerUserViaAPI(request);
        const res = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(attacker.access_token),
        });
        // ensureAccess() denies a non-member non-creator with 403 BEFORE the
        // mode/existence checks. Must not be 200 (would mean a foreign rotate).
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body).toMatchObject({ status: 'error' });
        expect(String(body.message).toLowerCase()).toContain('permission');
    });

    test('push-mode work -> 409 mode-mismatch typed error', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-push-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        // Flip the Work out of the default pull transport.
        const patch = await request.patch(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(u.access_token),
            data: { activitySyncMode: 'push' },
        });
        expect(patch.status()).toBe(200);

        const res = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(409);
        const body = await res.json();
        expect(body).toMatchObject({ error: 'mode-mismatch', mode: 'push' });
        expect(String(body.message)).toContain('pull-mode');
        // 409 path must ALSO not echo a secret-shaped blob.
        expect(JSON.stringify(body)).not.toMatch(SECRET_SHAPED);
    });

    test('rotation on push-mode does not mutate to success on retry (stable 409)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-asrs-push2-${test.info().workerIndex}-${Date.now().toString(36)}`,
        });
        await request.patch(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(u.access_token),
            data: { activitySyncMode: 'push' },
        });
        const first = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        const second = await request.post(ROTATE_PATH(work.id), {
            headers: authedHeaders(u.access_token),
        });
        expect(first.status()).toBe(409);
        expect(second.status()).toBe(409);
    });
});
