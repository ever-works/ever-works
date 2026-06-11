import { test, expect, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * sec-pin-oauth-state-matrix — pins the EW-722 #20 (security Wave L) CSRF
 * `state` matrix on the PLUGIN-CAPABILITY OAuth controller
 * (apps/api/src/plugins-capabilities/oauth/oauth.controller.ts): the
 * server-minted `ew_oauth_state` HttpOnly cookie on BOTH `/connect/url`
 * variants and its verification on BOTH `/callback/plugins*` variants.
 *
 * NON-DUPLICATION — the existing oauth/state specs already own:
 *   · flow-oauth-callback-security / flow-oauth-providers-deep /
 *     oauth-state.spec.ts → the AUTH social-login surface
 *     (`/api/oauth/:p/url` + `/api/oauth/:p/callback`, public): its mint,
 *     full rejection-reason precedence matrix, single-use clear-cookie,
 *     entropy, and cross-provider semantics. NOT the plugin-capability
 *     controller this file targets.
 *   · flow-plugin-git-provider / flow-git-provider-connection → the
 *     plugin-capability CODE gate ('Authorization code is required' with no
 *     state anywhere), the unconfigured-creds 400 contract, read-packages
 *     independence from the main connection, and the WEB-tier
 *     oauth_invalid_state redirects. They never read the `ew_oauth_state`
 *     Set-Cookie on `/connect/url`, never pin a state-verification reason on
 *     `/callback/plugins*`, and their code+state probes are deliberately
 *     adaptive (`<500` / conditional).
 *   · plugins-readpackages.spec.ts → anon-401 on both callbacks and loose
 *     (`<500`, not-200) authed probes — no state reasons, no cookies.
 *   · oauth-state-rotation / oauth-state-replay / oauth-csrf-state-binding →
 *     body-`state` rotation on a CONFIGURED `/connect/url` (skip here) and
 *     the AUTH callback; none touch `/callback/plugins*` or the cookie.
 *
 * THIS file pins the genuinely-new Wave L #20 state behaviors:
 *   1. `/connect/url` + `/read-packages/connect/url` mint the hardened
 *      `ew_oauth_state` cookie EVEN on the unconfigured-400 path (the mint
 *      runs before the credential lookup), with rotation across mints and
 *      NO mint for anon callers (auth guard first).
 *   2. The full state-verification matrix on `/callback/plugins` AND
 *      `/callback/plugins/read-packages`: missing query / missing cookie /
 *      value mismatch / length mismatch reasons, each with the single-use
 *      Max-Age=0 clear-cookie.
 *   3. Gate ORDERING made observable: missing code wins over a matching
 *      cookie+state AND leaves the cookie un-cleared (state verify never
 *      ran); a matching pair passes the gate and falls to the credential
 *      guard (never a state error); a REAL minted nonce round-trips; the
 *      nonce is flow-agnostic (read-packages mint redeems at the main
 *      callback's gate).
 *
 * EVERY status/message/header below was PROBED against the LIVE stack
 * (API 127.0.0.1:3100 sqlite in-memory CI driver) before the assertions
 * were written. Upstream github.com is NEVER contacted.
 *
 * PROBED CONTRACTS (live):
 *   GET /api/oauth/github/connect/url                (authed) → 400
 *     { message:'OAuth credentials not configured for provider: github' }
 *     + Set-Cookie: ew_oauth_state=<43-char base64url>; Path=/api/oauth;
 *       Max-Age=600; HttpOnly; SameSite=Lax     (mint happens on the 400!)
 *   GET /api/oauth/github/read-packages/connect/url  (authed) → same 400 +
 *       same hardened Set-Cookie mint; consecutive mints rotate the nonce.
 *   GET /api/oauth/github/connect/url                (anon)   → 401, NO Set-Cookie.
 *   GET /api/oauth/github/callback/plugins           (authed):
 *     code, no state, no cookie   → 400 '...failed: missing state query'
 *     code+state, no cookie       → 400 '...failed: missing state cookie'
 *     code+state ≠ cookie (=len)  → 400 '...failed: state value mismatch'
 *     code+state ≠ cookie (≠len)  → 400 '...failed: state length mismatch'
 *     NO code, matching pair      → 400 'Authorization code is required'
 *                                   and NO Set-Cookie at all (cookie intact)
 *     code + matching pair        → 400 'OAuth credentials not configured…'
 *                                   (state gate PASSED, fell to cred guard)
 *     every state-verified path   → Set-Cookie: ew_oauth_state=;
 *                                   Path=/api/oauth; Max-Age=0; HttpOnly;
 *                                   SameSite=Lax       (single-use clear)
 *   GET /api/oauth/github/callback/plugins/read-packages (authed) → the
 *       IDENTICAL matrix (probed point-for-point).
 *   A nonce minted at read-packages/connect/url passes the MAIN callback's
 *       state gate (the cookie is flow-agnostic; probed).
 *   Both callbacks anon → 401 (already pinned by plugins-readpackages —
 *       re-used here only as a precondition, not re-asserted).
 *
 * ISOLATION: every test registers its OWN fresh user. State-matrix probes
 * pass the Cookie header EXPLICITLY (an explicit header overrides the
 * per-test request-fixture cookie jar), and no-cookie probes run in tests
 * that never minted first — so the jar can never contaminate a probe.
 */

const PROVIDER = 'github';
const STATE_COOKIE = 'ew_oauth_state';
const CONNECT_URL = `${API_BASE}/api/oauth/${PROVIDER}/connect/url`;
const RP_CONNECT_URL = `${API_BASE}/api/oauth/${PROVIDER}/read-packages/connect/url`;
const CALLBACK = `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins`;
const RP_CALLBACK = `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins/read-packages`;

/** Two same-length (32) but different synthetic state values. */
const STATE_A = 'A'.repeat(32);
const STATE_B = 'B'.repeat(32);

/** Coalesce the raw Set-Cookie header (string | string[]) into one string. */
function setCookieString(res: APIResponse): string {
    const raw = res.headers()['set-cookie'];
    if (!raw) return '';
    return Array.isArray(raw) ? raw.join('\n') : String(raw);
}

/** Extract the ew_oauth_state VALUE from a response's Set-Cookie header. */
function mintedNonce(res: APIResponse): string | undefined {
    const match = setCookieString(res).match(new RegExp(`${STATE_COOKIE}=([^;]*)`));
    return match ? match[1] : undefined;
}

async function jsonMessage(res: APIResponse): Promise<string> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return String(body.message ?? '');
}

/**
 * The connect/url endpoints are environment-adaptive: this env has no
 * plugin-capability OAuth clientId/secret, so they 400 with the known
 * 'not configured' message; a configured env 200s with { url, state }.
 * The MINT contract is identical either way — assert it on whichever
 * status came back, but never accept a 5xx or an unknown 400.
 */
async function expectMintResponse(res: APIResponse, label: string): Promise<void> {
    expect(res.status(), `${label} never 5xx (got ${res.status()})`).toBeLessThan(500);
    if (res.status() === 400) {
        expect(
            await jsonMessage(res),
            `${label} 400 is the known unconfigured-creds guard`,
        ).toMatch(new RegExp(`not configured for provider: ${PROVIDER}`, 'i'));
    } else {
        expect(res.status(), `${label} configured path is 200`).toBe(200);
    }
}

/** Assert the full hardened mint Set-Cookie contract on a response. */
function expectHardenedMintCookie(res: APIResponse, label: string): string {
    const sc = setCookieString(res);
    expect(sc, `${label} sets the ${STATE_COOKIE} cookie`).toContain(`${STATE_COOKIE}=`);
    const nonce = mintedNonce(res) ?? '';
    expect(
        nonce.length,
        `${label} nonce is 32-byte-class (≥40 base64url chars)`,
    ).toBeGreaterThanOrEqual(40);
    expect(nonce, `${label} nonce is base64url`).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sc, `${label} cookie is HttpOnly (no JS exfil)`).toContain('HttpOnly');
    expect(sc, `${label} cookie is scoped to /api/oauth`).toContain('Path=/api/oauth');
    expect(sc, `${label} cookie is SameSite=Lax`).toMatch(/SameSite=Lax/i);
    const maxAge = Number(sc.match(/Max-Age=(\d+)/i)?.[1] ?? '0');
    expect(maxAge, `${label} cookie TTL is positive`).toBeGreaterThan(0);
    expect(maxAge, `${label} cookie TTL is short-lived (≤10 min)`).toBeLessThanOrEqual(600);
    return nonce;
}

/** Assert the single-use Max-Age=0 clear of the state cookie. */
function expectSingleUseClear(res: APIResponse, label: string): void {
    const sc = setCookieString(res);
    expect(sc, `${label} emits a ${STATE_COOKIE} Set-Cookie`).toContain(`${STATE_COOKIE}=`);
    expect(sc, `${label} clears the cookie (Max-Age=0, single-use)`).toMatch(/Max-Age=0\b/i);
    expect(mintedNonce(res), `${label} cleared value is empty`).toBe('');
    expect(sc, `${label} clear-cookie stays HttpOnly`).toContain('HttpOnly');
    expect(sc, `${label} clear-cookie stays scoped to /api/oauth`).toContain('Path=/api/oauth');
}

test.describe('sec-pin: connect/url mints the ew_oauth_state cookie (Wave L #20)', () => {
    test('GET connect/url mints the hardened state cookie EVEN on the unconfigured-400 path', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(CONNECT_URL, { headers: authedHeaders(u.access_token) });

        // The mint deliberately runs BEFORE the credential lookup, so the
        // CSRF cookie is set even when the provider has no clientId/secret
        // and the response is the truthful unconfigured 400.
        await expectMintResponse(res, 'connect/url');
        const nonce = expectHardenedMintCookie(res, 'connect/url');

        // On the configured 200 path the body state must equal the cookie;
        // on the 400 path there is no body state — the cookie IS the mint.
        if (res.status() === 200) {
            const body = (await res.json()) as { state?: unknown };
            expect(String(body.state), 'configured body.state === cookie nonce').toBe(nonce);
        }
    });

    test('GET read-packages/connect/url mints the SAME hardened cookie on its 400 path', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(RP_CONNECT_URL, { headers: authedHeaders(u.access_token) });
        await expectMintResponse(res, 'read-packages connect/url');
        expectHardenedMintCookie(res, 'read-packages connect/url');
    });

    test('consecutive mints ROTATE the nonce across BOTH connect/url variants (no reuse)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Four mints — two per variant. Every nonce must be unique even on
        // the unconfigured-400 path: a static nonce would let an attacker
        // pre-learn the CSRF value.
        const nonces: string[] = [];
        for (const url of [CONNECT_URL, CONNECT_URL, RP_CONNECT_URL, RP_CONNECT_URL]) {
            const res = await request.get(url, { headers: h });
            await expectMintResponse(res, url.includes('read-packages') ? 'rp mint' : 'main mint');
            const nonce = mintedNonce(res);
            expect(nonce, 'every mint sets a nonce').toBeTruthy();
            nonces.push(String(nonce));
        }
        expect(new Set(nonces).size, 'all 4 minted nonces are distinct (rotation)').toBe(
            nonces.length,
        );
    });

    test('anon connect/url (both variants) → 401 with NO state cookie minted (auth guard precedes the mint)', async ({
        request,
    }) => {
        for (const [label, url] of [
            ['main', CONNECT_URL],
            ['read-packages', RP_CONNECT_URL],
        ] as const) {
            const res = await request.get(url);
            expect(res.status(), `anon ${label} connect/url → 401`).toBe(401);
            // The guard rejects before the controller runs, so no CSRF
            // cookie is sprayed at unauthenticated callers.
            expect(
                setCookieString(res),
                `anon ${label} 401 mints NO ${STATE_COOKIE} cookie`,
            ).not.toContain(`${STATE_COOKIE}=`);
        }
    });
});

test.describe('sec-pin: /callback/plugins state-verification matrix (Wave L #20)', () => {
    test('code but NO state and NO cookie → 400 "missing state query" + single-use clear', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // No mint happened in this test → the per-test cookie jar is empty,
        // so this is a genuine no-cookie request.
        const res = await request.get(`${CALLBACK}?code=e2e-fake-code`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'no-state callback → 400').toBe(400);
        expect(await jsonMessage(res), 'reason: missing state query').toMatch(
            /OAuth state verification failed: missing state query/i,
        );
        expectSingleUseClear(res, 'missing-query rejection');
    });

    test('code + state but NO cookie → 400 "missing state cookie" + single-use clear', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${CALLBACK}?code=e2e-fake-code&state=${STATE_B}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'no-cookie callback → 400').toBe(400);
        expect(await jsonMessage(res), 'reason: missing state cookie').toMatch(
            /OAuth state verification failed: missing state cookie/i,
        );
        expectSingleUseClear(res, 'missing-cookie rejection');
    });

    test('mismatched cookie vs state → 400 value-mismatch (equal length) / length-mismatch (unequal)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Same length, different bytes → the constant-time compare rejects
        // with the value-mismatch reason.
        const value = await request.get(`${CALLBACK}?code=e2e-fake-code&state=${STATE_B}`, {
            headers: { ...h, Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(value.status(), 'value-mismatch → 400').toBe(400);
        expect(await jsonMessage(value), 'reason: state value mismatch').toMatch(
            /OAuth state verification failed: state value mismatch/i,
        );
        expectSingleUseClear(value, 'value-mismatch rejection');

        // Different lengths → the length check wins (still after the padded
        // constant-time compare, but the distinct reason is pinned).
        const length = await request.get(`${CALLBACK}?code=e2e-fake-code&state=short`, {
            headers: { ...h, Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(length.status(), 'length-mismatch → 400').toBe(400);
        expect(await jsonMessage(length), 'reason: state length mismatch').toMatch(
            /OAuth state verification failed: state length mismatch/i,
        );
        expectSingleUseClear(length, 'length-mismatch rejection');
    });

    test('missing code is STILL the first gate — it wins over a matching cookie+state and leaves the cookie UN-cleared', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // A pair that WOULD pass the state gate — but with no code the
        // code-presence check fires first (the pinned gate ordering).
        const res = await request.get(`${CALLBACK}?state=${STATE_A}`, {
            headers: { ...authedHeaders(u.access_token), Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(res.status(), 'no-code callback → 400').toBe(400);
        const msg = await jsonMessage(res);
        expect(msg, 'the code gate wins').toMatch(/authorization code is required/i);
        expect(msg, 'NOT a state error (state verify never ran)').not.toMatch(
            /OAuth state verification failed/i,
        );
        // Observable ordering proof: because the state verifier never ran,
        // the clear-cookie is NOT emitted — the browser's nonce survives a
        // malformed (code-less) callback hit.
        expect(
            setCookieString(res),
            'no-code rejection does NOT touch the state cookie',
        ).not.toContain(`${STATE_COOKIE}=`);
    });

    test('a MATCHING cookie+state passes the gate and falls to the credential guard — never a state error', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${CALLBACK}?code=e2e-fake-code&state=${STATE_A}`, {
            headers: { ...authedHeaders(u.access_token), Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        // Environment-adaptive: this env trips the unconfigured-creds guard
        // (exact message pinned); a configured env would fail later at the
        // code exchange. Either way the response is a non-2xx that is NOT a
        // state-verification failure — proving the gate passed.
        expect(
            res.status(),
            'matched-state callback still fails downstream',
        ).toBeGreaterThanOrEqual(400);
        const msg = await jsonMessage(res);
        expect(msg, 'NOT a state error (the gate passed)').not.toMatch(
            /OAuth state verification failed/i,
        );
        if (res.status() === 400) {
            expect(msg, 'this env: the credential guard fires AFTER the state gate').toMatch(
                new RegExp(`not configured for provider: ${PROVIDER}`, 'i'),
            );
        }
        // The pass path still consumes the nonce (single-use).
        expectSingleUseClear(res, 'gate-pass response');
    });

    test('a REAL nonce minted by connect/url round-trips through the callback state gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Mint — the nonce is real even on the unconfigured-400 path.
        const mint = await request.get(CONNECT_URL, { headers: h });
        await expectMintResponse(mint, 'round-trip mint');
        const nonce = mintedNonce(mint);
        expect(nonce, 'mint produced a nonce').toBeTruthy();

        // Redeem cookie+state exactly as a browser returning from GitHub
        // would. The state gate must PASS (no state error) and consume the
        // cookie.
        const res = await request.get(
            `${CALLBACK}?code=e2e-fake-code&state=${encodeURIComponent(String(nonce))}`,
            { headers: { ...h, Cookie: `${STATE_COOKIE}=${nonce}` } },
        );
        expect(
            res.status(),
            'round-trip callback fails downstream, not at the gate',
        ).toBeGreaterThanOrEqual(400);
        expect(await jsonMessage(res), 'minted nonce passed the state gate').not.toMatch(
            /OAuth state verification failed/i,
        );
        expectSingleUseClear(res, 'round-trip response');
    });
});

test.describe('sec-pin: /callback/plugins/read-packages state-verification matrix (Wave L #20)', () => {
    test('missing query / missing cookie reasons mirror the main callback + single-use clear', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // code, no state, no cookie (no mint in this test → empty jar).
        const noQuery = await request.get(`${RP_CALLBACK}?code=e2e-fake-code`, { headers: h });
        expect(noQuery.status(), 'rp no-state → 400').toBe(400);
        expect(await jsonMessage(noQuery), 'rp reason: missing state query').toMatch(
            /OAuth state verification failed: missing state query/i,
        );
        expectSingleUseClear(noQuery, 'rp missing-query rejection');

        // code + state, no cookie.
        const noCookie = await request.get(`${RP_CALLBACK}?code=e2e-fake-code&state=${STATE_B}`, {
            headers: h,
        });
        expect(noCookie.status(), 'rp no-cookie → 400').toBe(400);
        expect(await jsonMessage(noCookie), 'rp reason: missing state cookie').toMatch(
            /OAuth state verification failed: missing state cookie/i,
        );
        expectSingleUseClear(noCookie, 'rp missing-cookie rejection');
    });

    test('mismatched cookie vs state → value-mismatch / length-mismatch reasons + clear', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const value = await request.get(`${RP_CALLBACK}?code=e2e-fake-code&state=${STATE_B}`, {
            headers: { ...h, Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(value.status(), 'rp value-mismatch → 400').toBe(400);
        expect(await jsonMessage(value), 'rp reason: state value mismatch').toMatch(
            /OAuth state verification failed: state value mismatch/i,
        );
        expectSingleUseClear(value, 'rp value-mismatch rejection');

        const length = await request.get(`${RP_CALLBACK}?code=e2e-fake-code&state=tiny`, {
            headers: { ...h, Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(length.status(), 'rp length-mismatch → 400').toBe(400);
        expect(await jsonMessage(length), 'rp reason: state length mismatch').toMatch(
            /OAuth state verification failed: state length mismatch/i,
        );
        expectSingleUseClear(length, 'rp length-mismatch rejection');
    });

    test('missing code is the first gate on read-packages too — wins over a matching pair, cookie un-cleared', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${RP_CALLBACK}?state=${STATE_A}`, {
            headers: { ...authedHeaders(u.access_token), Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(res.status(), 'rp no-code → 400').toBe(400);
        const msg = await jsonMessage(res);
        expect(msg, 'rp code gate wins').toMatch(/authorization code is required/i);
        expect(msg, 'rp NOT a state error').not.toMatch(/OAuth state verification failed/i);
        expect(
            setCookieString(res),
            'rp no-code rejection does NOT touch the state cookie',
        ).not.toContain(`${STATE_COOKIE}=`);
    });

    test('a matching pair passes the rp gate to the credential guard, and the nonce is FLOW-AGNOSTIC (rp mint redeems at the MAIN callback)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Matching synthetic pair on the rp callback → past the gate.
        const matched = await request.get(`${RP_CALLBACK}?code=e2e-fake-code&state=${STATE_A}`, {
            headers: { ...h, Cookie: `${STATE_COOKIE}=${STATE_A}` },
        });
        expect(matched.status(), 'rp matched-state fails downstream').toBeGreaterThanOrEqual(400);
        const matchedMsg = await jsonMessage(matched);
        expect(matchedMsg, 'rp gate passed (not a state error)').not.toMatch(
            /OAuth state verification failed/i,
        );
        if (matched.status() === 400) {
            expect(matchedMsg, 'rp credential guard fires after the gate').toMatch(
                new RegExp(`not configured for provider: ${PROVIDER}`, 'i'),
            );
        }
        expectSingleUseClear(matched, 'rp gate-pass response');

        // Flow-agnostic nonce: a nonce minted at the READ-PACKAGES
        // connect/url is one bare CSRF binding — it passes the MAIN
        // callback's state gate too (probed; the cookie carries no flow
        // tag). Confusion between the two flows is prevented downstream by
        // which handler stores the token, not by the nonce.
        const rpMint = await request.get(RP_CONNECT_URL, { headers: h });
        await expectMintResponse(rpMint, 'rp cross-flow mint');
        const nonce = mintedNonce(rpMint);
        expect(nonce, 'rp mint produced a nonce').toBeTruthy();

        const crossFlow = await request.get(
            `${CALLBACK}?code=e2e-fake-code&state=${encodeURIComponent(String(nonce))}`,
            { headers: { ...h, Cookie: `${STATE_COOKIE}=${nonce}` } },
        );
        expect(
            await jsonMessage(crossFlow),
            'rp-minted nonce passes the MAIN callback gate (flow-agnostic)',
        ).not.toMatch(/OAuth state verification failed/i);
        expectSingleUseClear(crossFlow, 'cross-flow response');
    });
});
