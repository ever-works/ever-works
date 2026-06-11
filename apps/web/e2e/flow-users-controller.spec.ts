import { test, expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * USERS CONTROLLER deep pin — `apps/api/src/users/controllers/users.controller.ts`.
 *
 * This is a near-greenfield, single-route public surface introduced by
 * EW-652 (Tenants & Organizations Phase 0). The controller enumerates to
 * EXACTLY ONE handler:
 *
 *   @Public() @Throttle({ long: 5/60s }) GET /api/users/check-username?value=
 *     → `{ available, normalized, suggestion? }` from UsernameAllocatorService.suggest()
 *
 * There is NO authenticated route, NO admin-gated route, NO cross-user
 * resource, and NO entity/DTO that could leak a secret — the only output is
 * a boolean + two derived strings. So instead of the generic "anon 401 /
 * cross-user 403 / no-secret-DTO" template (which has nothing to bite on
 * here), this file pins the REAL contracts the route actually exposes:
 *   1. @Public access (anon AND bearer both 200 — auth is irrelevant).
 *   2. The exact response key set (no extra/internal fields ride along).
 *   3. The deterministic normalization rules (lowercase, non-[a-z0-9-]→'-',
 *      collapse, strip ends, empty→`u-<8hex>` fallback).
 *   4. DTO validation 400s (missing / empty / >64 / disallowed chars) with
 *      the exact class-validator message envelope.
 *   5. Collision → `available:false` + the next-free `-N` suggestion (real
 *      registered user as the colliding row).
 *   6. Route-surface enumeration: only check-username exists; bare /api/users,
 *      unknown subpaths, and wrong method all 404 (Nest "Cannot <M> <path>").
 *
 * PROBED CONTRACTS — every status/body below verified against the LIVE
 * sqlite e2e API (port 3100) with throwaway users/keys before assertion:
 *   GET check-username?value=alice            → 200 {available:true,normalized:'alice'}
 *   value=Alice O'Brien                        → 200 normalized:'alice-o-brien'
 *   value=GITHUB.USER@x.io                      → 200 normalized:'github-user-x-io'
 *   value=--Hello--World--                      → 200 normalized:'hello-world'
 *   value=---                                    → 200 normalized matches /^u-[0-9a-f]{8}$/
 *   (no value)                                  → 400 {message:[...],error:'Bad Request',statusCode:400}
 *   value= (empty)                              → 400 (message[] incl. length + unsupported-chars)
 *   value=a/b , value=hi!                        → 400 message[0] = 'value contains unsupported characters; allowed: …'
 *   value=<65×'a'>                              → 400 message[0] = 'value must be shorter than or equal to 64 characters'
 *   value=<64×'b'>                              → 200 (exact boundary)
 *   value=<existing username>                    → 200 {available:false,normalized:'<lower>',suggestion:'<lower>-2'}
 *   bearer + value=<free>                        → 200 (Public route; bearer changes nothing)
 *   GET /api/users                               → 404 'Cannot GET /api/users'
 *   GET /api/users/me                            → 404 'Cannot GET /api/users/me'
 *   GET /api/users/<junk>                        → 404 'Cannot GET /api/users/<junk>'
 *   POST /api/users/check-username               → 404 'Cannot POST …' (Nest 404, not 405)
 *
 * THROTTLE NOTE: the route is @Throttle(long 5/60s) anti-enumeration. To stay
 * deterministic and never collide with that 5-budget across this file's
 * requests, EVERY request carries its OWN unique `x-e2e-throttle-key` (honored
 * when NODE_ENV !== 'production'), giving each request a dedicated tracker
 * bucket. We never burst a single key past 5 — the 5→429 threshold itself is
 * owned by sec-pin-throttle-contracts.spec.ts (test 7) and is NOT re-pinned here.
 *
 * NON-DUPLICATION:
 *   - sec-pin-throttle-contracts.spec.ts — owns the 5/60s→429 threshold + per-key
 *     isolation of check-username; this file asserts the SHAPE/VALIDATION/normalization
 *     and never bursts to 429.
 *   - api-malformed-authorization-header.spec.ts / api-error-response-shape.spec.ts —
 *     use /api/users/me only as a generic "protected/absent route" probe; they
 *     never touch check-username's body or the users-controller route surface.
 *   - flow-refresh-token-rotation.spec.ts — documents that /api/users/me is absent
 *     (no @Get('me')); orthogonal to this controller's actual handler.
 *
 * ISOLATION: every test runs on a CLEAN APIRequestContext (explicit empty
 * storageState — the chromium project's seeded session cookie would otherwise
 * ride to the API origin and re-key the public route onto the seeded bucket).
 * The collision test registers a FRESH user. Unique suffixes derive from a
 * per-test counter + the test title, never a module-scope clock.
 */

type PlaywrightApi = PlaywrightWorkerArgs['playwright'];

/** Per-file monotonic counter — seeds unique values WITHOUT a module-scope clock. */
let seq = 0;
function uniqueKey(label: string): string {
    seq += 1;
    return `users-ctrl-${label}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clean request context: NO inherited cookies. Each request stamps its own
 * x-e2e-throttle-key, so anonymous and authed probes never share a bucket.
 */
async function newCleanContext(playwright: PlaywrightApi): Promise<APIRequestContext> {
    return playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
}

const CHECK_USERNAME = `${API_BASE}/api/users/check-username`;

interface CheckResult {
    available: boolean;
    normalized: string;
    suggestion?: string;
}

interface ValidationError {
    message: string[];
    error: string;
    statusCode: number;
}

test.describe('Users controller — GET /api/users/check-username + route surface', () => {
    test('1. @Public: an anonymous request (empty storageState, no bearer) gets 200', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(`${CHECK_USERNAME}?value=anon-ok`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('anon') },
            });
            expect(r.status(), 'public route must not 401 for anonymous').toBe(200);
            const body = (await r.json()) as CheckResult;
            expect(body.available).toBe(true);
            expect(body.normalized).toBe('anon-ok');
        } finally {
            await ctx.dispose();
        }
    });

    test('2. @Public: a valid bearer token is ignored — still 200 with the same shape', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const u = await registerUserViaAPI(ctx);
            const value = `bearer-free-${seq + 1}`;
            const r = await ctx.get(`${CHECK_USERNAME}?value=${encodeURIComponent(value)}`, {
                headers: {
                    ...authedHeaders(u.access_token),
                    'x-e2e-throttle-key': uniqueKey('bearer'),
                },
            });
            expect(r.status(), 'Public route accepts a bearer without changing behaviour').toBe(
                200,
            );
            const body = (await r.json()) as CheckResult;
            expect(body.available).toBe(true);
            expect(body.normalized).toBe(value.toLowerCase());
        } finally {
            await ctx.dispose();
        }
    });

    test('3. response DTO is EXACTLY {available,normalized} on an available name — no extra/internal keys leak', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(`${CHECK_USERNAME}?value=keysetfree`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('keyset-free') },
            });
            expect(r.status()).toBe(200);
            const body = (await r.json()) as Record<string, unknown>;
            // Pin the exact key set — guards against accidental id/email/slug/
            // userId/internal-field leakage from the allocator/repository layer.
            expect(new Set(Object.keys(body))).toEqual(new Set(['available', 'normalized']));
            expect(body).toEqual({ available: true, normalized: 'keysetfree' });
        } finally {
            await ctx.dispose();
        }
    });

    test('4. normalization: apostrophe/space/at-sign/dots all collapse to single hyphens, lowercased', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const cases: Array<{ input: string; normalized: string }> = [
                { input: "Alice O'Brien", normalized: 'alice-o-brien' },
                { input: 'GITHUB.USER@x.io', normalized: 'github-user-x-io' },
            ];
            for (const c of cases) {
                const r = await ctx.get(`${CHECK_USERNAME}?value=${encodeURIComponent(c.input)}`, {
                    headers: { 'x-e2e-throttle-key': uniqueKey('norm') },
                });
                expect(r.status(), `normalize "${c.input}"`).toBe(200);
                const body = (await r.json()) as CheckResult;
                expect(body.normalized, `"${c.input}" → "${c.normalized}"`).toBe(c.normalized);
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('5. normalization: leading/trailing/duplicate hyphens are stripped and collapsed', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(
                `${CHECK_USERNAME}?value=${encodeURIComponent('--Hello--World--')}`,
                {
                    headers: { 'x-e2e-throttle-key': uniqueKey('strip') },
                },
            );
            expect(r.status()).toBe(200);
            const body = (await r.json()) as CheckResult;
            expect(body.normalized).toBe('hello-world');
            // Never starts or ends with a hyphen.
            expect(body.normalized.startsWith('-') || body.normalized.endsWith('-')).toBe(false);
        } finally {
            await ctx.dispose();
        }
    });

    test('6. normalization fallback: an all-hyphen value yields a u-<8hex> placeholder, still 200', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(`${CHECK_USERNAME}?value=${encodeURIComponent('---')}`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('fallback') },
            });
            expect(r.status()).toBe(200);
            const body = (await r.json()) as CheckResult;
            // Empties-after-normalization fall back to `u-` + 8 random hex chars.
            expect(body.normalized).toMatch(/^u-[0-9a-f]{8}$/);
            expect(body.available).toBe(true);
        } finally {
            await ctx.dispose();
        }
    });

    test('7. DTO validation: missing the `value` query param → 400 with class-validator envelope', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(CHECK_USERNAME, {
                headers: { 'x-e2e-throttle-key': uniqueKey('missing') },
            });
            expect(r.status()).toBe(400);
            const body = (await r.json()) as ValidationError;
            expect(Array.isArray(body.message)).toBe(true);
            expect(body.error).toBe('Bad Request');
            expect(body.statusCode).toBe(400);
            // Missing value fails @IsString + @Length + @Matches simultaneously.
            expect(body.message).toContain('value must be a string');
        } finally {
            await ctx.dispose();
        }
    });

    test('8. DTO validation: an empty value → 400 (fails length + charset)', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const r = await ctx.get(`${CHECK_USERNAME}?value=`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('empty') },
            });
            expect(r.status()).toBe(400);
            const body = (await r.json()) as ValidationError;
            expect(body.message).toContain('value must be longer than or equal to 1 characters');
        } finally {
            await ctx.dispose();
        }
    });

    test('9. DTO validation: disallowed characters (/, !) → 400 with the exact unsupported-chars message', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const expected =
                'value contains unsupported characters; allowed: letters, digits, dot, underscore, at-sign, apostrophe, hyphen, space';
            for (const bad of ['a/b', 'hi!']) {
                const r = await ctx.get(`${CHECK_USERNAME}?value=${encodeURIComponent(bad)}`, {
                    headers: { 'x-e2e-throttle-key': uniqueKey('badchar') },
                });
                expect(r.status(), `disallowed "${bad}"`).toBe(400);
                const body = (await r.json()) as ValidationError;
                expect(body.message, `"${bad}" message`).toContain(expected);
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('10. DTO validation: 65 chars → 400 (max 64); exactly 64 → 200 (boundary)', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const tooLong = 'a'.repeat(65);
            const over = await ctx.get(`${CHECK_USERNAME}?value=${tooLong}`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('len-over') },
            });
            expect(over.status(), '65 chars must be rejected').toBe(400);
            const overBody = (await over.json()) as ValidationError;
            expect(overBody.message).toContain(
                'value must be shorter than or equal to 64 characters',
            );

            const exact = 'b'.repeat(64);
            const ok = await ctx.get(`${CHECK_USERNAME}?value=${exact}`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('len-exact') },
            });
            expect(ok.status(), '64 chars is the inclusive upper bound').toBe(200);
            const okBody = (await ok.json()) as CheckResult;
            expect(okBody.normalized).toBe(exact);
        } finally {
            await ctx.dispose();
        }
    });

    test('11. collision: a freshly-registered username reports available:false + the next-free -2 suggestion', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            // Build a charset-valid username (letters/digits only, well under 64).
            const username = `Collide${(seq + 1).toString()}${Math.random().toString(36).slice(2, 8)}`;
            await registerUserViaAPI(ctx, {
                name: username,
                email: `${username.toLowerCase()}@test.local`,
            });

            const r = await ctx.get(`${CHECK_USERNAME}?value=${encodeURIComponent(username)}`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('collide') },
            });
            expect(r.status()).toBe(200);
            const body = (await r.json()) as CheckResult;
            const lower = username.toLowerCase();
            expect(body.available, 'an existing username collides').toBe(false);
            expect(body.normalized).toBe(lower);
            // The suggestion is the deterministic next-free -N variant.
            expect(body.suggestion).toBe(`${lower}-2`);
            // The taken-result key set is exactly the three documented keys.
            expect(new Set(Object.keys(body as unknown as Record<string, unknown>))).toEqual(
                new Set(['available', 'normalized', 'suggestion']),
            );
        } finally {
            await ctx.dispose();
        }
    });

    test('12. route surface: only check-username exists — bare /api/users, /me, junk subpath, and POST all 404', async ({
        playwright,
    }) => {
        const ctx = await newCleanContext(playwright);
        try {
            const bare = await ctx.get(`${API_BASE}/api/users`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('bare') },
            });
            expect(bare.status(), 'no controller-root handler').toBe(404);
            expect(((await bare.json()) as { message: string }).message).toBe(
                'Cannot GET /api/users',
            );

            const me = await ctx.get(`${API_BASE}/api/users/me`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('me') },
            });
            expect(me.status(), 'no @Get("me") on this controller').toBe(404);

            const junk = await ctx.get(`${API_BASE}/api/users/does-not-exist`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('junk') },
            });
            expect(junk.status(), 'unknown subpath').toBe(404);

            const wrongMethod = await ctx.post(`${CHECK_USERNAME}?value=x`, {
                headers: { 'x-e2e-throttle-key': uniqueKey('post') },
            });
            // Nest reports 404 (route-not-found), not 405, for the wrong verb.
            expect(wrongMethod.status(), 'POST is not a handler on check-username').toBe(404);
        } finally {
            await ctx.dispose();
        }
    });
});
