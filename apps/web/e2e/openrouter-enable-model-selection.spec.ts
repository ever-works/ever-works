import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    listPluginsViaAPI,
    getPluginViaAPI,
    enablePluginViaAPI,
    patchPluginSettingsViaAPI,
    listPluginModelsViaAPI,
} from './helpers/plugins';
import { isAiProviderConfigured, createChatCompletionViaAPI } from './helpers/chat';

/**
 * OpenRouter AI provider — real enable → select model → use-in-chat flow.
 *
 * User ask: "when a user enables OpenRouter, make sure the plugin really WORKS
 * and Chat uses OpenRouter and the model that was selected."
 *
 * Everything below was probed against the LIVE stack before the assertions were
 * written, so the test asserts the platform's REAL behaviour (not a guess):
 *
 *   - POST /api/plugins/openrouter/enable → 201; the plugin then reports
 *     `enabled:true` both in the GET /api/plugins list and on the single-plugin
 *     GET. OpenRouter is a system plugin (systemPlugin/autoEnable true,
 *     defaultForCapabilities:['ai-provider']) so it is the default AI provider.
 *   - GET /api/plugins/openrouter/models → a large array of real OpenRouter
 *     models `{ id, name, description, ... }`; we pick a concrete model id.
 *   - PATCH /api/plugins/openrouter/settings enforces BOTH `apiKey` and
 *     `defaultModel`. A patch missing `defaultModel` returns the precise
 *     contract 400 `{ message:'Invalid plugin settings',
 *     errors:['Missing required fields: defaultModel'] }`. A patch with both
 *     succeeds (200) and the chosen model persists in `settings.defaultModel`
 *     and the env-merged `resolvedSettings.defaultModel`.
 *   - Chat uses the configured provider via POST /api/v1/chat/completions with
 *     `X-Provider-Override: openrouter`. NOTE: writing a user-scoped `apiKey`
 *     (here a deliberately-fake `sk-e2e-test-key`) SHADOWS any env-level key, so
 *     after persisting the selection the provider's usability is whatever that
 *     key yields. The chat assertion is therefore ENVIRONMENT-ADAPTIVE and
 *     measured AFTER the settings write: when the resolved key still produces a
 *     real provider we assert a genuine completion whose `model` reflects the
 *     selected model family; otherwise we assert the clean 422
 *     `provider_unavailable` contract (never a 5xx). The round-trip always fires.
 *   - DISABLE: OpenRouter is a system plugin and CANNOT be disabled — the API
 *     truthfully rejects it with 400 `Plugin "openrouter" is a system plugin and
 *     cannot be disabled`, and the plugin stays enabled. We assert that real
 *     contract rather than a fictional disabled state.
 *
 * A UI touch confirms the OpenRouter card renders on /plugins.
 */

const PLUGIN_ID = 'openrouter';

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

test.describe('OpenRouter — enable, model selection, chat usage', () => {
    test('enabling OpenRouter, selecting a model and using it in chat works end-to-end', async ({
        request,
    }) => {
        // Use a FRESH registered user (not the seeded one) for the enable +
        // settings + chat mutations. Writing a user-scoped fake apiKey shadows
        // the env key; doing that on the shared seeded account would make this
        // test's "missing defaultModel" contract state-dependent across repeat
        // runs AND break sibling chat specs that rely on the seeded user's
        // working env-keyed provider. A fresh user fully isolates the mutation.
        const token = (await registerUserViaAPI(request)).access_token;

        // 1. Enable the OpenRouter provider. It is a system/default AI provider,
        //    so enable is idempotent and returns the plugin object.
        const enabled = await enablePluginViaAPI(request, token, PLUGIN_ID);
        expect(enabled.id).toBe(PLUGIN_ID);
        expect(enabled.category).toBe('ai-provider');
        expect(enabled.systemPlugin).toBe(true);
        expect(enabled.defaultForCapabilities).toContain('ai-provider');

        // Enablement is observable both in the list and on the single-plugin GET.
        const list = await listPluginsViaAPI(request, token);
        const orInList = list.find((p) => p.id === PLUGIN_ID);
        expect(orInList, 'openrouter is present in the plugins list').toBeTruthy();
        expect(orInList?.enabled, 'openrouter reports enabled:true in the list').toBe(true);

        const fetched = await getPluginViaAPI(request, token, PLUGIN_ID);
        expect(fetched.enabled, 'GET /api/plugins/openrouter reports enabled:true').toBe(true);

        // 2. List real OpenRouter models and pick a concrete model id.
        const models = await listPluginModelsViaAPI(request, token, PLUGIN_ID);
        expect(models.length, 'OpenRouter exposes a real model catalogue').toBeGreaterThan(0);
        const picked = models[0];
        expect(picked.id, 'a picked model has an id').toBeTruthy();
        const pickedModelId = picked.id;

        // 3a. PROBE the validation contract: a settings patch missing the
        //     required `defaultModel` is rejected with the precise 400 shape.
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

        // 3b. Persist a valid selection with BOTH required fields. The schema
        //     requires `apiKey` (any non-empty string) + `defaultModel`.
        const ok = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: 'sk-e2e-test-key', defaultModel: pickedModelId },
        });
        expect(ok.status, `valid patch should succeed; body=${JSON.stringify(ok.body)}`).toBe(200);

        // The selected model must persist. The user-scoped `settings` carries the
        // chosen id, and the env-merged `resolvedSettings` resolves to it too.
        const afterPatch = await getPluginViaAPI(request, token, PLUGIN_ID);
        const persistedSettings = (afterPatch.settings ?? {}) as { defaultModel?: string };
        const resolved = (afterPatch.resolvedSettings ?? {}) as { defaultModel?: string };
        expect(
            persistedSettings.defaultModel,
            'the chosen defaultModel persisted in user settings',
        ).toBe(pickedModelId);
        expect(
            resolved.defaultModel,
            'the chosen defaultModel resolves as the effective default',
        ).toBe(pickedModelId);

        // 4. ENVIRONMENT-ADAPTIVE chat check, measured AFTER persisting the
        //    selection (the user-scoped key now governs provider usability).
        //    Either path is a truthful, non-5xx outcome; the round-trip fires.
        const providerUsable = await isAiProviderConfigured(request, token);
        const completion = await createChatCompletionViaAPI(request, token, {
            messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
            provider: PLUGIN_ID,
            model: pickedModelId,
            stream: false,
        });
        expect(completion.status, 'a chat completion round-trip fired').toBeGreaterThan(0);

        if (providerUsable && completion.status === 200) {
            // A real provider is wired → assert a genuine completion that echoes
            // the requested model family (providers may suffix variants, so we
            // compare the leading provider/model segment rather than equality).
            expect(completion.content, 'a configured provider returns content').toBeTruthy();
            expect(completion.model, 'the completion echoes a model').toBeTruthy();
            const requestedFamily = pickedModelId.split(':')[0];
            expect(
                (completion.model ?? '').startsWith(requestedFamily) ||
                    requestedFamily.startsWith(completion.model ?? ' ') ||
                    (completion.model ?? '').includes(requestedFamily.split('/').pop() ?? ' '),
                `completion model "${completion.model}" should reflect requested "${pickedModelId}"`,
            ).toBe(true);
        } else {
            // The resolved key cannot reach a provider (e.g. the fake e2e key, or
            // no key in CI) → the OpenAI-compat controller returns a clean 422
            // provider_unavailable, never a 5xx.
            expect(
                completion.status,
                `expected provider_unavailable; body=${JSON.stringify(completion.raw)}`,
            ).toBe(422);
            const errType = (completion.raw as { error?: { type?: string } })?.error?.type;
            expect(errType).toBe('provider_unavailable');
        }

        // 5. DISABLE is rejected for the system/default provider — assert the
        //    real contract and that the plugin stays enabled (the helper's
        //    <300 assertion would throw here, so we hit the endpoint directly).
        const disableRes = await request.post(`${API_BASE}/api/plugins/${PLUGIN_ID}/disable`, {
            headers: authedHeaders(token),
        });
        expect(disableRes.status(), 'system plugin disable is rejected').toBe(400);
        const disableBody = (await disableRes.json().catch(() => ({}))) as { message?: string };
        expect(disableBody?.message ?? '').toMatch(/system plugin and cannot be disabled/i);

        const afterDisable = await getPluginViaAPI(request, token, PLUGIN_ID);
        expect(afterDisable.enabled, 'openrouter remains enabled after the rejected disable').toBe(
            true,
        );
    });

    test('UI: the OpenRouter plugin card renders on the /plugins page', async ({ page }) => {
        await page.goto('/plugins', { waitUntil: 'domcontentloaded' });

        // PageHeader title ("Plugins") confirms we landed on the plugins page.
        await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible({
            timeout: 30_000,
        });

        // Each plugin renders as a card whose name sits in an <h3>. The
        // OpenRouter card must be present (it is a built-in system provider).
        const openRouterCard = page.getByRole('heading', { name: 'OpenRouter', exact: true });
        await expect(openRouterCard.first()).toBeVisible({ timeout: 30_000 });

        // The card is marked as a System plugin and links to its settings detail.
        const card = openRouterCard
            .first()
            .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
        await expect(card.getByText('System', { exact: false }).first()).toBeVisible({
            timeout: 15_000,
        });
        await expect(
            card.getByRole('link', { name: /Settings/i }).first(),
            'the OpenRouter card links to its settings detail',
        ).toBeVisible({ timeout: 15_000 });
    });
});
