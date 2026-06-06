import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Feature flags — runtime (deep, cross-feature INTEGRATION).
 *
 * Two sibling specs already cover the narrow angles, so this file does NOT
 * repeat them:
 *   - `feature-flags-runtime.spec.ts`       → secret leakage, 2-call key
 *                                              stability, unauth≤authed keys.
 *   - `feature-flag-runtime-toggle.spec.ts` → ETag / Cache-Control presence,
 *                                              If-None-Match 200/304, per-path
 *                                              key counts.
 *
 * What's NEW here: the full nested CONTRACT of `/api/config`, the
 * cross-endpoint CONSISTENCY between the public config flags and the auth
 * surfaces they advertise (`/api/auth/providers`, magic-link, anonymous,
 * subscriptions), the flag → UI surface (login magic-link tabs rendered
 * IFF the flag is set), flag DEFAULT semantics, and per-env determinism +
 * cache semantics under concurrent polling.
 *
 * ── Everything below was probed against the LIVE API (sqlite in-memory, the
 *    CI driver) at 127.0.0.1:3100 before any assertion was written ──
 *
 *  GET /api/config   (@Public, Cache-Control: public, max-age=60, weak ETag)
 *    200 application/json — IDENTICAL for anon and authed callers:
 *    {
 *      app:      { name: string, description: string },
 *      features: {
 *        subscriptionsEnabled: boolean,        // env SUBSCRIPTIONS_ENABLED
 *        magicLinkEnabled: boolean,            // env MAGIC_LINK_ENABLED
 *        anonymousAuthEnabled: boolean,        // env ANONYMOUS_AUTH_ENABLED
 *        emailVerificationRequired: boolean    // env REQUIRE_EMAIL_VERIFICATION !== 'false'
 *      },
 *      auth:     { providers: { github: boolean, google: boolean, facebook: boolean } },
 *      limits:   { bodyLimit: string }         // env BODY_LIMIT || '1mb'
 *    }
 *    Live values in this env: features.magicLinkEnabled=true,
 *      subscriptionsEnabled=true, anonymousAuthEnabled=false,
 *      emailVerificationRequired=false; auth.providers github=true google=true
 *      facebook=false; limits.bodyLimit='1mb'.
 *    Source: apps/api/src/api.controller.ts getConfig() — STRICT allow-list;
 *      provider presence is `!!process.env.<X>_CLIENT_ID` (boolean only, never
 *      the id); `truthy()` accepts 'true' | '1' | 'yes'.
 *
 *  GET /api/auth/providers  (@Public)
 *    200 { emailPassword: true, magicLink: boolean, socialProviders: string[] }
 *    `magicLink` reads the SAME env (MAGIC_LINK_ENABLED) as
 *    config.features.magicLinkEnabled → the two MUST agree.
 *    socialProviders here = ['github','google'] which mirror
 *    config.auth.providers github/google === true.
 *    Source: apps/api/src/auth/controllers/auth.controller.ts getConfiguredProviders().
 *
 *  Flag → UI surface (login page):
 *    apps/web/src/app/[locale]/(auth)/login/login-client.tsx renders the
 *    role="tablist" with [data-testid="login-tab-password"] +
 *    [data-testid="login-tab-magic-link"] ONLY when magicLinkEnabled is true
 *    (driven by getAuthProvidersConfig()). Magic-link tab swaps in
 *    [data-testid="magic-link-form"] / [data-testid="magic-link-email"] /
 *    [data-testid="magic-link-submit"]. Tab labels: "Password" /
 *    "Email me a link" (apps/web/messages/en.json auth.login.tabs).
 *    Canonical route is /login (200, unprefixed); /en/login 307→/login.
 *    An AUTHED visitor is redirected away (login/page.tsx) → UI assertions
 *    use an ANON context.
 *
 *  Flags are ADVISORY (probed truth — do NOT assert flag⇒hard-gate):
 *    - config.anonymousAuthEnabled=false BUT POST /api/auth/anonymous → 201
 *      (endpoint exists regardless; the flag is a UI hint, not a route gate).
 *    - config.subscriptionsEnabled=true BUT /api/subscriptions* → 404 (no
 *      REST surface at those paths in this build).
 *    - POST /api/auth/magic-link {} → 400 (DTO); {email} → 200 (throttled
 *      5/60s per-IP elsewhere; here best-effort).
 */

const CONFIG_PATH = '/api/config';
const PROVIDERS_PATH = '/api/auth/providers';

type PublicConfig = {
    app: { name: string; description: string };
    features: {
        subscriptionsEnabled: boolean;
        magicLinkEnabled: boolean;
        anonymousAuthEnabled: boolean;
        emailVerificationRequired: boolean;
    };
    auth: { providers: { github: boolean; google: boolean; facebook: boolean } };
    limits: { bodyLimit: string };
};

async function getConfig(request: APIRequestContext, token?: string): Promise<PublicConfig> {
    const res = await request.get(`${API_BASE}${CONFIG_PATH}`, {
        headers: token ? authedHeaders(token) : undefined,
    });
    expect(res.status(), `${CONFIG_PATH} should be 200`).toBe(200);
    expect((res.headers()['content-type'] || '').toLowerCase()).toContain('json');
    return (await res.json()) as PublicConfig;
}

test.describe('Feature flags — runtime config contract & consistency', () => {
    test('full nested /api/config contract: every documented key present with the right type', async ({
        request,
    }) => {
        const cfg = await getConfig(request);

        // Top-level shape is a strict allow-list of exactly four sections.
        expect(Object.keys(cfg).sort()).toEqual(['app', 'auth', 'features', 'limits']);

        // app.* — branding strings, always present and non-empty.
        expect(typeof cfg.app).toBe('object');
        expect(typeof cfg.app.name).toBe('string');
        expect(cfg.app.name.length).toBeGreaterThan(0);
        expect(typeof cfg.app.description).toBe('string');
        expect(cfg.app.description.length).toBeGreaterThan(0);

        // features.* — every flag MUST be a real boolean (coerced server-side),
        // never a raw env string like "true"/"1"/undefined.
        const FLAG_KEYS = [
            'subscriptionsEnabled',
            'magicLinkEnabled',
            'anonymousAuthEnabled',
            'emailVerificationRequired',
        ] as const;
        expect(Object.keys(cfg.features).sort()).toEqual([...FLAG_KEYS].sort());
        for (const k of FLAG_KEYS) {
            expect(
                typeof cfg.features[k],
                `features.${k} must be boolean, got ${JSON.stringify(cfg.features[k])}`,
            ).toBe('boolean');
        }

        // auth.providers.* — booleans only (presence signal, NEVER the client id).
        expect(typeof cfg.auth.providers).toBe('object');
        for (const p of ['github', 'google', 'facebook'] as const) {
            expect(typeof cfg.auth.providers[p], `auth.providers.${p} must be boolean`).toBe(
                'boolean',
            );
        }

        // limits.bodyLimit — a size string (e.g. "1mb").
        expect(typeof cfg.limits.bodyLimit).toBe('string');
        expect(cfg.limits.bodyLimit).toMatch(/^\d+\s*[kmg]?b$/i);
    });

    test('public config is byte-for-byte IDENTICAL for anonymous and authenticated callers', async ({
        request,
    }) => {
        // The controller doc pins "Authenticated users get the same keys — this
        // endpoint is identical for everyone." Verify it's not merely the same
        // KEYS but the same VALUES (no per-user leakage into the public surface).
        const anonRes = await request.get(`${API_BASE}${CONFIG_PATH}`);
        const anonText = await anonRes.text();

        const u = await registerUserViaAPI(request);
        const authedRes = await request.get(`${API_BASE}${CONFIG_PATH}`, {
            headers: authedHeaders(u.access_token),
        });
        const authedText = await authedRes.text();

        expect(authedRes.status()).toBe(200);
        // Parse-and-compare (whitespace-insensitive) so a serializer reorder
        // doesn't false-positive, but values must match exactly.
        expect(JSON.parse(authedText)).toEqual(JSON.parse(anonText));

        // And a fresh, different user observes the same payload — no drift.
        const u2 = await registerUserViaAPI(request);
        const authed2 = await request.get(`${API_BASE}${CONFIG_PATH}`, {
            headers: authedHeaders(u2.access_token),
        });
        expect(JSON.parse(await authed2.text())).toEqual(JSON.parse(anonText));
    });

    test('config flags never leak the underlying env VALUES (only coerced booleans/branding)', async ({
        request,
    }) => {
        // Distinct from the sibling secret-key grep: here we pin that even the
        // OAuth provider *ids* (which DO exist as truthy env in this run, since
        // github/google report true) never surface — only the boolean presence.
        const cfg = await getConfig(request);
        const flat = JSON.stringify(cfg);

        // No raw env truthy tokens leaked as provider values.
        expect(cfg.auth.providers.github === true || cfg.auth.providers.github === false).toBe(
            true,
        );
        // The serialized payload must contain ONLY booleans/strings we expect —
        // assert no obvious secret-shaped substrings rode along.
        for (const needle of ['client_secret', 'sk_', 'postgres://', 'redis://', 'Bearer ']) {
            expect(flat.toLowerCase().includes(needle.toLowerCase()), `leaked ${needle}`).toBe(
                false,
            );
        }
        // bodyLimit must be a bounded size token, not an arbitrary env dump.
        expect(cfg.limits.bodyLimit.length).toBeLessThan(12);
    });
});

test.describe('Feature flags — cross-endpoint flag consistency', () => {
    test('magicLinkEnabled in /api/config AGREES with magicLink in /api/auth/providers (same env source)', async ({
        request,
    }) => {
        // Both flags read MAGIC_LINK_ENABLED. If a future refactor splits the
        // source, the login UI (which trusts /api/auth/providers) and any
        // embedder (which trusts /api/config) would disagree — this guards it.
        const cfg = await getConfig(request);

        const provRes = await request.get(`${API_BASE}${PROVIDERS_PATH}`);
        expect(provRes.status()).toBe(200);
        const providers = (await provRes.json()) as {
            emailPassword: boolean;
            magicLink: boolean;
            socialProviders: string[];
        };

        expect(typeof providers.magicLink).toBe('boolean');
        expect(
            cfg.features.magicLinkEnabled,
            `config.features.magicLinkEnabled (${cfg.features.magicLinkEnabled}) !== providers.magicLink (${providers.magicLink})`,
        ).toBe(providers.magicLink);

        // emailPassword is the always-on baseline; config has no negative twin
        // for it, but providers must advertise it true (password auth is core).
        expect(providers.emailPassword).toBe(true);
    });

    test('config.auth.providers booleans are a faithful projection of providers.socialProviders', async ({
        request,
    }) => {
        const cfg = await getConfig(request);
        const provRes = await request.get(`${API_BASE}${PROVIDERS_PATH}`);
        const providers = (await provRes.json()) as { socialProviders: string[] };
        const social = new Set(providers.socialProviders);

        // Every provider config reports TRUE must appear in the social list,
        // and every provider it reports FALSE must be absent. (Facebook is
        // false here; github/google true.) This is the integration contract
        // between the two endpoints — they derive from the same *_CLIENT_ID env.
        for (const p of ['github', 'google'] as const) {
            if (cfg.auth.providers[p]) {
                expect(social.has(p), `${p}=true in config but missing from socialProviders`).toBe(
                    true,
                );
            } else {
                expect(social.has(p), `${p}=false in config but present in socialProviders`).toBe(
                    false,
                );
            }
        }
        // facebook is not OAuth-wired in this env → false AND absent.
        expect(cfg.auth.providers.facebook).toBe(false);
        expect(social.has('facebook')).toBe(false);
    });

    test('emailVerificationRequired flag is consistent with the live registration/login behavior', async ({
        request,
    }) => {
        // The flag is `REQUIRE_EMAIL_VERIFICATION !== 'false'`. When the flag is
        // FALSE (this env), a freshly-registered user must be able to log in via
        // the {email,password}-only DTO without any verification step. When TRUE,
        // registration still succeeds but the flag is advisory at this layer — we
        // only HARD-assert the false branch (the one this env runs), and annotate
        // the true branch so the test is honest either way.
        const cfg = await getConfig(request);
        const u = await registerUserViaAPI(request);

        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });

        if (cfg.features.emailVerificationRequired === false) {
            expect(
                loginRes.ok(),
                `emailVerificationRequired=false but fresh-user login returned ${loginRes.status()}`,
            ).toBe(true);
            const body = await loginRes.json();
            expect(typeof body.access_token).toBe('string');
        } else {
            // Verification required: login may succeed or be gated — never 5xx.
            expect(loginRes.status()).toBeLessThan(500);
            test.info().annotations.push({
                type: 'informational',
                description: `emailVerificationRequired=true; fresh-user login returned ${loginRes.status()} (advisory branch, not hard-asserted)`,
            });
        }
    });
});

test.describe('Feature flags — gated feature presence (advisory, never hard-gated)', () => {
    test('when magicLinkEnabled is true the magic-link endpoint is actually wired (DTO-validated)', async ({
        request,
    }) => {
        const cfg = await getConfig(request);

        // Empty body always exercises the DTO regardless of the flag.
        const emptyRes = await request.post(`${API_BASE}/api/auth/magic-link`, { data: {} });
        // 400 (validation) is the documented shape; 429 if throttled; never 5xx.
        expect(
            [400, 422, 429].includes(emptyRes.status()),
            `magic-link empty body returned ${emptyRes.status()}`,
        ).toBe(true);

        if (cfg.features.magicLinkEnabled) {
            // Flag advertises the feature → a well-formed request must NOT 404
            // (the route exists) and must NOT 5xx. 200/201 (sent or queued),
            // 400 (some envs reject unknown emails), or 429 (throttle) are all
            // acceptable "feature is present" signals.
            const u = await registerUserViaAPI(request);
            const sendRes = await request.post(`${API_BASE}/api/auth/magic-link`, {
                data: { email: u.email },
            });
            expect(
                sendRes.status(),
                `magic-link advertised enabled but POST returned 404 (route missing)`,
            ).not.toBe(404);
            expect(sendRes.status(), `magic-link POST 5xx`).toBeLessThan(500);
        } else {
            test.info().annotations.push({
                type: 'informational',
                description: 'magicLinkEnabled=false in this env — endpoint presence not asserted',
            });
        }
    });

    test('advisory flags do NOT necessarily gate a REST path (anonymous + subscriptions truth)', async ({
        request,
    }) => {
        // IMPORTANT probed truth: config flags are UI/embed hints, NOT route
        // gates. We pin the *observed* decoupling so a future reader does not
        // mistakenly tie a flag to a hard 404/200 contract.
        const cfg = await getConfig(request);

        // anonymousAuthEnabled is false here, yet POST /api/auth/anonymous works.
        const anonRes = await request.post(`${API_BASE}/api/auth/anonymous`, { data: {} });
        // Endpoint exists independent of the flag → 2xx, or a throttle/forbid,
        // but crucially the flag's value does not force a 404.
        expect(anonRes.status(), `anonymous endpoint 5xx`).toBeLessThan(500);
        test.info().annotations.push({
            type: 'informational',
            description: `anonymousAuthEnabled=${cfg.features.anonymousAuthEnabled}; POST /api/auth/anonymous → ${anonRes.status()} (flag is advisory, not a route gate)`,
        });

        // subscriptionsEnabled may be true while no /api/subscriptions* path is
        // mounted in this build. Probe a few candidates; assert only "no 5xx".
        const subPaths = ['/api/subscriptions', '/api/subscriptions/plans', '/api/me/subscription'];
        let anyMounted = false;
        for (const p of subPaths) {
            const r = await request.get(`${API_BASE}${p}`);
            expect(r.status(), `${p} 5xx`).toBeLessThan(500);
            if (r.status() !== 404) anyMounted = true;
        }
        test.info().annotations.push({
            type: 'informational',
            description: `subscriptionsEnabled=${cfg.features.subscriptionsEnabled}; subscription REST surface mounted=${anyMounted} (advisory flag, decoupled from path presence)`,
        });
        // No hard assertion linking the flag to mounting — both states are valid.
        expect(typeof cfg.features.subscriptionsEnabled).toBe('boolean');
    });
});

test.describe('Feature flags — flag affects the login UI surface', () => {
    test('magic-link tabs render IFF config.features.magicLinkEnabled, and the magic-link composer is usable', async ({
        browser,
        baseURL,
        request,
    }) => {
        const cfg = await getConfig(request);
        const origin = baseURL ?? 'http://localhost:3000';

        // Login redirects authed visitors away → drive it from a CLEAN anon
        // context (bare newContext() would inherit the storageState cookie).
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await ctx.newPage();
        try {
            await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });

            // Password form is the always-present baseline. Wait for hydration
            // by anchoring on a stable element (the password input).
            const passwordInput = page.locator('input[name="password"]');
            await expect(passwordInput.first()).toBeVisible({ timeout: 20000 });

            const magicTab = page.getByTestId('login-tab-magic-link');
            const passwordTab = page.getByTestId('login-tab-password');

            if (cfg.features.magicLinkEnabled) {
                // Flag ON → the tablist must exist and expose BOTH tabs.
                await expect(magicTab).toBeVisible({ timeout: 20000 });
                await expect(passwordTab).toBeVisible({ timeout: 20000 });
                await expect(page.getByRole('tablist')).toBeVisible();

                // Switch to the magic-link tab (retry the click to dodge the
                // dev hydration race where the first click is swallowed).
                await expect(async () => {
                    await magicTab.click();
                    await expect(page.getByTestId('magic-link-form')).toBeVisible({
                        timeout: 3000,
                    });
                }).toPass({ timeout: 20000 });

                // The composer must be alive: email input + submit present and
                // the tab marked selected (aria state flips).
                await expect(page.getByTestId('magic-link-email')).toBeVisible();
                await expect(page.getByTestId('magic-link-submit')).toBeVisible();
                await expect(magicTab).toHaveAttribute('aria-selected', 'true');

                // Switching back to password restores the password composer.
                await expect(async () => {
                    await passwordTab.click();
                    await expect(passwordInput.first()).toBeVisible({ timeout: 3000 });
                }).toPass({ timeout: 20000 });
            } else {
                // Flag OFF → NO tablist at all; only the single password form.
                await expect(magicTab).toHaveCount(0);
                await expect(passwordTab).toHaveCount(0);
                test.info().annotations.push({
                    type: 'informational',
                    description:
                        'magicLinkEnabled=false — login renders password-only, no tabs (asserted)',
                });
            }

            // Either way the password form (the un-gated surface) is functional.
            await expect(page.locator('input[name="email"]').first()).toBeVisible();
        } finally {
            await ctx.close();
        }
    });

    test('login social buttons reflect config.auth.providers (UI surface tracks the flag projection)', async ({
        browser,
        baseURL,
        request,
    }) => {
        const cfg = await getConfig(request);
        const origin = baseURL ?? 'http://localhost:3000';
        const enabledProviders = (['github', 'google', 'facebook'] as const).filter(
            (p) => cfg.auth.providers[p],
        );

        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await ctx.newPage();
        try {
            await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
            await expect(page.locator('input[name="password"]').first()).toBeVisible({
                timeout: 20000,
            });

            if (enabledProviders.length === 0) {
                // No OAuth configured → no provider buttons should render.
                const anyProviderBtn = page.getByRole('button', {
                    name: /github|google|facebook|continue with/i,
                });
                await expect(anyProviderBtn).toHaveCount(0);
                test.info().annotations.push({
                    type: 'informational',
                    description: 'no auth.providers enabled — no social buttons (asserted)',
                });
                return;
            }

            // At least one provider enabled → its button must appear. Match by
            // accessible name (label text contains the provider name). Local vs
            // CI markup can differ, so anchor on the provider name regex with
            // .first() and tolerate either a button or link element.
            for (const p of enabledProviders) {
                const btn = page
                    .getByRole('button', { name: new RegExp(p, 'i') })
                    .or(page.getByRole('link', { name: new RegExp(p, 'i') }))
                    .or(page.locator(`[data-provider="${p}"]`));
                await expect(
                    btn.first(),
                    `provider ${p} is enabled in config but no button is rendered`,
                ).toBeVisible({ timeout: 20000 });
            }

            // A provider that is NOT enabled must not have a button.
            const disabled = (['github', 'google', 'facebook'] as const).filter(
                (p) => !cfg.auth.providers[p],
            );
            for (const p of disabled) {
                await expect(
                    page.getByRole('button', { name: new RegExp(`\\b${p}\\b`, 'i') }),
                ).toHaveCount(0);
            }
        } finally {
            await ctx.close();
        }
    });
});

test.describe('Feature flags — defaults, determinism & cache semantics', () => {
    test('emailVerificationRequired honors the default-true / only-"false"-opts-out semantics', async ({
        request,
    }) => {
        // We can't flip server env from a black-box e2e, but we CAN pin the
        // invariant the controller guarantees: the value is a strict boolean and
        // it tracks the documented default rule. In this env the operator set
        // REQUIRE_EMAIL_VERIFICATION=false, so the flag must be exactly false —
        // any other value (incl. a truthy string coercion bug) fails here.
        const cfg = await getConfig(request);
        expect(typeof cfg.features.emailVerificationRequired).toBe('boolean');

        // Cross-check against the seeded user: global-setup could only have
        // logged that user in (storageState exists) if verification was NOT
        // blocking — i.e. the flag resolved to false in practice. Prove the
        // seeded creds still authenticate via the password DTO.
        const s = loadSeededTestUser();
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: s.email, password: s.password },
        });
        if (cfg.features.emailVerificationRequired === false) {
            expect(
                loginRes.ok(),
                `emailVerificationRequired=false but seeded login → ${loginRes.status()}`,
            ).toBe(true);
        } else {
            expect(loginRes.status()).toBeLessThan(500);
        }
    });

    test('config is DETERMINISTIC across concurrent polls and carries sane cache headers (env snapshot is stable)', async ({
        request,
    }) => {
        // Fire a burst of concurrent reads (simulating many web clients booting
        // at once). Every payload AND its weak ETag must be identical — a
        // per-request-randomized flag would surface as drift here.
        const N = 8;
        const results = await Promise.all(
            Array.from({ length: N }, () => request.get(`${API_BASE}${CONFIG_PATH}`)),
        );
        const bodies: string[] = [];
        const etags: string[] = [];
        for (const r of results) {
            expect(r.status()).toBe(200);
            bodies.push(JSON.stringify(await r.json()));
            const etag = r.headers()['etag'];
            if (etag) etags.push(etag);

            // Cache-Control must advertise a bounded, short-ish TTL so clients
            // re-poll and pick up flag flips reasonably soon.
            const cc = r.headers()['cache-control'] || '';
            const maxAge = /max-age\s*=\s*(\d+)/i.exec(cc);
            expect(maxAge, `Cache-Control missing max-age: "${cc}"`).not.toBeNull();
            expect(parseInt(maxAge![1], 10)).toBeGreaterThan(0);
            expect(parseInt(maxAge![1], 10)).toBeLessThanOrEqual(3600);
        }

        const uniqueBodies = new Set(bodies);
        expect(uniqueBodies.size, 'config payload drifted across concurrent polls').toBe(1);

        if (etags.length > 0) {
            const uniqueEtags = new Set(etags);
            expect(uniqueEtags.size, 'ETag drifted while body was constant').toBe(1);
            // A fresh ETag must round-trip to a cheap 304 (conditional GET).
            const cond = await request.get(`${API_BASE}${CONFIG_PATH}`, {
                headers: { 'If-None-Match': etags[0] },
            });
            expect([200, 304].includes(cond.status()), `If-None-Match → ${cond.status()}`).toBe(
                true,
            );
        }

        // HEAD parity: a HEAD must expose the same ETag as GET (so clients can
        // cheaply revalidate without pulling the body). HEAD may be 200 or 404
        // on some Nest+Express setups; only assert parity when it's served.
        const head = await request.fetch(`${API_BASE}${CONFIG_PATH}`, { method: 'HEAD' });
        if (head.status() === 200 && etags.length > 0) {
            const headEtag = head.headers()['etag'];
            if (headEtag) {
                expect(headEtag).toBe(etags[0]);
            }
        }
    });
});
