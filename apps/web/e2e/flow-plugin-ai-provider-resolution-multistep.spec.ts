import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import {
    enablePluginViaAPI,
    disablePluginViaAPI,
    patchPluginSettingsViaAPI,
    getPluginViaAPI,
} from './helpers/plugins';

/**
 * AI PROVIDER RESOLUTION — the EFFECTIVE-CONFIG DISCOVERY & VALIDATION surface.
 *
 * This file is the DISJOINT complement to the existing AI-provider specs. Where
 * they assert completion-time RESOLUTION (flow-plugin-ai-provider-resolution:
 * X-Provider-Override / X-Work-Id precedence at /api/v1/chat/completions), the
 * per-work RECORD state machine (flow-plugin-per-work-ai), the BYOK secret
 * lifecycle (flow-plugin-ai-byok) and the USER-scope settings-schema projection
 * (flow-plugin-ai-settings-validation), THIS file pins the "which providers are
 * installed and what model/config RESOLVES" read surface that answers those
 * questions WITHOUT firing a completion:
 *   - GET  /api/plugins?category=ai-provider   (the installed-only category view)
 *   - GET  /api/plugins/settings-menu          (grouped, hasRequiredSettings)
 *   - POST /api/plugins/:id/validate-connection (the standalone THROWING validator)
 *   - GET  /api/plugins/:id .models[] / .resolvedSettings (tiered effective model)
 *   - GET  /api/works/:id/plugins .models[]     (per-work effective model, isWorkOverride)
 *
 * Every shape, status and message below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-07-21 with throwaway users BEFORE the
 * assertions were written — this asserts the platform's REAL behaviour, never a
 * guess.
 *
 * PROBED CONTRACTS (live, http 3100):
 *
 *   - GET /api/plugins  → { plugins:[…], total, categories, capabilities }. The
 *     FULL catalogue ships MANY ai-provider plugins (probed 11: anthropic, google,
 *     grok, groq, lm-studio, mistral, ollama, openai, openrouter,
 *     vercel-ai-gateway, vllm).
 *   - GET /api/plugins?category=ai-provider → the INSTALLED-ONLY view: after the
 *     category narrow, `listPlugins` additionally keeps ONLY plugins that
 *     resolvePluginEnabled at the USER scope (plugin-operations.service L150-162).
 *     So a FRESH user sees ONLY the system default openrouter (total:1), NOT the
 *     other 10 — a strict subset of the full ai-provider set. Enabling anthropic
 *     makes it JOIN the filtered view (total:2); disabling removes it again. Each
 *     returned item still carries the full effective-config projection (models[],
 *     resolvedSettings). `?category=search` → only tavily; `?category=<bogus>` → [].
 *
 *   - GET /api/plugins/settings-menu → { categories:[{ category, label, plugins:[
 *       { pluginId, name, icon, enabled, hasRequiredSettings } ]}] }. The
 *     ai-provider bucket is labelled 'AI Providers'. `hasRequiredSettings` is TRUE
 *     iff the plugin has UNCONFIGURED required settings: openrouter (apiKey is
 *     x-envVar-bound) → false; a freshly-enabled anthropic (apiKey has NO env
 *     fallback) → true, flipping to false once its apiKey is PATCHed.
 *
 *   - POST /api/plugins/:id/validate-connection → the explicit THROWING validator
 *     (PluginValidationService.validateUserPluginConnection). Distinct from the
 *     non-throwing `validation` envelope embedded in a settings PATCH:
 *       • openrouter → env-adaptive: a working effective key → 200 { success:true };
 *         keyless → 400 { message:'OpenRouter: N model(s) failed validation…',
 *         modelResults:[{ tier, model, success:false, responseTime, error }] }.
 *         The tiers probed are provider-defined (openrouter default env → default +
 *         complex; a user who sets all 4 tiers → default/simple/medium/complex).
 *       • anthropic (enabled, no key) → 400 { message:'Anthropic: 3 model(s)…',
 *         modelResults tiers default/simple/medium, each error '401 Invalid bearer
 *         token' } — a provider-specific signature distinct from openrouter's.
 *       • unknown plugin id → 404 { message:'Plugin not found or not loaded: <id>' }.
 *       • tavily (search, no key) → 400 { message:'Tavily API key is not configured.' }.
 *       • github (git-provider, no OAuth) → 409 (NoGitCredentialsError). None is 5xx.
 *
 *   - GET /api/plugins/openrouter → tiered effective model:
 *       resolvedSettings:{ defaultModel, simpleModel, mediumModel, complexModel }
 *       models:[{ key, label, value, source, isWorkOverride }] with labels
 *       Default Model / Simple Tasks Model / Standard Tasks Model / Complex Tasks
 *       Model, and source ∈ { default | env | user | admin | work }. A fresh user
 *       resolves from env/default (isWorkOverride:false everywhere). PATCHing user
 *       tiers flips their `source` to 'user' with the chosen values; a tier left
 *       unset stays 'default'/'env' (mixed-source projection). The raw apiKey is
 *       NEVER echoed (settings/resolvedSettings mask it).
 *
 *   - GET /api/works/:id/plugins → each row also carries the effective-config
 *     projection RESOLVED FOR THE WORK. A work-level defaultModel override
 *     (PATCH /api/works/:id/plugins/openrouter/settings — itself gated 400 'User-
 *     level required settings must be configured first' until the user apiKey
 *     exists) flips that row's models[defaultModel] to { source:'work',
 *     isWorkOverride:true, value:<work value> } while the untouched tiers stay
 *     source 'default'; a null-clear reverts to the user value (source 'user',
 *     isWorkOverride:false). The override is ISOLATED — a sibling work is untouched.
 *
 * ENVIRONMENT-ADAPTIVE: the completion + validate paths need a real provider key.
 * The RESOLUTION/DISCOVERY/PROJECTION assertions (installed-only filter, the
 * settings-menu grouping, the model-source projection, the per-work override,
 * the error taxonomy) are key-INDEPENDENT and hold in BOTH envs; the
 * validate-connection SUCCESS and the completion round-trip branch on whether a
 * key is wired (200 vs 400/422) — never asserting a fictional outcome, never a 5xx.
 *
 * ISOLATION: every flow runs on its OWN FRESH registerUserViaAPI() user — never
 * the shared seeded user — because writing a user-scoped fake `apiKey` SHADOWS
 * the env key and would break sibling chat specs on the seeded account. Unique
 * Date.now()-suffixed emails; tolerant assertions (toContain / relative counts /
 * .or), never exact global catalogue counts. The `flow-` filename prefix is NOT
 * matched by the no-auth testIgnore regex and the file is fully API-orchestrated.
 */

const AI_CATEGORY = 'ai-provider';
const SYSTEM_AI = 'openrouter';
const SYSTEM_SEARCH = 'tavily';
const ALT_AI = 'anthropic';
const GIT_PROVIDER = 'github';

const TIER_LABELS: Record<string, string> = {
    defaultModel: 'Default Model',
    simpleModel: 'Simple Tasks Model',
    mediumModel: 'Standard Tasks Model',
    complexModel: 'Complex Tasks Model',
};
const ALL_TIERS = ['defaultModel', 'simpleModel', 'mediumModel', 'complexModel'];

interface ModelSummary {
    key: string;
    label?: string;
    value?: string;
    source?: string;
    isWorkOverride?: boolean;
}

interface PluginRow {
    id: string;
    category?: string;
    enabled?: boolean;
    systemPlugin?: boolean;
    resolvedSettings?: Record<string, unknown>;
    models?: ModelSummary[];
    workSettings?: Record<string, unknown> | null;
    settings?: Record<string, unknown> | null;
}

interface SettingsMenuPlugin {
    pluginId: string;
    name?: string;
    enabled?: boolean;
    hasRequiredSettings?: boolean;
    icon?: unknown;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-ai-resolve-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

/** GET /api/plugins with an optional category filter → normalized shape. */
async function listPlugins(
    request: APIRequestContext,
    token: string,
    category?: string,
): Promise<{ status: number; total: number; ids: string[]; plugins: PluginRow[] }> {
    const url = category
        ? `${API_BASE}/api/plugins?category=${encodeURIComponent(category)}`
        : `${API_BASE}/api/plugins`;
    const res = await request.get(url, { headers: authedHeaders(token), timeout: 30_000 });
    const body = (await res.json().catch(() => ({}))) as { plugins?: PluginRow[]; total?: number };
    const plugins = body.plugins ?? [];
    return {
        status: res.status(),
        total: body.total ?? plugins.length,
        ids: plugins.map((p) => p.id),
        plugins,
    };
}

/** GET /api/plugins/settings-menu → the ai-provider bucket (or undefined). */
async function aiSettingsMenuBucket(
    request: APIRequestContext,
    token: string,
): Promise<{ label?: string; plugins: SettingsMenuPlugin[] } | undefined> {
    const res = await request.get(`${API_BASE}/api/plugins/settings-menu`, {
        headers: authedHeaders(token),
        timeout: 30_000,
    });
    expect(res.status(), 'settings-menu resolves 200').toBe(200);
    const body = (await res.json()) as {
        categories?: Array<{ category: string; label?: string; plugins: SettingsMenuPlugin[] }>;
    };
    return (body.categories ?? []).find((c) => c.category === AI_CATEGORY);
}

/** POST /api/plugins/:id/validate-connection → { status, body }. */
async function validateConnection(
    request: APIRequestContext,
    token: string,
    pluginId: string,
): Promise<{
    status: number;
    body: {
        success?: boolean;
        message?: string;
        modelResults?: Array<{ tier?: string; model?: string; success?: boolean; error?: string }>;
    };
}> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/validate-connection`, {
        headers: authedHeaders(token),
        timeout: 40_000,
    });
    const body = (await res.json().catch(() => ({}))) as never;
    return { status: res.status(), body };
}

/** Pull a single row out of a work-plugins list. */
async function workPluginRow(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
): Promise<PluginRow> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
        headers: authedHeaders(token),
        timeout: 30_000,
    });
    expect(res.status(), `work-plugins list for ${workId}`).toBe(200);
    const body = (await res.json()) as { plugins: PluginRow[] };
    const row = body.plugins.find((p) => p.id === pluginId);
    expect(row, `${pluginId} present in the per-work list`).toBeTruthy();
    return row as PluginRow;
}

/** Detect whether a real OpenRouter key is wired for this user (env-adaptive). */
async function openRouterHasWorkingKey(
    request: APIRequestContext,
    token: string,
): Promise<boolean> {
    const { status, body } = await validateConnection(request, token, SYSTEM_AI);
    // 200 → a working effective key; 400 with modelResults → keyless/bad key.
    return status === 200 && body.success === true;
}

test.describe('AI provider effective-config — installed-only discovery filter', () => {
    test('Flow 1: ?category=ai-provider is the INSTALLED-only view — a strict subset of the full catalogue (fresh user sees only the system default)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'catfilter');

        // The FULL catalogue ships MANY ai-provider plugins.
        const full = await listPlugins(request, token);
        expect(full.status, 'full list resolves').toBe(200);
        const fullAi = full.plugins.filter((p) => p.category === AI_CATEGORY);
        expect(fullAi.length, 'the full catalogue ships many ai-providers').toBeGreaterThan(1);
        const fullAiIds = fullAi.map((p) => p.id);
        expect(fullAiIds, 'openrouter is in the full ai-provider catalogue').toContain(SYSTEM_AI);
        expect(fullAiIds, 'anthropic is in the full ai-provider catalogue').toContain(ALT_AI);

        // The category filter is the settings-page "installed" view: after the
        // category narrow it keeps ONLY user-enabled plugins. A fresh user has
        // ONLY the system default enabled.
        const filtered = await listPlugins(request, token, AI_CATEGORY);
        expect(filtered.status, 'category-filtered list resolves').toBe(200);
        expect(filtered.total, 'the total matches the payload length').toBe(
            filtered.plugins.length,
        );
        expect(filtered.ids, 'the installed view contains the system default openrouter').toContain(
            SYSTEM_AI,
        );
        expect(
            filtered.ids,
            'the installed view EXCLUDES the not-yet-enabled anthropic',
        ).not.toContain(ALT_AI);
        // Strict subset: the installed view is smaller than the full ai-provider set.
        expect(
            filtered.ids.length,
            'installed-only view is a strict subset of the full ai-provider catalogue',
        ).toBeLessThan(fullAi.length);
        // Every returned item genuinely has the requested category.
        for (const p of filtered.plugins) {
            expect(p.category, 'every filtered item is an ai-provider').toBe(AI_CATEGORY);
        }
    });

    test('Flow 2: enabling / disabling a provider makes it JOIN and LEAVE the installed-only view (observable membership transition)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'catmove');

        const before = await listPlugins(request, token, AI_CATEGORY);
        expect(before.ids, 'anthropic absent before enable').not.toContain(ALT_AI);

        // Enable anthropic at the user level → it JOINS the installed view.
        await enablePluginViaAPI(request, token, ALT_AI);
        const afterEnable = await listPlugins(request, token, AI_CATEGORY);
        expect(afterEnable.ids, 'anthropic joins the installed view after enable').toContain(
            ALT_AI,
        );
        expect(afterEnable.ids, 'the system default is still present').toContain(SYSTEM_AI);
        expect(
            afterEnable.ids.length,
            'the installed view grew by the newly-enabled provider',
        ).toBeGreaterThan(before.ids.length);

        // Disable anthropic → it LEAVES the installed view again.
        await disablePluginViaAPI(request, token, ALT_AI);
        const afterDisable = await listPlugins(request, token, AI_CATEGORY);
        expect(afterDisable.ids, 'anthropic leaves the installed view after disable').not.toContain(
            ALT_AI,
        );
        expect(afterDisable.ids, 'the system default openrouter cannot be removed').toContain(
            SYSTEM_AI,
        );
    });

    test('Flow 3: category filter is per-category (search→tavily only) and an unknown category resolves to an empty list, never a 5xx', async ({
        request,
    }) => {
        const token = await freshToken(request, 'catcross');

        const search = await listPlugins(request, token, 'search');
        expect(search.status, 'search category resolves').toBe(200);
        expect(search.ids, 'the search installed view carries its own system default').toContain(
            SYSTEM_SEARCH,
        );
        // ai-provider and search installed views are disjoint (each its own default).
        expect(
            search.ids,
            'the search view does NOT contain the ai-provider default',
        ).not.toContain(SYSTEM_AI);

        const bogus = await listPlugins(request, token, `not-a-real-category-${Date.now()}`);
        expect(bogus.status, 'an unknown category is a clean 200, not a 5xx').toBe(200);
        expect(bogus.plugins.length, 'an unknown category resolves to an empty list').toBe(0);
        expect(bogus.total, 'the empty list reports total 0').toBe(0);
    });

    test('Flow 4: each installed-view item carries the SAME effective-config projection as the detail endpoint (models[] + resolvedSettings)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'catproj');

        const filtered = await listPlugins(request, token, AI_CATEGORY);
        const orRow = filtered.plugins.find((p) => p.id === SYSTEM_AI);
        expect(orRow, 'openrouter present in the installed view').toBeTruthy();

        // The list item is not a thin stub — it embeds the resolved effective config
        // (so the settings page renders models without a second round-trip).
        expect(
            orRow?.resolvedSettings,
            'the installed-view item carries resolvedSettings',
        ).toBeTruthy();
        expect(
            (orRow?.resolvedSettings as { defaultModel?: string })?.defaultModel,
            'resolvedSettings carries an effective defaultModel',
        ).toBeTruthy();
        expect(
            Array.isArray(orRow?.models),
            'the installed-view item carries a models[] projection',
        ).toBe(true);
        const defEntry = (orRow?.models ?? []).find((m) => m.key === 'defaultModel');
        expect(defEntry, 'the models projection has a defaultModel tier entry').toBeTruthy();

        // Cross-check: the same projection is reachable via the detail endpoint.
        const detail = (await getPluginViaAPI(request, token, SYSTEM_AI)) as unknown as PluginRow;
        expect(
            (detail.resolvedSettings as { defaultModel?: string })?.defaultModel,
            'detail + list agree on the resolved defaultModel',
        ).toBe((orRow?.resolvedSettings as { defaultModel?: string })?.defaultModel);
    });
});

test.describe('AI provider effective-config — settings-menu grouping', () => {
    test('Flow 5: the settings-menu ai-provider bucket is labelled "AI Providers" and lists the enabled system default with a boolean hasRequiredSettings flag', async ({
        request,
    }) => {
        const token = await freshToken(request, 'menu');

        const bucket = await aiSettingsMenuBucket(request, token);
        expect(bucket, 'the ai-provider bucket is present').toBeTruthy();
        expect(bucket?.label, 'the bucket is human-labelled "AI Providers"').toBe('AI Providers');

        const or = bucket?.plugins.find((p) => p.pluginId === SYSTEM_AI);
        expect(or, 'openrouter is listed in the settings menu').toBeTruthy();
        expect(or?.enabled, 'the system default is enabled in the menu').toBe(true);
        expect(
            typeof or?.hasRequiredSettings,
            'the menu entry carries a boolean hasRequiredSettings flag',
        ).toBe('boolean');
        expect(or?.icon, 'the menu entry carries a render icon').toBeTruthy();
    });

    test('Flow 6: hasRequiredSettings tracks CONFIGURATION — a freshly-enabled anthropic is true, flipping to false once its apiKey is set', async ({
        request,
    }) => {
        const token = await freshToken(request, 'menucfg');

        // Not enabled yet → not in the menu bucket at all.
        const before = await aiSettingsMenuBucket(request, token);
        expect(
            before?.plugins.some((p) => p.pluginId === ALT_AI),
            'anthropic is absent from the menu before enable',
        ).toBeFalsy();

        // Enable anthropic WITHOUT settings → it appears with hasRequiredSettings:true
        // (its apiKey has no env fallback, so a required field is unconfigured).
        await enablePluginViaAPI(request, token, ALT_AI);
        const afterEnable = await aiSettingsMenuBucket(request, token);
        const anthEnabled = afterEnable?.plugins.find((p) => p.pluginId === ALT_AI);
        expect(anthEnabled, 'anthropic appears in the menu after enable').toBeTruthy();
        expect(anthEnabled?.enabled, 'anthropic is enabled').toBe(true);
        expect(
            anthEnabled?.hasRequiredSettings,
            'an unconfigured required-settings provider flags hasRequiredSettings:true',
        ).toBe(true);

        // Configure the required apiKey (+ defaultModel) → the flag flips to false.
        const patched = await patchPluginSettingsViaAPI(request, token, ALT_AI, {
            settings: { apiKey: 'sk-ant-e2e-fake-key', defaultModel: 'claude-3-5-haiku-latest' },
        });
        expect(patched.status, `configure anthropic; body=${JSON.stringify(patched.body)}`).toBe(
            200,
        );

        await expect
            .poll(
                async () => {
                    const b = await aiSettingsMenuBucket(request, token);
                    return b?.plugins.find((p) => p.pluginId === ALT_AI)?.hasRequiredSettings;
                },
                { timeout: 15_000, message: 'hasRequiredSettings flips to false once configured' },
            )
            .toBe(false);
    });
});

test.describe('AI provider effective-config — standalone validate-connection', () => {
    test('Flow 7: openrouter validate-connection is env-adaptive and always well-formed — success 200 OR a tiered 400 modelResults envelope, never a 5xx', async ({
        request,
    }) => {
        const token = await freshToken(request, 'valor');

        const { status, body } = await validateConnection(request, token, SYSTEM_AI);
        expect(
            status,
            'validate-connection is 200 (working key) or 400 (keyless), never 5xx',
        ).toBeLessThan(500);
        expect([200, 400], `unexpected status ${status}`).toContain(status);

        if (status === 200) {
            expect(body.success, 'a working key reports success:true').toBe(true);
        } else {
            // Keyless/bad key → a THROWN 400 with a per-tier model-result breakdown.
            expect(body.message ?? '', 'the 400 names the failing provider + model count').toMatch(
                /model\(s\) failed validation/i,
            );
            expect(Array.isArray(body.modelResults), 'the 400 carries a modelResults array').toBe(
                true,
            );
            expect(
                (body.modelResults ?? []).length,
                'at least one tier was probed',
            ).toBeGreaterThan(0);
            for (const r of body.modelResults ?? []) {
                expect(typeof r.tier, 'each result names a tier').toBe('string');
                expect(typeof r.model, 'each result names the model it tried').toBe('string');
                expect(r.success, 'each failing tier reports success:false').toBe(false);
                expect(
                    (r.error ?? '').toLowerCase(),
                    'the tier failure is an upstream auth error',
                ).toMatch(/401|auth|invalid|key/);
            }
        }
    });

    test('Flow 8: validate-connection exercises the USER-configured tiers — setting all four tier models makes them all appear in the modelResults', async ({
        request,
    }) => {
        const token = await freshToken(request, 'valtiers');
        const keyed = await openRouterHasWorkingKey(request, token);
        test.skip(keyed, 'a real env key returns success:true with no per-tier breakdown');

        // Configure a distinct model for EVERY tier with a deliberately-fake key.
        const models = {
            defaultModel: 'openai/gpt-4o-mini',
            simpleModel: 'openai/gpt-3.5-turbo',
            mediumModel: 'openai/gpt-4o',
            complexModel: 'openai/gpt-4-turbo',
        };
        const patched = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: 'sk-or-e2e-fake-byok', ...models },
        });
        expect(
            patched.status,
            `configure openrouter tiers; body=${JSON.stringify(patched.body)}`,
        ).toBe(200);

        // The standalone validator now probes ALL FOUR configured tiers — proving
        // the per-tier model selection is what drives connection validation.
        const { status, body } = await validateConnection(request, token, SYSTEM_AI);
        expect(status, 'a bad user key → 400 (not 5xx)').toBe(400);
        const tiers = (body.modelResults ?? []).map((r) => r.tier);
        for (const tier of ['default', 'simple', 'medium', 'complex']) {
            expect(tiers, `the ${tier} tier was validated`).toContain(tier);
        }
        // The exact per-tier models the user chose are the ones that were tried.
        const triedModels = (body.modelResults ?? []).map((r) => r.model);
        expect(triedModels, 'the default tier tried the user-chosen model').toContain(
            models.defaultModel,
        );
        expect(triedModels, 'the complex tier tried the user-chosen model').toContain(
            models.complexModel,
        );
    });

    test('Flow 9: validate-connection has a provider-specific signature — an enabled-but-keyless anthropic reports its own tier set + auth error', async ({
        request,
    }) => {
        const token = await freshToken(request, 'valanth');

        // Enable anthropic with a fake key so it is resolvable but fails upstream.
        await enablePluginViaAPI(request, token, ALT_AI);
        const cfg = await patchPluginSettingsViaAPI(request, token, ALT_AI, {
            settings: { apiKey: 'sk-ant-e2e-fake-key', defaultModel: 'claude-3-5-haiku-latest' },
        });
        expect(cfg.status, 'anthropic configured with a fake key').toBe(200);

        const { status, body } = await validateConnection(request, token, ALT_AI);
        expect([200, 400], `anthropic validate → ${status}`).toContain(status);
        if (status === 400) {
            expect(
                body.message ?? '',
                'the message names Anthropic as the failing provider',
            ).toMatch(/anthropic/i);
            expect(
                (body.modelResults ?? []).length,
                'anthropic probes its own tier set',
            ).toBeGreaterThan(0);
            for (const r of body.modelResults ?? []) {
                expect(r.success, 'each anthropic tier fails on the fake key').toBe(false);
                expect(
                    (r.error ?? '').toLowerCase(),
                    'anthropic surfaces an upstream auth error',
                ).toMatch(/401|invalid|auth|key/);
            }
        } else {
            expect(body.success, 'if a real anthropic key exists it is success:true').toBe(true);
        }
    });

    test('Flow 10: validate-connection error taxonomy across categories — unknown 404 / search-not-configured 400 / git-no-credentials 409, none a 5xx', async ({
        request,
    }) => {
        const token = await freshToken(request, 'valtax');

        // Unknown plugin id → 404 with a "not found or not loaded" message.
        const unknownId = `no-such-provider-${Date.now()}`;
        const unknown = await validateConnection(request, token, unknownId);
        expect(unknown.status, 'unknown plugin → 404').toBe(404);
        expect(unknown.body.message ?? '', 'the 404 names the missing plugin').toContain(unknownId);

        // A system SEARCH provider with no key → a clean 400 "not configured".
        const search = await validateConnection(request, token, SYSTEM_SEARCH);
        expect(search.status, 'unconfigured tavily → 400 (not 5xx)').toBe(400);
        expect(search.body.message ?? '', 'the 400 explains the missing search key').toMatch(
            /api key|configured|not configured/i,
        );

        // A GIT provider with no connected OAuth account → 409 (NoGitCredentials).
        const git = await validateConnection(request, token, GIT_PROVIDER);
        expect([400, 409], `git-provider without credentials → 4xx (got ${git.status})`).toContain(
            git.status,
        );
        expect(git.status, 'the git-provider path is never a 5xx').toBeLessThan(500);
    });
});

test.describe('AI provider effective-config — tiered model resolution (user scope)', () => {
    test('Flow 11: a fresh user resolves the full tiered model set from env/default, with a labelled, non-overridden models[] projection', async ({
        request,
    }) => {
        const token = await freshToken(request, 'tierbase');

        const plugin = (await getPluginViaAPI(request, token, SYSTEM_AI)) as unknown as PluginRow;
        const resolved = (plugin.resolvedSettings ?? {}) as Record<string, string>;
        // All four model tiers resolve to a concrete value out of the box.
        for (const tier of ALL_TIERS) {
            expect(
                resolved[tier],
                `${tier} resolves to a concrete model for a fresh user`,
            ).toBeTruthy();
        }

        const models = plugin.models ?? [];
        const def = models.find((m) => m.key === 'defaultModel');
        expect(def, 'the defaultModel tier is always projected').toBeTruthy();
        expect(def?.label, 'the defaultModel tier is human-labelled').toBe(
            TIER_LABELS.defaultModel,
        );
        expect(['default', 'env'], `fresh defaultModel source ${def?.source}`).toContain(
            def?.source,
        );
        // No work context here → nothing is a work override.
        for (const m of models) {
            expect(m.isWorkOverride, `tier ${m.key} is not a work override at user scope`).toBe(
                false,
            );
            if (m.label && TIER_LABELS[m.key]) {
                expect(m.label, `tier ${m.key} carries its canonical label`).toBe(
                    TIER_LABELS[m.key],
                );
            }
        }
    });

    test('Flow 12: PATCHing all four user tiers flips each to source:"user" with the exact chosen model (pick-a-model per tier)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'tieruser');

        const chosen = {
            defaultModel: 'openai/gpt-4o-mini',
            simpleModel: 'openai/gpt-3.5-turbo',
            mediumModel: 'openai/gpt-4o',
            complexModel: 'openai/gpt-4-turbo',
        };
        const patched = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: 'sk-or-e2e-fake-byok', ...chosen },
        });
        expect(patched.status, `PATCH four tiers; body=${JSON.stringify(patched.body)}`).toBe(200);

        const plugin = (await getPluginViaAPI(request, token, SYSTEM_AI)) as unknown as PluginRow;
        const resolved = (plugin.resolvedSettings ?? {}) as Record<string, string>;
        const models = plugin.models ?? [];

        for (const tier of ALL_TIERS) {
            expect(resolved[tier], `resolvedSettings.${tier} echoes the chosen model`).toBe(
                chosen[tier as keyof typeof chosen],
            );
            const entry = models.find((m) => m.key === tier);
            expect(entry, `${tier} is projected after the user override`).toBeTruthy();
            expect(entry?.value, `${tier} projects the chosen value`).toBe(
                chosen[tier as keyof typeof chosen],
            );
            expect(entry?.source, `${tier} source flips to 'user' after the PATCH`).toBe('user');
            expect(entry?.isWorkOverride, `${tier} is still not a work override`).toBe(false);
        }
    });

    test('Flow 13: the model-source projection is MIXED — only PATCHed tiers become "user"; untouched tiers keep their default/env source and the raw key never leaks', async ({
        request,
    }) => {
        const token = await freshToken(request, 'tiermix');

        const RAW_KEY = 'sk-or-e2e-supersecret-raw-9f8e7d';
        const USER_DEFAULT = 'openai/gpt-4o-mini';
        // Override ONLY the defaultModel tier, leaving simple/medium/complex unset.
        const patched = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: RAW_KEY, defaultModel: USER_DEFAULT },
        });
        expect(patched.status, `partial-tier PATCH; body=${JSON.stringify(patched.body)}`).toBe(
            200,
        );

        const plugin = (await getPluginViaAPI(request, token, SYSTEM_AI)) as unknown as PluginRow;
        const models = plugin.models ?? [];
        const def = models.find((m) => m.key === 'defaultModel');
        expect(def?.value, 'the defaultModel tier reflects the user override').toBe(USER_DEFAULT);
        expect(def?.source, 'the overridden tier is sourced from the user').toBe('user');

        // A tier the user did NOT set keeps a non-'user' source (default or env).
        const untouched = models.find(
            (m) => m.key !== 'defaultModel' && m.source && m.source !== 'user',
        );
        expect(
            untouched,
            'at least one untouched tier keeps a non-user (default/env) source',
        ).toBeTruthy();
        expect(['default', 'env'], `untouched tier source ${untouched?.source}`).toContain(
            untouched?.source,
        );

        // The raw secret is NEVER echoed back in settings OR resolvedSettings.
        const settingsKey = String((plugin.settings as { apiKey?: string })?.apiKey ?? '');
        const resolvedKey = String((plugin.resolvedSettings as { apiKey?: string })?.apiKey ?? '');
        expect(settingsKey, 'settings.apiKey is masked, not the raw key').not.toContain(RAW_KEY);
        expect(resolvedKey, 'resolvedSettings.apiKey is masked, not the raw key').not.toContain(
            RAW_KEY,
        );
        expect(
            JSON.stringify(plugin.models ?? []),
            'the raw key never leaks into the models projection',
        ).not.toContain(RAW_KEY);
    });
});

test.describe('AI provider effective-config — per-work model override (isWorkOverride)', () => {
    test('Flow 14: a per-work model override is GATED on user-level required settings — PATCHing work settings before the user apiKey exists is a precise 400', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workgate');
        const work = await createWorkViaAPI(request, token, { name: `WorkGate ${Date.now()}` });
        expect(work.id, 'work created').toBeTruthy();

        // openrouter is a system provider and workEnabled by default, yet a
        // work-level settings PATCH still requires the USER-level required apiKey
        // to be configured first (it cannot inherit the env fallback for a write).
        const premature = await request.patch(
            `${API_BASE}/api/works/${work.id}/plugins/${SYSTEM_AI}/settings`,
            {
                headers: authedHeaders(token),
                data: { settings: { defaultModel: 'openai/gpt-4o' } },
                timeout: 30_000,
            },
        );
        expect(premature.status(), 'work model override before user apiKey → 400').toBe(400);
        const body = (await premature.json().catch(() => ({}))) as {
            message?: string;
            errors?: string[];
        };
        expect(body.message ?? '', 'the 400 demands user-level settings first').toMatch(
            /user-level required settings/i,
        );
        expect((body.errors ?? []).join(' '), 'the 400 names the missing apiKey').toContain(
            'apiKey',
        );
    });

    test('Flow 15: after user config, a work defaultModel override flips that tier to source:"work" / isWorkOverride:true while untouched tiers stay default', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workset');
        // Satisfy the gate: configure user-level openrouter (fake key + default).
        const cfg = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: 'sk-or-e2e-fake', defaultModel: 'openai/gpt-4o-mini' },
        });
        expect(cfg.status, 'user openrouter configured').toBe(200);

        const work = await createWorkViaAPI(request, token, { name: `WorkSet ${Date.now()}` });
        const WORK_MODEL = 'anthropic/claude-3.5-haiku';

        const patched = await request.patch(
            `${API_BASE}/api/works/${work.id}/plugins/${SYSTEM_AI}/settings`,
            {
                headers: authedHeaders(token),
                data: { settings: { defaultModel: WORK_MODEL } },
                timeout: 30_000,
            },
        );
        expect(
            patched.status(),
            `work override PATCH; body=${await patched.text().catch(() => '')}`,
        ).toBe(200);

        const row = await workPluginRow(request, token, work.id, SYSTEM_AI);
        // The workSettings layer records the override.
        expect(
            (row.workSettings as { defaultModel?: string } | null)?.defaultModel,
            'workSettings carries the work-level defaultModel',
        ).toBe(WORK_MODEL);

        const models = row.models ?? [];
        const def = models.find((m) => m.key === 'defaultModel');
        expect(def?.value, 'the per-work models projection reflects the work model').toBe(
            WORK_MODEL,
        );
        expect(def?.source, 'the overridden tier is now sourced from the work').toBe('work');
        expect(def?.isWorkOverride, 'the defaultModel tier is flagged as a work override').toBe(
            true,
        );

        // A tier the work did NOT override is NOT a work override.
        const nonDefault = models.find((m) => m.key !== 'defaultModel' && m.source);
        if (nonDefault) {
            expect(
                nonDefault.isWorkOverride,
                'an untouched tier is not flagged as a work override',
            ).toBe(false);
            expect(nonDefault.source, 'an untouched tier is not sourced from the work').not.toBe(
                'work',
            );
        }
    });

    test('Flow 16: a per-work model override is ISOLATED — a sibling work of the same user resolves the tier from the user scope, not the work', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workiso');
        const cfg = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: 'sk-or-e2e-fake', defaultModel: 'openai/gpt-4o-mini' },
        });
        expect(cfg.status).toBe(200);

        const bound = await createWorkViaAPI(request, token, { name: `Bound ${Date.now()}` });
        const sibling = await createWorkViaAPI(request, token, { name: `Sibling ${Date.now()}` });
        const WORK_MODEL = 'meta-llama/llama-3-70b';

        const patched = await request.patch(
            `${API_BASE}/api/works/${bound.id}/plugins/${SYSTEM_AI}/settings`,
            {
                headers: authedHeaders(token),
                data: { settings: { defaultModel: WORK_MODEL } },
                timeout: 30_000,
            },
        );
        expect(patched.status(), 'bind the override on the first work').toBe(200);

        // The BOUND work sees the work override.
        const boundDef = (await workPluginRow(request, token, bound.id, SYSTEM_AI)).models?.find(
            (m) => m.key === 'defaultModel',
        );
        expect(boundDef?.isWorkOverride, 'the bound work is a work override').toBe(true);
        expect(boundDef?.value, 'the bound work resolves the work model').toBe(WORK_MODEL);

        // The SIBLING work is untouched: no work override, resolves the user value.
        const sibDef = (await workPluginRow(request, token, sibling.id, SYSTEM_AI)).models?.find(
            (m) => m.key === 'defaultModel',
        );
        expect(sibDef?.isWorkOverride, 'the sibling work has NO work override').toBe(false);
        expect(sibDef?.value, 'the sibling resolves the user default, not the work model').not.toBe(
            WORK_MODEL,
        );
        expect(sibDef?.source, 'the sibling tier is sourced from the user, not the work').not.toBe(
            'work',
        );
    });

    test('Flow 17: clearing a per-work model override with null REVERTS the tier to the user scope (source:"user", isWorkOverride:false)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workrev');
        const USER_DEFAULT = 'openai/gpt-4o-mini';
        const cfg = await patchPluginSettingsViaAPI(request, token, SYSTEM_AI, {
            settings: { apiKey: 'sk-or-e2e-fake', defaultModel: USER_DEFAULT },
        });
        expect(cfg.status).toBe(200);

        const work = await createWorkViaAPI(request, token, { name: `Revert ${Date.now()}` });
        const WORK_MODEL = 'google/gemini-1.5-pro';

        // Set an override, confirm it took.
        const set = await request.patch(
            `${API_BASE}/api/works/${work.id}/plugins/${SYSTEM_AI}/settings`,
            {
                headers: authedHeaders(token),
                data: { settings: { defaultModel: WORK_MODEL } },
                timeout: 30_000,
            },
        );
        expect(set.status(), 'set the work override').toBe(200);
        const afterSet = (await workPluginRow(request, token, work.id, SYSTEM_AI)).models?.find(
            (m) => m.key === 'defaultModel',
        );
        expect(afterSet?.isWorkOverride, 'override is live before the revert').toBe(true);

        // Clear it with null → REVERT to user inheritance.
        const clear = await request.patch(
            `${API_BASE}/api/works/${work.id}/plugins/${SYSTEM_AI}/settings`,
            {
                headers: authedHeaders(token),
                data: { settings: { defaultModel: null } },
                timeout: 30_000,
            },
        );
        expect(clear.status(), 'the null-clear PATCH succeeds').toBe(200);

        await expect
            .poll(
                async () => {
                    const def = (
                        await workPluginRow(request, token, work.id, SYSTEM_AI)
                    ).models?.find((m) => m.key === 'defaultModel');
                    return { value: def?.value, source: def?.source, wo: def?.isWorkOverride };
                },
                {
                    timeout: 15_000,
                    message: 'the tier reverts to the user scope after the null-clear',
                },
            )
            .toEqual({ value: USER_DEFAULT, source: 'user', wo: false });
    });
});

test.describe('AI provider effective-config — resolution reaches runtime', () => {
    test('Flow 18: the resolved effective default model bridges to a real completion — 200 echoes it, or a keyless env is a clean provider_unavailable 422 (never 5xx)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'bridge');

        // Read the resolved effective default model for a fresh user.
        const plugin = (await getPluginViaAPI(request, token, SYSTEM_AI)) as unknown as PluginRow;
        const resolvedDefault = (plugin.resolvedSettings as { defaultModel?: string })
            ?.defaultModel;
        expect(resolvedDefault, 'a fresh user resolves an effective default model').toBeTruthy();

        // Fire a real completion with no override → it resolves the system default
        // (openrouter) and its effective default model.
        const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
            headers: authedHeaders(token),
            data: {
                messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
                stream: false,
            },
            timeout: 60_000,
        });
        const status = res.status();
        const raw = (await res.json().catch(() => ({}))) as {
            model?: string;
            choices?: Array<{ message?: { content?: string } }>;
            error?: { type?: string };
        };

        expect(status, 'the completion is well-behaved (200 or 422), never a 5xx').toBeLessThan(
            500,
        );
        expect([200, 422], `unexpected completion status ${status}`).toContain(status);

        if (status === 200) {
            // Keyed env → the resolved effective default model is what serves the request.
            expect(raw.model, 'the completion echoes the resolved effective default model').toBe(
                resolvedDefault,
            );
            expect(
                raw.choices?.[0]?.message?.content,
                'a working provider returns content',
            ).toBeTruthy();
        } else {
            // Keyless env → the truthful provider_unavailable envelope.
            expect(raw.error?.type, 'keyless env → provider_unavailable, not a 5xx').toBe(
                'provider_unavailable',
            );
        }
    });
});
