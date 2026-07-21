import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Agents — /en/agents catalog + /agents/[id] detail DRIVEN THROUGH THE UI.
 *
 * This is the *journey / rendering* angle: rather than transitioning the
 * lifecycle over and over (agent-lifecycle-status.spec.ts) or persisting
 * instruction bodies (agent-instruction-files-ui.spec.ts) or pinning the
 * guardrails/scorecard *API* (flow-agent-guardrails-policy-deep,
 * flow-agent-scorecards-deep), it walks the whole detail experience a real
 * operator sees: the overview hero identity, the four quick-stat tiles, the
 * health strip, the capabilities block, the Guardrails card, the 6-tab strip
 * wiring, the 5-pill instructions editor presence, and the Settings status
 * controls that differ per lifecycle state (draft → Activate, active → Pause,
 * paused → Resume). Data is seeded via the API as the SAME seeded user the
 * `chromium` project's storageState authenticates as, so create-via-API agents
 * are visible + mutable in the UI.
 *
 * Probed live (sqlite in-memory) before writing assertions:
 *   - POST /api/agents { scope:'tenant', name } → 201 draft agent; slug from
 *     name; title=null, modelId=null, idleBehavior='propose', errorCount=0,
 *     pauseAfterFailures=3, guardrails=null, scorecard=null, avatarMode='initials'.
 *   - PATCH /api/agents/:id accepts { title, capabilities, modelId,
 *     heartbeatCadence } (200). idleBehavior enum is ['propose','noop','observe']
 *     server-side — the dashboard only labels 'propose' ("Propose work"), so we
 *     leave it at the default.
 *   - POST /api/agents/:id/resume → 200 'active'; /pause → 200 'paused'.
 *   - Guardrails are set via the WRAPPED PUT body { guardrails:{ mode, … } }
 *     (a bare { mode } → 400 forbidNonWhitelisted) — but this spec only reads
 *     the default require_approval posture the card renders for a fresh agent.
 *   - Dashboard hero renders `{scope} scope` ("tenant scope"), `modelId ??
 *     'default model'`, `title ?? 'No title set'`, the slug, and a lowercase
 *     status badge. Health strip = "Healthy" + "0 errors · pauses after 3
 *     consecutive failures" for a fresh agent.
 *   - Card (list): scope 'tenant' renders label "Workspace"; status labels
 *     "Draft"/"Active"/"Paused"; list is newest-first so a just-created agent
 *     is in the default limit=50 page.
 */

interface UiAgent {
    id: string;
    slug: string;
    name: string;
    status: string;
}

let cachedToken: string | undefined;

async function seededToken(request: APIRequestContext): Promise<string> {
    if (cachedToken) return cachedToken;
    // NB: loadSeededTestUser() is called lazily INSIDE this helper (never at
    // module scope) — a module-scope read runs at collection time and reddens
    // every shard before global-setup has written the credentials file.
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    cachedToken = access_token;
    return access_token;
}

function uniqueName(): string {
    return `Journey Agent ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createSeededAgent(
    request: APIRequestContext,
    patch?: Record<string, unknown>,
): Promise<UiAgent> {
    const token = await seededToken(request);
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name: uniqueName() },
    });
    expect(res.status(), `create agent body=${await res.text().catch(() => '')}`).toBe(201);
    const agent = (await res.json()) as UiAgent;
    if (patch) {
        const p = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(token),
            data: patch,
        });
        expect(p.status(), `patch body=${await p.text().catch(() => '')}`).toBe(200);
    }
    return agent;
}

async function moveStatus(
    request: APIRequestContext,
    id: string,
    action: 'resume' | 'pause',
): Promise<string> {
    const token = await seededToken(request);
    const res = await request.post(`${API_BASE}/api/agents/${id}/${action}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `${action} body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()) as UiAgent).status;
}

// ---------------------------------------------------------------------------
// Agents catalog (/agents) — prompt-first surface + card grid
// ---------------------------------------------------------------------------

test.describe('Agents catalog UI — prompt-first surface', () => {
    test('renders the Agents header, prompt composer, and manual-create affordance', async ({
        page,
    }) => {
        await page.goto('/en/agents', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);

        await expect(
            page.getByRole('heading', { name: 'Agents', exact: true }).first(),
        ).toBeVisible({ timeout: 30_000 });
        // The prompt-first composer is the primary create surface (testId="agents-prompt").
        await expect(page.locator('[data-testid="agents-prompt"]').first()).toBeVisible({
            timeout: 15_000,
        });
        // The "Or → Create Agent Manually" alternative below the composer.
        await expect(page.getByText('Or', { exact: true }).first()).toBeVisible();
        await expect(page.getByText('Create Agent Manually').first()).toBeVisible();
    });

    test('an API-created draft agent appears as a card with its name, Draft badge, and Workspace scope', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);

        await page.goto('/en/agents', { waitUntil: 'domcontentloaded' });
        // Scope to the card's own anchor (href ends at /agents/:id) so status
        // and scope labels can't be satisfied by a neighbouring agent's card.
        const card = page.locator(`a[href$="/agents/${agent.id}"]`).first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card.getByText(agent.name)).toBeVisible();
        await expect(card.getByText('Draft', { exact: true })).toBeVisible();
        // scope 'tenant' is labelled "Workspace" on the card.
        await expect(card.getByText('Workspace', { exact: true })).toBeVisible();
    });

    test('clicking a card navigates to that agent’s detail dashboard', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto('/en/agents', { waitUntil: 'domcontentloaded' });
        const card = page.locator(`a[href$="/agents/${agent.id}"]`).first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        await card.click();
        await page.waitForURL(new RegExp(`/agents/${agent.id}$`), { timeout: 30_000 });
        await expect(page.getByText(agent.name).first()).toBeVisible({ timeout: 30_000 });
    });
});

// ---------------------------------------------------------------------------
// Agent detail — dashboard overview (/agents/:id)
// ---------------------------------------------------------------------------

test.describe('Agent detail — dashboard overview', () => {
    test('hero shows identity defaults: name, tenant scope, slug, default model, no title', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });

        // Name renders both in the layout header (h1) and the hero (h2).
        await expect(
            page.getByRole('heading', { name: agent.name, exact: true }).first(),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('tenant scope')).toBeVisible();
        await expect(page.getByText('default model')).toBeVisible();
        await expect(page.getByText('No title set')).toBeVisible();
        await expect(page.getByText(agent.slug).first()).toBeVisible();
    });

    test('hero reflects PATCHed title + modelId', async ({ page, request }) => {
        const agent = await createSeededAgent(request, {
            title: 'Chief of Staff',
            modelId: 'gpt-4o-mini',
        });
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Chief of Staff').first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('gpt-4o-mini').first()).toBeVisible();
        // The default fallbacks must be gone now that real values exist.
        await expect(page.getByText('No title set')).toHaveCount(0);
        await expect(page.getByText('default model')).toHaveCount(0);
    });

    test('quick-stat tiles render heartbeat/idle/last-run/next-heartbeat with fresh defaults', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Heartbeat', { exact: true }).first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('Idle behavior', { exact: true })).toBeVisible();
        await expect(page.getByText('Last run', { exact: true })).toBeVisible();
        await expect(page.getByText('Next heartbeat', { exact: true })).toBeVisible();
        // Default values: no cadence → "Manual"; default idle → "Propose work".
        await expect(page.getByText('Manual', { exact: true })).toBeVisible();
        await expect(page.getByText('Propose work', { exact: true })).toBeVisible();
    });

    test('heartbeat tile shows the PATCHed cadence value', async ({ page, request }) => {
        const agent = await createSeededAgent(request, { heartbeatCadence: '0 9 * * 1' });
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('0 9 * * 1')).toBeVisible({ timeout: 30_000 });
        // The "Manual" default must not also be present for this tile.
        await expect(page.getByText('Manual', { exact: true })).toHaveCount(0);
    });

    test('health strip reads "Healthy" with the pause-after-failures summary for a fresh agent', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 30_000 });
        // Avoid pinning the exact middot separator — match the two stable clauses.
        await expect(page.getByText(/0 errors/)).toBeVisible();
        await expect(page.getByText(/pauses after 3 consecutive failures/)).toBeVisible();
        // The failing-runs banner must NOT appear (errorCount === 0).
        await expect(page.getByText('Recent runs are failing')).toHaveCount(0);
    });

    test('capabilities block shows the empty state by default', async ({ page, request }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Capabilities' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('No capabilities set yet.')).toBeVisible();
    });

    test('capabilities block renders PATCHed capabilities text', async ({ page, request }) => {
        const capabilities = 'Summarizes AI safety papers weekly and posts a digest.';
        const agent = await createSeededAgent(request, { capabilities });
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(capabilities)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('No capabilities set yet.')).toHaveCount(0);
    });

    test('Guardrails card renders with require-approval selected by default', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: 'Guardrails' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('Dispatch mode')).toBeVisible();
        // Fresh agent (guardrails: null) → the card defaults to require_approval.
        const requireApproval = page.getByRole('radio', { name: /Require approval/i });
        const autonomous = page.getByRole('radio', { name: /Autonomous/i });
        await expect(requireApproval).toBeChecked();
        await expect(autonomous).not.toBeChecked();
        // Blocked-action-type checkboxes + the save affordance are present.
        await expect(page.getByText('Blocked action types')).toBeVisible();
        await expect(page.getByText('Budget override').first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save guardrails' })).toBeVisible();
    });
});

// ---------------------------------------------------------------------------
// Agent detail — 6-tab strip navigation
// ---------------------------------------------------------------------------

test.describe('Agent detail — tab navigation', () => {
    test('the tab strip exposes all six detail tabs as links', async ({ page, request }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        // Header name confirms the layout mounted before we probe the strip.
        await expect(page.getByText(agent.name).first()).toBeVisible({ timeout: 30_000 });

        await expect(page.locator(`a[href$="/agents/${agent.id}"]`).first()).toBeVisible();
        for (const tab of ['activity', 'instructions', 'skills', 'budgets', 'settings']) {
            await expect(
                page.locator(`a[href$="/agents/${agent.id}/${tab}"]`).first(),
            ).toBeVisible();
        }
    });

    test('clicking the Instructions tab client-navigates to the editor', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        const link = page.locator(`a[href$="/agents/${agent.id}/instructions"]`).first();
        await expect(link).toBeVisible({ timeout: 30_000 });
        await link.click();
        await page.waitForURL(new RegExp(`/agents/${agent.id}/instructions`), { timeout: 30_000 });
        // The SOUL.md textarea (aria-label) is the landing editor.
        await expect(page.getByRole('textbox', { name: 'SOUL.md' })).toBeVisible({
            timeout: 30_000,
        });
    });

    test('clicking the Settings tab client-navigates to the settings sections', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        const link = page.locator(`a[href$="/agents/${agent.id}/settings"]`).first();
        await expect(link).toBeVisible({ timeout: 30_000 });
        await link.click();
        await page.waitForURL(new RegExp(`/agents/${agent.id}/settings`), { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Runtime' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Permissions' })).toBeVisible();
    });

    test('the secondary tabs (activity/skills/budgets) resolve while the header persists', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        for (const tab of ['activity', 'skills', 'budgets']) {
            await page.goto(`/en/agents/${agent.id}/${tab}`, { waitUntil: 'domcontentloaded' });
            await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/${tab}`));
            // The layout header (agent name) is shared across every tab body.
            await expect(page.getByText(agent.name).first()).toBeVisible({ timeout: 30_000 });
            // A resolved route, not a Next notFound() page.
            await expect(page.getByText(/this page could not be found/i)).toHaveCount(0);
        }
    });
});

// ---------------------------------------------------------------------------
// Instruction-files editor presence
// ---------------------------------------------------------------------------

test.describe('Agent detail — instruction files editor', () => {
    test('the Instructions tab renders the 5 canonical file pills and switches the editor', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}/instructions`, { waitUntil: 'domcontentloaded' });

        for (const name of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml']) {
            await expect(page.getByRole('button', { name, exact: true })).toBeVisible({
                timeout: 30_000,
            });
        }
        // The active editor is a single textarea whose aria-label follows the
        // selected pill — SOUL.md on first load.
        await expect(page.getByRole('textbox', { name: 'SOUL.md' })).toBeVisible();
        // Switching pills retargets the editor to that file.
        await page.getByRole('button', { name: 'AGENTS.md', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'AGENTS.md' })).toBeVisible({
            timeout: 15_000,
        });
    });
});

// ---------------------------------------------------------------------------
// Settings — status controls per lifecycle state
// ---------------------------------------------------------------------------

test.describe('Agent settings — status controls', () => {
    test('a draft agent offers Activate + Archive (no Pause)', async ({ page, request }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
        // draft → active is the only forward hop; there is no Pause yet.
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    });

    test('an active agent offers Pause + Archive (no Activate/Resume)', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        expect(await moveStatus(request, agent.id, 'resume')).toBe('active');
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Activate', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    });

    test('a paused agent offers Resume + Archive (no Pause)', async ({ page, request }) => {
        const agent = await createSeededAgent(request);
        expect(await moveStatus(request, agent.id, 'resume')).toBe('active');
        expect(await moveStatus(request, agent.id, 'pause')).toBe('paused');
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
    });

    test('the permissions section lists the eight capability toggles + a save button', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Permissions' })).toBeVisible({
            timeout: 30_000,
        });
        for (const label of [
            'Create agents',
            'Assign tasks',
            'Edit skills',
            'Edit instructions',
            'Spend budget',
            'Commit to repo',
            'Open pull requests',
            'Call external tools',
        ]) {
            await expect(page.getByText(label, { exact: true })).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
    });

    test('clicking Activate on a draft agent flips its persisted status to active', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        const token = await seededToken(request);
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });
        const activate = page.getByRole('button', { name: 'Activate', exact: true });
        await expect(activate).toBeVisible({ timeout: 30_000 });
        await activate.click();

        // The server action mutates via the same seeded user; assert on the
        // persisted API status (most robust vs. any client re-render timing).
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
                        headers: authedHeaders(token),
                    });
                    return ((await res.json()) as UiAgent).status;
                },
                { timeout: 20_000 },
            )
            .toBe('active');
    });
});

// ---------------------------------------------------------------------------
// Settings — scorecard section
// ---------------------------------------------------------------------------

test.describe('Agent settings — scorecard section', () => {
    test('the scorecard card renders its empty state and opens the metric editor', async ({
        page,
        request,
    }) => {
        const agent = await createSeededAgent(request);
        await page.goto(`/en/agents/${agent.id}/settings`, { waitUntil: 'domcontentloaded' });

        const scorecard = page.locator('[data-testid="agent-scorecard"]');
        await expect(scorecard).toBeVisible({ timeout: 30_000 });
        await expect(scorecard.getByRole('heading', { name: 'Scorecard' })).toBeVisible();
        await expect(
            scorecard.getByText(
                "No metrics yet. Add quantified goals so this Agent's output is measurable.",
            ),
        ).toBeVisible();
        // Entering edit mode reveals the "Add metric" affordance.
        await page.locator('[data-testid="scorecard-edit"]').click();
        await expect(page.getByRole('button', { name: 'Add metric' })).toBeVisible({
            timeout: 15_000,
        });
    });
});
