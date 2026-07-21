import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-git-provider-connection-multistep — multi-step git-provider CONNECT
 * flows centred on the AUTHORIZE-URL / CONNECT-ENTRY / DISCONNECT lifecycle:
 * the GitHub OAuth authorize-URL env-sentinel contract, the three-way
 * provider-allowlist divergence, the plugin `connect/url` state-cookie mint
 * (even when unconfigured), and the DELETE-disconnect idempotency + route
 * locality. Everything is asserted at the API tier against the live stack.
 *
 * NON-DUPLICATION — the sibling git-provider specs already own:
 *   · flow-oauth-git-providers    → the social-login URL loop (state==url-state,
 *       redirect_uri regex, https, cookie==body-state HttpOnly+Path) ACROSS all
 *       advertised providers, the full CSRF callback negative matrix, and the
 *       fresh-user git-provider connection-status walk.
 *   · flow-plugin-git-provider    → the SINGLE-user full lifecycle (status →
 *       connect/url → ONE DELETE 204), the read-packages token track, the plugin
 *       callback code-before-creds gate, unknown-provider resolution
 *       (gitlab/bitbucket), work git-gating, and the web-tier callback redirect.
 *   · flow-git-providers-deep     → the LIST descriptor shape (configured:true,
 *       exactly-one-provider, key-set, structured icon), provider-id
 *       resolution case-sensitivity, and the connection↔list descriptor agreement.
 *   · flow-git-provider-connection→ two-user connection-record isolation + the
 *       "connected-as" identity ABSENCE UI + the settings/works UI auth gates.
 *
 * THIS file deliberately covers the genuinely-uncovered CONNECT/DISCONNECT
 * angles (each probed live @127.0.0.1:3100 before it was asserted):
 *   A. The GitHub authorize URL (`GET /api/oauth/github/url`, PUBLIC) carries the
 *      GitHub-OAuth ENV SENTINELS — host is EXACTLY github.com, path
 *      /login/oauth/authorize, client_id names github (`e2e-fake-github-client-id`),
 *      response_type=code, scope `read:user user:email`, redirect_uri ends
 *      /api/oauth/github/callback — plus the state↔cookie binding down to
 *      Max-Age=600 + SameSite=Lax (which the sibling loop does NOT pin), the
 *      SAME-provider state ROTATION (fresh nonce per mint), and GET-only 404.
 *   B. The three-way allowlist DIVERGENCE: /api/oauth/providers = {github,vercel}
 *      (items carry `name`), /api/git-providers = {github} only (items carry NO
 *      `name`), and the social-URL mint honours a NARROWER allowlist still —
 *      github/google → 200 (distinct per-provider shaping: google adds
 *      access_type=offline+prompt=consent), vercel/unknown → 400 "Unsupported
 *      OAuth provider".
 *   C. The plugin `connect/url` (auth-gated; anon→401) is env-adaptive (400 "not
 *      configured" here OR 200 {url,state}) but ALWAYS mints + sets the
 *      `ew_oauth_state` cookie — the mint runs BEFORE the credential lookup that
 *      throws, so even the 400 response carries the HttpOnly Path=/api/oauth
 *      cookie. The read-packages variant shares that behaviour.
 *   D. DISCONNECT (`DELETE /api/oauth/:p`) is auth-gated, IDEMPOTENT across many
 *      calls (204 each), a graceful no-op for an UNKNOWN provider (204), and
 *      route-LOCAL to the oauth controller — `DELETE /api/git-providers/github`
 *      is 404 (the git-provider controller is GET-only).
 *   E. A fresh user's connection is `{id,name,enabled,connected:false}` on the
 *      oauth view and connected:false WITHOUT any leaked identity fields on the
 *      git view; both views AGREE, and remain connected:false after an idempotent
 *      disconnect (post-disconnect stability across both views).
 *
 * Upstream github.com / accounts.google.com are NEVER contacted — every
 * assertion is about platform-side URL shaping and connection bookkeeping.
 */

const OAUTH_STATE_COOKIE = 'ew_oauth_state';
const PROVIDER = 'github';

/** Extract the `ew_oauth_state` cookie value from a raw Set-Cookie header. */
function parseStateCookie(setCookie: string | string[] | undefined): string | undefined {
    if (!setCookie) return undefined;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
        const match = header.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`));
        if (match) return match[1];
    }
    return undefined;
}

/**
 * The plugin-capability OAuth connect endpoints depend on a clientId/secret
 * credential set that is legitimately absent in CI. Recognise ONLY the known
 * "not configured" 400 so a genuinely broken endpoint still fails loudly.
 */
async function isUnconfiguredCreds(res: APIResponse): Promise<boolean> {
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
    return /not configured|credentials/i.test(message);
}

interface Connection {
    id?: string;
    name?: string;
    enabled?: boolean;
    connected?: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: string;
}

// ---------------------------------------------------------------------------
// A. The GitHub authorize-URL env-sentinel contract (`GET /api/oauth/github/url`)
// ---------------------------------------------------------------------------
test.describe('flow: GitHub authorize URL carries the OAuth env sentinels', () => {
    test('the URL is public and points at exactly github.com/login/oauth/authorize', async ({
        request,
    }) => {
        // No auth header — the social-login URL mint is a PUBLIC endpoint (the
        // login page fetches it before any session exists).
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/url`);
        expect(res.status(), 'github/url is public (200 without auth)').toBe(200);

        const body = await res.json();
        expect(typeof body.url, 'github/url returns a string url').toBe('string');
        expect(typeof body.state, 'github/url returns a string state').toBe('string');

        const parsed = new URL(body.url);
        expect(parsed.protocol, 'authorize URL is https').toBe('https:');
        expect(parsed.host, 'authorize host is exactly github.com (not a lookalike)').toBe(
            'github.com',
        );
        expect(parsed.pathname, 'authorize path is /login/oauth/authorize').toBe(
            '/login/oauth/authorize',
        );
    });

    test('the URL embeds the GitHub OAuth env sentinels (client_id, response_type, scope, redirect_uri)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/url`);
        expect(res.status(), 'github/url 200').toBe(200);
        const q = new URL((await res.json()).url).searchParams;

        // The GitHub OAuth client-id env sentinel must be present and clearly a
        // github id (this env wires `e2e-fake-github-client-id`).
        const clientId = q.get('client_id') ?? '';
        expect(clientId.length, 'client_id sentinel is present (env wired)').toBeGreaterThan(0);
        expect(clientId.toLowerCase(), 'client_id names github').toContain('github');

        expect(q.get('response_type'), 'authorization-code grant').toBe('code');

        // GitHub scope for login: read:user + user:email (order-insensitive).
        const scope = q.get('scope') ?? '';
        expect(scope, 'scope requests read:user').toContain('read:user');
        expect(scope, 'scope requests user:email').toContain('user:email');

        // redirect_uri targets the platform's own github callback route.
        const redirectUri = q.get('redirect_uri') ?? '';
        expect(redirectUri, 'redirect_uri targets the github callback route').toMatch(
            /\/api\/oauth\/github\/callback$/,
        );
    });

    test('state↔cookie binding: cookie value equals body.state and is HttpOnly, path-scoped, single-use', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/url`);
        expect(res.status(), 'github/url 200').toBe(200);
        const body = await res.json();

        // The state in the URL, the state in the body, and the state in the
        // Set-Cookie must all be the SAME nonce (the C-03 dual-channel binding).
        expect(
            new URL(body.url).searchParams.get('state'),
            'URL embeds the returned state (CSRF binding)',
        ).toBe(body.state);

        const setCookie = res.headers()['set-cookie'];
        expect(parseStateCookie(setCookie), 'ew_oauth_state cookie carries the same nonce').toBe(
            body.state,
        );

        const raw = String(setCookie);
        expect(raw, 'state cookie is HttpOnly').toContain('HttpOnly');
        expect(raw, 'state cookie scoped to /api/oauth').toContain('Path=/api/oauth');
        // Attributes the sibling social-loop does NOT pin: 10-minute single-use
        // TTL and a Lax same-site policy.
        expect(raw, 'state cookie has a 600s single-use TTL').toContain('Max-Age=600');
        expect(raw, 'state cookie is SameSite=Lax').toMatch(/SameSite=Lax/i);
    });

    test('repeated mints rotate the state nonce (a fresh, unique nonce per call)', async ({
        request,
    }) => {
        const first = await (await request.get(`${API_BASE}/api/oauth/${PROVIDER}/url`)).json();
        const second = await (await request.get(`${API_BASE}/api/oauth/${PROVIDER}/url`)).json();

        expect(typeof first.state, 'state is a string').toBe('string');
        expect(String(first.state).length, 'first state is a non-trivial nonce').toBeGreaterThan(
            20,
        );
        expect(first.state, 'a second mint rotates the state (never reused)').not.toBe(
            second.state,
        );
        // Both nonces are URL-safe base64 (no reserved chars that would break the
        // authorize URL query string).
        expect(first.state, 'state is url-safe base64').toMatch(/^[A-Za-z0-9_-]+$/);
        expect(second.state, 'state is url-safe base64').toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('the URL endpoint is GET-only — POST is not a route (404)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/oauth/${PROVIDER}/url`);
        expect(res.status(), 'POST github/url is not a route').toBe(404);
    });
});

// ---------------------------------------------------------------------------
// B. Provider-allowlist divergence across the three lists
// ---------------------------------------------------------------------------
test.describe('flow: provider-allowlist divergence (oauth caps vs git providers vs social-URL)', () => {
    test('the OAuth capability list advertises github AND vercel, each with a display name', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'oauth/providers 200 for a user').toBe(200);
        const body = await res.json();
        expect(body.configured, 'oauth caps report configured:true').toBe(true);

        const byId = new Map<string, Connection>(
            (body.providers as Connection[]).map((p) => [String(p.id), p]),
        );
        expect([...byId.keys()], 'github is a connectable oauth capability').toContain('github');
        expect([...byId.keys()], 'vercel is a connectable oauth capability').toContain('vercel');
        // The oauth-list item shape carries a display NAME (contrast the
        // git-provider list item asserted below).
        expect(byId.get('github')?.name, 'oauth github item carries a display name').toBe('GitHub');
        expect(byId.get('github')?.enabled, 'oauth github is enabled').toBe(true);
        expect(byId.get('vercel')?.enabled, 'oauth vercel is enabled').toBe(true);
    });

    test('the git-provider list is NARROWER: github only, and its item carries NO name key', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/git-providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'git-providers 200 for a user').toBe(200);
        const body = await res.json();

        const ids = (body.providers as Connection[]).map((p) => String(p.id));
        expect(ids, 'github is a git provider').toContain('github');
        // vercel is a deployment/oauth capability, NOT a git provider — the
        // git-provider allowlist is strictly narrower than the oauth one.
        expect(ids, 'vercel is NOT a git provider').not.toContain('vercel');

        const github = (body.providers as Connection[]).find((p) => p.id === 'github')!;
        // Contract contrast: the git-provider descriptor omits `name` (it carries
        // description/homepage/icon instead — see flow-git-providers-deep).
        expect('name' in github, 'git-provider github item has no name key').toBe(false);
        expect(github.enabled, 'git-provider github is enabled').toBe(true);
    });

    test('the social-URL mint honours a still-narrower allowlist: vercel and unknown ids are rejected', async ({
        request,
    }) => {
        // vercel IS an oauth capability, yet it has no social-login URL shaping —
        // the URL mint rejects it explicitly.
        const vercel = await request.get(`${API_BASE}/api/oauth/vercel/url`);
        expect(vercel.status(), 'vercel/url → 400 (no social-login shaping)').toBe(400);
        expect(String((await vercel.json()).message), 'vercel rejection names it').toMatch(
            /unsupported oauth provider/i,
        );

        const unknown = await request.get(`${API_BASE}/api/oauth/bitbucket/url`);
        expect(unknown.status(), 'unknown/url → 400').toBe(400);
        expect(String((await unknown.json()).message), 'unknown rejection is uniform').toMatch(
            /unsupported oauth provider/i,
        );
    });

    test('google is a distinct URL provider with google-specific query shaping', async ({
        request,
    }) => {
        // Proving the URL mint shapes each provider differently, not from one
        // hard-coded template: google targets a different host and adds
        // access_type=offline + prompt=consent that github does NOT carry.
        const res = await request.get(`${API_BASE}/api/oauth/google/url`);
        expect(res.status(), 'google/url 200 (env wires google too)').toBe(200);
        const parsed = new URL((await res.json()).url);
        expect(parsed.host, 'google authorize host is accounts.google.com').toBe(
            'accounts.google.com',
        );
        const q = parsed.searchParams;
        expect(q.get('access_type'), 'google requests offline access (refresh token)').toBe(
            'offline',
        );
        expect(q.get('prompt'), 'google forces the consent screen').toBe('consent');
        expect((q.get('client_id') ?? '').toLowerCase(), 'google client_id sentinel').toContain(
            'google',
        );
    });
});

// ---------------------------------------------------------------------------
// C. The plugin connect/url mints a state cookie even when unconfigured
// ---------------------------------------------------------------------------
test.describe('flow: plugin connect/url mints a state cookie even on the unconfigured 400', () => {
    test('connect/url is auth-gated (anon → 401)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connect/url`);
        expect(res.status(), 'connect/url rejects anon').toBe(401);
    });

    test('connect/url ALWAYS sets the ew_oauth_state cookie — the mint precedes the credential lookup', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        // Env-adaptive: 400 "not configured" here OR 200 {url,state} when the
        // plugin clientId/secret are wired. Never 5xx.
        expect(res.status(), `connect/url never 5xx (got ${res.status()})`).toBeLessThan(500);

        // CRITICAL contract: the state is server-minted (and the cookie set)
        // BEFORE the credential lookup that throws — so even the 400 response
        // carries a fresh HttpOnly, path-scoped state cookie.
        const setCookie = res.headers()['set-cookie'];
        const cookieState = parseStateCookie(setCookie);
        expect(cookieState, 'connect/url minted a state cookie regardless of outcome').toBeTruthy();
        expect(String(setCookie), 'minted cookie is HttpOnly').toContain('HttpOnly');
        expect(String(setCookie), 'minted cookie is scoped to /api/oauth').toContain(
            'Path=/api/oauth',
        );

        if (await isUnconfiguredCreds(res)) {
            expect(
                String((await res.json()).message),
                'unconfigured connect/url names the provider',
            ).toMatch(new RegExp(`not configured for provider: ${PROVIDER}`, 'i'));
        } else {
            expect(res.status(), 'configured connect/url 200').toBe(200);
            const body = await res.json();
            expect(body.url, 'configured connect/url points at github authorize').toMatch(
                /^https:\/\/github\.com\/login\/oauth\/authorize/i,
            );
            // When configured, the URL-embedded state must equal the cookie state.
            expect(
                new URL(body.url).searchParams.get('state'),
                'configured connect/url binds url state to the cookie',
            ).toBe(cookieState);
        }
    });

    test('the read-packages connect/url variant shares the mint-before-lookup cookie behaviour', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/oauth/${PROVIDER}/read-packages/connect/url`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status(), `read-packages connect/url never 5xx`).toBeLessThan(500);

        // Same server-minted state + cookie as the main connect/url.
        const cookieState = parseStateCookie(res.headers()['set-cookie']);
        expect(cookieState, 'read-packages connect/url also mints a state cookie').toBeTruthy();

        if (await isUnconfiguredCreds(res)) {
            expect(
                String((await res.json()).message),
                'unconfigured read-packages connect/url names the provider',
            ).toMatch(new RegExp(`not configured for provider: ${PROVIDER}`, 'i'));
        } else {
            expect(
                (await res.json()).url,
                'configured read-packages url points at github authorize',
            ).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/i);
        }
    });
});

// ---------------------------------------------------------------------------
// D. Disconnect idempotency + route-locality
// ---------------------------------------------------------------------------
test.describe('flow: disconnect (DELETE /api/oauth/:p) idempotency + route-locality', () => {
    test('disconnect is auth-gated (anon → 401)', async ({ request }) => {
        const res = await request.delete(`${API_BASE}/api/oauth/${PROVIDER}`);
        expect(res.status(), 'DELETE /api/oauth/github rejects anon').toBe(401);
    });

    test('disconnect is idempotent across many calls — three consecutive DELETEs each return 204', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        for (let i = 1; i <= 3; i++) {
            const res = await request.delete(`${API_BASE}/api/oauth/${PROVIDER}`, { headers: h });
            expect(res.status(), `DELETE #${i} → 204 (idempotent, never-connected user)`).toBe(204);
        }
    });

    test('disconnect for an UNKNOWN provider is a graceful 204 no-op', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.delete(`${API_BASE}/api/oauth/bitbucket`, {
            headers: authedHeaders(u.access_token),
        });
        // The disconnect endpoint tolerates an unknown provider id — it neither
        // 404s nor 5xxs; there is simply nothing to remove.
        expect(res.status(), 'unknown-provider disconnect → 204 no-op').toBe(204);
    });

    test('disconnect is route-LOCAL to the oauth controller — DELETE /api/git-providers/:p is 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // The git-provider controller is GET-only; the disconnect verb lives ONLY
        // on the oauth controller. Pin the 404 so a future route reshuffle can't
        // silently move the mutation onto the read-only surface.
        const res = await request.delete(`${API_BASE}/api/git-providers/${PROVIDER}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'DELETE /api/git-providers/github is not a route (404)').toBe(404);
    });
});

// ---------------------------------------------------------------------------
// E. Fresh-user connection status + post-disconnect stability (both views)
// ---------------------------------------------------------------------------
test.describe('flow: fresh-user connection status + post-disconnect stability', () => {
    test('the oauth connection view is exactly {id,name,enabled,connected:false} for a fresh user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'oauth connection 200').toBe(200);
        const body = (await res.json()) as Connection;
        expect(body.id, 'echoes provider id').toBe('github');
        expect(body.name, 'oauth connection carries the display name').toBe('GitHub');
        expect(body.enabled, 'github oauth is enabled').toBe(true);
        expect(body.connected, 'fresh user is NOT connected').toBe(false);
    });

    test('the git-provider connection view is connected:false and leaks NO identity fields', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'git-providers connection 200').toBe(200);
        const body = (await res.json()) as Connection;
        expect(body.id, 'echoes provider id').toBe('github');
        expect(body.connected, 'fresh user is NOT connected (git view)').toBe(false);
        // A disconnected descriptor must NOT fabricate an identity — the
        // username/email/avatarUrl/authMethod fields are only populated after a
        // successful getUser() on a live token.
        expect(body.username, 'no username on a disconnected git connection').toBeUndefined();
        expect(body.email, 'no email on a disconnected git connection').toBeUndefined();
        expect(body.avatarUrl, 'no avatarUrl on a disconnected git connection').toBeUndefined();
        expect(body.authMethod, 'no authMethod on a disconnected git connection').toBeUndefined();
    });

    test('both connection views AGREE the fresh user is disconnected', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const oauth = (await (
            await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, { headers: h })
        ).json()) as Connection;
        const git = (await (
            await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
                headers: h,
            })
        ).json()) as Connection;
        expect(oauth.connected, 'oauth view: disconnected').toBe(false);
        expect(git.connected, 'git view: disconnected').toBe(false);
        expect(oauth.connected, 'the two connection views agree').toBe(git.connected);
    });

    test('after an idempotent disconnect, both views still report connected:false', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Baseline.
        const before = (await (
            await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, { headers: h })
        ).json()) as Connection;
        expect(before.connected, 'starts disconnected').toBe(false);

        // Disconnect (a no-op for a never-connected user).
        expect(
            (await request.delete(`${API_BASE}/api/oauth/${PROVIDER}`, { headers: h })).status(),
            'disconnect 204',
        ).toBe(204);

        // Post-disconnect stability across BOTH views — a failed/no-op disconnect
        // never flips the connection to connected.
        const oauthAfter = (await (
            await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, { headers: h })
        ).json()) as Connection;
        const gitAfter = (await (
            await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
                headers: h,
            })
        ).json()) as Connection;
        expect(oauthAfter.connected, 'oauth view still disconnected after disconnect').toBe(false);
        expect(gitAfter.connected, 'git view still disconnected after disconnect').toBe(false);
    });
});

/**
 * Keep the APIRequestContext type import load-bearing for envs where the inline
 * helper signatures are tree-shaken by the linter.
 */
export type _GitProviderConnectFlowRequest = APIRequestContext;
