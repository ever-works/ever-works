import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-git-providers-validation-matrix — an EXHAUSTIVE validation + authz
 * matrix for the OAUTH-PLUGIN capability controller
 * (`apps/api/src/plugins-capabilities/oauth/oauth.controller.ts`, the
 * `/api/oauth/*` surface) plus its coherence with the git-providers list.
 *
 * The value of THIS file is the `/api/oauth/:p/callback/plugins` C-03 state
 * gate examined as a full REASON matrix and a proven gate ORDER — angles the
 * sibling git-provider specs do NOT own.
 *
 * NON-DUPLICATION — the existing specs already own:
 *   · flow-oauth-git-providers          → the SOCIAL/auth `/api/oauth/:p/url` +
 *       `/api/oauth/:p/callback` loop and its CSRF negative matrix (a DIFFERENT
 *       route pair from the plugin `connect/url` + `callback/plugins` here).
 *   · flow-plugin-git-provider          → the single-user lifecycle, a
 *       code-before-creds gate touch, the read-packages track existence.
 *   · flow-git-provider-connection(-multistep) → per-user connection isolation,
 *       authorize-URL env sentinels, connect/url cookie mint (social route),
 *       DELETE idempotency + route locality, allowlist divergence.
 *   · flow-git-providers-deep           → the GIT-providers controller list
 *       shape, provider-id resolution, sub-resource envelope matrix.
 *   · git-providers-oauth-happy / github-app-surface → API smoke + github-app.
 *
 * THIS file deliberately covers the genuinely-uncovered angles on the PLUGIN
 * oauth controller:
 *   A. The `callback/plugins` state gate as a COMPLETE reason matrix — all five
 *      OAuthStateService.verify outcomes pinned by their exact reason string:
 *      'missing state query', 'missing state cookie', 'state length mismatch',
 *      'state value mismatch', and VALID (a self-consistent cookie==query pair
 *      passes the gate and falls through to the NEXT gate). The gate is STATELESS
 *      — it trusts cookie-vs-query equality, not a server-stored nonce — so an
 *      arbitrary matching pair that was never minted still passes state verify.
 *   B. The gate ORDER is code → state → creds: a missing/empty `code` yields
 *      'Authorization code is required' even when a perfectly valid state pair is
 *      supplied; a valid state pair then surfaces the creds gate
 *      ('OAuth credentials not configured for provider: github').
 *   C. The single-use CLEAR-cookie contract: any callback that REACHES state
 *      verification (i.e. code present) emits `Set-Cookie ew_oauth_state=; …
 *      Max-Age=0` regardless of outcome; a callback rejected at the earlier
 *      code gate emits NO Set-Cookie (verify never ran).
 *   D. The read-packages callback variant mirrors the SAME code/state gate matrix.
 *   E. `connect/url` MESSAGE matrix: a known-but-unconfigured provider →
 *      'OAuth credentials not configured for provider: github' (400); an unknown
 *      id → 'Plugin "<id>" not found' (400) — two DISTINCT 400 copies. The
 *      `ew_oauth_state` cookie is ALWAYS minted (mint runs before the credential
 *      lookup that throws), Max-Age=600, HttpOnly, SameSite=Lax, Path=/api/oauth,
 *      a fresh 43-char base64url nonce that rotates per call.
 *   F. The oauth PROVIDERS list + connection descriptor shape — {id,name,enabled}
 *      (carrying a `name`, and advertising github AND vercel), leaner than the
 *      git list item; case-SENSITIVE resolution to a synthetic Unknown.
 *   G. `oauth/:p/user` no-token envelope carries a provider-named error
 *      ('No valid token for provider github') and leaks no token.
 *   H. DELETE disconnect is a TOTAL idempotent no-op (204 for github/vercel/an
 *      unknown id, repeatable), and the full anon + bad-bearer + method-discipline
 *      boundary across the whole controller.
 *
 * EVERY status/message/cookie attribute below was PROBED against the LIVE stack
 * (API 127.0.0.1:3100 sqlite in-memory CI driver) before assertions were written.
 * Upstream github.com is NEVER contacted; no OAuth round-trip actually completes.
 *
 * PROBED CONTRACTS (live):
 *   POST   /api/auth/register { username(>=3), email, password }
 *            → { access_token, user:{id,email,username} }
 *   GET    /api/oauth/providers                        (authed) → 200
 *            { configured:true, providers:[{id:'github',name:'GitHub',enabled:true},
 *              {id:'vercel',name:'Vercel',enabled:true}] } (anon/bad-bearer 401)
 *   GET    /api/oauth/:p/connection                    (authed) → 200
 *            enabled p → {id,name,enabled:true,connected:false};
 *            non-exact/unknown id → {id:<verbatim>,name:'Unknown',enabled:false,connected:false}
 *   GET    /api/oauth/:p/connect/url                   (authed) →
 *            github → 400 'OAuth credentials not configured for provider: github';
 *            unknown → 400 'Plugin "<id>" not found'; ALWAYS Set-Cookie ew_oauth_state
 *            (Max-Age=600; HttpOnly; SameSite=Lax; Path=/api/oauth; 43-char nonce)
 *   GET    /api/oauth/:p/read-packages/connect/url     (authed) → same 400 matrix + cookie
 *   GET    /api/oauth/:p/callback/plugins              (authed) →
 *            no/empty code            → 400 'Authorization code is required' (NO Set-Cookie)
 *            code, no state           → 400 '…failed: missing state query'   (+clear cookie)
 *            code, state, no cookie   → 400 '…failed: missing state cookie'   (+clear cookie)
 *            code, state, len≠cookie  → 400 '…failed: state length mismatch'  (+clear cookie)
 *            code, state≠cookie (eq len) → 400 '…failed: state value mismatch'(+clear cookie)
 *            code, state==cookie      → passes gate → 400 creds-not-configured (+clear cookie)
 *   GET    /api/oauth/:p/callback/plugins/read-packages (authed) → same code/state gate matrix
 *   GET    /api/oauth/:p/user                          (authed, no token) → 200
 *            { success:false, user:null, error:'No valid token for provider <p>' }
 *   DELETE /api/oauth/:p                               (authed) → 204 (idempotent no-op)
 *   DELETE /api/oauth/:p/connection                    → 404 (NOT a route)
 *   POST   /api/oauth/providers | :p/callback/plugins | :p/connect/url → 404 (GET-only routes)
 *   GET    /api/git-providers                          (authed) → github only, item has NO name key
 *
 * ISOLATION: every test uses FRESH registerUserViaAPI() users — NEVER the shared
 * seeded user. All calls are read-only or idempotent (disconnect of a
 * never-connected provider is a 204 no-op), so no shared state is perturbed.
 * State-gate tests supply the `ew_oauth_state` cookie EXPLICITLY per-request and
 * never call connect/url first, so the fixture cookie jar stays empty and the
 * matrix is fully deterministic.
 */

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const OAUTH_STATE_COOKIE = 'ew_oauth_state';

interface OAuthProviderItem {
    id?: string;
    name?: string;
    enabled?: boolean;
    connected?: boolean;
}

interface ErrorBody {
    message?: string | string[];
    error?: string;
    statusCode?: number;
}

interface UserEnvelope {
    success?: boolean;
    user?: unknown;
    error?: string;
}

/** Flatten a Nest error `message` (string OR string[]) to one searchable string. */
function messageText(body: ErrorBody): string {
    const m = body?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

/** A github token must never appear in any payload we read back. */
function expectNoTokenLeak(text: string, label: string): void {
    expect(text, `${label} leaks no github token`).not.toMatch(/gh[pousr]_[A-Za-z0-9]{8,}/);
}

/** Pull the raw `ew_oauth_state` Set-Cookie header line off an APIResponse. */
function stateSetCookie(res: {
    headersArray(): Array<{ name: string; value: string }>;
}): string | undefined {
    return res
        .headersArray()
        .filter((h) => h.name.toLowerCase() === 'set-cookie')
        .map((h) => h.value)
        .find((v) => v.startsWith(`${OAUTH_STATE_COOKIE}=`));
}

// ---------------------------------------------------------------------------
// A. callback/plugins — the C-03 state-verification REASON matrix + gate order
// ---------------------------------------------------------------------------
test.describe('flow: callback/plugins state gate — the full reason matrix', () => {
    test('the code gate fires FIRST: a missing OR empty code is "Authorization code is required" even when a valid state pair is supplied, and emits NO clear-cookie (verify never ran)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const nonce = `only-a-code-check-${uniq()}`;

        // No code at all — earliest gate. State + a matching cookie are present,
        // yet the response is still the code error (proving code precedes state).
        const noCode = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?state=${nonce}`,
            { headers: { ...h, cookie: `${OAUTH_STATE_COOKIE}=${nonce}` } },
        );
        expect(noCode.status(), 'callback with no code → 400').toBe(400);
        expect(messageText(await noCode.json()), 'no-code → code-required message').toMatch(
            /Authorization code is required/i,
        );
        // verify() never ran, so the controller queued no clear-cookie.
        expect(
            stateSetCookie(noCode),
            'no-code path emits NO ew_oauth_state Set-Cookie',
        ).toBeUndefined();

        // Empty code (`code=`) is falsy → same code gate, again before state.
        const emptyCode = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=&state=${nonce}`,
            { headers: { ...h, cookie: `${OAUTH_STATE_COOKIE}=${nonce}` } },
        );
        expect(emptyCode.status(), 'callback with empty code → 400').toBe(400);
        expect(messageText(await emptyCode.json()), 'empty-code → code-required message').toMatch(
            /Authorization code is required/i,
        );
        expect(
            stateSetCookie(emptyCode),
            'empty-code path emits NO ew_oauth_state Set-Cookie',
        ).toBeUndefined();
    });

    test('code present, state query absent OR empty → "missing state query" (a clear-cookie is now emitted because verify ran)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        for (const query of ['code=abc123', 'code=abc123&state=']) {
            const res = await request.get(
                `${API_BASE}/api/oauth/github/callback/plugins?${query}`,
                {
                    headers: h,
                },
            );
            expect(res.status(), `[${query}] → 400`).toBe(400);
            expect(messageText(await res.json()), `[${query}] → missing state query`).toMatch(
                /state verification failed: missing state query/i,
            );
            // verify() ran → the single-use cookie is cleared regardless of outcome.
            const clear = stateSetCookie(res);
            expect(clear, `[${query}] emits a clear ew_oauth_state cookie`).toBeDefined();
            expect(String(clear), `[${query}] clear cookie is Max-Age=0`).toMatch(/Max-Age=0/i);
        }
    });

    test('code + state present but NO cookie → "missing state cookie"', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=abc123&state=some-state-${uniq()}`,
            { headers: h },
        );
        expect(res.status(), 'code + state, no cookie → 400').toBe(400);
        expect(messageText(await res.json()), 'no cookie → missing state cookie').toMatch(
            /state verification failed: missing state cookie/i,
        );
        expect(String(stateSetCookie(res)), 'still emits the clear cookie').toMatch(/Max-Age=0/i);
    });

    test('code + state + cookie of DIFFERENT length → "state length mismatch" (and a clear cookie)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=abc123&state=short`,
            {
                headers: {
                    ...h,
                    cookie: `${OAUTH_STATE_COOKIE}=a-much-longer-cookie-value-123456`,
                },
            },
        );
        expect(res.status(), 'length mismatch → 400').toBe(400);
        expect(messageText(await res.json()), 'unequal lengths → length mismatch').toMatch(
            /state verification failed: state length mismatch/i,
        );
        expect(String(stateSetCookie(res)), 'clear cookie present').toMatch(/Max-Age=0/i);
    });

    test('code + state + EQUAL-length but different cookie → "state value mismatch" (distinct from the length reason)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Two same-length (16-char) values that differ — exercises the equal-length
        // timing-safe branch that returns 'state value mismatch', NOT 'length mismatch'.
        const cookieVal = 'AAAAAAAAAAAAAAAA';
        const queryVal = 'BBBBBBBBBBBBBBBB';
        expect(cookieVal.length, 'the two values are the same length').toBe(queryVal.length);

        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=abc123&state=${queryVal}`,
            { headers: { ...h, cookie: `${OAUTH_STATE_COOKIE}=${cookieVal}` } },
        );
        expect(res.status(), 'value mismatch → 400').toBe(400);
        const msg = messageText(await res.json());
        expect(msg, 'equal length, different value → value mismatch').toMatch(
            /state verification failed: state value mismatch/i,
        );
        expect(msg, 'value mismatch is NOT reported as a length mismatch').not.toMatch(
            /length mismatch/i,
        );
    });

    test('a self-consistent cookie==state pair PASSES the stateless gate and falls through to the creds gate (proves order state → creds, and that verify trusts cookie/query equality not a server-stored nonce)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // This pair was NEVER minted by the server, yet because cookie === state the
        // stateless timing-safe compare passes. The request then advances PAST the
        // state gate to the credential lookup, which in this keyless env throws the
        // creds-not-configured 400. The DEFINING invariant: the failure is NO LONGER
        // a state-verification error.
        const shared = `never-minted-but-matching-${uniq()}`;
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=abc123&state=${shared}`,
            { headers: { ...h, cookie: `${OAUTH_STATE_COOKIE}=${shared}` } },
        );
        expect(res.status(), 'valid state → advances to creds gate → 400').toBe(400);
        const msg = messageText(await res.json());
        expect(msg, 'the state gate PASSED (no state-verification error)').not.toMatch(
            /state verification failed/i,
        );
        expect(msg, 'the NEXT gate (creds) is what fails in this env').toMatch(
            /credentials not configured for provider: github/i,
        );
        // Even on this pass-through path the single-use cookie is cleared.
        expect(String(stateSetCookie(res)), 'passing path still clears the cookie').toMatch(
            /Max-Age=0/i,
        );
    });
});

// ---------------------------------------------------------------------------
// D. read-packages callback variant mirrors the identical code/state gate
// ---------------------------------------------------------------------------
test.describe('flow: callback/plugins/read-packages mirrors the same code→state gate matrix', () => {
    test('the read-packages callback enforces code-first, then the same state reasons, then creds — a SEPARATE track sharing one gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const base = `${API_BASE}/api/oauth/github/callback/plugins/read-packages`;

        // code gate
        const noCode = await request.get(base, { headers: h });
        expect(noCode.status(), 'rp: no code → 400').toBe(400);
        expect(messageText(await noCode.json()), 'rp: code-required').toMatch(
            /Authorization code is required/i,
        );

        // missing state query
        const noState = await request.get(`${base}?code=abc123`, { headers: h });
        expect(messageText(await noState.json()), 'rp: missing state query').toMatch(
            /missing state query/i,
        );

        // missing cookie
        const noCookie = await request.get(`${base}?code=abc123&state=x-${uniq()}`, { headers: h });
        expect(messageText(await noCookie.json()), 'rp: missing state cookie').toMatch(
            /missing state cookie/i,
        );

        // valid pair → passes gate → creds 400 (proves the same order, distinct track)
        const shared = `rp-matching-${uniq()}`;
        const ok = await request.get(`${base}?code=abc123&state=${shared}`, {
            headers: { ...h, cookie: `${OAUTH_STATE_COOKIE}=${shared}` },
        });
        expect(ok.status(), 'rp: valid state → 400 creds').toBe(400);
        expect(messageText(await ok.json()), 'rp: gate passed → creds gate').toMatch(
            /credentials not configured for provider: github/i,
        );
    });
});

// ---------------------------------------------------------------------------
// E. connect/url — the message matrix + the always-minted cookie
// ---------------------------------------------------------------------------
test.describe('flow: connect/url message matrix + the always-minted state cookie', () => {
    test('github connect/url is a truthful 400 not-configured in this env, YET still mints a fresh HttpOnly Path=/api/oauth state cookie (mint runs before the credential lookup that throws)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, { headers: h });
        expect(res.status(), 'github connect/url → 400 (no creds in this env)').toBe(400);
        expect(messageText(await res.json()), 'github → creds-not-configured copy').toMatch(
            /OAuth credentials not configured for provider: github/i,
        );

        // The cookie is minted DESPITE the 400 — the security state is established
        // before the throwing credential lookup.
        const cookie = stateSetCookie(res);
        expect(cookie, 'connect/url mints an ew_oauth_state cookie even on the 400').toBeDefined();
        const raw = String(cookie);
        expect(raw, 'cookie is Max-Age=600 (10-minute TTL)').toMatch(/Max-Age=600/i);
        expect(raw, 'cookie is HttpOnly').toMatch(/HttpOnly/i);
        expect(raw, 'cookie is SameSite=Lax').toMatch(/SameSite=Lax/i);
        expect(raw, 'cookie is scoped to Path=/api/oauth').toMatch(/Path=\/api\/oauth/i);
        // Non-prod env → NOT Secure (mint keys Secure off NODE_ENV=production).
        expect(raw, 'cookie is not Secure in this non-prod env').not.toMatch(/;\s*Secure/i);
        // The nonce is a 43-char base64url string (randomBytes(32).base64url).
        const nonce = raw.slice(`${OAUTH_STATE_COOKIE}=`.length).split(';')[0];
        expect(nonce, 'nonce is a 43-char base64url value').toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    test('an UNKNOWN provider id yields a DISTINCT 400 copy — \'Plugin "<id>" not found\' — not the creds message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const unknownId = `bitbucket-${uniq()}`;

        const res = await request.get(
            `${API_BASE}/api/oauth/${encodeURIComponent(unknownId)}/connect/url`,
            { headers: h },
        );
        expect(res.status(), 'unknown provider connect/url → 400').toBe(400);
        const msg = messageText(await res.json());
        expect(msg, 'unknown → plugin-not-found copy naming the verbatim id').toContain(
            `Plugin "${unknownId}" not found`,
        );
        expect(msg, 'unknown is NOT the creds-not-configured copy').not.toMatch(
            /credentials not configured/i,
        );
    });

    test('connect/url tolerates callbackUrl + forceConsent query params (true/false/garbage) — still 400 not-configured, still mints a cookie each time', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const variants = [
            'callbackUrl=https://app.example.com/cb',
            'forceConsent=true',
            'forceConsent=false',
            'forceConsent=notaboolean',
            'callbackUrl=https://app.example.com/cb&forceConsent=true',
        ];
        for (const q of variants) {
            const res = await request.get(`${API_BASE}/api/oauth/github/connect/url?${q}`, {
                headers: h,
            });
            expect(res.status(), `[${q}] → 400 (creds still gate)`).toBe(400);
            expect(messageText(await res.json()), `[${q}] → creds-not-configured`).toMatch(
                /credentials not configured for provider: github/i,
            );
            expect(stateSetCookie(res), `[${q}] still mints a state cookie`).toBeDefined();
        }
    });

    test('repeated connect/url mints ROTATE the nonce — a fresh, unique base64url value per call (single-use freshness)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const nonces = new Set<string>();
        for (let i = 0; i < 4; i++) {
            const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
                headers: h,
            });
            const raw = String(stateSetCookie(res));
            const nonce = raw.slice(`${OAUTH_STATE_COOKIE}=`.length).split(';')[0];
            expect(nonce, `mint #${i} is a 43-char base64url nonce`).toMatch(/^[A-Za-z0-9_-]{43}$/);
            nonces.add(nonce);
        }
        expect(nonces.size, 'every mint produced a distinct nonce').toBe(4);
    });

    test('read-packages/connect/url shares the SAME message matrix + cookie mint (a distinct token track, same gating)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const github = await request.get(`${API_BASE}/api/oauth/github/read-packages/connect/url`, {
            headers: h,
        });
        expect(github.status(), 'rp connect/url github → 400').toBe(400);
        expect(messageText(await github.json()), 'rp github → creds-not-configured').toMatch(
            /credentials not configured for provider: github/i,
        );
        expect(stateSetCookie(github), 'rp connect/url mints a cookie too').toBeDefined();

        const unknownId = `gitlab-${uniq()}`;
        const unknown = await request.get(
            `${API_BASE}/api/oauth/${encodeURIComponent(unknownId)}/read-packages/connect/url`,
            { headers: h },
        );
        expect(unknown.status(), 'rp connect/url unknown → 400').toBe(400);
        expect(messageText(await unknown.json()), 'rp unknown → plugin-not-found').toContain(
            `Plugin "${unknownId}" not found`,
        );
    });
});

// ---------------------------------------------------------------------------
// F. oauth providers list + connection descriptor shape (distinct from git list)
// ---------------------------------------------------------------------------
test.describe('flow: oauth providers list + connection descriptor shape', () => {
    test('the authed oauth list reports configured:true and advertises github AND vercel, each item a {id,name,enabled} triple — the item CARRIES a name key (unlike the git-providers list item)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const res = await request.get(`${API_BASE}/api/oauth/providers`, { headers: h });
        expect(res.status(), 'oauth providers → 200').toBe(200);
        const body = (await res.json()) as {
            configured?: boolean;
            providers?: OAuthProviderItem[];
        };
        expect(body.configured, 'configured:true').toBe(true);
        expect(Array.isArray(body.providers), 'providers is an array').toBe(true);

        const providers = body.providers ?? [];
        const ids = providers.map((p) => p.id);
        expect(ids, 'oauth list advertises github').toContain('github');
        expect(ids, 'oauth list ALSO advertises vercel (broader than the git list)').toContain(
            'vercel',
        );

        for (const item of providers) {
            expect(typeof item.name, `oauth item ${item.id} carries a string name`).toBe('string');
            expect(item.enabled, `oauth item ${item.id} is enabled`).toBe(true);
        }
        expect(
            providers.find((p) => p.id === 'github')?.name,
            'github oauth name is "GitHub"',
        ).toBe('GitHub');
        expect(
            providers.find((p) => p.id === 'vercel')?.name,
            'vercel oauth name is "Vercel"',
        ).toBe('Vercel');

        // The git-providers list is NARROWER and its item has NO name key — the two
        // controllers intentionally diverge in both roster AND item shape.
        const gitRes = await request.get(`${API_BASE}/api/git-providers`, { headers: h });
        const gitProviders = ((await gitRes.json()).providers ?? []) as OAuthProviderItem[];
        expect(
            gitProviders.map((p) => p.id),
            'git list is github-only (no vercel)',
        ).not.toContain('vercel');
        const gitGithub = gitProviders.find((p) => p.id === 'github');
        expect(gitGithub && 'name' in gitGithub, 'git-list github item has NO name key').toBe(
            false,
        );
    });

    test('the connection descriptor for an enabled provider is a lean {id,name,enabled:true,connected:false} (no icon/description) for both github and vercel', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        for (const [id, name] of [
            ['github', 'GitHub'],
            ['vercel', 'Vercel'],
        ]) {
            const res = await request.get(`${API_BASE}/api/oauth/${id}/connection`, { headers: h });
            expect(res.status(), `${id} connection → 200`).toBe(200);
            const body = (await res.json()) as OAuthProviderItem & { icon?: unknown };
            expect(body.id, `${id} connection echoes id`).toBe(id);
            expect(body.name, `${id} connection name`).toBe(name);
            expect(body.enabled, `${id} connection enabled:true`).toBe(true);
            expect(body.connected, `${id} fresh user → connected:false`).toBe(false);
            // The oauth connection is leaner than the git one — no rich icon object.
            expect(body.icon, `${id} oauth connection carries no icon object`).toBeUndefined();
        }
    });

    test('oauth connection resolution is EXACT-MATCH / case-sensitive: GITHUB / Github / "vercel " / gitlab all become the synthetic {name:Unknown, enabled:false, connected:false} echoing the verbatim id', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        for (const id of ['GITHUB', 'Github', 'vercel ', 'gitlab', `nope-${uniq()}`]) {
            const res = await request.get(
                `${API_BASE}/api/oauth/${encodeURIComponent(id)}/connection`,
                { headers: h },
            );
            expect(res.status(), `'${id}' connection → 200 (never 5xx)`).toBe(200);
            const body = (await res.json()) as OAuthProviderItem;
            expect(body.id, `'${id}' echoes the VERBATIM id`).toBe(id);
            expect(body.name, `'${id}' → synthetic Unknown`).toBe('Unknown');
            expect(body.enabled, `'${id}' → enabled:false`).toBe(false);
            expect(body.connected, `'${id}' → connected:false`).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// G. oauth/:p/user no-token envelope
// ---------------------------------------------------------------------------
test.describe('flow: oauth/:p/user no-token envelope', () => {
    test('a disconnected user gets 200 {success:false, user:null, error:"No valid token for provider <p>"} — the error NAMES the provider and leaks no token', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        for (const id of ['github', 'vercel']) {
            const res = await request.get(`${API_BASE}/api/oauth/${id}/user`, { headers: h });
            expect(res.status(), `${id}/user → 200 graceful envelope`).toBe(200);
            const body = (await res.json()) as UserEnvelope;
            expect(body.success, `${id}/user → success:false`).toBe(false);
            expect(body.user, `${id}/user → null user`).toBeNull();
            const err = String(body.error ?? '');
            expect(err, `${id}/user error names the provider + no-token`).toMatch(
                new RegExp(`No valid token for provider ${id}`, 'i'),
            );
            expect(err, `${id}/user error does not leak the caller's id`).not.toContain(u.user.id);
            expectNoTokenLeak(err, `${id}/user error`);
        }
    });
});

// ---------------------------------------------------------------------------
// H. disconnect idempotency + the whole-controller authz/method boundary
// ---------------------------------------------------------------------------
test.describe('flow: DELETE disconnect is a total idempotent no-op', () => {
    test('DELETE /api/oauth/:p is 204 for github, vercel AND an unknown id, and stays 204 on repeat — a never-connected disconnect never 404s or errors', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        for (const id of ['github', 'vercel', `unknown-${uniq()}`]) {
            const first = await request.delete(`${API_BASE}/api/oauth/${encodeURIComponent(id)}`, {
                headers: h,
            });
            expect(first.status(), `DELETE ${id} (never connected) → 204`).toBe(204);
            const again = await request.delete(`${API_BASE}/api/oauth/${encodeURIComponent(id)}`, {
                headers: h,
            });
            expect(again.status(), `DELETE ${id} again → 204 (idempotent)`).toBe(204);
        }
    });

    test("one user disconnecting github never perturbs another fresh user's connection view (per-user isolation of the no-op)", async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        expect(userA.user.id, 'two distinct users').not.toBe(userB.user.id);
        const hA = authedHeaders(userA.access_token);
        const hB = authedHeaders(userB.access_token);

        expect(
            (await request.delete(`${API_BASE}/api/oauth/github`, { headers: hA })).status(),
            'A disconnect github → 204',
        ).toBe(204);

        const bConn = await request.get(`${API_BASE}/api/oauth/github/connection`, { headers: hB });
        expect(bConn.status(), 'B connection still 200').toBe(200);
        expect(
            ((await bConn.json()) as OAuthProviderItem).connected,
            "B still connected:false — A's disconnect did not touch B",
        ).toBe(false);
    });
});

test.describe('flow: the whole oauth controller is auth-guarded (anon + bad bearer)', () => {
    const anonRoutes: Array<{ method: 'get' | 'delete'; path: string }> = [
        { method: 'get', path: '/api/oauth/providers' },
        { method: 'get', path: '/api/oauth/github/connection' },
        { method: 'get', path: '/api/oauth/github/connect/url' },
        { method: 'get', path: '/api/oauth/github/read-packages/connect/url' },
        { method: 'get', path: '/api/oauth/github/callback/plugins?code=abc123' },
        { method: 'get', path: '/api/oauth/github/callback/plugins/read-packages?code=abc123' },
        { method: 'get', path: '/api/oauth/github/user' },
        { method: 'delete', path: '/api/oauth/github' },
    ];

    test('every oauth route rejects an anonymous caller with 401 (no route slips the guard)', async ({
        request,
    }) => {
        for (const r of anonRoutes) {
            const res =
                r.method === 'get'
                    ? await request.get(`${API_BASE}${r.path}`)
                    : await request.delete(`${API_BASE}${r.path}`);
            expect(res.status(), `anon ${r.method.toUpperCase()} ${r.path} → 401`).toBe(401);
        }
    });

    test('every oauth route rejects an invalid bearer with 401 (a bogus token is no better than none)', async ({
        request,
    }) => {
        const bad = authedHeaders(`not-a-real-token-${uniq()}`);
        for (const r of anonRoutes) {
            const res =
                r.method === 'get'
                    ? await request.get(`${API_BASE}${r.path}`, { headers: bad })
                    : await request.delete(`${API_BASE}${r.path}`, { headers: bad });
            expect(res.status(), `bad-bearer ${r.method.toUpperCase()} ${r.path} → 401`).toBe(401);
        }
    });
});

test.describe('flow: oauth controller method discipline', () => {
    test('GET-only routes reject the wrong verb and the disconnect verb is route-LOCAL to :p (not :p/connection)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // providers, connect/url and the callbacks are GET-only.
        expect(
            (
                await request.post(`${API_BASE}/api/oauth/providers`, { headers: h, data: {} })
            ).status(),
            'POST /api/oauth/providers → 404',
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/oauth/github/connect/url`, {
                    headers: h,
                    data: {},
                })
            ).status(),
            'POST /api/oauth/:p/connect/url → 404 (GET-only)',
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/oauth/github/callback/plugins`, {
                    headers: h,
                    data: {},
                })
            ).status(),
            'POST /api/oauth/:p/callback/plugins → 404 (GET-only)',
        ).toBe(404);

        // The disconnect verb lives on :p, NOT on :p/connection — a look-alike
        // DELETE on the connection sub-path is not a route.
        expect(
            (
                await request.delete(`${API_BASE}/api/oauth/github/connection`, { headers: h })
            ).status(),
            'DELETE /api/oauth/:p/connection → 404 (disconnect is DELETE /api/oauth/:p)',
        ).toBe(404);
    });
});

/**
 * Keep the APIRequestContext type import load-bearing for envs where the inline
 * helper signatures are tree-shaken by the linter.
 */
export type _GitProvidersValidationMatrixRequest = APIRequestContext;
