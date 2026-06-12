import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Admin-route AUTHORIZATION matrix — a security pin for the platform-admin gate
 * (`IsPlatformAdminGuard`, `User.isPlatformAdmin`). The theme is the COMPLETE set
 * of `/admin`-namespaced REST surfaces and the contract that a normal authenticated
 * user can NEVER reach any of them (403), an anonymous caller is rejected earlier
 * (401), and the admin elevation cannot be forged from the keyless e2e environment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — what is ALREADY pinned elsewhere (do NOT re-assert here):
 *   • flow-subscription-admin-usage.spec.ts FULLY covers the OTHER admin surface,
 *     `AdminUsageController @Controller('admin/usage')` (note: BARE, no `api/`
 *     prefix): its 404-on-`api/`-prefix, 401-anon, 403-non-admin (×3 fresh users +
 *     the seeded user), the guard-before-PERIOD-pipe ordering, and the non-admin
 *     not-found UI. This spec does NOT re-test `admin/usage`; it pins the SECOND,
 *     uncovered admin controller — `PluginAllowlistController` — and the
 *     cross-controller PREFIX ASYMMETRY that the two together expose.
 *
 * THIS SPEC pins the GAP: `PluginAllowlistController`
 *   (`@Controller('api/admin/plugins/allowlist')`,
 *    `@UseGuards(AuthSessionGuard, IsPlatformAdminGuard)`), EW-693/T23.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live API http://127.0.0.1:3100, curl, BEFORE writing):
 *
 *   ROUTE ENUMERATION — the allowlist controller exposes exactly 4 methods on 2
 *   path shapes, ALL behind the admin gate:
 *     GET    /api/admin/plugins/allowlist          (list)
 *     POST   /api/admin/plugins/allowlist          (create)
 *     PATCH  /api/admin/plugins/allowlist/:id      (toggle / re-pin)
 *     DELETE /api/admin/plugins/allowlist/:id      (remove)
 *
 *   AUTH MATRIX (verified per-method):
 *     anon (no Authorization)        -> 401 { message:'Unauthorized', statusCode:401 }
 *     anon (malformed Bearer token)  -> 401 { message:'Unauthorized', statusCode:401 }
 *     authed NON-admin (any method)  -> 403 { message:'Platform admin access required',
 *                                             error:'Forbidden', statusCode:403 }
 *   The AuthSessionGuard fires FIRST (anon → 401), then IsPlatformAdminGuard
 *   (authed-but-not-admin → 403). No e2e user is a platform admin
 *   (User.isPlatformAdmin defaults false; only SEED_PLATFORM_ADMIN_EMAIL or a
 *   manual UPDATE sets it), so the 200/201/204 admin happy-path is UNREACHABLE
 *   in the keyless env — the closure (401/403) contract is pinned thoroughly.
 *
 *   GUARD-BEFORE-PIPE ORDERING (verified): IsPlatformAdminGuard runs BEFORE the
 *   route's `ParseUUIDPipe` (PATCH/DELETE `:id`) and the body `ValidationPipe`
 *   (POST). A non-admin hitting PATCH/DELETE with a MALFORMED uuid, or POST with
 *   an EMPTY/invalid body, still gets 403 — never the 400/422 a platform admin
 *   would get. The route never leaks its id/body-validation contract to a
 *   non-admin (no enumeration oracle).
 *
 *   PREFIX ASYMMETRY (verified, cross-controller): the two admin controllers
 *   mount on OPPOSITE conventions —
 *     • PluginAllowlistController IS `api/`-prefixed → /api/admin/plugins/allowlist
 *       is the route; bare /admin/plugins/allowlist            -> 404
 *     • AdminUsageController is BARE             → /admin/usage is the route;
 *       api-prefixed /api/admin/usage                          -> 404
 *   A client guessing the "wrong" convention 404s on EITHER controller. Pinning
 *   both halves locks the enumeration surface for the whole `/admin` namespace.
 *
 *   404 SHAPE (verified): undefined methods/subpaths under the namespace 404:
 *     PUT  /api/admin/plugins/allowlist            -> 404 (no @Put handler)
 *     GET  /api/admin/plugins                       -> 404 (parent is not a route)
 *     GET  /api/admin/plugins/allowlist/foo/bar     -> 404 (no deep subpath)
 *   The 403 body is `application/json; charset=utf-8` with `X-Content-Type-Options: nosniff`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • Keyless / no-admin env: there is NO way to mint a platform admin from a
 *     spec (no env flag reachable at runtime, no self-elevation endpoint), so the
 *     admin-success payloads are deliberately NOT asserted — we pin the gate, not
 *     a fictional allowlist table. This is the correct security posture to lock.
 *   • Full isolation: every authed assertion uses a FRESH registerUserViaAPI()
 *     user (unique slug from the helper's own suffix) — no shared/seeded mutation.
 *     One invariance check additionally reuses the long-lived SEEDED storageState
 *     account (deferred load inside the test, never module scope) to prove that
 *     even an established, resource-owning account is still a non-admin here.
 *   • All assertions are API-contract (request fixture), independent of the
 *     project storageState — no UI/cold-compile dependency.
 */

const ALLOWLIST = `${API_BASE}/api/admin/plugins/allowlist`;
const ADMIN_403_MESSAGE = 'platform admin access required';
const RANDOM_UUID = '11111111-1111-1111-1111-111111111111';

/** Assert a response is the canonical authed-non-admin 403 from IsPlatformAdminGuard. */
async function expectPlatformAdmin403(
    res: { status(): number; json(): Promise<unknown> },
    label: string,
): Promise<void> {
    expect(res.status(), `${label} must be forbidden for a non-admin`).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.statusCode).toBe(403);
    expect(body.error).toBe('Forbidden');
    expect(
        String(body.message).toLowerCase(),
        `${label} names the platform-admin requirement`,
    ).toContain(ADMIN_403_MESSAGE);
}

/** Assert a response is the canonical anonymous 401 from AuthSessionGuard. */
async function expectUnauthorized401(
    res: { status(): number; json(): Promise<unknown> },
    label: string,
): Promise<void> {
    expect(res.status(), `${label} must require authentication`).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.statusCode).toBe(401);
}

test.describe('Flow: plugin-allowlist admin route — authentication gate (anon → 401)', () => {
    test('flow 1: every method of the allowlist controller rejects an ANONYMOUS caller with 401 BEFORE the admin check — no Authorization header AND a malformed Bearer token both 401, across GET/POST/PATCH/DELETE', async ({
        request,
    }) => {
        // ── 1. No Authorization header at all → AuthSessionGuard 401 on every method.
        await expectUnauthorized401(await request.get(ALLOWLIST), 'anon GET list');
        await expectUnauthorized401(
            await request.post(ALLOWLIST, {
                data: { packageName: '@x/y', versionRange: '^1.0.0' },
            }),
            'anon POST create',
        );
        await expectUnauthorized401(
            await request.patch(`${ALLOWLIST}/${RANDOM_UUID}`, { data: { enabled: false } }),
            'anon PATCH update',
        );
        await expectUnauthorized401(
            await request.delete(`${ALLOWLIST}/${RANDOM_UUID}`),
            'anon DELETE remove',
        );

        // ── 2. A malformed / bogus Bearer token is treated as unauthenticated (401),
        //       NOT as an authed-but-forbidden 403 — the session guard rejects it
        //       before the platform-admin lookup ever runs.
        const bogus = authedHeaders('totally-bogus-token-value');
        await expectUnauthorized401(
            await request.get(ALLOWLIST, { headers: bogus }),
            'bogus-token GET list',
        );
        await expectUnauthorized401(
            await request.delete(`${ALLOWLIST}/${RANDOM_UUID}`, { headers: bogus }),
            'bogus-token DELETE remove',
        );
    });
});

test.describe('Flow: plugin-allowlist admin route — authorization gate (non-admin → 403)', () => {
    test('flow 2: a freshly-registered, authenticated NON-admin user is forbidden (403 "Platform admin access required") from every allowlist method — GET/POST/PATCH/DELETE alike, with the canonical Nest forbidden body', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        await expectPlatformAdmin403(
            await request.get(ALLOWLIST, { headers }),
            'non-admin GET list',
        );
        await expectPlatformAdmin403(
            await request.post(ALLOWLIST, {
                headers,
                data: { packageName: '@scope/pkg', versionRange: '^1.2.3' },
            }),
            'non-admin POST create',
        );
        await expectPlatformAdmin403(
            await request.patch(`${ALLOWLIST}/${RANDOM_UUID}`, {
                headers,
                data: { enabled: true },
            }),
            'non-admin PATCH update',
        );
        await expectPlatformAdmin403(
            await request.delete(`${ALLOWLIST}/${RANDOM_UUID}`, { headers }),
            'non-admin DELETE remove',
        );
    });

    test('flow 3: the 403 is USER-INVARIANT — three INDEPENDENT fresh accounts each get the identical platform-admin forbidden response on the allowlist list endpoint; there is no row, scope, or registration path that elevates a normal account', async ({
        request,
    }) => {
        for (let i = 0; i < 3; i++) {
            const u = await registerUserViaAPI(request);
            await expectPlatformAdmin403(
                await request.get(ALLOWLIST, { headers: authedHeaders(u.access_token) }),
                `independent non-admin #${i} GET list`,
            );
        }
    });

    test('flow 4: even the long-lived, resource-owning SEEDED account is NOT a platform admin on the allowlist surface — owning works/sessions never confers isPlatformAdmin (the flag is seed/UPDATE-only)', async ({
        request,
    }) => {
        // Deferred load (NOT module scope) per the e2e house rule — reading the
        // seeded creds at collection time would redden every shard.
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.ok(), 'seeded user logs in for a fresh bearer token').toBeTruthy();
        const { access_token } = (await login.json()) as { access_token: string };

        await expectPlatformAdmin403(
            await request.get(ALLOWLIST, { headers: authedHeaders(access_token) }),
            'seeded resource-owner GET list',
        );
        await expectPlatformAdmin403(
            await request.delete(`${ALLOWLIST}/${RANDOM_UUID}`, {
                headers: authedHeaders(access_token),
            }),
            'seeded resource-owner DELETE remove',
        );
    });
});

test.describe('Flow: plugin-allowlist admin route — guard-before-pipe (no validation oracle)', () => {
    test('flow 5: IsPlatformAdminGuard short-circuits BEFORE the ParseUUIDPipe on :id — a non-admin hitting PATCH/DELETE with a MALFORMED uuid gets 403, never the 400 a platform admin would get; the id-validation contract never leaks to a non-admin', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        for (const badId of ['not-a-uuid', '123', 'foo-bar-baz', '%20']) {
            await expectPlatformAdmin403(
                await request.patch(`${ALLOWLIST}/${badId}`, { headers, data: { enabled: false } }),
                `non-admin PATCH malformed-id '${badId}'`,
            );
            await expectPlatformAdmin403(
                await request.delete(`${ALLOWLIST}/${badId}`, { headers }),
                `non-admin DELETE malformed-id '${badId}'`,
            );
        }
    });

    test('flow 6: the guard also short-circuits BEFORE the POST body ValidationPipe — a non-admin POSTing an EMPTY or invalid-shape body still gets 403, never the 400 "packageName should not be empty" a platform admin would get behind the gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // Each of these bodies would trip the create DTO validation FOR AN ADMIN,
        // but a non-admin never reaches the pipe — all 403, none 400/422.
        const badBodies: Array<Record<string, unknown>> = [
            {}, // missing required packageName
            { packageName: '' }, // empty packageName
            { packageName: 123, versionRange: false }, // wrong types
            { unexpected: 'field' }, // no recognised fields
        ];
        for (const [i, body] of badBodies.entries()) {
            await expectPlatformAdmin403(
                await request.post(ALLOWLIST, { headers, data: body }),
                `non-admin POST invalid-body #${i}`,
            );
        }
    });
});

test.describe('Flow: admin namespace — route enumeration & prefix asymmetry', () => {
    test('flow 7: the allowlist controller IS api/-prefixed (mirror image of admin/usage) — the bare /admin/plugins/allowlist path is NOT a route (404) for both anon and authed callers, so the `api/` prefix is load-bearing', async ({
        request,
    }) => {
        const bare = `${API_BASE}/admin/plugins/allowlist`;

        // Anon on the bare path: 404 (the route does not exist) — distinct from the
        // 401 the REAL api-prefixed path returns. The missing prefix means no route
        // matched, so no guard ran.
        const bareAnon = await request.get(bare);
        expect(bareAnon.status(), 'bare /admin/plugins/allowlist must not resolve (anon)').toBe(
            404,
        );

        // Authed on the bare path: still 404 — proving the prefix, not the auth state,
        // is what's missing. (A real-but-forbidden route would be 403 for this user.)
        const u = await registerUserViaAPI(request);
        const bareAuthed = await request.get(bare, { headers: authedHeaders(u.access_token) });
        expect(bareAuthed.status(), 'bare /admin/plugins/allowlist must not resolve (authed)').toBe(
            404,
        );

        // And the REAL api-prefixed path, for the same user, is the gated 403 — the
        // two together prove the prefix is the only difference.
        await expectPlatformAdmin403(
            await request.get(ALLOWLIST, { headers: authedHeaders(u.access_token) }),
            'api-prefixed allowlist (control)',
        );
    });

    test('flow 8: the two admin controllers enforce OPPOSITE prefix conventions — the bare admin/usage exists while api/admin/usage 404s, exactly inverted from the allowlist; a client guessing the wrong convention 404s on either, with no guard leakage', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // admin/usage is BARE: the api-prefixed variant does NOT exist → 404 (even
        // for an authed user — the route never matched, so no 403).
        const usageApiPrefixed = await request.get(`${API_BASE}/api/admin/usage`, { headers });
        expect(
            usageApiPrefixed.status(),
            'api/admin/usage must NOT resolve (bare-only route)',
        ).toBe(404);

        // ...while the BARE admin/usage IS the real route → gated 403 for this non-admin.
        const usageBare = await request.get(`${API_BASE}/admin/usage`, { headers });
        await expectPlatformAdmin403(usageBare, 'bare admin/usage (real route)');

        // The allowlist is the EXACT inverse: api-prefixed is real (403), bare is 404.
        // (Re-stated minimally here only to make the inversion a single explicit pair.)
        const allowApiPrefixed = await request.get(ALLOWLIST, { headers });
        await expectPlatformAdmin403(allowApiPrefixed, 'api/admin/plugins/allowlist (real route)');
        const allowBare = await request.get(`${API_BASE}/admin/plugins/allowlist`, { headers });
        expect(
            allowBare.status(),
            'bare allowlist must NOT resolve (api-prefixed-only route)',
        ).toBe(404);
    });

    test('flow 9: undefined methods and subpaths within the allowlist namespace are 404 (no @Put handler, parent path not a route, no deep subpath) — the namespace exposes exactly its 4 documented handlers and nothing more', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // PUT is not a defined handler on the collection → 404 (route-method miss),
        // distinct from the 403 the DEFINED methods return for this same user.
        const put = await request.fetch(ALLOWLIST, { method: 'PUT', headers, data: {} });
        expect(put.status(), 'PUT on allowlist collection is not a route').toBe(404);

        // The parent `/api/admin/plugins` (without `/allowlist`) is not a route here.
        const parent = await request.get(`${API_BASE}/api/admin/plugins`, { headers });
        expect(parent.status(), 'api/admin/plugins parent is not an allowlist route').toBe(404);

        // A deep, undefined subpath under the controller base is not a route.
        const deep = await request.get(`${ALLOWLIST}/${RANDOM_UUID}/extra`, { headers });
        expect(deep.status(), 'deep subpath under allowlist is not a route').toBe(404);
    });
});

test.describe('Flow: admin gate — response hygiene & cross-method consistency', () => {
    test('flow 10: the non-admin 403 is a clean JSON error with nosniff and no stack/internal leakage — the body is exactly {message,error,statusCode}, content-type application/json, and never a 5xx or HTML error page', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(ALLOWLIST, { headers: authedHeaders(u.access_token) });
        expect(res.status()).toBe(403);

        const headers = res.headers();
        expect(headers['content-type'] ?? '', 'forbidden body is JSON').toContain(
            'application/json',
        );
        // Defensive header set by the API for every JSON error response.
        expect(headers['x-content-type-options'] ?? '').toContain('nosniff');

        const body = (await res.json()) as Record<string, unknown>;
        // Exactly the canonical Nest forbidden shape — no extra fields leaking
        // internals (no `stack`, `path`, `trace`, or guard internals).
        expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
        const widened = body as unknown as Record<string, unknown>;
        expect(widened.stack, 'no stack trace leaks to the client').toBeUndefined();
        expect(widened.path, 'no request path echoed in the error').toBeUndefined();
    });

    test('flow 11: the admin gate is consistent across a rapid mixed-method burst from one non-admin — every GET/POST/PATCH/DELETE in the burst returns 403 (never a 5xx, never an accidental 200/201/204), proving the gate has no method-specific bypass', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const burst = await Promise.all([
            request.get(ALLOWLIST, { headers }),
            request.post(ALLOWLIST, {
                headers,
                data: { packageName: '@a/b', versionRange: '1.x' },
            }),
            request.patch(`${ALLOWLIST}/${RANDOM_UUID}`, { headers, data: { enabled: false } }),
            request.delete(`${ALLOWLIST}/${RANDOM_UUID}`, { headers }),
            request.get(ALLOWLIST, { headers }),
        ]);
        for (const [i, res] of burst.entries()) {
            expect(res.status(), `burst request #${i} must be a clean 403, never 2xx/5xx`).toBe(
                403,
            );
        }
    });

    test('flow 12: a non-admin cannot reach EITHER admin controller — the platform-admin flag is the single gate for the whole /admin namespace, so the same user is 403 on the allowlist AND 403 on admin/usage in one matrix, with no surface that any normal user can read', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // The complete reachable-route matrix for the /admin namespace, all gated by
        // the SAME isPlatformAdmin flag → uniformly 403 for this normal user.
        const allowlistList = await request.get(ALLOWLIST, { headers });
        const allowlistCreate = await request.post(ALLOWLIST, {
            headers,
            data: { packageName: '@m/n', versionRange: '^2.0.0' },
        });
        const usageBare = await request.get(`${API_BASE}/admin/usage`, { headers });
        const usageWithPeriod = await request.get(`${API_BASE}/admin/usage?period=current`, {
            headers,
        });

        await expectPlatformAdmin403(allowlistList, 'allowlist list');
        await expectPlatformAdmin403(allowlistCreate, 'allowlist create');
        await expectPlatformAdmin403(usageBare, 'admin usage (default period)');
        // Crucially, even a VALID period on admin/usage stays 403 for a non-admin —
        // the gate is period-independent (the usage spec pins the full period grid;
        // here we only confirm the same user is uniformly walled out of both routes).
        await expectPlatformAdmin403(usageWithPeriod, 'admin usage (period=current)');
    });
});
