import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-plugin-oauth-deviceauth — deep, cross-feature INTEGRATION flows for the
 * plugin OAuth connection contract (`/api/oauth/*`) and the plugin device-auth
 * (device-code) contract (`/api/device-auth/*`).
 *
 * These are the multi-step companions to the single-endpoint smokes in
 * device-auth.spec.ts (4 status/start probes), oauth-cross-provider-isolation.
 * spec.ts (connect/url + connection shape), and flow-oauth-git-providers.spec.ts
 * (the social-login URL/callback CSRF matrix). NONE of those walk:
 *   - the full DeviceAuthStatus invariant matrix across a capable plugin
 *     (codex) AND the not-capable / not-found rejection ladder, in one flow;
 *   - device-auth status isolation across two freshly registered users +
 *     start→status idempotency (no shared session state leaks between users);
 *   - the connect → connection → user → disconnect lifecycle as a single
 *     stateful walk on one user, asserting disconnect is idempotent (204 twice);
 *   - the OAuth providers capability list reconciled against per-provider
 *     /connection for advertised vs. unknown providers;
 *   - the read-packages OAuth variant's independence from the main connect URL;
 *   - the auth boundary across BOTH controllers in a single matrix.
 *
 * SURFACE — verified live against http://127.0.0.1:3100 before any assertion
 * (CI driver = NestJS + sqlite in-memory; plugin OAuth creds + Codex CLI both
 * ABSENT, which is the real CI shape these flows assert against):
 *
 *   Device auth (apps/api/.../plugins-capabilities/device-auth):
 *     GET  /api/device-auth/:plugin/status   (authed) — 401 anon
 *     POST /api/device-auth/:plugin/start    (authed) — 401 anon
 *       capable plugin (codex)  → 200 DeviceAuthStatus
 *         { installed, connected, pending, scope:'user', flowType:'device-code',
 *           prompt?:{verificationUri,userCode}, message }
 *         (CI: installed=false, connected=false, pending=false,
 *          message="Codex CLI is not installed on this machine.")
 *       no device-auth capability (github/openrouter) → 400
 *         "Plugin \"<id>\" does not support device auth"
 *       unknown plugin (not-a-real-plugin)            → 404
 *         "Plugin \"<id>\" not found"
 *
 *   OAuth connection (apps/api/.../plugins-capabilities/oauth):
 *     GET    /api/oauth/providers              (authed) → { configured:bool,
 *                                                provided:[{id,name,enabled}] }
 *       CI: { configured:true, providers:[{id:'github',name:'GitHub',enabled:true}] }
 *     GET    /api/oauth/:p/connection          (authed) → ALWAYS 200
 *       advertised provider  → { id, name, enabled:true, connected:false }
 *       unknown/unadvertised → { id, name:'Unknown', enabled:false, connected:false }
 *     GET    /api/oauth/:p/connect/url         (authed) → { url, state } when
 *       plugin OAuth creds wired; else 400 "OAuth credentials not configured
 *       for provider: <p>". (CI: 400 — plugin-cap creds absent.)
 *     GET    /api/oauth/:p/read-packages/connect/url (authed) → same 200/400 ladder.
 *     GET    /api/oauth/:p/user                (authed) → 200 envelope
 *       disconnected → { success:false, user:null, error:"No valid token..." }
 *     GET    /api/oauth/:p/callback/plugins             → 400 "Authorization code is required" (no code)
 *     GET    /api/oauth/:p/callback/plugins/read-packages → 400 "Authorization code is required" (no code)
 *     DELETE /api/oauth/:p                     (authed) → 204 (idempotent — 204
 *       even for a user that was never connected; safe to call twice).
 *
 * Every assertion is platform-side; upstream providers (github.com, OpenAI
 * device endpoint) are NEVER contacted. The flows are environment-adaptive:
 * where a credential set is legitimately absent in CI we assert the truthful
 * "not configured" contract with .or()/branching rather than a fictional happy
 * path, and never require a 5xx-free fictional success.
 */

const DEVICE_AUTH_CAPABLE_PLUGIN = 'codex';
const NON_DEVICE_AUTH_PLUGINS = ['github', 'openrouter'];
const UNKNOWN_PLUGIN = 'not-a-real-plugin-xyz';

interface DeviceAuthStatusShape {
    installed: boolean;
    connected: boolean;
    pending: boolean;
    scope: string;
    flowType: string;
    prompt?: { verificationUri?: string; userCode?: string };
    message: string;
}

/**
 * Assert a payload satisfies the full DeviceAuthStatus invariant set. This is
 * the contract `packages/plugin/.../device-auth-provider.interface.ts` pins and
 * the codex provider implements; it must hold regardless of whether the backend
 * CLI happens to be installed in the running environment.
 */
function assertDeviceAuthStatusShape(body: unknown, ctx: string): DeviceAuthStatusShape {
    expect(body, `${ctx}: body is an object`).toBeTruthy();
    const s = body as DeviceAuthStatusShape;
    expect(typeof s.installed, `${ctx}: installed is boolean`).toBe('boolean');
    expect(typeof s.connected, `${ctx}: connected is boolean`).toBe('boolean');
    expect(typeof s.pending, `${ctx}: pending is boolean`).toBe('boolean');
    expect(s.scope, `${ctx}: scope is the user scope literal`).toBe('user');
    expect(s.flowType, `${ctx}: flowType is the device-code literal`).toBe('device-code');
    expect(typeof s.message, `${ctx}: message is a human string`).toBe('string');
    expect(s.message.length, `${ctx}: message is non-empty`).toBeGreaterThan(0);
    // Cross-field invariants that hold in EVERY DeviceAuthStatus branch:
    //   - a connected user is never simultaneously pending;
    //   - connecting requires the CLI installed (can't be connected if absent).
    expect(s.connected && s.pending, `${ctx}: never connected AND pending at once`).toBe(false);
    if (s.connected) {
        expect(s.installed, `${ctx}: connected implies installed`).toBe(true);
    }
    // `prompt`, when present, must carry BOTH the verification URI and the code —
    // a half-populated prompt is never returned (the provider only sets it once
    // both are discovered from the CLI output).
    if (s.prompt) {
        expect(typeof s.prompt.verificationUri, `${ctx}: prompt.verificationUri string`).toBe(
            'string',
        );
        expect(typeof s.prompt.userCode, `${ctx}: prompt.userCode string`).toBe('string');
    }
    return s;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const s = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: s.email, password: s.password },
    });
    expect(res.ok(), `seeded login failed: ${res.status()}`).toBe(true);
    return (await res.json()).access_token as string;
}

test.describe('flow: plugin device-auth capability ladder (capable → not-capable → not-found)', () => {
    test('one fresh user walks the full status+start contract for a capable plugin and the rejection ladder', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — Capable plugin (codex declares the `device-auth` capability).
        // GET status must return the full DeviceAuthStatus envelope, 200, even
        // though the managed Codex CLI is absent in CI. The status read is a
        // pure query — it must NOT spin up a session, so `pending` stays false.
        const statusRes = await request.get(
            `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
            { headers: h },
        );
        expect(statusRes.status(), 'codex status is 200 for an authed user').toBe(200);
        const status = assertDeviceAuthStatusShape(await statusRes.json(), 'codex status');

        // STEP 2 — Start. `start` returns the SAME envelope shape. In an env
        // where the CLI is not installed it short-circuits to installed:false /
        // pending:false (no orphaned child process); where it IS installed it
        // would return pending:true with a prompt. Assert the invariant set, and
        // that start never DOWNGRADES an already-connected user to disconnected.
        const startRes = await request.post(
            `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/start`,
            { headers: h },
        );
        expect(startRes.status(), 'codex start is 200 (HttpCode OK), not 201').toBe(200);
        const started = assertDeviceAuthStatusShape(await startRes.json(), 'codex start');
        if (status.connected) {
            expect(started.connected, 'start does not disconnect an already-connected user').toBe(
                true,
            );
        }
        // Environment-adaptive truth: when the CLI is absent, the message names
        // the missing CLI and neither installed nor pending flips on.
        if (!started.installed) {
            expect(started.pending, 'uninstalled CLI cannot have a pending session').toBe(false);
            expect(started.connected, 'uninstalled CLI cannot be connected').toBe(false);
            expect(started.message, 'uninstalled message names the CLI').toMatch(/codex|install/i);
        }

        // STEP 3 — Re-read status right after start: codex status is idempotent
        // and self-consistent — re-reading still satisfies the full invariant
        // set and agrees with start on the installed bit (same machine).
        const status2Res = await request.get(
            `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
            { headers: h },
        );
        expect(status2Res.status(), 'codex status (2nd) is 200').toBe(200);
        const status2 = assertDeviceAuthStatusShape(await status2Res.json(), 'codex status #2');
        expect(status2.installed, 'installed bit is stable across reads on one machine').toBe(
            started.installed,
        );

        // STEP 4 — Plugins that exist but do NOT declare the device-auth
        // capability are rejected with a precise 400 BEFORE any session work —
        // the capability array is the source of truth (manifest-validated),
        // guarding against a 500 from duck-typing an un-materialized plugin.
        for (const pluginId of NON_DEVICE_AUTH_PLUGINS) {
            for (const verb of ['status', 'start'] as const) {
                const res =
                    verb === 'status'
                        ? await request.get(`${API_BASE}/api/device-auth/${pluginId}/status`, {
                              headers: h,
                          })
                        : await request.post(`${API_BASE}/api/device-auth/${pluginId}/start`, {
                              headers: h,
                          });
                expect(
                    res.status(),
                    `${pluginId}/${verb} rejected as 400 (no device-auth capability), not 5xx`,
                ).toBe(400);
                const body = await res.json();
                expect(
                    String(body.message),
                    `${pluginId}/${verb} names the missing capability`,
                ).toMatch(/does not support device auth/i);
            }
        }

        // STEP 5 — A plugin id that is not registered at all is a 404 — and the
        // not-found check precedes the capability check (you never see a
        // "does not support" message for a non-existent plugin).
        const notFound = await request.get(`${API_BASE}/api/device-auth/${UNKNOWN_PLUGIN}/status`, {
            headers: h,
        });
        expect(notFound.status(), 'unknown plugin device-auth status → 404').toBe(404);
        const nfBody = await notFound.json();
        expect(String(nfBody.message), 'unknown plugin message is the not-found one').toMatch(
            /not found/i,
        );
        expect(String(nfBody.message), 'unknown plugin is NOT a capability error').not.toMatch(
            /does not support/i,
        );
    });
});

test.describe('flow: device-auth session isolation across two freshly-registered users', () => {
    test('user A and user B each get an independent device-auth status; A.start never leaks into B', async ({
        request,
    }) => {
        // Device-auth sessions are user-scoped (keyed by userId in the provider).
        // Two brand-new users must each see their OWN status, and starting a
        // flow for A must not surface a pending prompt for B.
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const ha = authedHeaders(a.access_token);
        const hb = authedHeaders(b.access_token);

        // STEP 1 — Baseline both users. Fresh users share the same machine-level
        // installed bit but each owns its own session state (none yet).
        const aStatus0 = assertDeviceAuthStatusShape(
            await (
                await request.get(
                    `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
                    {
                        headers: ha,
                    },
                )
            ).json(),
            'A baseline',
        );
        const bStatus0 = assertDeviceAuthStatusShape(
            await (
                await request.get(
                    `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
                    {
                        headers: hb,
                    },
                )
            ).json(),
            'B baseline',
        );
        expect(aStatus0.installed, 'both users see the same machine install bit').toBe(
            bStatus0.installed,
        );
        expect(aStatus0.pending, 'A has no pending session at baseline').toBe(false);
        expect(bStatus0.pending, 'B has no pending session at baseline').toBe(false);

        // STEP 2 — Start the flow for A only.
        const aStart = assertDeviceAuthStatusShape(
            await (
                await request.post(
                    `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/start`,
                    {
                        headers: ha,
                    },
                )
            ).json(),
            'A start',
        );

        // STEP 3 — B's status must be UNCHANGED by A's start. The critical
        // isolation invariant: A's pending/prompt (if any) never appears for B.
        const bStatus1 = assertDeviceAuthStatusShape(
            await (
                await request.get(
                    `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
                    {
                        headers: hb,
                    },
                )
            ).json(),
            'B after A.start',
        );
        expect(bStatus1.pending, "A's start did not make B pending").toBe(false);
        expect(bStatus1.prompt, "A's prompt did not leak into B's status").toBeFalsy();
        expect(bStatus1.connected, "A's start did not connect B").toBe(false);

        // STEP 4 — If A's environment HAS the CLI and a session began, A may be
        // pending; B must still be quiescent. If A's env has no CLI, both stay
        // installed:false. Either way the two users' connected states are
        // independent and B never inherits A's session.
        if (aStart.pending) {
            expect(bStatus1.pending, 'pending is per-user (A pending, B not)').toBe(false);
        }
    });
});

test.describe('flow: OAuth provider connection lifecycle (connection → user → connect/url → disconnect)', () => {
    test('a fresh user walks the full not-connected lifecycle and disconnect is idempotent (204 twice)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const provider = 'github';

        // STEP 1 — Connection status for a brand-new user is a stable, non-leaky
        // "not connected" with the provider descriptor echoed back.
        const conn = await request.get(`${API_BASE}/api/oauth/${provider}/connection`, {
            headers: h,
        });
        expect(conn.status(), 'connection is 200').toBe(200);
        const connBody = await conn.json();
        expect(connBody.id, 'connection echoes provider id').toBe(provider);
        expect(typeof connBody.enabled, 'connection has enabled flag').toBe('boolean');
        expect(connBody.connected, 'fresh user is not connected').toBe(false);
        // A not-connected connection must never carry resolved identity fields.
        expect(connBody.username, 'no username leaked when not connected').toBeFalsy();
        expect(connBody.email, 'no email leaked when not connected').toBeFalsy();

        // STEP 2 — The /user endpoint returns a graceful failure envelope (NOT a
        // 5xx, NOT a thrown 401) because there is no stored token. The controller
        // catches the BadRequest and downgrades it to { success:false, user:null }.
        const user = await request.get(`${API_BASE}/api/oauth/${provider}/user`, { headers: h });
        expect(user.status(), 'user endpoint returns 200 with a failure envelope').toBe(200);
        const userBody = await user.json();
        expect(userBody.success, 'disconnected user lookup reports failure').toBe(false);
        expect(userBody.user, 'disconnected user lookup returns null user').toBeNull();
        expect(String(userBody.error), 'error names the missing token').toMatch(
            /no valid token|token/i,
        );

        // STEP 3 — The connect entry-point. ENVIRONMENT-ADAPTIVE: in this CI env
        // the plugin-capability OAuth credentials are absent, so connect/url
        // returns a truthful 400 "not configured"; when wired it returns
        // { url, state } pointing at the upstream authorize endpoint. Never 5xx.
        const connectRes = await request.get(`${API_BASE}/api/oauth/${provider}/connect/url`, {
            headers: h,
        });
        expect(connectRes.status(), 'connect/url never 5xx').toBeLessThan(500);
        const connectBody = await connectRes.json();
        if (connectRes.status() === 400) {
            expect(
                String(connectBody.message),
                'unconfigured connect/url names missing credentials',
            ).toMatch(/not configured|credentials/i);
        } else {
            expect(connectRes.status(), 'configured connect/url is 200').toBe(200);
            expect(typeof connectBody.url, 'connect/url returns a string url').toBe('string');
            expect(typeof connectBody.state, 'connect/url returns a string state').toBe('string');
            expect(
                new URL(connectBody.url).searchParams.get('state'),
                'connect/url embeds its own state (CSRF binding)',
            ).toBe(connectBody.state);
        }

        // STEP 4 — Disconnect. The platform contract is idempotent: revoking a
        // connection that never existed still returns 204 No Content, and a
        // second disconnect is equally a 204 (no 404 / no 409 / no 5xx). This is
        // the resilience property the settings UI relies on.
        const del1 = await request.delete(`${API_BASE}/api/oauth/${provider}`, { headers: h });
        expect(del1.status(), 'first disconnect is 204 even when never connected').toBe(204);
        const del2 = await request.delete(`${API_BASE}/api/oauth/${provider}`, { headers: h });
        expect(del2.status(), 'second disconnect is idempotently 204').toBe(204);

        // STEP 5 — Post-disconnect, connection is still cleanly not-connected.
        const connAfter = await request.get(`${API_BASE}/api/oauth/${provider}/connection`, {
            headers: h,
        });
        expect(connAfter.status(), 'connection after disconnect is 200').toBe(200);
        expect(
            (await connAfter.json()).connected,
            'still not connected after idempotent disconnects',
        ).toBe(false);
    });
});

test.describe('flow: OAuth capability list reconciles with per-provider connection (advertised vs unknown)', () => {
    test('every advertised provider resolves an enabled connection; unknown ids resolve to a safe Unknown stub', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — The authed capability list. Shape is { configured, providers }.
        const listRes = await request.get(`${API_BASE}/api/oauth/providers`, { headers: h });
        expect(listRes.status(), 'oauth/providers is 200 for an authed user').toBe(200);
        const list = await listRes.json();
        expect(typeof list.configured, 'list has a configured boolean').toBe('boolean');
        expect(Array.isArray(list.providers), 'providers is an array').toBe(true);
        const advertised: Array<{ id: string; name: string; enabled: boolean }> = list.providers;
        expect(advertised.length, 'at least one OAuth provider is advertised').toBeGreaterThan(0);

        // STEP 2 — For EVERY advertised provider, /connection must agree with the
        // list: same id, enabled:true (advertised => enabled), connected:false
        // for this fresh user. This proves the list and the per-provider resolver
        // are backed by the same source of truth.
        for (const p of advertised) {
            expect(typeof p.id, 'advertised provider has a string id').toBe('string');
            expect(p.enabled, `advertised provider ${p.id} is enabled`).toBe(true);
            const conn = await request.get(`${API_BASE}/api/oauth/${p.id}/connection`, {
                headers: h,
            });
            expect(conn.status(), `${p.id} connection is 200`).toBe(200);
            const body = await conn.json();
            expect(body.id, `${p.id} connection echoes id`).toBe(p.id);
            expect(body.enabled, `${p.id} connection enabled agrees with the list`).toBe(true);
            expect(body.connected, `${p.id} not connected for fresh user`).toBe(false);
        }

        // STEP 3 — An id NOT in the advertised list resolves to a SAFE stub
        // rather than 404/500: { name:'Unknown', enabled:false, connected:false }.
        // This is the defensive contract the UI relies on to render any provider
        // id without crashing. Pick an id guaranteed absent from the list.
        const advertisedIds = new Set(advertised.map((p) => p.id));
        const phantom = ['gitlab', 'bitbucket', 'totally-not-a-provider'].find(
            (id) => !advertisedIds.has(id),
        )!;
        const phantomConn = await request.get(`${API_BASE}/api/oauth/${phantom}/connection`, {
            headers: h,
        });
        expect(phantomConn.status(), `unknown provider ${phantom} still resolves 200`).toBe(200);
        const phantomBody = await phantomConn.json();
        expect(phantomBody.id, 'unknown provider echoes the requested id').toBe(phantom);
        expect(phantomBody.enabled, 'unknown provider is disabled').toBe(false);
        expect(phantomBody.connected, 'unknown provider is never connected').toBe(false);
        expect(String(phantomBody.name), 'unknown provider name is the Unknown stub').toMatch(
            /unknown/i,
        );
    });
});

test.describe('flow: read-packages OAuth variant is independent of the main connect flow + callbacks gate on code', () => {
    test('read-packages connect/url and callbacks share the missing-credential / missing-code ladder without touching the main connection', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const provider = 'github';

        // STEP 1 — The read-packages connect URL is a SEPARATE entry-point that
        // requests read:packages + write:packages scopes and stores its token in
        // plugin settings (readPackagesPat) WITHOUT replacing the main OAuth
        // connection. It shares the same credential gate as the main connect URL,
        // so both must report the same configured/unconfigured truth.
        const mainUrl = await request.get(`${API_BASE}/api/oauth/${provider}/connect/url`, {
            headers: h,
        });
        const rpUrl = await request.get(
            `${API_BASE}/api/oauth/${provider}/read-packages/connect/url`,
            { headers: h },
        );
        expect(mainUrl.status(), 'main connect/url never 5xx').toBeLessThan(500);
        expect(rpUrl.status(), 'read-packages connect/url never 5xx').toBeLessThan(500);
        // Both flows share the SAME GitHub OAuth app credentials, so they agree
        // on whether the provider is configured.
        expect(rpUrl.status() === 400, 'read-packages configured-state mirrors the main flow').toBe(
            mainUrl.status() === 400,
        );
        if (rpUrl.status() === 400) {
            expect(
                String((await rpUrl.json()).message),
                'unconfigured read-packages url names credentials',
            ).toMatch(/not configured|credentials/i);
        } else {
            const body = await rpUrl.json();
            expect(typeof body.url, 'configured read-packages url is a string').toBe('string');
            expect(typeof body.state, 'configured read-packages url has a state').toBe('string');
        }

        // STEP 2 — Both callback handlers (main + read-packages) require an
        // authorization code BEFORE any provider work. Omitting `code` is a
        // precise 400 regardless of which flow — proving the code gate runs
        // before the (unreachable) upstream token exchange.
        const callbacks = [
            { name: 'main', path: `callback/plugins` },
            { name: 'read-packages', path: `callback/plugins/read-packages` },
        ];
        for (const cb of callbacks) {
            const res = await request.get(`${API_BASE}/api/oauth/${provider}/${cb.path}`, {
                headers: h,
            });
            expect(res.status(), `${cb.name} callback without code → 400`).toBe(400);
            expect(
                String((await res.json()).message),
                `${cb.name} callback names the required code`,
            ).toMatch(/authorization code is required/i);
        }

        // STEP 3 — The read-packages flow must NOT have established the MAIN
        // connection: the user's main github connection is still not-connected.
        // (The read-packages token lives in plugin settings, separate from
        // authAccountRepository.) Hitting it must never have flipped `connected`.
        const conn = await request.get(`${API_BASE}/api/oauth/${provider}/connection`, {
            headers: h,
        });
        expect(conn.status(), 'connection still resolves 200').toBe(200);
        expect(
            (await conn.json()).connected,
            'read-packages probes did not establish the main connection',
        ).toBe(false);
    });
});

test.describe('flow: auth boundary across BOTH plugin-cap controllers (device-auth + oauth)', () => {
    test('every device-auth and oauth mutation/read rejects anonymous callers with 401, then admits an authed user', async ({
        request,
        browser,
    }) => {
        // An anonymous context. Note: bare browser.newContext() would INHERIT the
        // setup storageState cookie; pass an empty storageState for a true anon.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = anonCtx.request;

        // STEP 1 — Both controllers are guarded by AuthSessionGuard. Walk the
        // full matrix of endpoints; each must be a hard 401 for an anon caller,
        // BEFORE any plugin/provider resolution (so a 404/400 must NOT pre-empt
        // the auth check).
        const anonProbes: Array<{ method: 'get' | 'post' | 'delete'; path: string }> = [
            { method: 'get', path: `/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status` },
            { method: 'post', path: `/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/start` },
            // Even an unknown plugin must 401 (auth precedes the not-found check).
            { method: 'get', path: `/api/device-auth/${UNKNOWN_PLUGIN}/status` },
            { method: 'get', path: `/api/oauth/providers` },
            { method: 'get', path: `/api/oauth/github/connection` },
            { method: 'get', path: `/api/oauth/github/connect/url` },
            { method: 'get', path: `/api/oauth/github/user` },
            { method: 'delete', path: `/api/oauth/github` },
        ];
        try {
            for (const probe of anonProbes) {
                const res =
                    probe.method === 'get'
                        ? await anon.get(`${API_BASE}${probe.path}`)
                        : probe.method === 'post'
                          ? await anon.post(`${API_BASE}${probe.path}`)
                          : await anon.delete(`${API_BASE}${probe.path}`);
                expect(res.status(), `anon ${probe.method.toUpperCase()} ${probe.path} → 401`).toBe(
                    401,
                );
            }
        } finally {
            await anonCtx.close();
        }

        // STEP 2 — The SAME endpoints, presented with a valid bearer (the seeded
        // storageState user), are admitted: device-auth status is 200, oauth
        // providers is 200. This proves the 401s above were the guard, not a
        // universally-broken route.
        const token = await seededToken(request);
        const h = authedHeaders(token);

        const da = await request.get(
            `${API_BASE}/api/device-auth/${DEVICE_AUTH_CAPABLE_PLUGIN}/status`,
            { headers: h },
        );
        expect(da.status(), 'authed seeded user is admitted to device-auth status').toBe(200);
        assertDeviceAuthStatusShape(await da.json(), 'seeded device-auth status');

        const providers = await request.get(`${API_BASE}/api/oauth/providers`, { headers: h });
        expect(providers.status(), 'authed seeded user is admitted to oauth/providers').toBe(200);
        const provBody = await providers.json();
        expect(Array.isArray(provBody.providers), 'authed providers list is an array').toBe(true);
    });
});
