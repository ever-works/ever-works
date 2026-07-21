import { test, expect, type APIResponse, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-device-auth-oauth-multistep — CROSS-SURFACE integration flows that stitch
 * the plugin device-code grant (`/api/device-auth/:pluginId/{status,start}`,
 * apps/api/src/plugins-capabilities/device-auth) TOGETHER with the plugin
 * OAuth connection controller (`/api/oauth/*`, apps/api/src/plugins-capabilities/
 * oauth) in single stateful walks, and pins several genuinely-new corners of the
 * EW-722 #20 state-binding contract that the existing specs never reach.
 *
 * ── NON-DUPLICATION (deliberately DISJOINT from the crowded existing set) ──────
 * The following already own their surfaces; NOTHING below re-pins them:
 *   • flow-device-auth-flow.spec.ts / flow-plugin-oauth-deviceauth.spec.ts —
 *     the DeviceAuthStatus envelope, capability/not-found ladder, case-
 *     sensitivity, device-route HTTP-verb routing, device per-user isolation,
 *     and the single-controller oauth lifecycle. This file instead asserts the
 *     device-auth ↔ oauth ORTHOGONALITY (one surface's mutation never bleeds
 *     into the other) and cross-endpoint literal agreement.
 *   • sec-pin-oauth-state-matrix.spec.ts — the full state matrix with EXPLICIT
 *     Cookie headers on both callbacks, flow-agnostic (main↔read-packages)
 *     nonce, mint rotation. This file instead exercises the PROVIDER-agnostic
 *     nonce (vercel-minted → github callback) and, crucially, the REAL Playwright
 *     cookie-JAR round-trip (mint stores the cookie, redeem auto-attaches it,
 *     the single-use clear deletes it from the jar) — none of the existing specs
 *     rely on the jar; they all set Cookie by hand.
 *   • oauth-csrf-state-binding / oauth-state-replay / plugins-readpackages —
 *     the AUTH (social-login) controller and loose `<500` probes.
 * Every test registers its OWN fresh user (or uses a dedicated empty-jar
 * context); no module-scope await, no shared seeded user.
 *
 * ── PROBED CONTRACTS (live http://127.0.0.1:3100, sqlite in-memory CI driver,
 *    plugin-cap OAuth creds + Codex CLI both ABSENT — the real CI shape) ────────
 *   GET /api/oauth/providers (authed) → 200
 *     { configured:true, providers:[ {id:'github',name:'GitHub',enabled:true},
 *                                     {id:'vercel',name:'Vercel',enabled:true} ] }
 *   GET /api/oauth/:p/connect/url (authed) → 400
 *     { message:'OAuth credentials not configured for provider: <p>',
 *       error:'Bad Request', statusCode:400 }
 *     + Set-Cookie ew_oauth_state=<43-char base64url>; Path=/api/oauth;
 *       Max-Age=600; HttpOnly; SameSite=Lax  (mint runs BEFORE the cred lookup,
 *       and is invariant to ?forceConsent / ?callbackUrl).
 *   GET /api/oauth/:p/read-packages/connect/url (authed) → identical 400 + mint.
 *   GET /api/oauth/:p/callback/plugins (authed):
 *     no code                         → 400 'Authorization code is required'
 *     code, no state, no cookie       → 400 '...failed: missing state query'
 *     code+state, no cookie           → 400 '...failed: missing state cookie'
 *     code+state ≠ cookie (=len)      → 400 '...failed: state value mismatch'
 *     code+state ≠ cookie (≠len)      → 400 '...failed: state length mismatch'
 *     code + MATCHING cookie/state    → 400 'OAuth credentials not configured…'
 *                                       (state gate PASSED → fell to cred guard)
 *     every state-verified path emits Set-Cookie ew_oauth_state=; Max-Age=0
 *       (single-use clear).  A nonce minted at ANY provider/flow redeems here.
 *   GET /api/oauth/:p/callback/plugins/read-packages → same matrix.
 *   GET /api/oauth/:p/connection (authed) → ALWAYS 200; advertised →
 *     {id,name,enabled:true,connected:false}; unknown → {name:'Unknown',
 *     enabled:false,connected:false}.
 *   GET /api/oauth/:p/user (authed, disconnected) → 200
 *     { success:false, user:null, error:'No valid token for provider <p>' }.
 *   DELETE /api/oauth/:p (authed) → 204 (idempotent).
 *   POST /connect/url, POST /callback/plugins → 404 'Cannot POST <path>' (both
 *     are GET-only routes — a framework routing miss, not a controller error).
 *   Device-auth capable plugin = `codex`:
 *     GET status / POST start (authed) → 200 (start is @HttpCode OK, NOT 201)
 *       DeviceAuthStatus { installed:false, connected:false, pending:false,
 *         scope:'user', flowType:'device-code',
 *         message:'Codex CLI is not installed on this machine.' } (no `prompt`).
 *
 * Upstream github.com / vercel.com / OpenAI device endpoints are NEVER
 * contacted; every assertion is platform-side and environment-adaptive — where a
 * credential set is legitimately absent we assert the truthful "not configured"
 * contract rather than a fictional happy path.
 */

const DEVICE_PLUGIN = 'codex';
const STATE_COOKIE = 'ew_oauth_state';
/** Both OAuth providers advertised by the plugin-cap controller on `develop`. */
const PROVIDERS = [
    { id: 'github', name: 'GitHub' },
    { id: 'vercel', name: 'Vercel' },
] as const;

interface NestErrorBody {
    message: string;
    error?: string;
    statusCode: number;
}

interface DeviceAuthStatusShape {
    installed: boolean;
    connected: boolean;
    pending: boolean;
    scope: string;
    flowType: string;
    prompt?: { verificationUri?: string; userCode?: string };
    message: string;
}

/** Per-file monotonic counter → unique suffixes without a module-scope clock. */
let __seq = 0;
function uniq(tag: string): string {
    __seq += 1;
    return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${__seq}`;
}

async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    // Sanitize the tag → a valid email local-part (test titles carry spaces
    // and punctuation that IsEmail rejects; keep only [a-z0-9-]).
    const local = uniq(tag)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const u = await registerUserViaAPI(request, { email: `${local}@test.local` });
    return u.access_token;
}

/** Coalesce the Set-Cookie header (string | string[]) into one string. */
function setCookieString(res: APIResponse): string {
    const raw = res.headers()['set-cookie'];
    if (!raw) return '';
    return Array.isArray(raw) ? raw.join('\n') : String(raw);
}

/** Extract the ew_oauth_state nonce from a response's Set-Cookie header. */
function mintedNonce(res: APIResponse): string | undefined {
    const m = setCookieString(res).match(new RegExp(`${STATE_COOKIE}=([^;]*)`));
    return m ? m[1] : undefined;
}

async function jsonMessage(res: APIResponse): Promise<string> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return String(body.message ?? '');
}

/** The full DeviceAuthStatus invariant set the codex provider implements. */
function assertDeviceShape(body: unknown, ctx: string): DeviceAuthStatusShape {
    expect(body, `${ctx}: body is an object`).toBeTruthy();
    const s = body as DeviceAuthStatusShape;
    expect(typeof s.installed, `${ctx}: installed boolean`).toBe('boolean');
    expect(typeof s.connected, `${ctx}: connected boolean`).toBe('boolean');
    expect(typeof s.pending, `${ctx}: pending boolean`).toBe('boolean');
    expect(s.scope, `${ctx}: scope literal`).toBe('user');
    expect(s.flowType, `${ctx}: flowType literal`).toBe('device-code');
    expect(typeof s.message, `${ctx}: message string`).toBe('string');
    expect(s.message.length, `${ctx}: message non-empty`).toBeGreaterThan(0);
    // A connected user is never simultaneously pending, and can't be connected
    // without the CLI installed.
    expect(s.connected && s.pending, `${ctx}: never connected AND pending`).toBe(false);
    if (s.connected) expect(s.installed, `${ctx}: connected ⇒ installed`).toBe(true);
    return s;
}

async function getConnection(
    request: APIRequestContext,
    token: string,
    provider: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.get(`${API_BASE}/api/oauth/${provider}/connection`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

async function getDeviceStatus(
    request: APIRequestContext,
    token: string,
): Promise<DeviceAuthStatusShape> {
    const res = await request.get(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/status`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'codex device status → 200').toBe(200);
    return assertDeviceShape(await res.json(), 'device status');
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: device-auth ⟂ plugin-oauth are orthogonal per-user namespaces', () => {
    test('starting the codex device-code flow never establishes an OAuth connection, and probing OAuth never spins up a device session', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));

        // Baseline: both OAuth providers not-connected, device status quiescent.
        for (const p of PROVIDERS) {
            const c = await getConnection(request, token, p.id);
            expect(c.status, `${p.id} baseline connection 200`).toBe(200);
            expect(c.body.connected, `${p.id} not connected at baseline`).toBe(false);
        }
        const deviceBefore = await getDeviceStatus(request, token);
        expect(deviceBefore.pending, 'no pending device session at baseline').toBe(false);

        // Mutate the DEVICE surface: start the codex device-code flow.
        const start = await request.post(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/start`, {
            headers: authedHeaders(token),
        });
        expect(start.status(), 'device start → 200').toBe(200);
        assertDeviceShape(await start.json(), 'device start');

        // OAuth connections must be UNTOUCHED — device-auth writes to a plugin
        // device session, never to the OAuth authAccountRepository.
        for (const p of PROVIDERS) {
            const c = await getConnection(request, token, p.id);
            expect(c.body.connected, `${p.id} still not connected after device start`).toBe(false);
        }

        // Now mutate the OAUTH surface (connect/url — 400 unconfigured here) and
        // confirm the device session bit is likewise unaffected: the two
        // namespaces do not share state.
        const connect = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(token),
        });
        expect(connect.status(), 'oauth connect/url is a clean non-5xx').toBeLessThan(500);
        const deviceAfter = await getDeviceStatus(request, token);
        expect(deviceAfter.installed, 'device install bit stable across oauth probe').toBe(
            deviceBefore.installed,
        );
        expect(deviceAfter.pending, 'oauth probe did not create a pending device session').toBe(
            false,
        );
    });

    test('an idempotent OAuth disconnect (204 twice) leaves the codex device-auth status completely unchanged', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const before = await getDeviceStatus(request, token);

        // Two disconnects of a never-connected provider — both 204, no 404/409.
        const d1 = await request.delete(`${API_BASE}/api/oauth/github`, {
            headers: authedHeaders(token),
        });
        expect(d1.status(), 'first disconnect idempotent 204').toBe(204);
        const d2 = await request.delete(`${API_BASE}/api/oauth/github`, {
            headers: authedHeaders(token),
        });
        expect(d2.status(), 'second disconnect idempotent 204').toBe(204);

        const after = await getDeviceStatus(request, token);
        expect(after.installed, 'device install bit untouched by oauth disconnect').toBe(
            before.installed,
        );
        expect(after.connected, 'device connected bit untouched by oauth disconnect').toBe(
            before.connected,
        );
        expect(after.pending, 'device pending bit untouched by oauth disconnect').toBe(
            before.pending,
        );
    });

    test('the OAuth providers catalogue pins github+vercel (both enabled) with configured:true and reconciles with per-provider /connection', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const res = await request.get(`${API_BASE}/api/oauth/providers`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'providers list → 200').toBe(200);
        const list = (await res.json()) as {
            configured: boolean;
            providers: Array<{ id: string; name: string; enabled: boolean }>;
        };
        // The plugin OAuth SUBSYSTEM reports configured:true (the app HAS OAuth
        // providers registered) even though per-provider CREDENTIALS are absent —
        // two distinct notions the UI must not conflate.
        expect(list.configured, 'oauth subsystem is configured:true').toBe(true);
        expect(Array.isArray(list.providers), 'providers is an array').toBe(true);
        const ids = list.providers.map((p) => p.id);
        for (const p of PROVIDERS) {
            expect(ids, `catalogue advertises ${p.id}`).toContain(p.id);
            const entry = list.providers.find((x) => x.id === p.id)!;
            expect(entry.name, `${p.id} display name`).toBe(p.name);
            expect(entry.enabled, `${p.id} advertised ⇒ enabled`).toBe(true);
            // Reconcile against the per-provider resolver — same source of truth.
            const c = await getConnection(request, token, p.id);
            expect(c.body.id, `${p.id} connection echoes id`).toBe(p.id);
            expect(c.body.enabled, `${p.id} connection enabled agrees with catalogue`).toBe(true);
            expect(c.body.connected, `${p.id} not connected for fresh user`).toBe(false);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: plugin-OAuth connect/url mint is provider- and param-agnostic (Wave L #20)', () => {
    /** Assert the hardened mint Set-Cookie contract on a connect/url response. */
    function expectHardenedMint(res: APIResponse, label: string): string {
        const sc = setCookieString(res);
        expect(sc, `${label} sets ${STATE_COOKIE}`).toContain(`${STATE_COOKIE}=`);
        const nonce = mintedNonce(res) ?? '';
        expect(nonce.length, `${label} nonce is 32-byte-class base64url`).toBeGreaterThanOrEqual(
            40,
        );
        expect(nonce, `${label} nonce charset`).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(sc, `${label} HttpOnly`).toContain('HttpOnly');
        expect(sc, `${label} Path=/api/oauth`).toContain('Path=/api/oauth');
        expect(sc, `${label} SameSite=Lax`).toMatch(/SameSite=Lax/i);
        const maxAge = Number(sc.match(/Max-Age=(\d+)/i)?.[1] ?? '0');
        expect(maxAge, `${label} TTL positive`).toBeGreaterThan(0);
        expect(maxAge, `${label} TTL ≤ 10 min`).toBeLessThanOrEqual(600);
        return nonce;
    }

    for (const p of PROVIDERS) {
        test(`${p.id} connect/url returns the full NestError envelope AND still mints the hardened state cookie on the unconfigured-400 path`, async ({
            request,
        }, testInfo) => {
            const token = await freshToken(request, testInfo.title.slice(0, 8));
            const res = await request.get(`${API_BASE}/api/oauth/${p.id}/connect/url`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `${p.id} connect/url is a clean non-5xx`).toBeLessThan(500);
            // In this credential-less env the truthful contract is the 400 guard.
            expect(res.status(), `${p.id} connect/url unconfigured → 400`).toBe(400);
            const body = (await res.json()) as NestErrorBody;
            expect(body.message, `${p.id} names the missing credentials`).toBe(
                `OAuth credentials not configured for provider: ${p.id}`,
            );
            expect(body.error, `${p.id} carries the Bad Request label`).toBe('Bad Request');
            expect(body.statusCode, `${p.id} statusCode mirrors 400`).toBe(400);
            // The mint runs BEFORE the credential lookup — so the CSRF cookie is
            // present even on this 400.
            expectHardenedMint(res, `${p.id} connect/url`);
        });
    }

    test('?forceConsent and ?callbackUrl do NOT change the connect/url 400 contract or the mint (query-param invariance)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const variants = [
            'forceConsent=true',
            'forceConsent=false',
            'callbackUrl=' + encodeURIComponent('http://localhost:3000/settings/plugins'),
            'forceConsent=true&callbackUrl=' + encodeURIComponent('http://localhost:3000/cb'),
        ];
        const nonces: string[] = [];
        for (const q of variants) {
            const res = await request.get(`${API_BASE}/api/oauth/github/connect/url?${q}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `?${q} still 400 unconfigured`).toBe(400);
            expect(await jsonMessage(res), `?${q} same unconfigured message`).toBe(
                'OAuth credentials not configured for provider: github',
            );
            const nonce = mintedNonce(res);
            expect(nonce, `?${q} still mints a nonce`).toBeTruthy();
            nonces.push(String(nonce));
        }
        // And each param-variant mint rotates the nonce (no static value leaks
        // regardless of the query string).
        expect(new Set(nonces).size, 'every param-variant mint rotates the nonce').toBe(
            nonces.length,
        );
    });

    test('read-packages/connect/url mints the SAME hardened cookie and shares the unconfigured-400 guard (vercel + github)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        for (const p of PROVIDERS) {
            const res = await request.get(
                `${API_BASE}/api/oauth/${p.id}/read-packages/connect/url`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), `${p.id} read-packages connect/url → 400`).toBe(400);
            expect(await jsonMessage(res), `${p.id} read-packages unconfigured message`).toBe(
                `OAuth credentials not configured for provider: ${p.id}`,
            );
            expectHardenedMint(res, `${p.id} read-packages connect/url`);
        }
    });

    test('the state cookie is PROVIDER-agnostic: a nonce minted at the vercel connect/url passes the github callback state gate', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        // Mint at vercel — nonce is real even on the unconfigured 400.
        const mint = await request.get(`${API_BASE}/api/oauth/vercel/connect/url`, {
            headers: authedHeaders(token),
        });
        const nonce = expectHardenedMint(mint, 'vercel mint');

        // Redeem the SAME nonce at the GITHUB callback (the cookie's Path is
        // /api/oauth, not provider-scoped) — the state gate must PASS and the
        // response fall to the (github) credential guard, never a state error.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=e2e-fake&state=${encodeURIComponent(nonce)}`,
            { headers: { ...authedHeaders(token), Cookie: `${STATE_COOKIE}=${nonce}` } },
        );
        expect(res.status(), 'cross-provider redeem fails downstream, not at the gate').toBe(400);
        const msg = await jsonMessage(res);
        expect(msg, 'vercel-minted nonce passed the github state gate').not.toMatch(
            /OAuth state verification failed/i,
        );
        expect(msg, 'fell through to the github credential guard').toBe(
            'OAuth credentials not configured for provider: github',
        );
        // The pass path consumes the nonce (single-use Max-Age=0 clear).
        expect(setCookieString(res), 'gate-pass clears the cookie').toMatch(/Max-Age=0\b/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: REAL browser cookie-jar round-trip (mint → auto-attach → single-use replay)', () => {
    test('minting at connect/url stores the cookie in the jar; the callback redeems it WITHOUT an explicit Cookie header and passes the state gate', async ({
        browser,
    }, testInfo) => {
        // A dedicated empty-jar context: the connect/url Set-Cookie is the ONLY
        // ew_oauth_state in this jar, so the callback's auto-attached cookie can
        // only have come from the mint — a true end-to-end round-trip (the
        // existing state specs all set Cookie by hand).
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const req = ctx.request;
            const token = await freshToken(req, testInfo.title.slice(0, 8));

            const mint = await req.get(`${API_BASE}/api/oauth/github/connect/url`, {
                headers: authedHeaders(token),
            });
            const nonce = mintedNonce(mint);
            expect(nonce, 'mint set a nonce into the jar').toBeTruthy();

            // Redeem passing ONLY ?state — no Cookie header. The context jar must
            // re-attach ew_oauth_state (Path=/api/oauth covers this callback), so
            // the state gate PASSES and we fall to the credential guard.
            const redeem = await req.get(
                `${API_BASE}/api/oauth/github/callback/plugins?code=e2e-fake&state=${encodeURIComponent(
                    String(nonce),
                )}`,
                { headers: authedHeaders(token) },
            );
            expect(redeem.status(), 'jar round-trip fails downstream, not at the gate').toBe(400);
            expect(
                await jsonMessage(redeem),
                'jar-attached cookie passed the state gate',
            ).not.toMatch(/OAuth state verification failed/i);
        } finally {
            await ctx.close();
        }
    });

    test('the state cookie is SINGLE-USE through the jar: after one successful redeem the Max-Age=0 clear deletes it, so a replayed callback sees "missing state cookie"', async ({
        browser,
    }, testInfo) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const req = ctx.request;
            const token = await freshToken(req, testInfo.title.slice(0, 8));

            const mint = await req.get(`${API_BASE}/api/oauth/github/connect/url`, {
                headers: authedHeaders(token),
            });
            const nonce = String(mintedNonce(mint));
            expect(nonce.length, 'minted a real nonce').toBeGreaterThanOrEqual(40);
            const stateQ = encodeURIComponent(nonce);

            // Redeem #1 — passes the gate AND emits the single-use clear, which
            // the jar applies (Max-Age=0 deletes ew_oauth_state).
            const first = await req.get(
                `${API_BASE}/api/oauth/github/callback/plugins?code=e2e-fake&state=${stateQ}`,
                { headers: authedHeaders(token) },
            );
            expect(await jsonMessage(first), 'first redeem passed the gate').not.toMatch(
                /OAuth state verification failed/i,
            );
            expect(setCookieString(first), 'first redeem emitted the single-use clear').toMatch(
                /Max-Age=0\b/i,
            );

            // Redeem #2 — same nonce as ?state, but the jar no longer holds the
            // cookie (it was cleared), so the server sees no cookie → the gate
            // now reports "missing state cookie". This proves the replay is dead.
            const second = await req.get(
                `${API_BASE}/api/oauth/github/callback/plugins?code=e2e-fake&state=${stateQ}`,
                { headers: authedHeaders(token) },
            );
            expect(second.status(), 'replayed callback → 400').toBe(400);
            expect(
                await jsonMessage(second),
                'replay after single-use clear is missing-cookie',
            ).toMatch(/OAuth state verification failed: missing state cookie/i);
        } finally {
            await ctx.close();
        }
    });

    test('the jar cookie is FLOW-shared: a nonce minted at the main connect/url redeems at the read-packages callback (shared Path=/api/oauth)', async ({
        browser,
    }, testInfo) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const req = ctx.request;
            const token = await freshToken(req, testInfo.title.slice(0, 8));

            const mint = await req.get(`${API_BASE}/api/oauth/github/connect/url`, {
                headers: authedHeaders(token),
            });
            const nonce = String(mintedNonce(mint));
            expect(nonce.length, 'minted a real nonce').toBeGreaterThanOrEqual(40);

            // The read-packages callback lives under the same /api/oauth path, so
            // the jar attaches the main-flow nonce. The state gate is flow-
            // agnostic → it passes; the read-packages handler then fails
            // downstream (unreachable code exchange), never a state error.
            const redeem = await req.get(
                `${API_BASE}/api/oauth/github/callback/plugins/read-packages?code=e2e-fake&state=${encodeURIComponent(
                    nonce,
                )}`,
                { headers: authedHeaders(token) },
            );
            expect(redeem.status(), 'read-packages redeem fails downstream').toBeGreaterThanOrEqual(
                400,
            );
            expect(
                await jsonMessage(redeem),
                'main-flow nonce passed the read-packages gate',
            ).not.toMatch(/OAuth state verification failed/i);
        } finally {
            await ctx.close();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: callback code-gate + routing across BOTH providers', () => {
    for (const p of PROVIDERS) {
        test(`${p.id} callback with no code is the first gate → 400 "Authorization code is required" with the full envelope`, async ({
            request,
        }, testInfo) => {
            const token = await freshToken(request, testInfo.title.slice(0, 8));
            const res = await request.get(`${API_BASE}/api/oauth/${p.id}/callback/plugins`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `${p.id} no-code callback → 400`).toBe(400);
            const body = (await res.json()) as NestErrorBody;
            expect(body.message, `${p.id} names the required code`).toBe(
                'Authorization code is required',
            );
            expect(body.error, `${p.id} Bad Request label`).toBe('Bad Request');
            expect(body.statusCode, `${p.id} statusCode 400`).toBe(400);
            // The code gate wins over the (absent) state → NO state error leaks,
            // and no state cookie is touched (the verifier never ran).
            expect(body.message, `${p.id} not a state error`).not.toMatch(
                /OAuth state verification failed/i,
            );
            expect(
                setCookieString(res),
                `${p.id} no-code path does not touch the state cookie`,
            ).not.toContain(`${STATE_COOKIE}=`);
        });

        test(`${p.id} callback with code+state but no cookie → 400 "missing state cookie" + single-use clear`, async ({
            request,
        }, testInfo) => {
            const token = await freshToken(request, testInfo.title.slice(0, 8));
            // This test never minted, so the request-fixture jar has no
            // ew_oauth_state → a genuine no-cookie request.
            const res = await request.get(
                `${API_BASE}/api/oauth/${p.id}/callback/plugins?code=e2e-fake&state=abcdef123456`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), `${p.id} no-cookie callback → 400`).toBe(400);
            expect(await jsonMessage(res), `${p.id} reason: missing state cookie`).toMatch(
                /OAuth state verification failed: missing state cookie/i,
            );
            // The verifier ran → it emits the single-use clear even on rejection.
            expect(setCookieString(res), `${p.id} rejection still clears the cookie`).toMatch(
                /Max-Age=0\b/i,
            );
        });
    }

    test('the code gate precedes provider resolution: an UNKNOWN provider callback with no code is still "Authorization code is required" (never a 5xx / not-found)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        for (const unknown of ['gitlab', 'bitbucket', 'totally-not-a-provider']) {
            const res = await request.get(`${API_BASE}/api/oauth/${unknown}/callback/plugins`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `unknown ${unknown} no-code callback → 400`).toBe(400);
            const body = (await res.json()) as NestErrorBody;
            expect(body.message, `unknown ${unknown} hits the code gate first`).toBe(
                'Authorization code is required',
            );
            // The provider is never resolved (code gate short-circuits), so the
            // response must NOT be a not-found or an unmapped 500.
            expect(body.statusCode, `unknown ${unknown} is a 400, not 404/500`).toBe(400);
        }
    });

    test('connect/url and callback/plugins are GET-only: POSTing either is a framework routing 404 ("Cannot POST …"), not a controller error', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const h = authedHeaders(token);
        const routes = [
            `/api/oauth/github/connect/url`,
            `/api/oauth/github/callback/plugins`,
            `/api/oauth/vercel/connect/url`,
        ];
        for (const path of routes) {
            const res = await request.post(`${API_BASE}${path}`, { headers: h });
            expect(res.status(), `POST ${path} is an unmounted route → 404`).toBe(404);
            const body = (await res.json()) as NestErrorBody;
            expect(body.message, `POST ${path} is a framework routing miss`).toMatch(
                new RegExp(`^Cannot POST ${path.replace(/[/]/g, '\\/')}$`),
            );
            // A routing miss must NOT surface a controller message (credentials /
            // code / state) — that would mean the wrong verb reached the handler.
            expect(body.message, `POST ${path} is not a controller error`).not.toMatch(
                /credentials|Authorization code|state verification/i,
            );
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: connection + user read envelopes for BOTH advertised providers', () => {
    test('per-provider /connection returns a non-leaky not-connected descriptor for a fresh user (github + vercel)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        for (const p of PROVIDERS) {
            const c = await getConnection(request, token, p.id);
            expect(c.status, `${p.id} connection → 200`).toBe(200);
            expect(c.body.id, `${p.id} echoes id`).toBe(p.id);
            expect(c.body.name, `${p.id} display name`).toBe(p.name);
            expect(c.body.enabled, `${p.id} enabled`).toBe(true);
            expect(c.body.connected, `${p.id} not connected`).toBe(false);
            // A not-connected descriptor must never carry resolved identity.
            expect(c.body.username, `${p.id} no username leaked`).toBeFalsy();
            expect(c.body.email, `${p.id} no email leaked`).toBeFalsy();
            expect(c.body.avatarUrl, `${p.id} no avatar leaked`).toBeFalsy();
        }
    });

    test('per-provider /user for a disconnected user is a graceful { success:false, user:null, error } envelope (NOT a 5xx / thrown 401)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        for (const p of PROVIDERS) {
            const res = await request.get(`${API_BASE}/api/oauth/${p.id}/user`, {
                headers: authedHeaders(token),
            });
            // The controller catches the "no token" BadRequest and downgrades it
            // to a 200 failure envelope so the settings UI can render it inline.
            expect(res.status(), `${p.id} user endpoint → 200 failure envelope`).toBe(200);
            const body = (await res.json()) as {
                success: boolean;
                user: unknown;
                error?: string;
            };
            expect(body.success, `${p.id} disconnected lookup reports failure`).toBe(false);
            expect(body.user, `${p.id} disconnected lookup returns null user`).toBeNull();
            expect(String(body.error), `${p.id} error names the missing token`).toBe(
                `No valid token for provider ${p.id}`,
            );
        }
    });

    test('an unknown provider /connection resolves to a SAFE Unknown stub (disabled, never connected) rather than 404/500', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        for (const unknown of ['gitlab', 'bitbucket', 'totally-not-a-provider']) {
            const c = await getConnection(request, token, unknown);
            expect(c.status, `unknown ${unknown} still resolves 200`).toBe(200);
            expect(c.body.id, `unknown ${unknown} echoes the requested id`).toBe(unknown);
            expect(String(c.body.name), `unknown ${unknown} name is the Unknown stub`).toBe(
                'Unknown',
            );
            expect(c.body.enabled, `unknown ${unknown} is disabled`).toBe(false);
            expect(c.body.connected, `unknown ${unknown} is never connected`).toBe(false);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('flow: device-code shape + polling stability (codex)', () => {
    test('status and start AGREE on the scope/flowType literals, and start is 200 (HttpCode OK) — never the @Post default 201', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const h = authedHeaders(token);

        const statusRes = await request.get(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/status`, {
            headers: h,
        });
        expect(statusRes.status(), 'status → 200').toBe(200);
        const status = assertDeviceShape(await statusRes.json(), 'status');

        const startRes = await request.post(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/start`, {
            headers: h,
        });
        expect(startRes.status(), 'start → 200 (HttpCode OK)').toBe(200);
        expect(startRes.status(), 'start is explicitly not the 201 default').not.toBe(201);
        const start = assertDeviceShape(await startRes.json(), 'start');

        // The device-code grant's classification literals are stable across BOTH
        // endpoints — a single provider owns them for this user.
        expect(start.scope, 'start scope agrees with status').toBe(status.scope);
        expect(start.flowType, 'start flowType agrees with status').toBe(status.flowType);
    });

    test('polling status repeatedly is STABLE: it never accumulates a prompt and never auto-connects; env-adaptive message names the Codex CLI when uninstalled', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title.slice(0, 8));
        const h = authedHeaders(token);

        // Three consecutive polls. A pure query must not, by itself, mutate the
        // session: no prompt should appear and `connected` must not flip on.
        const snaps: DeviceAuthStatusShape[] = [];
        for (let i = 0; i < 3; i++) {
            const res = await request.get(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/status`, {
                headers: h,
            });
            expect(res.status(), `poll #${i + 1} → 200`).toBe(200);
            snaps.push(assertDeviceShape(await res.json(), `poll #${i + 1}`));
        }
        for (const [i, s] of snaps.entries()) {
            expect(s.installed, `poll #${i + 1} install bit stable`).toBe(snaps[0].installed);
            expect(s.connected, `poll #${i + 1} never auto-connects`).toBe(snaps[0].connected);
            if (!s.pending) {
                // Not-pending branch: the prompt (verificationUri + userCode) must
                // be strictly ABSENT — never half-populated.
                expect(s.prompt, `poll #${i + 1} emits no prompt when not pending`).toBeFalsy();
            }
        }
        // Environment-adaptive: CI has no Codex CLI, so the message names it and
        // the user cannot be connected.
        if (!snaps[0].installed) {
            expect(snaps[0].message, 'uninstalled message names the CLI').toMatch(/codex|install/i);
            expect(snaps[0].connected, 'uninstalled CLI cannot be connected').toBe(false);
        }
    });

    test("cross-surface per-user isolation: user A starting codex device-auth leaves BOTH user B's device status AND B's OAuth connection namespace untouched", async ({
        request,
    }, testInfo) => {
        const a = await freshToken(request, testInfo.title.slice(0, 6) + 'A');
        const b = await freshToken(request, testInfo.title.slice(0, 6) + 'B');

        // Baseline B on BOTH surfaces.
        const bDevice0 = await getDeviceStatus(request, b);
        const bConn0 = await getConnection(request, b, 'github');
        expect(bConn0.body.connected, 'B github not connected at baseline').toBe(false);
        expect(bDevice0.pending, 'B has no pending device session').toBe(false);

        // A mutates the DEVICE surface.
        const aStart = await request.post(`${API_BASE}/api/device-auth/${DEVICE_PLUGIN}/start`, {
            headers: authedHeaders(a),
        });
        expect(aStart.status(), 'A device start → 200').toBe(200);
        assertDeviceShape(await aStart.json(), 'A start');

        // B is untouched on BOTH surfaces — device sessions are user-keyed and
        // the two subsystems do not cross-contaminate across users.
        const bDevice1 = await getDeviceStatus(request, b);
        expect(bDevice1.pending, "A's start did not make B pending").toBe(false);
        expect(bDevice1.connected, "A's start did not connect B").toBe(false);
        expect(bDevice1.prompt, "A's prompt did not leak into B").toBeFalsy();
        const bConn1 = await getConnection(request, b, 'github');
        expect(bConn1.body.connected, "A's device start did not connect B's OAuth").toBe(false);
    });
});
