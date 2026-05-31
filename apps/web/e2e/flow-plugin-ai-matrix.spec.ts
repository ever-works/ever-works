import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    listPluginsViaAPI,
    getPluginViaAPI,
    enablePluginViaAPI,
    patchPluginSettingsViaAPI,
    listPluginModelsViaAPI,
} from './helpers/plugins';
import { isAiProviderConfigured, createChatCompletionViaAPI } from './helpers/chat';

/**
 * Plugin AI-provider matrix — real, multi-step orchestration of the OpenRouter
 * AI-gateway plugin: catalogue → settings persistence → system-plugin contract
 * → provider-override completion. Every shape below was PROBED against the LIVE
 * stack (http://127.0.0.1:3100) before the assertions were written, so this
 * file asserts the platform's REAL behaviour, not a guess.
 *
 * PROBED CONTRACTS (live):
 *   - GET  /api/plugins/openrouter
 *       → { id:'openrouter', category:'ai-provider', systemPlugin:true,
 *           autoEnable:true, defaultForCapabilities:['ai-provider'],
 *           visibility:'public', enabled:true,
 *           settingsSchema:{ required:['apiKey','defaultModel'],
 *             properties:{ apiKey, defaultModel, simpleModel, mediumModel,
 *             complexModel } },
 *           settings:{…masked apiKey…}, resolvedSettings:{ apiKey:'••••••••',
 *           defaultModel, simpleModel, mediumModel, complexModel } }.
 *     OpenRouter is the system/default AI provider and reports enabled:true
 *     out of the box (autoEnable); POST /enable is idempotent (returns 200 +
 *     the plugin object).
 *   - GET  /api/plugins/openrouter/models → a large (~343) array of real
 *     OpenRouter models `{ id, name, description, capabilities, …cost }`.
 *   - PATCH /api/plugins/openrouter/settings enforces BOTH required fields.
 *       missing defaultModel → 400 { message:'Invalid plugin settings',
 *         errors:['Missing required fields: defaultModel'] }.
 *       both present → 200; the chosen model then persists in BOTH
 *       `settings.defaultModel` and the env-merged `resolvedSettings.defaultModel`.
 *       NB: `settings.apiKey` is returned MASKED (e.g. "sk-e••••-key"), so we
 *       only assert the (unmasked) `defaultModel` persists, never the raw key.
 *   - POST /api/plugins/openrouter/disable → 400
 *       { message:'Plugin "openrouter" is a system plugin and cannot be
 *         disabled', error:'Bad Request', statusCode:400 }; it stays enabled.
 *   - POST /api/v1/chat/completions (Bearer + X-Provider-Override header; the
 *     `provider` BODY field is rejected 400 "property provider should not
 *     exist", so override MUST travel in the header — the chat helper already
 *     does this). With a working provider key → 200 OpenAI-shaped completion
 *     whose `model` echoes the requested model id EXACTLY (probed:
 *     google/gemini-3.1-flash-lite → model:"google/gemini-3.1-flash-lite";
 *     openai/gpt-4o-mini → "openai/gpt-4o-mini"); with no usable key → clean
 *     422 { error:{ type:'provider_unavailable' } }, never a 5xx.
 *
 * ISOLATION: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user) because writing a user-scoped fake `apiKey` SHADOWS
 * the env key — doing that on the seeded account would break sibling chat
 * specs. Flow 3 (which needs a real completion when the env provider is wired)
 * deliberately uses a fresh user that has NOT written a fake key, so it can
 * still resolve the env-level key when one is present.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */

const PLUGIN_ID = 'openrouter';

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

/** Pick a deterministic, well-known model id from the live catalogue. */
function pickModelId(models: Array<{ id: string; name?: string }>): string {
    // Prefer the canonical cheap default if present; otherwise the first id.
    const preferred = models.find((m) => m.id === 'openai/gpt-4o-mini');
    return (preferred ?? models[0]).id;
}

test.describe('Plugin AI-provider matrix — OpenRouter', () => {
    test('Flow 1: enable OpenRouter, read model catalogue, persist {apiKey, defaultModel}, assert it sticks in settings + resolvedSettings', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // --- Enable the system/default AI provider (idempotent) -----------
        const enabled = await enablePluginViaAPI(request, token, PLUGIN_ID);
        expect(enabled.id, 'enable echoes the plugin id').toBe(PLUGIN_ID);
        expect(enabled.category, 'OpenRouter is an ai-provider').toBe('ai-provider');
        expect(enabled.systemPlugin, 'OpenRouter is a system plugin').toBe(true);
        expect(
            enabled.defaultForCapabilities,
            'OpenRouter is the default for the ai-provider capability',
        ).toContain('ai-provider');

        // Enablement is observable both in the list and on the single-plugin GET.
        const list = await listPluginsViaAPI(request, token);
        const inList = list.find((p) => p.id === PLUGIN_ID);
        expect(inList, 'openrouter is present in GET /api/plugins').toBeTruthy();
        expect(inList?.enabled, 'openrouter reports enabled:true in the list').toBe(true);

        const fetched = await getPluginViaAPI(request, token, PLUGIN_ID);
        expect(fetched.enabled, 'GET /api/plugins/openrouter reports enabled:true').toBe(true);

        // The settings schema requires BOTH apiKey and defaultModel — confirm
        // the contract we are about to satisfy is real.
        const schema = (fetched.settingsSchema ?? {}) as { required?: string[] };
        expect(
            schema.required ?? [],
            'the openrouter schema requires apiKey + defaultModel',
        ).toEqual(expect.arrayContaining(['apiKey', 'defaultModel']));

        // --- Real model catalogue -----------------------------------------
        const models = await listPluginModelsViaAPI(request, token, PLUGIN_ID);
        expect(models.length, 'OpenRouter exposes a real model catalogue').toBeGreaterThan(0);
        const pickedModelId = pickModelId(models);
        expect(pickedModelId, 'a concrete model id was picked').toBeTruthy();
        // Each catalogue entry is a real model object with an id (sanity-check
        // the first few rather than asserting the full 300+ list).
        for (const m of models.slice(0, 5)) {
            expect(m.id, 'every catalogue model has an id').toBeTruthy();
        }

        // --- Reject a settings patch missing the required defaultModel -----
        const invalid = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: 'sk-e2e-test-key' },
        });
        expect(invalid.ok, 'patch missing defaultModel is rejected').toBe(false);
        expect(invalid.status, `unexpected status; body=${JSON.stringify(invalid.body)}`).toBe(400);
        const invalidBody = invalid.body as { message?: string; errors?: string[] };
        expect(invalidBody?.message).toContain('Invalid plugin settings');
        expect(
            (invalidBody?.errors ?? []).join(' '),
            'the 400 names the missing required field',
        ).toContain('defaultModel');

        // --- Persist a valid selection with BOTH required fields ----------
        const ok = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: 'sk-e2e-test-key', defaultModel: pickedModelId },
        });
        expect(ok.status, `valid patch should succeed; body=${JSON.stringify(ok.body)}`).toBe(200);

        // The chosen model must persist in BOTH the user-scoped `settings` and
        // the env-merged `resolvedSettings`. (We poll because the in-memory
        // store settles the write asynchronously under load.) We assert ONLY
        // the defaultModel — `settings.apiKey` comes back masked, so the raw
        // key is intentionally not asserted.
        await expect
            .poll(
                async () => {
                    const after = await getPluginViaAPI(request, token, PLUGIN_ID);
                    const s = (after.settings ?? {}) as { defaultModel?: string };
                    return s.defaultModel;
                },
                {
                    timeout: 15_000,
                    message: 'the chosen defaultModel should persist in user settings',
                },
            )
            .toBe(pickedModelId);

        const afterPatch = await getPluginViaAPI(request, token, PLUGIN_ID);
        const resolved = (afterPatch.resolvedSettings ?? {}) as { defaultModel?: string };
        expect(
            resolved.defaultModel,
            'the chosen defaultModel resolves as the effective default',
        ).toBe(pickedModelId);
    });

    test('Flow 2: system-plugin disable contract — POST /disable is rejected 400 and OpenRouter stays enabled', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Ensure it is enabled first (system/default provider — enable is a
        // no-op-ish idempotent confirm).
        await enablePluginViaAPI(request, token, PLUGIN_ID);
        const before = await getPluginViaAPI(request, token, PLUGIN_ID);
        expect(before.enabled, 'baseline: openrouter is enabled').toBe(true);
        expect(before.systemPlugin, 'baseline: openrouter is a system plugin').toBe(true);

        // The disable helper asserts <300, which would throw on the expected
        // 400 — so we hit the endpoint directly to inspect the real contract.
        const disableRes = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/disable`, {
            headers: authedHeaders(token),
        });
        expect(disableRes.status(), 'system plugin disable is rejected with 400').toBe(400);
        const disableBody = (await disableRes.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
            statusCode?: number;
        };
        // Exact message probed live: 'Plugin "openrouter" is a system plugin and cannot be disabled'.
        expect(disableBody?.message ?? '', 'the 400 explains it is a system plugin').toMatch(
            /system plugin and cannot be disabled/i,
        );
        expect(disableBody?.message ?? '', 'the 400 names the offending plugin').toContain(
            PLUGIN_ID,
        );

        // The plugin must stay enabled — the rejected disable is a no-op.
        const after = await getPluginViaAPI(request, token, PLUGIN_ID);
        expect(after.enabled, 'openrouter remains enabled after the rejected disable').toBe(true);

        // And it is still listed enabled in the catalogue (no silent drift).
        const list = await listPluginsViaAPI(request, token);
        expect(
            list.find((p) => p.id === PLUGIN_ID)?.enabled,
            'openrouter still reports enabled:true in the list',
        ).toBe(true);
    });

    test('Flow 3: provider-override chat (adaptive) — completion model reflects the chosen family when configured, else clean 422 provider_unavailable', async ({
        request,
    }) => {
        // Fresh user with NO fake-key PATCH: when the env provider key is wired
        // (local dev ships PLUGIN_OPENROUTER_API_KEY) the resolved key is the
        // real env key → a genuine completion; in CI (no key) → the truthful
        // provider_unavailable contract. Either path is asserted truthfully and
        // the round-trip always fires.
        const token = await freshToken(request);
        await enablePluginViaAPI(request, token, PLUGIN_ID);

        // Choose a concrete model from the live catalogue to drive the override.
        const models = await listPluginModelsViaAPI(request, token, PLUGIN_ID);
        expect(models.length, 'a model catalogue is available to pick from').toBeGreaterThan(0);
        const pickedModelId = pickModelId(models);

        const providerUsable = await isAiProviderConfigured(request, token);

        const completion = await createChatCompletionViaAPI(request, token, {
            messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
            provider: PLUGIN_ID, // travels as the X-Provider-Override header (never a body field)
            model: pickedModelId,
            stream: false,
        });
        expect(completion.status, 'a chat completion round-trip fired').toBeGreaterThan(0);

        if (providerUsable && completion.status === 200) {
            // A real provider is wired → assert a genuine OpenAI-shaped
            // completion whose `model` reflects the requested model family. The
            // controller echoes the requested id, but providers may suffix
            // variants, so we compare the family segment rather than equality.
            expect(completion.content, 'a configured provider returns content').toBeTruthy();
            expect(completion.model, 'the completion echoes a model').toBeTruthy();
            const requestedFamily = pickedModelId.split(':')[0];
            const returned = completion.model ?? '';
            expect(
                returned.startsWith(requestedFamily) ||
                    requestedFamily.startsWith(returned) ||
                    returned.includes(requestedFamily.split('/').pop() ?? ' '),
                `completion model "${returned}" should reflect requested "${pickedModelId}"`,
            ).toBe(true);
        } else {
            // No usable provider key → the OpenAI-compat controller maps the
            // upstream failure to a clean 422 provider_unavailable, never a 5xx.
            expect(
                completion.status,
                `expected provider_unavailable; body=${JSON.stringify(completion.raw)}`,
            ).toBe(422);
            const errType = (completion.raw as { error?: { type?: string } })?.error?.type;
            expect(errType, 'the 422 envelope is the provider_unavailable contract').toBe(
                'provider_unavailable',
            );
        }
    });
});
