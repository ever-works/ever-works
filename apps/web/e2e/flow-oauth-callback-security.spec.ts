import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * flow-oauth-callback-security — deep, multi-step OAuth login-callback
 * SECURITY flows centred on the server-minted `ew_oauth_state` CSRF nonce
 * and its single-use cookie binding. This file targets the AUTH social-login
 * surface (`apps/api/src/auth/controllers/oauth.controller.ts` +
 * `oauth-state.service.ts`) — NOT the plugin-capability `/connect/url`
 * surface that oauth-cross-provider-isolation / oauth-redirect-uri-pin /
 * oauth-state-rotation already cover.
 *
 * Deliberately NON-overlapping with flow-oauth-git-providers.spec.ts (which
 * already pins the negative state matrix + mint→callback value-mismatch +
 * unsupported-provider-at-MINT). The genuinely-uncovered angles asserted here:
 *
 *   1. The SINGLE-USE mechanism itself — every callback outcome emits the
 *      `ew_oauth_state=; Max-Age=0` clear-cookie (the actual replay defence;
 *      no existing spec asserts the clear-cookie at all).
 *   2. Cross-provider TOKEN CONFUSION — a github-minted cookie+state is
 *      accepted at the GOOGLE callback (the nonce is provider-agnostic), so
 *      confusion is prevented DOWNSTREAM by the per-provider client_id at the
 *      distinct authorize host, not by the state cookie.
 *   3. Provider ALLOWLIST is enforced AFTER the state gate at the CALLBACK
 *      (a matching cookie+state on an unsupported provider → 400 "Unsupported
 *      OAuth provider", never a state-error, never a 500).
 *   4. State-gate PRECEDENCE — when an input could trip several checks, the
 *      exact rejection-reason ordering is pinned (query → cookie → length →
 *      value → allowlist → exchange).
 *   5. redirect_uri + authorize-host PIN is per-provider and STABLE across
 *      repeated mints (github→github.com, google→accounts.google.com, web
 *      callback redirect_uri, never drifting to an attacker origin).
 *   6. Cookie hardening + nonce entropy — HttpOnly / Path=/api/oauth /
 *      SameSite=Lax / 10-min Max-Age, 43-char base64url nonce, no collisions
 *      across many mints (statistical replay resistance).
 *
 * VERIFIED LIVE against :3100 before these assertions were written:
 *   GET /api/oauth/:p/url           (public) → 200 { url, state }
 *                                     + Set-Cookie ew_oauth_state=<nonce>;
 *                                       Path=/api/oauth; Max-Age=600; HttpOnly;
 *                                       SameSite=Lax   (no Secure in dev)
 *   GET /api/oauth/:p/callback      (public):
 *      no state query              → 400 "...failed: missing state query"
 *      state query, no cookie      → 400 "...failed: missing state cookie"
 *      cookie len ≠ state len      → 400 "...failed: state length mismatch"
 *      cookie ≠ state (same len)   → 400 "...failed: state value mismatch"
 *      cookie === state, supported → 500 (code exchange vs fake provider creds)
 *      cookie === state, bad prov  → 400 "Unsupported OAuth provider: <id>"
 *      EVERY outcome               → Set-Cookie ew_oauth_state=; Max-Age=0 ...
 *   GET /api/oauth/bogus/url        → 400 "Unsupported OAuth provider: bogus"
 *
 * This env wires up github + google social login with FAKE client ids, so the
 * authorize URL forms correctly and the code-exchange step reaches a real but
 * unauthorised provider (→ 500). Upstream github.com / accounts.google.com are
 * NEVER contacted — every assertion is platform-side behaviour.
 */

const OAUTH_STATE_COOKIE = 'ew_oauth_state';

interface MintedState {
    state: string;
    url: string;
    setCookie: string;
}

/** Pull a named cookie's VALUE out of a raw Set-Cookie header (string|string[]). */
function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
    if (!setCookie) return undefined;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
        const match = header.match(new RegExp(`${name}=([^;]*)`));
        if (match) return match[1];
    }
    return undefined;
}

/** Coalesce the raw Set-Cookie header into a single string for attr matching. */
function setCookieString(setCookie: string | string[] | undefined): string {
    if (!setCookie) return '';
    return Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
}

/** Mint a real state nonce + matching cookie via the public /url endpoint. */
async function mintState(request: APIRequestContext, provider: string): Promise<MintedState> {
    const res = await request.get(`${API_BASE}/api/oauth/${provider}/url`);
    expect(res.status(), `${provider}/url mints a state (200)`).toBe(200);
    const body = await res.json();
    const setCookie = res.headers()['set-cookie'];
    const cookieState = cookieValue(setCookie, OAUTH_STATE_COOKIE);
    // The contract: body.state === URL state param === cookie value.
    expect(typeof body.state, `${provider} state is a string`).toBe('string');
    expect(cookieState, `${provider} cookie carries the body nonce`).toBe(body.state);
    return { state: body.state, url: body.url, setCookie: setCookieString(setCookie) };
}

async function jsonMessage(res: APIResponse): Promise<string> {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return String((body as { message?: unknown }).message ?? '');
}

test.describe('flow: OAuth callback single-use clear-cookie is the replay defence', () => {
    /**
     * The single-use guarantee is NOT server-side consumption tracking — it is
     * the callback unconditionally CLEARING the browser's state cookie
     * (Set-Cookie ew_oauth_state=; Max-Age=0) on EVERY codepath. A real browser
     * that completes one callback loses the cookie, so a second (replayed)
     * callback then fails at "missing state cookie". This flow proves the clear
     * fires across the full outcome matrix — happy, every rejection reason, and
     * the unsupported-provider branch — which no existing spec asserts.
     */
    test('every callback outcome emits the Max-Age=0 clear-cookie (single-use)', async ({
        request,
    }) => {
        // A real minted nonce so we can exercise the GUARD-PASSES branch too.
        const minted = await mintState(request, 'github');

        const outcomes: Array<{
            name: string;
            provider: string;
            query: string;
            cookie?: string;
            expectStatus: number;
        }> = [
            {
                name: 'missing state query',
                provider: 'github',
                query: '?code=e2e-code',
                expectStatus: 400,
            },
            {
                name: 'state query but no cookie',
                provider: 'github',
                query: '?code=e2e-code&state=deadbeefdeadbeefdeadbeefdeadbeef',
                expectStatus: 400,
            },
            {
                name: 'value mismatch (same length)',
                provider: 'github',
                query: '?code=e2e-code&state=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                cookie: `${OAUTH_STATE_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                expectStatus: 400,
            },
            {
                name: 'length mismatch',
                provider: 'github',
                query: '?code=e2e-code&state=short',
                cookie: `${OAUTH_STATE_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
                expectStatus: 400,
            },
            {
                name: 'guard PASSES → code exchange fails (matching cookie+state)',
                provider: 'github',
                query: `?code=e2e-invalid-code&state=${minted.state}`,
                cookie: `${OAUTH_STATE_COOKIE}=${minted.state}`,
                expectStatus: 500,
            },
        ];

        for (const o of outcomes) {
            const headers: Record<string, string> = {};
            if (o.cookie) headers['Cookie'] = o.cookie;
            const res = await request.get(
                `${API_BASE}/api/oauth/${o.provider}/callback${o.query}`,
                {
                    headers,
                },
            );
            expect(res.status(), `${o.name} → status ${o.expectStatus}`).toBe(o.expectStatus);
            // The defence: the cookie is cleared on this very response.
            const sc = setCookieString(res.headers()['set-cookie']);
            expect(sc, `${o.name} emits a Set-Cookie`).toContain(OAUTH_STATE_COOKIE);
            expect(sc, `${o.name} clears the state cookie (Max-Age=0)`).toMatch(/Max-Age=0\b/i);
            // Cleared cookie is still HttpOnly + path-scoped (can't be re-read or
            // scoped wider by an attacker reading the response).
            expect(sc, `${o.name} clear-cookie stays HttpOnly`).toContain('HttpOnly');
            expect(sc, `${o.name} clear-cookie stays scoped to /api/oauth`).toContain(
                'Path=/api/oauth',
            );
            // And the cleared value is empty — no stale nonce lingering.
            expect(
                cookieValue(res.headers()['set-cookie'], OAUTH_STATE_COOKIE),
                `${o.name} clear-cookie value is empty`,
            ).toBe('');
        }
    });

    test('a browser-faithful replay (cookie dropped after first callback) fails at "missing state cookie"', async ({
        request,
    }) => {
        // STEP 1 — mint a nonce and run the first callback WITH the cookie. The
        // guard passes (matching value) and the response clears the cookie.
        const minted = await mintState(request, 'github');
        const first = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=${minted.state}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${minted.state}` } },
        );
        // Matching state passed the CSRF gate → no state-verification error.
        expect(await jsonMessage(first), 'first callback passed the state gate').not.toMatch(
            /OAuth state verification failed/i,
        );
        const cleared = setCookieString(first.headers()['set-cookie']);
        expect(cleared, 'first callback clears the cookie').toMatch(/Max-Age=0\b/i);

        // STEP 2 — a faithful browser now has NO state cookie (it was cleared),
        // so a replayed callback presenting the SAME state query but no cookie is
        // rejected with the missing-cookie reason — the replay is dead.
        const replay = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=${minted.state}`,
        );
        expect(replay.status(), 'cookie-less replay is rejected 400').toBe(400);
        expect(await jsonMessage(replay), 'replay fails at the missing-cookie gate').toMatch(
            /missing state cookie/i,
        );
    });
});

test.describe('flow: cross-provider token confusion is prevented downstream, not by the nonce', () => {
    /**
     * The `ew_oauth_state` nonce is intentionally PROVIDER-AGNOSTIC (one cookie
     * name, no provider tag). So a github-minted cookie+state IS accepted at the
     * google callback's state gate. That is correct — confusion is prevented at
     * the EXCHANGE step: each provider uses its own client_id/secret against its
     * own token endpoint, and the authorize hosts are distinct. This flow proves
     * the truthful contract end-to-end (a fictional "nonce binds to provider"
     * contract would be wrong to assert).
     */
    test('github-minted nonce passes the google callback state gate but fails at the google exchange', async ({
        request,
    }) => {
        const minted = await mintState(request, 'github');

        // Replay the github nonce at the GOOGLE callback. The state gate compares
        // cookie===query and passes (provider-agnostic). It then proceeds to the
        // google code-exchange, which fails (fake creds / unreachable) → 500, NOT
        // a state-verification 400. That distinguishes "gate passed" from
        // "gate rejected".
        const crossed = await request.get(
            `${API_BASE}/api/oauth/google/callback?code=e2e-code&state=${minted.state}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${minted.state}` } },
        );
        expect(
            await jsonMessage(crossed),
            'cross-provider nonce passed the state gate',
        ).not.toMatch(/OAuth state verification failed/i);
        // Reaching the exchange (not the state error) is the proof. 5xx (upstream
        // exchange failure) is the observed shape; any non-state-400 is acceptable.
        if (crossed.status() === 400) {
            expect(
                await jsonMessage(crossed),
                'a 400 here must NOT be a state error (it is past the gate)',
            ).not.toMatch(/OAuth state verification failed/i);
        } else {
            expect(
                crossed.status(),
                'cross-provider callback progressed past the state gate',
            ).toBeGreaterThanOrEqual(500);
        }
        // Even the cross-provider callback clears the cookie (single-use holds).
        expect(
            setCookieString(crossed.headers()['set-cookie']),
            'cross-provider callback still clears the cookie',
        ).toMatch(/Max-Age=0\b/i);
    });

    test('github and google authorize URLs target DISTINCT hosts with DISTINCT client_ids (confusion barrier)', async ({
        request,
    }) => {
        const gh = await mintState(request, 'github');
        const goog = await mintState(request, 'google');

        const ghUrl = new URL(gh.url);
        const googUrl = new URL(goog.url);

        // The real per-provider confusion barrier: distinct authorize hosts.
        expect(ghUrl.hostname, 'github authorizes at github.com').toBe('github.com');
        expect(googUrl.hostname, 'google authorizes at accounts.google.com').toBe(
            'accounts.google.com',
        );
        expect(ghUrl.hostname, 'authorize hosts differ').not.toBe(googUrl.hostname);

        // Each carries its OWN client_id — a token minted for one cannot be
        // redeemed at the other (different OAuth app).
        const ghClient = ghUrl.searchParams.get('client_id');
        const googClient = googUrl.searchParams.get('client_id');
        expect(ghClient, 'github URL carries a client_id').toBeTruthy();
        expect(googClient, 'google URL carries a client_id').toBeTruthy();
        expect(ghClient, 'github + google use different client_ids').not.toBe(googClient);

        // And distinct state nonces — even minted back-to-back.
        expect(gh.state, 'per-provider mints produce distinct nonces').not.toBe(goog.state);
    });
});

test.describe('flow: provider allowlist is enforced AFTER the state gate at the callback', () => {
    /**
     * oauth-state.service.verify() runs FIRST; only on a pass does the controller
     * resolve the provider config (which throws "Unsupported OAuth provider" for
     * an unknown id) before the exchange. This proves the gate ordering: a
     * MATCHING cookie+state on an unsupported provider is rejected by the
     * ALLOWLIST (400, provider message) — not by the state guard, and not a 500.
     * Existing specs only test unsupported-provider at the URL-MINT step.
     */
    test('matching cookie+state on an unsupported provider → 400 "Unsupported OAuth provider" (past the gate)', async ({
        request,
    }) => {
        // Mint a real nonce on a SUPPORTED provider, then present it (cookie+query
        // matched) to an UNSUPPORTED provider's callback.
        const minted = await mintState(request, 'github');
        const bogusProvider = `notaprovider-${Date.now().toString(36)}`;

        const res = await request.get(
            `${API_BASE}/api/oauth/${bogusProvider}/callback?code=e2e-code&state=${minted.state}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${minted.state}` } },
        );
        expect(res.status(), 'unsupported-provider callback (matched state) → 400').toBe(400);
        const msg = await jsonMessage(res);
        // The rejection is the ALLOWLIST, not the state guard — proving ordering.
        expect(msg, 'rejection names the unsupported provider, not a state error').toMatch(
            /unsupported oauth provider/i,
        );
        expect(msg, 'this is NOT a state-verification failure (gate already passed)').not.toMatch(
            /OAuth state verification failed/i,
        );
        // The cookie is STILL cleared even though the provider was bogus.
        expect(
            setCookieString(res.headers()['set-cookie']),
            'unsupported-provider callback still clears the cookie',
        ).toMatch(/Max-Age=0\b/i);
    });

    test('unsupported provider WITHOUT a matching cookie is still stopped by the state gate first', async ({
        request,
    }) => {
        // Mirror image: with NO cookie, the state guard rejects BEFORE provider
        // resolution — so the same bogus provider yields the missing-cookie reason,
        // not the unsupported-provider reason. The two tests together pin the
        // gate→allowlist ordering from both sides.
        const bogusProvider = `notaprovider-${Date.now().toString(36)}`;
        const res = await request.get(
            `${API_BASE}/api/oauth/${bogusProvider}/callback?code=e2e-code&state=anything-here`,
        );
        expect(res.status(), 'no-cookie bogus-provider callback → 400').toBe(400);
        const msg = await jsonMessage(res);
        expect(msg, 'state gate fires before provider resolution').toMatch(/missing state cookie/i);
        expect(msg, 'provider allowlist did not run yet').not.toMatch(
            /unsupported oauth provider/i,
        );
    });
});

test.describe('flow: state-gate rejection PRECEDENCE matrix', () => {
    /**
     * When a single request could trip MULTIPLE state checks, exactly one reason
     * must win, and the order is fixed: missing-query → missing-cookie →
     * length-mismatch → value-mismatch → (gate passes). Existing specs test each
     * reason in ISOLATION; this proves the precedence by feeding inputs that
     * could satisfy several failure conditions at once.
     */
    test('missing-query beats everything else (cookie present, no state param)', async ({
        request,
    }) => {
        // A cookie IS present, but there is no `state` query param at all. The
        // missing-query check runs first → that reason must win over any
        // cookie-based comparison.
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?code=e2e-code`, {
            headers: { Cookie: `${OAUTH_STATE_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
        });
        expect(res.status()).toBe(400);
        expect(await jsonMessage(res), 'missing-query wins even with a cookie present').toMatch(
            /missing state query/i,
        );
    });

    test('missing-cookie beats length/value mismatch (state present, no cookie)', async ({
        request,
    }) => {
        // state query present, NO cookie. The missing-cookie check must win — the
        // length/value comparisons can't even run without a cookie.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=somevaluehere`,
        );
        expect(res.status()).toBe(400);
        expect(await jsonMessage(res), 'missing-cookie precedes length/value checks').toMatch(
            /missing state cookie/i,
        );
    });

    test('length-mismatch beats value-mismatch (different lengths AND different bytes)', async ({
        request,
    }) => {
        // Cookie and state differ in BOTH length and bytes. The service compares
        // length first → "state length mismatch" must win over "state value
        // mismatch", even though the bytes also differ.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=longerstatevaluexyz`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=tiny` } },
        );
        expect(res.status()).toBe(400);
        const msg = await jsonMessage(res);
        expect(msg, 'length-mismatch wins when both length and bytes differ').toMatch(
            /state length mismatch/i,
        );
        expect(msg, 'the value-mismatch reason did not win').not.toMatch(/state value mismatch/i);
    });

    test('value-mismatch is the LAST gate before pass (equal length, different bytes)', async ({
        request,
    }) => {
        // Equal length, different bytes → the only remaining failure is value
        // mismatch. This is the boundary case just before a pass.
        const cookie = 'A'.repeat(32);
        const state = 'B'.repeat(32);
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=e2e-code&state=${state}`,
            { headers: { Cookie: `${OAUTH_STATE_COOKIE}=${cookie}` } },
        );
        expect(res.status()).toBe(400);
        expect(await jsonMessage(res), 'equal-length differing-bytes → value mismatch').toMatch(
            /state value mismatch/i,
        );
    });
});

test.describe('flow: redirect_uri + authorize-host pin is per-provider and stable across mints', () => {
    /**
     * The authorize URL the platform forms must, on EVERY mint, pin the upstream
     * host (provider allowlist) and the redirect_uri back to the platform's own
     * web callback — never an attacker origin. We mint repeatedly and assert the
     * pin never drifts, and that the embedded state always equals the cookie
     * (CSRF binding holds per mint). Distinct from oauth-redirect-uri-pin.spec.ts
     * which probes the SEPARATE /connect/url surface a single time.
     */
    const PROVIDERS: Array<{ id: string; host: string }> = [
        { id: 'github', host: 'github.com' },
        { id: 'google', host: 'accounts.google.com' },
    ];

    for (const provider of PROVIDERS) {
        test(`${provider.id}: authorize host + web-callback redirect_uri are pinned across 4 mints`, async ({
            request,
        }) => {
            const apiHost = new URL(API_BASE).hostname;
            for (let i = 0; i < 4; i++) {
                const minted = await mintState(request, provider.id);
                const authorize = new URL(minted.url);

                // 1) Upstream authorize host is the pinned provider host (https).
                expect(
                    authorize.hostname,
                    `${provider.id} mint #${i} authorizes at ${provider.host}`,
                ).toBe(provider.host);
                expect(authorize.protocol, `${provider.id} mint #${i} authorize is https`).toBe(
                    'https:',
                );

                // 2) redirect_uri pins back to the platform's OWN callback route —
                // never an attacker origin. Host must be the API/web origin (or a
                // *.ever.works subdomain in prod); path must be the callback.
                const ru = authorize.searchParams.get('redirect_uri');
                expect(ru, `${provider.id} mint #${i} has a redirect_uri`).toBeTruthy();
                const redirect = new URL(ru!);
                const hostnameOk =
                    redirect.hostname === apiHost ||
                    redirect.hostname === '127.0.0.1' ||
                    redirect.hostname === 'localhost' ||
                    /\.ever\.works$/.test(redirect.hostname);
                expect(
                    hostnameOk,
                    `${provider.id} mint #${i} redirect_uri host "${redirect.hostname}" is platform-owned`,
                ).toBe(true);
                expect(
                    redirect.pathname,
                    `${provider.id} mint #${i} redirect_uri ends at the provider callback`,
                ).toMatch(new RegExp(`/api/oauth/${provider.id}/callback$`));
                // prod-shaped origins must be https.
                if (/\.ever\.works$/.test(redirect.hostname)) {
                    expect(
                        redirect.protocol,
                        `${provider.id} mint #${i} prod redirect_uri is https`,
                    ).toBe('https:');
                }

                // 3) CSRF binding holds on every mint: embedded state === cookie.
                expect(
                    authorize.searchParams.get('state'),
                    `${provider.id} mint #${i} URL embeds the cookie nonce`,
                ).toBe(minted.state);
            }
        });
    }
});

test.describe('flow: state-cookie hardening + nonce entropy (statistical replay resistance)', () => {
    /**
     * The mint endpoint sets the nonce as a hardened, single-purpose cookie and
     * the nonce is a 32-byte (43-char base64url) CSPRNG value. We assert the full
     * flag set on the SET path and that, across many back-to-back mints, every
     * nonce is unique and high-entropy — so an attacker cannot guess or collide a
     * valid state. No existing spec asserts the cookie flag set on the login
     * /url mint nor the cross-mint uniqueness at scale.
     */
    test('the /url mint sets a hardened HttpOnly / Path-scoped / SameSite=Lax / TTL cookie', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/oauth/github/url`);
        expect(res.status()).toBe(200);
        const sc = setCookieString(res.headers()['set-cookie']);
        expect(sc, 'mint sets the state cookie').toContain(`${OAUTH_STATE_COOKIE}=`);
        // HttpOnly → not readable by page JS (no XSS exfil of the CSRF nonce).
        expect(sc, 'state cookie is HttpOnly').toContain('HttpOnly');
        // Path-scoped to the oauth routes only — not sent on unrelated requests.
        expect(sc, 'state cookie scoped to /api/oauth').toContain('Path=/api/oauth');
        // SameSite=Lax — required so the cookie DOES ride the top-level callback
        // GET, while blocking cross-site POST attaches.
        expect(sc, 'state cookie is SameSite=Lax').toMatch(/SameSite=Lax/i);
        // A bounded TTL (10 min) so a leaked nonce expires.
        expect(sc, 'state cookie carries a bounded Max-Age').toMatch(/Max-Age=\d+/i);
        const maxAge = Number(sc.match(/Max-Age=(\d+)/i)?.[1] ?? '0');
        expect(maxAge, 'TTL is positive and not absurdly long').toBeGreaterThan(0);
        expect(maxAge, 'TTL is short-lived (≤ 1h)').toBeLessThanOrEqual(3600);

        // The body nonce equals the cookie nonce, and is a high-entropy value.
        const body = await res.json();
        const ck = cookieValue(res.headers()['set-cookie'], OAUTH_STATE_COOKIE);
        expect(ck, 'cookie nonce === body nonce').toBe(body.state);
        expect(
            String(body.state).length,
            'nonce is a 32-byte-class value (≥ 40 base64url chars)',
        ).toBeGreaterThanOrEqual(40);
        // base64url alphabet only — no padding, no exotic chars.
        expect(String(body.state), 'nonce is base64url').toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('20 consecutive mints produce 20 unique, high-entropy nonces (no collisions)', async ({
        request,
    }) => {
        const seen = new Set<string>();
        const MINTS = 20;
        for (let i = 0; i < MINTS; i++) {
            const res = await request.get(`${API_BASE}/api/oauth/github/url`);
            expect(res.status(), `mint #${i} returns 200`).toBe(200);
            const body = await res.json();
            const state: string = body.state;
            expect(state.length, `mint #${i} nonce is high-entropy`).toBeGreaterThanOrEqual(40);
            expect(
                seen.has(state),
                `mint #${i} produced a COLLIDING nonce (replay/guess risk)`,
            ).toBe(false);
            seen.add(state);
        }
        expect(seen.size, 'all nonces across the run were unique').toBe(MINTS);
    });
});
