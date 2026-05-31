import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    listPluginsViaAPI,
    getPluginViaAPI,
    enablePluginViaAPI,
    disablePluginViaAPI,
    patchPluginSettingsViaAPI,
} from './helpers/plugins';

/**
 * Plugin lifecycle (non-AI) + capabilities — REAL multi-step API + UI orchestration.
 *
 * Themed around the SEARCH / content-extractor plugin family (no LLM key, no
 * Trigger.dev required), this file exercises three cross-feature flows that the
 * shallow `plugin-enable-disable-lifecycle.spec.ts` smoke does NOT cover. Every
 * request/response shape, status code and error string below was probed against
 * the live API before being asserted (see inline notes); nothing is guessed.
 *
 * Cross-spec isolation: all mutating orchestration runs on FRESH
 * registerUserViaAPI() users so the shared in-memory DB stays clean for sibling
 * specs (a user-scoped search apiKey would otherwise shadow env keys). The
 * seeded UI user (storageState) is used only for a read-only UI cross-layer
 * assertion. Names/works use Date.now() suffixes and we assert toContain /
 * presence, never exact catalog counts.
 *
 * FLOW 1 — Fresh-user enable -> disable lifecycle of a safe no-key SEARCH plugin
 *   (`brave`: not system, not auto-enable, starts disabled). Enable -> GET
 *   reports enabled:true & installed:true; disable -> enabled:false while
 *   installed STAYS true (probed: disable keeps the install record). Then a
 *   targeted UI cross-layer check: the /plugins page card reflects the
 *   API-driven state for the seeded user.
 *
 * FLOW 2 — User-plugin settings VALIDATION against the real JSON-schema
 *   validator. brave's schema is { required: ["apiKey"(user,secret)],
 *   maxResults(global) }. Probed truths:
 *     - PATCH before install            -> 400 "Plugin \"X\" is not installed for this user. Enable it first."
 *     - PATCH missing required apiKey   -> 400 { message:"Invalid plugin settings", errors:["Missing required fields: apiKey"] }
 *     - PATCH with apiKey + maxResults  -> 200, persists (apiKey masked in `settings`, maxResults in `resolvedSettings`)
 *
 * FLOW 3 — Work-level plugin enablement + active capability + isolation.
 *   POST /api/works/:workId/plugins/:pluginId/enable. Probed truths:
 *     - work-enable before the user-scoped required apiKey is set -> 400
 *       { message:"User-level required settings must be configured first", errors:["Missing required fields: apiKey"] }
 *     - work-enable with an invalid activeCapability -> 400 (DTO capability validator, message is an array)
 *     - work-enable with activeCapability:"search" after user apiKey set -> 200
 *       { workEnabled:true, activeCapabilities:["search"], priority, workPluginId }
 *     - POST .../capability { capability:"deployment" } -> 400 'does not provide capability "deployment"'
 *     - POST .../capability { capability:"search" }     -> 200, activeCapabilities:["search"]
 *     - GET /api/works/:id/plugins.capabilityProviders  -> { search: "brave" }
 *     - ISOLATION: GET /api/plugins/brave (user scope) has NO workEnabled /
 *       activeCapabilities keys; work-disable flips workEnabled:false while the
 *       user-level enabled:true is untouched.
 */

// A safe, no-key SEARCH plugin: not a system plugin, not auto-enabled, starts
// disabled, and ships a settings schema with a single user-scoped secret
// required field (`apiKey`) plus a non-secret global `maxResults`.
const SEARCH_PLUGIN_ID = 'brave';
// A second independent no-key search plugin used so flow 1 doesn't collide with
// the brave state mutated by flows 2/3 on other (fresh) users.
const SECOND_SEARCH_PLUGIN_ID = 'exa';

const FAKE_API_KEY = 'e2e-fake-search-key-1234567890';

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted: only { email, password } — passing `name` 400s.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

/** Inline work-plugin helpers (no shared helper exists for these endpoints). */
async function enableWorkPlugin(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
    body: { settings?: Record<string, unknown>; activeCapability?: string; priority?: number } = {},
) {
    const res = await request.post(`${API_BASE}/api/works/${workId}/plugins/${pluginId}/enable`, {
        headers: authedHeaders(token),
        data: body,
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

async function disableWorkPlugin(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
) {
    const res = await request.post(`${API_BASE}/api/works/${workId}/plugins/${pluginId}/disable`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

async function setWorkActiveCapability(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
    capability: string,
) {
    const res = await request.post(
        `${API_BASE}/api/works/${workId}/plugins/${pluginId}/capability`,
        { headers: authedHeaders(token), data: { capability } },
    );
    return { status: res.status(), body: await res.json().catch(() => null) };
}

async function listWorkPlugins(request: APIRequestContext, token: string, workId: string) {
    const res = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

/** The /plugins page card for a plugin name (anchored on its <h3> + Settings link). */
function pluginCard(page: Page, name: string) {
    return page
        .locator('div', { has: page.getByRole('heading', { level: 3, name }) })
        .filter({ has: page.getByRole('link', { name: /Settings/i }) })
        .first();
}

test.describe('Plugin lifecycle (search/non-AI) + capabilities', () => {
    test('FLOW 1: fresh-user enable -> disable a no-key search plugin; installed stays true; UI reflects API state', async ({
        page,
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // The target must exist in the catalog and start disabled (it is neither
        // a system plugin nor auto-enabled), so a fresh user sees it off.
        const catalog = await listPluginsViaAPI(request, user.access_token);
        const summary = catalog.find((p) => p.id === SECOND_SEARCH_PLUGIN_ID);
        expect(
            summary,
            `plugin "${SECOND_SEARCH_PLUGIN_ID}" present in GET /api/plugins`,
        ).toBeTruthy();
        expect(summary?.category).toBe('search');

        const before = await getPluginViaAPI(request, user.access_token, SECOND_SEARCH_PLUGIN_ID);
        expect(before.enabled, 'fresh user sees the search plugin disabled').toBe(false);
        expect(before.capabilities).toContain('search');

        // ENABLE -> enabled:true AND installed:true.
        const enabled = await enablePluginViaAPI(
            request,
            user.access_token,
            SECOND_SEARCH_PLUGIN_ID,
        );
        expect(enabled.enabled).toBe(true);
        expect(enabled.installed).toBe(true);
        await expect
            .poll(
                async () =>
                    (await getPluginViaAPI(request, user.access_token, SECOND_SEARCH_PLUGIN_ID))
                        .enabled,
                { timeout: 15_000, message: 'enable should persist as enabled:true' },
            )
            .toBe(true);

        // DISABLE -> enabled:false while installed STAYS true (probed behaviour:
        // the install record survives a disable; only the enabled flag flips).
        const disabled = await disablePluginViaAPI(
            request,
            user.access_token,
            SECOND_SEARCH_PLUGIN_ID,
        );
        expect(disabled.enabled).toBe(false);
        expect(disabled.installed, 'installed survives disable').toBe(true);
        await expect
            .poll(
                async () =>
                    (await getPluginViaAPI(request, user.access_token, SECOND_SEARCH_PLUGIN_ID))
                        .enabled,
                { timeout: 15_000, message: 'disable should persist as enabled:false' },
            )
            .toBe(false);

        // UI CROSS-LAYER CHECK (seeded storageState user): drive the seeded
        // user's catalog state via the API to a known DISABLED baseline, then
        // confirm the /plugins page card surfaces the matching "Enable" toggle
        // (i.e. the UI reads the same per-user state the API persists). This is
        // a read-only consistency check — we deliberately do NOT re-drive the
        // confirmation dialogs that the existing lifecycle smoke already covers.
        const seedTok = await seededToken(request);
        await disablePluginViaAPI(request, seedTok, SECOND_SEARCH_PLUGIN_ID).catch(() => undefined);
        await expect
            .poll(
                async () =>
                    (await getPluginViaAPI(request, seedTok, SECOND_SEARCH_PLUGIN_ID)).enabled,
                { timeout: 15_000 },
            )
            .toBe(false);

        const pluginName = (await getPluginViaAPI(request, seedTok, SECOND_SEARCH_PLUGIN_ID))
            .name as string;
        expect(pluginName, 'plugin should expose a display name').toBeTruthy();

        await page.goto('/plugins');
        const search = page.getByPlaceholder('Search plugins...');
        await expect(search).toBeVisible({ timeout: 30_000 });
        await search.fill(pluginName);

        const card = pluginCard(page, pluginName);
        await expect(card, 'search-plugin card should render after filtering').toBeVisible({
            timeout: 30_000,
        });
        await expect(
            card.getByRole('button', { name: /^Enable$/ }),
            'card should offer Enable, matching the API disabled state',
        ).toBeVisible({ timeout: 20_000 });
    });

    test('FLOW 2: user-plugin settings validation — install gate, missing required apiKey -> 400 errors, full payload persists', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // (a) PATCH before installing -> 400 "not installed ... Enable it first."
        const notInstalled = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SEARCH_PLUGIN_ID,
            { settings: { maxResults: 5 } },
        );
        expect(notInstalled.status).toBe(400);
        expect((notInstalled.body as { message?: string })?.message).toContain('is not installed');
        expect((notInstalled.body as { message?: string })?.message).toContain('Enable it first');

        // Enable the plugin (no settings) so subsequent PATCHes are allowed.
        const enabled = await enablePluginViaAPI(request, user.access_token, SEARCH_PLUGIN_ID);
        expect(enabled.enabled).toBe(true);

        // (b) PATCH missing the required user-scoped `apiKey` (only the global
        //     non-secret maxResults) -> 400 with the EXACT errors array.
        const missing = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SEARCH_PLUGIN_ID,
            { settings: { maxResults: 5 } },
        );
        expect(missing.status).toBe(400);
        const missingBody = missing.body as { message?: string; errors?: string[] };
        expect(missingBody?.message).toBe('Invalid plugin settings');
        expect(Array.isArray(missingBody?.errors)).toBe(true);
        expect(missingBody?.errors).toContain('Missing required fields: apiKey');

        // (c) PATCH with the required apiKey (secret) + maxResults -> 200, and it
        //     persists: maxResults round-trips via resolvedSettings, and the
        //     secret apiKey is echoed back MASKED inside `settings` (never raw).
        const ok = await patchPluginSettingsViaAPI(request, user.access_token, SEARCH_PLUGIN_ID, {
            settings: { maxResults: 7 },
            secretSettings: { apiKey: FAKE_API_KEY },
        });
        expect(ok.status, `patch ok body=${JSON.stringify(ok.body)}`).toBe(200);
        const okBody = ok.body as {
            settings?: Record<string, unknown>;
            resolvedSettings?: Record<string, unknown>;
        };
        expect(okBody?.resolvedSettings?.maxResults).toBe(7);
        // apiKey is masked (contains the bullet pattern) and the raw value is never returned.
        const echoedApiKey = okBody?.settings?.apiKey;
        expect(typeof echoedApiKey).toBe('string');
        expect(echoedApiKey).not.toBe(FAKE_API_KEY);
        expect(String(echoedApiKey)).toContain('••••');

        // Persistence survives a fresh GET (maxResults stays, apiKey stays masked).
        await expect
            .poll(
                async () => {
                    const fresh = await getPluginViaAPI(
                        request,
                        user.access_token,
                        SEARCH_PLUGIN_ID,
                    );
                    return (fresh.resolvedSettings as Record<string, unknown> | undefined)
                        ?.maxResults;
                },
                { timeout: 15_000, message: 'maxResults should persist across GET' },
            )
            .toBe(7);
    });

    test('FLOW 3: work-level enablement, active capability, and user/work isolation', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Search Work ${Date.now()}`,
        });
        expect(
            work.id,
            `work should be created (raw=${JSON.stringify(work.raw).slice(0, 200)})`,
        ).toBeTruthy();

        // Enable the plugin at USER level WITHOUT the required apiKey first, so we
        // can assert the user-level-required GATE on work-enable.
        await enablePluginViaAPI(request, user.access_token, SEARCH_PLUGIN_ID);

        // (a) work-enable before the user-scoped required apiKey is configured ->
        //     400 with the user-level-required message + errors array.
        const gated = await enableWorkPlugin(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
            { activeCapability: 'search' },
        );
        expect(gated.status).toBe(400);
        const gatedBody = gated.body as { message?: string; errors?: string[] };
        expect(gatedBody?.message).toBe('User-level required settings must be configured first');
        expect(gatedBody?.errors).toContain('Missing required fields: apiKey');

        // Configure the required user-scoped apiKey so the gate clears.
        const configured = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SEARCH_PLUGIN_ID,
            { secretSettings: { apiKey: FAKE_API_KEY } },
        );
        expect(configured.status, `configure body=${JSON.stringify(configured.body)}`).toBe(200);

        // (b) work-enable with an INVALID activeCapability -> 400 from the DTO's
        //     capability validator (message is an array of validation messages).
        const badCap = await enableWorkPlugin(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
            {
                activeCapability: 'totally-not-a-cap',
            },
        );
        expect(badCap.status).toBe(400);
        const badCapMsg = (badCap.body as { message?: string | string[] })?.message;
        const badCapText = Array.isArray(badCapMsg) ? badCapMsg.join(' ') : String(badCapMsg);
        expect(badCapText).toContain('is not a valid capability');

        // (c) work-enable with the valid `search` capability -> 200, work-scoped
        //     state set: workEnabled true, activeCapabilities includes search,
        //     priority echoed, workPluginId issued.
        const wEnabled = await enableWorkPlugin(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
            { activeCapability: 'search', priority: 3 },
        );
        expect(wEnabled.status, `work-enable body=${JSON.stringify(wEnabled.body)}`).toBe(200);
        const we = wEnabled.body as {
            workEnabled?: boolean;
            activeCapabilities?: string[];
            priority?: number;
            workPluginId?: string;
            installed?: boolean;
            enabled?: boolean;
        };
        expect(we.workEnabled).toBe(true);
        expect(we.activeCapabilities).toContain('search');
        expect(we.priority).toBe(3);
        expect(typeof we.workPluginId).toBe('string');
        // User-level facts are still echoed in the work response.
        expect(we.installed).toBe(true);
        expect(we.enabled).toBe(true);

        // (d) /capability endpoint: invalid capability for this plugin -> 400.
        const wrongCap = await setWorkActiveCapability(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
            'deployment',
        );
        expect(wrongCap.status).toBe(400);
        expect((wrongCap.body as { message?: string })?.message).toContain(
            'does not provide capability',
        );

        // (e) /capability endpoint: valid `search` -> 200, activeCapabilities set.
        const rightCap = await setWorkActiveCapability(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
            'search',
        );
        expect(rightCap.status, `set-cap body=${JSON.stringify(rightCap.body)}`).toBe(200);
        expect((rightCap.body as { activeCapabilities?: string[] })?.activeCapabilities).toContain(
            'search',
        );

        // (f) The work plugin list reports the capability provider mapping and the
        //     brave entry as work-enabled with the active capability.
        const wList = await listWorkPlugins(request, user.access_token, work.id);
        expect(wList.status).toBe(200);
        const listBody = wList.body as {
            capabilityProviders?: Record<string, string>;
            plugins?: Array<{ id: string; workEnabled?: boolean; activeCapabilities?: string[] }>;
        };
        expect(listBody?.capabilityProviders?.search).toBe(SEARCH_PLUGIN_ID);
        const braveInList = listBody?.plugins?.find((p) => p.id === SEARCH_PLUGIN_ID);
        expect(braveInList?.workEnabled).toBe(true);
        expect(braveInList?.activeCapabilities).toContain('search');

        // (g) ISOLATION: the USER-scope GET carries NO work-scoped fields. The
        //     work activation is scoped to the work, not the user catalog row.
        const userScope = await getPluginViaAPI(request, user.access_token, SEARCH_PLUGIN_ID);
        expect(userScope.enabled).toBe(true);
        expect('workEnabled' in userScope, 'user-scope GET must not leak workEnabled').toBe(false);
        expect(
            'activeCapabilities' in userScope,
            'user-scope GET must not leak activeCapabilities',
        ).toBe(false);

        // (h) ISOLATION (other direction): work-disable flips workEnabled:false
        //     while the user-level enabled:true is left untouched.
        const wDisabled = await disableWorkPlugin(
            request,
            user.access_token,
            work.id,
            SEARCH_PLUGIN_ID,
        );
        expect(wDisabled.status).toBe(200);
        const wd = wDisabled.body as { workEnabled?: boolean; enabled?: boolean };
        expect(wd.workEnabled).toBe(false);
        expect(wd.enabled, 'work-disable must not touch user-level enabled').toBe(true);

        // Confirm via a fresh user-level GET that the user catalog row is intact.
        const userAfter = await getPluginViaAPI(request, user.access_token, SEARCH_PLUGIN_ID);
        expect(userAfter.enabled).toBe(true);
        expect(userAfter.installed).toBe(true);
    });
});
