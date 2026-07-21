/**
 * OfficeCLI Content Extractor plugin — DEEP, against a live stack (#1680).
 *
 * The OfficeCLI extractor (docx/xlsx/pptx → text/markdown) shipped as an
 * OPTIONAL, off-by-default, SUPPLEMENTARY content-extractor plugin with no
 * dedicated e2e coverage. There is no public "extract-from-URL" REST route —
 * the ContentExtractorFacade is invoked internally during work generation / KB
 * ingestion. So this file pins the real, reachable surface end-to-end: plugin
 * registration + metadata + the user/work plugin-management lifecycle that
 * governs whether the extractor is ever wired into the facade. The CLI binary
 * itself is never exercised here (env-adaptive: it may be absent), so we assert
 * the registration/contract + the graceful "available" posture, never a live
 * extraction.
 *
 * Probed live (http://127.0.0.1:3100, sqlite in-memory, all flags ON) before
 * every assertion. The observed contract:
 *
 *   • GET /api/plugins → { plugins, total, categories, capabilities }; the full
 *     (unfiltered) list carries officecli-extractor with category
 *     "content-extractor", capabilities ["content-extractor"], supplementary
 *     true, systemPlugin false, distribution "registry", off by default
 *     (enabled=false, installed=false), state "loaded".
 *   • GET /api/plugins?category=content-extractor → ONLY enabled plugins in the
 *     category → EXCLUDES officecli until the caller enables it, then INCLUDES it.
 *   • settingsSchema exposes exactly { renderMode(enum text|markdown, def text),
 *     maxBytes(min 1024, max 209715200) } — x-hidden timeout/binaryPath stripped.
 *   • GET /api/plugins/:id → single plugin; unknown → 404 (constant shape).
 *   • GET /api/plugins/catalog → { entries, fetchedAt, degraded:false }; officecli
 *     entry install.installState "available", source "bundled".
 *   • GET /api/plugins/:id/install-status → available/bundled; models → [];
 *     connection-status → {} ; validate-connection → { success:true, message }.
 *   • POST enable/disable (user): enable→enabled+installed true; disable→enabled
 *     false, installed stays true; invalid settings enum → 400 { message, errors }.
 *   • PATCH settings: renderMode enum + maxBytes bounds enforced → 400.
 *   • Work scope: enable-for-work requires user-level enable first (400);
 *     enable-for-work with activeCapability "content-extractor" → workEnabled;
 *     the dedicated /capability route REFUSES it (supplementary → 400); an
 *     unowned capability → 400 "does not provide"; cross-user work access → 403;
 *     unknown/malformed work → 404.
 *   • Every route is auth-gated → 401 with no bearer.
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never the
 * shared seeded user). `flow-` prefix ⇒ runs in the authed chromium project and
 * is NOT matched by the no-auth testIgnore regex.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

const PLUGIN_ID = 'officecli-extractor';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '11111111-1111-4111-8111-111111111111';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Enable the officecli extractor at the user level (prerequisite for work-scope). */
async function enableForUser(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    const res = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/enable`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `enableForUser body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('OfficeCLI extractor — registration & metadata', () => {
    test('appears in the full plugin list with the exact supplementary/content-extractor manifest', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.plugins)).toBe(true);
        expect(body.total).toBe(body.plugins.length);
        expect(body.categories).toContain('content-extractor');

        const ids = body.plugins.map((p: { id: string }) => p.id);
        expect(ids).toContain(PLUGIN_ID);

        const p = body.plugins.find((x: { id: string }) => x.id === PLUGIN_ID);
        expect(p.name).toBe('OfficeCLI Content Extractor');
        expect(p.category).toBe('content-extractor');
        expect(p.capabilities).toEqual(['content-extractor']);
        expect(p.version).toBe('1.0.0');
        expect(p.supplementary).toBe(true);
        expect(p.systemPlugin).toBe(false);
        expect(p.builtIn).toBe(true);
        expect(p.isDefault).toBe(false);
        expect(p.autoEnable).toBe(false);
        expect(p.distribution).toBe('registry');
        expect(p.configurationMode).toBe('hybrid');
        expect(p.state).toBe('loaded');
        expect(p.license).toBe('AGPL-3.0');
        expect(p.author).toMatchObject({ name: 'Ever Works Team' });
    });

    test('is OFF by default — a fresh user sees enabled=false / installed=false', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const p = await res.json();
        expect(p.id).toBe(PLUGIN_ID);
        expect(p.enabled).toBe(false);
        expect(p.installed).toBe(false);
        expect(p.autoEnableForWorks).toBe(false);
        expect(p.state).toBe('loaded');
    });

    test('settingsSchema exposes exactly renderMode + maxBytes with the probed enum/bounds/defaults', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}`, {
            headers: authedHeaders(user.access_token),
        });
        const p = await res.json();
        const props = p.settingsSchema.properties;
        // x-hidden `timeout` and `binaryPath` are stripped from the exposed schema.
        expect(Object.keys(props).sort()).toEqual(['maxBytes', 'renderMode']);
        expect(props.renderMode.enum).toEqual(['text', 'markdown']);
        expect(props.renderMode.default).toBe('text');
        expect(props.maxBytes.minimum).toBe(1024);
        expect(props.maxBytes.maximum).toBe(209715200);
        // Resolved defaults for a not-yet-configured user.
        expect(p.resolvedSettings.renderMode).toBe('text');
        expect(p.resolvedSettings.maxBytes).toBe(26214400);
    });

    test('readme documents the docx/xlsx/pptx + off-by-default contract', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}`, {
            headers: authedHeaders(user.access_token),
        });
        const p = await res.json();
        expect(typeof p.readme).toBe('string');
        expect(p.readme).toContain('.docx');
        expect(p.readme).toContain('.xlsx');
        expect(p.readme).toContain('.pptx');
        expect(p.description).toContain('.docx/.xlsx/.pptx');
    });

    test('the EW-693 catalog lists it as a bundled/available registry plugin', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/catalog`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.entries)).toBe(true);
        expect(typeof body.fetchedAt).toBe('string');
        expect(body.degraded).toBe(false);
        const entry = body.entries.find((e: { pluginId: string }) => e.pluginId === PLUGIN_ID);
        expect(entry, 'officecli-extractor should be in the catalog').toBeTruthy();
        expect(entry.category).toBe('content-extractor');
        expect(entry.capabilities).toEqual(['content-extractor']);
        expect(entry.distribution).toBe('registry');
        expect(entry.deprecated).toBe(false);
        expect(entry.install.installState).toBe('available');
        expect(entry.install.source).toBe('bundled');
    });

    test('install-status is a read-only available/bundled row; models is an empty list for a non-AI plugin', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const install = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}/install-status`, {
            headers: authedHeaders(user.access_token),
        });
        expect(install.status()).toBe(200);
        const state = await install.json();
        expect(state.pluginId).toBe(PLUGIN_ID);
        expect(state.installState).toBe('available');
        expect(state.source).toBe('bundled');

        const models = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}/models`, {
            headers: authedHeaders(user.access_token),
        });
        expect(models.status()).toBe(200);
        expect(await models.json()).toEqual([]);
    });
});

test.describe('OfficeCLI extractor — user enable / disable lifecycle', () => {
    test('the category=content-extractor filter excludes it until enabled, then includes it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const before = await request.get(`${API_BASE}/api/plugins?category=content-extractor`, {
            headers: authedHeaders(user.access_token),
        });
        expect(before.status()).toBe(200);
        const beforeIds = (await before.json()).plugins.map((p: { id: string }) => p.id);
        // Off-by-default supplementary plugin is not surfaced in the enabled-only settings filter.
        expect(beforeIds).not.toContain(PLUGIN_ID);

        await enableForUser(request, user.access_token);

        const after = await request.get(`${API_BASE}/api/plugins?category=content-extractor`, {
            headers: authedHeaders(user.access_token),
        });
        const afterIds = (await after.json()).plugins.map((p: { id: string }) => p.id);
        expect(afterIds).toContain(PLUGIN_ID);
    });

    test('enable flips enabled+installed true; disable clears enabled but leaves installed true', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const enabled = await enableForUser(request, user.access_token);
        expect(enabled.enabled).toBe(true);
        expect(enabled.installed).toBe(true);

        const disable = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/disable`, {
            headers: authedHeaders(user.access_token),
        });
        expect(disable.status()).toBe(200);
        const after = await disable.json();
        expect(after.enabled).toBe(false);
        // Disable is a soft toggle — the installation record persists.
        expect(after.installed).toBe(true);
    });

    test('enable persists user settings + autoEnableForWorks', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const result = await enableForUser(request, user.access_token, {
            settings: { renderMode: 'markdown' },
            autoEnableForWorks: true,
        });
        expect(result.enabled).toBe(true);
        expect(result.autoEnableForWorks).toBe(true);
        expect((result.resolvedSettings as Record<string, unknown>).renderMode).toBe('markdown');
    });

    test('enabling with an invalid renderMode enum → 400 { message, errors }', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/enable`, {
            headers: authedHeaders(user.access_token),
            data: { settings: { renderMode: 'docx' } },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toBe('Invalid plugin settings');
        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors.join(' ')).toContain('renderMode');
        expect(body.errors.join(' ')).toContain('text, markdown');
    });

    test('PATCH settings honors the renderMode change and reflects it in resolvedSettings', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await enableForUser(request, user.access_token);
        const patch = await request.patch(`${API_BASE}/api/plugins/${PLUGIN_ID}/settings`, {
            headers: authedHeaders(user.access_token),
            data: { settings: { renderMode: 'markdown' } },
        });
        expect(patch.status()).toBe(200);
        const body = await patch.json();
        expect((body.resolvedSettings as Record<string, unknown>).renderMode).toBe('markdown');
    });

    test('PATCH settings rejects out-of-bounds maxBytes on BOTH ends → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await enableForUser(request, user.access_token);
        const below = await request.patch(`${API_BASE}/api/plugins/${PLUGIN_ID}/settings`, {
            headers: authedHeaders(user.access_token),
            data: { settings: { maxBytes: 512 } },
        });
        expect(below.status()).toBe(400);
        expect((await below.json()).errors.join(' ')).toContain('>= 1024');

        const above = await request.patch(`${API_BASE}/api/plugins/${PLUGIN_ID}/settings`, {
            headers: authedHeaders(user.access_token),
            data: { settings: { maxBytes: 999_999_999 } },
        });
        expect(above.status()).toBe(400);
        expect((await above.json()).errors.join(' ')).toContain('<= 209715200');
    });

    test('validate-connection reports the extractor as available (no credentials to check)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await enableForUser(request, user.access_token);
        const res = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/validate-connection`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // isAvailable() is unconditionally true — the facade is "connectable" even
        // though the CLI binary is only invoked lazily during a real extraction.
        expect(body.success).toBe(true);
        expect(typeof body.message).toBe('string');
    });

    test('connection-status is an empty probe object for a credential-free extractor', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}/connection-status`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // A credential-free extractor has nothing to probe → the endpoint
        // returns a bare empty status object `{}` (never a 500, no nested key).
        expect(typeof body).toBe('object');
        expect(body).toEqual({});
    });
});

test.describe('OfficeCLI extractor — work-scoped enablement', () => {
    test('enabling for a work before the user-level enable → 400 "must be enabled at user level first"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `OfficeCLI WS ${stamp()}`,
        });
        expect(workId).toMatch(UUID_RE);
        const res = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: {},
            },
        );
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toContain('must be enabled at user level first');
    });

    test('full flow: user-enable → work-enable(activeCapability) → work list shows it → disable-for-work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `OfficeCLI Flow ${stamp()}`,
        });
        await enableForUser(request, user.access_token);

        const enable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: { activeCapability: 'content-extractor' },
            },
        );
        expect(enable.status(), `work-enable body=${await enable.text().catch(() => '')}`).toBe(
            200,
        );
        const wp = await enable.json();
        expect(wp.workEnabled).toBe(true);
        expect(wp.enabled).toBe(true);
        expect(wp.activeCapabilities).toContain('content-extractor');
        expect(typeof wp.workPluginId).toBe('string');

        const list = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        const listBody = await list.json();
        expect(listBody).toHaveProperty('capabilityProviders');
        const entry = listBody.plugins.find((p: { id: string }) => p.id === PLUGIN_ID);
        expect(entry, 'officecli should appear in the work plugin list').toBeTruthy();
        expect(entry.workEnabled).toBe(true);
        expect(entry.activeCapabilities).toContain('content-extractor');

        const disable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/disable`,
            {
                headers: authedHeaders(user.access_token),
            },
        );
        expect(disable.status()).toBe(200);
        expect((await disable.json()).workEnabled).toBe(false);
    });

    test('the /capability route refuses a supplementary plugin (400) even for a capability it owns', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `OfficeCLI Cap ${stamp()}`,
        });
        await enableForUser(request, user.access_token);
        await request.post(`${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/enable`, {
            headers: authedHeaders(user.access_token),
            data: { activeCapability: 'content-extractor' },
        });

        // content-extractor IS in its manifest, but it is supplementary → refused.
        const owned = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/capability`,
            {
                headers: authedHeaders(user.access_token),
                data: { capability: 'content-extractor' },
            },
        );
        expect(owned.status()).toBe(400);
        expect((await owned.json()).message).toContain('supplementary plugin');
    });

    test('the /capability route rejects a capability the plugin does not provide (400 "does not provide")', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `OfficeCLI Cap2 ${stamp()}`,
        });
        await enableForUser(request, user.access_token);
        await request.post(`${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/enable`, {
            headers: authedHeaders(user.access_token),
            data: { activeCapability: 'content-extractor' },
        });

        // `search` is checked BEFORE the supplementary guard → "does not provide".
        const notOwned = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/capability`,
            {
                headers: authedHeaders(user.access_token),
                data: { capability: 'search' },
            },
        );
        expect(notOwned.status()).toBe(400);
        expect((await notOwned.json()).message).toContain('does not provide capability');
    });

    test('the /capability route validates the body — a missing capability → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `OfficeCLI Cap3 ${stamp()}`,
        });
        const res = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/capability`,
            {
                headers: authedHeaders(user.access_token),
                data: {},
            },
        );
        expect(res.status()).toBe(400);
    });

    test('cross-user isolation: a non-owner is walled off from the work plugin surface → 403', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `OfficeCLI Private ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        const list = await request.get(`${API_BASE}/api/works/${workId}/plugins`, { headers: iH });
        expect(list.status()).toBe(403);

        const enable = await request.post(
            `${API_BASE}/api/works/${workId}/plugins/${PLUGIN_ID}/enable`,
            {
                headers: iH,
                data: {},
            },
        );
        expect(enable.status()).toBe(403);
    });

    test('unknown-but-valid-uuid work → 404; a malformed work id → 404 (guard resolves before any pipe)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await enableForUser(request, user.access_token);

        const unknown = await request.post(
            `${API_BASE}/api/works/${UNKNOWN_UUID}/plugins/${PLUGIN_ID}/enable`,
            {
                headers: authedHeaders(user.access_token),
                data: {},
            },
        );
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toContain('not found');

        const malformed = await request.get(`${API_BASE}/api/works/not-a-uuid/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        expect(malformed.status()).toBe(404);
    });
});

test.describe('OfficeCLI extractor — unknown-id & auth gating', () => {
    test('unknown plugin id → 404 across get / enable / validate-connection', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const bogus = 'does-not-exist-xyz';

        const get = await request.get(`${API_BASE}/api/plugins/${bogus}`, { headers: H });
        expect(get.status()).toBe(404);
        expect((await get.json()).message).toContain(bogus);

        const enable = await request.post(`${API_BASE}/api/plugins/${bogus}/enable`, {
            headers: H,
            data: {},
        });
        expect(enable.status()).toBe(404);

        const validate = await request.post(
            `${API_BASE}/api/plugins/${bogus}/validate-connection`,
            { headers: H },
        );
        expect(validate.status()).toBe(404);

        const install = await request.get(`${API_BASE}/api/plugins/${bogus}/install-status`, {
            headers: H,
        });
        expect(install.status()).toBe(404);
    });

    test('every route is auth-gated — no bearer → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/plugins`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/plugins/catalog`)).status()).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/enable`, { data: {} })
            ).status(),
        ).toBe(401);
        expect(
            (
                await request.post(
                    `${API_BASE}/api/works/${UNKNOWN_UUID}/plugins/${PLUGIN_ID}/capability`,
                    {
                        data: { capability: 'content-extractor' },
                    },
                )
            ).status(),
        ).toBe(401);
    });
});
