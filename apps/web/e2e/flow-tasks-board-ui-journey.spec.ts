import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createTaskViaAPI, transitionTaskViaAPI, type Task } from './helpers/agents-tasks';

/**
 * `/tasks` BOARD — the list-page shell, its three view modes, and the
 * KANBAN board's inline "Move →" status transition. This is the board /
 * multi-column journey, deliberately DISTINCT from the existing specs:
 *
 *   - `tasks.spec.ts` (UI block) only proves the /tasks/new form + that an
 *     API-created task appears in the DEFAULT cards view.
 *   - `task-board-lifecycle.spec.ts` drives the "Move to" panel on the
 *     /tasks/:id DETAIL page.
 *
 * NEW angles proven here (all against the real components):
 *   - The view segmented control (Cards / Table / Kanban) toggles view,
 *     with `aria-pressed` reflecting the active tab and Cards as default.
 *   - The Kanban board renders all SEVEN status columns
 *     (Backlog, Todo, In Progress, In Review, Blocked, Done, Cancelled).
 *   - The Table view renders its 5 column headers + task rows.
 *   - Status-filter pills (cards view) client-filter the card grid, and are
 *     hidden in kanban (the columns already group by status).
 *   - A KANBAN card's "Move →" menu offers EXACTLY the legal next statuses
 *     for that card's status, clicking one performs the transition
 *     (server action → POST /api/tasks/:id/transition), the API reflects it,
 *     and after a reload the card re-renders in its new column's move-state.
 *   - Cancelled cards expose NO move affordance (terminal state).
 *   - New tasks created via the API appear on the board after reload.
 *
 * Board data contract (PROBED live, sqlite in-memory, all flags on):
 *   - GET /api/tasks → { data:Task[], meta:{ total, limit(=50 default), offset } }
 *   - list is ordered by `task.updatedAt DESC` (repository), so freshly
 *     created / just-transitioned tasks bubble to the top of the 50-window
 *     — that is why newly created seeded-user tasks are reliably visible on
 *     the board (which fetches the newest 50).
 *   - status filter (?status=todo) narrows to that status only.
 *   - Kanban NEXT_STATUS lattice (mirror of TaskTransitionService):
 *       backlog → todo, cancelled
 *       todo    → in_progress, blocked, cancelled
 *       done / cancelled are terminal-ish (done → in_progress only;
 *       cancelled → []).
 *
 * The UI tests run as the seeded user (default `chromium` project reuses the
 * stored storageState); the board only ever shows THAT user's tasks, so the
 * cross-layer tests create their fixtures with the seeded user's own token.
 * The API-contract tests register isolated users for determinism.
 */

// ── View-tab labels (COLUMNS in TasksKanbanView / VIEW_TABS in TasksList) ──
const KANBAN_COLUMNS = [
    'Backlog',
    'Todo',
    'In Progress',
    'In Review',
    'Blocked',
    'Done',
    'Cancelled',
] as const;

const TABLE_HEADERS = ['Slug', 'Title', 'Status', 'Priority', 'Updated'] as const;

function uniq(tag: string): string {
    return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    expect(access_token, 'seeded login returns a bearer token').toBeTruthy();
    return access_token;
}

async function apiStatus(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<string> {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()).status as string;
}

/** Land on the board and wait for its stable toolbar anchor (the view tabs). */
async function gotoBoard(page: Page, query = ''): Promise<void> {
    await page.goto(`/en/tasks${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('button[title="Kanban"]')).toBeVisible({ timeout: 30_000 });
}

/**
 * Switch to the kanban view (idempotent + retry-guarded for the prod-build
 * hydration race). "In Review" is a kanban-only column header — the cards
 * view uses "In review" for its pill and hides pills in kanban — so its
 * visibility is a reliable "we are on the board" signal.
 */
async function openKanban(page: Page): Promise<void> {
    const tab = page.locator('button[title="Kanban"]');
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
        if ((await tab.getAttribute('aria-pressed')) !== 'true') {
            await tab.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(page.getByText('In Review', { exact: true }).first()).toBeVisible({
            timeout: 4_000,
        });
    }).toPass({ timeout: 30_000 });
}

/** The kanban card element (a draggable div) carrying `title`. */
function kanbanCard(page: Page, title: string) {
    return page.locator('[draggable="true"]').filter({ hasText: title }).first();
}

// ─────────────────────────────────────────────────────────────────────────
// A. Board shell + view modes (mostly data-independent structural proofs)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Tasks board — shell & view modes (seeded UI)', () => {
    test('board loads authenticated with the Tasks header, subtitle, and New Task action', async ({
        page,
    }) => {
        await gotoBoard(page);
        await expect(page.getByRole('heading', { name: 'Tasks' }).first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText('Trackable work items assigned to people or Agents.').first(),
        ).toBeVisible();
        // PageHeader action links to /tasks/new.
        await expect(page.locator('a[href*="/tasks/new"]').first()).toBeVisible();
    });

    test('view segmented control renders Cards/Table/Kanban with Cards active by default', async ({
        page,
    }) => {
        await gotoBoard(page);
        for (const label of ['Cards', 'Table', 'Kanban'] as const) {
            await expect(page.locator(`button[title="${label}"]`)).toBeVisible();
        }
        // `aria-pressed` reflects the active view; Cards is the initial state.
        await expect(page.locator('button[title="Cards"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('button[title="Kanban"]')).toHaveAttribute(
            'aria-pressed',
            'false',
        );
    });

    test('Kanban view renders all seven status columns', async ({ page }) => {
        await gotoBoard(page);
        await openKanban(page);
        await expect(page.locator('button[title="Kanban"]')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        for (const col of KANBAN_COLUMNS) {
            await expect(
                page.getByText(col, { exact: true }).first(),
                `column header "${col}" should render`,
            ).toBeVisible({ timeout: 15_000 });
        }
    });

    test('Table view renders the 5-column task table', async ({ page, request }) => {
        // Seed at least one task as the board user so the table (not the
        // empty-state) renders — TasksList shows an empty state at 0 rows, and
        // the board only ever shows THIS user's tasks.
        const token = await seededToken(request);
        await createTaskViaAPI(request, token, { title: uniq('Table Row') });
        await gotoBoard(page);
        const tableTab = page.locator('button[title="Table"]');
        await expect(async () => {
            if ((await tableTab.getAttribute('aria-pressed')) !== 'true') {
                await tableTab.click({ timeout: 10_000 }).catch(() => undefined);
            }
            await expect(page.getByRole('table')).toBeVisible({ timeout: 8_000 });
        }).toPass({ timeout: 60_000 });
        for (const header of TABLE_HEADERS) {
            await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
        }
    });

    test('status-filter pills show in cards view and disappear in kanban', async ({ page }) => {
        await gotoBoard(page);
        // Cards view (default) exposes the "All" + per-status pills.
        const allPill = page.getByRole('button', { name: 'All', exact: true });
        await expect(allPill).toBeVisible({ timeout: 15_000 });
        const backlogPill = page.getByRole('button', { name: 'Backlog', exact: true });
        await expect(backlogPill).toBeVisible();

        // Kanban hides the pills (columns already group by status).
        await openKanban(page);
        await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
    });

    test('cards view renders a "shown / total" count badge', async ({ page }) => {
        await gotoBoard(page);
        // Cards view badge is `${filtered.length} / ${tasks.length}` — e.g. "3 / 12".
        await expect(page.getByText(/^\d+\s*\/\s*\d+$/).first()).toBeVisible({ timeout: 15_000 });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// B. Board reflects API-created data (cross-layer: API write → UI read)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Tasks board — reflects API data (seeded UI)', () => {
    test('a backlog task created via API renders as a kanban card (slug + title)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Board card');
        const created = await createTaskViaAPI(request, token, { title });
        expect(created.status).toBe('backlog');

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });
        // The card shows the human title AND the auto slug T-<n>.
        await expect(card.getByText(created.slug, { exact: true })).toBeVisible();
    });

    test('kanban card surfaces the task priority badge and a label chip', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Board prio');
        const label = uniq('lbl');
        // Raw create so we can send `labels` (not part of the typed helper body).
        const createRes = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: { title, priority: 'p0', labels: [label] },
        });
        expect(createRes.status(), `create body=${await createRes.text().catch(() => '')}`).toBe(
            201,
        );
        const created = (await createRes.json()) as Task;
        expect(created.priority).toBe('p0');

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card.getByText('p0', { exact: true })).toBeVisible();
        await expect(card.getByText(label, { exact: true })).toBeVisible();
    });

    test('tasks in three distinct statuses each render as their own kanban card', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const backlogTitle = uniq('Multi backlog');
        const todoTitle = uniq('Multi todo');
        const progressTitle = uniq('Multi progress');

        await createTaskViaAPI(request, token, { title: backlogTitle });
        const todoTask = await createTaskViaAPI(request, token, { title: todoTitle });
        await transitionTaskViaAPI(request, token, todoTask.id, 'todo');
        const progressTask = await createTaskViaAPI(request, token, { title: progressTitle });
        await transitionTaskViaAPI(request, token, progressTask.id, 'todo');
        await transitionTaskViaAPI(request, token, progressTask.id, 'in_progress');

        await gotoBoard(page);
        await openKanban(page);
        for (const title of [backlogTitle, todoTitle, progressTitle]) {
            await expect(kanbanCard(page, title)).toBeVisible({ timeout: 30_000 });
        }
    });

    test('cards view shows the task with a status badge and the no-description placeholder', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Cards view');
        const created = await createTaskViaAPI(request, token, { title });

        await gotoBoard(page);
        // Default cards view. Scope to the card <a> linking to the detail page.
        const card = page
            .locator(`a[href*="/tasks/${created.id}"]`)
            .filter({ hasText: title })
            .first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card.getByText(created.slug, { exact: true })).toBeVisible();
        // status badge renders `status.replace('_',' ')` → "backlog".
        await expect(card.getByText('backlog', { exact: true })).toBeVisible();
        // no description was provided → placeholder copy.
        await expect(card.getByText('No description yet')).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C. Kanban "Move →" inline transition (the core new journey)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Tasks board — kanban Move → transition (seeded UI)', () => {
    test('a backlog card Move menu offers exactly its legal targets (todo, cancelled)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Move menu');
        await createTaskViaAPI(request, token, { title });

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });

        await expect(async () => {
            const todoItem = card.getByRole('button', { name: 'todo', exact: true });
            if (!(await todoItem.isVisible().catch(() => false))) {
                await card
                    .getByRole('button', { name: /move/i })
                    .click({ timeout: 3_000 })
                    .catch(() => undefined);
            }
            await expect(todoItem).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });

        // Legal targets present…
        await expect(card.getByRole('button', { name: 'todo', exact: true })).toBeVisible();
        await expect(card.getByRole('button', { name: 'cancelled', exact: true })).toBeVisible();
        // …illegal ones never offered from backlog.
        await expect(card.getByRole('button', { name: 'done', exact: true })).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'in review', exact: true })).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'in progress', exact: true })).toHaveCount(0);
    });

    test('moving a card backlog → todo via the kanban menu persists (API + reload agree)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Kanban move');
        const created = await createTaskViaAPI(request, token, { title });
        expect(created.status).toBe('backlog');

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });

        // Open the Move menu and click "todo"; retry until the API confirms
        // the server-action transition landed (absorbs the hydration race).
        await expect(async () => {
            const todoItem = card.getByRole('button', { name: 'todo', exact: true });
            if (!(await todoItem.isVisible().catch(() => false))) {
                await card
                    .getByRole('button', { name: /move/i })
                    .click({ timeout: 3_000 })
                    .catch(() => undefined);
            }
            await todoItem.click({ timeout: 3_000 }).catch(() => undefined);
            expect(await apiStatus(request, token, created.id)).toBe('todo');
        }).toPass({ timeout: 30_000 });

        // After a fresh reload the card re-renders in its `todo` move-state:
        // its menu now offers a todo-only target ("in progress") and can no
        // longer move to "todo" itself.
        await gotoBoard(page);
        await openKanban(page);
        const reloaded = kanbanCard(page, title);
        await expect(reloaded).toBeVisible({ timeout: 30_000 });
        await expect(async () => {
            const inProgress = reloaded.getByRole('button', { name: 'in progress', exact: true });
            if (!(await inProgress.isVisible().catch(() => false))) {
                await reloaded
                    .getByRole('button', { name: /move/i })
                    .click({ timeout: 3_000 })
                    .catch(() => undefined);
            }
            await expect(inProgress).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expect(reloaded.getByRole('button', { name: 'todo', exact: true })).toHaveCount(0);
    });

    test('moving a todo card → in progress via the kanban menu reflects on the API', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Kanban progress');
        const created = await createTaskViaAPI(request, token, { title });
        // Seed it into `todo` via the API so the UI hop under test is
        // todo → in_progress specifically.
        await transitionTaskViaAPI(request, token, created.id, 'todo');

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });

        await expect(async () => {
            const item = card.getByRole('button', { name: 'in progress', exact: true });
            if (!(await item.isVisible().catch(() => false))) {
                await card
                    .getByRole('button', { name: /move/i })
                    .click({ timeout: 3_000 })
                    .catch(() => undefined);
            }
            await item.click({ timeout: 3_000 }).catch(() => undefined);
            expect(await apiStatus(request, token, created.id)).toBe('in_progress');
        }).toPass({ timeout: 30_000 });
    });

    test('a cancelled card exposes no Move affordance (terminal state)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Cancelled card');
        const created = await createTaskViaAPI(request, token, { title });
        // backlog → cancelled is a legal hop.
        await transitionTaskViaAPI(request, token, created.id, 'cancelled');
        expect(await apiStatus(request, token, created.id)).toBe('cancelled');

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });
        // NEXT_STATUS.cancelled === [] → the "Move →" trigger is not rendered.
        await expect(card.getByRole('button', { name: /move/i })).toHaveCount(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// D. Cards / Table view interactions + client-side status filter
// ─────────────────────────────────────────────────────────────────────────
test.describe('Tasks board — cards/table filter (seeded UI)', () => {
    test('a status-filter pill client-filters the card grid, and "All" restores it', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const doneTitle = uniq('Filter done');
        const backlogTitle = uniq('Filter backlog');

        // A `done` task (walk the lattice) and a `backlog` task.
        const doneTask = await createTaskViaAPI(request, token, { title: doneTitle });
        await transitionTaskViaAPI(request, token, doneTask.id, 'todo');
        await transitionTaskViaAPI(request, token, doneTask.id, 'in_progress');
        await transitionTaskViaAPI(request, token, doneTask.id, 'done');
        // Create the backlog task LAST so it is the newest → top of the window.
        await createTaskViaAPI(request, token, { title: backlogTitle });

        await gotoBoard(page);
        // Cards view (default) → both cards visible under "All".
        await expect(page.getByText(backlogTitle).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(doneTitle).first()).toBeVisible({ timeout: 30_000 });

        // Filter to Backlog → the backlog card stays, the done card is removed.
        await page.getByRole('button', { name: 'Backlog', exact: true }).click();
        await expect(page.getByText(backlogTitle).first()).toBeVisible();
        await expect(page.getByText(doneTitle)).toHaveCount(0);

        // Back to All → both return.
        await page.getByRole('button', { name: 'All', exact: true }).click();
        await expect(page.getByText(backlogTitle).first()).toBeVisible();
        await expect(page.getByText(doneTitle).first()).toBeVisible();
    });

    test('table view lists the task with its slug and a title link to the detail page', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Table row');
        const created = await createTaskViaAPI(request, token, { title });

        await gotoBoard(page);
        const tableTab = page.locator('button[title="Table"]');
        await expect(async () => {
            if ((await tableTab.getAttribute('aria-pressed')) !== 'true') {
                await tableTab.click({ timeout: 10_000 }).catch(() => undefined);
            }
            await expect(page.getByRole('table')).toBeVisible({ timeout: 8_000 });
        }).toPass({ timeout: 60_000 });

        // The row carries the slug cell and a title link at /tasks/:id.
        await expect(page.getByRole('cell', { name: created.slug, exact: true })).toBeVisible({
            timeout: 15_000,
        });
        const titleLink = page.getByRole('link', { name: title, exact: true });
        await expect(titleLink).toBeVisible();
        await expect(titleLink).toHaveAttribute('href', new RegExp(`/tasks/${created.id}$`));
    });

    test('clicking a kanban card title navigates to the task detail page', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Kanban link');
        const created = await createTaskViaAPI(request, token, { title });

        await gotoBoard(page);
        await openKanban(page);
        const card = kanbanCard(page, title);
        await expect(card).toBeVisible({ timeout: 30_000 });

        await card.getByRole('link', { name: title, exact: true }).click();
        await page.waitForURL(new RegExp(`/tasks/${created.id}`), { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: title }).first()).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// E. New tasks appear + board data contract (API, isolated users)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Tasks board — new tasks + data contract', () => {
    test('newly created tasks appear on the board after reload (UI)', async ({ page, request }) => {
        const token = await seededToken(request);
        const first = uniq('New first');
        const second = uniq('New second');

        await createTaskViaAPI(request, token, { title: first });
        await gotoBoard(page);
        await openKanban(page);
        await expect(kanbanCard(page, first)).toBeVisible({ timeout: 30_000 });

        // A brand-new task shows up on the next board load.
        await createTaskViaAPI(request, token, { title: second });
        await gotoBoard(page);
        await openKanban(page);
        await expect(kanbanCard(page, second)).toBeVisible({ timeout: 30_000 });
        await expect(kanbanCard(page, first)).toBeVisible({ timeout: 30_000 });
    });

    test('GET /api/tasks returns {data, meta} ordered by updatedAt DESC with default limit 50', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        const a = await createTaskViaAPI(request, token, { title: 'Contract A' });
        const b = await createTaskViaAPI(request, token, { title: 'Contract B' });

        const listRes = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status()).toBe(200);
        const body = await listRes.json();
        expect(Array.isArray(body.data)).toBe(true);
        // Default page window is 50 and offset 0.
        expect(body.meta).toMatchObject({ limit: 50, offset: 0 });
        expect(body.meta.total).toBe(2);

        // Ordered by updatedAt DESC: the repository sorts by `task.updatedAt`
        // only, with NO secondary tie-breaker, and updatedAt is persisted at
        // 1-second granularity — so two tasks created in the same second tie and
        // their relative order is not stable. Assert the DESC *invariant*
        // (timestamps are non-increasing down the page), which tolerates ties,
        // instead of a brittle "B strictly before A" index check.
        type TaskRow = Task & { updatedAt: string };
        const rows = body.data as TaskRow[];
        const stamps = rows.map((t) => new Date(t.updatedAt).getTime());
        for (let i = 1; i < stamps.length; i++) {
            expect(stamps[i - 1]).toBeGreaterThanOrEqual(stamps[i]);
        }
        const titles = rows.map((t) => t.title);
        expect(titles).toContain('Contract A');
        expect(titles).toContain('Contract B');

        // Touching A (a transition bumps updatedAt) moves it to the front of the
        // updatedAt-DESC window: A's updatedAt is now >= B's, and the page stays
        // ordered. (>= rather than a strict index compare tolerates the case
        // where the transition lands in the same second B was created.)
        await transitionTaskViaAPI(request, token, a.id, 'todo');
        const afterRes = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
        });
        const after = (await afterRes.json()).data as TaskRow[];
        const afterStamps = after.map((t) => new Date(t.updatedAt).getTime());
        for (let i = 1; i < afterStamps.length; i++) {
            expect(afterStamps[i - 1]).toBeGreaterThanOrEqual(afterStamps[i]);
        }
        const aRow = after.find((t) => t.title === 'Contract A');
        const bRow = after.find((t) => t.title === 'Contract B');
        expect(aRow?.updatedAt, 'transitioned task A is present in the list').toBeTruthy();
        expect(bRow?.updatedAt, 'task B is present in the list').toBeTruthy();
        expect(new Date(aRow!.updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(bRow!.updatedAt).getTime(),
        );
        expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('board status filter narrows to a single column (?status=todo returns only todo)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        const inProgress = await createTaskViaAPI(request, token, { title: 'Column progress' });
        await transitionTaskViaAPI(request, token, inProgress.id, 'todo');
        const todo = await createTaskViaAPI(request, token, { title: 'Column todo' });
        await transitionTaskViaAPI(request, token, todo.id, 'todo');
        // Advance the first one out of todo so the filter is discriminating.
        await transitionTaskViaAPI(request, token, inProgress.id, 'in_progress');

        const todoRes = await request.get(`${API_BASE}/api/tasks?status=todo`, {
            headers: authedHeaders(token),
        });
        expect(todoRes.status()).toBe(200);
        const todoIds = ((await todoRes.json()).data as Task[]).map((t) => t.id);
        expect(todoIds).toContain(todo.id);
        expect(todoIds).not.toContain(inProgress.id);

        const progressRes = await request.get(`${API_BASE}/api/tasks?status=in_progress`, {
            headers: authedHeaders(token),
        });
        const progressIds = ((await progressRes.json()).data as Task[]).map((t) => t.id);
        expect(progressIds).toContain(inProgress.id);
        expect(progressIds).not.toContain(todo.id);
    });

    test("the board only surfaces the owner's tasks (cross-user isolation)", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceTask = await createTaskViaAPI(request, alice.access_token, {
            title: 'Alice board task',
        });

        // Bob's board (list) must not include Alice's task.
        const bobList = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobList.status()).toBe(200);
        const bobIds = ((await bobList.json()).data as Task[]).map((t) => t.id);
        expect(bobIds).not.toContain(aliceTask.id);

        // And a direct fetch of Alice's task by Bob is denied.
        const bobGet = await request.get(`${API_BASE}/api/tasks/${aliceTask.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(bobGet.status());
    });
});
