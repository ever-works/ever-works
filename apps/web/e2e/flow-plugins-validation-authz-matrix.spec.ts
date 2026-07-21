import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * PLUGINS — VALIDATION & AUTHZ MATRIX (`/api/plugins` + per-work plugins +
 * settings/plugins categories).
 *
 * Where the sibling `flow-plugin-*` specs drive ONE provider deeply
 * (openrouter catalogue → completion) or assert the system-plugin COHORT
 * invariants, THIS file is a pure EDGE / VALIDATION / AUTHZ matrix: one
 * assertion cluster per DTO field across every write endpoint, the full
 * unauth / cross-user / unknown-id / malformed-id surface, and — the novel
 * angle — the THREE DISTINCT 400 error SHAPES the plugin controller emits,
 * which are easy to conflate:
 *
 *   SHAPE ①  class-validator (DTO)      → { message: string[], error:'Bad Request', statusCode:400 }
 *   SHAPE ②  plugin JSON-schema         → { message:'Invalid plugin settings', errors: string[] }
 *   SHAPE ③  work needs user settings   → { message:'User-level required settings must be configured first', errors: string[] }
 *
 * Every contract below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100, CI sqlite build, 85 plugins / 18 categories) with
 * throwaway users BEFORE the assertions were written — this pins REAL
 * behaviour, not a guess.
 *
 * PROBED CONTRACTS
 *   Listing
 *     - GET /api/plugins → { plugins:[…], total:N (===plugins.length),
 *       categories:string[], capabilities:string[] }.
 *     - GET /api/plugins?category=X → filters to category X **and only
 *       ENABLED plugins in it** (the settings-page projection). A fresh user
 *       sees only the auto/system-enabled members (e.g. category=search ⇒
 *       just `tavily`, never the disabled `brave`/`exa`). Unknown category ⇒
 *       total:0, [].
 *   DTO validation (SHAPE ①, HTTP 400)
 *     - extra top-level field          → ["property <x> should not exist"] (forbidNonWhitelisted)
 *     - settings / secretSettings / metadata not an object → ["<field> must be an object"]
 *     - autoEnableForWorks not boolean → ["autoEnableForWorks must be a boolean value"]
 *     - priority < 0 (work enable)     → ["priority must not be less than 0"]
 *     - priority non-number            → +["priority must be a number conforming to the specified constraints"]
 *     - activeCapability / capability not in the whitelist → ["'<x>' is not a valid capability. Valid capabilities are: ai-provider, search, …"]
 *     - pipeline-default missing enforce → ["enforce must be a boolean value"]
 *   Plugin-schema validation (SHAPE ②, HTTP 400)
 *     - enable tavily with `settings` but no required apiKey → { message:'Invalid plugin settings', errors:['Missing required fields: apiKey'] }
 *   Prototype-pollution guard
 *     - `__proto__` / `constructor` keys in settings are SILENTLY STRIPPED by
 *       the sanitizer (not a 400); a valid payload alongside still enables and
 *       leaks no polluted key.
 *   x-secret masking
 *     - a secret supplied via EITHER `secretSettings` OR `settings` comes back
 *       masked in `settings` (first4 + bullets + last4); the raw value is never
 *       echoed; `secretSettings` is null in the response.
 *     - PATCH …/settings returns the plugin + an appended `validation` object.
 *   Guards
 *     - disable a SYSTEM plugin → 400 "…is a system plugin and cannot be disabled" (stays enabled).
 *     - PATCH settings on a NOT-installed plugin → 400 "…is not installed for this user. Enable it first."
 *     - disable a not-installed NON-system plugin → 200 (idempotent).
 *   Not-found / malformed (plugin ids are STRINGS — no ParseUUIDPipe)
 *     - unknown OR malformed pluginId on detail/enable/disable/connection-status → 404 { message:'Plugin "<id>" not found', statusCode:404 }.
 *   Work scope
 *     - work enable with un-configured user creds → 400 SHAPE ③.
 *     - cross-user access to another user's work plugins (list/enable/patch) → 403 "You do not have permission to access this work".
 *     - unknown OR malformed workId → 404 "Work with id '<id>' not found" (never 400 — no ParseUUIDPipe on workId).
 *   Auth
 *     - every route with NO bearer → 401 (AuthSessionGuard, before routing).
 *
 * ISOLATION: every test registers a FRESH user via registerUserViaAPI (never
 * the shared seeded user); assertions use toContain / per-row checks and never
 * exact global counts. Filename uses the safe `flow-` prefix and is fully
 * API-orchestrated, so it does not contend on the shared UI/stack.
 */

const SYSTEM_DISABLE_RE = /is a system plugin and cannot be disabled/i;
const NOT_INSTALLED_RE = /is not installed for this user/i;
const INVALID_CAPABILITY_RE = /is not a valid capability/i;
const INVALID_SCHEMA_MSG = 'Invalid plugin settings';
const USER_SETTINGS_FIRST_MSG = 'User-level required settings must be configured first';

/** A system plugin every build ships (autoEnabled, requires apiKey, category=search). */
const SYSTEM_SEARCH = 'tavily';
/** A NON-system, non-autoEnabled plugin (category=search) — not installed for a fresh user. */
const NON_SYSTEM_SEARCH = 'brave';
/** Another non-system plugin — used for idempotent-disable contrast. */
const NON_SYSTEM_SEARCH_2 = 'exa';

async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

interface RawPlugin {
    id: string;
    pluginId?: string;
    category?: string;
    systemPlugin?: boolean;
    autoEnable?: boolean;
    enabled?: boolean;
    installed?: boolean;
    settings?: Record<string, unknown> | null;
    secretSettings?: Record<string, unknown> | null;
    resolvedSettings?: Record<string, unknown> | null;
    validation?: unknown;
}

async function listPlugins(
    request: APIRequestContext,
    token: string,
    category?: string,
): Promise<{ plugins: RawPlugin[]; total: number; categories: string[]; capabilities: string[] }> {
    const url = category
        ? `${API_BASE}/api/plugins?category=${encodeURIComponent(category)}`
        : `${API_BASE}/api/plugins`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    expect(res.status(), `GET ${url}`).toBe(200);
    const body = (await res.json()) as {
        plugins?: RawPlugin[];
        total?: number;
        categories?: string[];
        capabilities?: string[];
    };
    return {
        plugins: body.plugins ?? [],
        total: body.total ?? 0,
        categories: body.categories ?? [],
        capabilities: body.capabilities ?? [],
    };
}

/** Create a Work owned by `token`; return its id. */
async function makeWork(request: APIRequestContext, token: string): Promise<string> {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { id } = await createWorkViaAPI(request, token, {
        name: `Plug Matrix ${suffix}`,
        slug: `plug-matrix-${suffix}`,
    });
    expect(id, 'work id was returned').toBeTruthy();
    return id;
}

// =====================================================================================
// A. Enable/disable DTO validation + the two error-SHAPE families (user level)
// =====================================================================================
test.describe('Plugins matrix — user enable/disable DTO validation', () => {
    test('extra unknown top-level field is rejected 400 (forbidNonWhitelisted) with the property message', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { bogusField: 123 },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.message.join(' ')).toMatch(/property bogusField should not exist/i);
        expect(body.error).toBe('Bad Request');
        expect(body.statusCode).toBe(400);
    });

    test('settings / secretSettings must each be an object — 400 with the per-field message', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const s = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { settings: 'iamastring' },
        });
        expect(s.status()).toBe(400);
        expect((await s.json()).message.join(' ')).toMatch(/settings must be an object/i);

        const ss = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { secretSettings: 123 },
        });
        expect(ss.status()).toBe(400);
        expect((await ss.json()).message.join(' ')).toMatch(/secretSettings must be an object/i);
    });

    test('metadata must be an object on PATCH settings — 400', async ({ request }) => {
        const token = await freshToken(request);
        // enable first so the record exists (else the not-installed guard fires first)
        const en = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(en.status()).toBe(200);
        const res = await request.patch(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/settings`, {
            headers: authedHeaders(token),
            data: { metadata: 'not-an-object' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message.join(' ')).toMatch(/metadata must be an object/i);
    });

    test('autoEnableForWorks must be a boolean — 400', async ({ request }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { autoEnableForWorks: 'yes' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message.join(' ')).toMatch(
            /autoEnableForWorks must be a boolean value/i,
        );
    });

    test('enable with an empty body is a valid 200 (all fields optional)', async ({ request }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as RawPlugin;
        expect(body.id).toBe(SYSTEM_SEARCH);
        expect(body.enabled).toBe(true);
        expect(body.installed).toBe(true);
    });

    test('SHAPE ②: enabling with `settings` but no required schema field → { message:"Invalid plugin settings", errors:[…] } — a DIFFERENT shape from class-validator', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            // arbitrary nested key is allowed by the open Record DTO; the plugin
            // JSON-schema then rejects it for missing the required `apiKey`.
            data: { settings: { region: 'us' } },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toBe(INVALID_SCHEMA_MSG);
        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors.join(' ')).toMatch(/apiKey/i);
        // This shape has NO `error`/`statusCode` string[] `message` — prove it is
        // NOT the class-validator envelope.
        expect(Array.isArray(body.message)).toBe(false);
    });

    test('prototype-pollution keys in settings are silently stripped (not a 400) and never leak', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: {
                settings: { apiKey: 'tvly-ok-abcd7777', __proto__: { polluted: true } },
                secretSettings: { constructor: { hijack: 1 } },
            },
        });
        expect(res.status()).toBe(200);
        const raw = JSON.stringify(await res.json());
        expect(raw).not.toContain('polluted');
        expect(raw).not.toContain('hijack');
        // Object prototype must be untouched by the request.
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

// =====================================================================================
// B. x-secret masking channel matrix
// =====================================================================================
test.describe('Plugins matrix — x-secret masking', () => {
    test('a secret via secretSettings is masked in `settings`, never echoed raw, and secretSettings stays null', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const raw = 'tvly-secret-channel-12345';
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { secretSettings: { apiKey: raw } },
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as RawPlugin;
        const masked = String(body.settings?.apiKey ?? '');
        expect(masked).not.toBe(raw);
        expect(masked).not.toContain('secret-channel');
        expect(masked.endsWith(raw.slice(-4))).toBe(true); // last 4 preserved
        expect(masked.startsWith(raw.slice(0, 4))).toBe(true); // first 4 preserved
        // The raw secret is never round-tripped back to the client.
        expect(JSON.stringify(body)).not.toContain(raw);
        expect(body.secretSettings ?? null).toBeNull();
    });

    test('a secret provided through the plain `settings` channel is masked identically', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const raw = 'tvly-plaintext-abcd9876';
        const res = await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { settings: { apiKey: raw } },
        });
        expect(res.status()).toBe(200);
        const masked = String(((await res.json()) as RawPlugin).settings?.apiKey ?? '');
        expect(masked).not.toBe(raw);
        expect(masked).not.toContain('plaintext');
        expect(masked.endsWith('9876')).toBe(true);
    });

    test('PATCH …/settings returns the plugin + an appended `validation` object, still masked', async ({
        request,
    }) => {
        const token = await freshToken(request);
        await request.post(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {
            headers: authedHeaders(token),
            data: { secretSettings: { apiKey: 'tvly-init-key-5555' } },
        });
        const res = await request.patch(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/settings`, {
            headers: authedHeaders(token),
            data: { secretSettings: { apiKey: 'tvly-rotated-key-8888' } },
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as RawPlugin & { validation?: unknown };
        expect(body).toHaveProperty('validation');
        const masked = String(body.settings?.apiKey ?? '');
        expect(masked).not.toContain('rotated');
        expect(masked.endsWith('8888')).toBe(true);
    });
});

// =====================================================================================
// C. System-plugin & install-state guards (user-level disable / patch)
// =====================================================================================
test.describe('Plugins matrix — system & install-state guards', () => {
    test('disabling a system plugin is rejected 400 and it stays enabled', async ({ request }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/openrouter/disable`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(String(body.message)).toMatch(SYSTEM_DISABLE_RE);
        expect(body.statusCode).toBe(400);
        // still enabled afterwards
        const detail = await request.get(`${API_BASE}/api/plugins/openrouter`, {
            headers: authedHeaders(token),
        });
        expect(((await detail.json()) as RawPlugin).enabled).toBe(true);
    });

    test('PATCH settings on a NOT-installed plugin → 400 "…is not installed for this user"', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.patch(`${API_BASE}/api/plugins/${NON_SYSTEM_SEARCH}/settings`, {
            headers: authedHeaders(token),
            data: { settings: { foo: 'bar' } },
        });
        expect(res.status()).toBe(400);
        expect(String((await res.json()).message)).toMatch(NOT_INSTALLED_RE);
    });

    test('disabling a NOT-installed, non-system plugin is an idempotent 200 (contrast with the system guard)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/${NON_SYSTEM_SEARCH_2}/disable`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as RawPlugin;
        expect(body.id).toBe(NON_SYSTEM_SEARCH_2);
        expect(body.systemPlugin).toBe(false);
    });
});

// =====================================================================================
// D. Category filter contract (settings-page projection = only ENABLED in category)
// =====================================================================================
test.describe('Plugins matrix — ?category filter', () => {
    test('?category=search returns ONLY enabled plugins in that category (a superset lives in the unfiltered list)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const full = await listPlugins(request, token);
        const filtered = await listPlugins(request, token, 'search');

        expect(filtered.total).toBe(filtered.plugins.length);
        // every filtered row is category=search AND enabled
        for (const p of filtered.plugins) {
            expect(p.category, `${p.id} is a search plugin`).toBe('search');
            expect(p.enabled, `${p.id} is enabled (settings-page projection)`).toBe(true);
        }
        const filteredIds = filtered.plugins.map((p) => p.id);
        // the auto/system-enabled search default is present…
        expect(filteredIds).toContain(SYSTEM_SEARCH);
        // …and a known DISABLED search plugin from the full catalogue is excluded.
        const fullSearch = full.plugins.filter((p) => p.category === 'search');
        expect(fullSearch.length).toBeGreaterThan(filtered.plugins.length);
        const disabledSearch = fullSearch.find((p) => p.enabled === false);
        if (disabledSearch) {
            expect(filteredIds).not.toContain(disabledSearch.id);
        }
    });

    test('?category=<nonsense> returns an empty list with total 0', async ({ request }) => {
        const token = await freshToken(request);
        const res = await listPlugins(request, token, 'no-such-category-xyz');
        expect(res.total).toBe(0);
        expect(res.plugins).toHaveLength(0);
    });

    test('unfiltered list is self-consistent: total===length, categories/capabilities are non-empty arrays', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins, total, categories, capabilities } = await listPlugins(request, token);
        expect(total).toBe(plugins.length);
        expect(total).toBeGreaterThan(0);
        expect(categories.length).toBeGreaterThan(0);
        expect(capabilities.length).toBeGreaterThan(0);
        // every plugin declares the fields the settings UI reads
        for (const p of plugins.slice(0, 10)) {
            expect(typeof p.id).toBe('string');
            expect(p.pluginId ?? p.id).toBe(p.id);
        }
    });
});

// =====================================================================================
// E. Unknown / malformed plugin id — 404 posture (ids are strings; no ParseUUIDPipe)
// =====================================================================================
test.describe('Plugins matrix — unknown / malformed plugin id', () => {
    test('GET detail on unknown AND malformed ids both 404 with the not-found envelope', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const id of [
            'does-not-exist-xyz',
            'not a uuid!!',
            '00000000-0000-0000-0000-000000000000',
        ]) {
            const res = await request.get(`${API_BASE}/api/plugins/${encodeURIComponent(id)}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `GET detail "${id}"`).toBe(404);
            const body = await res.json();
            expect(body.statusCode).toBe(404);
            expect(String(body.message)).toMatch(/not found/i);
        }
    });

    test('enable / disable / connection-status on an unknown id all 404', async ({ request }) => {
        const token = await freshToken(request);
        const h = authedHeaders(token);
        const en = await request.post(`${API_BASE}/api/plugins/ghost-plugin/enable`, {
            headers: h,
            data: {},
        });
        expect(en.status()).toBe(404);

        const dis = await request.post(`${API_BASE}/api/plugins/ghost-plugin/disable`, {
            headers: h,
        });
        expect(dis.status()).toBe(404);

        const cs = await request.get(`${API_BASE}/api/plugins/ghost-plugin/connection-status`, {
            headers: h,
        });
        expect(cs.status()).toBe(404);
    });
});

// =====================================================================================
// F. Auth (401) matrix — every route requires a bearer, before routing
// =====================================================================================
test.describe('Plugins matrix — unauthenticated 401', () => {
    test('every plugin route without a bearer token returns 401', async ({ request }) => {
        const gets = [
            `${API_BASE}/api/plugins`,
            `${API_BASE}/api/plugins/${SYSTEM_SEARCH}`,
            `${API_BASE}/api/plugins/settings-menu`,
            `${API_BASE}/api/plugins/${SYSTEM_SEARCH}/connection-status`,
            `${API_BASE}/api/works/00000000-0000-4000-8000-000000000000/plugins`,
        ];
        for (const url of gets) {
            const res = await request.get(url);
            expect(res.status(), `GET ${url}`).toBe(401);
        }

        const posts: Array<[string, unknown]> = [
            [`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/enable`, {}],
            [`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/disable`, {}],
            [`${API_BASE}/api/plugins/pipeline-default`, { enforce: false }],
            [`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/validate-connection`, {}],
        ];
        for (const [url, data] of posts) {
            const res = await request.post(url, { data });
            expect(res.status(), `POST ${url}`).toBe(401);
        }

        const patch = await request.patch(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/settings`, {
            data: { settings: {} },
        });
        expect(patch.status()).toBe(401);
    });
});

// =====================================================================================
// G. Work-level plugin authz + capability / priority validation
// =====================================================================================
test.describe('Plugins matrix — work-level validation & authz', () => {
    test('work enable with an invalid activeCapability → 400 whitelist message', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);
        const res = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: 'not-a-real-capability' } },
        );
        expect(res.status()).toBe(400);
        const msg = (await res.json()).message;
        expect(Array.isArray(msg) ? msg.join(' ') : String(msg)).toMatch(INVALID_CAPABILITY_RE);
    });

    test('work enable priority validation — negative rejected, non-number rejected', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);

        const neg = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(token), data: { priority: -5 } },
        );
        expect(neg.status()).toBe(400);
        expect((await neg.json()).message.join(' ')).toMatch(/priority must not be less than 0/i);

        const str = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(token), data: { priority: 'high' } },
        );
        expect(str.status()).toBe(400);
        expect((await str.json()).message.join(' ')).toMatch(/priority must be a number/i);
    });

    test('set-active-capability requires a valid `capability` — missing and invalid both 400', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);

        const missing = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/capability`,
            { headers: authedHeaders(token), data: {} },
        );
        expect(missing.status()).toBe(400);
        expect(String((await missing.json()).message)).toMatch(INVALID_CAPABILITY_RE);

        const invalid = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/capability`,
            { headers: authedHeaders(token), data: { capability: 'nope' } },
        );
        expect(invalid.status()).toBe(400);
        expect(String((await invalid.json()).message)).toMatch(INVALID_CAPABILITY_RE);
    });

    test('work settings PATCH rejects an extra top-level field (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);
        const res = await request.patch(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/settings`,
            { headers: authedHeaders(token), data: { nope: 1 } },
        );
        expect(res.status()).toBe(400);
        expect((await res.json()).message.join(' ')).toMatch(/property nope should not exist/i);
    });

    test('SHAPE ③: enabling a plugin for a work before its user creds exist → 400 "User-level required settings must be configured first"; configuring then succeeds', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);

        // tavily is auto-enabled at user level but has NO apiKey yet.
        const blocked = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(token), data: {} },
        );
        expect(blocked.status()).toBe(400);
        const body = await blocked.json();
        expect(body.message).toBe(USER_SETTINGS_FIRST_MSG);
        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors.join(' ')).toMatch(/apiKey/i);

        // configure the user-level secret, then the work enable is accepted.
        const cfg = await request.patch(`${API_BASE}/api/plugins/${SYSTEM_SEARCH}/settings`, {
            headers: authedHeaders(token),
            data: { secretSettings: { apiKey: 'tvly-user-key-4242' } },
        });
        expect(cfg.status()).toBe(200);

        const ok = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(token), data: { priority: 1 } },
        );
        expect(ok.status(), await ok.text()).toBe(200);
        expect(((await ok.json()) as RawPlugin).id).toBe(SYSTEM_SEARCH);
    });

    test('cross-user: a stranger cannot list/enable/patch plugins on someone else’s work → 403', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const stranger = await freshToken(request);
        const workId = await makeWork(request, owner);

        const list = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
            headers: authedHeaders(stranger),
        });
        expect(list.status()).toBe(403);
        expect(String((await list.json()).message)).toMatch(/do not have permission/i);

        const enable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/enable`,
            { headers: authedHeaders(stranger), data: {} },
        );
        expect(enable.status()).toBe(403);

        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/plugins/${SYSTEM_SEARCH}/settings`,
            { headers: authedHeaders(stranger), data: { settings: { x: 1 } } },
        );
        expect(patch.status()).toBe(403);
    });

    test('unknown AND malformed workId → 404 "Work with id … not found" (never a ParseUUID 400)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const wid of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
            const res = await request.get(
                `${API_BASE}/api/works/${encodeURIComponent(wid)}/plugins`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), `workId "${wid}"`).toBe(404);
            expect(String((await res.json()).message)).toMatch(/not found/i);
        }
    });
});

// =====================================================================================
// H. Global pipeline-default DTO (`enforce` is required)
// =====================================================================================
test.describe('Plugins matrix — pipeline-default DTO', () => {
    test('pipeline-default requires the `enforce` boolean — 400 when omitted', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.post(`${API_BASE}/api/plugins/pipeline-default`, {
            headers: authedHeaders(token),
            data: { pluginId: 'standard-pipeline' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message.join(' ')).toMatch(/enforce must be a boolean value/i);
    });

    test('pipeline-default accepts a clear (pluginId:null) and a set (enforce:true) → 200', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const clear = await request.post(`${API_BASE}/api/plugins/pipeline-default`, {
            headers: authedHeaders(token),
            data: { pluginId: null, enforce: false },
        });
        expect(clear.status()).toBe(200);

        const setDefault = await request.post(`${API_BASE}/api/plugins/pipeline-default`, {
            headers: authedHeaders(token),
            data: { pluginId: 'standard-pipeline', enforce: true },
        });
        expect(setDefault.status()).toBe(200);
    });
});
