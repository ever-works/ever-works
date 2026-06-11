import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-device-auth-flow — controller-level contract pinning for the plugin
 * device-code grant under `/api/device-auth/:pluginId/{status,start}`
 * (apps/api/src/plugins-capabilities/device-auth/device-auth.controller.ts →
 * DeviceAuthService → PluginOperationsService.getDeviceAuthProvider).
 *
 * This is the OAuth-device-code grant plugins/CLIs use to log a user into a
 * managed external tool (Codex CLI is the only `device-auth`-capable plugin on
 * `develop`). The controller is `@UseGuards(AuthSessionGuard)`; both routes are
 * `@HttpCode(HttpStatus.OK)`.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────────
 * Two existing specs touch this surface; this file deliberately asserts a
 * DISJOINT set of controller contracts:
 *   • device-auth.spec.ts — 4 shallow smokes (anon 401 ×2; one start/status
 *     "shape includes a code-or-url" probe that test.skip()s when not configured
 *     using `github`). It never pins the NestJS exception ENVELOPE, the HTTP
 *     method/routing semantics, the 200-not-201 status code, the poll-vs-approve
 *     (`pending`) semantics, or plugin-id case sensitivity.
 *   • flow-plugin-oauth-deviceauth.spec.ts — deep DeviceAuthStatus invariant
 *     matrix + two-user session isolation, but BUNDLED with the whole `/api/oauth`
 *     connection lifecycle, and gated on a module-scope loadSeededTestUser()
 *     in one of its describes. It asserts `body.message` regex only — never the
 *     `error`/`statusCode` envelope fields, the wrong-HTTP-verb 404 routing
 *     contract, the start↔201 distinction, the prompt-absent-when-not-pending
 *     poll contract, case sensitivity, or bad-/empty-bearer 401 bodies.
 * Everything below is fresh-registered-user / raw-fetch only — NO module-scope
 * seeded user, NO module-scope await.
 *
 * ── PROBED CONTRACTS (live http://127.0.0.1:3100, before any assertion) ──────
 * Capable plugin id = `codex` (declares PLUGIN_CAPABILITIES.DEVICE_AUTH).
 *   GET  /api/device-auth/codex/status (authed) → 200 DeviceAuthStatus
 *     { installed:false, connected:false, pending:false, scope:'user',
 *       flowType:'device-code', message:'Codex CLI is not installed on this
 *       machine.' }  (no `prompt` key in the not-pending branch)
 *   POST /api/device-auth/codex/start  (authed) → 200 (NOT 201),
 *       Content-Type application/json; same DeviceAuthStatus envelope.
 *   Anon (empty storageState) on either route → 401 { message:'Unauthorized',
 *       statusCode:401 }.   Bad/empty bearer → identical 401 body.
 *   Plugin WITHOUT the capability (github/openrouter/anthropic/openai/
 *       claude-code/gemini/opencode/...) → 400
 *       { message:'Plugin "<id>" does not support device auth',
 *         error:'Bad Request', statusCode:400 }.
 *   Unknown plugin id (zzz-nope / UPPERCASE CODEX / mixed-case Codex /
 *       traversal-ish `../../etc`) → 404
 *       { message:'Plugin "<id>" not found', error:'Not Found', statusCode:404 }.
 *       (not-found is checked BEFORE the capability gate; ids are case-sensitive.)
 *   Wrong HTTP verb (GET /start, POST /status, DELETE /status) → 404
 *       { message:'Cannot <VERB> /api/device-auth/codex/<seg>', error:'Not Found' }.
 *
 * The managed Codex CLI is ABSENT in CI (keyless sqlite driver) — exactly the
 * shape these assertions target. Upstream OpenAI device endpoints are NEVER
 * contacted; every assertion is platform-side and environment-adaptive (where a
 * branch depends on the CLI being installed we branch on `installed`/`pending`
 * rather than demand a fictional happy path).
 */

const DEVICE_AUTH_PLUGIN = 'codex';

interface DeviceAuthStatusShape {
    installed: boolean;
    connected: boolean;
    pending: boolean;
    scope: string;
    flowType: string;
    prompt?: { verificationUri?: string; userCode?: string };
    message: string;
}

interface NestErrorBody {
    message: string;
    error?: string;
    statusCode: number;
}

/**
 * Assert the DeviceAuthStatus invariant set the
 * `device-auth-provider.interface.ts` contract pins and codex implements. Holds
 * regardless of whether the managed CLI is installed on the running machine.
 */
function assertStatusShape(body: unknown, ctx: string): DeviceAuthStatusShape {
    expect(body, `${ctx}: body is an object`).toBeTruthy();
    const s = body as DeviceAuthStatusShape;
    expect(typeof s.installed, `${ctx}: installed boolean`).toBe('boolean');
    expect(typeof s.connected, `${ctx}: connected boolean`).toBe('boolean');
    expect(typeof s.pending, `${ctx}: pending boolean`).toBe('boolean');
    expect(s.scope, `${ctx}: scope literal`).toBe('user');
    expect(s.flowType, `${ctx}: flowType literal`).toBe('device-code');
    expect(typeof s.message, `${ctx}: message string`).toBe('string');
    expect(s.message.length, `${ctx}: message non-empty`).toBeGreaterThan(0);
    return s;
}

/**
 * Per-test unique suffix WITHOUT calling a clock at module scope (house rule):
 * derived from the test title + a per-file monotonic counter.
 */
let __counter = 0;
function uniqueSuffix(title: string): string {
    __counter += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '').slice(0, 12)}${__counter}`;
}

async function freshToken(request: APIRequestContext, title: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `da-${uniqueSuffix(title)}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    });
    return u.access_token;
}

test.describe('device-auth controller — happy-path status/start envelope', () => {
    test('GET status for the capable plugin returns the full DeviceAuthStatus envelope (200)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'codex status is 200 for an authed user').toBe(200);
        expect(res.headers()['content-type'], 'status is JSON').toMatch(/application\/json/i);
        assertStatusShape(await res.json(), 'codex status');
    });

    test('POST start returns 200 (HttpCode OK) — NOT 201 Created — with a JSON envelope', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/start`, {
            headers: authedHeaders(token),
        });
        // The controller annotates @HttpCode(HttpStatus.OK); a plain @Post would
        // default to 201. Pinning 200 guards that decorator from silent removal.
        expect(res.status(), 'codex start is 200, not the @Post default 201').toBe(200);
        expect(res.status(), 'start is explicitly not 201').not.toBe(201);
        expect(res.headers()['content-type'], 'start is JSON').toMatch(/application\/json/i);
        assertStatusShape(await res.json(), 'codex start');
    });

    test('status is a PURE QUERY: poll-before-approve never auto-connects and never half-populates a prompt', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        const res = await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
            headers: h,
        });
        expect(res.status(), 'status 200').toBe(200);
        const s = assertStatusShape(await res.json(), 'codex status poll');
        // A status poll must not, by itself, mark the user connected (that would
        // be an approval). `connected` and `pending` are the device-code grant's
        // "authorized" vs "authorization_pending" signals.
        expect(s.connected && s.pending, 'never connected AND pending simultaneously').toBe(false);
        // `prompt` (verificationUri + userCode) is only emitted once a session is
        // pending; in the not-pending branch it must be ABSENT, never half-set.
        if (s.pending) {
            expect(s.prompt, 'a pending session carries a prompt').toBeTruthy();
            expect(typeof s.prompt?.verificationUri, 'prompt.verificationUri string').toBe(
                'string',
            );
            expect(typeof s.prompt?.userCode, 'prompt.userCode string').toBe('string');
        } else {
            expect(s.prompt, 'no prompt is emitted when not pending').toBeFalsy();
            // Environment-adaptive: CI has no Codex CLI → message names it.
            if (!s.installed) {
                expect(s.message, 'uninstalled message names the CLI').toMatch(/codex|install/i);
                expect(s.connected, 'uninstalled CLI cannot be connected').toBe(false);
            }
        }
    });

    test('start is idempotent for the not-installed env: re-calling does not mutate the installed/connected bits', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        const first = assertStatusShape(
            await (
                await request.post(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/start`, {
                    headers: h,
                })
            ).json(),
            'start #1',
        );
        const second = assertStatusShape(
            await (
                await request.post(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/start`, {
                    headers: h,
                })
            ).json(),
            'start #2',
        );
        // Same machine, same user, no CLI: installed/connected are stable. start
        // never DOWNGRADES an already-connected user to disconnected either.
        expect(second.installed, 'installed bit stable across repeated start').toBe(
            first.installed,
        );
        if (first.connected) {
            expect(second.connected, 'repeated start never disconnects a connected user').toBe(
                true,
            );
        }
        // And a status read right after agrees with start on the machine bit.
        const afterStatus = assertStatusShape(
            await (
                await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
                    headers: h,
                })
            ).json(),
            'status after start',
        );
        expect(afterStatus.installed, 'status agrees with start on installed').toBe(
            first.installed,
        );
    });
});

test.describe('device-auth controller — capability + not-found rejection ladder', () => {
    test('a plugin that exists but lacks the device-auth capability is a precise 400 with the full NestJS envelope', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        // Several real plugins that are NOT device-auth providers. The capability
        // is gated on the manifest `capabilities` array (source of truth), so this
        // is a clean 400, never a 5xx from duck-typing an un-materialized plugin.
        const nonCapable = [
            'github',
            'openrouter',
            'anthropic',
            'openai',
            'claude-code',
            'gemini',
            'opencode',
        ];
        for (const id of nonCapable) {
            for (const verb of ['status', 'start'] as const) {
                const res =
                    verb === 'status'
                        ? await request.get(`${API_BASE}/api/device-auth/${id}/status`, {
                              headers: h,
                          })
                        : await request.post(`${API_BASE}/api/device-auth/${id}/start`, {
                              headers: h,
                          });
                expect(res.status(), `${id}/${verb} → 400 (no device-auth capability)`).toBe(400);
                const body = (await res.json()) as NestErrorBody;
                expect(body.message, `${id}/${verb} names the missing capability`).toBe(
                    `Plugin "${id}" does not support device auth`,
                );
                expect(body.error, `${id}/${verb} carries the Bad Request error label`).toBe(
                    'Bad Request',
                );
                expect(body.statusCode, `${id}/${verb} statusCode mirrors 400`).toBe(400);
            }
        }
    });

    test('an unregistered plugin id is 404 Not Found — and not-found is checked BEFORE the capability gate', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        for (const id of ['zzz-nope', 'not-a-real-plugin-xyz']) {
            for (const verb of ['status', 'start'] as const) {
                const res =
                    verb === 'status'
                        ? await request.get(`${API_BASE}/api/device-auth/${id}/status`, {
                              headers: h,
                          })
                        : await request.post(`${API_BASE}/api/device-auth/${id}/start`, {
                              headers: h,
                          });
                expect(res.status(), `${id}/${verb} → 404`).toBe(404);
                const body = (await res.json()) as NestErrorBody;
                expect(body.message, `${id}/${verb} is the not-found message`).toBe(
                    `Plugin "${id}" not found`,
                );
                expect(body.error, `${id}/${verb} Not Found label`).toBe('Not Found');
                expect(body.statusCode, `${id}/${verb} statusCode 404`).toBe(404);
                // A non-existent plugin must NEVER surface the capability message
                // — that would prove the gate ran in the wrong order.
                expect(body.message, `${id}/${verb} is not a capability error`).not.toMatch(
                    /does not support/i,
                );
            }
        }
    });

    test('plugin ids are CASE-SENSITIVE: the capable id only matches lowercase `codex` — uppercase/mixed resolve to 404', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        // The lowercase id is capable (200); case variants are unknown ids (404),
        // proving the registry lookup is an exact match (no normalization that
        // could collide distinct plugin ids).
        const ok = await request.get(`${API_BASE}/api/device-auth/codex/status`, { headers: h });
        expect(ok.status(), 'lowercase codex is the capable plugin (200)').toBe(200);
        for (const variant of ['CODEX', 'Codex', 'coDex']) {
            const res = await request.get(`${API_BASE}/api/device-auth/${variant}/status`, {
                headers: h,
            });
            expect(res.status(), `case variant ${variant} is an unknown id → 404`).toBe(404);
            const body = (await res.json()) as NestErrorBody;
            expect(body.message, `${variant} is the not-found message`).toBe(
                `Plugin "${variant}" not found`,
            );
        }
    });

    test('a path-traversal-ish plugin segment is safely echoed and 404d (no resolution, no 5xx)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        // `%2f`-encoded slashes decode to a single route segment; the service
        // treats it as an opaque plugin id, finds nothing, and 404s cleanly.
        const res = await request.get(`${API_BASE}/api/device-auth/..%2f..%2fetc/status`, {
            headers: h,
        });
        expect(res.status(), 'traversal-ish id resolves to a clean 404, never 5xx').toBe(404);
        const body = (await res.json()) as NestErrorBody;
        expect(body.message, 'traversal-ish id echoed as an unknown plugin').toBe(
            'Plugin "../../etc" not found',
        );
        expect(body.error, 'traversal-ish id Not Found label').toBe('Not Found');
    });
});

test.describe('device-auth controller — HTTP method / routing contract', () => {
    test('only GET /status and POST /start are mounted; every other verb on those segments is a routing 404', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const h = authedHeaders(token);
        // These are framework ROUTING 404s ("Cannot <VERB> <path>"), distinct from
        // the service's "Plugin not found" 404 — pinning that /status is GET-only
        // and /start is POST-only (an accidental @All or duplicate route would
        // change these). All on the capable `codex` id so a not-found can't mask it.
        const wrong: Array<{ method: 'get' | 'post' | 'delete' | 'put'; seg: string }> = [
            { method: 'get', seg: 'start' }, // start is POST-only
            { method: 'post', seg: 'status' }, // status is GET-only
            { method: 'delete', seg: 'status' },
            { method: 'put', seg: 'start' },
        ];
        for (const w of wrong) {
            const url = `${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/${w.seg}`;
            const res =
                w.method === 'get'
                    ? await request.get(url, { headers: h })
                    : w.method === 'post'
                      ? await request.post(url, { headers: h })
                      : w.method === 'delete'
                        ? await request.delete(url, { headers: h })
                        : await request.put(url, { headers: h });
            expect(
                res.status(),
                `${w.method.toUpperCase()} /${w.seg} is an unmounted route → 404`,
            ).toBe(404);
            const body = (await res.json()) as NestErrorBody;
            // Framework routing miss is "Cannot <VERB> <path>", NOT the service's
            // "Plugin ... not found" / "does not support" messages.
            expect(body.message, `${w.method} /${w.seg} is a framework routing miss`).toMatch(
                /^Cannot (GET|POST|DELETE|PUT) \/api\/device-auth\/codex\//,
            );
            expect(body.message, 'routing miss is not a plugin error').not.toMatch(
                /does not support|Plugin "/,
            );
        }
    });
});

test.describe('device-auth controller — auth gating (AuthSessionGuard)', () => {
    test('anonymous callers (empty storageState) are rejected 401 on BOTH routes before any plugin resolution', async ({
        browser,
    }) => {
        // browser.newContext() would INHERIT the chromium project storageState
        // cookie; an explicit empty storageState gives a true anonymous client.
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anon = anonCtx.request;
            // Capable id AND unknown id: a 401 must precede both the capability
            // and the not-found checks (the guard runs before the controller).
            const probes: Array<{ method: 'get' | 'post'; path: string }> = [
                { method: 'get', path: `/api/device-auth/${DEVICE_AUTH_PLUGIN}/status` },
                { method: 'post', path: `/api/device-auth/${DEVICE_AUTH_PLUGIN}/start` },
                { method: 'get', path: `/api/device-auth/zzz-unknown-plugin/status` },
                { method: 'get', path: `/api/device-auth/github/status` },
            ];
            for (const p of probes) {
                const res =
                    p.method === 'get'
                        ? await anon.get(`${API_BASE}${p.path}`)
                        : await anon.post(`${API_BASE}${p.path}`);
                expect(res.status(), `anon ${p.method.toUpperCase()} ${p.path} → 401`).toBe(401);
                const body = (await res.json()) as NestErrorBody;
                expect(body.statusCode, `anon ${p.path} statusCode 401`).toBe(401);
                expect(String(body.message), `anon ${p.path} is Unauthorized`).toMatch(
                    /unauthorized/i,
                );
                // Auth precedes plugin resolution: an anon hit on an unknown/non-
                // capable plugin must NOT leak the not-found / capability message.
                expect(
                    String(body.message),
                    `anon ${p.path} does not leak a plugin error`,
                ).not.toMatch(/does not support|not found/i);
            }
        } finally {
            await anonCtx.close();
        }
    });

    test('a malformed or empty bearer is treated as anonymous → identical 401 envelope', async ({
        browser,
    }) => {
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anon = anonCtx.request;
            const headerVariants = [
                { name: 'garbage token', value: 'Bearer not-a-real-token-xyz' },
                { name: 'empty bearer', value: 'Bearer ' },
            ];
            for (const v of headerVariants) {
                const res = await anon.get(
                    `${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`,
                    { headers: { Authorization: v.value } },
                );
                expect(res.status(), `${v.name} → 401`).toBe(401);
                const body = (await res.json()) as NestErrorBody;
                expect(body.statusCode, `${v.name} statusCode 401`).toBe(401);
                expect(String(body.message), `${v.name} is Unauthorized`).toMatch(/unauthorized/i);
            }
        } finally {
            await anonCtx.close();
        }
    });

    test('a freshly registered bearer is ADMITTED to status (proving the 401s were the guard, not a dead route)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'a valid bearer is admitted (200)').toBe(200);
        assertStatusShape(await res.json(), 'authed admitted status');
    });
});

test.describe('device-auth controller — per-user session independence', () => {
    test('two freshly-registered users each get their own status; one user starting a flow does not leak into the other', async ({
        request,
    }, testInfo) => {
        // Sessions are keyed by userId in the provider, so two brand-new users
        // must observe independent state and B must never inherit A's session.
        const a = await freshToken(request, testInfo.title + 'A');
        const b = await freshToken(request, testInfo.title + 'B');
        const ha = authedHeaders(a);
        const hb = authedHeaders(b);

        const aBefore = assertStatusShape(
            await (
                await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
                    headers: ha,
                })
            ).json(),
            'A before',
        );
        const bBefore = assertStatusShape(
            await (
                await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
                    headers: hb,
                })
            ).json(),
            'B before',
        );
        // Same host → same machine-level `installed` bit, but each owns its session.
        expect(aBefore.installed, 'both users observe the same machine install bit').toBe(
            bBefore.installed,
        );
        expect(bBefore.pending, 'B has no pending session at baseline').toBe(false);

        // A starts a flow.
        const aStart = assertStatusShape(
            await (
                await request.post(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/start`, {
                    headers: ha,
                })
            ).json(),
            'A start',
        );

        // B's status must be untouched by A's start — the key isolation invariant.
        const bAfter = assertStatusShape(
            await (
                await request.get(`${API_BASE}/api/device-auth/${DEVICE_AUTH_PLUGIN}/status`, {
                    headers: hb,
                })
            ).json(),
            'B after A.start',
        );
        expect(bAfter.pending, "A's start did not make B pending").toBe(false);
        expect(bAfter.prompt, "A's prompt did not leak into B").toBeFalsy();
        expect(bAfter.connected, "A's start did not connect B").toBe(false);
        if (aStart.pending) {
            expect(bAfter.pending, 'pending is per-user (A pending, B not)').toBe(false);
        }
    });
});
