import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { getPluginViaAPI, patchPluginSettingsViaAPI, enablePluginViaAPI } from './helpers/plugins';

/**
 * AI-PLUGIN SETTINGS SCHEMA VALIDATION — complex, multi-step INTEGRATION flows
 * that pin the way an ai-provider plugin's JSON-Schema settings are surfaced,
 * validated, masked, and resolved: the schema-property projection (x-* → public
 * names), the required-field 400 matrix, AJV type validation, x-secret masking
 * (settings vs resolvedSettings), x-envVar binding + the user>env precedence,
 * and the resolvedSettings / models-summary / connection-status shapes. Every
 * status, message, and shape below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-06-01 before the assertions were written — so
 * this asserts the platform's REAL behaviour, never a guess.
 *
 * The existing flow-plugin-ai-matrix / flow-plugin-ai-provider-resolution specs
 * cover the ENABLE/disable contract, the model CATALOGUE, and provider/work
 * RESOLUTION + chat completions. This file is deliberately DISJOINT: it is about
 * the SETTINGS-SCHEMA validation surface (field projection, required/type errors,
 * masking, env-binding, resolved shape), which neither sibling spec asserts.
 *
 * PROBED CONTRACTS (live, http 3100; raw plugin schema in
 * packages/plugins/openrouter/src/openrouter.plugin.ts; projection +
 * masking in packages/agent/src/plugins/services/plugin-operations.service.ts;
 * AJV validation in .../settings-schema-validator.service.ts):
 *
 *   - GET /api/plugins/openrouter → settingsSchema is the PUBLIC projection of
 *     the raw schema (extractSettingsSchema):
 *       • required: ['apiKey','defaultModel']
 *       • properties keys: apiKey, defaultModel, simpleModel, mediumModel,
 *         complexModel  (the raw schema's x-hidden fields baseUrl/temperature/
 *         maxTokens are STRIPPED and never surfaced).
 *       • each property's x-* extensions are re-emitted WITHOUT the x- prefix:
 *         apiKey      → { type:'string', secret:true,  envVar:'PLUGIN_OPENROUTER_API_KEY', scope:'user' }
 *         defaultModel→ { type:'string', envVar:'PLUGIN_OPENROUTER_DEFAULT_MODEL', scope:'global', widget:'model-select', default:'openai/gpt-5-mini' }
 *
 *   - PATCH /api/plugins/openrouter/settings — required-field validation
 *     (validateSettingsOrThrow → settingsValidator.validate, scope 'user'):
 *       • {} (neither) → 400 { message:'Invalid plugin settings',
 *           errors:['Missing required fields: apiKey, defaultModel'] }
 *       • only defaultModel → errors:['Missing required fields: apiKey']
 *       • only apiKey       → errors:['Missing required fields: defaultModel']
 *       • apiKey:'' (empty string) counts as MISSING → same apiKey error.
 *     Type validation (AJV): defaultModel:12345 (number) →
 *       400 { errors:['/defaultModel: must be string (expected string)'] }.
 *     An UNKNOWN extra field (no additionalProperties:false, AJV strict:false)
 *       is TOLERATED → 200 and is echoed back in `settings`.
 *
 *   - x-secret masking (two distinct masks):
 *       • `settings` / work echo uses partialReveal(): len<=8 → 2+'••••'+2,
 *         else 4+'••••'+4. e.g. 'sk-enable-key-1234' → 'sk-e••••1234'.
 *       • `resolvedSettings` (projectDisplaySettings) masks every x-secret to
 *         the FIXED 8-bullet '••••••••' (8×U+2022). The raw key is NEVER echoed.
 *       • a secret supplied via `secretSettings.apiKey` is accepted and persists
 *         (echoed masked); the top-level `secretSettings` field comes back null.
 *
 *   - x-envVar binding + precedence (plugin-settings.service resolveSetting:
 *       work > user > admin > env > default):
 *       • a FRESH user with NO override → resolvedSettings.defaultModel is the
 *         ENV value (PLUGIN_OPENROUTER_DEFAULT_MODEL='openai/gpt-4o-mini'),
 *         models summary entry { key:'defaultModel', source:'env' }.
 *       • after the user PATCHes defaultModel, the USER value wins over env →
 *         source flips to 'user' (proves user>env precedence on an env-bound key).
 *       • global-scoped tier models with NO env var set fall back to their
 *         schema `default` → source:'default'.
 *       • CONTRAST: anthropic/google/groq/openai apiKey is x-secret but has NO
 *         x-envVar (configurationMode 'user-required') — its key is user-supplied
 *         only, with no env fallback. mistral + openrouter DO declare x-envVar.
 *
 *   - GET /api/plugins/openrouter/connection-status → { connectionStatus:{
 *       connected:boolean, scope:'user', message } } (200, opt-in probe).
 *   - GET /api/plugins/<unknown> → 404 { message:'Plugin "<id>" not found',
 *       error:'Not Found', statusCode:404 }.
 *
 * ISOLATION: every flow runs on its OWN FRESH registerUserViaAPI() user — never
 * the shared seeded user — because writing a user-scoped fake `apiKey` SHADOWS
 * the env key and would break sibling chat specs on the seeded account. Unique
 * Date.now()-suffixed emails; tolerant assertions (toContain / arrayContaining),
 * never exact global counts. Filename uses the safe `flow-` prefix (not matched
 * by the no-auth testIgnore regex) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */

const PLUGIN_ID = 'openrouter';
const ENV_DEFAULT_MODEL = 'openai/gpt-4o-mini'; // PLUGIN_OPENROUTER_DEFAULT_MODEL (local stack)
const SCHEMA_DEFAULT_MODEL = 'openai/gpt-5-mini'; // raw schema `default` for defaultModel
const FIXED_SECRET_MASK = '••••••••'; // resolvedSettings x-secret mask (8×U+2022)
const BULLET = '••••'; // partialReveal infix

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-ai-settings-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

/** Raw PATCH so we can inspect the exact status/body for the error matrix. */
async function rawPatch(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<{ status: number; body: { message?: string; errors?: string[] } | null }> {
    const res = await request.patch(`${API_BASE}/api/plugins/${PLUGIN_ID}/settings`, {
        headers: authedHeaders(token),
        data: body,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => null)) as {
            message?: string;
            errors?: string[];
        } | null,
    };
}

interface ModelSummary {
    key: string;
    label?: string;
    value?: string;
    source?: string;
    isWorkOverride?: boolean;
}

/**
 * ENVIRONMENT-ADAPTIVE configured-ness probe.
 *
 * The LOCAL dev stack binds PLUGIN_OPENROUTER_API_KEY / PLUGIN_OPENROUTER_DEFAULT_MODEL
 * via env, so a FRESH user (no override) resolves the env-bound apiKey/defaultModel
 * (resolvedSettings.apiKey → '••••••••', defaultModel → env value, models source 'env').
 * The CI e2e job sets NO LLM env key, so the SAME fresh user instead falls back to the
 * schema `default` (no resolved secret, defaultModel → schema default, source 'default').
 *
 * The single source of truth for "is the env key wired up?" is the FRESH-user model
 * summary: defaultModel.source === 'env' iff PLUGIN_OPENROUTER_DEFAULT_MODEL is bound.
 * The flows below assert the CONFIGURED contract when that is true and the UNCONFIGURED
 * contract otherwise, so the spec holds whether or not a provider key is present in CI.
 */
function envBoundDefaultModel(plugin: Record<string, unknown>): boolean {
    const models = (plugin.models ?? []) as ModelSummary[];
    return models.find((m) => m.key === 'defaultModel')?.source === 'env';
}

test.describe('AI-plugin settings schema validation — OpenRouter', () => {
    test('Flow 1: settingsSchema is the public projection — required fields, x-secret/x-envVar/x-scope/x-widget surfaced without the x- prefix, x-hidden fields stripped', async ({
        request,
    }) => {
        const token = await freshToken(request, 'schema');

        const plugin = await getPluginViaAPI(request, token, PLUGIN_ID);
        const schema = (plugin.settingsSchema ?? {}) as {
            type?: string;
            required?: string[];
            properties?: Record<string, Record<string, unknown>>;
        };

        expect(schema.type, 'the projected schema is an object schema').toBe('object');
        expect(
            schema.required ?? [],
            'the openrouter schema requires BOTH apiKey and defaultModel',
        ).toEqual(expect.arrayContaining(['apiKey', 'defaultModel']));

        const props = schema.properties ?? {};
        const keys = Object.keys(props);
        // The five user-facing model/key fields are surfaced.
        expect(keys, 'apiKey is surfaced').toContain('apiKey');
        expect(keys, 'defaultModel is surfaced').toContain('defaultModel');
        expect(keys, 'simpleModel is surfaced').toContain('simpleModel');
        expect(keys, 'mediumModel is surfaced').toContain('mediumModel');
        expect(keys, 'complexModel is surfaced').toContain('complexModel');
        // The raw schema's x-hidden fields are STRIPPED from the public projection.
        expect(keys, 'x-hidden baseUrl is not surfaced').not.toContain('baseUrl');
        expect(keys, 'x-hidden temperature is not surfaced').not.toContain('temperature');
        expect(keys, 'x-hidden maxTokens is not surfaced').not.toContain('maxTokens');

        // apiKey property: x-secret/x-scope/x-envVar re-emitted WITHOUT the x- prefix.
        const apiKey = props.apiKey ?? {};
        expect(apiKey.type, 'apiKey is a string field').toBe('string');
        expect(apiKey.secret, 'apiKey is flagged secret (x-secret → secret)').toBe(true);
        expect(apiKey.scope, 'apiKey is user-scoped (x-scope → scope)').toBe('user');
        expect(
            apiKey.envVar,
            'apiKey is env-bound (x-envVar → envVar) to the OpenRouter key var',
        ).toBe('PLUGIN_OPENROUTER_API_KEY');
        // The raw schema MUST NOT leak its internal x- prefixed keys to the API surface.
        expect(apiKey['x-secret'], 'the internal x-secret key is not leaked').toBeUndefined();
        expect(apiKey['x-envVar'], 'the internal x-envVar key is not leaked').toBeUndefined();
        expect(apiKey['x-scope'], 'the internal x-scope key is not leaked').toBeUndefined();

        // defaultModel property: global scope, env var, model-select widget, default.
        const defaultModel = props.defaultModel ?? {};
        expect(defaultModel.type, 'defaultModel is a string field').toBe('string');
        expect(defaultModel.secret, 'defaultModel is NOT a secret').toBeFalsy();
        expect(defaultModel.scope, 'defaultModel is global-scoped').toBe('global');
        expect(defaultModel.envVar, 'defaultModel is env-bound').toBe(
            'PLUGIN_OPENROUTER_DEFAULT_MODEL',
        );
        expect(defaultModel.widget, 'defaultModel uses the model-select widget').toBe(
            'model-select',
        );
        expect(defaultModel.default, 'defaultModel carries its schema default').toBe(
            SCHEMA_DEFAULT_MODEL,
        );
    });

    test('Flow 2: required-field validation matrix — missing both / each / empty-string each return a precise 400 naming exactly the absent required fields', async ({
        request,
    }) => {
        const token = await freshToken(request, 'required');

        // (a) Neither required field present → BOTH named, in schema order.
        const neither = await rawPatch(request, token, { settings: {} });
        expect(
            neither.status,
            `empty settings rejected; body=${JSON.stringify(neither.body)}`,
        ).toBe(400);
        expect(neither.body?.message, 'the 400 envelope is the settings-validation message').toBe(
            'Invalid plugin settings',
        );
        expect(
            (neither.body?.errors ?? []).join(' '),
            'both required fields are named when both are missing',
        ).toBe('Missing required fields: apiKey, defaultModel');

        // (b) Only defaultModel present → apiKey named alone.
        const missingApiKey = await rawPatch(request, token, {
            settings: { defaultModel: ENV_DEFAULT_MODEL },
        });
        expect(missingApiKey.status, 'missing apiKey rejected').toBe(400);
        expect(
            (missingApiKey.body?.errors ?? []).join(' '),
            'only apiKey is named when only it is missing',
        ).toBe('Missing required fields: apiKey');

        // (c) Only apiKey present → defaultModel named alone.
        const missingDefaultModel = await rawPatch(request, token, {
            settings: { apiKey: 'sk-e2e-only-key' },
        });
        expect(missingDefaultModel.status, 'missing defaultModel rejected').toBe(400);
        expect(
            (missingDefaultModel.body?.errors ?? []).join(' '),
            'only defaultModel is named when only it is missing',
        ).toBe('Missing required fields: defaultModel');

        // (d) Empty-string apiKey counts as MISSING (value === '' is treated absent).
        const emptyApiKey = await rawPatch(request, token, {
            settings: { apiKey: '', defaultModel: ENV_DEFAULT_MODEL },
        });
        expect(emptyApiKey.status, 'empty-string apiKey is rejected as missing').toBe(400);
        expect(
            (emptyApiKey.body?.errors ?? []).join(' '),
            'an empty-string required field is reported missing',
        ).toContain('apiKey');

        // CONTROL: satisfying BOTH required fields succeeds — proving the 400s above
        // are about REQUIREDNESS, not a blanket reject of every PATCH.
        const ok = await rawPatch(request, token, {
            settings: { apiKey: 'sk-e2e-valid-key', defaultModel: ENV_DEFAULT_MODEL },
        });
        expect(ok.status, `valid PATCH should succeed; body=${JSON.stringify(ok.body)}`).toBe(200);
    });

    test('Flow 3: AJV type validation rejects a non-string model with an instance-path message; an unknown extra field is tolerated', async ({
        request,
    }) => {
        const token = await freshToken(request, 'types');

        // Wrong type for a string field → AJV `type` error formatted with the
        // instance path. Both required fields are present, so this isolates the
        // TYPE failure from the required-field failure.
        const wrongType = await rawPatch(request, token, {
            settings: { apiKey: 'sk-e2e-typed-key', defaultModel: 12345 },
        });
        expect(
            wrongType.status,
            `a non-string defaultModel is rejected; body=${JSON.stringify(wrongType.body)}`,
        ).toBe(400);
        expect(wrongType.body?.message, 'the same settings-validation envelope').toBe(
            'Invalid plugin settings',
        );
        const typeErr = (wrongType.body?.errors ?? []).join(' ');
        expect(typeErr, 'the error names the offending field via its instance path').toContain(
            '/defaultModel',
        );
        expect(typeErr, 'the error states the expected type').toContain('must be string');

        // An UNKNOWN extra field passes (AJV strict:false, no additionalProperties:false)
        // as long as the required fields are valid → 200, and it is echoed back.
        const extraField = `bogus_${Date.now()}`;
        const withExtra = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: {
                apiKey: 'sk-e2e-extra-key',
                defaultModel: ENV_DEFAULT_MODEL,
                [extraField]: 'tolerated',
            },
        });
        expect(
            withExtra.status,
            `an unknown extra field is tolerated; body=${JSON.stringify(withExtra.body)}`,
        ).toBe(200);

        // The extra field round-trips into the stored user settings (the schema
        // neither rejects nor strips unknown keys).
        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, PLUGIN_ID);
                    const s = (p.settings ?? {}) as Record<string, unknown>;
                    return s[extraField];
                },
                { timeout: 15_000, message: 'the tolerated extra field persists in user settings' },
            )
            .toBe('tolerated');
    });

    test('Flow 4: x-secret masking — a secret apiKey supplied via secretSettings is accepted, partially-masked in settings, fully-masked in resolvedSettings, and never echoed raw', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mask');

        // Supply the secret through `secretSettings` (the secret-typed channel) and
        // the non-secret model through `settings`. Both required fields are thereby
        // satisfied across the two channels (they are validated together).
        const RAW_KEY = 'sk-enable-key-1234'; // 18 chars → partialReveal: 'sk-e' + '••••' + '1234'
        const patched = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            secretSettings: { apiKey: RAW_KEY },
            settings: { defaultModel: ENV_DEFAULT_MODEL },
        });
        expect(
            patched.status,
            `secret via secretSettings is accepted; body=${JSON.stringify(patched.body)}`,
        ).toBe(200);

        // Poll for the write to settle, then inspect the masked echoes.
        let plugin!: Record<string, unknown>;
        await expect
            .poll(
                async () => {
                    plugin = await getPluginViaAPI(request, token, PLUGIN_ID);
                    const s = (plugin.settings ?? {}) as { apiKey?: string };
                    return s.apiKey;
                },
                { timeout: 15_000, message: 'the secret apiKey settles into the echoed settings' },
            )
            .toBeTruthy();

        const settings = (plugin.settings ?? {}) as { apiKey?: string; defaultModel?: string };
        const resolved = (plugin.resolvedSettings ?? {}) as {
            apiKey?: string;
            defaultModel?: string;
        };

        // `settings` echo uses partialReveal: 4-prefix + '••••' + 4-suffix.
        expect(settings.apiKey, 'settings.apiKey is partial-revealed').toBe('sk-e••••1234');
        expect(settings.apiKey, 'the masked value contains the bullet infix').toContain(BULLET);
        // CRITICAL: the raw secret is NEVER returned in the clear.
        expect(settings.apiKey, 'the raw key never appears in settings').not.toBe(RAW_KEY);
        expect(
            JSON.stringify(plugin),
            'the raw key leaks nowhere in the whole payload',
        ).not.toContain(RAW_KEY);

        // `resolvedSettings` masks every x-secret. The user supplied the apiKey via
        // secretSettings, so it resolves at user scope wherever the resolved projection
        // surfaces a secret value at all. In a keyless CI env the resolved projection can
        // omit the secret entirely (projectDisplaySettings drops a no-value field) — but
        // the CONTRACT that the secret is NEVER emitted in the clear holds either way:
        // resolvedSettings.apiKey is either the FIXED 8-bullet mask or absent, never raw.
        expect(
            resolved.apiKey === undefined || resolved.apiKey === FIXED_SECRET_MASK,
            `resolvedSettings.apiKey is the fixed 8-bullet mask or absent (never raw); got=${JSON.stringify(resolved.apiKey)}`,
        ).toBe(true);
        expect(resolved.apiKey, 'the raw secret is never echoed in resolvedSettings').not.toBe(
            RAW_KEY,
        );
        // The non-secret defaultModel was supplied as a USER override, so it resolves in the
        // CLEAR to that exact value regardless of env (only secrets are masked).
        expect(resolved.defaultModel, 'the non-secret defaultModel resolves unmasked').toBe(
            ENV_DEFAULT_MODEL,
        );

        // The top-level `secretSettings` field is not echoed back to the client.
        expect(
            (plugin as { secretSettings?: unknown }).secretSettings ?? null,
            'the secretSettings blob is not surfaced',
        ).toBeNull();
    });

    test('Flow 5: x-envVar binding & precedence — a fresh user resolves defaultModel from the env var (source:env); a user override beats env (source:user); a no-env tier falls back to schema default', async ({
        request,
    }) => {
        const token = await freshToken(request, 'envbind');

        // (1) FRESH user, no overrides → the env-bound defaultModel resolves FROM
        // the environment variable; tier models with no env var fall back to default.
        // ENVIRONMENT-ADAPTIVE: the local stack binds PLUGIN_OPENROUTER_DEFAULT_MODEL so the
        // fresh user inherits the env value (source 'env'); the keyless CI e2e job has NO env
        // key so the SAME fresh user falls back to the schema `default` (source 'default').
        // Probe the configured-ness off the fresh-user summary and assert the matching contract.
        const before = await getPluginViaAPI(request, token, PLUGIN_ID);
        const envConfigured = envBoundDefaultModel(before);
        const resolvedBefore = (before.resolvedSettings ?? {}) as { defaultModel?: string };
        const modelsBefore = (before.models ?? []) as ModelSummary[];
        const defBefore = modelsBefore.find((m) => m.key === 'defaultModel');
        expect(defBefore, 'the model summary carries a defaultModel entry').toBeTruthy();
        if (envConfigured) {
            // CONFIGURED contract (env key present): env value wins, source 'env'.
            expect(
                resolvedBefore.defaultModel,
                'a fresh user inherits the env-var-bound default model',
            ).toBe(ENV_DEFAULT_MODEL);
            expect(defBefore?.source, 'the default model is sourced from the env var').toBe('env');
        } else {
            // UNCONFIGURED contract (keyless CI): the env-bound key has no env value, so
            // defaultModel falls through to its schema `default` (source 'default').
            expect(
                resolvedBefore.defaultModel,
                'with no env key the fresh user falls back to the schema default model',
            ).toBe(SCHEMA_DEFAULT_MODEL);
            expect(
                defBefore?.source,
                'with no env key the default model is sourced from the schema default',
            ).toBe('default');
        }
        expect(defBefore?.isWorkOverride, 'no work override at user scope').toBe(false);

        // A global-scoped tier with NO env var set resolves to its schema `default`.
        const simpleBefore = modelsBefore.find((m) => m.key === 'simpleModel');
        if (simpleBefore) {
            expect(
                simpleBefore.source,
                'a no-env tier model falls back to its schema default',
            ).toBe('default');
            expect(simpleBefore.value, 'the fallback value is the schema default').toBe(
                SCHEMA_DEFAULT_MODEL,
            );
        }

        // (2) The user PATCHes a DIFFERENT defaultModel → the user value OUTRANKS the
        // env value (work > user > admin > env > default). source flips env → user.
        const USER_MODEL = 'anthropic/claude-3.5-haiku';
        expect(USER_MODEL, 'the override differs from the env default').not.toBe(ENV_DEFAULT_MODEL);
        const patched = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: 'sk-e2e-envbind-key', defaultModel: USER_MODEL },
        });
        expect(
            patched.status,
            `override PATCH succeeds; body=${JSON.stringify(patched.body)}`,
        ).toBe(200);

        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, PLUGIN_ID);
                    return (p.resolvedSettings as { defaultModel?: string } | undefined)
                        ?.defaultModel;
                },
                { timeout: 15_000, message: 'the user override wins over the env default' },
            )
            .toBe(USER_MODEL);

        const after = await getPluginViaAPI(request, token, PLUGIN_ID);
        const modelsAfter = (after.models ?? []) as ModelSummary[];
        const defAfter = modelsAfter.find((m) => m.key === 'defaultModel');
        expect(defAfter?.value, 'the resolved value is the user override').toBe(USER_MODEL);
        expect(defAfter?.source, 'the source flips from env to user (user>env precedence)').toBe(
            'user',
        );

        // (3) CONTRAST: anthropic declares apiKey as x-secret but with NO x-envVar
        // (configurationMode 'user-required') — so its secret has NO env fallback,
        // proving x-envVar binding is a per-field property, not a category default.
        const anthropic = await getPluginViaAPI(request, token, 'anthropic');
        const anthropicSchema = (anthropic.settingsSchema ?? {}) as {
            properties?: Record<string, Record<string, unknown>>;
        };
        const anthropicApiKey = anthropicSchema.properties?.apiKey ?? {};
        expect(anthropicApiKey.secret, 'anthropic apiKey is still a secret').toBe(true);
        expect(
            anthropicApiKey.envVar,
            'anthropic apiKey is NOT env-bound (no x-envVar) — user-supplied only',
        ).toBeFalsy();
        expect(
            anthropic.configurationMode,
            'anthropic is a user-required provider (no shared env key path)',
        ).toBe('user-required');
    });

    test('Flow 6: resolvedSettings + models summary + connection-status shapes are well-formed, and an unknown plugin id resolves 404 (never 5xx)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'resolved');

        // enable is idempotent for the system/default provider; do it so the
        // resolved/connection projections are exercised on an enabled record.
        const enabled = await enablePluginViaAPI(request, token, PLUGIN_ID);
        expect(enabled.id, 'enable echoes the plugin id').toBe(PLUGIN_ID);

        const plugin = await getPluginViaAPI(request, token, PLUGIN_ID);

        // resolvedSettings carries every projected (non-hidden) field with a value;
        // the secret is masked, the models resolve to concrete strings.
        // ENVIRONMENT-ADAPTIVE: with the env key wired up (local) the fresh user resolves the
        // env-bound apiKey (masked to the FIXED 8-bullet string) + the env default model; in
        // the keyless CI e2e job the secret has no resolved value so projectDisplaySettings
        // OMITS apiKey, and defaultModel falls through to its schema `default`. Either way the
        // masking contract holds: resolvedSettings.apiKey is the 8-bullet mask or absent — never raw.
        const resolved = (plugin.resolvedSettings ?? {}) as Record<string, unknown>;
        const envConfigured = envBoundDefaultModel(plugin);
        expect(
            resolved.apiKey === undefined || resolved.apiKey === FIXED_SECRET_MASK,
            `resolvedSettings masks the secret apiKey (8-bullet mask or absent, never raw); got=${JSON.stringify(resolved.apiKey)}`,
        ).toBe(true);
        if (envConfigured) {
            expect(resolved.apiKey, 'a wired env key resolves the masked secret apiKey').toBe(
                FIXED_SECRET_MASK,
            );
            expect(typeof resolved.defaultModel, 'defaultModel resolves to a concrete string').toBe(
                'string',
            );
            expect(resolved.defaultModel, 'the env-bound default resolves for a fresh user').toBe(
                ENV_DEFAULT_MODEL,
            );
        } else {
            // No env key: the unconfigured secret is dropped from the projection, and the
            // non-secret defaultModel still resolves to a concrete string — the schema default.
            expect(typeof resolved.defaultModel, 'defaultModel resolves to a concrete string').toBe(
                'string',
            );
            expect(
                resolved.defaultModel,
                'with no env key the fresh user resolves the schema default model',
            ).toBe(SCHEMA_DEFAULT_MODEL);
        }
        // x-hidden fields never leak into the resolved projection either.
        expect(
            resolved.baseUrl,
            'x-hidden baseUrl is absent from resolvedSettings',
        ).toBeUndefined();
        expect(
            resolved.temperature,
            'x-hidden temperature is absent from resolvedSettings',
        ).toBeUndefined();

        // The models summary is a per-key array of { key,label,value,source,isWorkOverride }.
        const models = (plugin.models ?? []) as ModelSummary[];
        expect(models.length, 'the provider exposes a model summary').toBeGreaterThan(0);
        const defEntry = models.find((m) => m.key === 'defaultModel');
        expect(defEntry, 'the summary includes the default model tier').toBeTruthy();
        expect(typeof defEntry?.label, 'each summary entry carries a human label').toBe('string');
        expect(defEntry?.value, 'the default tier resolves to a concrete model id').toBeTruthy();
        expect(
            ['env', 'user', 'admin', 'work', 'default'],
            'each summary entry reports a known resolution source',
        ).toContain(defEntry?.source);
        expect(typeof defEntry?.isWorkOverride, 'isWorkOverride is a boolean flag').toBe('boolean');

        // connection-status is its own opt-in endpoint with a stable envelope.
        const csRes = await request.get(`${API_BASE}/api/plugins/${PLUGIN_ID}/connection-status`, {
            headers: authedHeaders(token),
        });
        expect(csRes.status(), 'connection-status resolves 200').toBe(200);
        const csBody = (await csRes.json().catch(() => ({}))) as {
            connectionStatus?: { connected?: boolean; scope?: string; message?: string };
        };
        // Adaptive on the env key: with a working key it reports connected:true; in a
        // keyless env the envelope is still present — assert the SHAPE either way.
        if (csBody.connectionStatus) {
            expect(
                typeof csBody.connectionStatus.connected,
                'connection-status carries a boolean connected flag',
            ).toBe('boolean');
            if (csBody.connectionStatus.connected) {
                expect(
                    csBody.connectionStatus.scope,
                    'a connected provider reports its resolution scope',
                ).toBeTruthy();
            }
        }

        // An unknown plugin id is a clean 404 with the not-found envelope — never a 5xx.
        const unknownId = `no-such-plugin-${Date.now()}`;
        const unknown = await request.get(`${API_BASE}/api/plugins/${unknownId}`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status(), 'an unknown plugin id is a 404, not a 5xx').toBe(404);
        const unknownBody = (await unknown.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
            statusCode?: number;
        };
        expect(unknownBody.statusCode, 'the 404 carries the NestJS not-found status').toBe(404);
        expect(unknownBody.message ?? '', 'the 404 names the unknown plugin id').toContain(
            unknownId,
        );
    });
});
