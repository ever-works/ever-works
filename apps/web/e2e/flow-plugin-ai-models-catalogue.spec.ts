import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    getPluginViaAPI,
    enablePluginViaAPI,
    patchPluginSettingsViaAPI,
    listPluginModelsViaAPI,
} from './helpers/plugins';
import { isAiProviderConfigured, createChatCompletionViaAPI } from './helpers/chat';

/**
 * Plugin AI MODEL CATALOGUE — GET /api/plugins/:id/models per provider, the
 * relationship between the catalogue and `defaultModel` selection, the model
 * actually used reflected back in a completion (adaptive), unknown-model
 * handling, and the catalogue contract for disabled / non-AI / unknown plugins.
 *
 * Every shape, status and message below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-06-01 before the assertions were written, so
 * this file asserts the platform's REAL behaviour — never a guess.
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - GET /api/plugins/openrouter/models → 200, a large array (~343) of REAL
 *     OpenRouter models, each `{ id, name, description, capabilities:{
 *       supportsStructuredOutput, supportsStreaming, supportsToolCalling,
 *       supportsVision, maxContextLength }, inputCostPer1k?, outputCostPer1k? }`.
 *     Well-known ids present: openai/gpt-4o-mini, openai/gpt-4o,
 *     anthropic/claude-3.5-haiku, google/gemini-3.1-flash-lite.
 *     KEY-INDEPENDENT: openrouter's `listModels` fetches the PUBLIC catalogue, so
 *     the SAME 343-model list is returned for a fresh user, AND even after the
 *     user writes a deliberately-fake `apiKey` that SHADOWS the env key (the
 *     catalogue does not depend on credentials — completions do).
 *     (impl: PluginOperationsService.listPluginModels → AiFacadeService
 *      .getAvailableModels → plugin.listModels; on ANY error it is caught and
 *      returns [] — never a 5xx.)
 *   - GET /api/plugins/anthropic/models (an AI provider that is NOT the system
 *     default) → 200 `[]` for a fresh/unconfigured user, AND still `[]` once
 *     enabled with a FAKE key (the real Anthropic catalogue can't be fetched, the
 *     error is caught → []). Stays `[]` across enable → disable.
 *   - GET /api/plugins/github/models, /api/plugins/tavily/models (non-AI plugins
 *     with no `listModels`) → 200 `[]`.
 *   - GET /api/plugins/no-such-plugin/models → 404
 *     { message:'Plugin "<id>" not found', error:'Not Found', statusCode:404 }.
 *   - GET /api/plugins/openrouter/models WITHOUT a bearer → 401 Unauthorized.
 *   - PATCH /api/plugins/openrouter/settings { apiKey, defaultModel } — the
 *     required-field validation checks PRESENCE only, NOT catalogue membership:
 *     a NON-catalogue `defaultModel` is accepted (200) and persists in
 *     `settings.defaultModel` + the env-merged `resolvedSettings.defaultModel`.
 *   - POST /api/v1/chat/completions (Bearer, @HttpCode(200)):
 *       • a VALID catalogue model in the body is echoed back EXACTLY in the
 *         response `model` (probed: model:"openai/gpt-4o" → "openai/gpt-4o",
 *         "openai/gpt-4o-mini" → "openai/gpt-4o-mini") when the env key is wired.
 *       • an UNKNOWN model id → clean 422 { error:{ type:'provider_unavailable',
 *         message:'400 <id> is not a valid model ID' } } — NEVER a 5xx.
 *       • after the user writes a fake `apiKey` (shadowing env) the SAME default
 *         request → clean 422 { error:{ type:'provider_unavailable',
 *         message:'401 Missing Authentication header …' } }.
 *
 * ENVIRONMENT-ADAPTIVE: completions need a real provider key. Locally the stack
 * ships PLUGIN_OPENROUTER_API_KEY so the resolved (env) key produces a real 200
 * whose `model` echoes the requested model; in CI (no key) the SAME round-trip
 * is the truthful 422 provider_unavailable. Each completion flow branches on
 * `isAiProviderConfigured()` / the 200-vs-422 status so it asserts the REAL
 * outcome for whatever env it runs in, and ALWAYS fires the round-trip. The
 * CATALOGUE assertions (count, ids, shape, []-for-disabled, 404-for-unknown,
 * 401-unauth, presence/persistence of the selected model) hold in BOTH envs
 * because the openrouter catalogue is the public, key-independent model list.
 *
 * ISOLATION: every mutating flow runs on its OWN FRESH registerUserViaAPI() user
 * — never the shared seeded user — because writing a user-scoped fake `apiKey`
 * SHADOWS the env key and would break sibling chat specs on the seeded account.
 * Unique Date.now()-suffixed emails; tolerant assertions (toContain /
 * toBeGreaterThan), never exact catalogue counts. Filename uses the safe `flow-`
 * prefix (not matched by the no-auth testIgnore regex in playwright.config.ts)
 * and is fully API-orchestrated, so it does not contend on the shared UI/stack.
 *
 * GAP vs existing specs: flow-plugin-ai-matrix / openrouter-enable-model-selection
 * persist {apiKey,defaultModel} and assert a single override completion;
 * flow-plugin-ai-provider-resolution drives WHICH provider is resolved. NONE of
 * them drill the MODEL CATALOGUE endpoint itself across provider categories /
 * enablement states, the key-independence of the catalogue, catalogue↔selection
 * membership, the unknown-model vs valid-model completion distinction, or the
 * non-catalogue-defaultModel-still-persists behaviour. This file owns that.
 */

const OPENROUTER = 'openrouter';
const ANTHROPIC = 'anthropic';
const AI_CAPABILITY = 'ai-provider';
const COMPLETIONS = `${API_BASE}/api/v1/chat/completions`;

/**
 * Canonical openrouter ids the PLATFORM pins as defaults (probed present + used
 * as the resolved default model across the codebase) — these must be present.
 */
const CANONICAL_MODELS = ['openai/gpt-4o-mini', 'openai/gpt-4o'];

/**
 * Additional well-known ids probed present in the live list. The catalogue
 * tracks upstream OpenRouter and drifts over time, so we assert the MAJORITY of
 * these are present rather than every single one (resilient to upstream churn).
 */
const WELL_KNOWN_MODELS = [
    ...CANONICAL_MODELS,
    'anthropic/claude-3.5-haiku',
    'google/gemini-3.1-flash-lite',
];

interface CatalogueModel {
    id: string;
    name?: string;
    description?: string;
    capabilities?: Record<string, unknown>;
    inputCostPer1k?: number;
    outputCostPer1k?: number;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-models-cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

/** Raw GET /api/plugins/:id/models so we can inspect status + body (the helper swallows non-2xx → []). */
async function rawModels(
    request: APIRequestContext,
    token: string | null,
    pluginId: string,
): Promise<{ status: number; body: unknown }> {
    const res = await request.get(`${API_BASE}/api/plugins/${pluginId}/models`, {
        headers: token ? authedHeaders(token) : {},
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Raw completion probe that parses BOTH the success and provider_unavailable envelopes. */
async function complete(
    request: APIRequestContext,
    token: string,
    opts: { model?: string; provider?: string; content?: string } = {},
): Promise<{
    status: number;
    model: string | null;
    content: string | null;
    errorType: string | null;
    errorMessage: string | null;
    raw: unknown;
}> {
    const headers: Record<string, string> = authedHeaders(token);
    if (opts.provider) headers['X-Provider-Override'] = opts.provider;
    const data: Record<string, unknown> = {
        messages: [{ role: 'user', content: opts.content ?? 'Reply with exactly the word PONG.' }],
        stream: false,
    };
    if (opts.model) data.model = opts.model;

    const res = await request.post(COMPLETIONS, { headers, data, timeout: 60_000 });
    const raw = (await res.json().catch(() => null)) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        error?: { type?: string; message?: string };
    } | null;

    return {
        status: res.status(),
        model: raw?.model ?? null,
        content: raw?.choices?.[0]?.message?.content ?? null,
        errorType: raw?.error?.type ?? null,
        errorMessage: raw?.error?.message ?? null,
        raw,
    };
}

test.describe('Plugin AI model catalogue — GET /api/plugins/:id/models', () => {
    test('Flow 1: the OpenRouter catalogue is a real, richly-shaped model list containing well-known model ids', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const { status, body } = await rawModels(request, token, OPENROUTER);
        expect(status, 'openrouter models resolves 200').toBe(200);
        expect(Array.isArray(body), 'the catalogue is an array').toBe(true);

        const models = body as CatalogueModel[];
        // The live catalogue is large (~343); assert a generous floor rather than
        // an exact count (it tracks upstream OpenRouter and drifts over time).
        expect(models.length, 'OpenRouter exposes a large real model catalogue').toBeGreaterThan(
            50,
        );

        // Every entry is a real model object with a non-empty id + name (sanity-check
        // a window rather than all 300+).
        for (const m of models.slice(0, 10)) {
            expect(m.id, 'every catalogue model has an id').toBeTruthy();
            expect(typeof m.id, 'the id is a string').toBe('string');
            expect(m.name, 'every catalogue model has a name').toBeTruthy();
        }

        // Each model carries a capabilities envelope with the probed boolean/numeric
        // flags. Find one that has it (the very first row may vary upstream).
        const withCaps = models.find((m) => m.capabilities);
        expect(withCaps, 'at least one model exposes a capabilities envelope').toBeTruthy();
        const caps = (withCaps as CatalogueModel).capabilities as Record<string, unknown>;
        expect(typeof caps.maxContextLength, 'capabilities.maxContextLength is a number').toBe(
            'number',
        );
        expect(typeof caps.supportsStreaming, 'capabilities.supportsStreaming is a boolean').toBe(
            'boolean',
        );

        // The canonical default models the platform pins on MUST be present.
        const ids = new Set(models.map((m) => m.id));
        for (const canonical of CANONICAL_MODELS) {
            expect(ids.has(canonical), `catalogue contains canonical model "${canonical}"`).toBe(
                true,
            );
        }
        // The broader well-known set is asserted as a MAJORITY (resilient to
        // upstream OpenRouter catalogue churn renaming a non-canonical id).
        const knownPresent = WELL_KNOWN_MODELS.filter((m) => ids.has(m));
        expect(
            knownPresent.length,
            `most well-known models present (${knownPresent.length}/${WELL_KNOWN_MODELS.length})`,
        ).toBeGreaterThanOrEqual(Math.ceil(WELL_KNOWN_MODELS.length / 2));
    });

    test('Flow 2: the catalogue is KEY-INDEPENDENT — the full openrouter list survives a fake apiKey that shadows the env key', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Baseline: a fresh, unconfigured user already sees the full public catalogue
        // (no credentials required to LIST openrouter models).
        const before = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(before.length, 'fresh user sees the full openrouter catalogue').toBeGreaterThan(50);
        const beforeIds = new Set(before.map((m) => m.id));

        // Persist a deliberately-FAKE apiKey + a known model. This SHADOWS the env
        // key (so completions would now fail) — but the catalogue is the public
        // model list and must be UNAFFECTED.
        const picked = 'openai/gpt-4o-mini';
        expect(beforeIds.has(picked), 'the model we select is a live catalogue member').toBe(true);
        const patch = await patchPluginSettingsViaAPI(request, token, OPENROUTER, {
            settings: { apiKey: 'sk-or-e2e-fake-shadow-key', defaultModel: picked },
        });
        expect(patch.status, `settings patch persists; body=${JSON.stringify(patch.body)}`).toBe(
            200,
        );

        // After the fake-key shadow the catalogue is still the same large list.
        const after = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(
            after.length,
            'the catalogue is unchanged by user credentials (it is the public list)',
        ).toBeGreaterThan(50);
        const afterIds = new Set(after.map((m) => m.id));
        for (const canonical of CANONICAL_MODELS) {
            expect(
                afterIds.has(canonical),
                `"${canonical}" still present after the fake-key write`,
            ).toBe(true);
        }

        // PROOF the fake key really shadows the provider: a default completion now
        // fails cleanly on the missing/invalid auth (422 provider_unavailable, NEVER
        // a 5xx) even though the catalogue read above succeeded. This is the
        // catalogue-vs-credentials separation in one flow.
        const res = await complete(request, token, { provider: OPENROUTER });
        expect(
            res.status,
            `shadowed-key completion is well-behaved; raw=${JSON.stringify(res.raw)}`,
        ).toBe(422);
        expect(res.errorType, 'clean provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            (res.errorMessage ?? '').toLowerCase(),
            'the failure is an upstream auth error (the fake key shadowed the env key)',
        ).toMatch(/401|auth|key|invalid/);
    });

    test('Flow 3: selecting a catalogue model persists it AND the model used is reflected in the completion (adaptive)', async ({
        request,
    }) => {
        // Fresh user with NO fake-key write up to the completion: when the env
        // provider key is wired (local) the env key resolves and the completion is
        // real; in CI (no key) it is a truthful 422. The CATALOGUE-membership and
        // PERSISTENCE assertions hold in both envs.
        const token = await freshToken(request);

        const catalogue = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(catalogue.length, 'a catalogue is available to pick from').toBeGreaterThan(0);
        // Pick a stable, well-known catalogue model so the echo assertion is
        // deterministic across runs.
        const picked =
            catalogue.find((m) => m.id === 'openai/gpt-4o')?.id ??
            catalogue.find((m) => m.id === 'openai/gpt-4o-mini')?.id ??
            catalogue[0].id;

        const providerUsable = await isAiProviderConfigured(request, token);

        // Drive the completion with the picked model as an explicit body model
        // BEFORE writing any user key, so the env key (when present) resolves.
        const completion = await createChatCompletionViaAPI(request, token, {
            messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
            provider: OPENROUTER,
            model: picked,
            stream: false,
        });
        expect(completion.status, 'a completion round-trip fired').toBeGreaterThan(0);

        if (providerUsable && completion.status === 200) {
            // Real provider wired → the response `model` reflects the model that was
            // actually used: the requested catalogue id is echoed back exactly.
            expect(completion.content, 'a configured provider returns content').toBeTruthy();
            expect(completion.model, 'the completion reflects the EXACT model that was used').toBe(
                picked,
            );
        } else {
            // No usable key → clean 422 provider_unavailable, never a 5xx.
            expect(
                completion.status,
                `expected provider_unavailable; raw=${JSON.stringify(completion.raw)}`,
            ).toBe(422);
            const errType = (completion.raw as { error?: { type?: string } })?.error?.type;
            expect(errType, 'clean provider_unavailable contract').toBe('provider_unavailable');
        }

        // Now persist the selection as the user's defaultModel and assert it sticks
        // in BOTH the user-scoped `settings` and the env-merged `resolvedSettings`.
        // (This write shadows the env key, which is why the completion above ran first.)
        const patch = await patchPluginSettingsViaAPI(request, token, OPENROUTER, {
            settings: { apiKey: 'sk-or-e2e-fake-key', defaultModel: picked },
        });
        expect(
            patch.status,
            `persisting the selection succeeds; body=${JSON.stringify(patch.body)}`,
        ).toBe(200);

        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, OPENROUTER);
                    return (p.settings as { defaultModel?: string } | undefined)?.defaultModel;
                },
                { timeout: 15_000, message: 'the selected model persists in user settings' },
            )
            .toBe(picked);

        const persisted = await getPluginViaAPI(request, token, OPENROUTER);
        expect(
            (persisted.resolvedSettings as { defaultModel?: string } | undefined)?.defaultModel,
            'the selected model resolves as the effective default',
        ).toBe(picked);
        // The persisted defaultModel is a genuine member of the catalogue we read.
        const stillInCatalogue = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(
            stillInCatalogue.some((m) => m.id === picked),
            'the persisted defaultModel is a real catalogue member',
        ).toBe(true);
    });

    test('Flow 4: a non-catalogue `defaultModel` is ACCEPTED (presence-only validation) yet a completion using it fails cleanly (never 5xx)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const bogusModel = `totally/nonexistent-model-${Date.now()}`;

        // Sanity: the bogus id is NOT in the catalogue (so this really tests a
        // non-member persisting).
        const catalogue = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(
            catalogue.some((m) => m.id === bogusModel),
            'the bogus model is genuinely absent from the catalogue',
        ).toBe(false);

        // The required-field validation checks PRESENCE only, not catalogue
        // membership → a bogus defaultModel is accepted (200) and persists.
        const patch = await patchPluginSettingsViaAPI(request, token, OPENROUTER, {
            settings: { apiKey: 'sk-or-e2e-fake-key', defaultModel: bogusModel },
        });
        expect(
            patch.status,
            `a non-catalogue defaultModel is accepted; body=${JSON.stringify(patch.body)}`,
        ).toBe(200);

        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, OPENROUTER);
                    return (p.settings as { defaultModel?: string } | undefined)?.defaultModel;
                },
                { timeout: 15_000, message: 'the bogus defaultModel persists verbatim' },
            )
            .toBe(bogusModel);

        // A completion that RESOLVES to the bogus persisted defaultModel (no body
        // model) must fail cleanly — a 422 provider_unavailable, NEVER a 5xx. The
        // fake key also shadows the env key, so either the invalid-model upstream
        // error OR the auth error surfaces; both are the clean provider_unavailable
        // envelope. The key contract: a bad persisted model never crashes the API.
        const res = await complete(request, token);
        expect(
            res.status,
            `bogus-default completion is well-behaved (422, not 5xx); raw=${JSON.stringify(res.raw)}`,
        ).toBe(422);
        expect(res.errorType, 'clean provider_unavailable envelope').toBe('provider_unavailable');
        expect(res.errorMessage, 'the 422 carries an explanatory message').toBeTruthy();

        // The catalogue itself is untouched by the bogus selection — still the full list.
        const afterCatalogue = await listPluginModelsViaAPI(request, token, OPENROUTER);
        expect(
            afterCatalogue.length,
            'the bogus selection did not corrupt the catalogue',
        ).toBeGreaterThan(50);
    });

    test('Flow 5: an UNKNOWN model id in a completion is a clean 422, while a VALID catalogue model is echoed exactly (adaptive)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // An UNKNOWN model id → the OpenAI-compat controller maps the upstream
        // rejection to a clean 422 provider_unavailable with the "not a valid model
        // ID" message, NEVER a 5xx. This holds REGARDLESS of the env key (the model
        // is rejected before/at the provider, not an auth failure).
        const unknownModel = `totally/nonexistent-model-${Date.now()}`;
        const unknown = await complete(request, token, {
            provider: OPENROUTER,
            model: unknownModel,
        });
        expect(
            unknown.status,
            `unknown-model completion → 422 (never 5xx); raw=${JSON.stringify(unknown.raw)}`,
        ).toBe(422);
        expect(unknown.errorType, 'clean provider_unavailable envelope').toBe(
            'provider_unavailable',
        );

        // CONTROL: a VALID catalogue model — adaptive. With the env key it is echoed
        // back EXACTLY; without it, the SAME clean 422. The contrast proves the
        // unknown-model 422 above is about the MODEL, not a blanket failure.
        const catalogue = await listPluginModelsViaAPI(request, token, OPENROUTER);
        const validModel =
            catalogue.find((m) => m.id === 'openai/gpt-4o-mini')?.id ?? catalogue[0].id;
        const valid = await complete(request, token, { provider: OPENROUTER, model: validModel });
        expect(valid.status, 'valid-model completion round-trip fired').toBeGreaterThan(0);

        if (valid.status === 200) {
            expect(valid.content, 'a configured provider returns content').toBeTruthy();
            expect(valid.model, 'the response echoes the EXACT valid model that was used').toBe(
                validModel,
            );
        } else {
            expect(valid.status, 'no env key → clean 422').toBe(422);
            expect(valid.errorType, 'clean provider_unavailable envelope').toBe(
                'provider_unavailable',
            );
            // Even keyless, a VALID model does NOT produce the "not a valid model ID"
            // message — the failure mode differs from the unknown-model case.
            expect(
                (valid.errorMessage ?? '').toLowerCase(),
                'a valid model is not rejected as an invalid model id',
            ).not.toContain('not a valid model');
        }
    });

    test('Flow 6: catalogue contract for non-default / non-AI / unknown plugins — disabled AI provider → [], non-AI → [], unknown → 404, unauth → 401', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // --- A non-default AI provider (anthropic) across its lifecycle -----------
        // Fresh / unconfigured → [] (the real Anthropic catalogue needs a working
        // key, the facade catches the failure and returns []). NEVER a 5xx.
        const anFresh = await rawModels(request, token, ANTHROPIC);
        expect(anFresh.status, 'anthropic models resolves 200 for a fresh user').toBe(200);
        expect(Array.isArray(anFresh.body), 'anthropic returns an array').toBe(true);
        expect(
            (anFresh.body as CatalogueModel[]).length,
            'an unconfigured anthropic catalogue is empty (no working key)',
        ).toBe(0);

        // Enable anthropic with a FAKE key (non-system providers must be enabled
        // before they are configurable). The catalogue stays [] — the fake key
        // cannot fetch the real Anthropic model list, and the error is caught.
        const enabled = await enablePluginViaAPI(request, token, ANTHROPIC, {
            settings: { apiKey: 'sk-ant-e2e-fake-key', defaultModel: 'claude-3-5-haiku-latest' },
        });
        expect(enabled.id, 'anthropic enable echoes the id').toBe(ANTHROPIC);
        expect(enabled.category, 'anthropic is an ai-provider').toBe(AI_CAPABILITY);
        expect(enabled.systemPlugin, 'anthropic is NOT a system plugin').toBeFalsy();

        const anEnabled = await rawModels(request, token, ANTHROPIC);
        expect(anEnabled.status, 'anthropic models still 200 once enabled').toBe(200);
        expect(
            (anEnabled.body as CatalogueModel[]).length,
            'anthropic catalogue stays empty with a fake key (fetch fails → [], never 5xx)',
        ).toBe(0);

        // Disable anthropic — the catalogue endpoint still resolves cleanly to [].
        const disable = await request.post(`${API_BASE}/api/plugins/${ANTHROPIC}/disable`, {
            headers: authedHeaders(token),
        });
        expect(disable.status(), 'a non-system AI provider can be disabled').toBe(200);
        const anDisabled = await rawModels(request, token, ANTHROPIC);
        expect(anDisabled.status, 'anthropic models still 200 once disabled').toBe(200);
        expect(
            (anDisabled.body as CatalogueModel[]).length,
            'a disabled anthropic catalogue is [] (never a 5xx)',
        ).toBe(0);

        // --- Non-AI plugins have no model catalogue → [] -------------------------
        for (const nonAi of ['github', 'tavily']) {
            const r = await rawModels(request, token, nonAi);
            expect(r.status, `${nonAi} models resolves 200`).toBe(200);
            expect(Array.isArray(r.body), `${nonAi} returns an array`).toBe(true);
            expect(
                (r.body as CatalogueModel[]).length,
                `a non-AI plugin (${nonAi}) has no model catalogue`,
            ).toBe(0);
        }

        // --- An unknown plugin id → 404, NOT [] and NOT a 5xx -------------------
        const unknownId = `no-such-provider-${Date.now()}`;
        const unknown = await rawModels(request, token, unknownId);
        expect(unknown.status, 'an unknown plugin models → 404').toBe(404);
        const unknownBody = unknown.body as {
            message?: string;
            error?: string;
            statusCode?: number;
        };
        expect(unknownBody.message ?? '', 'the 404 names the missing plugin').toContain(unknownId);
        expect(unknownBody.message ?? '', 'the 404 is the not-found contract').toMatch(
            /not found/i,
        );

        // --- The catalogue endpoint requires authentication ---------------------
        const unauth = await rawModels(request, null, OPENROUTER);
        expect(unauth.status, 'the models endpoint rejects unauthenticated callers with 401').toBe(
            401,
        );
    });
});
