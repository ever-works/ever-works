import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { patchPluginSettingsViaAPI } from './helpers/plugins';

/**
 * PER-WORK AI PLUGIN ENABLEMENT — complex, multi-step INTEGRATION flows for the
 * way an AI-provider plugin becomes ACTIVE for a single Work: the user→work
 * enablement ordering, `autoEnableForWorks` inheritance into existing + future
 * works, a per-work override that opts a work OUT of (or INTO) a provider, the
 * single-active-provider-per-capability binding (work-level override of the
 * user provider), and the per-work isolation guarantee. Every shape, status and
 * message below was PROBED against the LIVE stack (http://127.0.0.1:3100) on
 * 2026-06-01 before the assertions were written — this asserts the platform's
 * REAL behaviour, never a guess.
 *
 * WHY THIS IS DISTINCT from the sibling specs:
 *   - flow-plugin-ai-provider-resolution.spec.ts asserts which provider a
 *     /api/v1/chat/completions request RESOLVES (X-Work-Id / X-Provider-Override
 *     precedence at completion time).
 *   - flow-plugin-ai-matrix.spec.ts asserts the USER-level OpenRouter contract.
 *   - flow-work-pipeline-plugin-binding.spec.ts asserts the PIPELINE binding via
 *     the generator-form schema.
 *   THIS file asserts the per-work PLUGIN-RECORD state machine itself — the
 *   `POST/GET /api/works/:id/plugins[...]` surface and the `workEnabled` /
 *   `activeCapabilities` / `capabilityProviders` projection it produces — which
 *   none of the above touch.
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - Catalogue: `openrouter` is the ONLY system/default ai-provider
 *     (systemPlugin:true, autoEnable:true, enabled:true out of the box).
 *     `anthropic` / `openai` / `google` are NON-system, NON-autoEnable, NOT
 *     enabled for a fresh user — the perfect drivers for per-work enablement.
 *     `tavily` is the system/default `search` provider.
 *
 *   - GET /api/works/:workId/plugins (owner; @CurrentUser-guarded)
 *       → { plugins: WorkPlugin[], total, capabilityProviders }.
 *     Each WorkPlugin carries BOTH scopes:
 *       enabled            — USER-level enable (resolvePluginEnabled, no work ctx)
 *       autoEnableForWorks — the user-level "cascade to all works" flag
 *       workEnabled        — the RESOLVED enable for THIS work
 *       activeCapabilities — the capabilities this plugin is the active provider
 *                            for IN THIS WORK (e.g. ['ai-provider'])
 *       workPluginId       — present IFF an explicit per-work record exists
 *                            (absent ⇒ the work INHERITS its state)
 *     `capabilityProviders` is the resolved { capability → pluginId } map for the
 *     work — the single ACTIVE provider per capability (probed: a work with no
 *     overrides has {}; binding anthropic ⇒ { 'ai-provider':'anthropic' }).
 *
 *   - resolvePluginEnabled priority (packages/agent .../plugin-registry.service):
 *       1. systemPlugin            → always workEnabled (openrouter never off)
 *       2. user-level DISABLED     → cascades globally (work false even w/ record)
 *       3. explicit work record    → use ITS enabled value (overrides 4)
 *       4. user autoEnableForWorks → workEnabled true (NO per-work record needed)
 *       5. user enabled, no flag   → enabled at user scope, FALSE inside a work
 *       6. fallback manifest autoEnable (default false)
 *
 *   - POST /api/works/:workId/plugins/:pluginId/enable { activeCapability?, settings?, priority? }
 *       • the plugin must be enabled at USER level first, else
 *         400 { message:'Plugin "<id>" must be enabled at user level first' }.
 *       • once user-enabled, the plugin's USER-LEVEL REQUIRED settings must exist,
 *         else 400 { message:'User-level required settings must be configured
 *         first', errors:['Missing required fields: apiKey'] }.
 *       • after PATCH user settings {apiKey,defaultModel} (200) the work-enable
 *         succeeds 200 → workEnabled:true, activeCapabilities:[activeCapability],
 *         a workPluginId is minted, and capabilityProviders binds the capability.
 *       • adding `activeCapability:'ai-provider'` does NOT exclusively clear other
 *         providers (that is /capability's job) — two enabled providers can both
 *         carry the active cap; the resolved map picks one.
 *
 *   - POST /api/works/:workId/plugins/:pluginId/disable
 *       • mints/flips an explicit work record to enabled:false → workEnabled:false
 *         EVEN WHEN the user has autoEnableForWorks:true (priority 3 beats 4).
 *         The user-level `enabled` is untouched (still true).
 *       • a SYSTEM plugin (openrouter) cannot be disabled per-work → 400
 *         { message:'Plugin "openrouter" is a system plugin and cannot be disabled' }.
 *
 *   - POST /api/works/:workId/plugins/:pluginId/capability { capability }
 *       • EXCLUSIVE: sets this plugin as the active provider AND clears that
 *         capability from every OTHER plugin in the work → capabilityProviders
 *         resolves deterministically to one id. It also force-enables the work
 *         record (workEnabled:true).
 *       • the plugin must already be enabled for the work, else 400
 *         { message:'Plugin "<id>" is not enabled for this work. Enable it first.' }.
 *       • the plugin must actually OWN the capability, else 400
 *         { message:'Plugin "<id>" does not provide capability "<cap>"' }; an
 *         unknown capability string is rejected by the DTO validator (400).
 *
 *   - AUTH/OWNERSHIP (ensureCanView / ensureCanEdit): owner → 200; a DIFFERENT
 *     authed user → 403; a nonexistent work id → 404; anonymous (no bearer) → 401.
 *
 * ISOLATION (cross-spec): every flow runs on its OWN FRESH registerUserViaAPI()
 * user — NEVER the shared seeded user — because work-enabling a provider writes a
 * user-scoped fake `apiKey` that SHADOWS the env key and would break sibling chat
 * specs on the seeded account. Unique Date.now()-suffixed emails; tolerant
 * assertions (toContain / .or(), no exact catalogue counts). The `flow-` filename
 * prefix is NOT matched by the playwright.config no-auth testIgnore regex, and the
 * file is fully API-orchestrated so it does not contend on the shared UI/stack.
 *
 * ENVIRONMENT-ADAPTIVE: nothing here depends on an LLM key or Trigger.dev — every
 * assertion is about the per-work plugin RECORD/binding state, which is identical
 * whether or not a provider key is wired, so the file is green in CI and locally.
 */

const SYSTEM_AI = 'openrouter';
const SYSTEM_SEARCH = 'tavily';
const ALT_AI = 'anthropic';
const ALT_AI_2 = 'openai';
const AI_CAPABILITY = 'ai-provider';
const ALT_AI_MODEL = 'claude-3-5-haiku-latest';
const ALT_AI_2_MODEL = 'gpt-4o-mini';

interface WorkPlugin {
    id: string;
    enabled?: boolean;
    autoEnableForWorks?: boolean;
    workEnabled?: boolean;
    activeCapabilities?: string[];
    workPluginId?: string;
    installed?: boolean;
    systemPlugin?: boolean;
    priority?: number;
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
        email: `e2e-perwork-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
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

/** Configure a provider's user-level required settings (apiKey + defaultModel). */
async function configureUserProvider(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    defaultModel: string,
): Promise<void> {
    const res = await patchPluginSettingsViaAPI(request, token, pluginId, {
        settings: { apiKey: `sk-${pluginId}-e2e-fake-key`, defaultModel },
    });
    expect(
        res.status,
        `configure ${pluginId} user settings; body=${JSON.stringify(res.body)}`,
    ).toBe(200);
}

/** Enable a non-system provider at the USER level (idempotent, optional flag). */
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

test.describe('Per-work AI plugin enablement — inherit / override / bind / isolate', () => {
    test('Flow 1: user→work enablement ORDERING — a non-system provider must be user-enabled AND user-configured before a work can bind it', async ({
        request,
    }) => {
        const token = await freshToken(request, 'order');
        const work = await createWorkViaAPI(request, token, { name: `Order ${Date.now()}` });
        expect(work.id, 'work created').toBeTruthy();

        // BASELINE: a fresh work inherits the catalogue. The system ai-provider
        // (openrouter) is already workEnabled (priority 1); the non-system
        // anthropic is NOT (priority 6 fallback false) and has no per-work record.
        const baseline = await listWorkPlugins(request, token, work.id);
        const orBase = rowFor(baseline, SYSTEM_AI);
        expect(orBase?.systemPlugin, 'openrouter is a system plugin').toBe(true);
        expect(orBase?.workEnabled, 'the system ai-provider is workEnabled by default').toBe(true);
        const altBase = rowFor(baseline, ALT_AI);
        expect(altBase, 'anthropic is present in the per-work catalogue').toBeTruthy();
        expect(altBase?.enabled, 'anthropic is NOT user-enabled for a fresh user').toBeFalsy();
        expect(altBase?.workEnabled, 'anthropic is NOT workEnabled for a fresh work').toBeFalsy();
        expect(altBase?.workPluginId, 'anthropic has no explicit per-work record yet').toBeFalsy();

        // STEP 1: work-enabling before the USER-level enable is a precise 400.
        const beforeUserEnable = await workPluginAction(request, token, work.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(beforeUserEnable.status, 'work-enable before user-enable → 400').toBe(400);
        expect(
            String(beforeUserEnable.body.message ?? ''),
            'the 400 demands a user-level enable first',
        ).toMatch(/must be enabled at user level first/i);

        // STEP 2: user-enable anthropic but WITHOUT its required settings — the
        // user-enable itself succeeds (200), yet a work-enable is still blocked
        // because the user-level required fields (apiKey) are not configured.
        const ue = await userEnable(request, token, ALT_AI);
        expect(ue.status, 'user-enable anthropic (no settings) succeeds').toBe(200);
        expect(ue.body.enabled, 'anthropic now user-enabled').toBe(true);

        const beforeSettings = await workPluginAction(request, token, work.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(beforeSettings.status, 'work-enable before user settings → 400').toBe(400);
        expect(
            String(beforeSettings.body.message ?? ''),
            'the 400 explains user-level required settings must come first',
        ).toMatch(/user-level required settings must be configured first/i);
        expect(
            ((beforeSettings.body.errors as string[]) ?? []).join(' '),
            'the 400 names the missing required field',
        ).toContain('apiKey');

        // STEP 3: configure the user-level required settings, then the work-enable
        // finally succeeds and the per-work binding materialises.
        await configureUserProvider(request, token, ALT_AI, ALT_AI_MODEL);
        const enabled = await workPluginAction(request, token, work.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(
            enabled.status,
            `work-enable after user settings → 200; body=${JSON.stringify(enabled.body)}`,
        ).toBe(200);
        expect(enabled.body.id, 'the enable echoes the plugin id').toBe(ALT_AI);
        expect(enabled.body.workEnabled, 'anthropic is now workEnabled for this work').toBe(true);
        expect(
            enabled.body.activeCapabilities,
            'anthropic is the active ai-provider for this work',
        ).toContain(AI_CAPABILITY);

        // And the per-work list now reflects an explicit, active, capability-bound record.
        const after = await listWorkPlugins(request, token, work.id);
        const altAfter = rowFor(after, ALT_AI);
        expect(altAfter?.workEnabled, 'anthropic workEnabled in the list').toBe(true);
        expect(altAfter?.workPluginId, 'an explicit per-work record now exists').toBeTruthy();
        expect(after.capabilityProviders?.[AI_CAPABILITY], 'work binds ai-provider→anthropic').toBe(
            ALT_AI,
        );
    });

    test('Flow 2: autoEnableForWorks INHERITANCE — a user flag makes a provider workEnabled in EXISTING + FUTURE works with no per-work record', async ({
        request,
    }) => {
        const token = await freshToken(request, 'inherit');

        // A work created BEFORE the flag is set — it must retroactively inherit.
        const preWork = await createWorkViaAPI(request, token, {
            name: `Inherit Pre ${Date.now()}`,
        });
        expect(preWork.id).toBeTruthy();

        // Baseline: anthropic is not workEnabled anywhere yet.
        const pre0 = rowFor(await listWorkPlugins(request, token, preWork.id), ALT_AI);
        expect(
            pre0?.workEnabled,
            'pre-existing work: anthropic not workEnabled initially',
        ).toBeFalsy();

        // Set autoEnableForWorks:true at the user level (with its required settings,
        // so the user record is fully configured). This is the "cascade to all
        // works" switch — priority 4 in resolvePluginEnabled.
        const ue = await userEnable(request, token, ALT_AI, {
            settings: { apiKey: `sk-${ALT_AI}-e2e-fake-key`, defaultModel: ALT_AI_MODEL },
            autoEnableForWorks: true,
        });
        expect(ue.status, 'user-enable with autoEnableForWorks succeeds').toBe(200);
        expect(ue.body.autoEnableForWorks, 'the cascade flag is persisted').toBe(true);

        // The PRE-EXISTING work now inherits workEnabled:true WITHOUT any per-work
        // record (workPluginId stays absent — pure inheritance, not an explicit row).
        await expect
            .poll(
                async () => {
                    const r = rowFor(await listWorkPlugins(request, token, preWork.id), ALT_AI);
                    return { we: r?.workEnabled, wid: r?.workPluginId };
                },
                { timeout: 15_000, message: 'pre-existing work inherits the user cascade flag' },
            )
            .toEqual({ we: true, wid: undefined });

        // A work created AFTER the flag also inherits it (forward inheritance).
        const postWork = await createWorkViaAPI(request, token, {
            name: `Inherit Post ${Date.now()}`,
        });
        const postRow = rowFor(await listWorkPlugins(request, token, postWork.id), ALT_AI);
        expect(postRow?.workEnabled, 'a future work also inherits the cascade flag').toBe(true);
        expect(
            postRow?.workPluginId,
            'forward inheritance is implicit (no explicit per-work record)',
        ).toBeFalsy();

        // Inheritance enables the plugin but does NOT make it the ACTIVE capability
        // provider — capabilityProviders stays empty until an explicit binding.
        const postList = await listWorkPlugins(request, token, postWork.id);
        expect(
            postList.capabilityProviders?.[AI_CAPABILITY],
            'inheritance alone does not bind the active ai-provider',
        ).toBeFalsy();
        expect(
            postRow?.activeCapabilities ?? [],
            'inherited plugin carries no active capability',
        ).not.toContain(AI_CAPABILITY);
    });

    test('Flow 3: per-work OVERRIDE opts a single work OUT of the inherited provider (priority 3 beats 4), leaving siblings + user scope intact', async ({
        request,
    }) => {
        const token = await freshToken(request, 'optout');

        // Cascade anthropic to all works for this user.
        const ue = await userEnable(request, token, ALT_AI, {
            settings: { apiKey: `sk-${ALT_AI}-e2e-fake-key`, defaultModel: ALT_AI_MODEL },
            autoEnableForWorks: true,
        });
        expect(ue.status).toBe(200);

        const workA = await createWorkViaAPI(request, token, { name: `OptOut A ${Date.now()}` });
        const workB = await createWorkViaAPI(request, token, { name: `OptOut B ${Date.now()}` });

        // Both inherit workEnabled:true.
        await expect
            .poll(
                async () =>
                    rowFor(await listWorkPlugins(request, token, workA.id), ALT_AI)?.workEnabled,
                {
                    timeout: 15_000,
                    message: 'work A inherits the cascade',
                },
            )
            .toBe(true);
        expect(rowFor(await listWorkPlugins(request, token, workB.id), ALT_AI)?.workEnabled).toBe(
            true,
        );

        // OVERRIDE: disable anthropic for work A ONLY. This mints an explicit work
        // record (enabled:false) that beats the user cascade flag (priority 3>4).
        const disable = await workPluginAction(request, token, workA.id, ALT_AI, 'disable');
        expect(disable.status, 'per-work disable succeeds 200').toBe(200);
        expect(disable.body.workEnabled, 'work A: anthropic now workEnabled:false').toBe(false);
        expect(disable.body.workPluginId, 'an explicit opt-out record was minted').toBeTruthy();
        // The USER-level enable is untouched — the override is work-scoped only.
        expect(disable.body.enabled, 'the user-level enable survives the per-work opt-out').toBe(
            true,
        );

        // ISOLATION: work B is unaffected — it still inherits workEnabled:true with
        // NO explicit record. The opt-out did not leak across works.
        const bRow = rowFor(await listWorkPlugins(request, token, workB.id), ALT_AI);
        expect(bRow?.workEnabled, 'sibling work B is unaffected by A’s opt-out').toBe(true);
        expect(
            bRow?.workPluginId,
            'work B still has no explicit record (pure inheritance)',
        ).toBeFalsy();

        // RE-OPT-IN: re-enabling for work A flips the SAME record back on (idempotent
        // round-trip on the per-work binding).
        await configureUserProvider(request, token, ALT_AI, ALT_AI_MODEL);
        const reEnable = await workPluginAction(request, token, workA.id, ALT_AI, 'enable');
        expect(reEnable.status, 're-enable for work A succeeds').toBe(200);
        expect(reEnable.body.workEnabled, 'work A: anthropic re-enabled').toBe(true);
    });

    test('Flow 4: work-level provider OVERRIDE of the user/system default via /capability is EXCLUSIVE — one active provider per capability', async ({
        request,
    }) => {
        const token = await freshToken(request, 'bind');
        const work = await createWorkViaAPI(request, token, { name: `Bind ${Date.now()}` });

        // Configure + user-enable TWO alternate providers so both are bindable.
        // PROBED (live 3100): PATCH /api/plugins/:id/settings 400s with "not
        // installed for this user. Enable it first." UNLESS the plugin is
        // user-enabled first — so user-enable (idempotent, 200) precedes settings.
        expect((await userEnable(request, token, ALT_AI)).status).toBe(200);
        expect((await userEnable(request, token, ALT_AI_2)).status).toBe(200);
        await configureUserProvider(request, token, ALT_AI, ALT_AI_MODEL);
        await configureUserProvider(request, token, ALT_AI_2, ALT_AI_2_MODEL);

        // BASELINE: no explicit ai-provider binding for the work. The system default
        // (openrouter) is workEnabled but is NOT recorded as the active capability
        // provider in the work's capabilityProviders map (which is empty).
        const base = await listWorkPlugins(request, token, work.id);
        expect(
            base.capabilityProviders?.[AI_CAPABILITY],
            'a fresh work has no explicit active ai-provider override',
        ).toBeFalsy();

        // OVERRIDE 1: enable anthropic for the work AS the active ai-provider — this
        // overrides the user/system default for THIS work.
        const e1 = await workPluginAction(request, token, work.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(e1.status, 'enable anthropic as active ai-provider').toBe(200);
        await expect
            .poll(
                async () =>
                    (await listWorkPlugins(request, token, work.id)).capabilityProviders?.[
                        AI_CAPABILITY
                    ],
                { timeout: 15_000, message: 'work binds ai-provider→anthropic' },
            )
            .toBe(ALT_AI);

        // OVERRIDE 2: flip the active ai-provider to openai via the /capability
        // endpoint. It is EXCLUSIVE: it clears anthropic's active ai-provider so the
        // map resolves deterministically to a single provider.
        const flip = await workPluginAction(request, token, work.id, ALT_AI_2, 'capability', {
            capability: AI_CAPABILITY,
        });
        expect(flip.status, `set openai active; body=${JSON.stringify(flip.body)}`).toBe(400); // probed: /capability requires the plugin be enabled for the work FIRST
        expect(
            String(flip.body.message ?? ''),
            '/capability on a not-yet-enabled work plugin demands an enable first',
        ).toMatch(/not enabled for this work/i);

        // Satisfy that ordering: enable openai for the work, THEN flip the active
        // capability to it — the exclusive switch now lands.
        const e2 = await workPluginAction(request, token, work.id, ALT_AI_2, 'enable');
        expect(e2.status, 'enable openai for the work').toBe(200);
        const flip2 = await workPluginAction(request, token, work.id, ALT_AI_2, 'capability', {
            capability: AI_CAPABILITY,
        });
        expect(flip2.status, 'flip active ai-provider to openai').toBe(200);

        const afterFlip = await listWorkPlugins(request, token, work.id);
        expect(
            afterFlip.capabilityProviders?.[AI_CAPABILITY],
            'the active ai-provider override is now openai',
        ).toBe(ALT_AI_2);
        // EXCLUSIVITY: anthropic stays workEnabled but lost the active capability.
        const anthAfter = rowFor(afterFlip, ALT_AI);
        expect(anthAfter?.workEnabled, 'anthropic remains enabled for the work').toBe(true);
        expect(
            anthAfter?.activeCapabilities ?? [],
            'anthropic is no longer the active ai-provider (exclusivity cleared it)',
        ).not.toContain(AI_CAPABILITY);
        const oaAfter = rowFor(afterFlip, ALT_AI_2);
        expect(
            oaAfter?.activeCapabilities ?? [],
            'openai now owns the active ai-provider',
        ).toContain(AI_CAPABILITY);
    });

    test('Flow 5: per-work binding is fully ISOLATED across works and the SYSTEM provider cannot be disabled per-work', async ({
        request,
    }) => {
        const token = await freshToken(request, 'iso');
        // PROBED (live 3100): settings PATCH requires the plugin be user-enabled
        // first (else 400 "not installed for this user. Enable it first.").
        expect((await userEnable(request, token, ALT_AI)).status).toBe(200);
        await configureUserProvider(request, token, ALT_AI, ALT_AI_MODEL);

        const bound = await createWorkViaAPI(request, token, { name: `Iso Bound ${Date.now()}` });
        const clean = await createWorkViaAPI(request, token, { name: `Iso Clean ${Date.now()}` });

        // Bind anthropic as the active ai-provider on ONE work only.
        const e = await workPluginAction(request, token, bound.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(e.status, 'bind anthropic on the first work').toBe(200);
        await expect
            .poll(
                async () =>
                    (await listWorkPlugins(request, token, bound.id)).capabilityProviders?.[
                        AI_CAPABILITY
                    ],
                { timeout: 15_000, message: 'bound work binds anthropic' },
            )
            .toBe(ALT_AI);

        // ISOLATION: the OTHER work of the SAME user shows none of that binding — no
        // active provider, no per-work anthropic record, no workEnabled leakage.
        const cleanList = await listWorkPlugins(request, token, clean.id);
        expect(
            cleanList.capabilityProviders?.[AI_CAPABILITY],
            'the binding does NOT leak into a sibling work',
        ).toBeFalsy();
        const cleanAnth = rowFor(cleanList, ALT_AI);
        expect(
            cleanAnth?.workPluginId,
            'sibling work has no anthropic per-work record',
        ).toBeFalsy();
        expect(
            cleanAnth?.workEnabled,
            'sibling work does not inherit the explicit binding',
        ).toBeFalsy();

        // SYSTEM-PLUGIN GUARD: the system ai-provider (openrouter) and the system
        // search provider (tavily) cannot be disabled per-work — they are always-on.
        for (const sys of [SYSTEM_AI, SYSTEM_SEARCH]) {
            const sysDisable = await workPluginAction(request, token, bound.id, sys, 'disable');
            expect(sysDisable.status, `system plugin ${sys} per-work disable → 400`).toBe(400);
            expect(
                String(sysDisable.body.message ?? ''),
                `the 400 explains ${sys} is a system plugin`,
            ).toMatch(/system plugin and cannot be disabled/i);
            // It stays workEnabled after the rejected disable.
            const stillOn = rowFor(await listWorkPlugins(request, token, bound.id), sys);
            expect(
                stillOn?.workEnabled,
                `${sys} remains workEnabled after the rejected disable`,
            ).toBe(true);
        }
    });

    test('Flow 6: per-work plugin surface is ownership-scoped and capability-validated (owner 200 / intruder 403 / ghost 404 / anon 401 / bad-cap 400)', async ({
        request,
        browser,
    }) => {
        const token = await freshToken(request, 'guard');
        // PROBED (live 3100): settings PATCH requires the plugin be user-enabled
        // first (else 400 "not installed for this user. Enable it first.").
        expect((await userEnable(request, token, ALT_AI)).status).toBe(200);
        await configureUserProvider(request, token, ALT_AI, ALT_AI_MODEL);
        const work = await createWorkViaAPI(request, token, { name: `Guard ${Date.now()}` });

        // OWNER can read + mutate the per-work plugin surface.
        const ownerList = await listWorkPlugins(request, token, work.id);
        expect(Array.isArray(ownerList.plugins), 'owner reads the per-work plugin list').toBe(true);
        const ownerEnable = await workPluginAction(request, token, work.id, ALT_AI, 'enable', {
            activeCapability: AI_CAPABILITY,
        });
        expect(ownerEnable.status, 'owner can enable a plugin for the work').toBe(200);

        // CAPABILITY VALIDATION: /capability rejects a capability the plugin does not
        // provide (anthropic is ai-provider only, not search) → 400.
        const wrongCap = await workPluginAction(request, token, work.id, ALT_AI, 'capability', {
            capability: 'search',
        });
        expect(wrongCap.status, 'a capability the plugin lacks → 400').toBe(400);
        expect(String(wrongCap.body.message ?? ''), 'the 400 names the missing capability').toMatch(
            /does not provide capability/i,
        );

        // An entirely unknown capability string is rejected by the DTO validator (400).
        const bogusCap = await workPluginAction(request, token, work.id, ALT_AI, 'capability', {
            capability: `not-a-cap-${Date.now()}`,
        });
        expect(bogusCap.status, 'an unknown capability string → 400 (DTO validation)').toBe(400);

        // INTRUDER: a different authenticated user is denied on BOTH read and write.
        const intruderToken = await freshToken(request, 'intruder');
        const intruderRead = await request.get(workPluginsUrl(work.id), {
            headers: authedHeaders(intruderToken),
            timeout: 30_000,
        });
        expect([403, 404], `cross-user read denied (got ${intruderRead.status()})`).toContain(
            intruderRead.status(),
        );
        const intruderWrite = await workPluginAction(
            request,
            intruderToken,
            work.id,
            ALT_AI_2,
            'enable',
        );
        expect([403, 404], `cross-user write denied (got ${intruderWrite.status})`).toContain(
            intruderWrite.status,
        );

        // GHOST: a nonexistent work id → 404 (ownership lookup cannot find it).
        const ghost = await request.get(workPluginsUrl('00000000-0000-0000-0000-000000000000'), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(ghost.status(), `ghost work per-work read (got ${ghost.status()})`).toBe(404);

        // ANON: an EMPTY-storageState context (so it does NOT inherit the shared auth
        // cookie) is rejected 401 by the @CurrentUser guard on both read and write.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonRead = await anon.request.get(workPluginsUrl(work.id), { timeout: 30_000 });
        expect(anonRead.status(), 'anon per-work plugin read is guarded 401').toBe(401);
        const anonWrite = await anon.request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${ALT_AI}/enable`,
            { data: {}, timeout: 30_000 },
        );
        expect(anonWrite.status(), 'anon per-work plugin enable is guarded 401').toBe(401);
        await anon.close();
    });
});
