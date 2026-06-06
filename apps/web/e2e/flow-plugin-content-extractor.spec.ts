import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * COMPLEX, multi-step e2e INTEGRATION flows for CONTENT-EXTRACTOR plugins —
 * the `content-extractor` capability family (a.k.a. "Content Processors" in the
 * UI). Covers: capability discovery via the category filter, the system DEFAULT
 * extractor (local-content-extractor) and its un-disableable contract, the
 * configured-vs-unconfigured extract contract (BYOK secret masking +
 * env-adaptive validation), per-work extractor binding + active-capability
 * override (capabilityProviders map), and cross-extractor priority ordering.
 *
 * PROBED CONTRACT (live http://127.0.0.1:3100, verified 2026-06-01):
 *   The API exposes NO dedicated `/api/content-extractor/extract` route — the
 *   extractor capability is driven entirely through the generic plugins
 *   controller (apps/api/src/plugins/plugins.controller.ts, @Controller('api')).
 *   So the REAL surface for this capability is:
 *
 *     GET  /api/plugins?category=content-extractor
 *         -> { plugins[], total, categories[], capabilities[] }. In THIS stack
 *            the category resolves to FIVE plugins:
 *              local-content-extractor (systemPlugin:true, builtIn, autoEnable,
 *                  defaultForCapabilities:['content-extractor'], installed+enabled
 *                  out of the box, configurationMode:'hybrid', empty settingsSchema),
 *              pdf-extractor   (configurationMode:'hybrid', secret `mistralApiKey`
 *                  scope:user, envVar PLUGIN_PDF_EXTRACTOR_API_KEY, minLength:10),
 *              notion-extractor, scrapfly (also `screenshot`), jina (also `search`).
 *            Every entry advertises 'content-extractor' in `capabilities`.
 *            `capabilities[]` (global) ALWAYS contains 'content-extractor'.
 *
 *     GET  /api/plugins/local-content-extractor
 *         -> systemPlugin:true, defaultForCapabilities:['content-extractor'],
 *            settingsSchema.properties === {} (no user config — local/no-key),
 *            installed:true, enabled:true even for a brand-new user.
 *
 *     POST /api/plugins/local-content-extractor/disable
 *         -> 400 "Plugin \"local-content-extractor\" is a system plugin and
 *            cannot be disabled". (The default extractor is permanent.)
 *
 *     POST /api/plugins/:id/enable { settings?, secretSettings?, autoEnableForWorks? }
 *     PATCH /api/plugins/:id/settings { settings?, secretSettings? }
 *         -> on pdf-extractor with a `mistralApiKey` secret: the response NEVER
 *            echoes the plaintext key — `settings.mistralApiKey` comes back MASKED
 *            (prefix + bullet chars + last-4), and the raw key is absent from the
 *            whole JSON. PATCH response also carries a `validation` field
 *            (env-adaptive; null/contract-only with no real key configured).
 *
 *     POST /api/works/:workId/plugins/:pluginId/enable { settings?, activeCapability?, priority? }
 *         -> 400 "Plugin \"<id>\" must be enabled at user level first" when the
 *            extractor was never installed for the user (e.g. jina). The system
 *            default (local-content-extractor) enables for a work WITHOUT a prior
 *            user enable (it's auto-installed).
 *
 *     POST /api/works/:workId/plugins/:pluginId/capability { capability }
 *         -> 200 for 'content-extractor'; 400 "Plugin \"<id>\" does not provide
 *            capability \"search\"" for a capability the plugin lacks.
 *
 *     GET  /api/works/:workId/plugins
 *         -> { plugins[], total, capabilityProviders }. `capabilityProviders` is
 *            the per-work OVERRIDE map: {} while only the system DEFAULT extractor
 *            is active, and { 'content-extractor': '<pluginId>' } once a NON-default
 *            extractor (e.g. notion-extractor) is enabled+active for the work.
 *
 * GOTCHAS honored:
 *   - register DTO = {username,email,password}; login DTO = {email,password} only.
 *   - CROSS-SPEC ISOLATION: a fresh registerUserViaAPI() user per test (these are
 *     user-scoped plugin MUTATIONS; the BYOK fake key must not shadow the shared
 *     seeded user / sibling chat specs). Unique work slugs via Date.now()+rand.
 *   - assert toContain / membership, never exact counts (catalogue may grow).
 *   - NO LLM key / NO Trigger.dev in CI -> never assert extraction EXECUTION nor a
 *     "configured" validation; only the SELECTION/CONFIG/MASKING metadata.
 *   - ANON CONTEXT inherits the storageState cookie -> use empty storageState for
 *     the unauthenticated assertion.
 *   - createWorkViaAPI(request, token, { name }) -> { id }.
 */

const DEFAULT_EXTRACTOR = 'local-content-extractor';
const EXTRACTOR_CAPABILITY = 'content-extractor';

interface WorkPluginEntry {
    id: string;
    category?: string;
    capabilities?: string[];
    installed?: boolean;
    enabled?: boolean;
    workEnabled?: boolean;
    systemPlugin?: boolean;
    autoEnable?: boolean;
    priority?: number | null;
    defaultForCapabilities?: string[] | null;
    settings?: Record<string, unknown>;
}

function uniqueSlug(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function listExtractorPlugins(
    request: APIRequestContext,
    token: string,
): Promise<{ plugins: WorkPluginEntry[]; capabilities: string[]; categories: string[] }> {
    const res = await request.get(`${API_BASE}/api/plugins?category=${EXTRACTOR_CAPABILITY}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list extractors body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return {
        plugins: (body.plugins ?? []) as WorkPluginEntry[],
        capabilities: (body.capabilities ?? []) as string[],
        categories: (body.categories ?? []) as string[],
    };
}

async function listWorkPlugins(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ plugins: WorkPluginEntry[]; capabilityProviders: Record<string, string> }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `work plugins body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return {
        plugins: (body.plugins ?? []) as WorkPluginEntry[],
        capabilityProviders: (body.capabilityProviders ?? {}) as Record<string, string>,
    };
}

test.describe('flow: content-extractor plugin capability', () => {
    test.describe.configure({ mode: 'serial' });

    test('discovery: category filter surfaces extractors and the content-extractor capability', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { plugins, capabilities, categories } = await listExtractorPlugins(
            request,
            user.access_token,
        );

        // The capability filter is meaningful: every returned plugin must actually
        // be a content-extractor (category) AND advertise the capability.
        expect(plugins.length).toBeGreaterThan(0);
        for (const p of plugins) {
            expect(p.category).toBe(EXTRACTOR_CAPABILITY);
            expect(p.capabilities ?? []).toContain(EXTRACTOR_CAPABILITY);
        }

        // The global capability/category catalogues advertise the family.
        expect(capabilities).toContain(EXTRACTOR_CAPABILITY);
        expect(categories).toContain(EXTRACTOR_CAPABILITY);

        // The system default extractor is present and flagged as the
        // default-for-capability provider, pre-installed + enabled for a brand-new
        // user (no key required).
        const local = plugins.find((p) => p.id === DEFAULT_EXTRACTOR);
        expect(local, 'local-content-extractor must be in the catalogue').toBeTruthy();
        expect(local?.systemPlugin).toBe(true);
        expect(local?.defaultForCapabilities ?? []).toContain(EXTRACTOR_CAPABILITY);
        expect(local?.installed).toBe(true);
        expect(local?.enabled).toBe(true);

        // Exactly one default-for-capability extractor in the category.
        const defaults = plugins.filter((p) =>
            (p.defaultForCapabilities ?? []).includes(EXTRACTOR_CAPABILITY),
        );
        expect(defaults.map((p) => p.id)).toEqual([DEFAULT_EXTRACTOR]);
    });

    test('default extractor (local) is a system plugin that cannot be disabled', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Detail endpoint: no user-configurable settings (local/no-key extractor).
        const detailRes = await request.get(`${API_BASE}/api/plugins/${DEFAULT_EXTRACTOR}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(detailRes.status()).toBe(200);
        const detail = await detailRes.json();
        expect(detail.systemPlugin).toBe(true);
        expect(detail.installed).toBe(true);
        expect(detail.enabled).toBe(true);
        expect(detail.defaultForCapabilities ?? []).toContain(EXTRACTOR_CAPABILITY);
        // Empty settings schema => nothing to configure (the "local, no API key" contract).
        expect(detail.settingsSchema?.properties ?? {}).toEqual({});

        // Disabling the system default is REJECTED with a 400 + truthful message.
        const disableRes = await request.post(
            `${API_BASE}/api/plugins/${DEFAULT_EXTRACTOR}/disable`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(disableRes.status()).toBe(400);
        const disableBody = await disableRes.json();
        expect(String(disableBody.message)).toContain('system plugin');
        expect(String(disableBody.message)).toContain(DEFAULT_EXTRACTOR);

        // And it stays enabled after the rejected disable (idempotent system state).
        const after = await listExtractorPlugins(request, user.access_token);
        expect(after.plugins.find((p) => p.id === DEFAULT_EXTRACTOR)?.enabled).toBe(true);
    });

    test('extract contract: BYOK extractor configured-vs-unconfigured masks the secret', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // UNCONFIGURED: pdf-extractor not installed for a fresh user; it advertises
        // a secret `mistralApiKey` (the BYOK knob that flips configured/unconfigured).
        const detailRes = await request.get(`${API_BASE}/api/plugins/pdf-extractor`, {
            headers: authedHeaders(user.access_token),
        });
        expect(detailRes.status()).toBe(200);
        const detail = await detailRes.json();
        expect(detail.category).toBe(EXTRACTOR_CAPABILITY);
        expect(detail.installed).toBe(false);
        const secretProp = detail.settingsSchema?.properties?.mistralApiKey;
        expect(secretProp, 'pdf-extractor must expose a secret apiKey knob').toBeTruthy();
        expect(secretProp.secret).toBe(true);

        // CONFIGURE (BYOK): enable with a fake secret key.
        const FAKE_KEY = `sk-fake-mistral-${Date.now()}-ZZZZZZZZ`;
        const enableRes = await request.post(`${API_BASE}/api/plugins/pdf-extractor/enable`, {
            headers: authedHeaders(user.access_token),
            data: { secretSettings: { mistralApiKey: FAKE_KEY } },
        });
        expect(enableRes.status(), `enable body=${await enableRes.text().catch(() => '')}`).toBe(
            200,
        );
        const enabled = await enableRes.json();
        expect(enabled.installed).toBe(true);
        expect(enabled.enabled).toBe(true);
        // The plaintext secret is NEVER echoed back from the enable response.
        expect(JSON.stringify(enabled)).not.toContain(FAKE_KEY);

        // PATCH a new secret: response masks it AND keeps the contract field set.
        const NEW_KEY = `sk-fake-mistral-${Date.now()}-QQQQQQQQ`;
        const patchRes = await request.patch(`${API_BASE}/api/plugins/pdf-extractor/settings`, {
            headers: authedHeaders(user.access_token),
            data: { secretSettings: { mistralApiKey: NEW_KEY } },
        });
        expect(patchRes.status()).toBe(200);
        const patched = await patchRes.json();
        // Whole payload must not leak the plaintext key.
        expect(JSON.stringify(patched)).not.toContain(NEW_KEY);
        // `settings.mistralApiKey` is present but MASKED (not the raw value).
        const shown = (patched.settings ?? {}).mistralApiKey;
        if (shown !== undefined && shown !== null) {
            expect(String(shown)).not.toBe(NEW_KEY);
            expect(String(shown).length).toBeGreaterThan(0);
        }
        // PATCH carries an env-adaptive `validation` field (no real key configured
        // in CI -> null/contract-only; NEVER assert a successful "configured" probe).
        expect('validation' in patched).toBe(true);
    });

    test('per-work extractor: enable + active-capability override flips capabilityProviders', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: 'CE per-work override',
            slug: uniqueSlug('ce-override'),
        });
        expect(workId).toBeTruthy();

        // Baseline: only the system default extractor is active for the work, so the
        // per-work OVERRIDE map is empty (the default needs no override entry).
        const baseline = await listWorkPlugins(request, user.access_token, workId);
        expect(baseline.capabilityProviders[EXTRACTOR_CAPABILITY]).toBeUndefined();
        const localInWork = baseline.plugins.find((p) => p.id === DEFAULT_EXTRACTOR);
        expect(localInWork?.workEnabled).toBe(true);

        // Enabling a NON-default extractor (jina) for the work WITHOUT a prior user
        // enable is rejected — work plugins require a user-level enable first.
        const premature = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/jina/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { activeCapability: EXTRACTOR_CAPABILITY },
            },
        );
        expect(premature.status()).toBe(400);
        expect(String((await premature.json()).message)).toContain('user level');

        // Install notion-extractor at the user level, then bind it (active) to the work.
        const userEnable = await request.post(`${API_BASE}/api/plugins/notion-extractor/enable`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        expect(userEnable.status()).toBe(200);

        const workEnable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/notion-extractor/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { activeCapability: EXTRACTOR_CAPABILITY, priority: 5 },
            },
        );
        expect(
            workEnable.status(),
            `work enable body=${await workEnable.text().catch(() => '')}`,
        ).toBe(200);

        // The override map now names the non-default extractor for the capability.
        const overridden = await listWorkPlugins(request, user.access_token, workId);
        expect(overridden.capabilityProviders[EXTRACTOR_CAPABILITY]).toBe('notion-extractor');
        const notionInWork = overridden.plugins.find((p) => p.id === 'notion-extractor');
        expect(notionInWork?.workEnabled).toBe(true);
    });

    test('per-work capability endpoint: accepts content-extractor, rejects a foreign capability', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: 'CE capability validation',
            slug: uniqueSlug('ce-cap'),
        });
        expect(workId).toBeTruthy();

        // Bind the system default extractor to the work so the capability endpoint
        // has a target plugin (it's auto-installed -> no user enable required).
        const workEnable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${DEFAULT_EXTRACTOR}/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { activeCapability: EXTRACTOR_CAPABILITY },
            },
        );
        expect(workEnable.status()).toBe(200);

        // Setting the capability it DOES provide -> 200.
        const ok = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${DEFAULT_EXTRACTOR}/capability`,
            {
                headers: authedHeaders(user.access_token),
                data: { capability: EXTRACTOR_CAPABILITY },
            },
        );
        expect(ok.status(), `set cap body=${await ok.text().catch(() => '')}`).toBe(200);

        // Setting a capability the extractor LACKS (search) -> 400 + precise message.
        const bad = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${DEFAULT_EXTRACTOR}/capability`,
            {
                headers: authedHeaders(user.access_token),
                data: { capability: 'search' },
            },
        );
        expect(bad.status()).toBe(400);
        const badBody = await bad.json();
        expect(String(badBody.message)).toContain('does not provide capability');
        expect(String(badBody.message)).toContain('search');
    });

    test('cross-extractor: two extractors coexist per-work with priority; unauth list is rejected', async ({
        request,
        browser,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: 'CE multi-extractor',
            slug: uniqueSlug('ce-multi'),
        });
        expect(workId).toBeTruthy();

        // Install two real BYOK extractors at the user level.
        for (const id of ['notion-extractor', 'pdf-extractor']) {
            const r = await request.post(`${API_BASE}/api/plugins/${id}/enable`, {
                headers: authedHeaders(user.access_token),
                data: {},
            });
            expect(r.status(), `user enable ${id}`).toBe(200);
        }

        // Bind both to the work with DIFFERENT priorities (lower = higher priority).
        const notionWork = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/notion-extractor/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { activeCapability: EXTRACTOR_CAPABILITY, priority: 1 },
            },
        );
        expect(notionWork.status()).toBe(200);
        const pdfWork = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/pdf-extractor/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { priority: 9 },
            },
        );
        expect(pdfWork.status()).toBe(200);

        const { plugins, capabilityProviders } = await listWorkPlugins(
            request,
            user.access_token,
            workId,
        );
        // Both extractors plus the system default are all present for the work.
        const extractorEntries = plugins.filter((p) => p.category === EXTRACTOR_CAPABILITY);
        const enabledExtractorIds = extractorEntries.filter((p) => p.workEnabled).map((p) => p.id);
        expect(enabledExtractorIds).toContain('notion-extractor');
        expect(enabledExtractorIds).toContain('pdf-extractor');
        expect(enabledExtractorIds).toContain(DEFAULT_EXTRACTOR);

        // The ACTIVE (override) extractor for the capability is the one bound with
        // activeCapability — notion-extractor — not whichever has the lowest priority
        // alone. Priority is recorded on the binding regardless.
        expect(capabilityProviders[EXTRACTOR_CAPABILITY]).toBe('notion-extractor');
        const notionEntry = extractorEntries.find((p) => p.id === 'notion-extractor');
        const pdfEntry = extractorEntries.find((p) => p.id === 'pdf-extractor');
        expect(notionEntry?.priority).toBe(1);
        expect(pdfEntry?.priority).toBe(9);

        // SECURITY: an anonymous client cannot read the work's plugin bindings.
        // (bare newContext() would inherit the storageState cookie -> use empty state.)
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.get(`${API_BASE}/api/works/${workId}/plugins`);
            expect(anonRes.ok()).toBeFalsy();
            expect([401, 403]).toContain(anonRes.status());
        } finally {
            await anon.close();
        }
    });
});
