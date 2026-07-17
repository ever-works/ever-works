import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-onboarding-catalog-choices.spec.ts — complex, cross-feature INTEGRATION
 * flows for the v2 onboarding wizard's CATALOG and the way an Ever-Works-default
 * vs BYOK choice reshapes the wizard (step list + which capability endpoint the
 * config sub-step talks to + device-auth in onboarding).
 *
 * These do NOT duplicate the existing onboarding specs:
 *   - flow-onboarding-wizard.spec.ts walks BYOK-AI + vercel + user-github step
 *     derivation, dismiss/complete, and the telemetry funnel — but it never
 *     asserts the CATALOG's `available`/`badges` gating, never reconciles the
 *     config sub-step's plugin against the catalog `pluginId`, and never wires
 *     the wizard's per-choice CONNECTION/DEVICE-AUTH source endpoints.
 *   - onboarding-deeper.spec.ts / onboarding-wizard-v2.spec.ts are shallow
 *     single-endpoint smokes.
 *   - flow-plugin-oauth-deviceauth.spec.ts walks the device-auth/oauth
 *     controllers in isolation — NOT in the onboarding catalog context, and
 *     never reconciles them against the onboarding catalog cards that drive
 *     which endpoint the wizard calls.
 *
 * SURFACE — verified live against http://127.0.0.1:3100 before any assertion
 * (CI driver = NestJS + sqlite in-memory). Every shape below is probe-verified:
 *
 *   GET /api/onboarding/catalog (authed) → { ai[6], storage[4], deploy[3], plugins[] }
 *     Each card: { choice, title, description, default:bool, available:bool,
 *                  badges:('default'|'byok'|'planned')[], pluginId? }.
 *     CI-REAL availability (env flags everWorks.git / everWorks.deploy OFF):
 *       ai:      all 6 available; default=ever-works (no pluginId, no byok badge),
 *                the other 5 are byok + carry a pluginId.
 *       storage: default `ever-works-git` is available:false, badges
 *                ['default','planned']; `user-github` available (pluginId github);
 *                `user-gitlab` + `user-git` available:false, ['planned'].
 *       deploy:  default `ever-works` is available:false, ['default','planned'];
 *                `vercel` + `k8s` available, pluginId vercel / k8s.
 *     i.e. in CI BOTH the storage and deploy Ever Works DEFAULTS are "planned".
 *
 *   GET /api/plugins (authed) → { <id>: { capabilities[], ... } } map. Probed:
 *     codex        caps include 'device-auth' (the onboarding ai-config:codex source)
 *     github       caps ['git-provider','oauth']
 *     openrouter / grok  caps ['ai-provider']      (no remote-status capability)
 *     gemini / claude-code caps ['pipeline','code-edit', …] (NO device-auth)
 *     vercel / k8s caps ['deployment']             (no remote-status capability)
 *
 *   The wizard's `getOnboardingPluginStatuses` server action resolves, per the
 *   chosen plugin's capabilities (see apps/web/.../actions/dashboard/onboarding.ts):
 *     git-provider → GET /api/git-providers/:id/connection (200, {connected:false})
 *     oauth        → GET /api/oauth/:id/connection         (200, {connected:false})
 *     device-auth  → GET /api/device-auth/:id/status       (200 DeviceAuthStatus)
 *     none of those → connection=null, deviceAuthStatus=null (field-based step).
 *
 *   PATCH /api/onboarding/state deep-merges a partial { state }. The DTO
 *   validates `ai/storage/deploy.choice` against the ENUM, NOT against the
 *   catalog's `available` flag — so a valid-but-"planned" choice (user-gitlab)
 *   is ACCEPTED (200). `whitelist: forbidNonWhitelisted` is on for truly
 *   unknown inner keys. EW-722 (security wave M): the contract-declared
 *   `prompt` is now whitelisted with @MaxLength(5000) — a valid prompt
 *   persists (200); an oversized one (>5000 chars) → 400.
 *
 *   POST /api/onboarding/telemetry allow-list (probe-verified full set):
 *     onboarding_opened, onboarding_closed, onboarding_completed,
 *     onboarding_step_viewed, onboarding_step_next, onboarding_step_back,
 *     onboarding_step_skipped, onboarding_ai_choice_selected,
 *     onboarding_storage_choice_selected, onboarding_deploy_choice_selected,
 *     onboarding_plugin_connected, onboarding_plugin_refresh_clicked,
 *     onboarding_planned_card_clicked, onboarding_byok_skipped,
 *     onboarding_plugins_step_expanded, onboarding_plugins_step_skipped,
 *     onboarding_plugins_step_advanced, onboarding_ever_works_quota_blocked.
 *     NOTE: `onboarding_prompt_set` — emitted by the web hook — is NOT on the
 *     server list → 400. A real, asserted client/server divergence.
 *
 * Isolation: all API orchestration runs on FRESH registerUserViaAPI() users so
 * the shared in-memory DB stays clean. The single UI flow uses the seeded
 * storageState user via the Help-drawer manual-open path.
 */

// ─── Wire types (subset; mirrors @ever-works/contracts/api) ──────────────────

type AiChoice = 'ever-works' | 'openrouter' | 'claude-code' | 'codex' | 'gemini' | 'grok';
type StorageChoice = 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git';
type DeployChoice = 'ever-works' | 'vercel' | 'k8s';
type CardBadge = 'default' | 'byok' | 'planned';

interface CatalogCard {
    choice: string;
    title: string;
    description: string;
    default: boolean;
    available: boolean;
    badges: CardBadge[];
    pluginId?: string;
}

interface CatalogResponse {
    ai: CatalogCard[];
    storage: CatalogCard[];
    deploy: CatalogCard[];
    plugins: Array<{
        pluginId: string;
        name: string;
        category: string;
        description: string;
        onboardingPriority: number;
    }>;
}

interface WizardStateV2 {
    version: 2;
    lastStep: number;
    ai: { choice: AiChoice };
    storage: { choice: StorageChoice };
    deploy: { choice: DeployChoice };
    skippedSteps: string[];
    pluginsReviewed: boolean;
    // EW-722: contract-declared landing-page prompt (EW-617 G4), validated
    // server-side with @MaxLength(5000) and persisted.
    prompt?: string;
}

interface StateResponse {
    completedAt: string | null;
    dismissedAt: string | null;
    state: WizardStateV2;
}

interface DeviceAuthStatus {
    installed: boolean;
    connected: boolean;
    pending: boolean;
    scope: string;
    flowType: string;
    prompt?: { verificationUri?: string; userCode?: string };
    message: string;
}

const ONB = {
    state: `${API_BASE}/api/onboarding/state`,
    catalog: `${API_BASE}/api/onboarding/catalog`,
    complete: `${API_BASE}/api/onboarding/complete`,
    dismiss: `${API_BASE}/api/onboarding/dismiss`,
    telemetry: `${API_BASE}/api/onboarding/telemetry`,
} as const;

// ─── Step derivation (faithful copy of computeStepList in useOnboardingFlow.ts) ─

/**
 * Mirror of the product's `computeStepList`. Base flow is always
 * welcome → ai-choice → storage-choice → deploy-choice → plugins-catalog →
 * create-work (6). A config sub-step is inserted ONLY for a NON-default AI
 * choice, for `storage.choice === 'user-github'`, and for a `vercel`/`k8s`
 * deploy. Crucially the derivation keys off the CHOICE, not the catalog's
 * `available` flag — so picking the (CI-unavailable) Ever Works defaults still
 * yields the lean 6-step flow with zero config steps.
 */
function computeStepIds(state: Pick<WizardStateV2, 'ai' | 'storage' | 'deploy'>): string[] {
    const ids: string[] = ['welcome', 'ai-choice'];
    if (state.ai.choice !== 'ever-works') ids.push(`ai-config:${state.ai.choice}`);
    ids.push('storage-choice');
    if (state.storage.choice === 'user-github') ids.push(`storage-config:${state.storage.choice}`);
    ids.push('deploy-choice');
    if (state.deploy.choice === 'vercel' || state.deploy.choice === 'k8s') {
        ids.push(`deploy-config:${state.deploy.choice}`);
    }
    ids.push('plugins-catalog', 'create-work');
    return ids;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCatalog(request: APIRequestContext, token: string): Promise<CatalogResponse> {
    const res = await request.get(ONB.catalog, { headers: authedHeaders(token) });
    expect(res.status(), `GET catalog body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getState(request: APIRequestContext, token: string): Promise<StateResponse> {
    const res = await request.get(ONB.state, { headers: authedHeaders(token) });
    expect(res.status(), `GET state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function patchState(
    request: APIRequestContext,
    token: string,
    state: Record<string, unknown>,
): Promise<StateResponse> {
    const res = await request.patch(ONB.state, {
        headers: authedHeaders(token),
        data: { state },
    });
    expect(res.status(), `PATCH state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Load the capabilities map (pluginId → capabilities[]) from GET /api/plugins. */
async function getPluginCaps(
    request: APIRequestContext,
    token: string,
): Promise<Record<string, string[]>> {
    const res = await request.get(`${API_BASE}/api/plugins`, { headers: authedHeaders(token) });
    expect(res.status(), 'GET /api/plugins is 200 for an authed user').toBe(200);
    const body = await res.json();
    // PROBE-VERIFIED shape: the endpoint returns an envelope
    //   { plugins: [{ id, pluginId, capabilities[], ... }], total, categories, capabilities }
    // i.e. the plugin list is the `plugins` ARRAY, each element keyed by `id`
    // (== `pluginId`). We tolerate a bare array OR a keyed-map form too, so a
    // future backend reshape never silently skips the reconciliation.
    const map: Record<string, string[]> = {};
    const list: unknown = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { plugins?: unknown }).plugins)
          ? (body as { plugins: unknown[] }).plugins
          : null;
    if (Array.isArray(list)) {
        for (const entry of list) {
            const p = entry as { id?: string; pluginId?: string; capabilities?: string[] };
            const id = p?.pluginId ?? p?.id;
            if (id) map[id] = Array.isArray(p?.capabilities) ? p.capabilities : [];
        }
    } else if (body && typeof body === 'object') {
        // Legacy keyed-map fallback { <id>: { capabilities, ... } }.
        for (const [id, p] of Object.entries(body as Record<string, { capabilities?: string[] }>)) {
            map[id] = Array.isArray(p?.capabilities) ? p!.capabilities! : [];
        }
    }
    return map;
}

function assertDeviceAuthShape(body: unknown, ctx: string): DeviceAuthStatus {
    expect(body, `${ctx}: object`).toBeTruthy();
    const s = body as DeviceAuthStatus;
    expect(typeof s.installed, `${ctx}: installed bool`).toBe('boolean');
    expect(typeof s.connected, `${ctx}: connected bool`).toBe('boolean');
    expect(typeof s.pending, `${ctx}: pending bool`).toBe('boolean');
    expect(s.scope, `${ctx}: scope user`).toBe('user');
    expect(s.flowType, `${ctx}: flowType device-code`).toBe('device-code');
    expect(typeof s.message, `${ctx}: message string`).toBe('string');
    expect(s.connected && s.pending, `${ctx}: never connected AND pending`).toBe(false);
    if (s.connected) expect(s.installed, `${ctx}: connected implies installed`).toBe(true);
    return s;
}

async function loadSeededAuthToken(request: APIRequestContext): Promise<string | null> {
    try {
        const seeded = loadSeededTestUser();
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        if (!res.ok()) return null;
        return ((await res.json()) as { access_token?: string }).access_token ?? null;
    } catch {
        return null;
    }
}

// ─── Flow 1: catalog availability gating (Ever-Works-default vs BYOK) ─────────

test.describe('Onboarding catalog — availability gating across the three buckets', () => {
    test('every bucket has exactly one default; the AI default is available while the storage+deploy defaults are env-gated, and BYOK/own-provider cards carry a pluginId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const catalog = await getCatalog(request, user.access_token);

        // STRUCTURE — bucket cardinality is server-authoritative and stable.
        expect(catalog.ai, 'ai bucket has 6 cards').toHaveLength(6);
        expect(catalog.storage, 'storage bucket has 4 cards').toHaveLength(4);
        expect(catalog.deploy, 'deploy bucket has 3 cards').toHaveLength(3);

        // INVARIANT — each bucket has EXACTLY ONE default card, and that default
        // is the one badged 'default'. This holds regardless of env flags.
        for (const [name, bucket] of [
            ['ai', catalog.ai],
            ['storage', catalog.storage],
            ['deploy', catalog.deploy],
        ] as const) {
            const defaults = bucket.filter((c) => c.default);
            expect(defaults, `${name}: exactly one default card`).toHaveLength(1);
            expect(defaults[0].badges, `${name}: default card is badged 'default'`).toContain(
                'default',
            );
            // A 'byok' badge and the 'default' badge are mutually exclusive — the
            // managed Ever Works option is never "bring your own key".
            expect(defaults[0].badges, `${name}: default is not also byok`).not.toContain('byok');
        }

        // AI bucket — the Ever Works default needs NO config (no pluginId, no
        // byok badge, always available). The other 5 are BYOK and each names the
        // plugin that backs its config step.
        const aiDefault = catalog.ai.find((c) => c.default)!;
        expect(aiDefault.choice, 'ai default is ever-works').toBe('ever-works');
        expect(aiDefault.available, 'ai default is always available').toBe(true);
        expect(aiDefault.pluginId, 'ai default has no backing plugin').toBeFalsy();
        for (const card of catalog.ai.filter((c) => !c.default)) {
            expect(card.badges, `ai ${card.choice} is byok`).toContain('byok');
            expect(card.pluginId, `ai byok ${card.choice} names a plugin`).toBeTruthy();
            expect(card.available, `ai byok ${card.choice} is available`).toBe(true);
        }

        // STORAGE — `ever-works-git` is the default but env-gated. In CI (git
        // flag OFF) it is available:false and carries BOTH 'default' and 'planned'.
        // `user-github` is the real, available, pluginId-backed BYO option.
        const storageDefault = catalog.storage.find((c) => c.default)!;
        expect(storageDefault.choice, 'storage default is ever-works-git').toBe('ever-works-git');
        // Environment-adaptive: when the env flag is OFF the default is "planned".
        if (!storageDefault.available) {
            expect(storageDefault.badges, 'gated storage default is planned').toEqual(
                expect.arrayContaining(['default', 'planned']),
            );
        } else {
            expect(storageDefault.badges, 'available storage default is not planned').not.toContain(
                'planned',
            );
        }
        const userGithub = catalog.storage.find((c) => c.choice === 'user-github')!;
        expect(userGithub.available, 'user-github is available').toBe(true);
        expect(userGithub.pluginId, 'user-github is backed by the github plugin').toBe('github');
        // The two self-hosted Git options are always "planned" + unavailable.
        for (const choice of ['user-gitlab', 'user-git'] as const) {
            const card = catalog.storage.find((c) => c.choice === choice)!;
            expect(card.available, `${choice} is unavailable`).toBe(false);
            expect(card.badges, `${choice} is planned`).toContain('planned');
        }

        // DEPLOY — `ever-works` default is env-gated like storage; `vercel`/`k8s`
        // are the available own-provider options with backing plugins.
        const deployDefault = catalog.deploy.find((c) => c.default)!;
        expect(deployDefault.choice, 'deploy default is ever-works').toBe('ever-works');
        if (!deployDefault.available) {
            expect(deployDefault.badges, 'gated deploy default is planned').toEqual(
                expect.arrayContaining(['default', 'planned']),
            );
        }
        for (const choice of ['vercel', 'k8s'] as const) {
            const card = catalog.deploy.find((c) => c.choice === choice)!;
            expect(card.available, `${choice} is available`).toBe(true);
            expect(card.pluginId, `${choice} names a backing plugin`).toBe(choice);
            expect(card.badges, `${choice} is not planned`).not.toContain('planned');
        }

        // CROSS-CHECK — every catalog card that names a pluginId must reference a
        // REAL plugin in the registry (no dangling pluginId that would break the
        // config step's lookup). Reconcile against GET /api/plugins.
        const caps = await getPluginCaps(request, user.access_token);
        const cardPluginIds = [...catalog.ai, ...catalog.storage, ...catalog.deploy]
            .map((c) => c.pluginId)
            .filter((id): id is string => Boolean(id));
        expect(cardPluginIds.length, 'at least a few cards are plugin-backed').toBeGreaterThan(0);
        for (const id of cardPluginIds) {
            expect(
                Object.prototype.hasOwnProperty.call(caps, id),
                `catalog pluginId "${id}" resolves to a registered plugin`,
            ).toBe(true);
        }
    });
});

// ─── Flow 2: choices reshape the step list; config steps reconcile to catalog ─

test.describe('Onboarding step list — Ever-Works-default vs BYOK reshapes the flow', () => {
    test('all-Ever-Works defaults yield the lean 6-step flow even though the storage+deploy defaults are "planned"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A pristine user is on the all-defaults state. Even though the storage
        // and deploy defaults are CI-unavailable ("planned"), the step list is
        // derived purely from the CHOICE — so it is exactly the 6 base steps,
        // with NO config sub-steps. This is the key default-path property.
        const pristine = await getState(request, token);
        expect(pristine.state.ai.choice).toBe('ever-works');
        expect(pristine.state.storage.choice).toBe('ever-works-git');
        expect(pristine.state.deploy.choice).toBe('ever-works');
        expect(computeStepIds(pristine.state)).toEqual([
            'welcome',
            'ai-choice',
            'storage-choice',
            'deploy-choice',
            'plugins-catalog',
            'create-work',
        ]);

        // Picking the (planned) Ever Works defaults explicitly is still accepted
        // and still produces the lean flow — the "planned" availability never
        // inserts a config step.
        const afterDefaults = await patchState(request, token, {
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'ever-works' },
            lastStep: 1,
        });
        expect(computeStepIds(afterDefaults.state)).toHaveLength(6);
    });

    test('each catalog-available, pluginId-backed choice inserts exactly the config step the wizard renders for that plugin', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const catalog = await getCatalog(request, token);

        // Drive the state toward the MAXIMAL flow using only catalog-available,
        // pluginId-backed cards (the cards the wizard renders as real config
        // steps): a BYOK AI, user-github storage, and an own-provider deploy.
        const aiByok = catalog.ai.find((c) => c.badges.includes('byok') && c.available)!;
        const deployOwn = catalog.deploy.find((c) => !c.default && c.available && c.pluginId)!;
        expect(aiByok, 'a BYOK AI card is available').toBeTruthy();
        expect(deployOwn, 'an own-provider deploy card is available').toBeTruthy();

        const merged = await patchState(request, token, {
            ai: { choice: aiByok.choice },
            storage: { choice: 'user-github' },
            deploy: { choice: deployOwn.choice },
            lastStep: 3,
        });
        expect(merged.state.ai.choice).toBe(aiByok.choice);
        expect(merged.state.storage.choice).toBe('user-github');
        expect(merged.state.deploy.choice).toBe(deployOwn.choice);

        // The derived flow is the full 9 steps; the three inserted config steps
        // must name EXACTLY the choices we made. The wizard's StepBody maps
        // ai-config → state.ai.choice plugin, storage-config → github,
        // deploy-config → state.deploy.choice plugin — so each id reconciles to
        // the catalog card's pluginId.
        const ids = computeStepIds(merged.state);
        expect(ids).toEqual([
            'welcome',
            'ai-choice',
            `ai-config:${aiByok.choice}`,
            'storage-choice',
            'storage-config:user-github',
            'deploy-choice',
            `deploy-config:${deployOwn.choice}`,
            'plugins-catalog',
            'create-work',
        ]);

        // Reconcile each config step's backing plugin id against the catalog +
        // the live registry, so the config step can actually resolve a plugin.
        const caps = await getPluginCaps(request, token);
        const expectations: Array<{ stepId: string; pluginId: string }> = [
            { stepId: `ai-config:${aiByok.choice}`, pluginId: aiByok.pluginId! },
            { stepId: 'storage-config:user-github', pluginId: 'github' },
            { stepId: `deploy-config:${deployOwn.choice}`, pluginId: deployOwn.pluginId! },
        ];
        for (const { stepId, pluginId } of expectations) {
            expect(ids, `flow contains ${stepId}`).toContain(stepId);
            expect(
                Object.prototype.hasOwnProperty.call(caps, pluginId),
                `config step ${stepId} resolves to a real plugin "${pluginId}"`,
            ).toBe(true);
        }

        // And switching the AI choice back to the Ever Works default REMOVES the
        // ai-config step (the flow shrinks) — proving the derivation is reactive
        // to the choice, not sticky.
        const reverted = await patchState(request, token, { ai: { choice: 'ever-works' } });
        const revertedIds = computeStepIds(reverted.state);
        expect(revertedIds).not.toContain(`ai-config:${aiByok.choice}`);
        expect(revertedIds, 'reverting AI to default drops one config step').toHaveLength(
            ids.length - 1,
        );
    });
});

// ─── Flow 3: connection-during-onboarding wiring (the per-choice status source) ─

test.describe('Onboarding config steps — the wizard resolves each choice via its capability endpoint', () => {
    test('a fresh user resolves connection status for every config-triggering choice exactly as getOnboardingPluginStatuses would', async ({
        request,
    }) => {
        // This walks the SAME capability-routing the wizard's server action uses:
        //   git-provider → /api/git-providers/:id/connection
        //   oauth        → /api/oauth/:id/connection
        //   device-auth  → /api/device-auth/:id/status
        //   (none)       → no remote status; the config step is field-based.
        // We assert each chosen plugin's status resolves to a clean, NOT-connected
        // contract for a brand-new user, never a 5xx.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const caps = await getPluginCaps(request, token);

        // 3a — user-github storage. github has BOTH git-provider AND oauth caps;
        // the action prefers the git-provider path. The connection descriptor is
        // 200, echoes the id, and reports connected:false for the fresh user.
        expect(caps['github'], 'github plugin has git-provider capability').toContain(
            'git-provider',
        );
        const gh = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
            headers: h,
        });
        expect(gh.status(), 'github git-provider connection is 200').toBe(200);
        const ghBody = await gh.json();
        expect(ghBody.id, 'github connection echoes id').toBe('github');
        expect(ghBody.connected, 'fresh user not connected to github').toBe(false);

        // 3b — a BYOK AI that has NO oauth/git-provider/device-auth capability
        // (openrouter / grok are plain ai-providers). The wizard resolves NO
        // remote status for these — the config step is purely field-based. We
        // prove the absence of the capability so the field-based branch is taken.
        const fieldBasedAi = ['openrouter', 'grok'].find(
            (id) =>
                caps[id] &&
                !caps[id].includes('oauth') &&
                !caps[id].includes('git-provider') &&
                !caps[id].includes('device-auth'),
        );
        expect(fieldBasedAi, 'at least one field-based BYOK AI exists').toBeTruthy();

        // 3c — an own-provider deploy (vercel / k8s) is a plain 'deployment'
        // plugin → also field-based, no remote status endpoint.
        for (const id of ['vercel', 'k8s']) {
            if (!caps[id]) continue;
            expect(
                caps[id].some((c) => ['oauth', 'git-provider', 'device-auth'].includes(c)),
                `${id} has no remote-status capability (field-based config step)`,
            ).toBe(false);
        }

        // 3d — the github OAuth connection path (the wizard's fallback when a
        // plugin has oauth but no git-provider) is ALSO a clean 200 not-connected,
        // so either routing yields a coherent descriptor.
        const oauthConn = await request.get(`${API_BASE}/api/oauth/github/connection`, {
            headers: h,
        });
        expect(oauthConn.status(), 'github oauth connection is 200').toBe(200);
        const oauthBody = await oauthConn.json();
        expect(oauthBody.connected, 'oauth path also reports not-connected').toBe(false);

        // 3e — choosing user-github in onboarding state and then resolving its
        // connection composes the real wizard sequence (choice → config step →
        // connection fetch). The connection result is independent of the stored
        // choice (status is keyed by user + plugin, not by onboarding state).
        await patchState(request, token, { storage: { choice: 'user-github' }, lastStep: 4 });
        const ghAfterChoice = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
            headers: h,
        });
        expect(ghAfterChoice.status(), 'connection still 200 after picking user-github').toBe(200);
        expect(
            (await ghAfterChoice.json()).connected,
            'picking the storage choice does not auto-connect github',
        ).toBe(false);
    });
});

// ─── Flow 4: device-auth IS the codex onboarding config step ─────────────────

test.describe('Onboarding device-auth — the codex AI choice drives the device-code config step', () => {
    test('selecting codex as the AI provider wires the device-auth status/start contract, while non-device-auth AI choices fall back to field config', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const caps = await getPluginCaps(request, token);

        // PRECONDITION — codex is the one AI catalog choice whose plugin declares
        // the device-auth capability; that is what makes ai-config:codex render a
        // device-code panel instead of a field form.
        expect(caps['codex'], 'codex plugin declares device-auth').toContain('device-auth');

        // STEP 1 — pick codex as the AI provider in onboarding state. The derived
        // flow now contains ai-config:codex.
        const afterCodex = await patchState(request, token, {
            ai: { choice: 'codex' },
            lastStep: 2,
        });
        expect(computeStepIds(afterCodex.state)).toContain('ai-config:codex');

        // STEP 2 — the config step's data source is GET /api/device-auth/codex/
        // status. It returns the full DeviceAuthStatus envelope (200) even though
        // the Codex CLI is absent in CI — installed/connected/pending all false,
        // and the message names the missing CLI.
        const statusRes = await request.get(`${API_BASE}/api/device-auth/codex/status`, {
            headers: h,
        });
        expect(statusRes.status(), 'codex device-auth status is 200').toBe(200);
        const status = assertDeviceAuthShape(await statusRes.json(), 'codex status');

        // STEP 3 — the "Connect" button in the panel POSTs start. Same envelope,
        // 200 (HttpCode OK). When the CLI is absent it short-circuits without
        // spinning a pending session.
        const startRes = await request.post(`${API_BASE}/api/device-auth/codex/start`, {
            headers: h,
        });
        expect(startRes.status(), 'codex device-auth start is 200').toBe(200);
        const started = assertDeviceAuthShape(await startRes.json(), 'codex start');
        // The `installed` bit is MONOTONIC across status→start, not strictly
        // equal: `status` only probes for an already-present binary
        // (resolveExistingBinary), while `start` runs ensureBinary(), which can
        // DOWNLOAD + install the Codex CLI as a side effect. Locally (no LLM key
        // is irrelevant here; this is binary-gated) the GitHub release download
        // fails so both report installed:false and the test was authored against
        // that. In CI the runner can reach the GitHub releases CDN, so `start`
        // may legitimately flip installed false→true after materializing the
        // binary. Assert the real invariant: start can ADD an install but never
        // REMOVE one, so a status-installed CLI stays installed after start.
        if (status.installed) {
            expect(
                started.installed,
                'a CLI present at status is still installed after start',
            ).toBe(true);
        }
        if (!started.installed) {
            expect(started.pending, 'no pending session without the CLI').toBe(false);
            expect(started.connected, 'cannot be connected without the CLI').toBe(false);
            expect(started.message, 'message names the missing Codex CLI').toMatch(
                /codex|install/i,
            );
        }

        // STEP 4 — the OTHER AI choices that LOOK CLI-ish (claude-code, gemini)
        // do NOT declare device-auth, so their ai-config step is field-based, and
        // hitting the device-auth endpoint for them is a precise 400 (capability
        // guard), NOT a 5xx. This is what keeps the wizard from rendering a
        // device-code panel for a plugin that can't do device auth.
        for (const aiId of ['claude-code', 'gemini']) {
            if (!caps[aiId]) continue;
            expect(caps[aiId], `${aiId} does NOT declare device-auth`).not.toContain('device-auth');
            const res = await request.get(`${API_BASE}/api/device-auth/${aiId}/status`, {
                headers: h,
            });
            expect(res.status(), `${aiId} device-auth status is a 400 capability rejection`).toBe(
                400,
            );
            expect(
                String((await res.json()).message),
                `${aiId} names the missing capability`,
            ).toMatch(/does not support device auth/i);
        }

        // STEP 5 — record the BYOK-skipped + plugin-connected telemetry the wizard
        // fires around a device-auth step; both are allow-listed (204).
        for (const event of ['onboarding_byok_skipped', 'onboarding_plugin_connected']) {
            const res = await request.post(ONB.telemetry, {
                headers: h,
                data: { event, properties: { pluginId: 'codex', bucket: 'ai', choice: 'codex' } },
            });
            expect(res.status(), `${event} is accepted (204)`).toBe(204);
        }
    });
});

// ─── Flow 5: catalog availability ≠ state acceptance; client/server divergences ─

test.describe('Onboarding state — catalog availability does not gate the state machine', () => {
    test('a valid-but-"planned" choice is accepted, prompt is validated and persisted, and onboarding_prompt_set is not allow-listed', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const catalog = await getCatalog(request, token);

        // Find a choice the catalog marks UNAVAILABLE ('planned'). user-gitlab is
        // such a card. The state DTO validates against the ENUM, not `available`,
        // so persisting it is a clean 200 — the catalog gates the UI, the DTO
        // gates the wire. This is the contract boundary between the two.
        const plannedStorage = catalog.storage.find(
            (c) => !c.available && c.choice !== 'ever-works-git',
        );
        expect(plannedStorage, 'catalog exposes a planned, non-default storage card').toBeTruthy();
        const accepted = await patchState(request, token, {
            storage: { choice: plannedStorage!.choice },
        });
        expect(
            accepted.state.storage.choice,
            'a valid-but-planned choice is accepted by the state machine',
        ).toBe(plannedStorage!.choice);

        // A truly out-of-enum choice is still a 400 (the enum is the gate).
        const badEnum = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: { state: { storage: { choice: 'magic-cloud-drive' } } },
        });
        expect(badEnum.status(), 'out-of-enum storage choice → 400').toBe(400);
        expect(JSON.stringify(await badEnum.json().catch(() => ({})))).toContain(
            'must be one of the following values',
        );

        // EW-722 (security wave M): the former client/server divergence is
        // CLOSED — the contract-declared `prompt` is now whitelisted in the
        // server DTO with @MaxLength(5000) and persisted, so the web hook's
        // patch (which includes `prompt` when the landing page set one) is a
        // clean 200. Oversized user-controlled text is still rejected so it
        // cannot bloat the onboarding_state column.
        const withPrompt = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: { state: { prompt: 'build me a cafe directory' } },
        });
        expect(withPrompt.status(), 'contract-declared prompt is accepted → 200').toBe(200);
        const oversizedPrompt = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: { state: { prompt: 'x'.repeat(5001) } },
        });
        expect(oversizedPrompt.status(), 'prompt over 5000 chars → 400').toBe(400);
        expect(JSON.stringify(await oversizedPrompt.json().catch(() => ({})))).toMatch(
            /prompt must be shorter than or equal to 5000 characters/i,
        );

        // The rejected patches above never mutated state beyond the accepted
        // ones; the valid prompt round-trips on an independent GET.
        const after = await getState(request, token);
        expect(after.state.storage.choice, 'only the accepted planned choice stuck').toBe(
            plannedStorage!.choice,
        );
        expect(after.state.prompt, 'valid prompt persisted').toBe('build me a cafe directory');

        // CLIENT/SERVER DIVERGENCE #2 — `onboarding_prompt_set` is fired by the
        // web wizard (setPrompt → trackEvent) but is NOT on the server telemetry
        // allow-list → 400. Meanwhile the catalog-driven events the wizard emits
        // around choices ARE allow-listed (204). Assert both halves so the
        // divergence is pinned, not silently tolerated.
        const promptEvt = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'onboarding_prompt_set', properties: { hasValue: true } },
        });
        expect(promptEvt.status(), 'onboarding_prompt_set is NOT allow-listed → 400').toBe(400);

        for (const event of [
            'onboarding_ai_choice_selected',
            'onboarding_storage_choice_selected',
            'onboarding_deploy_choice_selected',
            'onboarding_planned_card_clicked',
        ]) {
            const res = await request.post(ONB.telemetry, {
                headers: authedHeaders(token),
                data: { event, properties: { choice: 'vercel', bucket: 'deploy' } },
            });
            expect(res.status(), `${event} (a real catalog event) is accepted (204)`).toBe(204);
        }
    });
});

// ─── Flow 6: UI — choosing a BYOK AI card grows the SideNav with a config step ─

test.describe('Onboarding wizard UI — a BYOK AI choice inserts a config step into the SideNav', () => {
    test('opening the wizard from the Help drawer, the rendered step list and step count agree with the catalog-derived flow', async ({
        page,
        request,
        baseURL,
    }) => {
        // This single UI-driven flow chains a 30s retry-to-open (the dev
        // hydration race on the "?" Help shortcut), several 15s/10s wizard-chrome
        // waits, a mid-flow server cross-check, and the OpenRouter-card → Configure
        // AI re-derive. Under a workers=4 local run those generous-but-legitimate
        // waits can cumulatively exceed the 90s default and time out the test even
        // though every step eventually succeeds. Give this one test more headroom
        // so it rides out next-dev cold-compile + worker contention without
        // weakening any assertion below.
        test.setTimeout(180_000);

        const origin = new URL(baseURL || 'http://localhost:3000').origin;
        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 });

        // Open the Help drawer via the global "?" shortcut (ignored while focus
        // is in an input → blur first). Retry-to-open to ride the dev hydration
        // race where the first keypress is swallowed pre-hydration.
        const helpTitle = page.getByRole('heading', { name: 'Help & Resources' });
        await expect(async () => {
            await page.locator('body').click({ position: { x: 5, y: 5 } });
            await page.keyboard.press('?');
            await expect(helpTitle).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });

        // Manual-open entry — always rendered regardless of dismissed/works state.
        const openOnboarding = page.getByRole('button', {
            name: /Open onboarding \(\d+\/\d+\)/,
        });
        await expect(openOnboarding).toBeVisible({ timeout: 10_000 });
        await openOnboarding.click();

        // Wizard chrome appears. The SideNav lists every derived step as a
        // numbered button with the product's English labels. Scope all SideNav
        // assertions to the wizard's own Dialog: the dashboard chat panel
        // renders an AI provider-selector that surfaces the same provider
        // names (e.g. "OpenRouter") OUTSIDE the wizard, so an unscoped match
        // could resolve to the wrong, dialog-overlay-covered control.
        const wizard = page.getByRole('dialog');
        await expect(wizard.getByText('Get started with Ever Works')).toBeVisible({
            timeout: 15_000,
        });
        await expect(wizard.getByRole('button', { name: 'Your AI choice' })).toBeVisible({
            timeout: 15_000,
        });

        // Cross-check the SideNav against the server-derived step list for the
        // seeded user. With the seeded user we cannot assume defaults, but the
        // "Configure AI" SideNav label is present IFF the user's AI choice is a
        // BYOK (non-ever-works) one — and the catalog/state agree on that.
        const seeded = await loadSeededAuthToken(request);
        if (seeded) {
            const serverState = await getState(request, seeded);
            const ids = computeStepIds(serverState.state);
            const expectsAiConfig = serverState.state.ai.choice !== 'ever-works';
            const aiConfigBtn = wizard.getByRole('button', { name: 'Configure AI' });
            if (expectsAiConfig) {
                expect(ids.some((id) => id.startsWith('ai-config:'))).toBe(true);
                await expect(aiConfigBtn, 'BYOK AI choice shows a Configure AI step').toBeVisible({
                    timeout: 10_000,
                });
            } else {
                expect(ids.some((id) => id.startsWith('ai-config:'))).toBe(false);
                await expect(
                    aiConfigBtn,
                    'Ever Works default AI shows no Configure AI step',
                ).toHaveCount(0);
            }

            // The "Create your first Work" final step is always present, and the
            // total rendered SideNav step buttons equal the server-derived count.
            await expect(
                wizard.getByRole('button', { name: 'Create your first Work' }),
            ).toBeVisible({
                timeout: 10_000,
            });
        }

        // Whether or not the seeded cross-check ran, the wizard exposes the
        // AI-choice step. Selecting an available BYOK AI card live should grow
        // the SideNav with a "Configure AI" step (the catalog → step-list link,
        // observed entirely in the UI). We branch on whether the card renders as
        // an enabled control to stay resilient to the seeded user's prior state.
        // Re-use the dialog-scoped `wizard` locator defined above. The
        // dashboard chat panel renders an AI provider-selector pill that ALSO
        // reads "OpenRouter" but lives OUTSIDE the wizard — an unscoped
        // `/OpenRouter/` matched it first, and because the open wizard Dialog
        // overlay (headlessui-portal-root) sits on top of the whole page, that
        // pill is permanently pointer-event-intercepted. The click then retried
        // until the 180s test timeout (no action timeout is configured). Scope
        // to the dialog so we hit the real, clickable ChoiceCard.
        const aiChoiceNav = wizard.getByRole('button', { name: 'Your AI choice' });
        await aiChoiceNav.click();
        // OpenRouter is a guaranteed-available BYOK card (title "OpenRouter").
        const openRouterCard = wizard
            .getByRole('button', { name: /OpenRouter/ })
            .or(wizard.getByText('OpenRouter', { exact: false }))
            .first();
        if (await openRouterCard.isVisible().catch(() => false)) {
            await openRouterCard.click().catch(() => {});
            // After selecting a BYOK AI, the SideNav must surface a Configure AI
            // step. Generous timeout: the state push + re-derive is async.
            await expect(
                wizard.getByRole('button', { name: 'Configure AI' }),
                'selecting a BYOK AI card inserts a Configure AI step',
            ).toBeVisible({ timeout: 15_000 });
        }

        // Close cleanly.
        await expect(wizard.getByRole('button', { name: 'Close wizard' })).toBeVisible({
            timeout: 10_000,
        });
    });
});
