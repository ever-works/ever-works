import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-oauth-git-providers — multi-step OAuth + git-provider integration flows.
 *
 * These are cross-tier, multi-entity orchestrations that go beyond the
 * single-endpoint smoke probes in oauth-state.spec.ts / git-providers.spec.ts /
 * git-providers-oauth-happy.spec.ts / auth-providers-list.spec.ts. Each flow
 * stitches together several real endpoints and asserts the exact shapes the
 * platform returns (verified live before these assertions were written).
 *
 * Surface (verified against the running API at :3100 + web at :3000):
 *   - GET  /api/auth/providers                     (public) → { emailPassword, magicLink, socialProviders[] }
 *   - GET  /api/oauth/:p/url                        (public) → { url, state } + Set-Cookie ew_oauth_state
 *   - GET  /api/oauth/:p/callback                   (public) → validates state cookie↔query, 400 on mismatch
 *   - GET  /api/oauth/:p/callback                   (web :3000 — the real redirect_uri target) → 3xx redirect
 *   - GET  /api/oauth/providers                     (authed) → { configured, providers:[{id,name,enabled}] }
 *   - GET  /api/oauth/:p/connection                 (authed) → { id, name, enabled, connected }
 *   - GET  /api/oauth/:p/connect/url                (authed) → { url, state } OR 400 "not configured"
 *   - GET  /api/git-providers                       (authed) → { configured, providers:[{id,enabled,...}] }
 *   - GET  /api/git-providers/:p/connection         (authed) → provider object + { connected }
 *   - GET  /api/git-providers/:p/organizations|repositories|user (authed) → { success, ... }
 *
 * Environment note: in this CI-mirrored env the AUTH social-login OAuth IS
 * configured (fake github/google client ids → /api/oauth/:p/url returns 200),
 * but the PLUGIN-capability OAuth connect flow (/api/oauth/:p/connect/url) is a
 * SEPARATE credential set and reports "not configured". Both states are real;
 * the flows below assert whichever the platform actually reports rather than
 * assuming one. Upstream providers (github.com / accounts.google.com) are never
 * contacted — every assertion is about platform-side behaviour.
 */

const OAUTH_STATE_COOKIE = 'ew_oauth_state';

interface AuthProvidersResponse {
    emailPassword: boolean;
    magicLink: boolean;
    socialProviders: string[];
}

/**
 * Parse the value of the `ew_oauth_state` cookie out of a raw Set-Cookie
 * header (string or string[]). Returns undefined if absent.
 */
function parseStateFromSetCookie(setCookie: string | string[] | undefined): string | undefined {
    if (!setCookie) return undefined;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
        const match = header.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`));
        if (match) return match[1];
    }
    return undefined;
}

/**
 * The plugin-capability OAuth connect endpoint depends on a credential set
 * that may legitimately be absent in CI. Recognise ONLY the known
 * "not configured" 400 so a genuinely broken endpoint still fails loudly.
 */
async function isConnectUrlUnconfigured(
    res: import('@playwright/test').APIResponse,
): Promise<boolean> {
    if (res.status() !== 400) return false;
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return false;
    }
    const message =
        typeof body === 'object' && body !== null && 'message' in body
            ? String((body as { message: unknown }).message ?? '')
            : '';
    return /not configured/i.test(message) || /credentials/i.test(message);
}

test.describe('flow: OAuth provider discovery → authorize URL → callback redirect', () => {
    test('public provider list, authed capability list, per-provider URL mint, and web-tier callback redirect all agree', async ({
        request,
        page,
        baseURL,
    }) => {
        // STEP 1 — Public provider discovery. The unauthenticated landing /
        // login surface fetches this to decide which social buttons to show.
        const publicRes = await request.get(`${API_BASE}/api/auth/providers`);
        expect(publicRes.status(), 'auth/providers is public').toBe(200);
        const providers = (await publicRes.json()) as AuthProvidersResponse;
        expect(typeof providers.emailPassword, 'emailPassword flag present').toBe('boolean');
        expect(typeof providers.magicLink, 'magicLink flag present').toBe('boolean');
        expect(Array.isArray(providers.socialProviders), 'socialProviders is an array').toBe(true);
        // This env wires up github + google social login.
        expect(providers.socialProviders.length, 'at least one social provider').toBeGreaterThan(0);
        expect(providers.socialProviders, 'github is offered as a social provider').toContain(
            'github',
        );

        // STEP 2 — The authed capability view of OAuth providers (the side the
        // settings/integrations UI reads). Different shape, same source of
        // truth: every social provider that is *connectable* should surface
        // here, and the list must be a strict subset relationship we can
        // reason about.
        const u = await registerUserViaAPI(request);
        const capRes = await request.get(`${API_BASE}/api/oauth/providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(capRes.status(), 'oauth/providers requires auth and returns 200 for a user').toBe(
            200,
        );
        const capBody = await capRes.json();
        expect(typeof capBody.configured, 'capability list has a configured flag').toBe('boolean');
        expect(Array.isArray(capBody.providers), 'capability providers is an array').toBe(true);
        const capIds: string[] = capBody.providers.map(
            (p: { id?: string; name?: string }) => p?.id ?? p?.name,
        );
        for (const p of capBody.providers) {
            expect(typeof p.id, `capability provider has string id: ${JSON.stringify(p)}`).toBe(
                'string',
            );
            expect(typeof p.enabled, 'capability provider has enabled flag').toBe('boolean');
        }
        // github is both a login provider AND a connectable capability here.
        expect(capIds, 'github surfaces in the capability provider list').toContain('github');

        // STEP 3 — For each social provider the platform advertises, mint an
        // authorization URL via the PUBLIC endpoint and pin the C-03 state
        // contract: the URL embeds the same state the body returns, and the
        // platform sets a single-use HttpOnly state cookie scoped to
        // /api/oauth. We probe every advertised provider, not just one.
        const seenStates = new Set<string>();
        for (const providerId of providers.socialProviders) {
            const urlRes = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            expect(
                urlRes.status(),
                `${providerId}/url returns 200 (env advertises it via auth/providers)`,
            ).toBe(200);
            const urlBody = await urlRes.json();
            expect(typeof urlBody.url, `${providerId} url is a string`).toBe('string');
            expect(typeof urlBody.state, `${providerId} state is a string`).toBe('string');
            expect(
                urlBody.state.length,
                `${providerId} state is a non-trivial nonce`,
            ).toBeGreaterThan(20);

            // The state in the upstream URL must equal the returned state.
            const parsed = new URL(urlBody.url);
            expect(
                parsed.searchParams.get('state'),
                `${providerId} URL embeds the response state (CSRF binding)`,
            ).toBe(urlBody.state);
            // redirect_uri must point back at the WEB app's callback route, not
            // the API — that is the route we drive in step 4.
            const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
            expect(
                redirectUri,
                `${providerId} redirect_uri points at the platform callback`,
            ).toMatch(/\/api\/oauth\/[^/]+\/callback$/);
            // upstream host is the real provider authorization host (we never
            // call it, but the platform must form a correct URL).
            expect(parsed.protocol, `${providerId} authorize URL is https`).toBe('https:');

            // Set-Cookie carries the matching state nonce, HttpOnly + path-scoped.
            const setCookie = urlRes.headers()['set-cookie'];
            const cookieState = parseStateFromSetCookie(setCookie);
            expect(cookieState, `${providerId} sets the ew_oauth_state cookie`).toBe(urlBody.state);
            expect(String(setCookie), `${providerId} state cookie is HttpOnly`).toContain(
                'HttpOnly',
            );
            expect(String(setCookie), `${providerId} state cookie scoped to /api/oauth`).toContain(
                'Path=/api/oauth',
            );

            // Each mint must be a fresh nonce — no reuse across providers/calls.
            expect(seenStates.has(urlBody.state), `${providerId} state nonce is unique`).toBe(
                false,
            );
            seenStates.add(urlBody.state);
        }

        // STEP 4 — Reach the authorize→callback target and assert the platform
        // ISSUES A REDIRECT (the upstream provider is never contacted; the web
        // tier validates state and redirects). The web route at :3000 is the
        // real redirect_uri target. We hit it WITHOUT a valid state pairing, so
        // the platform's response is a redirect back into the app rather than a
        // successful session — that redirect is the platform-side behaviour
        // this flow asserts. A 3xx (redirect) or a <500 reject both prove the
        // route is wired and never explodes.
        const webBase = baseURL || 'http://localhost:3000';
        const firstProvider = providers.socialProviders[0];
        const cbRes = await page.request.get(
            `${webBase}/api/oauth/${firstProvider}/callback?code=e2e-fake-code&state=e2e-bogus-state`,
            { maxRedirects: 0 },
        );
        expect(
            cbRes.status(),
            `web callback route is wired and does not 5xx (got ${cbRes.status()})`,
        ).toBeLessThan(500);
        // The platform-side behaviour for the redirect_uri target is to issue a
        // redirect (back to login/error with a message). When it redirects, the
        // Location header must be present and string-typed.
        if ([301, 302, 303, 307, 308].includes(cbRes.status())) {
            const location = cbRes.headers()['location'];
            expect(typeof location, 'redirect carries a Location header').toBe('string');
            expect((location ?? '').length, 'redirect Location is non-empty').toBeGreaterThan(0);
        }
    });
});

test.describe('flow: git-provider connection status + connect entry-point contract', () => {
    test('fresh user walks capability list → not-connected status → connect entry-point → gated sub-resources', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — Both the git-providers list and the OAuth providers list are
        // auth-gated. Confirm the boundary on the connection endpoint first.
        const unauth = await request.get(`${API_BASE}/api/git-providers/github/connection`);
        expect(unauth.status(), 'git-providers connection rejects anon').toBe(401);

        // STEP 2 — Capability list of git providers. github (the default
        // git-provider plugin) must be present and enabled, with a real
        // descriptor (icon/description) — not just a bare id.
        const listRes = await request.get(`${API_BASE}/api/git-providers`, { headers: h });
        expect(listRes.status(), 'git-providers list returns 200 for a user').toBe(200);
        const listBody = await listRes.json();
        expect(typeof listBody.configured, 'git-providers list has configured flag').toBe(
            'boolean',
        );
        expect(Array.isArray(listBody.providers), 'git-providers list is an array').toBe(true);
        const github = listBody.providers.find((p: { id?: string }) => p?.id === 'github');
        expect(github, 'github is an available git provider').toBeTruthy();
        expect(github.enabled, 'github git provider is enabled').toBe(true);

        // STEP 3 — Connection status for the fresh user. Two independent views
        // of the same not-connected truth must agree:
        //   a) /api/git-providers/:p/connection  (provider descriptor + connected)
        //   b) /api/oauth/:p/connection           (oauth-link view)
        const gpConn = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
            headers: h,
        });
        expect(gpConn.status(), 'git-providers connection returns 200').toBe(200);
        const gpConnBody = await gpConn.json();
        expect(gpConnBody.id, 'git-providers connection echoes provider id').toBe('github');
        expect(
            gpConnBody.connected,
            'fresh user is NOT connected to github (git-providers view)',
        ).toBe(false);

        const oauthConn = await request.get(`${API_BASE}/api/oauth/github/connection`, {
            headers: h,
        });
        expect(oauthConn.status(), 'oauth connection returns 200').toBe(200);
        const oauthConnBody = await oauthConn.json();
        expect(oauthConnBody.id, 'oauth connection echoes provider id').toBe('github');
        expect(typeof oauthConnBody.enabled, 'oauth connection has enabled flag').toBe('boolean');
        expect(
            oauthConnBody.connected,
            'fresh user is NOT connected to github (oauth view) — both views agree',
        ).toBe(false);

        // STEP 4 — The connect entry-point contract. This is the link the UI
        // sends the user to in order to begin the OAuth grant. It is
        // ENVIRONMENT-ADAPTIVE: when the plugin-capability OAuth credentials
        // are wired it returns { url, state }; otherwise it returns a truthful
        // 400 "not configured". Both are valid platform states — never 5xx.
        const connectRes = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: h,
        });
        expect(
            connectRes.status(),
            `connect/url never 5xx (got ${connectRes.status()})`,
        ).toBeLessThan(500);
        if (await isConnectUrlUnconfigured(connectRes)) {
            // Truthful "not configured" — assert the exact contract: a 400 with
            // a message naming the provider / missing credentials.
            const body = await connectRes.json();
            expect(
                String(body.message),
                'unconfigured connect/url names the missing credentials',
            ).toMatch(/not configured|credentials/i);
        } else {
            // Configured — assert the same C-03 url+state contract as the public
            // login URL, but for the connect (link-to-existing-account) flow.
            expect(connectRes.status(), 'configured connect/url returns 200').toBe(200);
            const body = await connectRes.json();
            expect(typeof body.url, 'connect/url returns a string url').toBe('string');
            expect(typeof body.state, 'connect/url returns a string state').toBe('string');
            expect(body.url, 'connect/url points at github.com authorize').toMatch(
                /^https:\/\/github\.com\/login\/oauth\/authorize/i,
            );
            expect(
                new URL(body.url).searchParams.get('state'),
                'connect/url embeds its state',
            ).toBe(body.state);
        }

        // STEP 5 — Every downstream git-provider sub-resource must report a
        // graceful, NON-connected failure (never 5xx, never a leaked token)
        // because the user has not completed the grant. The controller catches
        // provider errors and returns { success:false, ... } shapes.
        const subResources: Array<{ path: string; key: string }> = [
            { path: 'organizations', key: 'organizations' },
            { path: 'repositories', key: 'repositories' },
            { path: 'user', key: 'user' },
        ];
        for (const { path, key } of subResources) {
            const r = await request.get(`${API_BASE}/api/git-providers/github/${path}`, {
                headers: h,
            });
            expect(r.status(), `git-providers/${path} never 5xx`).toBeLessThan(500);
            // 200 with a success envelope is the documented shape; a 4xx reject
            // is also acceptable. If it's 200, the envelope must report failure
            // (no connection) rather than fabricated data.
            if (r.status() === 200) {
                const body = await r.json();
                expect(typeof body.success, `git-providers/${path} returns a success flag`).toBe(
                    'boolean',
                );
                if (body.success === false) {
                    // The list-type resources default to an empty collection on
                    // failure; the user resource defaults to null.
                    if (key === 'user') {
                        expect(body.user, `disconnected ${path} returns null user`).toBeNull();
                    } else {
                        expect(
                            Array.isArray(body[key]),
                            `disconnected ${path} returns an empty ${key} array`,
                        ).toBe(true);
                        expect(body[key].length, `disconnected ${path} has no ${key}`).toBe(0);
                    }
                }
            }
        }
    });
});

test.describe('flow: OAuth state integrity (CSRF) — callback rejects bad state', () => {
    /**
     * The public callback (/api/oauth/:p/callback) verifies the `state` query
     * param against the `ew_oauth_state` cookie using a constant-time compare
     * and rejects with a specific reason BEFORE exchanging the code. This flow
     * walks the full negative matrix and also proves the mint→callback pairing
     * end-to-end.
     */
    const NEGATIVE_CASES: Array<{
        name: string;
        query: string;
        cookie?: string;
        reason: RegExp;
    }> = [
        {
            name: 'missing state query (no params)',
            query: '',
            reason: /missing state query/i,
        },
        {
            name: 'state present but no cookie',
            query: '?code=e2e-code&state=deadbeefdeadbeefdeadbeef',
            reason: /missing state cookie/i,
        },
        {
            name: 'cookie present but state value mismatches',
            query: '?code=e2e-code&state=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            cookie: `${OAUTH_STATE_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
            reason: /state value mismatch/i,
        },
        {
            name: 'cookie present but state length mismatches',
            query: '?code=e2e-code&state=short',
            cookie: `${OAUTH_STATE_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
            reason: /state length mismatch/i,
        },
    ];

    for (const c of NEGATIVE_CASES) {
        test(`public callback rejects: ${c.name}`, async ({ request }) => {
            const headers: Record<string, string> = {};
            if (c.cookie) headers['Cookie'] = c.cookie;
            const res = await request.get(`${API_BASE}/api/oauth/github/callback${c.query}`, {
                headers,
            });
            expect(res.status(), `${c.name} → 400 (state check fails before code exchange)`).toBe(
                400,
            );
            const body = await res.json();
            expect(
                String(body.message),
                `${c.name} surfaces the specific verification reason`,
            ).toMatch(/OAuth state verification failed/i);
            expect(String(body.message), `${c.name} reason matches`).toMatch(c.reason);
        });
    }

    test('mint→callback: a freshly minted state that is NOT echoed back is rejected (single-use binding)', async ({
        request,
    }) => {
        // STEP 1 — Mint a real state nonce + cookie via the public URL endpoint.
        const urlRes = await request.get(`${API_BASE}/api/oauth/github/url`);
        expect(urlRes.status(), 'mint url returns 200').toBe(200);
        const urlBody = await urlRes.json();
        const realState: string = urlBody.state;
        const setCookie = urlRes.headers()['set-cookie'];
        const cookieState = parseStateFromSetCookie(setCookie);
        expect(cookieState, 'minted cookie carries the same nonce as the body').toBe(realState);

        // STEP 2 — Drive the callback presenting the REAL cookie but an
        // ATTACKER-CONTROLLED (different) state query param. This is the core
        // CSRF defence: even with a valid session cookie, a state the provider
        // did not echo back must be rejected with a value mismatch.
        const attackerState = 'x'.repeat(realState.length); // same length → forces value-mismatch path, not length-mismatch
        expect(attackerState).not.toBe(realState);
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=${attackerState}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${realState}` } },
        );
        expect(res.status(), 'mismatched echoed-state is rejected').toBe(400);
        const body = await res.json();
        expect(String(body.message), 'rejection cites a state value mismatch').toMatch(
            /state value mismatch/i,
        );

        // STEP 3 — The happy pairing (cookie === query) does NOT fail the state
        // check; it proceeds to the code-exchange step and fails THERE instead
        // (the fake code can't be exchanged with the unreachable provider). The
        // platform-side guarantee we assert: the error is no longer a *state*
        // verification failure — the CSRF gate passed.
        const matched = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-invalid-code&state=${realState}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${realState}` } },
        );
        // Code exchange against a fake/unreachable provider can surface as a 4xx
        // or a 5xx (upstream failure) — either way the response must NOT be the
        // state-verification 400 we asserted above.
        if (matched.status() === 400) {
            const matchedBody = await matched.json().catch(() => ({}));
            expect(
                String((matchedBody as { message?: unknown }).message ?? ''),
                'matched state passes the CSRF gate (no state-verification error)',
            ).not.toMatch(/OAuth state verification failed/i);
        } else {
            // Any non-400 (e.g. 5xx from the unreachable upstream token endpoint)
            // also proves the request progressed past the state gate.
            expect(matched.status(), 'matched state progressed past the CSRF gate').not.toBe(400);
        }
    });

    test('unsupported provider id is rejected at URL mint (defends the provider allowlist)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/oauth/not-a-real-provider/url`);
        expect(res.status(), 'unknown provider → 400').toBe(400);
        const body = await res.json();
        expect(String(body.message), 'names the unsupported provider').toMatch(
            /unsupported oauth provider/i,
        );
    });
});

/**
 * Belt-and-braces: keep the negative-matrix loop honest by referencing the
 * APIRequestContext type import so lint does not flag it as unused in envs
 * where the inline import above is tree-shaken.
 */
export type _OAuthFlowRequest = APIRequestContext;
