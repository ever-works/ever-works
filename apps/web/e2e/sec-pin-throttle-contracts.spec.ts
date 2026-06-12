import { test, expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * SECURITY PIN: deterministic per-route @Throttle contracts (429 semantics).
 *
 * The four existing rate-limit specs all hammer ANONYMOUS `/api/auth/*`
 * endpoints — exactly the routes the CI harness exempts via
 * `E2E_DISABLE_AUTH_THROTTLE` (UserAwareThrottlerGuard skip-list:
 * `/api/auth/*`, `/api/claim/*`, `/api/organizations/check-slug`), which is
 * why none of them can hard-assert a 429. This file pins the throttles that
 * ARE CI-stable:
 *
 *   - NON-auth `@Throttle` overrides stay fully active in CI (e2e.yml only
 *     raises REGISTER/LOGIN_THROTTLE_LIMIT + sets E2E_DISABLE_AUTH_THROTTLE;
 *     none of the works/webhooks/users limits below are touched), and
 *   - authenticated requests are tracked per `user:<userId>`
 *     (UserAwareThrottlerGuard.getTracker, which runs AFTER AuthSessionGuard
 *     in the APP_GUARD order), so a FRESH user per test gives each burst a
 *     dedicated bucket — deterministic 429 position, zero impact on sibling
 *     specs sharing the runner IP.
 *   - anonymous bursts get a DEDICATED bucket by stamping a unique
 *     `x-e2e-throttle-key` (honored when NODE_ENV !== 'production'; the
 *     harness itself stamps `w<worker>` globally, so a per-test unique key is
 *     strictly MORE isolated than the suite default).
 *
 * PROBED CONTRACTS — every status/body/header below was verified against the
 * LIVE sqlite e2e API (port 3100) with throwaway users before being asserted:
 *
 *   POST /api/works/quick-create (@Throttle long 10/60s, EW-617 G4 generation
 *        kick-off) with `{}`: DTO ValidationPipe 400 ×10 (message[] includes
 *        'slug should not be empty'), then 429 on the 11th — proving the
 *        throttler counts requests at the GUARD stage, before validation.
 *   POST /api/works/:absentId/import-items (@Throttle long 3/60s): 404 ×3
 *        `{ status:'error', message:"Work with id '<id>' not found" }`, then
 *        429 on the 4th — failed (4xx) requests still consume quota.
 *   429 envelope (probed on import-items): body is EXACTLY
 *        `{ statusCode:429, message:'ThrottlerException: Too Many Requests' }`;
 *        headers carry the TIER-SUFFIXED backoff signal `Retry-After-long: 60`
 *        (there is NO bare Retry-After in this build) plus the non-exceeded
 *        tier counters `X-RateLimit-Limit-short: 50` / `-medium: 300` with
 *        numeric remaining/reset (reset-short <= 1s, reset-medium <= 10s).
 *   PUT /api/works/:absentId/advanced-prompts (@Throttle long 20/60s — the
 *        EW-714 Wave-K abuse-rate hardening on the prompts-feed-generation
 *        write path): 404 ×20, then 429 on the 21st.
 *   POST /api/webhooks/:absentUuid/test (@Throttle long 5/60s): 404 ×5
 *        `{ message:'Webhook subscription not found', error:'Not Found',
 *        statusCode:404 }`, then 429 on the 6th.
 *   USER-KEYED isolation (probed): after user A exhausts the import-items
 *        bucket (…→429), a fresh user B's FIRST request to the SAME route
 *        from the SAME IP returns 404 (not 429), and user A's sibling route
 *        GET /api/works still returns 200 (per-route, per-user buckets).
 *   GET /api/users/check-username?value=… (PUBLIC, @Throttle long 5/60s,
 *        anti-enumeration hardening): with a dedicated x-e2e-throttle-key,
 *        200 `{ available:true, normalized:'<value>' }` ×5, then 429 on the
 *        6th; a DIFFERENT key on the same route still gets 200 (bucket is
 *        per-key, not per-route-global).
 *   POST /api/auth/magic-link (@Throttle long 5/60s): with a dedicated key,
 *        200 ×5 then 429 on the 6th when the auth throttle is ENFORCED
 *        (probed live locally). In CI the harness sets
 *        E2E_DISABLE_AUTH_THROTTLE=true which skips ALL `/api/auth/*`
 *        throttling, so this test is environment-adaptive: it pins the exact
 *        5→429 threshold when enforcement is on, and pins uniform-200
 *        (never 5xx, no premature 429) when the harness exemption is active.
 *
 * NON-DUPLICATION:
 *   - rate-limit.spec.ts            — anonymous login/anonymous-auth hammer, 4xx-family only.
 *   - rate-limit-deeper.spec.ts     — register-vs-health isolation, Retry-After existence (skips when no 429).
 *   - rate-limit-headers.spec.ts    — unsuffixed x-ratelimit-* lookups (all skip in this build).
 *   - rate-limit-key-isolation.spec.ts — Alice/Bob login lockout (anonymous, IP/account-keyed).
 *   - flow-rate-limit-throttle.spec.ts — named-tier header taxonomy on NORMAL responses, shared
 *     long-bucket monotonicity, short-tier recovery, BEST-EFFORT 429 envelope (never reached in
 *     its env), magic-link anti-enumeration uniformity. It never pins a deterministic 429
 *     position, never pins the tier-suffixed Retry-After-long, and never touches the works/
 *     webhooks/users @Throttle overrides — all of which are owned here.
 *   - sec-pin-webhook-ownership.spec.ts — pins the 404 ownership masking on /api/webhooks/:id/*
 *     but not the test-fire throttle threshold.
 *   - flow-work-generation-lifecycle.spec.ts — tolerates 429 in its enqueue-gate set but never
 *     asserts the quick-create threshold.
 *
 * ISOLATION: every test runs on a CLEAN APIRequestContext (explicit empty
 * storageState — the default `request` fixture under the `chromium` project
 * would carry the seeded session cookie, which could re-key anonymous bursts
 * onto the SHARED seeded user bucket). Every authenticated burst uses a fresh
 * registerUserViaAPI user (its own `user:<id>` bucket); every anonymous burst
 * uses a unique per-attempt x-e2e-throttle-key. Biggest burst is 21 requests —
 * far below the global named tiers (short 50/1s, medium 300/10s, long 1000/60s
 * per tracker), so no test can trip a tier another test shares.
 */

type PlaywrightApi = PlaywrightWorkerArgs['playwright'];

const THROTTLED_BODY = { statusCode: 429, message: 'ThrottlerException: Too Many Requests' };

/** Valid v4-shaped UUID no live row will ever have. */
const ABSENT_WORK_ID = '00000000-0000-4000-8000-00000000dead';
const ABSENT_WEBHOOK_ID = '11111111-2222-4333-8444-555566667777';

function uniq(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Clean request context: NO inherited cookies (the chromium project's
 * storageState would otherwise ride along to the API origin) and no
 * suite-level worker throttle key — each test stamps its own tracker
 * (Bearer user or dedicated x-e2e-throttle-key) explicitly.
 */
async function newCleanContext(playwright: PlaywrightApi): Promise<APIRequestContext> {
    return playwright.request.newContext({
        storageState: { cookies: [], origins: [] },
    });
}

function isNumeric(v: string | undefined): v is string {
    return typeof v === 'string' && /^\d+$/.test(v);
}

test.describe('Security pin — deterministic @Throttle contracts', () => {
    test('1. quick-create generation throttle (10/60s): ten DTO-invalid 400s then a deterministic 429 — guard counts BEFORE validation', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);
            const statuses: number[] = [];
            let firstBody: { message?: string[] } | null = null;
            let throttledBody: unknown = null;

            for (let i = 0; i < 11; i++) {
                const r = await ctx.post(`${API_BASE}/api/works/quick-create`, {
                    headers: authedHeaders(u.access_token),
                    data: {},
                });
                statuses.push(r.status());
                if (i === 0) firstBody = (await r.json()) as { message?: string[] };
                if (i === 10) throttledBody = await r.json();
            }

            // Exactly 10 validation 400s — the @Throttle(10/60s) budget — then 429.
            expect(
                statuses.slice(0, 10),
                `first 10 must be DTO-400s: ${statuses.join(',')}`,
            ).toEqual(new Array(10).fill(400));
            expect(statuses[10], `11th call must throttle: ${statuses.join(',')}`).toBe(429);

            // The 400s really are the DTO gate (handler pipeline reached past the
            // guard): class-validator message array names the missing slug.
            expect(Array.isArray(firstBody?.message)).toBe(true);
            expect(firstBody?.message).toContain('slug should not be empty');

            // Canonical @nestjs/throttler rejection body.
            expect(throttledBody).toEqual(THROTTLED_BODY);
        } finally {
            await ctx.dispose();
        }
    });

    test('2. import-items execute throttle (3/60s): three ownership-404s then 429 — failed requests still consume quota', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);
            const statuses: number[] = [];
            let firstBody: { status?: string; message?: string } | null = null;

            for (let i = 0; i < 4; i++) {
                const r = await ctx.post(`${API_BASE}/api/works/${ABSENT_WORK_ID}/import-items`, {
                    headers: authedHeaders(u.access_token),
                    data: { rows: [] },
                });
                statuses.push(r.status());
                if (i === 0) firstBody = (await r.json()) as { status?: string; message?: string };
            }

            expect(statuses, 'expected exactly [404,404,404,429]').toEqual([404, 404, 404, 429]);

            // The pre-429 responses are the works exception-filter 404 envelope
            // (ownership masked before body validation — see executeImportItems).
            expect(firstBody?.status).toBe('error');
            expect(firstBody?.message).toBe(`Work with id '${ABSENT_WORK_ID}' not found`);
        } finally {
            await ctx.dispose();
        }
    });

    test('3. 429 envelope deep-pin: tier-suffixed Retry-After-long backoff + intact sibling-tier counters', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);

            // Drive a fresh user's import-items bucket (3/60s) to exhaustion.
            let throttled: { headers: Record<string, string>; body: string } | null = null;
            for (let i = 0; i < 4; i++) {
                const r = await ctx.post(`${API_BASE}/api/works/${ABSENT_WORK_ID}/import-items`, {
                    headers: authedHeaders(u.access_token),
                    data: { rows: [] },
                });
                if (r.status() === 429) {
                    throttled = { headers: r.headers(), body: await r.text() };
                    break;
                }
            }
            expect(
                throttled,
                'fresh user must hit 429 by the 4th import-items call',
            ).not.toBeNull();
            const h = throttled!.headers;

            // Backoff signal: this build emits the TIER-SUFFIXED form. The
            // exceeded tier is the route override's `long` (ttl 60s), so the
            // header is `retry-after-long` with 1..60 seconds.
            const retryAfterLong = h['retry-after-long'];
            expect(
                isNumeric(retryAfterLong),
                `retry-after-long missing/malformed: ${retryAfterLong}`,
            ).toBe(true);
            expect(Number(retryAfterLong)).toBeGreaterThanOrEqual(1);
            expect(Number(retryAfterLong)).toBeLessThanOrEqual(60);

            // Non-exceeded tier counters stay present + coherent on the 429
            // (config defaults — e2e.yml does not override THROTTLER_*).
            expect(h['x-ratelimit-limit-short']).toBe('50');
            expect(h['x-ratelimit-limit-medium']).toBe('300');
            expect(isNumeric(h['x-ratelimit-remaining-short'])).toBe(true);
            expect(isNumeric(h['x-ratelimit-remaining-medium'])).toBe(true);
            expect(Number(h['x-ratelimit-reset-short'])).toBeLessThanOrEqual(1);
            expect(Number(h['x-ratelimit-reset-medium'])).toBeLessThanOrEqual(10);

            // Canonical JSON rejection body.
            expect(h['content-type'] || '').toContain('json');
            expect(JSON.parse(throttled!.body)).toEqual(THROTTLED_BODY);
        } finally {
            await ctx.dispose();
        }
    });

    test('4. advanced-prompts write throttle (20/60s, Wave-K prompt-injection hardening): twenty 404s then 429 on the 21st', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);
            const statuses: number[] = [];

            for (let i = 0; i < 21; i++) {
                const r = await ctx.put(
                    `${API_BASE}/api/works/${ABSENT_WORK_ID}/advanced-prompts`,
                    {
                        headers: authedHeaders(u.access_token),
                        data: {},
                    },
                );
                statuses.push(r.status());
            }

            expect(
                statuses.slice(0, 20),
                `first 20 must be ownership-404s: ${statuses.join(',')}`,
            ).toEqual(new Array(20).fill(404));
            expect(statuses[20], `21st call must throttle: ${statuses.join(',')}`).toBe(429);
        } finally {
            await ctx.dispose();
        }
    });

    test('5. webhook test-fire throttle (5/60s): five masked 404s then 429 on the 6th', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);
            const statuses: number[] = [];
            let firstBody: { message?: string; error?: string; statusCode?: number } | null = null;

            for (let i = 0; i < 6; i++) {
                const r = await ctx.post(`${API_BASE}/api/webhooks/${ABSENT_WEBHOOK_ID}/test`, {
                    headers: authedHeaders(u.access_token),
                });
                statuses.push(r.status());
                if (i === 0)
                    firstBody = (await r.json()) as {
                        message?: string;
                        error?: string;
                        statusCode?: number;
                    };
            }

            expect(statuses, 'expected exactly [404 x5, 429]').toEqual([
                404, 404, 404, 404, 404, 429,
            ]);

            // The pre-throttle responses are the ownership-masking 404 pinned by
            // sec-pin-webhook-ownership.spec.ts — same envelope here.
            expect(firstBody?.message).toBe('Webhook subscription not found');
            expect(firstBody?.error).toBe('Not Found');
            expect(firstBody?.statusCode).toBe(404);
        } finally {
            await ctx.dispose();
        }
    });

    test("6. throttle buckets are USER-keyed and PER-ROUTE: user A exhausting a route blocks neither user B nor A's other routes", async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const userA = await registerUserViaAPI(ctx);
            const userB = await registerUserViaAPI(ctx);

            // A exhausts import-items (3/60s) from the suite's shared IP.
            const aStatuses: number[] = [];
            for (let i = 0; i < 4; i++) {
                const r = await ctx.post(`${API_BASE}/api/works/${ABSENT_WORK_ID}/import-items`, {
                    headers: authedHeaders(userA.access_token),
                    data: { rows: [] },
                });
                aStatuses.push(r.status());
            }
            expect(aStatuses).toEqual([404, 404, 404, 429]);

            // B's FIRST call to the SAME route from the SAME IP gets the normal
            // 404 — NOT 429. The tracker is `user:<id>`, not `ip:<addr>`.
            const bRes = await ctx.post(`${API_BASE}/api/works/${ABSENT_WORK_ID}/import-items`, {
                headers: authedHeaders(userB.access_token),
                data: { rows: [] },
            });
            expect(bRes.status(), 'user B must not inherit user A throttle').toBe(404);

            // A's bucket is PER-ROUTE: an unrelated authed read on a different
            // route still serves while import-items stays throttled.
            const aWorks = await ctx.get(`${API_BASE}/api/works`, {
                headers: authedHeaders(userA.access_token),
            });
            expect(aWorks.status(), 'sibling route poisoned by per-route 429').toBe(200);

            const aStill = await ctx.post(`${API_BASE}/api/works/${ABSENT_WORK_ID}/import-items`, {
                headers: authedHeaders(userA.access_token),
                data: { rows: [] },
            });
            expect(aStill.status(), 'user A bucket must persist within the 60s window').toBe(429);
        } finally {
            await ctx.dispose();
        }
    });

    test('7. public check-username throttle (5/60s, anti-enumeration): five 200s then 429, scoped to the caller bucket', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            // Dedicated anonymous bucket — unique per attempt so retries and
            // sibling specs (which use the per-worker key) are unaffected.
            const bucketKey = `sec-pin-thr-cu-${uniq()}`;
            const statuses: number[] = [];
            let firstBody: { available?: boolean; normalized?: string } | null = null;

            for (let i = 0; i < 6; i++) {
                const value = `sec-pin-cu-${uniq()}`;
                const r = await ctx.get(
                    `${API_BASE}/api/users/check-username?value=${encodeURIComponent(value)}`,
                    { headers: { 'x-e2e-throttle-key': bucketKey } },
                );
                statuses.push(r.status());
                if (i === 0) {
                    firstBody = (await r.json()) as { available?: boolean; normalized?: string };
                    // Contract shape: { available, normalized } — a fresh random
                    // slug is available and normalizes to itself (lowercase input).
                    expect(firstBody.available).toBe(true);
                    expect(firstBody.normalized).toBe(value);
                }
            }

            expect(statuses, 'expected exactly [200 x5, 429]').toEqual([
                200, 200, 200, 200, 200, 429,
            ]);

            // A DIFFERENT bucket key immediately gets 200 on the same route —
            // the 5/60s budget is per-tracker, not a route-global brownout.
            const other = await ctx.get(
                `${API_BASE}/api/users/check-username?value=sec-pin-cu-${uniq()}`,
                { headers: { 'x-e2e-throttle-key': `${bucketKey}-other` } },
            );
            expect(other.status(), 'sibling bucket must be unaffected by the burst').toBe(200);
        } finally {
            await ctx.dispose();
        }
    });

    test('8. magic-link issuance throttle (5/60s) — exact 6th-call 429 when enforced; uniform 200 under the CI auth-throttle exemption', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const bucketKey = `sec-pin-thr-ml-${uniq()}`;
            const results: Array<{ status: number; headers: Record<string, string> }> = [];

            for (let i = 0; i < 6; i++) {
                const r = await ctx.post(`${API_BASE}/api/auth/magic-link`, {
                    headers: { 'x-e2e-throttle-key': bucketKey },
                    data: { email: `sec-pin-ml-${uniq()}-${i}@test.local` },
                });
                results.push({ status: r.status(), headers: r.headers() });
            }

            const statuses = results.map((r) => r.status);

            if (statuses[0] === 404) {
                test.skip(true, 'magic-link endpoint disabled (404) in this env');
            }

            // Hard contract in EVERY env: issuance only ever answers 200
            // (uniform anti-enumeration accept) or 429 (throttle) — never 5xx,
            // never a premature 429 inside the documented 5-request budget.
            for (const [i, s] of statuses.entries()) {
                expect([200, 429], `call ${i + 1} returned ${s}`).toContain(s);
            }
            expect(statuses.slice(0, 5), 'throttled before the documented 5/60s budget').toEqual([
                200, 200, 200, 200, 200,
            ]);

            if (statuses[5] === 429) {
                // Enforced env (probed live locally): the 6th call is the exact
                // threshold, and carries the tier-suffixed backoff header.
                const retryAfterLong = results[5].headers['retry-after-long'];
                expect(
                    isNumeric(retryAfterLong),
                    'throttled magic-link lacks retry-after-long',
                ).toBe(true);
                expect(Number(retryAfterLong)).toBeLessThanOrEqual(60);
            } else {
                // CI harness mode: E2E_DISABLE_AUTH_THROTTLE exempts /api/auth/*
                // entirely — the contract here is UNIFORM acceptance.
                expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
                test.info().annotations.push({
                    type: 'informational',
                    description:
                        'no 429 on the 6th magic-link call — auth-throttle exemption active (E2E_DISABLE_AUTH_THROTTLE, as in CI); pinned uniform-200 acceptance instead',
                });
            }
        } finally {
            await ctx.dispose();
        }
    });
});
