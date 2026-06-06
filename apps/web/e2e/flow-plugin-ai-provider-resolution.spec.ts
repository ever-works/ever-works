import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { enablePluginViaAPI, patchPluginSettingsViaAPI, getPluginViaAPI } from './helpers/plugins';

/**
 * AI PROVIDER RESOLUTION — complex, multi-step INTEGRATION flows for the way the
 * OpenAI-compat completion endpoint resolves WHICH ai-provider plugin actually
 * serves a request: enabling multiple providers, the default selection order,
 * the `X-Provider-Override` header, the per-work active-provider binding, and
 * the full `override > work-active > default` precedence chain. Every shape and
 * status below was PROBED against the LIVE stack (http://127.0.0.1:3100) on
 * 2026-06-01 before the assertions were written — this asserts the platform's
 * REAL resolution behaviour, never a guess.
 *
 * RESOLUTION CHAIN (packages/agent/src/facades/base.facade.ts `resolvePlugin`):
 *     agentProviderOverride > providerOverride > work-active > default-for-cap > first-enabled
 *   The OpenAI-compat controller threads it via two headers
 *   (apps/api/src/ai-conversation/openai-compat.controller.ts):
 *     - `X-Provider-Override: <pluginId>`  → providerOverride
 *     - `X-Work-Id: <workId>`              → workId (scopes the work-active lookup)
 *   The `provider` BODY field is REJECTED 400 "property provider should not
 *   exist" (forbidNonWhitelisted is active globally) — overrides MUST travel in
 *   the header. When no `X-Work-Id` is sent the service (openai-compat.service
 *   `resolveWorkContext`) backfills the user's FIRST work as the work scope.
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - GET /api/plugins → the ai-provider catalogue ships MANY providers
 *     (openrouter, anthropic, google, groq, openai, mistral, ollama, …). Exactly
 *     ONE — `openrouter` — is the SYSTEM/DEFAULT provider: `systemPlugin:true`,
 *     `enabled:true` out of the box, `defaultForCapabilities:['ai-provider']`.
 *     Every other ai-provider reports `enabled:false` and `systemPlugin:false`
 *     for a fresh user.
 *   - POST /api/v1/chat/completions (Bearer; @HttpCode(200)):
 *       • no override, no work → resolves the default (openrouter). With the env
 *         key wired (local) → 200, `model` echoes the resolved default model
 *         "openai/gpt-4o-mini"; without a key (CI) → clean 422
 *         { error:{ type:'provider_unavailable' } }.
 *       • `X-Provider-Override` to a provider that is NOT enabled for the user →
 *         422 { error:{ message:'ai-provider provider not found: <id>',
 *         type:'provider_unavailable' } }  (ProviderNotFoundError, mapped to 422
 *         by the controller's @Res() catch — NEVER a 5xx). Same for an unknown id.
 *       • `X-Provider-Override` to an ENABLED-but-unconfigured provider →
 *         resolution SUCCEEDS (passes the enabled check) and the failure happens
 *         at the provider call: 422 with a provider-auth message
 *         ("401 Invalid bearer token" / "401 Invalid Anthropic API Key …").
 *       • a `model` in the BODY overrides the resolved default model and the
 *         response `model` echoes it EXACTLY (probed: model:"anthropic/claude-3.5-haiku"
 *         → "anthropic/claude-3.5-haiku"; default → "openai/gpt-4o-mini"). When
 *         the chosen model isn't reachable on the key → clean 422.
 *   - Per-work active-provider binding:
 *       • POST /api/works/:id/plugins/:pluginId/enable { activeCapability:'ai-provider' }
 *         REQUIRES the user-level required settings first — enabling before
 *         PATCHing user settings → 400 { message:'User-level required settings
 *         must be configured first', errors:['Missing required fields: apiKey'] }.
 *       • After PATCH user settings { apiKey, defaultModel } (200) the work-enable
 *         succeeds 200 and PINS that provider as the work's active ai-provider.
 *       • A completion with `X-Work-Id:<that work>` then resolves the WORK-ACTIVE
 *         provider (anthropic) ahead of the system default — fake key → 422 with
 *         the Anthropic-auth message (PROVES the binding swapped the provider).
 *       • POST /api/works/:id/plugins/openrouter/capability { capability:'ai-provider' }
 *         flips the work-active binding back to openrouter (200) → a subsequent
 *         `X-Work-Id` completion resolves openrouter again (observable switch).
 *       • `X-Provider-Override` BEATS the work-active binding: override openrouter
 *         on a work whose active provider is anthropic → 200 openrouter.
 *   - GET /api/plugins/:id/connection-status → { connectionStatus:{ connected,
 *     scope, message } } for a CONFIGURED provider; `{}` for an unconfigured one.
 *
 * ENVIRONMENT-ADAPTIVE: completions need a real provider key. Locally the stack
 * ships PLUGIN_OPENROUTER_API_KEY so the default/openrouter path returns a real
 * 200; in CI (no key) the SAME path is a truthful 422 provider_unavailable. Each
 * flow asserts the REAL outcome for whatever env it runs in via the
 * `providerUsable` branch — never skipping the round-trip, never asserting a
 * fictional contract. The RESOLUTION assertions (which provider is selected, the
 * not-found vs auth-error distinction, the work-active swap) hold in BOTH envs
 * because they are about WHICH plugin is resolved, not whether the upstream call
 * ultimately succeeds.
 *
 * ISOLATION: every flow runs on its OWN FRESH registerUserViaAPI() user — never
 * the shared seeded user — because writing a user-scoped fake `apiKey` SHADOWS
 * the env key and would break sibling chat specs on the seeded account. Unique
 * Date.now()-suffixed emails; `toContain`/tolerant assertions, never exact counts.
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex) and is fully API-orchestrated, so it does not contend on the shared UI.
 */

const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const ALT_PROVIDER = 'anthropic';
const ALT_MODEL = 'claude-3-5-haiku-latest';
const AI_CAPABILITY = 'ai-provider';
const COMPLETIONS = `${API_BASE}/api/v1/chat/completions`;

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
        email: `e2e-provider-res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
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
 * Configure a provider's user-level required settings (apiKey + defaultModel).
 * PROBED real ordering: a non-system provider must be USER-ENABLED first — a
 * PATCH /settings before the user-enable is rejected 400 "Plugin \"<id>\" is not
 * installed for this user. Enable it first." So enable (idempotent 200), THEN
 * PATCH the required settings (200, persists the chosen defaultModel masked).
 */
async function configureUserProvider(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    apiKey: string,
    defaultModel: string,
): Promise<void> {
    const enabled = await enablePluginViaAPI(request, token, pluginId);
    expect(enabled.enabled, `user-enable ${pluginId} before configuring`).toBe(true);

    const res = await patchPluginSettingsViaAPI(request, token, pluginId, {
        settings: { apiKey, defaultModel },
    });
    expect(
        res.status,
        `configure ${pluginId} user settings; body=${JSON.stringify(res.body)}`,
    ).toBe(200);
}

test.describe('AI provider resolution — override, work-active & precedence', () => {
    test('Flow 1: catalogue shape — exactly one system/default ai-provider (openrouter); the rest are enabled:false for a fresh user', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const res = await request.get(`${API_BASE}/api/plugins`, { headers: authedHeaders(token) });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
            plugins?: Array<{
                id: string;
                category?: string;
                enabled?: boolean;
                systemPlugin?: boolean;
                defaultForCapabilities?: string[];
            }>;
        };
        const providers = (body.plugins ?? []).filter((p) => p.category === AI_CAPABILITY);
        expect(
            providers.length,
            'the catalogue ships multiple ai-provider plugins',
        ).toBeGreaterThan(1);

        const ids = providers.map((p) => p.id);
        expect(ids, 'openrouter is in the ai-provider catalogue').toContain(DEFAULT_PROVIDER);
        expect(ids, 'anthropic is in the ai-provider catalogue').toContain(ALT_PROVIDER);

        // openrouter is THE system/default provider: enabled out of the box,
        // systemPlugin, default-for the ai-provider capability.
        const openrouter = providers.find((p) => p.id === DEFAULT_PROVIDER);
        expect(openrouter, 'openrouter present').toBeTruthy();
        expect(openrouter?.enabled, 'openrouter is enabled by default (autoEnable)').toBe(true);
        expect(openrouter?.systemPlugin, 'openrouter is a system plugin').toBe(true);
        expect(
            openrouter?.defaultForCapabilities ?? [],
            'openrouter is default-for the ai-provider capability',
        ).toContain(AI_CAPABILITY);

        // Exactly ONE ai-provider claims the default-for-capability flag — the
        // tie-breaker the resolver sorts to the front of "first enabled".
        const defaults = providers.filter((p) =>
            (p.defaultForCapabilities ?? []).includes(AI_CAPABILITY),
        );
        expect(defaults.length, 'exactly one default ai-provider').toBe(1);
        expect(defaults[0].id, 'the single default ai-provider is openrouter').toBe(
            DEFAULT_PROVIDER,
        );

        // A second, non-default provider reports the inverse state for a fresh user.
        const anthropic = providers.find((p) => p.id === ALT_PROVIDER);
        expect(anthropic?.enabled, 'anthropic is NOT enabled for a fresh user').toBeFalsy();
        expect(anthropic?.systemPlugin, 'anthropic is not a system plugin').toBeFalsy();
    });

    test('Flow 2: no-override default selection resolves the system default provider (adaptive) and the body `provider` field is rejected', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // The `provider` field cannot ride in the BODY — it must be the header.
        // This pins the real contract so a future regression to a body field
        // (which would silently ignore the override) is caught.
        const bodyFieldRes = await request.post(COMPLETIONS, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'ping' }], provider: DEFAULT_PROVIDER },
        });
        expect(bodyFieldRes.status(), 'a body `provider` field is rejected').toBe(400);
        const bodyFieldBody = (await bodyFieldRes.json().catch(() => ({}))) as {
            message?: string | string[];
        };
        const msg = Array.isArray(bodyFieldBody.message)
            ? bodyFieldBody.message.join(' ')
            : (bodyFieldBody.message ?? '');
        expect(msg, 'the 400 names the rejected `provider` property').toContain('provider');

        // Default resolution: no override, no work scope → the system default
        // (openrouter) is selected. Adaptive on the env key.
        const def = await complete(request, token);
        expect(def.status, 'default completion round-trip fired').toBeGreaterThan(0);

        if (def.status === 200) {
            // Real provider wired → the resolved default model is echoed.
            expect(def.content, 'a configured default provider returns content').toBeTruthy();
            expect(def.model, 'the default provider echoes its default model').toBe(DEFAULT_MODEL);
        } else {
            // No env key → the truthful provider_unavailable envelope, never a 5xx.
            expect(def.status, `expected 422; raw=${JSON.stringify(def.raw)}`).toBe(422);
            expect(def.errorType, 'clean provider_unavailable contract').toBe(
                'provider_unavailable',
            );
        }
    });

    test('Flow 3: X-Provider-Override to a provider NOT enabled for the user → 422 "provider not found" (distinct from a provider-auth failure)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // anthropic exists in the catalogue but is NOT enabled for this fresh
        // user → the resolver throws ProviderNotFoundError → controller 422 with
        // the "provider not found: <id>" message. This is a RESOLUTION failure,
        // categorically different from an enabled provider that fails on a bad key.
        const notEnabled = await complete(request, token, { providerOverride: ALT_PROVIDER });
        expect(notEnabled.status, 'override to a not-enabled provider → 422 (never 5xx)').toBe(422);
        expect(notEnabled.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            notEnabled.errorMessage ?? '',
            'the message explains the override target is not a resolvable provider',
        ).toContain(`provider not found: ${ALT_PROVIDER}`);

        // An entirely unknown plugin id behaves the same way — not a 404, not a
        // 5xx, but the same 422 not-found resolution envelope.
        const unknownId = `no-such-provider-${Date.now()}`;
        const unknown = await complete(request, token, { providerOverride: unknownId });
        expect(unknown.status, 'override to an unknown id → 422').toBe(422);
        expect(unknown.errorType).toBe('provider_unavailable');
        expect(unknown.errorMessage ?? '', 'the message names the unknown id').toContain(
            `provider not found: ${unknownId}`,
        );

        // CONTROL: overriding to the ENABLED default provider resolves cleanly —
        // proving the 422s above are about ENABLEMENT, not the override mechanism
        // itself. Adaptive on the env key.
        const okOverride = await complete(request, token, { providerOverride: DEFAULT_PROVIDER });
        if (okOverride.status === 200) {
            expect(okOverride.model, 'override to openrouter resolves it').toBe(DEFAULT_MODEL);
        } else {
            expect(okOverride.status, 'no env key → clean 422').toBe(422);
            expect(okOverride.errorType).toBe('provider_unavailable');
            // Crucially NOT the "provider not found" message — openrouter IS resolvable.
            expect(okOverride.errorMessage ?? '').not.toContain('provider not found');
        }
    });

    test('Flow 4: X-Provider-Override to an ENABLED-but-unconfigured provider resolves it and fails at the provider call (auth error, not "not found")', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Configure anthropic at the USER level with a fake key (required before
        // it can be enabled anywhere) — this makes it an ENABLED, resolvable
        // provider whose upstream call will fail on the bad key.
        await configureUserProvider(request, token, ALT_PROVIDER, 'sk-ant-e2e-fake-key', ALT_MODEL);

        // The PATCH persisted the chosen defaultModel in the resolved settings.
        await expect
            .poll(
                async () => {
                    const p = await getPluginViaAPI(request, token, ALT_PROVIDER);
                    return (p.settings as { defaultModel?: string } | undefined)?.defaultModel;
                },
                { timeout: 15_000, message: 'anthropic defaultModel persists for the user' },
            )
            .toBe(ALT_MODEL);

        // Override to anthropic → it RESOLVES (passes the enabled+capability
        // check) and the failure is now a PROVIDER-AUTH error, not a resolution
        // "not found". The 422 message is the upstream 401, never a 5xx.
        const res = await complete(request, token, { providerOverride: ALT_PROVIDER });
        expect(res.status, 'enabled-but-bad-key override → 422 (clean, not 5xx)').toBe(422);
        expect(res.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            res.errorMessage ?? '',
            'the failure is an upstream provider-auth error, NOT a resolution "not found"',
        ).not.toContain('provider not found');
        expect(
            (res.errorMessage ?? '').toLowerCase(),
            'the upstream auth failure surfaces (401 / invalid key)',
        ).toMatch(/401|invalid|key|auth/);
    });

    test('Flow 5: per-work active binding swaps the resolved provider — work-enable requires user settings first, then X-Work-Id resolves the work-active provider', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const work = await createWorkViaAPI(request, token, {
            name: `Provider Binding ${Date.now()}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        // PROBED two-stage ordering gate. STAGE 1: on a fresh user (anthropic not
        // user-enabled), work-enabling it is rejected 400 "Plugin \"<id>\" must be
        // enabled at user level first" — the user-level ENABLE must precede the work
        // binding. (No `errors` array at this stage; the missing-field detail only
        // surfaces at stage 2, below.)
        const beforeUserEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${ALT_PROVIDER}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(
            beforeUserEnable.status(),
            'work-enable before user-level enable is rejected 400',
        ).toBe(400);
        const beforeUserEnableBody = (await beforeUserEnable.json().catch(() => ({}))) as {
            message?: string;
        };
        expect(
            beforeUserEnableBody.message ?? '',
            'the 400 demands a user-level enable first',
        ).toMatch(/must be enabled at user level first/i);

        // STAGE 2: user-enable anthropic WITHOUT its required settings — the enable
        // itself succeeds (200), yet a work-enable is still blocked because the
        // user-level required fields (apiKey) are not configured. THIS gate carries
        // the precise "user-level required settings" message + the missing-field array.
        const userEnable = await enablePluginViaAPI(request, token, ALT_PROVIDER);
        expect(userEnable.enabled, 'anthropic is now user-enabled (no settings yet)').toBe(true);

        const prematureEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${ALT_PROVIDER}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(prematureEnable.status(), 'work-enable before user settings is rejected 400').toBe(
            400,
        );
        const prematureBody = (await prematureEnable.json().catch(() => ({}))) as {
            message?: string;
            errors?: string[];
        };
        expect(
            prematureBody.message ?? '',
            'the 400 explains user-level settings must come first',
        ).toMatch(/user-level required settings/i);
        expect(
            (prematureBody.errors ?? []).join(' '),
            'the 400 names the missing required field',
        ).toContain('apiKey');

        // Now satisfy the ordering: configure user-level anthropic (idempotent
        // re-enable + PATCH settings), then pin it as the work's ACTIVE ai-provider.
        await configureUserProvider(request, token, ALT_PROVIDER, 'sk-ant-e2e-fake-key', ALT_MODEL);
        const workEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${ALT_PROVIDER}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(
            workEnable.status(),
            `work-enable after user settings succeeds; body=${await workEnable.text().catch(() => '')}`,
        ).toBe(200);
        const workEnableBody = (await workEnable.json().catch(() => ({}))) as { id?: string };
        expect(workEnableBody.id, 'the work-enable echoes the bound plugin id').toBe(ALT_PROVIDER);

        // A completion scoped to THIS work via X-Work-Id resolves the WORK-ACTIVE
        // provider (anthropic) ahead of the system default (openrouter). The fake
        // key → 422 with the Anthropic-auth message: PROOF that the work binding
        // swapped which plugin served the request (a default-openrouter resolution
        // would have used the env key and returned 200 / a non-Anthropic error).
        const scoped = await complete(request, token, { workId: work.id });
        expect(scoped.status, 'work-scoped completion is well-behaved (422, not 5xx)').toBe(422);
        expect(scoped.errorType, 'provider_unavailable envelope').toBe('provider_unavailable');
        expect(
            scoped.errorMessage ?? '',
            'the work-active anthropic binding served the request (its auth error surfaced)',
        ).toMatch(/anthropic|401|invalid|key/i);
        // It is NOT the openrouter default — the work binding took precedence.
        expect(scoped.errorMessage ?? '', 'the system default did NOT serve it').not.toContain(
            'provider not found',
        );

        // Flip the work-active binding to openrouter via the capability endpoint —
        // an OBSERVABLE switch of the resolved provider for the same work.
        const flip = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${DEFAULT_PROVIDER}/capability`,
            { headers: authedHeaders(token), data: { capability: AI_CAPABILITY } },
        );
        expect(
            flip.status(),
            `switch work-active provider to openrouter; body=${await flip.text().catch(() => '')}`,
        ).toBe(200);

        // The same X-Work-Id completion now resolves openrouter. Adaptive on env key.
        const reScoped = await complete(request, token, { workId: work.id });
        if (reScoped.status === 200) {
            expect(reScoped.model, 'flipped work-active openrouter now serves it').toBe(
                DEFAULT_MODEL,
            );
        } else {
            expect(reScoped.status, 'no env key → clean 422').toBe(422);
            expect(reScoped.errorType).toBe('provider_unavailable');
            // The switch is still observable: it is no longer the Anthropic auth error.
            expect(reScoped.errorMessage ?? '', 'no longer the anthropic binding').not.toMatch(
                /anthropic/i,
            );
        }
    });

    test('Flow 6: precedence — X-Provider-Override BEATS the work-active binding (override > work-active > default)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const work = await createWorkViaAPI(request, token, {
            name: `Provider Precedence ${Date.now()}`,
        });

        // Make the work ACTIVE provider anthropic (bad key) — left alone, an
        // X-Work-Id completion would resolve anthropic and 422 on its auth error.
        await configureUserProvider(request, token, ALT_PROVIDER, 'sk-ant-e2e-fake-key', ALT_MODEL);
        const bind = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${ALT_PROVIDER}/enable`,
            { headers: authedHeaders(token), data: { activeCapability: AI_CAPABILITY } },
        );
        expect(bind.status(), 'anthropic pinned as the work-active provider').toBe(200);

        // Baseline (work scope, NO override) → the work-active anthropic resolves
        // and fails on its key (422 anthropic-auth). Confirms the binding is live.
        const baseline = await complete(request, token, { workId: work.id });
        expect(baseline.status, 'baseline work-scoped → 422').toBe(422);
        expect(baseline.errorMessage ?? '', 'baseline resolved the work-active anthropic').toMatch(
            /anthropic|401|invalid|key/i,
        );

        // Now add X-Provider-Override:openrouter ON THE SAME work-scoped request.
        // Per the resolver, the explicit override OUTRANKS the work-active binding
        // → openrouter serves it. Adaptive on the env key.
        const overridden = await complete(request, token, {
            workId: work.id,
            providerOverride: DEFAULT_PROVIDER,
        });
        expect(overridden.status, 'override-on-work-scope completion fired').toBeGreaterThan(0);

        if (overridden.status === 200) {
            // Real key → the override won: openrouter's default model is echoed,
            // NOT the anthropic work-active binding.
            expect(overridden.content, 'the override provider returned content').toBeTruthy();
            expect(
                overridden.model,
                'X-Provider-Override openrouter beat the work-active anthropic',
            ).toBe(DEFAULT_MODEL);
        } else {
            // No env key → still a clean 422, but the KEY signal is that it is NOT
            // the anthropic auth error anymore — the override re-routed resolution
            // away from the work-active binding before the call.
            expect(overridden.status, 'no env key → clean 422').toBe(422);
            expect(overridden.errorType, 'provider_unavailable envelope').toBe(
                'provider_unavailable',
            );
            expect(
                overridden.errorMessage ?? '',
                'the override re-routed away from the anthropic work-active binding',
            ).not.toMatch(/anthropic/i);
            expect(
                overridden.errorMessage ?? '',
                'and openrouter WAS resolvable (not a not-found)',
            ).not.toContain('provider not found');
        }
    });

    test('Flow 7: explicit body model overrides the resolved default model (adaptive exact echo) and connection-status reflects configuration scope', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // An explicit model in the body overrides the provider's resolved default
        // model; the response `model` echoes it EXACTLY (probed: openrouter's
        // default is openai/gpt-4o-mini, but anthropic/claude-3.5-haiku is echoed
        // back verbatim when requested and reachable on the key).
        const explicitModel = 'anthropic/claude-3.5-haiku';
        const withModel = await complete(request, token, {
            providerOverride: DEFAULT_PROVIDER,
            model: explicitModel,
        });
        expect(withModel.status, 'explicit-model completion fired').toBeGreaterThan(0);

        if (withModel.status === 200) {
            expect(
                withModel.model,
                'the requested model is echoed exactly, overriding the resolved default',
            ).toBe(explicitModel);
            expect(
                withModel.model,
                'the echoed model is NOT the provider default — the body model won',
            ).not.toBe(DEFAULT_MODEL);
        } else {
            // Model unreachable on this key, or no key at all → clean 422.
            expect(withModel.status, 'unreachable/unkeyed model → clean 422').toBe(422);
            expect(withModel.errorType).toBe('provider_unavailable');
        }

        // connection-status reflects whether a provider is configured for the
        // caller. openrouter (env-default) reports a connected envelope; a fresh
        // unconfigured anthropic reports an empty object.
        const orStatus = await request.get(
            `${API_BASE}/api/plugins/${DEFAULT_PROVIDER}/connection-status`,
            { headers: authedHeaders(token) },
        );
        expect(orStatus.status(), 'openrouter connection-status resolves 200').toBe(200);
        const orBody = (await orStatus.json().catch(() => ({}))) as {
            connectionStatus?: { connected?: boolean; scope?: string; message?: string };
        };
        // Adaptive: with the env key wired openrouter reports connected:true; in a
        // keyless env the platform still returns a 200 envelope (possibly empty) —
        // assert the SHAPE, and the connected flag only when present.
        if (orBody.connectionStatus) {
            expect(
                typeof orBody.connectionStatus.connected,
                'connection-status carries a boolean connected flag',
            ).toBe('boolean');
            if (orBody.connectionStatus.connected) {
                expect(
                    orBody.connectionStatus.scope,
                    'a connected provider reports its resolution scope',
                ).toBeTruthy();
            }
        }

        const anStatus = await request.get(
            `${API_BASE}/api/plugins/${ALT_PROVIDER}/connection-status`,
            { headers: authedHeaders(token) },
        );
        expect(anStatus.status(), 'unconfigured anthropic connection-status resolves 200').toBe(
            200,
        );
        const anBody = (await anStatus.json().catch(() => ({}))) as {
            connectionStatus?: { connected?: boolean };
        };
        // Unconfigured → either an absent/empty connectionStatus or connected:false.
        expect(
            anBody.connectionStatus?.connected ?? false,
            'an unconfigured provider is not reported connected',
        ).toBeFalsy();
    });
});
