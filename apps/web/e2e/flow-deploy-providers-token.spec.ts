import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: DEPLOY PROVIDERS + VALIDATE-TOKEN FACADE CONTRACT — focused, real-probed
 * INTEGRATION flows pinning the THREE read-side endpoints of the deploy facade
 * controller that the deploy-picker UI polls: GET /api/deploy/providers (the
 * list envelope + ordering + per-user `configured` axis), GET
 * /api/deploy/providers/:providerId/configured (the branch-dependent key SHAPE
 * + id-matching rules), and POST /api/deploy/validate-token (the body-agnostic,
 * provider-existence-only, strictly-per-user contract). Auth-gating (anon +
 * garbage-bearer 401) and HTTP method routing (404) are pinned too.
 *
 * GROUNDING — every shape below was verified against the LIVE sqlite e2e API
 * (port 3100, keyless CI mirror) with throwaway users on 2026-06-12, and
 * cross-checked against the real source:
 *   - apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 *       listProviders        -> getAvailableProvidersForUser(userId) (per-user `configured`)
 *       isProviderConfigured -> resolveDeployProviderId('ever-works'->'k8s'); three branches
 *                               (unknown / disabled / known) with DIFFERENT key sets
 *       validateToken        -> takes NO @Body(); returns valid := exists(enabled && configured)
 *                               provider for the CALLING user; userInfo always null
 *   - the whole controller is @UseGuards(AuthSessionGuard) -> anon/garbage 401
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     GET  /api/deploy/providers (authed) → 200 { status:'success', providers:[k8s, vercel] }
 *            ids arrive in the stable order ['k8s','vercel']; each row has a boolean
 *            user-scoped `configured` (false for a fresh user).
 *     GET  /api/deploy/providers/:id/configured →
 *            known   ('vercel')     → keys {status,configured,available,enabled,message}, available/enabled true
 *            alias   ('ever-works') → resolves to k8s: available/enabled true, configured mirrors k8s;
 *                                     message ECHOES the requested id verbatim ("Provider 'ever-works' ...")
 *            unknown ('zzz','VERCEL','foo bar') → keys {status,configured,available,message} (NO `enabled`),
 *                                     available:false, configured:false, message /not available/
 *            id-matching is CASE-SENSITIVE ('VERCEL' not available) and NOT trimmed ('foo bar' not available)
 *     POST /api/deploy/validate-token →
 *            body is IGNORED (no DTO): {}, {providerId,token}, {bogus:1}, and NO body all behave identically
 *            unconfigured user → 201 { status:'success', valid:false, userInfo:null, msg /No deployment provider/ }
 *            after THIS user configures a (fake) vercel token → valid:true, userInfo STILL null
 *            strictly PER-USER: configuring user B never flips user A's validate-token / configured axis
 *     AUTH: providers / configured / validate-token all 401 for anon AND a garbage bearer.
 *     METHOD: POST /providers → 404, GET /validate-token → 404 (no such route/verb).
 *
 * ADAPTIVITY (keyless CI): NO real Vercel/k8s token is wired. The configure step
 * supplies a deliberately FAKE token only to flip the *isConfigured* axis (the
 * real Vercel API rejects it — connectionStatus "Vercel rejected the API token"),
 * and validate-token reports provider-EXISTENCE, never a real token validation —
 * so it never 5xx's. A pre-configured stack is tolerated where a fresh user could
 * already be configured (boolean-type / set-membership assertions, never exact).
 *
 * NON-DUPLICATION: flow-deploy-capability-contract pins the provider-facade SHAPE
 * (icon/description/homepage), the create-vs-PATCH deployProvider write asymmetry,
 * the deploy-gate provider-NAME resolution, /teams, and the correlation invariant.
 * flow-plugin-deployment drives the PLUGIN side (token-enable flips the capability,
 * the two-stage deploy gate, per-work re-binding, lookup/domains/batch, system-plugin
 * invariants). flow-templates-deploy / flow-work-deploy-state pin a single
 * configured-check + the state machine. THIS file pins ONLY the residual
 * providers/configured/validate-token GAPS those specs leave open: the list
 * ENVELOPE + id ORDER, the per-provider key-SHAPE asymmetry (unknown drops
 * `enabled`), id-matching CASE-sensitivity / no-trim, the alias message-echo,
 * validate-token's BODY-AGNOSTIC + per-USER-isolation contract, and the
 * auth-gate / method-routing 401/404 negative space.
 *
 * ISOLATION: every assertion runs on a FRESH registerUserViaAPI() user (the
 * configured token is USER-scoped — must never leak into sibling specs that share
 * the seeded user). No module-scope await / clock-suffix. Anonymous probes use an
 * EXPLICIT empty storageState context so they don't inherit the shared auth cookie.
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const PLUGINS_BASE = `${API_BASE}/api/plugins`;
const FAKE_VERCEL_TOKEN = 'fake-vercel-token-providers-token-spec';

interface ProviderRow {
    id: string;
    name: string;
    enabled: boolean;
    configured?: boolean;
}

/** GET /api/deploy/providers — returns the user-scoped provider rows (asserts the envelope). */
async function listProviders(request: APIRequestContext, token: string): Promise<ProviderRow[]> {
    const res = await request.get(`${DEPLOY_BASE}/providers`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(Array.isArray(body.providers)).toBe(true);
    return body.providers as ProviderRow[];
}

/** GET /api/deploy/providers/:id/configured */
async function providerConfigured(
    request: APIRequestContext,
    token: string,
    providerId: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(
        `${DEPLOY_BASE}/providers/${encodeURIComponent(providerId)}/configured`,
        {
            headers: authedHeaders(token),
        },
    );
    expect(res.status()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

/** POST /api/deploy/validate-token with an arbitrary (ignored) body. */
async function validateToken(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown> | undefined = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await request.post(`${DEPLOY_BASE}/validate-token`, {
        headers: authedHeaders(token),
        ...(body === undefined ? {} : { data: body }),
    });
    return { status: res.status(), json: (await res.json()) as Record<string, unknown> };
}

/** Enable the vercel plugin with a (fake) apiToken so the deploy capability becomes configured. */
async function configureVercelToken(request: APIRequestContext, token: string): Promise<void> {
    const res = await request.post(`${PLUGINS_BASE}/vercel/enable`, {
        headers: authedHeaders(token),
        data: { secretSettings: { apiToken: FAKE_VERCEL_TOKEN } },
    });
    expect(res.status(), `enable vercel body=${await res.text().catch(() => '')}`).toBeLessThan(
        300,
    );
}

test.describe('Deploy providers list + validate-token facade contract (gaps: envelope/order, key-shape, id-matching, body-agnostic, per-user isolation, auth/method)', () => {
    test('1. GET /providers returns the success envelope with the two built-in providers in the stable order [k8s, vercel], each row carrying a boolean user-scoped `configured` axis (false for a fresh user)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        const providers = await listProviders(request, access_token);
        expect(
            providers.length,
            'at least the two built-in deploy providers ship',
        ).toBeGreaterThanOrEqual(2);

        // The deploy-picker UI relies on a STABLE leading order: k8s before vercel.
        const ids = providers.map((p) => p.id);
        expect(ids).toContain('k8s');
        expect(ids).toContain('vercel');
        expect(
            ids.indexOf('k8s'),
            'k8s is listed before vercel (stable provider ordering)',
        ).toBeLessThan(ids.indexOf('vercel'));

        // Every row carries the boolean per-user `configured` axis (the list is
        // getAvailableProvidersForUser, not a static catalog).
        for (const p of providers) {
            expect(typeof p.configured, `${p.id}.configured is a boolean (user-scoped)`).toBe(
                'boolean',
            );
            expect(typeof p.enabled, `${p.id}.enabled is a boolean`).toBe('boolean');
        }

        // A brand-new user has supplied no token -> no provider is configured for them.
        // (Tolerate a pre-configured stack by asserting the count, not each row.)
        const configuredCount = providers.filter((p) => p.configured === true).length;
        expect(configuredCount, 'a fresh user has zero configured deploy providers').toBe(0);
    });

    test('2. GET /providers/:id/configured has a BRANCH-DEPENDENT key shape: a KNOWN provider carries {status,configured,available,enabled,message} with available+enabled true; an UNKNOWN id carries {status,configured,available,message} WITHOUT an `enabled` key', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // KNOWN provider branch: includes the `enabled` discriminator.
        const known = await providerConfigured(request, access_token, 'vercel');
        expect(known.status).toBe('success');
        expect(known.available).toBe(true);
        expect(known.enabled).toBe(true);
        expect(typeof known.configured).toBe('boolean');
        expect(typeof known.message).toBe('string');
        expect(Object.keys(known).sort()).toEqual(
            ['available', 'configured', 'enabled', 'message', 'status'].sort(),
        );

        // UNKNOWN provider branch: NO `enabled` key (the controller returns early before
        // the enabled check), available:false, configured:false.
        const unknown = await providerConfigured(
            request,
            access_token,
            `nope-${test.info().title.length}-zzz`,
        );
        expect(unknown.status).toBe('success');
        expect(unknown.available, 'unknown provider is not available').toBe(false);
        expect(unknown.configured).toBe(false);
        expect(String(unknown.message)).toMatch(/not available/i);
        expect(
            Object.prototype.hasOwnProperty.call(unknown, 'enabled'),
            'the not-available branch omits the `enabled` key entirely',
        ).toBe(false);
        expect(Object.keys(unknown).sort()).toEqual(
            ['available', 'configured', 'message', 'status'].sort(),
        );
    });

    test('3. provider-id matching is CASE-SENSITIVE and NOT trimmed: lowercase `vercel` is available but `VERCEL` and a space-containing id are reported not-available — the resolver never canonicalises the requested id', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // Canonical lowercase id resolves to a real provider.
        const lower = await providerConfigured(request, access_token, 'vercel');
        expect(lower.available, 'lowercase `vercel` resolves to a real provider').toBe(true);

        // Upper-cased id does NOT match (case-sensitive registry lookup).
        const upper = await providerConfigured(request, access_token, 'VERCEL');
        expect(upper.available, 'id matching is case-sensitive: `VERCEL` is not available').toBe(
            false,
        );
        expect(String(upper.message)).toContain("'VERCEL'");

        // An id with an embedded space is not trimmed/normalised -> not available, and the
        // message echoes the raw (decoded) id verbatim.
        const spaced = await providerConfigured(request, access_token, 'foo bar');
        expect(spaced.available, 'a space-containing id is not normalised -> not available').toBe(
            false,
        );
        expect(String(spaced.message)).toContain("'foo bar'");
    });

    test('4. the `ever-works` READ alias resolves to the k8s provider on /configured: available+enabled true, configured mirrors k8s, and the message ECHOES the requested alias id verbatim (not the resolved k8s id)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        const alias = await providerConfigured(request, access_token, 'ever-works');
        expect(alias.status).toBe('success');
        expect(alias.available, "'ever-works' resolves to an available provider (k8s)").toBe(true);
        expect(alias.enabled).toBe(true);
        expect(typeof alias.configured).toBe('boolean');

        // The message echoes the REQUESTED id, never the resolved target id.
        expect(String(alias.message)).toContain("'ever-works'");
        expect(
            String(alias.message),
            'alias message does not leak the resolved k8s id',
        ).not.toContain("'k8s'");

        // The alias's configured axis agrees with its resolution target (k8s).
        const k8s = await providerConfigured(request, access_token, 'k8s');
        expect(alias.configured, "'ever-works' configured-state mirrors k8s").toBe(k8s.configured);
        expect(alias.available).toBe(k8s.available);
        expect(alias.enabled).toBe(k8s.enabled);
    });

    test('5. POST /validate-token IGNORES its request body entirely (no DTO): an empty body, a {providerId,token} body, an extra-key body, and NO body at all all yield the SAME success envelope with userInfo:null — there is no forbidNonWhitelisted 400', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        const empty = await validateToken(request, access_token, {});
        const withFields = await validateToken(request, access_token, {
            providerId: 'vercel',
            token: 'totally-fake-token',
        });
        const withBogus = await validateToken(request, access_token, {
            bogusKey: 123,
            nested: { a: 1 },
        });
        const noBody = await validateToken(request, access_token, undefined);

        for (const r of [empty, withFields, withBogus, noBody]) {
            expect([200, 201], `validate-token status ${r.status}`).toContain(r.status);
            expect(r.json.status).toBe('success');
            // The body is never validated, so an unknown key is NEVER a 400 (no DTO on this route).
            expect(typeof r.json.valid).toBe('boolean');
            expect(
                r.json.userInfo,
                'validate-token never returns userInfo on this stack',
            ).toBeNull();
            expect(typeof r.json.message).toBe('string');
        }

        // All four shapes agree on `valid` — proof the body had zero influence on the result.
        const validValues = [empty, withFields, withBogus, noBody].map((r) => r.json.valid);
        expect(
            new Set(validValues).size,
            'the request body does not change validate-token`s verdict',
        ).toBe(1);
    });

    test('6. validate-token reports provider-EXISTENCE, not a real token check, and flips false->true once THIS user configures a (fake) vercel token — but userInfo stays null because no real validation runs in keyless CI', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // BEFORE: a fresh user has no enabled+configured provider -> valid:false.
        const before = await validateToken(request, access_token, {});
        expect(before.json.status).toBe('success');
        const startedConfigured = before.json.valid === true;
        if (!startedConfigured) {
            expect(String(before.json.message)).toMatch(/No deployment provider/i);
        }

        // ACT: configure a deliberately FAKE vercel token (real Vercel rejects it, but the
        // *isConfigured* axis flips regardless — validate-token only asks "does an
        // enabled+configured provider EXIST for me", never "is the token real").
        await configureVercelToken(request, access_token);

        await expect
            .poll(async () => (await validateToken(request, access_token, {})).json.valid, {
                timeout: 15_000,
                message:
                    'validate-token flips valid:true once an enabled+configured provider exists',
            })
            .toBe(true);

        const after = await validateToken(request, access_token, {});
        expect(after.json.valid).toBe(true);
        // Even with valid:true, no real token validation ran -> userInfo stays null and the
        // message defers validation to deploy-time.
        expect(
            after.json.userInfo,
            'validate-token still surfaces no userInfo on a fake token',
        ).toBeNull();
        expect(String(after.json.message)).toMatch(/provider is available|will be validated/i);
    });

    test('7. validate-token and provider-configured are STRICTLY PER-USER: user B configuring a vercel token flips ONLY user B`s validate-token + providers-list + configured axis, while a freshly-registered user A stays valid:false / configured:false (no cross-user credential leak)', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);

        // Both start unconfigured (fresh users).
        expect((await validateToken(request, userA.access_token, {})).json.valid).toBe(false);
        expect((await validateToken(request, userB.access_token, {})).json.valid).toBe(false);

        // ACT: ONLY user B configures a (fake) vercel token.
        await configureVercelToken(request, userB.access_token);
        await expect
            .poll(async () => (await validateToken(request, userB.access_token, {})).json.valid, {
                timeout: 15_000,
            })
            .toBe(true);

        // User B sees the flip across validate-token + providers-list + configured.
        expect((await validateToken(request, userB.access_token, {})).json.valid).toBe(true);
        const bVercel = (await listProviders(request, userB.access_token)).find(
            (p) => p.id === 'vercel',
        );
        expect(bVercel?.configured, 'user B`s providers-list reflects the configured token').toBe(
            true,
        );
        expect((await providerConfigured(request, userB.access_token, 'vercel')).configured).toBe(
            true,
        );

        // User A — never touched — remains fully unconfigured: NO cross-user leak.
        expect(
            (await validateToken(request, userA.access_token, {})).json.valid,
            'user A`s validate-token is unaffected by user B`s token',
        ).toBe(false);
        const aVercel = (await listProviders(request, userA.access_token)).find(
            (p) => p.id === 'vercel',
        );
        expect(aVercel?.configured, 'user A`s providers-list stays unconfigured').toBe(false);
        expect(
            (await providerConfigured(request, userA.access_token, 'vercel')).configured,
            'user A`s per-provider configured stays false',
        ).toBe(false);
    });

    test('8. all three read endpoints are auth-gated by AuthSessionGuard: an anonymous request (explicit empty storageState) AND a garbage bearer token both get 401 on /providers, /providers/:id/configured, and /validate-token', async ({
        browser,
    }) => {
        // Anonymous: an EXPLICIT empty storageState so the context does not inherit the
        // shared seeded auth cookie from the project config.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonProviders = await anon.request.get(`${DEPLOY_BASE}/providers`);
            expect(anonProviders.status(), 'anon /providers is auth-guarded').toBe(401);

            const anonConfigured = await anon.request.get(
                `${DEPLOY_BASE}/providers/vercel/configured`,
            );
            expect(anonConfigured.status(), 'anon /configured is auth-guarded').toBe(401);

            const anonValidate = await anon.request.post(`${DEPLOY_BASE}/validate-token`, {
                data: {},
            });
            expect(anonValidate.status(), 'anon /validate-token is auth-guarded').toBe(401);

            // A GARBAGE bearer token is rejected exactly like anon (no partial trust).
            const garbage = { Authorization: 'Bearer not-a-real-token-deadbeef' };
            const gProviders = await anon.request.get(`${DEPLOY_BASE}/providers`, {
                headers: garbage,
            });
            expect(gProviders.status(), 'garbage-bearer /providers is 401').toBe(401);

            const gValidate = await anon.request.post(`${DEPLOY_BASE}/validate-token`, {
                headers: garbage,
                data: {},
            });
            expect(gValidate.status(), 'garbage-bearer /validate-token is 401').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('9. HTTP method routing is exact: POST /providers (a GET-only route) and GET /validate-token (a POST-only route) both 404 — the deploy facade does not silently accept the wrong verb', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // /providers is GET-only -> POST is an unmatched route (404).
        const postProviders = await request.post(`${DEPLOY_BASE}/providers`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(postProviders.status(), 'POST /providers is not a route (404)').toBe(404);

        // /validate-token is POST-only -> GET is an unmatched route (404).
        const getValidate = await request.get(`${DEPLOY_BASE}/validate-token`, {
            headers: authedHeaders(access_token),
        });
        expect(getValidate.status(), 'GET /validate-token is not a route (404)').toBe(404);
    });

    test('10. the providers-list `configured` axis and the per-provider /configured probe are READ-THROUGHS of one credential model: for a configured user every list row agrees with its single-provider configured probe, and validate-token agrees with whether ANY row is configured', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await configureVercelToken(request, access_token);
        await expect
            .poll(
                async () => (await providerConfigured(request, access_token, 'vercel')).configured,
                {
                    timeout: 15_000,
                },
            )
            .toBe(true);

        const providers = await listProviders(request, access_token);

        // Each list row's `configured` must equal the single-provider probe for that id —
        // no drift between the aggregate list and the per-provider endpoint.
        for (const p of providers) {
            const probe = await providerConfigured(request, access_token, p.id);
            expect(
                probe.configured,
                `single-provider /configured for ${p.id} matches its providers-list row`,
            ).toBe(p.configured === true);
        }

        // validate-token's verdict equals "is any enabled+configured provider present" —
        // a derivation of the very same list.
        const anyConfigured = providers.some((p) => p.enabled && p.configured === true);
        const vt = await validateToken(request, access_token, {});
        expect(vt.json.valid, 'validate-token agrees with the providers-list configured axis').toBe(
            anyConfigured,
        );
        // We just configured vercel, so on every stack at least one provider is configured.
        expect(anyConfigured, 'the configured user has at least one configured provider').toBe(
            true,
        );
    });
});
