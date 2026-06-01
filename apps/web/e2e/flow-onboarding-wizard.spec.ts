import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-onboarding-wizard.spec.ts — complex, multi-step end-to-end flows for
 * the v2 onboarding wizard (EW-617). Unlike the shallow round-trip smoke in
 * `onboarding-wizard-v2.spec.ts` / `onboarding-deeper.spec.ts`, every test here
 * orchestrates several wizard endpoints in sequence and asserts the EXACT
 * server behaviour verified against the live API at :3100:
 *
 *   - GET   /api/onboarding/state    → { completedAt, dismissedAt, state:V2 }
 *   - PATCH /api/onboarding/state    → deep-merges a partial `{ state }` and
 *                                       echoes the full merged V2 state (200)
 *   - POST  /api/onboarding/complete → sets completedAt (idempotent, 200)
 *   - POST  /api/onboarding/dismiss  → sets dismissedAt (idempotent, 200)
 *   - POST  /api/onboarding/telemetry→ 204 for allow-listed events, 400 else
 *   - GET   /api/onboarding/catalog  → { ai[6], storage[4], deploy[3], plugins[] }
 *
 * The "step list derives from choices" assertion mirrors the product's own
 * `computeStepList` (apps/web/src/components/onboarding/useOnboardingFlow.ts):
 * config sub-steps appear only for non-default choices. We re-implement it
 * here (inline, per the spec rules — do not reach into product source from a
 * test) and assert the derivation against catalog-driven choices.
 *
 * Isolation: all API orchestration runs on FRESH registered users so the
 * shared in-memory DB stays clean and sibling specs are unaffected. The single
 * UI-driven flow uses the seeded storageState user but reaches the wizard via
 * the Help drawer (manual-open path), which is independent of the user's works
 * count / dismissed state — so it is deterministic regardless of what other
 * specs left behind.
 */

// ─── Wire types (subset, matches @ever-works/contracts/api) ──────────────────

type AiChoice = 'ever-works' | 'openrouter' | 'claude-code' | 'codex' | 'gemini' | 'grok';
type StorageChoice = 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git';
type DeployChoice = 'ever-works' | 'vercel' | 'k8s';

interface WizardStateV2 {
    version: 2;
    lastStep: number;
    ai: { choice: AiChoice };
    storage: { choice: StorageChoice };
    deploy: { choice: DeployChoice };
    skippedSteps: string[];
    pluginsReviewed: boolean;
}

interface StateResponse {
    completedAt: string | null;
    dismissedAt: string | null;
    state: WizardStateV2;
}

interface CatalogCard {
    choice: string;
    title: string;
    description: string;
    default: boolean;
    available: boolean;
    badges: string[];
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

// ─── Step derivation (faithful copy of computeStepList) ──────────────────────

/**
 * Mirror of `computeStepList` in useOnboardingFlow.ts. Base flow is always
 * welcome → ai-choice → storage-choice → deploy-choice → plugins-catalog →
 * create-work (6 steps). Per-provider config steps are inserted ONLY for a
 * non-default choice in that bucket. With all defaults that is exactly 6
 * steps; with all BYOK + a self-hosted deploy it is 9.
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

// ─── API helpers (inline — no product helper exists for onboarding) ──────────

const ONB = {
    state: `${API_BASE}/api/onboarding/state`,
    catalog: `${API_BASE}/api/onboarding/catalog`,
    complete: `${API_BASE}/api/onboarding/complete`,
    dismiss: `${API_BASE}/api/onboarding/dismiss`,
    telemetry: `${API_BASE}/api/onboarding/telemetry`,
} as const;

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

// ─── Flow 1: catalog-driven stepping advances state + derives step list ──────

test.describe('Onboarding wizard — catalog-driven multi-step flow', () => {
    test('stepping through catalog choices advances lastStep and grows the derived step list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Step 0 — pristine state for a brand-new user (probe-verified shape).
        const pristine = await getState(request, token);
        expect(pristine.completedAt).toBeNull();
        expect(pristine.dismissedAt).toBeNull();
        expect(pristine.state.version).toBe(2);
        expect(pristine.state.lastStep).toBe(0);
        expect(pristine.state.ai.choice).toBe('ever-works');
        expect(pristine.state.storage.choice).toBe('ever-works-git');
        expect(pristine.state.deploy.choice).toBe('ever-works');
        expect(pristine.state.skippedSteps).toEqual([]);
        expect(pristine.state.pluginsReviewed).toBe(false);

        // With all defaults the wizard renders exactly the 6 base steps —
        // no config sub-steps because every bucket is the Ever Works default.
        expect(computeStepIds(pristine.state)).toEqual([
            'welcome',
            'ai-choice',
            'storage-choice',
            'deploy-choice',
            'plugins-catalog',
            'create-work',
        ]);

        // The catalog is server-authoritative — read it and pick real,
        // available BYOK choices the wizard would expose as cards.
        const catalogRes = await request.get(ONB.catalog, { headers: authedHeaders(token) });
        expect(catalogRes.status()).toBe(200);
        const catalog = (await catalogRes.json()) as CatalogResponse;
        expect(catalog.ai).toHaveLength(6);
        expect(catalog.storage).toHaveLength(4);
        expect(catalog.deploy).toHaveLength(3);
        // Each bucket has exactly one default; AI's default is Ever Works.
        expect(catalog.ai.filter((c) => c.default).map((c) => c.choice)).toEqual(['ever-works']);
        const aiByok = catalog.ai.find((c) => c.badges.includes('byok') && c.available);
        const deployOwn = catalog.deploy.find((c) => c.choice === 'vercel' && c.available);
        const storageOwn = catalog.storage.find((c) => c.choice === 'user-github' && c.available);
        expect(aiByok, 'catalog should expose an available BYOK AI card').toBeTruthy();
        expect(deployOwn, 'catalog should expose Vercel as an available deploy card').toBeTruthy();
        expect(
            storageOwn,
            'catalog should expose Your GitHub as an available storage card',
        ).toBeTruthy();

        // Step 1 — welcome → ai-choice. Persisting lastStep=1 (server echoes
        // the full merged state and round-trips on the next GET).
        const afterWelcome = await patchState(request, token, { lastStep: 1 });
        expect(afterWelcome.state.lastStep).toBe(1);

        // Step 2 — pick a BYOK AI provider. This is the choice that, in the
        // real wizard, INSERTS an ai-config sub-step into the flow.
        const byokAi = aiByok!.choice as AiChoice;
        const afterAi = await patchState(request, token, {
            ai: { choice: byokAi },
            lastStep: 2,
        });
        expect(afterAi.state.ai.choice).toBe(byokAi);
        expect(afterAi.state.lastStep).toBe(2);
        // Other buckets untouched by the deep-merge.
        expect(afterAi.state.storage.choice).toBe('ever-works-git');
        expect(afterAi.state.deploy.choice).toBe('ever-works');

        // The derived step list now includes an ai-config step → 7 steps.
        const stepsAfterAi = computeStepIds(afterAi.state);
        expect(stepsAfterAi).toContain(`ai-config:${byokAi}`);
        expect(stepsAfterAi).toHaveLength(7);

        // Step — pick a non-default storage + deploy that each add a config
        // sub-step, advance lastStep, and skip the plugins step.
        const afterStorageDeploy = await patchState(request, token, {
            storage: { choice: 'user-github' },
            deploy: { choice: 'vercel' },
            skippedSteps: ['plugins-catalog'],
            pluginsReviewed: true,
            lastStep: 5,
        });
        expect(afterStorageDeploy.state.storage.choice).toBe('user-github');
        expect(afterStorageDeploy.state.deploy.choice).toBe('vercel');
        expect(afterStorageDeploy.state.skippedSteps).toEqual(['plugins-catalog']);
        expect(afterStorageDeploy.state.pluginsReviewed).toBe(true);
        expect(afterStorageDeploy.state.lastStep).toBe(5);
        // AI choice from the earlier patch survived (true deep-merge, not replace).
        expect(afterStorageDeploy.state.ai.choice).toBe(byokAi);

        // Now all three buckets are non-default → the full 9-step flow.
        const fullSteps = computeStepIds(afterStorageDeploy.state);
        expect(fullSteps).toEqual([
            'welcome',
            'ai-choice',
            `ai-config:${byokAi}`,
            'storage-choice',
            'storage-config:user-github',
            'deploy-choice',
            'deploy-config:vercel',
            'plugins-catalog',
            'create-work',
        ]);

        // A final independent GET proves the whole sequence persisted on the
        // server (survives a "device switch" — the design goal of v2 state).
        const persisted = await getState(request, token);
        expect(persisted.state.lastStep).toBe(5);
        expect(persisted.state.ai.choice).toBe(byokAi);
        expect(persisted.state.storage.choice).toBe('user-github');
        expect(persisted.state.deploy.choice).toBe('vercel');
        expect(persisted.state.skippedSteps).toEqual(['plugins-catalog']);
        expect(persisted.completedAt).toBeNull();
        expect(persisted.dismissedAt).toBeNull();
    });

    test('rejects out-of-catalog choices and negative steps without corrupting persisted state', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Seed a valid known-good state first.
        await patchState(request, token, { ai: { choice: 'openrouter' }, lastStep: 2 });

        // An AI choice not present in the catalog enum → 400 with the exact
        // class-validator message (probe-verified).
        const badAi = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: { state: { ai: { choice: 'totally-made-up' } } },
        });
        expect(badAi.status()).toBe(400);
        const badAiBody = await badAi.json();
        expect(JSON.stringify(badAiBody.message)).toContain('must be one of the following values');

        // A negative lastStep is rejected by @Min(0).
        const badStep = await request.patch(ONB.state, {
            headers: authedHeaders(token),
            data: { state: { lastStep: -3 } },
        });
        expect(badStep.status()).toBe(400);
        const badStepBody = await badStep.json();
        expect(JSON.stringify(badStepBody.message)).toContain('must not be less than 0');

        // The rejected patches must NOT have mutated the persisted state.
        const after = await getState(request, token);
        expect(after.state.ai.choice).toBe('openrouter');
        expect(after.state.lastStep).toBe(2);
    });
});

// ─── Flow 2: dismiss / complete transitions + badge/auto-open invariants ─────

test.describe('Onboarding wizard — dismiss + complete lifecycle', () => {
    test('dismiss then complete: timestamps accumulate, both are idempotent, and state is preserved', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Make some progress so we can prove dismiss/complete preserve state.
        await patchState(request, token, {
            ai: { choice: 'gemini' },
            deploy: { choice: 'k8s' },
            lastStep: 4,
        });

        // Fresh user starts with neither timestamp set.
        const before = await getState(request, token);
        expect(before.completedAt).toBeNull();
        expect(before.dismissedAt).toBeNull();

        // Dismiss → dismissedAt set, completedAt still null, state preserved.
        const dismissed1 = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissed1.status()).toBe(200);
        const dismissedBody1 = (await dismissed1.json()) as StateResponse;
        expect(dismissedBody1.dismissedAt).not.toBeNull();
        expect(dismissedBody1.completedAt).toBeNull();
        expect(dismissedBody1.state.ai.choice).toBe('gemini');
        expect(dismissedBody1.state.deploy.choice).toBe('k8s');
        expect(dismissedBody1.state.lastStep).toBe(4);

        // Dismiss again → idempotent: the SAME dismissedAt timestamp returns.
        const dismissed2 = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissed2.status()).toBe(200);
        const dismissedBody2 = (await dismissed2.json()) as StateResponse;
        expect(dismissedBody2.dismissedAt).toBe(dismissedBody1.dismissedAt);

        // Complete → completedAt set, dismissedAt unchanged.
        const completed1 = await request.post(ONB.complete, { headers: authedHeaders(token) });
        expect(completed1.status()).toBe(200);
        const completedBody1 = (await completed1.json()) as StateResponse;
        expect(completedBody1.completedAt).not.toBeNull();
        expect(completedBody1.dismissedAt).toBe(dismissedBody1.dismissedAt);

        // Complete again → idempotent: SAME completedAt timestamp returns.
        const completed2 = await request.post(ONB.complete, { headers: authedHeaders(token) });
        expect(completed2.status()).toBe(200);
        const completedBody2 = (await completed2.json()) as StateResponse;
        expect(completedBody2.completedAt).toBe(completedBody1.completedAt);

        // Final GET: both timestamps present, progress intact.
        const final = await getState(request, token);
        expect(final.completedAt).toBe(completedBody1.completedAt);
        expect(final.dismissedAt).toBe(dismissedBody1.dismissedAt);
        expect(final.state.ai.choice).toBe('gemini');
        expect(final.state.lastStep).toBe(4);

        // Badge / auto-open invariants (mirrors layout-client.tsx). Once a user
        // has BOTH dismissed AND completed, the auto-open wizard is suppressed
        // and the header badge is hidden (badge requires !completedAt). Assert
        // the same boolean logic the dashboard layout evaluates server-side.
        const totalWorks = 0; // brand-new user has no works
        const isDismissed = Boolean(final.dismissedAt);
        const isCompleted = Boolean(final.completedAt);
        const shouldAutoOpen = totalWorks === 0 && !isDismissed && !isCompleted;
        const showBadge = totalWorks === 0 && isDismissed && !isCompleted;
        expect(shouldAutoOpen).toBe(false);
        expect(showBadge).toBe(false);
    });

    test('badge invariant: a dismissed-but-not-completed fresh user is in the "show badge" state', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A brand-new user has no works yet. The dashboard layout's auto-open
        // and badge predicates both gate on `totalWorks === 0`.
        const totalWorks = 0;

        // A pristine, never-touched fresh user (no works) is in the auto-open
        // state per the layout rule.
        const pristine = await getState(request, token);
        const pristineAutoOpen =
            totalWorks === 0 && !Boolean(pristine.dismissedAt) && !Boolean(pristine.completedAt);
        expect(pristineAutoOpen).toBe(true);

        // Advance to the plugins step, then dismiss (the wizard's "close"
        // path). The header badge should now show "<lastStep+1>/<totalSteps>".
        await patchState(request, token, { lastStep: 4 });
        const dismissRes = await request.post(ONB.dismiss, { headers: authedHeaders(token) });
        expect(dismissRes.status()).toBe(200);

        const after = await getState(request, token);
        const isDismissed = Boolean(after.dismissedAt);
        const isCompleted = Boolean(after.completedAt);
        const showBadge = totalWorks === 0 && isDismissed && !isCompleted;
        expect(showBadge).toBe(true);

        // Badge label maths: currentStep = min(lastStep + 1, totalSteps),
        // totalSteps = derived step count. All defaults → 6 steps, lastStep 4
        // → badge reads "5/6".
        const totalSteps = computeStepIds(after.state).length;
        const currentStep = Math.min(after.state.lastStep + 1, totalSteps);
        expect(totalSteps).toBe(6);
        expect(currentStep).toBe(5);
    });

    test('UI: the wizard is reachable from the Help drawer and renders the derived step list', async ({
        page,
        request,
        baseURL,
    }) => {
        // This is the one UI-driven flow. It uses the seeded storageState user
        // (the dashboard chromium project). We do NOT rely on auto-open (which
        // depends on the seeded user's works count, mutated by sibling specs).
        // Instead we open the wizard via the Help drawer's "Open onboarding"
        // entry — the manual-open path, always available regardless of state.
        const origin = new URL(baseURL || 'http://localhost:3000').origin;
        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        await page.goto('/works', { waitUntil: 'domcontentloaded' });

        // Wait for the dashboard shell to hydrate (the header help button or
        // any dashboard chrome). Generous timeout for next-dev cold compile.
        await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 });

        // Open the Help drawer. The "?" global shortcut fires onOpenHelp; it is
        // ignored while focus is in an input, so blur first. Retry-to-open to
        // ride out the dev-mode hydration race.
        const helpTitle = page.getByRole('heading', { name: 'Help & Resources' });
        await expect(async () => {
            await page.locator('body').click({ position: { x: 5, y: 5 } });
            await page.keyboard.press('?');
            await expect(helpTitle).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });

        // The onboarding entry is always rendered in the drawer and shows
        // "Open onboarding (x/N)" (i18n: dashboard.header.help.onboarding.action).
        const openOnboarding = page.getByRole('button', { name: /Open onboarding \(\d+\/\d+\)/ });
        await expect(openOnboarding).toBeVisible({ timeout: 10_000 });

        // The N in the label must equal the API-derived step count for the
        // seeded user's persisted state — UI and server agree on the flow size.
        // `loadSeededAuthToken` returns null if seeded creds are unavailable, in
        // which case we skip the cross-check but still run the UI assertions.
        const seeded = await loadSeededAuthToken(request);
        if (seeded) {
            const serverState = await getState(request, seeded);
            const expectedTotal = computeStepIds(serverState.state).length;
            const labelText = (await openOnboarding.textContent()) ?? '';
            const match = labelText.match(/\((\d+)\/(\d+)\)/);
            expect(match, `onboarding label had no x/N: "${labelText}"`).toBeTruthy();
            expect(Number(match![2])).toBe(expectedTotal);
        }

        // Click it → the drawer closes and the wizard Dialog opens (manual
        // open path; independent of dismissed/works state). Assert the wizard's
        // own stable chrome appears: the SideNav "Setup" badge heading and the
        // numbered step buttons — these render regardless of which step the
        // wizard restores to from the user's persisted `lastStep`.
        await openOnboarding.click();

        await expect(page.getByText('Get started with Ever Works')).toBeVisible({
            timeout: 15_000,
        });
        // The wizard SideNav lists every derived step as a numbered button.
        // For the seeded user we cannot assume defaults, but the base
        // navigation labels are always present.
        const welcomeNav = page.getByRole('button', { name: 'Welcome' });
        await expect(welcomeNav).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByRole('button', { name: 'Your AI choice' })).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByRole('button', { name: 'Create your first work' })).toBeVisible({
            timeout: 10_000,
        });
        // And the wizard footer's "Close wizard" affordance.
        await expect(page.getByRole('button', { name: 'Close wizard' })).toBeVisible({
            timeout: 10_000,
        });
        // The wizard restores to the user's persisted `lastStep` (probe shows
        // the seeded user can be at step 1 = "ai-choice", mutated by sibling
        // onboarding specs under parallelism), so the welcome step body is NOT
        // guaranteed to be the open step. Jump to step 0 via the "Welcome"
        // SideNav button (flow.jumpTo(0)) so the WelcomeStep body renders, then
        // assert its heading. Retry-to-open rides out the dev hydration race.
        await expect(async () => {
            await welcomeNav.click();
            await expect(page.getByRole('heading', { name: 'Welcome to Ever Works' })).toBeVisible({
                timeout: 3_000,
            });
        }).toPass({ timeout: 15_000 });
    });
});

/**
 * Resolve a bearer token for the seeded storageState user so the UI flow can
 * cross-check the server-side onboarding step count. Returns null (and the UI
 * flow skips the cross-check) if the seeded creds aren't available — the rest
 * of the UI assertions still run. Login DTO is whitelisted to {email,password}.
 */
async function loadSeededAuthToken(request: APIRequestContext): Promise<string | null> {
    try {
        // Lazy import so the module load can't break the API-only flows.
        const { loadSeededTestUser } = await import('./helpers/seeded-test-user');
        const seeded = loadSeededTestUser();
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        if (!res.ok()) return null;
        const body = (await res.json()) as { access_token?: string };
        return body.access_token ?? null;
    } catch {
        return null;
    }
}

// ─── Flow 3: telemetry relay — allow-list enforcement + funnel sequence ──────

test.describe('Onboarding wizard — telemetry relay', () => {
    test('accepts a full allow-listed funnel of events (with and without properties)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A realistic wizard funnel: open → step views/nexts → choice selects →
        // plugins reviewed → completed. Every event is on the server allow-list
        // and must return 204 No Content (probe-verified).
        const funnel: Array<{ event: string; properties?: Record<string, unknown> }> = [
            { event: 'onboarding_opened', properties: { trigger: 'auto' } },
            { event: 'onboarding_step_viewed', properties: { stepKind: 'welcome' } },
            {
                event: 'onboarding_step_next',
                properties: { stepKind: 'welcome', stepId: 'welcome' },
            },
            { event: 'onboarding_ai_choice_selected', properties: { choice: 'openrouter' } },
            { event: 'onboarding_step_next' }, // no properties — server tolerates omission
            { event: 'onboarding_storage_choice_selected', properties: { choice: 'user-github' } },
            { event: 'onboarding_deploy_choice_selected', properties: { choice: 'vercel' } },
            { event: 'onboarding_plugins_step_expanded' },
            { event: 'onboarding_plugins_step_skipped' },
            { event: 'onboarding_completed', properties: {} },
        ];

        for (const evt of funnel) {
            const res = await request.post(ONB.telemetry, {
                headers: authedHeaders(token),
                data: evt,
            });
            expect(res.status(), `event ${evt.event} should be accepted`).toBe(204);
            // 204 = No Content → empty body.
            expect((await res.text()).length).toBe(0);
        }
    });

    test('rejects unknown events and malformed properties; telemetry never blocks state', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Unknown event name → 400 listing the allow-list (probe-verified).
        const unknown = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'definitely_not_allow_listed' },
        });
        expect(unknown.status()).toBe(400);
        const unknownBody = await unknown.json();
        expect(JSON.stringify(unknownBody.message)).toContain(
            'must be one of the following values',
        );
        // The allow-list includes the canonical first event, proving the
        // message enumerates the real set.
        expect(JSON.stringify(unknownBody.message)).toContain('onboarding_opened');

        // properties present but not an object → 400 from @IsObject.
        const badProps = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'onboarding_opened', properties: 'not-an-object' },
        });
        expect(badProps.status()).toBe(400);
        expect(JSON.stringify(await badProps.json())).toContain('properties must be an object');

        // A subsequent valid telemetry call still succeeds (rejections are
        // per-request and don't poison the user's session).
        const recover = await request.post(ONB.telemetry, {
            headers: authedHeaders(token),
            data: { event: 'onboarding_closed', properties: { completed: false } },
        });
        expect(recover.status()).toBe(204);

        // And telemetry — even when it errored — never touches onboarding
        // state: the user is still pristine.
        const state = await getState(request, token);
        expect(state.completedAt).toBeNull();
        expect(state.dismissedAt).toBeNull();
        expect(state.state.lastStep).toBe(0);
    });

    test('telemetry endpoint requires authentication', async ({ request }) => {
        const res = await request.post(ONB.telemetry, {
            data: { event: 'onboarding_opened' },
        });
        expect(res.status()).toBe(401);
    });
});
