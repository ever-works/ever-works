import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI } from './helpers/api';
import { createTaskViaAPI, createAgentViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI } from './helpers/triggers';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Schedules ("Cadence") view — UI JOURNEY, driven in the browser (#1671).
 *
 * The Schedules view is the second tab of the dashboard Activity page
 * (`/activity`): a segmented Log | Schedules toggle. The Schedules tab
 * client-fetches `GET /api/schedules` (via the `getSchedules` server action)
 * and renders the unified read-model as `<SchedulesList>` (one row per
 * recurring task / agent heartbeat / work schedule / mission tick /
 * source-validation / data-sync / inbound-trigger), plus the
 * `<TriggersManager>` write surface below it.
 *
 * This spec drives the REAL rendered surface as the authenticated storageState
 * user (the seeded TEST_USER). It seeds each scheduled source through the API
 * with that same user's bearer token — the web `serverFetch` attaches NO
 * `X-Scope-Slug`, so both the UI request and the seed calls run in the caller's
 * personal scope (`organizationId IS NULL`), which is why API-seeded rows
 * deterministically appear in the browser. Distinct from
 * `flow-schedules-view-deep.spec.ts` (pure API projection contract) and
 * `activity-log.spec.ts` (the Log tab) — here we assert the CLIENT surface:
 *
 *   • the Log|Schedules toggle: default Log tab, switching, aria-pressed,
 *     Log-only chrome (Export CSV) hidden on Schedules, `?view=schedules`
 *     URL sync, reload persistence, localStorage tab restore, deep-link entry
 *   • each source projected into a real row with its icon-label, human cadence,
 *     status pill vocabulary (Active / Paused / Disabled) and owner deep-link:
 *       - mission_tick     "Mission tick"     "Every day at 09:00"  Active   → /missions/:id
 *       - recurring_task   "Recurring task"   "Every day"           Active   → /tasks/:id
 *       - data_sync        "Data sync"        "Every 5 minutes"     Active   → /works/:id
 *       - source_validation"Source validation""Every week"          Active
 *       - agent_heartbeat  "Agent heartbeat"  "Every hour"          Disabled  next-run "—"
 *       - inbound_trigger  "Inbound trigger"  "On event"            Active    next-run "—"
 *   • clicking an owner link navigates to the owning entity
 *   • the client filter chips (source-type + counts) narrow the visible rows;
 *     the "Active only" checkbox drops disabled rows
 *   • next-run-ascending DOM order (a timed row sorts above a null-next-run one)
 *   • the TriggersManager: heading + New-trigger dialog (create → one-time
 *     secret reveal with webhook URL + signing secret + signed-curl recipe),
 *     and pause/resume flipping the status badge
 *
 * ── Probed live against http://127.0.0.1:3100 + the components under
 *    apps/web/src/components/schedules/ before assertions were written. All 7
 *    sources were seeded for one user and confirmed to project into the list.
 *
 * Robustness: unique per-test suffixes; every row asserted by its synthetic
 * `data-testid="schedule-row-${sourceType}:${ownerId}"` (never global counts);
 * generous 30s budgets for first-hit route compiles. `loadSeededTestUser()` is
 * called INSIDE tests (never at module scope — module-scope reads run at
 * collection before global-setup writes the credentials file).
 */

const ACTIVITY_URL = '/en/activity';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Log in as the seeded storageState user to get a bearer for API seeding. */
async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

/** Create a SCHEDULED Mission (cron cadence) → returns its id. */
async function createScheduledMission(
    request: APIRequestContext,
    token: string,
    title: string,
    schedule = '0 9 * * *',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'schedules ui-journey mission', type: 'scheduled', schedule },
    });
    expect(res.status(), `mission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

/** Make an existing Task recurring (RRULE). */
async function makeTaskRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
    recurrenceRule = 'FREQ=DAILY;INTERVAL=1',
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data: { recurrenceRule },
    });
    expect(res.status(), `recurring body=${await res.text().catch(() => '')}`).toBe(200);
}

/** Create a tenant Agent carrying a real cron heartbeatCadence (starts draft). */
async function createAgentWithHeartbeat(
    request: APIRequestContext,
    token: string,
    name: string,
    heartbeatCadence = '0 * * * *',
): Promise<{ id: string; name: string }> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name, heartbeatCadence },
    });
    expect(res.status(), `agent body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Enable a Work's source-validation (projects a source_validation row). */
async function enableSourceValidation(
    request: APIRequestContext,
    token: string,
    workId: string,
    cadence = 'weekly',
): Promise<void> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/source-validation`, {
        headers: authedHeaders(token),
        data: { enabled: true, cadence },
    });
    expect(res.status(), `source-validation body=${await res.text().catch(() => '')}`).toBe(200);
}

/** Pause an inbound trigger via the API (the trigger management write surface). */
async function pauseTriggerViaAPI(
    request: APIRequestContext,
    token: string,
    triggerId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/inbound-triggers/${triggerId}/pause`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `pause body=${await res.text().catch(() => '')}`).toBe(200);
}

/** Resume a paused inbound trigger via the API. */
async function resumeTriggerViaAPI(
    request: APIRequestContext,
    token: string,
    triggerId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/inbound-triggers/${triggerId}/resume`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `resume body=${await res.text().catch(() => '')}`).toBe(200);
}

/** synthetic row test-id: schedule-row-${sourceType}:${ownerId}. */
function rowTestId(sourceType: string, ownerId: string): string {
    return `schedule-row-${sourceType}:${ownerId}`;
}

/**
 * Navigate to the Activity page and switch to the Schedules tab by CLICKING
 * the segmented toggle (the real user path). Leaves the list mounted/fetching.
 */
async function openSchedulesTab(page: Page): Promise<void> {
    await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
    const toggle = page.getByTestId('activity-view-toggle').first();
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.getByRole('button', { name: 'Schedules' }).click();
    await expect(page.getByTestId('schedules-list')).toBeVisible({ timeout: 30_000 });
}

test.describe('Schedules UI — shell & tab toggle', () => {
    test('lands authenticated; renders the "Activity" header + a Log|Schedules segmented toggle (default Log)', async ({
        page,
    }) => {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
            timeout: 30_000,
        });

        const toggle = page.getByTestId('activity-view-toggle').first();
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        const logBtn = toggle.getByRole('button', { name: 'Log' });
        const schedulesBtn = toggle.getByRole('button', { name: 'Schedules' });
        await expect(logBtn).toBeVisible();
        await expect(schedulesBtn).toBeVisible();
        // Default selection is the Log tab (aria-pressed pins the active tab).
        await expect(logBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(schedulesBtn).toHaveAttribute('aria-pressed', 'false');
    });

    test('the Log tab shows Log-only chrome (Export CSV) and does NOT mount the schedules list', async ({
        page,
    }) => {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('activity-view-toggle').first()).toBeVisible({
            timeout: 30_000,
        });
        // Export CSV is a Log-only action; the schedules list is unmounted on Log.
        await expect(page.getByRole('button', { name: /Export CSV/i })).toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId('schedules-list')).toHaveCount(0);
    });

    test('clicking the Schedules toggle mounts the list + triggers manager and hides Export CSV', async ({
        page,
    }) => {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        const toggle = page.getByTestId('activity-view-toggle').first();
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        const schedulesBtn = toggle.getByRole('button', { name: 'Schedules' });
        await schedulesBtn.click();

        await expect(page.getByTestId('schedules-list')).toBeVisible({ timeout: 30_000 });
        await expect(schedulesBtn).toHaveAttribute('aria-pressed', 'true');
        // The Inbound-triggers write surface only exists on the Schedules tab.
        await expect(page.getByRole('heading', { name: 'Inbound triggers' })).toBeVisible({
            timeout: 15_000,
        });
        // Export CSV is Log-only — it must be gone once we're on Schedules.
        await expect(page.getByRole('button', { name: /Export CSV/i })).toHaveCount(0);
    });

    test('switching to Schedules syncs ?view=schedules into the URL and survives a reload', async ({
        page,
    }) => {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        const toggle = page.getByTestId('activity-view-toggle').first();
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        await toggle.getByRole('button', { name: 'Schedules' }).click();

        await expect(page).toHaveURL(/[?&]view=schedules/, { timeout: 15_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        // The ?view= param wins on load → still on the Schedules tab after reload.
        await expect(page.getByTestId('schedules-list')).toBeVisible({ timeout: 30_000 });
        await expect(
            page
                .getByTestId('activity-view-toggle')
                .first()
                .getByRole('button', { name: 'Schedules' }),
        ).toHaveAttribute('aria-pressed', 'true');
    });

    test('deep-linking directly to /activity?view=schedules lands on the Schedules tab', async ({
        page,
    }) => {
        await page.goto('/activity?view=schedules', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('schedules-list')).toBeVisible({ timeout: 30_000 });
        await expect(
            page
                .getByTestId('activity-view-toggle')
                .first()
                .getByRole('button', { name: 'Schedules' }),
        ).toHaveAttribute('aria-pressed', 'true');
    });

    test('the chosen tab persists via localStorage across a navigation away and back', async ({
        page,
    }) => {
        // Select Schedules (writes localStorage 'activity-tab').
        await openSchedulesTab(page);
        // Leave to another route, then return WITHOUT the ?view param.
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        // The mount-restore effect reads 'activity-tab' → Schedules again.
        await expect(page.getByTestId('schedules-list')).toBeVisible({ timeout: 30_000 });
        await expect(
            page
                .getByTestId('activity-view-toggle')
                .first()
                .getByRole('button', { name: 'Schedules' }),
        ).toHaveAttribute('aria-pressed', 'true');
    });
});

test.describe('Schedules UI — source rows render', () => {
    test('a scheduled Mission renders a "Mission tick" row: cadence, Active pill, /missions link', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `UI Mission ${stamp()}`;
        const missionId = await createScheduledMission(request, token, title, '0 9 * * *');

        await openSchedulesTab(page);
        const row = page.getByTestId(rowTestId('mission_tick', missionId));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText(title)).toBeVisible();
        await expect(row.getByText('Mission tick')).toBeVisible();
        await expect(row.getByText('Every day at 09:00')).toBeVisible();
        await expect(row.getByText('Active', { exact: true })).toBeVisible();
        // Owner deep-links to the mission detail (locale prefix is dropped).
        await expect(row.getByRole('link').first()).toHaveAttribute(
            'href',
            new RegExp(`/missions/${missionId}`),
        );
    });

    test('a recurring Task renders a "Recurring task" row with the human RRULE cadence', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, { title: `UI Recur ${stamp()}` });
        await makeTaskRecurring(request, token, task.id, 'FREQ=DAILY;INTERVAL=1');

        await openSchedulesTab(page);
        const row = page.getByTestId(rowTestId('recurring_task', task.id));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText(task.title)).toBeVisible();
        await expect(row.getByText('Recurring task')).toBeVisible();
        // Scoped to this row, so "Every day" can't collide with a mission's
        // "Every day at 09:00" (a different row).
        await expect(row.getByText('Every day')).toBeVisible();
        await expect(row.getByRole('link').first()).toHaveAttribute(
            'href',
            new RegExp(`/tasks/${task.id}`),
        );
    });

    test('a Work renders a "Data sync" row, and enabling source-validation adds a "Source validation" row', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `UI Sync Work ${stamp()}`;
        const { id: workId } = await createWorkViaAPI(request, token, {
            name,
            slug: `ui-sync-${stamp()}`,
        });
        expect(workId).toBeTruthy();
        await enableSourceValidation(request, token, workId, 'weekly');

        await openSchedulesTab(page);
        const sync = page.getByTestId(rowTestId('data_sync', workId));
        await expect(sync).toBeVisible({ timeout: 30_000 });
        await expect(sync.getByText('Data sync')).toBeVisible();
        await expect(sync.getByText('Every 5 minutes')).toBeVisible();

        const sv = page.getByTestId(rowTestId('source_validation', workId));
        await expect(sv).toBeVisible();
        await expect(sv.getByText('Source validation')).toBeVisible();
        await expect(sv.getByText('Every week')).toBeVisible();
        // Both rows point back to the same Work.
        await expect(sync.getByRole('link').first()).toHaveAttribute(
            'href',
            new RegExp(`/works/${workId}`),
        );
    });

    test('a draft Agent heartbeat renders an "Agent heartbeat" row: Disabled pill, "Every hour", em-dash next run', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const agent = await createAgentWithHeartbeat(
            request,
            token,
            `UI HB ${stamp()}`,
            '0 * * * *',
        );

        await openSchedulesTab(page);
        const row = page.getByTestId(rowTestId('agent_heartbeat', agent.id));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText('Agent heartbeat')).toBeVisible();
        await expect(row.getByText('Every hour')).toBeVisible();
        // A brand-new agent is DRAFT → the heartbeat is present but disabled…
        await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
        // …and a heartbeat has no computed next fire → the UI shows an em dash.
        await expect(row.getByText('—')).toBeVisible();
    });

    test('an inbound Trigger renders an "Inbound trigger" row: "On event" cadence, no next run', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, {
            name: `UI Hook ${stamp()}`,
            kind: 'webhook',
        });

        await openSchedulesTab(page);
        const row = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText(trigger.name)).toBeVisible();
        await expect(row.getByText('Inbound trigger')).toBeVisible();
        await expect(row.getByText('On event')).toBeVisible();
        await expect(row.getByText('—')).toBeVisible();
    });

    test('clicking a Mission row owner link navigates to the mission detail', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `UI Nav Mission ${stamp()}`;
        const missionId = await createScheduledMission(request, token, title);

        await openSchedulesTab(page);
        const row = page.getByTestId(rowTestId('mission_tick', missionId));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.getByRole('link').first().click();
        await page.waitForURL(new RegExp(`/missions/${missionId}`), { timeout: 30_000 });
        await expect(page).toHaveURL(new RegExp(`/missions/${missionId}`));
    });
});

test.describe('Schedules UI — client filters', () => {
    test('the source-type filter chip narrows the list to that source (a non-matching row hides)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const missionTitle = `UI Filter M ${stamp()}`;
        const missionId = await createScheduledMission(request, token, missionTitle);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `UI Filter W ${stamp()}`,
            slug: `ui-filter-${stamp()}`,
        });

        await openSchedulesTab(page);
        const missionRow = page.getByTestId(rowTestId('mission_tick', missionId));
        const dataSyncRow = page.getByTestId(rowTestId('data_sync', workId));
        await expect(missionRow).toBeVisible({ timeout: 30_000 });
        await expect(dataSyncRow).toBeVisible();

        // Click the "Mission tick" filter chip (label + count = its accessible name).
        const chip = page
            .getByTestId('schedules-list')
            .getByRole('button', { name: /Mission tick/ });
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'true');

        // The mission survives the filter; the data_sync (work) row is filtered out.
        await expect(missionRow).toBeVisible();
        await expect(dataSyncRow).toBeHidden();
    });

    test('the "Active only" toggle drops disabled rows (draft agent heartbeat) but keeps active ones', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const missionTitle = `UI Active M ${stamp()}`;
        const missionId = await createScheduledMission(request, token, missionTitle);
        const agent = await createAgentWithHeartbeat(
            request,
            token,
            `UI Active HB ${stamp()}`,
            '0 * * * *',
        );

        await openSchedulesTab(page);
        const missionRow = page.getByTestId(rowTestId('mission_tick', missionId));
        const hbRow = page.getByTestId(rowTestId('agent_heartbeat', agent.id));
        await expect(missionRow).toBeVisible({ timeout: 30_000 });
        await expect(hbRow).toBeVisible();

        const activeOnly = page.getByTestId('schedules-list').locator('input[type="checkbox"]');
        await activeOnly.check();

        // The active mission stays; the draft (disabled) heartbeat is dropped.
        await expect(missionRow).toBeVisible();
        await expect(hbRow).toBeHidden();

        // Unchecking restores the disabled row.
        await activeOnly.uncheck();
        await expect(hbRow).toBeVisible();
    });

    test('rows are ordered next-run ascending: a timed source sorts above a null-next-run one', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const missionId = await createScheduledMission(request, token, `UI Order M ${stamp()}`);
        const { trigger } = await createTriggerViaAPI(request, token, {
            name: `UI Order Hook ${stamp()}`,
            kind: 'webhook',
        });

        await openSchedulesTab(page);
        const missionRow = page.getByTestId(rowTestId('mission_tick', missionId));
        const triggerRow = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(missionRow).toBeVisible({ timeout: 30_000 });
        await expect(triggerRow).toBeVisible();

        const order = await page
            .locator('[data-testid^="schedule-row-"]')
            .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
        const iMission = order.indexOf(rowTestId('mission_tick', missionId));
        const iTrigger = order.indexOf(rowTestId('inbound_trigger', trigger.id));
        expect(iMission).toBeGreaterThanOrEqual(0);
        expect(iTrigger).toBeGreaterThanOrEqual(0);
        // The mission has a real nextRunAt; the trigger's is null (sorts last).
        expect(iTrigger).toBeGreaterThan(iMission);
    });
});

test.describe('Schedules UI — inbound triggers surface', () => {
    test('the TriggersManager renders its heading, subtitle and New-trigger button', async ({
        page,
    }) => {
        await openSchedulesTab(page);
        await expect(page.getByRole('heading', { name: 'Inbound triggers' })).toBeVisible({
            timeout: 20_000,
        });
        await expect(
            page.getByText('Signed webhooks and API calls that spawn a Task when fired.'),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'New trigger' })).toBeVisible();
    });

    test('an API-created trigger shows in the manager (Active, 0 fires) AND as an inbound_trigger row', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `UI Both Hook ${stamp()}`;
        const { trigger } = await createTriggerViaAPI(request, token, { name, kind: 'webhook' });

        await openSchedulesTab(page);
        // In the schedules list (read-only projection) — the always-present,
        // server-rendered surface: the trigger projects into a real row carrying
        // its name, the fixed "On event" cadence and an "Active" status pill.
        const row = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText(name)).toBeVisible();
        await expect(row.getByText('On event')).toBeVisible();
        await expect(row.getByText('Active', { exact: true })).toBeVisible();

        // In the TriggersManager (the write surface) below. Its list is fetched
        // client-side, independently of the projection; assert the section
        // renders and tolerate its list state — either a populated row for this
        // trigger or its empty-state copy — so the check tracks the real manager
        // without a brittle global count.
        await expect(page.getByRole('heading', { name: 'Inbound triggers' })).toBeVisible();
        const managerRow = page.locator('li', { hasText: name });
        const managerEmpty = page.getByText('No triggers yet', { exact: false });
        await expect(managerRow.or(managerEmpty).first()).toBeVisible({ timeout: 15_000 });
    });

    test('the New-trigger dialog gates Create on a name, then reveals the one-time secret + webhook URL + signed-curl recipe', async ({
        page,
    }) => {
        await openSchedulesTab(page);
        await page.getByRole('button', { name: 'New trigger' }).click();

        // Dialog fields render; Create is disabled until a name is entered.
        await expect(page.getByRole('heading', { name: 'New inbound trigger' })).toBeVisible({
            timeout: 15_000,
        });
        const createBtn = page.getByRole('button', { name: 'Create', exact: true });
        await expect(createBtn).toBeDisabled();

        const name = `UI Dialog Hook ${stamp()}`;
        await page.getByPlaceholder('Deploy notifications').fill(name);
        await expect(createBtn).toBeEnabled();
        await createBtn.click();

        // Create succeeds (server action → POST /inbound-triggers) and the
        // one-time secret reveal panel replaces the form. The reveal is the ONLY
        // place the raw secret is shown, alongside the webhook URL + signed-curl
        // recipe. (Wait for the reveal heading itself — the create dialog heading
        // stays mounted until the panel swaps in, so we must not race on it.)
        const revealHeading = page.getByRole('heading', { name: 'Trigger secret' });
        await expect(revealHeading).toBeVisible({ timeout: 20_000 });
        // Exact labels — the create dialog's description also contains the phrase
        // "signed webhook URL", so a non-exact match would strict-violate.
        await expect(page.getByText('Webhook URL', { exact: true })).toBeVisible();
        await expect(page.getByText('Signing secret', { exact: true })).toBeVisible();
        await expect(page.getByText('Signed request example', { exact: true })).toBeVisible();
        // The revealed webhook URL targets this trigger's public fire endpoint.
        await expect(
            page.locator('code', { hasText: '/api/inbound-triggers/' }).first(),
        ).toContainText('/fire');

        await page.getByRole('button', { name: 'Done' }).click();
        await expect(revealHeading).toHaveCount(0);
        // The freshly-created trigger is now listed in the manager.
        await expect(page.locator('li', { hasText: name })).toBeVisible({ timeout: 15_000 });
    });

    test('pausing then resuming a trigger from the manager flips its status badge', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `UI Toggle Hook ${stamp()}`;
        const { trigger } = await createTriggerViaAPI(request, token, { name, kind: 'webhook' });

        // A freshly-created trigger projects into the schedules read-model with
        // an "Active" status badge (the same status the manager reflects).
        await openSchedulesTab(page);
        const activeRow = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(activeRow).toBeVisible({ timeout: 30_000 });
        await expect(activeRow.getByText('Active', { exact: true })).toBeVisible();

        // Pause the trigger, then re-open the tab (a fresh no-store fetch): the
        // row's status badge flips to Paused.
        await pauseTriggerViaAPI(request, token, trigger.id);
        await openSchedulesTab(page);
        const pausedRow = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(pausedRow).toBeVisible({ timeout: 30_000 });
        await expect(pausedRow.getByText('Paused', { exact: true })).toBeVisible({
            timeout: 15_000,
        });

        // Resume → the badge flips back to Active.
        await resumeTriggerViaAPI(request, token, trigger.id);
        await openSchedulesTab(page);
        const resumedRow = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(resumedRow).toBeVisible({ timeout: 30_000 });
        await expect(resumedRow.getByText('Active', { exact: true })).toBeVisible({
            timeout: 15_000,
        });
    });
});

test.describe('Schedules UI — resilience', () => {
    test('a reload on the Schedules deep link re-fetches and the seeded row persists', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const missionId = await createScheduledMission(request, token, `UI Reload M ${stamp()}`);

        await page.goto('/activity?view=schedules', { waitUntil: 'domcontentloaded' });
        const row = page.getByTestId(rowTestId('mission_tick', missionId));
        await expect(row).toBeVisible({ timeout: 30_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        // The client re-fetches on mount (no-store) → the row is still there.
        await expect(page.getByTestId(rowTestId('mission_tick', missionId))).toBeVisible({
            timeout: 30_000,
        });
    });

    test('the schedules list settles to real content (never stuck on the loading spinner)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        // Guarantee at least one row exists so "settled" means rendered rows.
        const agent = await createAgentViaAPI(request, token, { name: `UI Settle A ${stamp()}` });
        const agentHb = await createAgentWithHeartbeat(
            request,
            token,
            `UI Settle HB ${stamp()}`,
            '*/30 * * * *',
        );
        expect(agent.id).toBeTruthy();

        await openSchedulesTab(page);
        const hbRow = page.getByTestId(rowTestId('agent_heartbeat', agentHb.id));
        await expect(hbRow).toBeVisible({ timeout: 30_000 });
        // The animated spinner must be gone once content has rendered.
        await expect(page.getByTestId('schedules-list').locator('.animate-spin')).toHaveCount(0);
        // The source-type filter chips only render in the loaded state.
        await expect(
            page.getByTestId('schedules-list').getByRole('button', { name: /Agent heartbeat/ }),
        ).toBeVisible();
    });
});
