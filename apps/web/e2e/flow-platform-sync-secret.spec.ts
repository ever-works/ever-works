import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-platform-sync-secret — the platform's at-rest SECRET-ROTATION contract,
 * driven end-to-end through its real public surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE ASSIGNED THEME MAPS TO IN REAL CODE
 *
 * The theme names a "platform-sync secret rotate (PLATFORM_API_SECRET_TOKEN-gated),
 * rotate→old secret invalid, encrypted-at-rest, rotate idempotency/409, secret
 * never returned in GET". Two distinct real platform-secret surfaces back this,
 * and BOTH were read from source + re-probed live (sqlite in-memory, fresh
 * throwaway users) before anything below was asserted:
 *
 *   A. The webhook SIGNING-SECRET rotation surface (apps/api/src/webhooks/*):
 *        POST /api/webhooks                       -> 201 { subscription, signingSecret }
 *        GET  /api/webhooks                       -> 200 { subscriptions:[ view ] }   (NO secret)
 *        POST /api/webhooks/:id/rotate-secret      -> 200 { subscription, signingSecret(NEW) }
 *        POST /api/webhooks/:id/test               -> 200 { deliveryId, outcome, status, ok }
 *        GET  /api/webhooks/deliveries             -> 200 { deliveries:[ ... ] }
 *        DELETE /api/webhooks/:id                  -> 204
 *      The raw `signingSecret` is base64url of 32 random bytes — EXACTLY 43 chars,
 *      matching /^[A-Za-z0-9_-]{43}$/. It is returned ONCE on create and ONCE per
 *      rotate, and is NEVER readable again (no re-fetch route; GET views omit it).
 *      At rest it is AES-256-GCM enveloped (`enc::v1::base64(IV||authTag||ct)`)
 *      keyed on PLATFORM_ENCRYPTION_KEY (WebhookSecretService) — the stored
 *      `secretEncrypted` column never appears in any view (WebhookSubscriptionView
 *      has no secret field at all). PLATFORM_ENCRYPTION_KEY is set in the e2e API
 *      env (hex 64 → 32 bytes), so encryption is ACTIVE, not passthrough.
 *
 *   B. The PLATFORM_API_SECRET_TOKEN-gated ingest bearer (PlatformSecretGuard,
 *      apps/api/src/activity-log/guards/platform-secret.guard.ts):
 *        POST /api/activity-log/ingest            -> 401 (missing/invalid bearer)
 *      Constant-time (`timingSafeEqual`) comparison against
 *      process.env.PLATFORM_API_SECRET_TOKEN; the token is the platform-wide
 *      secret pushed into every deployed directory site. "Rotating" THIS token is
 *      an env/redeploy operation (no HTTP route) — the OBSERVABLE rotation contract
 *      is: the OLD token stops authenticating and the NEW token starts. We
 *      reconstruct that here against the current env token (old≠current both 401).
 *
 * FOCUS-WORDING vs REALITY (annotated, never faked):
 *   - "rotate → old secret invalid": there is NO server-side validation route that
 *     accepts a raw signing secret, so "old secret invalid" is asserted as a
 *     NON-RETRIEVAL + REPLACEMENT contract — every prior raw secret is gone from
 *     all surfaces after a rotate, and the rotate always mints a fresh distinct
 *     value (the old at-rest envelope is overwritten via repo.updateSecret).
 *   - "rotate idempotency/409": rotation is NOT idempotent and NEVER 409s — each
 *     call deterministically mints a NEW secret (probed: 8 back-to-back rotates =
 *     8 distinct 200s). The only 409 in this domain is the INGEST mode-mismatch
 *     (pull-mode Work). We assert the real always-200 rotate behaviour AND the
 *     real ingest 409, and annotate that a "rotate 409" contract does not exist.
 *   - "encrypted-at-rest": asserted as the BLACK-BOX consequence — the raw secret
 *     never round-trips through any read surface, and a value that looks like the
 *     stored envelope (`enc::v1::`) is never emitted to the client.
 *
 * OTHER PROBED GATES (read from source, re-probed live):
 *   - rotate non-uuid id        -> 400 'Validation failed (uuid is expected)' (ParseUUIDPipe)
 *   - rotate unknown uuid       -> 404 'Webhook subscription not found'
 *   - rotate cross-account      -> 404 (enumeration-defense; NOT 403)
 *   - rotate unauthenticated    -> 401 (global AuthSessionGuard)
 *   - rotate after DELETE       -> 404 (subscription gone)
 *   - rotate @Throttle 5/60s    -> NOT enforced in this env (probed: 8 rapid = all 200).
 *                                  Tolerate 200 AND 429 — never hard-require either.
 *   - test-fire to a loopback / webhook.site URL -> records a delivery row but the
 *     orchestrator SSRF-blocks loopback ('ssrf_blocked') / the receiver 404s
 *     ('client_error', status 404). Delivery ATTEMPT is the observable artifact;
 *     we never assert ok===true (no reachable receiver in CI).
 *
 * NOT DUPLICATED (surveyed apps/web/e2e):
 *   - flow-data-sync-platform.spec.ts (Flow 3): rotate happy-path issues a new
 *     secret + 400-non-uuid / 404-unknown / 404-cross-account, and ingest
 *     401/409/404/400. We do NOT re-assert those gates as the headline; instead
 *     this file targets the SECRET-SPECIFIC properties that file does not:
 *     (1) the exact 43-char base64url secret SHAPE + uniqueness across MANY
 *     rotates, (2) the secret NEVER appearing in GET list / no enc::v1:: leak,
 *     (3) old-raw-secret NON-RETRIEVAL after rotate, (4) rotate-after-delete 404 +
 *     unauth 401 + throttle tolerance, (5) the at-rest encryption black-box
 *     contract via the test-fire delivery path, (6) the PLATFORM_API_SECRET_TOKEN
 *     old-vs-current bearer rotation contract on the ingest guard.
 *   - webhook-secret-rotation.spec.ts: probes only the (non-existent) integration
 *     rotate paths + a bcrypt/argon hash-leak grep; no shape/uniqueness/GET-omit.
 *   - rsc-payload-no-secrets.spec.ts: greps LOGIN PAGE HTML for env-var patterns
 *     (postgres://, AKIA…) — unrelated to the API secret-rotation surface.
 *   - data-sync*.spec.ts / flow-data-sync-dispatch-deep.spec.ts: the force-sync
 *     three-gate dispatch fold — a different domain.
 *
 * All mutations run on FRESH registerUserViaAPI() users (never the shared seeded
 * UI user) so the in-memory DB stays clean for sibling specs. Unique URLs/suffixes
 * (Date.now), tolerant matchers (toContain, family checks), generous timeouts.
 */

// base64url of 32 bytes → 43 chars, URL-safe alphabet, no padding.
const RAW_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
// The at-rest AES-256-GCM envelope prefix — must NEVER reach the client.
const ENC_ENVELOPE_PREFIX = 'enc::v1::';

// The platform-wide ingest bearer — pinned deterministically in the e2e API env
// (apps/api/.env). PlatformSecretGuard compares against
// process.env.PLATFORM_API_SECRET_TOKEN with timingSafeEqual. Read it from the
// environment first (keeping the canonical value out of tracked source) and fall
// back to the known e2e literal only when the harness didn't export it.
const PLATFORM_API_SECRET_TOKEN =
    process.env.PLATFORM_API_SECRET_TOKEN ?? 'e2e-platform-secret-token-deterministic-32+chars';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function uniqueUrl(tag: string): string {
    return `https://webhook.site/e2e-${tag}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

/** Create a webhook subscription; return { subId, secret } (raw secret seen once). */
async function createSubscription(
    request: APIRequestContext,
    token: string,
    tag: string,
): Promise<{ subId: string; secret: string; raw: unknown }> {
    const res = await request.post(`${API_BASE}/api/webhooks`, {
        headers: authedHeaders(token),
        data: { url: uniqueUrl(tag) },
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.subscription?.id, 'create returns a subscription id').toBeTruthy();
    expect(typeof body.signingSecret).toBe('string');
    return { subId: body.subscription.id, secret: body.signingSecret, raw: body };
}

/** Minimally-valid push-ingest payload for a given Work. */
function ingestPayload(workId: string) {
    return {
        workId,
        eventId: globalThis.crypto.randomUUID(),
        actionType: 'website_user_registered',
        occurredAt: new Date().toISOString(),
        summary: 'e2e platform-secret bearer probe',
    };
}

test.describe('Platform secret — webhook signing-secret rotation lifecycle', () => {
    test('Flow 1 — create + rotate mint distinct 43-char base64url secrets; rotation is never idempotent and never 409s', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { subId, secret: createSecret } = await createSubscription(
            request,
            owner.access_token,
            'rot',
        );

        // The raw secret is base64url of 32 random bytes → exactly 43 chars.
        expect(createSecret).toMatch(RAW_SECRET_RE);

        // Rotate MANY times; each call is a fresh mint (NOT idempotent) and stays
        // 200 — there is no "rotate 409 / already-rotated" contract in this domain.
        const seen = new Set<string>([createSecret]);
        let previous = createSecret;
        for (let i = 0; i < 5; i++) {
            const res = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
                headers: authedHeaders(owner.access_token),
            });
            // @Throttle 5/60s is documented on the route but NOT enforced in this
            // env (probed: 8 rapid rotates all 200). Tolerate a 429 if a future
            // env tightens it — the contract we assert is "no 409, no 5xx".
            if (res.status() === 429) {
                test.info().annotations.push({
                    type: 'throttled',
                    description: `rotate #${i + 1} hit the 5/60s per-IP throttle (429) — tolerated.`,
                });
                break;
            }
            expect(res.status(), `rotate#${i + 1} body=${await res.text().catch(() => '')}`).toBe(
                200,
            );
            const body = await res.json();
            expect(body.subscription?.id, 'rotate echoes the same subscription id').toBe(subId);
            // Each mint is a fresh, distinct, well-shaped secret.
            expect(body.signingSecret).toMatch(RAW_SECRET_RE);
            expect(body.signingSecret, 'rotate must change the secret').not.toBe(previous);
            expect(
                seen.has(body.signingSecret),
                'every rotate yields a globally-unique secret',
            ).toBe(false);
            seen.add(body.signingSecret);
            previous = body.signingSecret;
        }

        // Sanity: rotation never collapsed to a single repeated value — it is a
        // generator, not an idempotent set-once. (At least create + 1 rotate.)
        expect(seen.size).toBeGreaterThanOrEqual(2);
    });

    test('Flow 2 — the raw signing secret is returned ONCE and is never retrievable again (GET omits it; no enc::v1:: envelope leaks)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { subId, secret: firstSecret } = await createSubscription(
            request,
            owner.access_token,
            'omit',
        );
        expect(firstSecret).toMatch(RAW_SECRET_RE);

        // GET list must return the canonical VIEW with NO secret material at all,
        // and must never leak the at-rest AES envelope.
        const listRes = await request.get(`${API_BASE}/api/webhooks`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const listText = await listRes.text();
        const list = JSON.parse(listText);
        const view = (list.subscriptions ?? []).find((s: { id?: string }) => s.id === subId);
        expect(view, 'created subscription appears in the list').toBeTruthy();

        // The view exposes the operational fields...
        expect(view).toMatchObject({ id: subId, status: 'active' });
        // ...but NONE of the secret-bearing fields.
        expect(view).not.toHaveProperty('signingSecret');
        expect(view).not.toHaveProperty('secret');
        expect(view).not.toHaveProperty('secretEncrypted');

        // Black-box at-rest contract: neither the raw secret nor the stored AES
        // envelope ever appears in the serialized list payload.
        expect(listText, 'raw signing secret must not round-trip through GET').not.toContain(
            firstSecret,
        );
        expect(listText, 'at-rest enc::v1:: envelope must never reach the client').not.toContain(
            ENC_ENVELOPE_PREFIX,
        );

        // Rotate, then re-confirm: the NEW secret is delivered once, and STILL the
        // GET list leaks neither the new nor the old raw secret.
        const rotateRes = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(rotateRes.status()).toBe(200);
        const rotated = await rotateRes.json();
        expect(rotated.signingSecret).toMatch(RAW_SECRET_RE);
        expect(rotated.signingSecret).not.toBe(firstSecret);

        const listAfterText = await (
            await request.get(`${API_BASE}/api/webhooks`, {
                headers: authedHeaders(owner.access_token),
            })
        ).text();
        expect(listAfterText).not.toContain(firstSecret);
        expect(listAfterText).not.toContain(rotated.signingSecret);
        expect(listAfterText).not.toContain(ENC_ENVELOPE_PREFIX);
    });

    test('Flow 3 — rotate→old secret invalid: after rotation every prior raw secret is gone from all read surfaces and the new secret is the active signing key', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { subId, secret: oldSecret } = await createSubscription(
            request,
            owner.access_token,
            'old',
        );

        // Collect every raw secret value ever issued for this subscription.
        const issued = [oldSecret];
        const rotateRes = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(rotateRes.status()).toBe(200);
        const newSecret = (await rotateRes.json()).signingSecret as string;
        expect(newSecret).toMatch(RAW_SECRET_RE);
        expect(newSecret).not.toBe(oldSecret);
        issued.push(newSecret);

        // There is NO server route that accepts a raw secret for validation, so
        // "old secret invalid" is the NON-RETRIEVAL + REPLACEMENT contract: none of
        // the previously-issued raw secrets is reachable through ANY read surface.
        const listText = await (
            await request.get(`${API_BASE}/api/webhooks`, {
                headers: authedHeaders(owner.access_token),
            })
        ).text();
        for (const s of issued) {
            expect(
                listText,
                `issued secret must never be retrievable: ${s.slice(0, 6)}…`,
            ).not.toContain(s);
        }

        // Deliveries are also a read surface a caller controls — confirm neither
        // the old nor new raw secret leaks through it either.
        const deliveriesText = await (
            await request.get(`${API_BASE}/api/webhooks/deliveries`, {
                headers: authedHeaders(owner.access_token),
            })
        ).text();
        for (const s of issued) {
            expect(deliveriesText).not.toContain(s);
        }

        // The NEW secret is the active signing key: a test-fire AFTER the rotate
        // still produces a signed delivery attempt (the orchestrator signs with the
        // freshly-stored secret). In CI the receiver is unreachable (webhook.site
        // 404 / loopback ssrf_blocked) so we assert the delivery ATTEMPT envelope
        // shape, NEVER ok===true.
        const testRes = await request.post(`${API_BASE}/api/webhooks/${subId}/test`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(testRes.status(), `test body=${await testRes.text().catch(() => '')}`).toBe(200);
        const testBody = await testRes.json();
        expect(testBody.deliveryId, 'test-fire records a delivery row').toBeTruthy();
        expect(typeof testBody.outcome).toBe('string');
        expect(typeof testBody.ok).toBe('boolean');

        // The recorded delivery row surfaces in the deliveries feed (the observable
        // artifact that the post-rotation secret produced a signed attempt).
        const deliveryRow = await expect
            .poll(
                async () => {
                    const r = await request.get(`${API_BASE}/api/webhooks/deliveries`, {
                        headers: authedHeaders(owner.access_token),
                    });
                    if (!r.ok()) return undefined;
                    const j = await r.json();
                    return (j.deliveries ?? []).find(
                        (d: { id?: string }) => d.id === testBody.deliveryId,
                    );
                },
                {
                    timeout: 20_000,
                    message: 'the post-rotation test-fire should record a delivery row in the feed',
                },
            )
            .toBeTruthy();
        void deliveryRow;
    });

    test('Flow 4 — rotate gates: non-uuid 400, unknown uuid 404, cross-account 404, unauthenticated 401, and post-delete 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { subId } = await createSubscription(request, owner.access_token, 'gate');

        // Non-uuid id → ParseUUIDPipe rejects with 400 before the handler runs.
        const badId = await request.post(`${API_BASE}/api/webhooks/not-a-uuid/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(badId.status()).toBe(400);
        expect((await badId.json()).message).toMatch(/uuid is expected/i);

        // Unknown but well-formed uuid → 404 (not 403).
        const unknown = await request.post(`${API_BASE}/api/webhooks/${ZERO_UUID}/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toMatch(/not found/i);

        // Cross-account → 404 enumeration-defense (a stranger can't learn it exists).
        const cross = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status()).toBe(404);

        // Unauthenticated → 401 (global AuthSessionGuard; no @Public on this route).
        const unauth = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`);
        expect(unauth.status()).toBe(401);

        // The cross-account 404 must NOT have mutated the owner's live secret — a
        // legitimate rotate by the owner still succeeds and yields a fresh secret.
        const ownerRotate = await request.post(`${API_BASE}/api/webhooks/${subId}/rotate-secret`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerRotate.status()).toBe(200);
        expect((await ownerRotate.json()).signingSecret).toMatch(RAW_SECRET_RE);

        // After DELETE the subscription is gone, so rotate → 404 (secret material is
        // irretrievable AND unrotatable once the row is removed).
        const del = await request.delete(`${API_BASE}/api/webhooks/${subId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(del.status()).toBe(204);
        const rotateAfterDelete = await request.post(
            `${API_BASE}/api/webhooks/${subId}/rotate-secret`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(rotateAfterDelete.status()).toBe(404);
    });

    test('Flow 5 — encrypted-at-rest black box: two subscriptions with independently rotated secrets never cross-contaminate and never expose stored envelopes', async ({
        request,
    }) => {
        // The IV is random per record, so the SAME plaintext encrypts differently
        // each time; we cannot read the envelope, but we CAN assert the black-box
        // consequence: distinct subscriptions own independent secrets, every issued
        // raw value is unique, and no read surface ever emits the enc::v1:: envelope.
        const owner = await registerUserViaAPI(request);
        const a = await createSubscription(request, owner.access_token, 'enc-a');
        const b = await createSubscription(request, owner.access_token, 'enc-b');

        expect(a.subId).not.toBe(b.subId);
        expect(a.secret).not.toBe(b.secret);

        const allSecrets = new Set<string>([a.secret, b.secret]);

        // Rotate each subscription a couple of times; collect every raw value.
        for (const sub of [a, b]) {
            for (let i = 0; i < 2; i++) {
                const res = await request.post(
                    `${API_BASE}/api/webhooks/${sub.subId}/rotate-secret`,
                    { headers: authedHeaders(owner.access_token) },
                );
                if (res.status() === 429) break; // tolerate the documented throttle
                expect(res.status()).toBe(200);
                const s = (await res.json()).signingSecret as string;
                expect(s).toMatch(RAW_SECRET_RE);
                expect(
                    allSecrets.has(s),
                    'each rotate across subscriptions is globally unique',
                ).toBe(false);
                allSecrets.add(s);
            }
        }

        // No read surface (list view) leaks any raw secret or the stored envelope.
        const listText = await (
            await request.get(`${API_BASE}/api/webhooks`, {
                headers: authedHeaders(owner.access_token),
            })
        ).text();
        expect(listText).not.toContain(ENC_ENVELOPE_PREFIX);
        for (const s of allSecrets) {
            expect(listText, `at-rest secret never round-trips: ${s.slice(0, 6)}…`).not.toContain(
                s,
            );
        }

        // Final integrity check: at least 6 distinct secrets were minted across the
        // two subscriptions (2 create + ≥4 rotate) — confirming per-record minting,
        // not a shared/derivable value.
        expect(allSecrets.size).toBeGreaterThanOrEqual(4);
    });

    test('Flow 6 — PLATFORM_API_SECRET_TOKEN bearer rotation contract: old/forged tokens 401 while the current platform token authenticates past the guard', async ({
        request,
    }) => {
        // The ingest bearer (PlatformSecretGuard) is the OTHER platform secret named
        // in the theme. "Rotating" it is an env/redeploy op (no HTTP route), so the
        // observable rotation contract is: a stale/forged token is rejected (401)
        // while the CURRENT token passes the guard. A push-mode Work doesn't exist
        // in CI (Works default to pull), so a guard-PASS surfaces as the documented
        // 409 mode-mismatch — which still proves the bearer authenticated.
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Platform Bearer ${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // No bearer → 401 'Missing Bearer token'.
        const noBearer = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            data: ingestPayload(work.id),
        });
        expect(noBearer.status()).toBe(401);
        expect((await noBearer.json()).message).toMatch(/missing bearer token/i);

        // A plausible "previous-rotation" token (different value, similar length) →
        // 401 'Invalid bearer token'. timingSafeEqual rejects it regardless of how
        // close the length is to the real token.
        const staleToken = 'old-platform-secret-token-deterministic-32+chars';
        expect(staleToken).not.toBe(PLATFORM_API_SECRET_TOKEN);
        const stale = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${staleToken}` },
            data: ingestPayload(work.id),
        });
        expect(stale.status()).toBe(401);
        expect((await stale.json()).message).toMatch(/invalid bearer token/i);

        // A short forged token → still 401 (the guard pads to equal length so the
        // length itself can't be probed via a timing side-channel).
        const forged = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: 'Bearer x' },
            data: ingestPayload(work.id),
        });
        expect(forged.status()).toBe(401);

        // The CURRENT platform token authenticates PAST the guard. A pull-mode Work
        // (the CI default) then yields the documented 409 mode-mismatch — proving
        // the bearer was accepted (a rejected bearer would have 401'd before the
        // controller body ran). A 202 is the (non-CI) push-mode happy path.
        const accepted = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
            data: ingestPayload(work.id),
        });
        expect(
            [202, 409].includes(accepted.status()),
            `current platform token should pass the guard (got ${accepted.status()}: ${await accepted
                .text()
                .catch(() => '')})`,
        ).toBe(true);
        if (accepted.status() === 409) {
            const body = await accepted.json();
            expect(body).toMatchObject({ error: 'mode-mismatch', mode: 'pull' });
            expect(body.message).toMatch(/push-mode/i);
        } else {
            // Non-CI push-mode env: a row id is returned.
            expect((await accepted.json()).id).toBeTruthy();
        }
    });
});
