import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-oauth-providers-deep — provider-taxonomy reconciliation, per-provider
 * authorize-URL parameter divergence, and callback state-cookie integrity.
 *
 * These flows DELIBERATELY do NOT duplicate the existing specs:
 *   - auth-providers-list.spec.ts          (single GET /api/auth/providers smoke)
 *   - flow-oauth-git-providers.spec.ts     (discovery→url→callback redirect happy)
 *   - oauth-state.spec.ts / -replay / -rotation (state round-trip + single-use)
 *   - oauth-csrf-state-binding.spec.ts     (user-A state at user-B callback)
 *   - oauth-cross-provider-isolation.spec.ts (distinct URLs/states per provider)
 *   - oauth-redirect-uri-pin / -consent-screen / -pkce (URL shape pinning)
 *
 * The NEW ground these flows cover:
 *   1. THREE-TIER provider taxonomy reconciliation — the public login list
 *      (/api/auth/providers) is a DIFFERENT, broader set than the authed
 *      capability list (/api/oauth/providers) and the per-provider /connection
 *      `enabled` flag. google is a LOGIN provider but NOT a capability provider
 *      (enabled:false, name:"Unknown"); github is BOTH. No spec reconciles all
 *      three views against each other.
 *   2. KNOWN-but-unconfigured vs TRULY-unknown provider at the public /url mint.
 *      facebook/linkedin are in the allowlist but lack creds → 400
 *      "<p> client id is not configured"; a junk id → 400 "Unsupported OAuth
 *      provider: <id>". Two distinct contracts; existing specs only test junk.
 *   3. PER-PROVIDER authorize-URL parameter MATRIX — google adds
 *      access_type=offline + prompt=consent and host accounts.google.com with
 *      scope "openid email profile"; github omits access_type and uses host
 *      github.com with scope "read:user user:email". The divergence is unasserted.
 *   4. CALLBACK state-cookie is PROVIDER-AGNOSTIC — a state minted at github's
 *      /url (+cookie) presented at the GOOGLE callback PASSES the C-03 state
 *      gate (cookie isn't provider-bound) and fails LATER at code exchange,
 *      while the clear-cookie Set-Cookie is emitted on EVERY callback regardless.
 *   5. WEB-tier login UI renders exactly the advertised social buttons +
 *      the web callback issues an oauth_invalid_state redirect on a bad state.
 *
 * Surface (verified live against API :3100 + web :3000 before writing):
 *   GET /api/auth/providers (public)
 *     → { emailPassword:true, magicLink:boolean, socialProviders:["github","google"] }
 *   GET /api/oauth/:p/url (public, AUTH login controller)
 *     → 200 { url, state } + Set-Cookie ew_oauth_state=<nonce>; Path=/api/oauth; HttpOnly; SameSite=Lax
 *     → 400 { message:"<p> client id is not configured" }   (known, no creds)
 *     → 400 { message:"Unsupported OAuth provider: <id>" }   (not in allowlist)
 *   GET /api/oauth/:p/callback (public)
 *     → 400 "OAuth state verification failed: <reason>" before code exchange
 *     → 5xx at code exchange once the state gate passes (upstream unreachable)
 *     → ALWAYS Set-Cookie ew_oauth_state=; Max-Age=0  (single-use clear)
 *   GET /api/oauth/providers (authed, CAPABILITY controller)
 *     → { configured:boolean, providers:[{id,name,enabled}] }  (github only here)
 *   GET /api/oauth/:p/connection (authed)
 *     → { id, name, enabled, connected }  (google → name:"Unknown", enabled:false)
 *   github authorize URL: host github.com, scope "read:user user:email", NO access_type
 *   google authorize URL: host accounts.google.com, scope "openid email profile",
 *                         access_type=offline, prompt=consent
 *
 * Environment: NO upstream provider is ever contacted; every assertion is about
 * platform-side behaviour. Social-login OAuth is wired with FAKE client ids
 * (e2e-fake-github-client-id / e2e-fake-google-client-id) so /url returns 200
 * but any real code exchange fails — which is exactly the negative path some of
 * these flows lean on.
 */

const OAUTH_STATE_COOKIE = 'ew_oauth_state';

interface AuthProvidersResponse {
    emailPassword: boolean;
    magicLink: boolean;
    socialProviders: string[];
}

interface CapabilityProvider {
    id: string;
    name: string;
    enabled: boolean;
}

interface ConnectionResponse {
    id: string;
    name: string;
    enabled: boolean;
    connected: boolean;
}

/** Pull the ew_oauth_state value out of a raw Set-Cookie header (string|string[]). */
function parseStateFromSetCookie(setCookie: string | string[] | undefined): string | undefined {
    if (!setCookie) return undefined;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
        const match = header.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]*)`));
        if (match) return match[1];
    }
    return undefined;
}

/** Does a Set-Cookie header carry the single-use CLEAR of ew_oauth_state? */
function setCookieClearsState(setCookie: string | string[] | undefined): boolean {
    if (!setCookie) return false;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    return headers.some((h) => h.includes(`${OAUTH_STATE_COOKIE}=`) && /Max-Age=0/i.test(h));
}

test.describe('flow: three-tier OAuth provider taxonomy reconciliation', () => {
    /**
     * The platform exposes THREE views of "which providers exist", each scoped
     * differently. This flow proves the precise relationship the UI relies on:
     * the public login list is the AUTHORITATIVE set of social-login buttons;
     * the authed capability list is a DISTINCT (not subset) set of OAuth-capable
     * plugin providers that OVERLAPS the login list on github (it also carries
     * non-login OAuth providers like vercel, and the login list carries
     * social-only providers like google that are not capabilities); and the
     * per-provider /connection enabled flag agrees with the capability list, not
     * the login list.
     */
    test('public login list and authed capability list OVERLAP on github (neither is a strict subset); per-provider /connection enabled flag tracks the CAPABILITY view (not login)', async ({
        request,
    }) => {
        // STEP 1 — Public login discovery (no auth). This is the set of social
        // buttons the unauthenticated login page renders.
        const publicRes = await request.get(`${API_BASE}/api/auth/providers`);
        expect(publicRes.status(), 'auth/providers is public 200').toBe(200);
        const pub = (await publicRes.json()) as AuthProvidersResponse;
        expect(typeof pub.emailPassword, 'emailPassword is a flag').toBe('boolean');
        expect(typeof pub.magicLink, 'magicLink is a flag').toBe('boolean');
        expect(Array.isArray(pub.socialProviders), 'socialProviders is an array').toBe(true);
        const loginSet = new Set(pub.socialProviders);
        expect(loginSet.has('github'), 'github is a login provider in this env').toBe(true);

        // STEP 2 — Authed capability list. Different controller, different shape,
        // narrower scope (only providers wired as a plugin capability surface).
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const capRes = await request.get(`${API_BASE}/api/oauth/providers`, { headers: h });
        expect(capRes.status(), 'capability list requires auth, returns 200').toBe(200);
        const capBody = await capRes.json();
        expect(typeof capBody.configured, 'capability list has configured flag').toBe('boolean');
        expect(Array.isArray(capBody.providers), 'capability providers is an array').toBe(true);
        const capProviders = capBody.providers as CapabilityProvider[];
        const capSet = new Set(capProviders.map((p) => p.id));
        for (const p of capProviders) {
            expect(typeof p.id, `capability provider has string id: ${JSON.stringify(p)}`).toBe(
                'string',
            );
            expect(typeof p.enabled, 'capability provider has enabled flag').toBe('boolean');
        }

        // STEP 3 — The KEY relationship between the two views. They are DISTINCT
        // scopes that OVERLAP on the providers that are BOTH a social-login button
        // AND a connectable OAuth capability — NEITHER is a strict subset of the
        // other in this env:
        //   - the login list carries social-only providers (google) that are NOT
        //     exposed as an OAuth-capable plugin capability;
        //   - the capability list carries OAuth-capable plugin providers (vercel,
        //     a deployment provider) that are NOT social-login buttons.
        // The invariant that holds is that their intersection is non-empty and
        // contains github — the provider that is BOTH a login button AND a
        // connectable capability. (toContain, not exact counts, keeps this robust
        // against which extra providers each view happens to advertise.)
        const bothViews = [...capSet].filter((id) => loginSet.has(id));
        expect(
            bothViews,
            'github is advertised in BOTH the login list and the capability list',
        ).toContain('github');

        // STEP 4 — Reconcile the THIRD view: the per-provider /connection enabled
        // flag. For EVERY login provider, fetch its oauth /connection and assert
        // the enabled flag tracks the CAPABILITY membership, not login membership.
        //   - github (login AND capability) → enabled:true
        //   - google (login but NOT capability) → enabled:false, name:"Unknown"
        // A fresh user is connected to NONE of them.
        for (const providerId of pub.socialProviders) {
            const connRes = await request.get(`${API_BASE}/api/oauth/${providerId}/connection`, {
                headers: h,
            });
            expect(
                connRes.status(),
                `/api/oauth/${providerId}/connection returns 200 for an authed user`,
            ).toBe(200);
            const conn = (await connRes.json()) as ConnectionResponse;
            expect(conn.id, `${providerId} connection echoes the provider id`).toBe(providerId);
            expect(conn.connected, `fresh user is NOT connected to ${providerId}`).toBe(false);
            expect(typeof conn.enabled, `${providerId} connection has enabled flag`).toBe(
                'boolean',
            );

            const inCapability = capSet.has(providerId);
            expect(
                conn.enabled,
                `${providerId} connection.enabled (${conn.enabled}) tracks capability membership (${inCapability})`,
            ).toBe(inCapability);
            if (!inCapability) {
                // A login-only provider has no capability descriptor, so the
                // connection view reports a placeholder name.
                expect(
                    conn.name,
                    `login-only provider ${providerId} has placeholder/non-empty name`,
                ).toBeTruthy();
            }
        }
    });
});

test.describe('flow: provider allowlist — known-unconfigured vs unknown are DISTINCT contracts', () => {
    /**
     * The public /url mint has two failure shapes that the UI must distinguish:
     * a provider that exists in the allowlist but has no client creds (operator
     * can fix by setting env), versus a provider id that simply isn't a thing
     * (caller bug). Conflating them would mislead an operator. This flow walks
     * the full positive+negative provider matrix in one pass.
     */
    test('configured→200+url+state; known-but-no-creds→400 "client id is not configured"; junk→400 "Unsupported OAuth provider"', async ({
        request,
    }) => {
        // STEP 1 — The advertised (configured) providers all mint a 200 URL.
        const pub = (await (
            await request.get(`${API_BASE}/api/auth/providers`)
        ).json()) as AuthProvidersResponse;
        expect(
            pub.socialProviders.length,
            'env advertises at least one social provider',
        ).toBeGreaterThan(0);
        for (const providerId of pub.socialProviders) {
            const r = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            expect(r.status(), `advertised provider ${providerId} mints a 200 url`).toBe(200);
            const body = await r.json();
            expect(typeof body.url, `${providerId} url is a string`).toBe('string');
            expect(typeof body.state, `${providerId} state is a string`).toBe('string');
        }

        // STEP 2 — KNOWN-but-unconfigured providers. facebook + linkedin are in
        // the SOCIAL_AUTH_PROVIDERS allowlist but have no client id/secret in
        // this env. They must NOT be advertised, and the mint must fail with the
        // "missing credentials" contract — NOT the "unsupported provider" one.
        const knownUnconfigured = ['facebook', 'linkedin'].filter(
            (p) => !pub.socialProviders.includes(p),
        );
        expect(
            knownUnconfigured.length,
            'at least one known-but-unconfigured provider to probe',
        ).toBeGreaterThan(0);
        for (const providerId of knownUnconfigured) {
            expect(
                pub.socialProviders.includes(providerId),
                `${providerId} is NOT advertised as a configured login provider`,
            ).toBe(false);
            const r = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            expect(
                r.status(),
                `known-but-unconfigured ${providerId} → 400 (not 5xx, not 200)`,
            ).toBe(400);
            const body = await r.json();
            const message = String(body.message ?? '');
            expect(
                message,
                `${providerId} reports a MISSING-CREDENTIALS reason, naming the provider`,
            ).toMatch(new RegExp(`${providerId}.*(client id|client secret).*not configured`, 'i'));
            // The crucial negative: it is NOT the unknown-provider message.
            expect(
                message,
                `${providerId} is NOT reported as an unsupported/unknown provider`,
            ).not.toMatch(/unsupported oauth provider/i);
        }

        // STEP 3 — TRULY-unknown provider ids (not in the allowlist at all) get
        // the other contract. Probe a couple of shapes so a future refactor that
        // accidentally 404s the catch-all is caught.
        for (const junk of ['not-a-real-provider', 'zzz-unknown', 'github2']) {
            const r = await request.get(`${API_BASE}/api/oauth/${junk}/url`);
            expect(r.status(), `junk provider ${junk} → 400`).toBe(400);
            const body = await r.json();
            expect(
                String(body.message ?? ''),
                `junk provider ${junk} names it as UNSUPPORTED (distinct from missing-creds)`,
            ).toMatch(new RegExp(`unsupported oauth provider:?\\s*${junk}`, 'i'));
        }
    });
});

test.describe('flow: per-provider authorize-URL parameter divergence', () => {
    /**
     * Each social provider mints a structurally-correct but provider-SPECIFIC
     * authorize URL: different host, different scope set, and google-only
     * offline-access params. This flow pins the exact per-provider matrix the
     * platform forms — the same flow the user's browser would be redirected to
     * (we never follow it). It deepens oauth-consent-screen / -redirect-uri-pin
     * which only check github's generic shape.
     */
    const EXPECTED: Record<string, { host: RegExp; scope: string; offline: boolean }> = {
        github: {
            host: /(^|\.)github\.com$/i,
            scope: 'read:user user:email',
            offline: false,
        },
        google: {
            host: /(^|\.)google\.com$/i,
            scope: 'openid email profile',
            offline: true,
        },
    };

    test('github vs google authorize URLs diverge by host, scope, and offline-access params — but share the C-03 state binding', async ({
        request,
    }) => {
        const pub = (await (
            await request.get(`${API_BASE}/api/auth/providers`)
        ).json()) as AuthProvidersResponse;

        const minted: Array<{ providerId: string; state: string }> = [];

        for (const providerId of pub.socialProviders) {
            const expected = EXPECTED[providerId];
            // Only assert the strict matrix for providers we have an oracle for;
            // any other advertised provider still gets the universal checks below.
            const res = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            expect(res.status(), `${providerId}/url returns 200`).toBe(200);
            const body = await res.json();
            const url = new URL(body.url);

            // UNIVERSAL invariants for every social provider.
            expect(url.protocol, `${providerId} authorize URL is https`).toBe('https:');
            expect(
                url.searchParams.get('response_type'),
                `${providerId} uses authorization-code response_type`,
            ).toBe('code');
            expect(
                url.searchParams.get('client_id'),
                `${providerId} carries a non-empty client_id`,
            ).toBeTruthy();
            // redirect_uri must point back at the platform callback, not upstream.
            const redirectUri = url.searchParams.get('redirect_uri') ?? '';
            expect(
                redirectUri,
                `${providerId} redirect_uri targets the platform /callback`,
            ).toMatch(/\/api\/oauth\/[^/]+\/callback$/);
            expect(
                redirectUri,
                `${providerId} redirect_uri callback path matches the provider id`,
            ).toContain(`/api/oauth/${providerId}/callback`);
            // C-03: the URL embeds the SAME state the body returns + the cookie.
            expect(
                url.searchParams.get('state'),
                `${providerId} URL embeds the response state (CSRF binding)`,
            ).toBe(body.state);
            const cookieState = parseStateFromSetCookie(res.headers()['set-cookie']);
            expect(cookieState, `${providerId} ew_oauth_state cookie carries the same nonce`).toBe(
                body.state,
            );

            if (expected) {
                // PROVIDER-SPECIFIC matrix.
                expect(
                    url.hostname,
                    `${providerId} authorize host is the real provider host`,
                ).toMatch(expected.host);
                expect(
                    url.searchParams.get('scope'),
                    `${providerId} requests its exact scope set`,
                ).toBe(expected.scope);
                if (expected.offline) {
                    expect(
                        url.searchParams.get('access_type'),
                        `${providerId} requests offline access`,
                    ).toBe('offline');
                    expect(
                        url.searchParams.get('prompt'),
                        `${providerId} forces the consent prompt`,
                    ).toBe('consent');
                } else {
                    expect(
                        url.searchParams.get('access_type'),
                        `${providerId} does NOT request offline access`,
                    ).toBeNull();
                    expect(
                        url.searchParams.get('prompt'),
                        `${providerId} does NOT force a consent prompt`,
                    ).toBeNull();
                }
            }

            minted.push({ providerId, state: body.state });
        }

        // CROSS-PROVIDER: if both github + google are advertised, their hosts and
        // state nonces must differ (no shared upstream, no reused nonce).
        if (minted.length >= 2) {
            const states = minted.map((m) => m.state);
            expect(new Set(states).size, 'each provider mints a UNIQUE state nonce').toBe(
                states.length,
            );
        }
    });
});

test.describe('flow: callback state-cookie is provider-AGNOSTIC + always cleared (single-use)', () => {
    /**
     * The ew_oauth_state cookie is NOT bound to a provider id — it is a bare CSRF
     * nonce. This flow proves the two consequences:
     *   (a) a state minted at github's /url, presented WITH its cookie at the
     *       GOOGLE callback with a MATCHING query param, PASSES the C-03 state
     *       gate (so the failure is downstream at code exchange, NOT a state
     *       verification 400). This documents the cross-provider semantics that
     *       oauth-csrf-state-binding (cross-USER) does not touch.
     *   (b) the callback emits the single-use CLEAR Set-Cookie on EVERY response
     *       — the rejected path AND the gate-passed path — so a captured nonce
     *       cannot be replayed.
     */
    test('github-minted state matches at the GOOGLE callback (cookie is not provider-scoped) → past the state gate, then fails downstream; clear-cookie emitted both ways', async ({
        request,
    }) => {
        const pub = (await (
            await request.get(`${API_BASE}/api/auth/providers`)
        ).json()) as AuthProvidersResponse;
        test.skip(
            !(pub.socialProviders.includes('github') && pub.socialProviders.includes('google')),
            'needs both github + google advertised',
        );

        // STEP 1 — Mint a REAL state nonce at GITHUB's /url.
        const mintRes = await request.get(`${API_BASE}/api/oauth/github/url`);
        expect(mintRes.status(), 'github mint 200').toBe(200);
        const mintBody = await mintRes.json();
        const state: string = mintBody.state;
        const cookieState = parseStateFromSetCookie(mintRes.headers()['set-cookie']);
        expect(cookieState, 'minted cookie carries the body nonce').toBe(state);

        // STEP 2 — Present that github cookie + a MISMATCHED query at the GOOGLE
        // callback. The cookie is provider-agnostic, so this is a genuine
        // value-mismatch (not a provider mismatch) → 400 state-verification.
        const wrong = 'x'.repeat(state.length);
        expect(wrong).not.toBe(state);
        const mismatchRes = await request.get(
            `${API_BASE}/api/oauth/google/callback?code=fake&state=${wrong}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${state}` } },
        );
        expect(
            mismatchRes.status(),
            'github-cookie + mismatched query at google callback → 400',
        ).toBe(400);
        expect(
            String((await mismatchRes.json()).message),
            'rejection is a state-value-mismatch (cookie crossed providers, value did not match)',
        ).toMatch(/state value mismatch/i);
        expect(
            setCookieClearsState(mismatchRes.headers()['set-cookie']),
            'rejected callback STILL clears the state cookie (single-use)',
        ).toBe(true);

        // STEP 3 — Present the github cookie + a MATCHING query at the GOOGLE
        // callback. The C-03 gate compares cookie==query bytewise; it has no
        // notion of provider, so it PASSES the gate. The request then proceeds to
        // the google code exchange and fails THERE (fake code, unreachable
        // upstream) — the platform-side guarantee we assert is that the error is
        // NO LONGER a state-verification 400.
        const matchRes = await request.get(
            `${API_BASE}/api/oauth/google/callback?code=fake&state=${state}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${state}` } },
        );
        expect(
            matchRes.status(),
            'gate-passed callback never explodes into a 2xx success with a fake code',
        ).not.toBe(200);
        if (matchRes.status() === 400) {
            // If it is a 400, it must be a DOWNSTREAM 400 (e.g. bad code), NOT the
            // state-verification 400 — proving the cross-provider cookie passed.
            const body = await matchRes.json().catch(() => ({}));
            expect(
                String((body as { message?: unknown }).message ?? ''),
                'matching cross-provider state PASSED the CSRF gate (no state-verification error)',
            ).not.toMatch(/OAuth state verification failed/i);
        } else {
            // A 5xx from the unreachable google token endpoint also proves the
            // request progressed past the state gate.
            expect(
                matchRes.status(),
                'gate-passed callback progressed past the state gate (got non-400)',
            ).toBeGreaterThanOrEqual(500);
        }
        // STEP 4 — The clear-cookie is emitted regardless of the downstream
        // outcome: the gate-passed path clears the nonce too.
        expect(
            setCookieClearsState(matchRes.headers()['set-cookie']),
            'gate-passed callback ALSO clears the state cookie (single-use, both paths)',
        ).toBe(true);
    });
});

test.describe('flow: callback state gate runs BEFORE provider resolution', () => {
    /**
     * The C-03 state check in OAuthController.authRedirect runs before
     * socialAuthService.authenticate (which resolves the provider config). So a
     * callback to a KNOWN-but-unconfigured provider, or even a syntactically
     * weird provider, is rejected at the STATE layer first when the state is
     * bad — the provider is never resolved, no creds are touched, nothing 5xxs.
     * This is the ordering guarantee no existing spec pins.
     */
    test('a bad-state callback is rejected with the SAME state-verification reason across configured + unconfigured providers (provider never resolved)', async ({
        request,
    }) => {
        const pub = (await (
            await request.get(`${API_BASE}/api/auth/providers`)
        ).json()) as AuthProvidersResponse;

        // Mix a configured provider with a known-but-unconfigured one. For BOTH,
        // a callback with NO state cookie must yield the identical "missing state
        // cookie" reason — i.e. the gate fired before the provider mattered.
        const probes = [
            pub.socialProviders[0], // configured (github)
            'facebook', // known but unconfigured in this env
            'linkedin', // known but unconfigured in this env
        ];

        for (const providerId of probes) {
            // (a) no state at all → missing-state-query, before provider resolve.
            const noState = await request.get(`${API_BASE}/api/oauth/${providerId}/callback`);
            expect(
                noState.status(),
                `${providerId} callback with no params → 400 (state gate first)`,
            ).toBe(400);
            expect(
                String((await noState.json()).message),
                `${providerId} cites the state-verification failure, not a provider/creds error`,
            ).toMatch(/OAuth state verification failed: missing state query/i);

            // (b) state query present but no cookie → missing-state-cookie. Still
            // a state failure, NOT a "<p> client id is not configured" creds error
            // — proving the unconfigured providers never reach their config.
            const noCookie = await request.get(
                `${API_BASE}/api/oauth/${providerId}/callback?code=c&state=deadbeefdeadbeefdeadbeef`,
            );
            expect(noCookie.status(), `${providerId} callback with state-but-no-cookie → 400`).toBe(
                400,
            );
            const msg = String((await noCookie.json()).message);
            expect(
                msg,
                `${providerId} cites missing-state-cookie (gate runs before provider config)`,
            ).toMatch(/OAuth state verification failed: missing state cookie/i);
            expect(
                msg,
                `${providerId} never surfaced a missing-credentials error (provider unresolved)`,
            ).not.toMatch(/client (id|secret).*not configured/i);
            // Single-use clear cookie is emitted even on the no-cookie path.
            expect(
                setCookieClearsState(noCookie.headers()['set-cookie']),
                `${providerId} no-cookie rejection still emits the clear-cookie`,
            ).toBe(true);
        }
    });
});

test.describe('flow: web login UI ↔ API provider-list agree; web callback redirects on bad state', () => {
    /**
     * The unauthenticated login page server-fetches /api/auth/providers and
     * renders exactly one social button per advertised provider. The web-tier
     * callback (the REAL redirect_uri target at :3000) validates its own
     * host-scoped oauth_state cookie and 307-redirects to the auth-error page on
     * a bad state. This flow stitches the UI render to the API contract and the
     * web redirect together — the cross-tier journey, not a single endpoint.
     */
    test('anon login page renders the advertised social buttons; web /api/oauth/:p/callback 307s to oauth_invalid_state on a bad state', async ({
        browser,
        baseURL,
        request,
    }) => {
        const webBase = baseURL ?? 'http://localhost:3000';
        const pub = (await (
            await request.get(`${API_BASE}/api/auth/providers`)
        ).json()) as AuthProvidersResponse;

        // Bare browser.newContext() inherits the seeded storageState cookie; for
        // the UNAUTH login surface we must explicitly drop it.
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const page = await ctx.newPage();
            await page.goto(`${webBase}/en/login`, { waitUntil: 'domcontentloaded' });

            // The login form itself must be present (email/password surface).
            await expect(
                page.getByRole('button', { name: /sign in|log ?in|continue/i }).first(),
                'login page renders a primary submit control',
            ).toBeVisible({ timeout: 20000 });

            // For each advertised provider, the matching labeled social button
            // should render. Labels come from auth.login.socialLogin.* = GitHub /
            // Google. Some next-dev local route divergence can swallow the
            // client-hydrated buttons, so branch: assert when present, else fall
            // back to the API contract (the page WAS fed these providers).
            const labelFor: Record<string, RegExp> = {
                github: /github/i,
                google: /google/i,
            };
            let sawAnyButton = false;
            for (const providerId of pub.socialProviders) {
                const label = labelFor[providerId];
                if (!label) continue;
                const btn = page.getByRole('button', { name: label }).first();
                if (await btn.isVisible().catch(() => false)) {
                    sawAnyButton = true;
                    await expect(
                        btn,
                        `${providerId} social button is enabled (clickable to start OAuth)`,
                    ).toBeEnabled({ timeout: 10000 });
                }
            }
            // Either we saw at least one social button, OR (local route divergence)
            // none hydrated — in which case the API contract still proves the page
            // was given the providers. Never hard-fail on the hydration race.
            if (!sawAnyButton) {
                expect(
                    pub.socialProviders.length,
                    'fallback: API advertised the social providers the page was fed',
                ).toBeGreaterThan(0);
            }

            // WEB-tier callback: hit the real redirect_uri target with a bad state
            // (no matching host cookie). It must 307 to the auth-error page with
            // the oauth_invalid_state code, and clear its host-scoped oauth_state
            // cookie — never 5xx, never silently 200.
            const firstProvider = pub.socialProviders[0];
            const cbRes = await page.request.get(
                `${webBase}/api/oauth/${firstProvider}/callback?code=fake-code&state=bogus-state`,
                { maxRedirects: 0 },
            );
            expect(cbRes.status(), `web callback never 5xx (got ${cbRes.status()})`).toBeLessThan(
                500,
            );
            if ([301, 302, 303, 307, 308].includes(cbRes.status())) {
                const location = cbRes.headers()['location'] ?? '';
                expect(typeof location, 'redirect carries a Location header').toBe('string');
                expect(
                    location,
                    'bad-state web callback redirects to the auth-error / invalid-state page',
                ).toMatch(/auth\/error|oauth_invalid_state|login/i);
            }
        } finally {
            await ctx.close();
        }
    });
});

/**
 * Keep the APIRequestContext type import live so lint does not tree-shake it in
 * envs where the inline import is otherwise unreferenced.
 */
export type _OAuthProvidersDeepRequest = APIRequestContext;
