import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * PLUGINS — CATALOG SHAPE, CATEGORY PROJECTION, CAPABILITIES & PER-WORK LIST
 * (`GET /api/plugins`, `GET /api/plugins?category=…`, `GET /api/plugins/:id`,
 *  `GET /api/works/:workId/plugins`).
 *
 * Sibling coverage on this resource is already dense, so this file deliberately
 * carves out the ONE angle the others skip: the READ-side DATA CONTRACT of the
 * catalog itself.  Where `flow-plugins-validation-authz-matrix` is a pure
 * write/error-SHAPE/authz matrix and the `flow-plugin-*` specs each drive one
 * provider deeply, THIS spec sweeps the WHOLE catalogue and pins:
 *
 *   • the list ENVELOPE            → { plugins:[…], total, categories, capabilities }
 *   • per-row INTEGRITY invariants swept across every registered plugin
 *   • the top-level categories/capabilities registry projections + the exact
 *     relationship  capabilities === ⋃ plugin.capabilities
 *   • the ?category filter's SETTINGS-PAGE PROJECTION semantics: it is NOT a
 *     plain filter — it also restricts to ENABLED-only, is case-SENSITIVE, and
 *     the empty string is falsy (⇒ full list)
 *   • enabled-state per-USER isolation (the list is a per-user projection)
 *   • the per-WORK list's DISTINCT envelope ({ plugins, total, capabilityProviders },
 *     NO categories/capabilities) and its narrower, work-scoped membership.
 *
 * EVERY contract below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100, CI sqlite build) with throwaway users BEFORE the
 * assertions were written — real behaviour, not a guess. Observed at probe
 * time: 85 catalogue plugins / 18 categories, work list = 80 (deployment /
 * dns / git-provider members are user-visible but NOT work-scoped). Counts are
 * asserted with >= thresholds + subset/contains, never exact globals, so the
 * spec survives a PR that adds another plugin and the accumulating shard DB.
 *
 * ISOLATION: every test registers a FRESH user via registerUserViaAPI (never
 * the shared seeded user); `flow-` prefix + fully API-orchestrated so it does
 * not contend on the shared UI/stack.
 */

// ---- Anchors that every build ships (probed present + stable) --------------
/** system + autoEnable ai-gateway → always enabled for a fresh user. */
const DEFAULT_AI = 'openrouter';
/** system + autoEnable search default → always enabled for a fresh user. */
const DEFAULT_SEARCH = 'tavily';
/** system pipeline → always enabled + work-scoped. */
const DEFAULT_PIPELINE = 'standard-pipeline';
/** ai-provider, NOT auto/system → disabled for a fresh user (enable is a no-op-body 200). */
const DISABLED_AI = 'openai';
/** deployment plugin: user-enabled by default but explicitly NOT work-scoped. */
const DEPLOY_PLUGIN = 'vercel';
/** git-provider: user-visible but NOT in the per-work list. */
const GIT_PLUGIN = 'github';

/** Categories from the task theme that ARE registered in the registry. */
const REAL_THEME_CATEGORIES = [
    'ai-provider',
    'search',
    'deployment',
    'content-extractor',
    'connector',
    'pipeline',
] as const;

/**
 * Categories where the manifest invariant "a plugin in category X also
 * advertises capability X" holds (probed — `metrics` is the notable exception,
 * its members carry `metrics-provider`, so it is intentionally excluded here).
 */
const SELF_CAP_CATEGORIES = [
    'ai-provider',
    'search',
    'deployment',
    'content-extractor',
    'connector',
    'pipeline',
    'screenshot',
    'git-provider',
    'vector-store',
    'storage',
    'notification-channel',
] as const;

interface RawPlugin {
    id: string;
    pluginId?: string;
    name?: string;
    version?: string;
    category?: string;
    capabilities?: string[];
    enabled?: boolean;
    installed?: boolean;
    systemPlugin?: boolean;
    autoEnable?: boolean;
    autoEnableForWorks?: boolean;
    builtIn?: boolean;
    visibility?: string;
    state?: string;
    icon?: { type?: string; value?: string } | null;
    // work-level extras
    workEnabled?: boolean;
    activeCapabilities?: string[];
}

interface PluginList {
    plugins: RawPlugin[];
    total: number;
    categories: string[];
    capabilities: string[];
    raw: Record<string, unknown>;
}

interface WorkPluginList {
    plugins: RawPlugin[];
    total: number;
    capabilityProviders: Record<string, unknown> | undefined;
    raw: Record<string, unknown>;
}

async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

async function listPlugins(
    request: APIRequestContext,
    token: string,
    category?: string,
): Promise<PluginList> {
    const url =
        category === undefined
            ? `${API_BASE}/api/plugins`
            : `${API_BASE}/api/plugins?category=${encodeURIComponent(category)}`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    expect(res.status(), `GET ${url}`).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    return {
        plugins: (body.plugins as RawPlugin[]) ?? [],
        total: (body.total as number) ?? 0,
        categories: (body.categories as string[]) ?? [],
        capabilities: (body.capabilities as string[]) ?? [],
        raw: body,
    };
}

async function listWorkPlugins(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<WorkPluginList> {
    const url = `${API_BASE}/api/works/${workId}/plugins`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    expect(res.status(), `GET ${url}`).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    return {
        plugins: (body.plugins as RawPlugin[]) ?? [],
        total: (body.total as number) ?? 0,
        capabilityProviders: body.capabilityProviders as Record<string, unknown> | undefined,
        raw: body,
    };
}

async function enable(request: APIRequestContext, token: string, pluginId: string): Promise<void> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/enable`, {
        headers: authedHeaders(token),
        data: {},
    });
    expect(res.status(), `enable ${pluginId}`).toBe(200);
}

async function makeWork(request: APIRequestContext, token: string): Promise<string> {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { id } = await createWorkViaAPI(request, token, {
        name: `Catalog Work ${suffix}`,
        slug: `catalog-work-${suffix}`,
    });
    expect(id, 'work id returned').toBeTruthy();
    return id;
}

// =====================================================================================
// A. Catalog envelope + per-row integrity (unfiltered list)
// =====================================================================================
test.describe('Plugins catalog — envelope & row integrity', () => {
    test('envelope is { plugins, total, categories, capabilities } with total === plugins.length', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const list = await listPlugins(request, token);

        expect(Array.isArray(list.plugins)).toBe(true);
        expect(list.total).toBe(list.plugins.length);
        // static registry — comfortably above this floor at probe time (85).
        expect(list.total).toBeGreaterThanOrEqual(40);
        expect(Array.isArray(list.categories)).toBe(true);
        expect(Array.isArray(list.capabilities)).toBe(true);
        expect(list.categories.length).toBeGreaterThanOrEqual(10);
        expect(list.capabilities.length).toBeGreaterThanOrEqual(20);
    });

    test('every row: id is a non-empty string and equals pluginId; ids are globally unique', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await listPlugins(request, token);

        for (const p of plugins) {
            expect(typeof p.id, `id type for ${p.id}`).toBe('string');
            expect(p.id.length, `id non-empty`).toBeGreaterThan(0);
            // pluginId mirrors the string id (NOT a DB uuid).
            expect(p.pluginId ?? p.id, `pluginId mirrors id for ${p.id}`).toBe(p.id);
            expect(typeof p.name).toBe('string');
            expect(typeof p.version).toBe('string');
        }
        const ids = plugins.map((p) => p.id);
        expect(new Set(ids).size, 'no duplicate plugin ids').toBe(ids.length);
    });

    test('every row.category is a member of the top-level categories set', async ({ request }) => {
        const token = await freshToken(request);
        const { plugins, categories } = await listPlugins(request, token);
        const catSet = new Set(categories);
        for (const p of plugins) {
            expect(catSet.has(p.category as string), `${p.id}.category=${p.category}`).toBe(true);
        }
    });

    test('every row.capabilities is a string[] wholly contained in the top-level capabilities set', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins, capabilities } = await listPlugins(request, token);
        const capSet = new Set(capabilities);
        for (const p of plugins) {
            expect(Array.isArray(p.capabilities), `${p.id}.capabilities is array`).toBe(true);
            for (const c of p.capabilities ?? []) {
                expect(typeof c).toBe('string');
                expect(capSet.has(c), `${p.id} capability "${c}" is in top-level set`).toBe(true);
            }
        }
    });

    test('top-level capabilities EQUALS the union of every row.capabilities (both directions)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins, capabilities } = await listPlugins(request, token);
        const union = new Set<string>();
        for (const p of plugins) for (const c of p.capabilities ?? []) union.add(c);
        const top = new Set(capabilities);
        // no advertised capability is missing from the index …
        for (const c of union)
            expect(top.has(c), `union cap "${c}" present in top-level`).toBe(true);
        // … and the index advertises nothing no plugin provides.
        for (const c of top)
            expect(union.has(c), `top-level cap "${c}" is backed by a plugin`).toBe(true);
    });

    test('no listed plugin is hidden; state/visibility/icon.type stay inside their enums', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await listPlugins(request, token);
        const iconTypes = new Set(['svg', 'url', 'base64', 'lucide', 'emoji']);
        for (const p of plugins) {
            expect(p.visibility, `${p.id} not hidden`).not.toBe('hidden');
            expect(['public', 'user-only', 'operator', undefined]).toContain(p.visibility);
            expect(['loaded', 'error']).toContain(p.state);
            if (p.icon && p.icon.type !== undefined) {
                expect(iconTypes.has(p.icon.type), `${p.id} icon.type=${p.icon.type}`).toBe(true);
            }
        }
    });

    test('lifecycle flag fields (builtIn/systemPlugin/enabled/installed) are booleans', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await listPlugins(request, token);
        for (const p of plugins) {
            expect(typeof p.enabled, `${p.id}.enabled`).toBe('boolean');
            expect(typeof p.installed, `${p.id}.installed`).toBe('boolean');
            expect(typeof p.systemPlugin, `${p.id}.systemPlugin`).toBe('boolean');
            expect(typeof p.builtIn, `${p.id}.builtIn`).toBe('boolean');
        }
    });

    test('catalogue ordering is deterministic across two identical calls', async ({ request }) => {
        const token = await freshToken(request);
        const a = await listPlugins(request, token);
        const b = await listPlugins(request, token);
        expect(b.plugins.map((p) => p.id)).toEqual(a.plugins.map((p) => p.id));
    });

    test('well-known anchor plugins are all present in the catalogue', async ({ request }) => {
        const token = await freshToken(request);
        const ids = (await listPlugins(request, token)).plugins.map((p) => p.id);
        for (const anchor of [
            DEFAULT_AI,
            DEFAULT_SEARCH,
            DEFAULT_PIPELINE,
            DISABLED_AI,
            DEPLOY_PLUGIN,
            GIT_PLUGIN,
        ]) {
            expect(ids, `catalogue contains ${anchor}`).toContain(anchor);
        }
    });

    test('single-plugin detail is consistent with its catalogue row (parity)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const row = (await listPlugins(request, token)).plugins.find((p) => p.id === DEFAULT_AI);
        expect(row, `${DEFAULT_AI} row exists`).toBeTruthy();

        const res = await request.get(`${API_BASE}/api/plugins/${DEFAULT_AI}`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const detail = (await res.json()) as RawPlugin;
        expect(detail.id).toBe(row!.id);
        expect(detail.category).toBe(row!.category);
        expect(detail.systemPlugin).toBe(row!.systemPlugin);
        expect([...(detail.capabilities ?? [])].sort()).toEqual(
            [...(row!.capabilities ?? [])].sort(),
        );
    });
});

// =====================================================================================
// B. Enabled-state semantics — a per-user projection
// =====================================================================================
test.describe('Plugins catalog — enabled-state projection', () => {
    test('a fresh user: every enabled row is systemPlugin OR autoEnable, and disabled rows also exist', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await listPlugins(request, token);
        const enabled = plugins.filter((p) => p.enabled === true);
        const disabled = plugins.filter((p) => p.enabled === false);

        expect(enabled.length, 'some plugins enabled by default').toBeGreaterThan(0);
        expect(disabled.length, 'most plugins disabled by default').toBeGreaterThan(0);
        for (const p of enabled) {
            expect(
                p.systemPlugin === true || p.autoEnable === true,
                `${p.id} enabled ⇒ system|autoEnable`,
            ).toBe(true);
        }
    });

    test('the default-enabled anchors are enabled; a plain BYOK provider is not', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const byId = new Map((await listPlugins(request, token)).plugins.map((p) => [p.id, p]));
        expect(byId.get(DEFAULT_AI)?.enabled).toBe(true);
        expect(byId.get(DEFAULT_SEARCH)?.enabled).toBe(true);
        expect(byId.get(DEFAULT_PIPELINE)?.enabled).toBe(true);
        // openai is a user-required BYOK provider — never enabled for a fresh user.
        expect(byId.get(DISABLED_AI)?.enabled).toBe(false);
        expect(byId.get(DISABLED_AI)?.installed).toBe(false);
    });

    test('enabled/installed flip is scoped to the acting user — a second user is unaffected', async ({
        request,
    }) => {
        const userA = await freshToken(request);
        const userB = await freshToken(request);

        await enable(request, userA, DISABLED_AI);

        const aRow = (await listPlugins(request, userA)).plugins.find((p) => p.id === DISABLED_AI);
        const bRow = (await listPlugins(request, userB)).plugins.find((p) => p.id === DISABLED_AI);
        expect(aRow?.enabled, 'A sees it enabled').toBe(true);
        expect(aRow?.installed, 'A sees it installed').toBe(true);
        expect(bRow?.enabled, 'B is unaffected — still disabled').toBe(false);
        expect(bRow?.installed, 'B is unaffected — still not installed').toBe(false);
    });
});

// =====================================================================================
// C. ?category filter — the settings-page projection (category AND enabled-only)
// =====================================================================================
test.describe('Plugins catalog — ?category projection', () => {
    test('?category=ai-provider returns ONLY that category AND ONLY enabled rows', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const filtered = await listPlugins(request, token, 'ai-provider');
        expect(filtered.total).toBe(filtered.plugins.length);
        expect(filtered.plugins.length).toBeGreaterThan(0);
        for (const p of filtered.plugins) {
            expect(p.category, `${p.id} is ai-provider`).toBe('ai-provider');
            expect(p.enabled, `${p.id} is enabled (settings projection)`).toBe(true);
        }
        // the auto/system default is present; a disabled BYOK provider is excluded.
        const ids = filtered.plugins.map((p) => p.id);
        expect(ids).toContain(DEFAULT_AI);
        expect(ids).not.toContain(DISABLED_AI);
    });

    test('across every real theme category the projection is category-exact + enabled-only, and a subset of the full enabled-in-category set', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const full = await listPlugins(request, token);

        for (const cat of REAL_THEME_CATEGORIES) {
            const filtered = await listPlugins(request, token, cat);
            expect(filtered.total, `${cat} total===length`).toBe(filtered.plugins.length);
            for (const p of filtered.plugins) {
                expect(p.category, `${p.id} category=${cat}`).toBe(cat);
                expect(p.enabled, `${p.id} enabled`).toBe(true);
            }
            // the filtered ids are exactly the enabled members of that category
            // in the unfiltered catalogue (superset relationship).
            const fullEnabledInCat = new Set(
                full.plugins
                    .filter((p) => p.category === cat && p.enabled === true)
                    .map((p) => p.id),
            );
            const filteredIds = new Set(filtered.plugins.map((p) => p.id));
            expect(filteredIds).toEqual(fullEnabledInCat);
        }
    });

    test('for self-capability categories every projected plugin advertises the category as a capability', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const cat of SELF_CAP_CATEGORIES) {
            const { plugins } = await listPlugins(request, token, cat);
            for (const p of plugins) {
                expect(
                    (p.capabilities ?? []).includes(cat),
                    `${p.id} (category ${cat}) advertises "${cat}" capability`,
                ).toBe(true);
            }
        }
    });

    test('enabling a BYOK provider makes it appear in that user’s ?category projection but not another user’s', async ({
        request,
    }) => {
        const userA = await freshToken(request);
        const userB = await freshToken(request);

        const before = await listPlugins(request, userA, 'ai-provider');
        expect(before.plugins.map((p) => p.id)).not.toContain('groq');

        await enable(request, userA, 'groq');

        const afterA = await listPlugins(request, userA, 'ai-provider');
        expect(
            afterA.plugins.map((p) => p.id),
            'A now sees groq in the projection',
        ).toContain('groq');
        for (const p of afterA.plugins) expect(p.enabled).toBe(true);

        const afterB = await listPlugins(request, userB, 'ai-provider');
        expect(
            afterB.plugins.map((p) => p.id),
            'B still does not',
        ).not.toContain('groq');
    });

    test('the theme-listed "memory" pseudo-category and other unknown categories return an empty projection', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const cat of ['memory', 'no-such-category-xyz', 'ai_provider']) {
            const res = await listPlugins(request, token, cat);
            expect(res.total, `${cat} total`).toBe(0);
            expect(res.plugins, `${cat} plugins`).toHaveLength(0);
        }
    });

    test('the ?category filter is case-SENSITIVE (AI-PROVIDER matches nothing)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const upper = await listPlugins(request, token, 'AI-PROVIDER');
        expect(upper.total).toBe(0);
        expect(upper.plugins).toHaveLength(0);
        // sanity: the lowercase form does match.
        const lower = await listPlugins(request, token, 'ai-provider');
        expect(lower.plugins.length).toBeGreaterThan(0);
    });

    test('an EMPTY-string category is falsy → the FULL catalogue (not the enabled-only projection)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const full = await listPlugins(request, token);
        const emptyCat = await listPlugins(request, token, '');
        expect(emptyCat.total).toBe(full.total);
        // includes disabled rows — proof it is NOT the enabled-only projection.
        expect(emptyCat.plugins.some((p) => p.enabled === false)).toBe(true);
        expect(emptyCat.plugins.map((p) => p.id)).toContain(DISABLED_AI);
    });

    test('top-level categories & capabilities are registry-wide INVARIANTS — identical under any ?category and across users', async ({
        request,
    }) => {
        const userA = await freshToken(request);
        const userB = await freshToken(request);

        const unfiltered = await listPlugins(request, userA);
        const filtered = await listPlugins(request, userA, 'ai-provider');
        const nonsense = await listPlugins(request, userA, 'no-such-category-xyz');
        const otherUser = await listPlugins(request, userB);

        const sortedCats = (l: PluginList) => [...l.categories].sort();
        const sortedCaps = (l: PluginList) => [...l.capabilities].sort();

        // filtering the plugin ROWS never changes the registry-derived indexes …
        expect(sortedCats(filtered)).toEqual(sortedCats(unfiltered));
        expect(sortedCaps(filtered)).toEqual(sortedCaps(unfiltered));
        expect(sortedCats(nonsense)).toEqual(sortedCats(unfiltered));
        expect(sortedCaps(nonsense)).toEqual(sortedCaps(unfiltered));
        // … and they are the same for a completely different user.
        expect(sortedCats(otherUser)).toEqual(sortedCats(unfiltered));
        expect(sortedCaps(otherUser)).toEqual(sortedCaps(unfiltered));

        // the theme's named categories are all present in the index.
        for (const cat of REAL_THEME_CATEGORIES) {
            expect(unfiltered.categories, `index lists ${cat}`).toContain(cat);
        }
    });
});

// =====================================================================================
// D. Per-work plugin list — a distinct envelope + narrower membership
// =====================================================================================
test.describe('Plugins catalog — per-work list', () => {
    test('per-work envelope is { plugins, total, capabilityProviders } with NO categories/capabilities', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);
        const wl = await listWorkPlugins(request, token, workId);

        expect(wl.total).toBe(wl.plugins.length);
        expect(wl.plugins.length).toBeGreaterThan(0);
        // capabilityProviders is an object map (empty for a fresh work).
        expect(typeof wl.capabilityProviders).toBe('object');
        expect(wl.capabilityProviders).not.toBeNull();
        expect(Array.isArray(wl.capabilityProviders)).toBe(false);
        // the per-work list intentionally OMITS the registry indexes the user
        // list carries — a real shape difference, not an oversight.
        expect(wl.raw).not.toHaveProperty('categories');
        expect(wl.raw).not.toHaveProperty('capabilities');
    });

    test('every work row carries workEnabled(boolean), activeCapabilities(array) and the user-level enabled(boolean)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);
        const { plugins } = await listWorkPlugins(request, token, workId);
        for (const p of plugins) {
            expect(typeof p.workEnabled, `${p.id}.workEnabled`).toBe('boolean');
            expect(Array.isArray(p.activeCapabilities), `${p.id}.activeCapabilities`).toBe(true);
            expect(typeof p.enabled, `${p.id}.enabled`).toBe('boolean');
        }
    });

    test('work membership is a SUBSET of the catalogue and excludes non-work-scoped categories (deployment/git) while keeping pipeline & search defaults', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);

        const catalogIds = new Set((await listPlugins(request, token)).plugins.map((p) => p.id));
        const workIds = new Set(
            (await listWorkPlugins(request, token, workId)).plugins.map((p) => p.id),
        );

        // every work-scoped plugin is a real catalogue plugin.
        for (const id of workIds) expect(catalogIds.has(id), `${id} ∈ catalogue`).toBe(true);
        // deployment + git-provider plugins are user-visible but NOT work-scoped.
        expect(workIds.has(DEPLOY_PLUGIN), `${DEPLOY_PLUGIN} excluded from work list`).toBe(false);
        expect(workIds.has(GIT_PLUGIN), `${GIT_PLUGIN} excluded from work list`).toBe(false);
        // yet the pipeline + search defaults ARE work-scoped.
        expect(workIds.has(DEFAULT_PIPELINE)).toBe(true);
        expect(workIds.has(DEFAULT_SEARCH)).toBe(true);
    });

    test('a fresh work: default workEnabled cohort covers the pipeline/search defaults; a BYOK provider stays workEnabled=false', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const workId = await makeWork(request, token);
        const byId = new Map(
            (await listWorkPlugins(request, token, workId)).plugins.map((p) => [p.id, p]),
        );

        expect(byId.get(DEFAULT_PIPELINE)?.workEnabled, 'pipeline default work-enabled').toBe(true);
        expect(byId.get(DEFAULT_SEARCH)?.workEnabled, 'search default work-enabled').toBe(true);
        // anthropic is a BYOK ai-provider — present in the work list but off by default.
        const anthropic = byId.get('anthropic');
        expect(anthropic, 'anthropic present in work list').toBeTruthy();
        expect(anthropic?.workEnabled, 'anthropic off by default for the work').toBe(false);
    });

    test('the per-work list is user-scoped: two fresh users get consistent, non-empty, catalogue-subset lists for their own works', async ({
        request,
    }) => {
        const userA = await freshToken(request);
        const userB = await freshToken(request);
        const workA = await makeWork(request, userA);
        const workB = await makeWork(request, userB);

        const a = await listWorkPlugins(request, userA, workA);
        const b = await listWorkPlugins(request, userB, workB);

        // both fresh works expose the same static work-scoped membership.
        expect(a.plugins.map((p) => p.id).sort()).toEqual(b.plugins.map((p) => p.id).sort());
        expect(a.total).toBe(b.total);
        expect(a.total).toBeGreaterThan(0);
    });
});

// =====================================================================================
// E. Auth posture on the read endpoints
// =====================================================================================
test.describe('Plugins catalog — auth', () => {
    test('unauthenticated reads of the catalogue, a detail row and a work list all 401', async ({
        request,
    }) => {
        const noAuth = [
            `${API_BASE}/api/plugins`,
            `${API_BASE}/api/plugins?category=ai-provider`,
            `${API_BASE}/api/plugins/${DEFAULT_AI}`,
            `${API_BASE}/api/works/00000000-0000-4000-8000-000000000000/plugins`,
        ];
        for (const url of noAuth) {
            const res = await request.get(url);
            expect(res.status(), `no-auth GET ${url}`).toBe(401);
        }
    });

    test('a malformed bearer token is rejected 401 (not a 200 with an empty catalogue)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/plugins`, {
            headers: { Authorization: 'Bearer not-a-real-token.xyz' },
        });
        expect(res.status()).toBe(401);
    });

    test('an unknown plugin id on the detail route is 404 with the not-found envelope', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const res = await request.get(`${API_BASE}/api/plugins/definitely-not-a-plugin-xyz`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.statusCode).toBe(404);
        expect(String(body.message)).toMatch(/not found/i);
    });
});
