import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import {
    getPluginViaAPI,
    enablePluginViaAPI,
    disablePluginViaAPI,
    patchPluginSettingsViaAPI,
    listPluginModelsViaAPI,
} from './helpers/plugins';

/**
 * AI-GATEWAY PLUGINS — complex, multi-step INTEGRATION flows for the
 * `ai-gateway` family (openrouter = the system default gateway,
 * vercel-ai-gateway = an opt-in, NON-system gateway). This file is the
 * complement to flow-plugin-ai-matrix (openrouter happy path) and
 * flow-plugin-ai-provider-resolution (override/work-active precedence with the
 * anthropic *direct* provider): here the SECOND, non-default party in every
 * resolution is the vercel-ai-gateway, exercising the gateway-specific
 * lifecycle (enable-before-settings ordering, empty model catalogue, the
 * gateway's own upstream-auth signature) and gateway-vs-direct-default
 * precedence. Every shape, status and message below was PROBED against the LIVE
 * stack (http://127.0.0.1:3100) on 2026-06-01 before the assertions were
 * written — this asserts the platform's REAL behaviour, never a guess.
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - GET /api/plugins/vercel-ai-gateway →
 *       { id:'vercel-ai-gateway', category:'ai-provider', systemPlugin:false,
 *         autoEnable:false, enabled:false (fresh user), configurationMode:'hybrid',
 *         defaultForCapabilities:[],  // ← NOT a default-for-capability
 *         settingsSchema:{ required:['apiKey','defaultModel'],
 *           properties:{ apiKey(x-secret,x-scope:user,envVar:PLUGIN_VERCEL_AI_GATEWAY_API_KEY),
 *             defaultModel(default:'openai/gpt-5.1'), simpleModel, mediumModel,
 *             complexModel, baseUrl(hidden), temperature(hidden), maxTokens(hidden) } },
 *         resolvedSettings:{ defaultModel:'openai/gpt-5.1', simpleModel:'openai/gpt-5-nano',
 *           mediumModel:'openai/gpt-4o', complexModel:'openai/gpt-5.1' },
 *         models:[ {key:'defaultModel',value:'openai/gpt-5.1',source:'default'}, … ] }.
 *   - GET /api/plugins/vercel-ai-gateway/models → `[]` (EMPTY array — the gateway
 *     proxies many upstreams and ships no static catalogue; unlike openrouter's
 *     ~343-entry catalogue). NB the per-plugin tier models live on the plugin
 *     object's `models` field, not this endpoint.
 *   - LIFECYCLE ORDERING (gateway is NOT auto-enabled, so order matters):
 *       • PATCH /settings BEFORE enable → 400 { message:'Plugin
 *         "vercel-ai-gateway" is not installed for this user. Enable it first.',
 *         error:'Bad Request' }.
 *       • POST /enable {} → 200 (no settings required to enable at the USER level)
 *         → enabled:true.
 *       • PATCH /settings { apiKey, defaultModel } AFTER enable → 200; apiKey
 *         comes back MASKED ("vck-••••-key"); the chosen defaultModel persists in
 *         BOTH `settings.defaultModel` and `resolvedSettings.defaultModel`.
 *       • PATCH /settings { apiKey } with NO defaultModel, on a NEWLY-installed
 *         user that has never set one → 400 { message:'Invalid plugin settings',
 *         errors:['Missing required fields: defaultModel'] }.
 *       • POST /disable → 200 (vercel-ai-gateway is NOT a system plugin, so —
 *         unlike openrouter — it disables cleanly).
 *   - RESOLUTION via POST /api/v1/chat/completions (@HttpCode(200); the override
 *     travels ONLY in `X-Provider-Override`, the work scope in `X-Work-Id`; a body
 *     `provider` field → 400 "property provider should not exist"):
 *       • X-Provider-Override:vercel-ai-gateway while NOT enabled → 422
 *         { error:{ message:'ai-provider provider not found: vercel-ai-gateway',
 *         type:'provider_unavailable' } } (resolution failure, never a 5xx).
 *       • X-Provider-Override:vercel-ai-gateway once ENABLED (fake user key) → the
 *         gateway RESOLVES and the failure is its OWN upstream auth error: 422
 *         { error:{ message:'401 Authentication failed. Create an API key and set
 *         in AI_GATEWAY_API_KEY environment variable …', type:'provider_unavailable' } }.
 *         The `AI_GATEWAY_API_KEY` / ai-gateway.vercel.sh signature is the
 *         fingerprint that PROVES the gateway (not openrouter/anthropic) served it.
 *       • DEFAULT precedence: even with the gateway enabled+configured, a
 *         no-override completion still resolves OPENROUTER (the only
 *         defaultForCapabilities:['ai-provider'] plugin). With the env key wired
 *         (local) → 200 model:"openai/gpt-4o-mini"; keyless (CI) → 422
 *         provider_unavailable — and in NEITHER case the gateway signature.
 *       • WORK-ACTIVE: POST /api/works/:id/plugins/vercel-ai-gateway/enable
 *         { activeCapability:'ai-provider' } pins the gateway as the work's active
 *         ai-provider (requires user settings first, same ordering as any
 *         provider). A completion with X-Work-Id:<work> then resolves the gateway
 *         (its auth signature surfaces) ahead of the openrouter default.
 *       • PRECEDENCE: X-Provider-Override:openrouter on the SAME X-Work-Id request
 *         BEATS the work-active gateway → openrouter serves it (no gateway
 *         signature; real 200 / clean 422).
 *   - GET /api/plugins/vercel-ai-gateway/connection-status → 200 `{}` (a fake
 *     user key does not promote to a connected envelope).
 *
 * ENVIRONMENT-ADAPTIVE: completions need a real provider key. Locally the stack
 * ships PLUGIN_OPENROUTER_API_KEY so the openrouter/default path returns a real
 * 200; in CI (no key) the SAME path is a truthful 422 provider_unavailable. Each
 * flow asserts the REAL outcome for whatever env it runs in via a `providerUsable`
 * branch — never skipping the round-trip, never asserting a fictional contract.
 * The RESOLUTION assertions (WHICH plugin served — gateway signature vs not,
 * not-found vs gateway-auth, the work-active swap, the override precedence) hold
 * in BOTH envs because they are about WHICH plugin is resolved, not whether the
 * upstream call ultimately succeeds. The vercel-ai-gateway never has a real key
 * in either env, so its override path is a deterministic gateway-auth 422
 * everywhere — a stable cross-env anchor.
 *
 * ISOLATION: every flow runs on its OWN FRESH registerUserViaAPI() user — never
 * the shared seeded user — because writing a user-scoped fake `apiKey` SHADOWS
 * the env key and would break sibling chat specs on the seeded account. Unique
 * Date.now()-suffixed emails; tolerant assertions (toContain / .or()), never
 * exact counts. Filename uses the safe `flow-` prefix (not matched by the no-auth
 * testIgnore regex in playwright.config.ts) and is fully API-orchestrated, so it
 * does not contend on the shared UI/stack.
 */

const GATEWAY = 'vercel-ai-gateway';
const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const AI_CAPABILITY = 'ai-provider';
const COMPLETIONS = `${API_BASE}/api/v1/chat/completions`;
const FAKE_GATEWAY_KEY = 'vck-e2e-fake-gateway-key';

/** Fingerprint that PROVES the vercel-ai-gateway plugin served a request. */
const GATEWAY_SIGNATURE = /ai_gateway_api_key|ai-gateway|gateway/i;

interface CompletionProbe {
    status: number;
    model: string | null;
    content: string | null;
    errorType: string | null;
    errorMessage: string | null;
    raw: unknown;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-ai-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

/**
 * Fire a real POST /api/v1/chat/completions round-trip with optional provider /
 * work-scope headers and an optional explicit body model. Parses BOTH the
 * success and the provider_unavailable envelope so callers can branch.
 */
async function complete(
    request: APIRequestContext,
    token: string,
    opts: {
        providerOverride?: string;
        workId?: string;
        model?: string;
        content?: string;
    } = {},
): Promise<CompletionProbe> {
    const headers: Record<string, string> = authedHeaders(token);
    if (opts.providerOverride) headers['X-Provider-Override'] = opts.providerOverride;
    if (opts.workId) headers['X-Work-Id'] = opts.workId;

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

/**
 * Enable the gateway at the USER level, then configure its required settings.
 * The ORDER matters: the gateway is NOT auto-enabled, so a settings PATCH before
 * enable is rejected ("not installed … Enable it first"). After this returns the
 * gateway is an enabled, RESOLVABLE provider whose upstream call will fail on the
 * fake key (the deterministic gateway-auth 422 in every environment).
 */
async function enableAndConfigureGateway(
    request: APIRequestContext,
    token: string,
    defaultModel = DEFAULT_MODEL,
): Promise<void> {
    const enabled = await enablePluginViaAPI(request, token, GATEWAY);
    expect(enabled.id, 'enable echoes the gateway id').toBe(GATEWAY);
    const patch = await patchPluginSettingsViaAPI(request, token, GATEWAY, {
        settings: { apiKey: FAKE_GATEWAY_KEY, defaultModel },
    });
    expect(patch.status, `configure gateway settings; body=${JSON.stringify(patch.body)}`).toBe(
        200,
    );
}

test.describe('AI gateway plugins — vercel-ai-gateway lifecycle, resolution & precedence', () => {
    test('Flow 1: gateway catalogue contract — vercel-ai-gateway is an ai-provider but NOT a system/default plugin; openrouter is the only default', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // --- The gateway's own descriptor ---------------------------------
        const gateway = await getPluginViaAPI(request, token, GATEWAY);
        expect(gateway.id, 'gateway id').toBe(GATEWAY);
        expect(gateway.category, 'the gateway is catalogued under the ai-provider capability').toBe(
            AI_CAPABILITY,
        );
        expect(gateway.systemPlugin, 'the vercel gateway is NOT a system plugin').toBeFalsy();
        expect(gateway.autoEnable, 'the vercel gateway does NOT auto-enable').toBeFalsy();
        expect(gateway.enabled, 'the vercel gateway is disabled for a fresh user').toBeFalsy();
        expect(gateway.configurationMode, 'the gateway runs in hybrid configuration mode').toBe(
            'hybrid',
        );
        expect(
            (gateway.defaultForCapabilities as string[] | undefined) ?? [],
            'the gateway is NOT default-for any capability',
        ).toEqual([]);

        // The settings schema requires the same apiKey + defaultModel contract as
        // any ai-provider, with the gateway-specific default model.
        const schema = (gateway.settingsSchema ?? {}) as {
            required?: string[];
            properties?: Record<string, { default?: string }>;
        };
        expect(schema.required ?? [], 'the gateway schema requires apiKey + defaultModel').toEqual(
            expect.arrayContaining(['apiKey', 'defaultModel']),
        );
        expect(
            schema.properties?.defaultModel?.default,
            'the gateway ships a default model out of the box',
        ).toBeTruthy();

        // --- Contrast with the catalogue: openrouter is THE default gateway ---
        const listRes = await request.get(`${API_BASE}/api/plugins`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status()).toBe(200);
        const listBody = (await listRes.json()) as {
            plugins?: Array<{
                id: string;
                category?: string;
                enabled?: boolean;
                systemPlugin?: boolean;
                defaultForCapabilities?: string[];
            }>;
        };
        const providers = (listBody.plugins ?? []).filter((p) => p.category === AI_CAPABILITY);
        const ids = providers.map((p) => p.id);
        expect(ids, 'the catalogue lists the vercel gateway').toContain(GATEWAY);
        expect(ids, 'the catalogue lists openrouter (the default gateway)').toContain(
            DEFAULT_PROVIDER,
        );

        // Exactly ONE ai-provider is default-for the capability and it is openrouter
        // — the vercel gateway is an opt-in alternative, never the silent default.
        const defaults = providers.filter((p) =>
            (p.defaultForCapabilities ?? []).includes(AI_CAPABILITY),
        );
        expect(defaults.length, 'exactly one default ai-provider').toBe(1);
        expect(
            defaults[0].id,
            'the single default ai-provider is openrouter, not the gateway',
        ).toBe(DEFAULT_PROVIDER);
        const gatewayInList = providers.find((p) => p.id === GATEWAY);
        expect(
            gatewayInList?.systemPlugin,
            'the gateway is non-system in the list too',
        ).toBeFalsy();
    });

    test('Flow 2: enable-before-settings ordering — PATCH before enable is rejected, enable then valid PATCH persists model; an empty-defaultModel install is rejected', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // The gateway is NOT auto-enabled, so a settings PATCH before enable is a
        // precise install-ordering rejection (DISTINCT from the missing-required
        // validation a freshly-installed user gets).
        const premature = await patchPluginSettingsViaAPI(request, token, GATEWAY, {
            settings: { apiKey: FAKE_GATEWAY_KEY, defaultModel: DEFAULT_MODEL },
        });
        expect(premature.status, 'PATCH before enable is rejected 400').toBe(400);
        expect(
            (premature.body as { message?: string })?.message ?? '',
            'the 400 tells the caller to enable the gateway first',
        ).toMatch(/not installed.*enable it first/i);

        // Enable at the user level — no settings are needed to ENABLE the gateway.
        const enabled = await enablePluginViaAPI(request, token, GATEWAY);
        expect(enabled.id, 'enable echoes the gateway id').toBe(GATEWAY);
        const afterEnable = await getPluginViaAPI(request, token, GATEWAY);
        expect(afterEnable.enabled, 'the gateway is enabled after POST /enable').toBe(true);

        // Now an empty-defaultModel PATCH on this freshly-installed user (which has
        // never set a defaultModel) hits the REQUIRED-FIELDS validation — a
        // different 400 from the install-ordering one above.
        const missingModel = await patchPluginSettingsViaAPI(request, token, GATEWAY, {
            settings: { apiKey: 'vck-only-no-model' },
        });
        expect(
            missingModel.status,
            'PATCH missing defaultModel on a fresh install is rejected',
        ).toBe(400);
        const missingBody = missingModel.body as { message?: string; errors?: string[] };
        expect(missingBody?.message ?? '', 'the 400 is the settings-validation envelope').toContain(
            'Invalid plugin settings',
        );
        expect(
            (missingBody?.errors ?? []).join(' '),
            'the 400 names the missing required field',
        ).toContain('defaultModel');

        // A valid PATCH (both required fields) succeeds and persists.
        const ok = await patchPluginSettingsViaAPI(request, token, GATEWAY, {
            settings: { apiKey: FAKE_GATEWAY_KEY, defaultModel: DEFAULT_MODEL },
        });
        expect(ok.status, `valid PATCH succeeds; body=${JSON.stringify(ok.body)}`).toBe(200);

        // The chosen model persists in BOTH the user `settings` and the env-merged
        // `resolvedSettings`. The apiKey comes back MASKED, so we never assert the
        // raw key — only the (unmasked) defaultModel.
        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, GATEWAY);
                    return (p.settings as { defaultModel?: string } | undefined)?.defaultModel;
                },
                { timeout: 15_000, message: 'the chosen defaultModel persists in user settings' },
            )
            .toBe(DEFAULT_MODEL);

        const settled = await getPluginViaAPI(request, token, GATEWAY);
        expect(
            (settled.resolvedSettings as { defaultModel?: string } | undefined)?.defaultModel,
            'the chosen defaultModel is the effective resolved default',
        ).toBe(DEFAULT_MODEL);
        // The raw key is masked in the round-trip — assert the mask, never the key.
        const maskedKey = (settled.settings as { apiKey?: string } | undefined)?.apiKey;
        if (maskedKey) {
            expect(maskedKey, 'the gateway apiKey is returned masked, never in clear').not.toBe(
                FAKE_GATEWAY_KEY,
            );
        }
    });

    test('Flow 3: the gateway models endpoint is an empty static catalogue (the gateway proxies upstreams; tier models live on the plugin object)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Unlike openrouter (which exposes a ~343-entry static catalogue), the
        // vercel gateway proxies many upstream providers and ships NO static model
        // list of its own — the endpoint resolves 200 with an empty array.
        const models = await listPluginModelsViaAPI(request, token, GATEWAY);
        expect(Array.isArray(models), 'the gateway models endpoint returns an array').toBe(true);
        expect(models.length, 'the gateway ships no static model catalogue').toBe(0);

        // The configurable per-tier model selections instead live on the plugin
        // object's `models` field — the real source of the gateway's defaults.
        const gateway = await getPluginViaAPI(request, token, GATEWAY);
        const tierModels = (gateway.models ?? []) as Array<{
            key?: string;
            value?: string;
            source?: string;
        }>;
        expect(tierModels.length, 'the plugin object carries the tier model rows').toBeGreaterThan(
            0,
        );
        const keys = tierModels.map((m) => m.key);
        expect(keys, 'the default-model tier is exposed').toContain('defaultModel');
        const defaultTier = tierModels.find((m) => m.key === 'defaultModel');
        expect(defaultTier?.value, 'the default tier has a concrete model value').toBeTruthy();
        expect(
            defaultTier?.source,
            'an unconfigured tier reports its value comes from the plugin default',
        ).toBe('default');
    });

    test('Flow 4: override resolution — gateway override fails "not found" until enabled, then resolves and fails with the GATEWAY auth signature', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Before enabling, an override to the gateway is a RESOLUTION failure
        // (ProviderNotFoundError → 422), categorically different from an enabled
        // provider that fails on its key.
        const notEnabled = await complete(request, token, { providerOverride: GATEWAY });
        expect(notEnabled.status, 'override to a not-enabled gateway → 422 (never 5xx)').toBe(422);
        expect(notEnabled.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            notEnabled.errorMessage ?? '',
            'the message explains the gateway is not a resolvable provider yet',
        ).toContain(`provider not found: ${GATEWAY}`);

        // Enable + configure the gateway with a fake key — it is now ENABLED and
        // RESOLVABLE; the failure moves from "resolution" to "the gateway's own
        // upstream auth call".
        await enableAndConfigureGateway(request, token);

        const resolved = await complete(request, token, { providerOverride: GATEWAY });
        expect(resolved.status, 'enabled-but-bad-key gateway override → 422 (clean, not 5xx)').toBe(
            422,
        );
        expect(resolved.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        // It is NO LONGER a "not found" — the gateway resolved.
        expect(
            resolved.errorMessage ?? '',
            'the failure is now an upstream gateway-auth error, not a resolution miss',
        ).not.toContain('provider not found');
        // And the message carries the vercel-ai-gateway FINGERPRINT — proof that the
        // GATEWAY (not openrouter/anthropic) served the request.
        expect(
            resolved.errorMessage ?? '',
            'the gateway upstream-auth signature proves the gateway served it',
        ).toMatch(GATEWAY_SIGNATURE);
        expect(
            (resolved.errorMessage ?? '').toLowerCase(),
            'the failure is an authentication error on the gateway key',
        ).toMatch(/401|authentication|api key|auth/);
    });

    test('Flow 5: default precedence — with the gateway enabled+configured, a no-override completion STILL resolves openrouter (the default), never the gateway', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Enable + configure the gateway. If the resolver wrongly preferred a
        // freshly-enabled gateway over the default-for-capability plugin, a
        // no-override completion would carry the gateway signature.
        await enableAndConfigureGateway(request, token);

        // The body `provider` field cannot carry the override — it must be the
        // header. Pin that contract so a regression to a silently-ignored body
        // field is caught.
        const bodyFieldRes = await request.post(COMPLETIONS, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'ping' }], provider: GATEWAY },
        });
        expect(bodyFieldRes.status(), 'a body `provider` field is rejected').toBe(400);
        const bodyFieldBody = (await bodyFieldRes.json().catch(() => ({}))) as {
            message?: string | string[];
        };
        const rejectMsg = Array.isArray(bodyFieldBody.message)
            ? bodyFieldBody.message.join(' ')
            : (bodyFieldBody.message ?? '');
        expect(rejectMsg, 'the 400 names the rejected `provider` property').toContain('provider');

        // No override, no work scope → the system DEFAULT (openrouter) resolves,
        // NOT the just-enabled gateway. Adaptive on the env key.
        const def = await complete(request, token);
        expect(def.status, 'default completion round-trip fired').toBeGreaterThan(0);

        // In EITHER environment the gateway must NOT have served the default — its
        // fingerprint never appears on the no-override path.
        expect(
            def.errorMessage ?? '',
            'the gateway did NOT hijack the default resolution',
        ).not.toMatch(GATEWAY_SIGNATURE);

        if (def.status === 200) {
            // Real openrouter key wired → the openrouter default model is echoed.
            expect(def.content, 'the default provider returned content').toBeTruthy();
            expect(def.model, 'the resolved default is openrouter (its default model)').toBe(
                DEFAULT_MODEL,
            );
        } else {
            // No env key → the truthful provider_unavailable envelope from openrouter,
            // never a 5xx and never the gateway-auth error.
            expect(def.status, `expected 422; raw=${JSON.stringify(def.raw)}`).toBe(422);
            expect(def.errorType, 'clean provider_unavailable contract').toBe(
                'provider_unavailable',
            );
        }
    });

    test('Flow 6: per-work active gateway binding — work-enable requires user settings first, then X-Work-Id resolves the gateway ahead of the default', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const work = await createWorkViaAPI(request, token, {
            name: `Gateway Binding ${Date.now()}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        // Binding the gateway to a work before its user-level required settings
        // exist is rejected — the same ordering contract every provider shares.
        const prematureEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${GATEWAY}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(
            prematureEnable.status(),
            `work-enable before user settings is rejected; body=${await prematureEnable.text().catch(() => '')}`,
        ).toBe(400);
        const prematureBody = (await prematureEnable.json().catch(() => ({}))) as {
            message?: string;
            errors?: string[];
        };
        // Either the "user-level required settings" ordering message or the install
        // ordering message — both are the real, pre-settings rejections.
        expect(
            prematureBody.message ?? '',
            'the 400 explains the gateway is not yet configured/installed for binding',
        ).toMatch(
            // 'must be enabled at user level first' is the real pre-settings
            // rejection from plugin-operations.service.ts when the gateway was
            // never user-enabled; the user-level-required-settings variant is the
            // next-step rejection. Either is a valid pre-binding ordering 400.
            /must be enabled at user level first|user-level required settings|not installed|enable it first|apikey/i,
        );

        // Satisfy the ordering: enable + configure the gateway at the user level,
        // then pin it as the work's ACTIVE ai-provider.
        await enableAndConfigureGateway(request, token);
        const workEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${GATEWAY}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(
            workEnable.status(),
            `work-enable after user settings succeeds; body=${await workEnable.text().catch(() => '')}`,
        ).toBe(200);
        expect(
            (await workEnable.json().catch(() => ({}))).id,
            'the work-enable echoes the bound gateway id',
        ).toBe(GATEWAY);

        // A completion scoped to THIS work via X-Work-Id resolves the WORK-ACTIVE
        // gateway ahead of the openrouter default. The fake key → 422 with the
        // gateway signature: PROOF the work binding swapped which plugin served it
        // (a default-openrouter resolution would have used the env key → 200 / no
        // gateway signature).
        const scoped = await complete(request, token, { workId: work.id });
        expect(scoped.status, 'work-scoped completion is well-behaved (422, not 5xx)').toBe(422);
        expect(scoped.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            scoped.errorMessage ?? '',
            'the work-active gateway served the request (its auth signature surfaced)',
        ).toMatch(GATEWAY_SIGNATURE);
        // It is NOT the openrouter default — the work binding took precedence.
        expect(scoped.errorMessage ?? '', 'the default was NOT what served it').not.toContain(
            'provider not found',
        );
    });

    test('Flow 7: precedence + disable — X-Provider-Override:openrouter BEATS the work-active gateway, and the non-system gateway disables cleanly', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const work = await createWorkViaAPI(request, token, {
            name: `Gateway Precedence ${Date.now()}`,
        });

        // Pin the gateway as the work-active provider (bad key).
        await enableAndConfigureGateway(request, token);
        const bind = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${GATEWAY}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(bind.status(), 'gateway pinned as the work-active provider').toBe(200);

        // Baseline (work scope, NO override) → the work-active gateway resolves and
        // fails on its key (422 with the gateway signature). Confirms the binding is live.
        const baseline = await complete(request, token, { workId: work.id });
        expect(baseline.status, 'baseline work-scoped → 422').toBe(422);
        expect(baseline.errorMessage ?? '', 'baseline resolved the work-active gateway').toMatch(
            GATEWAY_SIGNATURE,
        );

        // Now add X-Provider-Override:openrouter ON THE SAME work-scoped request.
        // Per the resolver, the explicit override OUTRANKS the work-active binding
        // → openrouter serves it, NOT the gateway. Adaptive on the env key.
        const overridden = await complete(request, token, {
            workId: work.id,
            providerOverride: DEFAULT_PROVIDER,
        });
        expect(overridden.status, 'override-on-work-scope completion fired').toBeGreaterThan(0);
        // In EITHER environment the gateway signature must be GONE — the override
        // re-routed resolution away from the work-active gateway before the call.
        expect(
            overridden.errorMessage ?? '',
            'the override re-routed away from the work-active gateway',
        ).not.toMatch(GATEWAY_SIGNATURE);

        if (overridden.status === 200) {
            // Real key → the override won: openrouter's default model is echoed.
            expect(overridden.content, 'the override provider returned content').toBeTruthy();
            expect(
                overridden.model,
                'X-Provider-Override openrouter beat the work-active gateway',
            ).toBe(DEFAULT_MODEL);
        } else {
            // No env key → still a clean 422, but NOT the gateway-auth error, and
            // openrouter WAS resolvable (not a not-found).
            expect(overridden.status, 'no env key → clean 422').toBe(422);
            expect(overridden.errorType, 'provider_unavailable envelope').toBe(
                'provider_unavailable',
            );
            expect(
                overridden.errorMessage ?? '',
                'and openrouter WAS resolvable (not a not-found)',
            ).not.toContain('provider not found');
        }

        // Finally: the vercel gateway is NOT a system plugin, so — unlike openrouter,
        // whose /disable is rejected 400 — it disables cleanly and reports disabled.
        const disabled = await disablePluginViaAPI(request, token, GATEWAY);
        expect(disabled.id, 'disable echoes the gateway id').toBe(GATEWAY);
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, GATEWAY)).enabled, {
                timeout: 15_000,
                message: 'the non-system gateway is disabled cleanly',
            })
            .toBeFalsy();

        // Once disabled, an override to the gateway is once again an unresolvable
        // "not found" — the disable truly took effect at the resolution layer.
        const afterDisable = await complete(request, token, { providerOverride: GATEWAY });
        expect(afterDisable.status, 'override to a disabled gateway → 422').toBe(422);
        expect(
            afterDisable.errorMessage ?? '',
            'a disabled gateway is no longer a resolvable provider',
        ).toContain(`provider not found: ${GATEWAY}`);
    });
});
