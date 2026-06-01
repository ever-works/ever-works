import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { patchPluginSettingsViaAPI } from './helpers/plugins';

/**
 * WORK-LEVEL PLUGIN MATRIX — ACROSS CATEGORIES. Complex, multi-step INTEGRATION
 * flows for the per-work plugin surface viewed as a CAPABILITY MATRIX spanning
 * MANY categories at once (search / content-extractor / ai-provider / pipeline /
 * deployment …), the single-ACTIVE-provider-per-capability binding, the
 * work-plugin SETTINGS layer vs the user-plugin SETTINGS layer (the resolved
 * cascade + work-override + null-revert), and the per-work enable/disable
 * ISOLATION + the system-default guard PER CATEGORY. Every shape, status and
 * message below was PROBED against the LIVE stack (http://127.0.0.1:3100) on
 * 2026-06-01 with throwaway users BEFORE the assertions were written — this
 * asserts the platform's REAL behaviour, never a guess.
 *
 * WHY THIS IS DISTINCT from the sibling specs:
 *   - flow-plugin-per-work-ai.spec.ts drives ONE category (ai-provider:
 *     anthropic/openai) through the per-work enable/override/bind/isolate state
 *     machine. THIS file is the CROSS-CATEGORY matrix: it proves the SAME
 *     work-plugin surface governs search + content-extractor + pipeline + the
 *     ai-provider category simultaneously, that capabilityProviders is a
 *     per-capability (not per-category-singleton) map where ONE plugin can own
 *     TWO capabilities at once, and that the system DEFAULT of EACH category is
 *     independently always-on.
 *   - flow-plugin-system-rules.spec.ts asserts the USER-level system-plugin
 *     cohort rules. THIS file asserts the WORK-level projection of those rules
 *     (workEnabled per category, per-work disable guard per category).
 *   - flow-plugin-ai-settings-validation.spec.ts asserts USER-level settings
 *     validation. THIS file asserts the WORK-level settings LAYER and the
 *     work-vs-user resolution (workSettings vs settings, the work-override that
 *     masks the user value, and the null-clear that REVERTS to user inheritance)
 *     — a surface none of the above touch.
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - GET /api/works/:workId/plugins (owner; @CurrentUser + ensureCanView)
 *       → { plugins: WorkPlugin[], total, capabilityProviders }.
 *     The per-work list spans MANY categories (probed present: ai-provider,
 *     content-extractor, data-source, email-provider, notification-channel,
 *     pipeline, screenshot, search, storage, utility). It EXCLUDES the
 *     work-inapplicable / user-only categories (deployment, git-provider) — so
 *     this file asserts on categories that are RELIABLY in the list.
 *     Each WorkPlugin carries: id, category, capabilities[], enabled (USER
 *     scope), autoEnableForWorks, systemPlugin, workEnabled (RESOLVED for THIS
 *     work), activeCapabilities[] (caps this plugin is the active provider for in
 *     THIS work), workPluginId (present IFF an explicit per-work record exists),
 *     settings (user-level masked), workSettings (work-override masked),
 *     resolvedSettings (resolved cascade, secrets shown as '••••••••').
 *     `capabilityProviders` resolves { capability → pluginId } — the single
 *     ACTIVE provider per capability (probed: empty {} on a fresh work).
 *
 *   - SYSTEM DEFAULT per category (systemPlugin:true, autoEnable:true,
 *     workEnabled:true out of the box, CANNOT be disabled per-work):
 *       ai-provider        → openrouter
 *       search             → tavily
 *       content-extractor  → local-content-extractor
 *       pipeline           → agent-pipeline / standard-pipeline
 *     NON-system alternates (workEnabled:false, enabled:false for a fresh user,
 *     require a user `apiKey` before any work binding):
 *       search             → brave, serpapi, exa
 *       content-extractor  → jina, exa
 *       ai-provider        → anthropic, openai
 *     MULTI-CAPABILITY plugins (one plugin, two caps): exa & jina BOTH provide
 *     ['search','content-extractor'].
 *
 *   - POST /api/works/:workId/plugins/:pluginId/enable { activeCapability?, settings?, priority? }
 *       • non-system plugin must be USER-enabled first else 400
 *         { message:'Plugin "<id>" must be enabled at user level first' }.
 *       • then its USER-level required settings (apiKey) must exist else 400
 *         { message:'User-level required settings must be configured first',
 *           errors:['Missing required fields: apiKey'] }.
 *       • after PATCH user settings {apiKey} (200) the work-enable returns 200,
 *         mints a workPluginId, workEnabled:true.
 *
 *   - POST /api/works/:workId/plugins/:pluginId/capability { capability }
 *       • plugin must be ENABLED FOR THE WORK first (ensureWorkPlugin), else 400
 *         { message:'Plugin "<id>" is not enabled for this work. Enable it first.' }.
 *       • plugin must OWN the capability else 400
 *         { message:'Plugin "<id>" does not provide capability "<cap>"' }.
 *       • EXCLUSIVE PER-CAPABILITY: sets this plugin as the active provider for
 *         `capability` AND clears ONLY that one capability from every OTHER
 *         plugin in the work. A plugin can own MULTIPLE capabilities at once
 *         (probed: exa→['search','content-extractor']); flipping `search` to a
 *         different plugin leaves exa's `content-extractor` intact, so the map
 *         resolves to { search:<other>, content-extractor:exa }.
 *
 *   - POST /api/works/:workId/plugins/:pluginId/disable
 *       • mints/flips an explicit work record enabled:false → workEnabled:false;
 *         a SYSTEM plugin (per category) → 400
 *         { message:'Plugin "<id>" is a system plugin and cannot be disabled' }.
 *
 *   - PATCH /api/works/:workId/plugins/:pluginId/settings { settings?, secretSettings? }
 *       • before the user-level required apiKey exists → 400 'User-level required
 *         settings must be configured first' / 'Missing required fields: apiKey'.
 *       • after user apiKey set, a work override returns 200 with a `workSettings`
 *         map (work-scoped masked values) DISTINCT from `settings` (user masked),
 *         a minted workPluginId, and a `validation` envelope (best-effort
 *         connection probe; success:false in CI without a real key is fine).
 *       • PATCH {apiKey:null} CLEARS the work override → workSettings reverts to
 *         undefined and the resolved value falls back to the user value.
 *
 *   - AUTH/OWNERSHIP: owner 200; a DIFFERENT authed user 403/404; anonymous 401.
 *
 * ISOLATION (cross-spec): every flow runs on its OWN FRESH registerUserViaAPI()
 * user — NEVER the shared seeded user — because work-binding a provider writes a
 * user-scoped fake `apiKey` that would SHADOW the env key and break sibling chat
 * specs on the seeded account. Unique Date.now()-suffixed emails; tolerant
 * assertions (toContain / .or(), no exact catalogue counts). The `flow-`
 * filename prefix is NOT matched by the playwright.config no-auth testIgnore
 * regex; the file is fully API-orchestrated so it does not contend on the UI.
 *
 * ENVIRONMENT-ADAPTIVE: nothing here depends on an LLM key or Trigger.dev — every
 * assertion is about the per-work plugin RECORD / capability binding / settings
 * resolution, which is identical whether or not a provider key is wired, so the
 * file is green in CI and locally. The `validation` connection probe is allowed
 * to fail (no real key) — we assert the RECORD/binding, never the probe result.
 */

const AI_SYSTEM = 'openrouter';
const SEARCH_SYSTEM = 'tavily';
const EXTRACTOR_SYSTEM = 'local-content-extractor';
const PIPELINE_SYSTEM = 'agent-pipeline';

// Non-system alternates, each requiring a user-level `apiKey`.
const SEARCH_ALT = 'brave';
const SEARCH_ALT_2 = 'serpapi';
const MULTI_CAP = 'exa'; // provides BOTH 'search' AND 'content-extractor'
const AI_ALT = 'anthropic';

const CAP_AI = 'ai-provider';
const CAP_SEARCH = 'search';
const CAP_EXTRACTOR = 'content-extractor';

interface WorkPlugin {
    id: string;
    category?: string;
    capabilities?: string[];
    enabled?: boolean;
    autoEnableForWorks?: boolean;
    systemPlugin?: boolean;
    workEnabled?: boolean;
    activeCapabilities?: string[];
    workPluginId?: string;
    settings?: Record<string, unknown>;
    workSettings?: Record<string, unknown>;
    resolvedSettings?: Record<string, unknown>;
}

interface WorkPluginList {
    plugins: WorkPlugin[];
    total?: number;
    capabilityProviders?: Record<string, string>;
}

interface ProbeResult {
    status: number;
    body: Record<string, unknown>;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        name: `Matrix ${tag} User`,
        email: `e2e-wmatrix-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

function workPluginsUrl(workId: string): string {
    return `${API_BASE}/api/works/${workId}/plugins`;
}

/** GET the per-work plugin list (owner). */
async function listWorkPlugins(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<WorkPluginList> {
    const res = await request.get(workPluginsUrl(workId), {
        headers: authedHeaders(token),
        timeout: 30_000,
    });
    expect(res.status(), `listWorkPlugins ${workId} body=${await res.text().catch(() => '')}`).toBe(
        200,
    );
    return (await res.json()) as WorkPluginList;
}

/** Pull a single plugin row out of the per-work list. */
function rowFor(list: WorkPluginList, pluginId: string): WorkPlugin | undefined {
    return list.plugins.find((p) => p.id === pluginId);
}

/** POST a per-work plugin action (enable/disable/capability) and parse the envelope. */
async function workPluginAction(
    request: APIRequestContext,
    token: string | null,
    workId: string,
    pluginId: string,
    action: 'enable' | 'disable' | 'capability',
    data: Record<string, unknown> = {},
): Promise<ProbeResult> {
    const res = await request.post(
        `${API_BASE}/api/works/${workId}/plugins/${pluginId}/${action}`,
        {
            headers: token ? authedHeaders(token) : undefined,
            data,
            timeout: 30_000,
        },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body };
}

/** PATCH the WORK-scoped settings for a plugin. */
async function patchWorkSettings(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
    settings: Record<string, unknown>,
): Promise<ProbeResult> {
    const res = await request.patch(
        `${API_BASE}/api/works/${workId}/plugins/${pluginId}/settings`,
        { headers: authedHeaders(token), data: { settings }, timeout: 30_000 },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body };
}

/** Enable a non-system plugin at the USER level (idempotent). */
async function userEnable(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    body: Record<string, unknown> = {},
): Promise<ProbeResult> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/enable`, {
        headers: authedHeaders(token),
        data: body,
        timeout: 30_000,
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body: parsed };
}

// AI-provider plugins (anthropic) require BOTH `apiKey` AND `defaultModel` in their
// settings schema (PROBED live 2026-06-01: anthropic settingsSchema.required ===
// ['apiKey','defaultModel']), so a user-settings PATCH with apiKey ALONE is rejected
// 400 'Missing required fields: defaultModel'. Search providers (brave/serpapi/exa)
// require only `apiKey`. We always include the extra required fields needed per plugin
// so configureUserApiKey clears the user-level gate for EVERY category.
const EXTRA_REQUIRED_USER_SETTINGS: Record<string, Record<string, unknown>> = {
    [AI_ALT]: { defaultModel: 'claude-sonnet-4-5-20250514' },
};

/** Configure a plugin's user-level required settings (the gate for any work binding). */
async function configureUserApiKey(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    value = `${pluginId}-e2e-user-key-${Date.now()}`,
): Promise<void> {
    const res = await patchPluginSettingsViaAPI(request, token, pluginId, {
        settings: { apiKey: value, ...(EXTRA_REQUIRED_USER_SETTINGS[pluginId] ?? {}) },
    });
    expect(res.status, `configure ${pluginId} user apiKey; body=${JSON.stringify(res.body)}`).toBe(
        200,
    );
}

/**
 * Fully provision a non-system plugin so a work can bind it:
 * user-enable → configure user apiKey → work-enable. Returns the work-enable result.
 */
async function provisionForWork(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
): Promise<ProbeResult> {
    const ue = await userEnable(request, token, pluginId);
    expect(ue.status, `user-enable ${pluginId}`).toBe(200);
    await configureUserApiKey(request, token, pluginId);
    const we = await workPluginAction(request, token, workId, pluginId, 'enable');
    expect(we.status, `work-enable ${pluginId}; body=${JSON.stringify(we.body)}`).toBe(200);
    return we;
}

test.describe('Work-level plugin matrix — categories / active capability / work-vs-user settings / isolation', () => {
    test('Flow 1: the per-work list is a CROSS-CATEGORY matrix — every category has its system default workEnabled and its non-system alternates off', async ({
        request,
    }) => {
        const token = await freshToken(request, 'crosscat');
        const work = await createWorkViaAPI(request, token, { name: `CrossCat ${Date.now()}` });
        expect(work.id, 'work created').toBeTruthy();

        const list = await listWorkPlugins(request, token, work.id);
        expect(Array.isArray(list.plugins), 'per-work list is an array').toBe(true);
        expect(list.plugins.length, 'the matrix spans many plugins').toBeGreaterThan(10);

        // The list spans MULTIPLE categories — not just ai-provider.
        const categories = new Set(list.plugins.map((p) => p.category).filter(Boolean));
        for (const cat of [CAP_AI, CAP_SEARCH, CAP_EXTRACTOR, 'pipeline']) {
            expect([...categories], `category "${cat}" is part of the per-work matrix`).toContain(
                cat,
            );
        }

        // SYSTEM DEFAULT per category: present, systemPlugin, workEnabled by default.
        const systemDefaults: Array<[string, string]> = [
            [AI_SYSTEM, CAP_AI],
            [SEARCH_SYSTEM, CAP_SEARCH],
            [EXTRACTOR_SYSTEM, CAP_EXTRACTOR],
            [PIPELINE_SYSTEM, 'pipeline'],
        ];
        for (const [id, cat] of systemDefaults) {
            const row = rowFor(list, id);
            expect(row, `${cat} system default "${id}" is in the matrix`).toBeTruthy();
            expect(row?.systemPlugin, `${id} is a system plugin`).toBe(true);
            expect(row?.workEnabled, `${id} (${cat}) is workEnabled by default`).toBe(true);
            expect(row?.category, `${id} category is ${cat}`).toBe(cat);
        }

        // NON-SYSTEM alternates: present, NOT user-enabled, NOT workEnabled, no record.
        for (const id of [SEARCH_ALT, SEARCH_ALT_2, MULTI_CAP, AI_ALT]) {
            const row = rowFor(list, id);
            expect(row, `non-system alternate "${id}" is in the matrix`).toBeTruthy();
            expect(row?.systemPlugin, `${id} is NOT a system plugin`).toBeFalsy();
            expect(row?.enabled, `${id} is NOT user-enabled for a fresh user`).toBeFalsy();
            expect(row?.workEnabled, `${id} is NOT workEnabled for a fresh work`).toBeFalsy();
            expect(row?.workPluginId, `${id} has no explicit per-work record yet`).toBeFalsy();
        }

        // A fresh work has NO explicit active-provider override anywhere — the
        // resolved capability map is empty even though every system default is on.
        expect(
            Object.keys(list.capabilityProviders ?? {}).length,
            'a fresh work has no explicit active-capability bindings',
        ).toBe(0);

        // MULTI-CAPABILITY plugins really do advertise two caps in the matrix.
        const multi = rowFor(list, MULTI_CAP);
        expect(multi?.capabilities ?? [], `${MULTI_CAP} advertises search`).toContain(CAP_SEARCH);
        expect(multi?.capabilities ?? [], `${MULTI_CAP} advertises content-extractor`).toContain(
            CAP_EXTRACTOR,
        );
    });

    test('Flow 2: binding an ACTIVE provider in one category does NOT disturb the others — the matrix resolves one provider PER capability independently', async ({
        request,
    }) => {
        const token = await freshToken(request, 'percat');
        const work = await createWorkViaAPI(request, token, { name: `PerCat ${Date.now()}` });

        // Provision a non-system SEARCH provider and an AI provider for the work.
        await provisionForWork(request, token, work.id, SEARCH_ALT);
        await provisionForWork(request, token, work.id, AI_ALT);

        // Bind brave as the active SEARCH provider — exclusive within `search` only.
        const bindSearch = await workPluginAction(
            request,
            token,
            work.id,
            SEARCH_ALT,
            'capability',
            {
                capability: CAP_SEARCH,
            },
        );
        expect(bindSearch.status, `bind ${SEARCH_ALT} as active search`).toBe(200);

        // Bind anthropic as the active AI provider — a DIFFERENT capability.
        const bindAi = await workPluginAction(request, token, work.id, AI_ALT, 'capability', {
            capability: CAP_AI,
        });
        expect(bindAi.status, `bind ${AI_ALT} as active ai-provider`).toBe(200);

        // The resolved map carries BOTH independent bindings simultaneously.
        await expect
            .poll(
                async () =>
                    (await listWorkPlugins(request, token, work.id)).capabilityProviders ?? {},
                {
                    timeout: 15_000,
                    message: 'work resolves search→brave AND ai-provider→anthropic',
                },
            )
            .toEqual(expect.objectContaining({ [CAP_SEARCH]: SEARCH_ALT, [CAP_AI]: AI_ALT }));

        const after = await listWorkPlugins(request, token, work.id);
        // The content-extractor category was UNTOUCHED — its system default still owns
        // no explicit override (nobody bound it), so it is NOT in capabilityProviders.
        expect(
            after.capabilityProviders?.[CAP_EXTRACTOR],
            'binding search + ai-provider did not touch the content-extractor category',
        ).toBeFalsy();
        // And the content-extractor system default stays workEnabled (its category is
        // independent of the search/ai bindings).
        expect(
            rowFor(after, EXTRACTOR_SYSTEM)?.workEnabled,
            'content-extractor system default is unaffected by other-category bindings',
        ).toBe(true);
    });

    test('Flow 3: ONE plugin can be the active provider for TWO capabilities at once; flipping one capability to another plugin clears ONLY that capability', async ({
        request,
    }) => {
        const token = await freshToken(request, 'multicap');
        const work = await createWorkViaAPI(request, token, { name: `MultiCap ${Date.now()}` });

        // exa provides BOTH search + content-extractor. Provision + work-enable it.
        await provisionForWork(request, token, work.id, MULTI_CAP);

        // Make exa the active provider for BOTH of its capabilities in this work.
        const asSearch = await workPluginAction(request, token, work.id, MULTI_CAP, 'capability', {
            capability: CAP_SEARCH,
        });
        expect(asSearch.status, `${MULTI_CAP} active for search`).toBe(200);
        const asExtractor = await workPluginAction(
            request,
            token,
            work.id,
            MULTI_CAP,
            'capability',
            {
                capability: CAP_EXTRACTOR,
            },
        );
        expect(asExtractor.status, `${MULTI_CAP} active for content-extractor`).toBe(200);
        expect(
            asExtractor.body.activeCapabilities,
            'one plugin owns BOTH active capabilities at once',
        ).toEqual(expect.arrayContaining([CAP_SEARCH, CAP_EXTRACTOR]));

        // The matrix resolves BOTH capabilities to exa.
        await expect
            .poll(
                async () =>
                    (await listWorkPlugins(request, token, work.id)).capabilityProviders ?? {},
                { timeout: 15_000, message: 'exa owns both search + content-extractor' },
            )
            .toEqual(
                expect.objectContaining({ [CAP_SEARCH]: MULTI_CAP, [CAP_EXTRACTOR]: MULTI_CAP }),
            );

        // Now flip ONLY the search capability to brave. Exclusivity is PER-CAPABILITY:
        // exa loses `search` but KEEPS `content-extractor`.
        await provisionForWork(request, token, work.id, SEARCH_ALT);
        const flip = await workPluginAction(request, token, work.id, SEARCH_ALT, 'capability', {
            capability: CAP_SEARCH,
        });
        expect(flip.status, `flip search→${SEARCH_ALT}`).toBe(200);

        const after = await listWorkPlugins(request, token, work.id);
        expect(
            after.capabilityProviders,
            'search→brave but content-extractor STILL resolves to exa (per-capability exclusivity)',
        ).toEqual(
            expect.objectContaining({ [CAP_SEARCH]: SEARCH_ALT, [CAP_EXTRACTOR]: MULTI_CAP }),
        );
        const exaAfter = rowFor(after, MULTI_CAP);
        expect(exaAfter?.activeCapabilities ?? [], 'exa lost the search capability').not.toContain(
            CAP_SEARCH,
        );
        expect(
            exaAfter?.activeCapabilities ?? [],
            'exa kept the content-extractor capability',
        ).toContain(CAP_EXTRACTOR);
        expect(
            rowFor(after, SEARCH_ALT)?.activeCapabilities ?? [],
            'brave now owns search',
        ).toContain(CAP_SEARCH);
    });

    test('Flow 4: WORK-level settings vs USER-level settings — a work override masks the user value, and a null-clear REVERTS to user inheritance', async ({
        request,
    }) => {
        const token = await freshToken(request, 'settings');
        const work = await createWorkViaAPI(request, token, { name: `Settings ${Date.now()}` });

        // A work-level settings PATCH on a plugin that is not yet enabled FOR THE WORK
        // is rejected. PROBED live 2026-06-01: updateWorkPluginSettings calls
        // ensureWorkPlugin() FIRST (a non-system plugin with no per-work record and
        // autoEnableForWorks:false is NOT work-enabled), so the real first gate is the
        // work-enable guard — the user-required-settings check only runs afterwards.
        const beforeWorkEnable = await patchWorkSettings(request, token, work.id, SEARCH_ALT, {
            apiKey: 'work-only-key',
        });
        expect(beforeWorkEnable.status, 'work settings before work-enable → 400').toBe(400);
        expect(
            String(beforeWorkEnable.body.message ?? ''),
            'the 400 demands the plugin be enabled for the work first',
        ).toMatch(/not enabled for this work/i);

        // The USER-level required-settings gate is REAL but lives on the work-ENABLE
        // path: once the plugin is user-enabled WITHOUT its required apiKey, attempting
        // to enable it for the work is rejected with the canonical user-required 400.
        await userEnable(request, token, SEARCH_ALT);
        const enableBeforeUserKey = await workPluginAction(
            request,
            token,
            work.id,
            SEARCH_ALT,
            'enable',
        );
        expect(enableBeforeUserKey.status, 'work-enable before the user apiKey → 400').toBe(400);
        expect(
            String(enableBeforeUserKey.body.message ?? ''),
            'the 400 demands user-level required settings first',
        ).toMatch(/user-level required settings must be configured first/i);
        expect(
            ((enableBeforeUserKey.body.errors as string[]) ?? []).join(' '),
            'the 400 names the missing required field',
        ).toContain('apiKey');

        // Configure the USER-level apiKey (distinct, recognisable value), then enable the
        // plugin for the work so an explicit per-work record exists — only AFTER that does
        // the work-settings PATCH resolve to a 200 override (PROBED 2026-06-01).
        const userKey = `brave-USER-key-${Date.now()}`;
        await configureUserApiKey(request, token, SEARCH_ALT, userKey);
        const workEnable = await workPluginAction(request, token, work.id, SEARCH_ALT, 'enable');
        expect(
            workEnable.status,
            `work-enable ${SEARCH_ALT}; body=${JSON.stringify(workEnable.body)}`,
        ).toBe(200);

        // Now a WORK-level override is accepted (200) and surfaces a `workSettings`
        // map DISTINCT from the user `settings`. Both are masked first-4+last-4, so the
        // WORK key is given a non-numeric, non-overlapping tail to guarantee the masks
        // differ regardless of timestamp collision.
        const workKey = `WORK-brave-override-${Date.now()}-zzqx`;
        const override = await patchWorkSettings(request, token, work.id, SEARCH_ALT, {
            apiKey: workKey,
        });
        expect(
            override.status,
            `work settings override → 200; body=${JSON.stringify(override.body)}`,
        ).toBe(200);
        expect(override.body.workPluginId, 'an explicit per-work record was minted').toBeTruthy();
        const overrideWork = (override.body.workSettings ?? {}) as Record<string, unknown>;
        const overrideUser = (override.body.settings ?? {}) as Record<string, unknown>;
        expect(overrideWork.apiKey, 'workSettings carries the (masked) work override').toBeTruthy();
        expect(overrideUser.apiKey, 'settings still carries the (masked) user value').toBeTruthy();
        expect(
            overrideWork.apiKey,
            'the work override is a DIFFERENT value from the user setting (work vs user layer)',
        ).not.toBe(overrideUser.apiKey);
        // The settings PATCH also runs a best-effort connection probe; we assert the
        // envelope EXISTS but never its success (no real key in CI).
        expect('validation' in override.body, 'a validation envelope is attached').toBe(true);

        // CLEAR the work override with apiKey:null → workSettings REVERTS to undefined
        // (pure user inheritance) while the user value is untouched.
        const cleared = await patchWorkSettings(request, token, work.id, SEARCH_ALT, {
            apiKey: null,
        });
        expect(cleared.status, 'null-clear of the work override → 200').toBe(200);

        await expect
            .poll(
                async () => {
                    const row = rowFor(await listWorkPlugins(request, token, work.id), SEARCH_ALT);
                    return {
                        work: (row?.workSettings as Record<string, unknown> | undefined)?.apiKey,
                        user: (row?.settings as Record<string, unknown> | undefined)?.apiKey,
                    };
                },
                {
                    timeout: 15_000,
                    message: 'work override reverts to user inheritance after null-clear',
                },
            )
            .toEqual({ work: undefined, user: expect.anything() });
    });

    test('Flow 5: the system DEFAULT of EVERY category is always-on per work — none can be disabled, and the matrix resolution gate is per-category', async ({
        request,
    }) => {
        const token = await freshToken(request, 'sysguard');
        const work = await createWorkViaAPI(request, token, { name: `SysGuard ${Date.now()}` });

        // The system default of each category rejects a per-work disable with the
        // SAME canonical message AND stays workEnabled afterwards.
        for (const sys of [AI_SYSTEM, SEARCH_SYSTEM, EXTRACTOR_SYSTEM, PIPELINE_SYSTEM]) {
            const disable = await workPluginAction(request, token, work.id, sys, 'disable');
            expect(disable.status, `system default ${sys} per-work disable → 400`).toBe(400);
            expect(
                String(disable.body.message ?? ''),
                `the 400 explains ${sys} is a system plugin`,
            ).toMatch(/system plugin and cannot be disabled/i);
            const stillOn = rowFor(await listWorkPlugins(request, token, work.id), sys);
            expect(
                stillOn?.workEnabled,
                `${sys} remains workEnabled after the rejected disable`,
            ).toBe(true);
        }

        // The /capability gate is per-work, per-category: binding a NON-system search
        // provider that is not yet work-enabled is rejected — "Enable it first".
        await userEnable(request, token, SEARCH_ALT);
        await configureUserApiKey(request, token, SEARCH_ALT);
        const earlyBind = await workPluginAction(
            request,
            token,
            work.id,
            SEARCH_ALT,
            'capability',
            {
                capability: CAP_SEARCH,
            },
        );
        expect(earlyBind.status, 'capability bind before work-enable → 400').toBe(400);
        expect(
            String(earlyBind.body.message ?? ''),
            'the 400 demands the plugin be enabled for the work first',
        ).toMatch(/not enabled for this work/i);

        // A plugin can only own a capability it actually PROVIDES: a search plugin
        // cannot be bound as the ai-provider, even once work-enabled.
        const we = await workPluginAction(request, token, work.id, SEARCH_ALT, 'enable');
        expect(we.status, 'work-enable the search alternate').toBe(200);
        const wrongCap = await workPluginAction(request, token, work.id, SEARCH_ALT, 'capability', {
            capability: CAP_AI,
        });
        expect(wrongCap.status, 'a search plugin bound as ai-provider → 400').toBe(400);
        expect(
            String(wrongCap.body.message ?? ''),
            'the 400 names the capability the plugin lacks',
        ).toMatch(/does not provide capability/i);
    });

    test('Flow 6: per-work enable/disable is ISOLATED across works and the surface is ownership-scoped (owner 200 / sibling clean / intruder 403-404 / anon 401)', async ({
        request,
        browser,
    }) => {
        const token = await freshToken(request, 'iso');
        await userEnable(request, token, SEARCH_ALT);
        await configureUserApiKey(request, token, SEARCH_ALT);

        const bound = await createWorkViaAPI(request, token, { name: `Iso Bound ${Date.now()}` });
        const sibling = await createWorkViaAPI(request, token, {
            name: `Iso Sibling ${Date.now()}`,
        });

        // Bind brave as the active search provider on ONE work only.
        const we = await workPluginAction(request, token, bound.id, SEARCH_ALT, 'enable');
        expect(we.status, 'work-enable the search alternate on the bound work').toBe(200);
        const bind = await workPluginAction(request, token, bound.id, SEARCH_ALT, 'capability', {
            capability: CAP_SEARCH,
        });
        expect(bind.status, 'bind active search on the bound work').toBe(200);
        await expect
            .poll(
                async () =>
                    (await listWorkPlugins(request, token, bound.id)).capabilityProviders?.[
                        CAP_SEARCH
                    ],
                { timeout: 15_000, message: 'bound work resolves search→brave' },
            )
            .toBe(SEARCH_ALT);

        // ISOLATION: the SIBLING work of the SAME user shows NONE of the binding — its
        // search category still resolves to nothing explicit, no per-work record, and
        // the non-system search alternate is not workEnabled there.
        const siblingList = await listWorkPlugins(request, token, sibling.id);
        expect(
            siblingList.capabilityProviders?.[CAP_SEARCH],
            'the search binding does NOT leak into a sibling work',
        ).toBeFalsy();
        const siblingAlt = rowFor(siblingList, SEARCH_ALT);
        expect(
            siblingAlt?.workPluginId,
            'sibling work has no per-work record for the alternate',
        ).toBeFalsy();
        expect(
            siblingAlt?.workEnabled,
            'sibling work does not inherit the explicit work-enable',
        ).toBeFalsy();
        // The sibling's own system search default is still on (independent of the bound work).
        expect(
            rowFor(siblingList, SEARCH_SYSTEM)?.workEnabled,
            'sibling system search default on',
        ).toBe(true);

        // OWNERSHIP: a different authenticated user is denied read AND write.
        const intruder = await freshToken(request, 'intruder');
        const intruderRead = await request.get(workPluginsUrl(bound.id), {
            headers: authedHeaders(intruder),
            timeout: 30_000,
        });
        expect([403, 404], `cross-user read denied (got ${intruderRead.status()})`).toContain(
            intruderRead.status(),
        );
        const intruderWrite = await workPluginAction(
            request,
            intruder,
            bound.id,
            SEARCH_ALT_2,
            'enable',
        );
        expect([403, 404], `cross-user write denied (got ${intruderWrite.status})`).toContain(
            intruderWrite.status,
        );

        // ANON: an EMPTY-storageState context (does NOT inherit the shared auth cookie)
        // is rejected 401 by the @CurrentUser guard on both read and write.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonRead = await anon.request.get(workPluginsUrl(bound.id), { timeout: 30_000 });
        expect(anonRead.status(), 'anon per-work plugin read is guarded 401').toBe(401);
        const anonWrite = await anon.request.post(
            `${API_BASE}/api/works/${bound.id}/plugins/${SEARCH_ALT}/enable`,
            { data: {}, timeout: 30_000 },
        );
        expect(anonWrite.status(), 'anon per-work plugin enable is guarded 401').toBe(401);
        await anon.close();
    });
});
