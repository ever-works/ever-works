import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * `/tasks` BOARD — the numbers a user reads off the board are true.
 *
 * Before the board read existed, the board was handed ONE 50-row page of the
 * list and each column header counted whatever that page happened to hold, so
 * a column with 140 Tasks could read "12". These journeys pin what replaced
 * it, end to end:
 *
 *   A. API contract (isolated users) — `GET /api/tasks/board` returns each
 *      column's true total with at most 50 cards, orders a column p0 first
 *      even when the p0 is the oldest Task, pages ONE column through
 *      `GET /api/tasks/board/column`, refuses an unknown column, and never
 *      shows one user another user's Tasks.
 *      Both card orders are reachable (`sort=priority`, the default, and
 *      `sort=updated`), and `terminalWindowDays=all` lifts the 90-day clamp.
 *   B. UI (seeded user) — `?view=board` is an address: it opens the board,
 *      the header count is the filtered total, the p0 card leads its column,
 *      and the chosen view is remembered across a visit without the query.
 *      The card order (`?sort=`) and the completed-Task window (`?done=`)
 *      are addresses too, chosen from the board's own controls.
 *
 * The seeded user is shared with every other spec, so the UI journeys narrow
 * the board to their own fixtures with a unique `label` — the same filter a
 * user applies — and never assert on unfiltered totals.
 */

type BoardColumn = {
    key: string;
    statuses: string[];
    total: number;
    cards: Array<{
        id: string;
        title: string;
        priority: string;
        status: string;
        updatedAt: string;
    }>;
    offset: number;
    limit: number;
    failed: boolean;
};

type BoardResult = {
    layout: string;
    columns: BoardColumn[];
    columnLimit: number;
    terminalWindowDays: number | 'all';
    sort: 'priority' | 'updated';
};

function uniq(tag: string): string {
    return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createTask(
    request: APIRequestContext,
    token: string,
    data: { title: string; status?: string; priority?: string; labels?: string[] },
): Promise<{ id: string; title: string }> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function getBoard(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<BoardResult> {
    const res = await request.get(`${API_BASE}/api/tasks/board${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `board body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

const columnOf = (board: BoardResult, key: string) => {
    const column = board.columns.find((entry) => entry.key === key);
    expect(column, `column ${key} present`).toBeTruthy();
    return column!;
};

// ─────────────────────────────────────────────────────────────────────────
// A. API contract
// ─────────────────────────────────────────────────────────────────────────
test.describe('Task board read — true totals (API)', () => {
    test('a column reports its true total while holding at most 50 cards, and pages on its own', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // 55 in To do, 2 in Blocked. Sequential on purpose: the create route
        // is rate-limited per user and 57 is comfortably under it.
        for (let i = 0; i < 55; i += 1) {
            await createTask(request, token, { title: `Todo ${i}`, status: 'todo' });
        }
        await createTask(request, token, { title: 'Blocked A', status: 'blocked' });
        await createTask(request, token, { title: 'Blocked B', status: 'blocked' });

        const board = await getBoard(request, token);
        expect(board.layout).toBe('status');
        expect(board.columns.map((column) => column.key)).toEqual([
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'blocked',
            'done',
            'cancelled',
        ]);
        const todo = columnOf(board, 'todo');
        expect(todo.total).toBe(55);
        expect(todo.cards).toHaveLength(50);
        expect(columnOf(board, 'blocked').total).toBe(2);
        expect(columnOf(board, 'backlog').total).toBe(0);

        // "Show more" on To do: the next page of THAT column only.
        const pageRes = await request.get(
            `${API_BASE}/api/tasks/board/column?column=todo&offset=50`,
            { headers: authedHeaders(token) },
        );
        expect(pageRes.status()).toBe(200);
        const page = (await pageRes.json()) as BoardColumn;
        expect(page.key).toBe('todo');
        expect(page.total).toBe(55);
        expect(page.cards).toHaveLength(5);
        const firstIds = new Set(todo.cards.map((card) => card.id));
        expect(page.cards.some((card) => firstIds.has(card.id))).toBe(false);
        expect(page.cards.every((card) => card.status === 'todo')).toBe(true);
    });

    test('a p0 Task leads its column even when it is the oldest one there', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const urgent = await createTask(request, token, {
            title: 'Old but urgent',
            status: 'todo',
            priority: 'p0',
        });
        await createTask(request, token, { title: 'Newer normal', status: 'todo', priority: 'p3' });
        await createTask(request, token, { title: 'Newest high', status: 'todo', priority: 'p1' });

        const todo = columnOf(await getBoard(request, token), 'todo');
        expect(todo.cards.map((card) => card.priority)).toEqual(['p0', 'p1', 'p3']);
        expect(todo.cards[0].id).toBe(urgent.id);
    });

    test('sort=updated orders a column most recently updated first; the default stays priority', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const urgent = await createTask(request, token, {
            title: 'Old but urgent',
            status: 'todo',
            priority: 'p0',
        });
        // A clear gap, so the two updates can never share a timestamp.
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const fresh = await createTask(request, token, {
            title: 'Fresh normal',
            status: 'todo',
            priority: 'p3',
        });

        const byPriority = await getBoard(request, token);
        expect(byPriority.sort).toBe('priority');
        expect(columnOf(byPriority, 'todo').cards.map((card) => card.id)).toEqual([
            urgent.id,
            fresh.id,
        ]);

        const byUpdated = await getBoard(request, token, '?sort=updated');
        expect(byUpdated.sort).toBe('updated');
        const todo = columnOf(byUpdated, 'todo');
        expect(todo.cards.map((card) => card.id)).toEqual([fresh.id, urgent.id]);
        expect(todo.total).toBe(2);

        // "Show more" pages in the same order the board read used.
        const pageRes = await request.get(
            `${API_BASE}/api/tasks/board/column?column=todo&offset=1&sort=updated`,
            { headers: authedHeaders(token) },
        );
        expect(pageRes.status()).toBe(200);
        const page = (await pageRes.json()) as BoardColumn;
        expect(page.cards.map((card) => card.id)).toEqual([urgent.id]);
    });

    test('terminalWindowDays=all is the one way past the 90-day clamp, and still pages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createTask(request, token, { title: 'Finished', status: 'done' });

        const week = await getBoard(request, token);
        expect(week.terminalWindowDays).toBe(7);

        const capped = await getBoard(request, token, '?terminalWindowDays=365');
        expect(capped.terminalWindowDays).toBe(90);

        const allTime = await getBoard(request, token, '?terminalWindowDays=all');
        expect(allTime.terminalWindowDays).toBe('all');
        const done = columnOf(allTime, 'done');
        // Every completed Task the 7-day board counts, all time counts too.
        expect(done.total).toBeGreaterThanOrEqual(columnOf(week, 'done').total);
        expect(done.total).toBe(1);
        expect(done.cards.map((card) => card.title)).toEqual(['Finished']);

        const pageRes = await request.get(
            `${API_BASE}/api/tasks/board/column?column=done&terminalWindowDays=all`,
            { headers: authedHeaders(token) },
        );
        expect(pageRes.status()).toBe(200);
        expect(await pageRes.json()).toMatchObject({ key: 'done', total: 1 });
    });

    test('filters narrow every column and every count', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const label = uniq('lbl').toLowerCase();

        await createTask(request, token, { title: 'Tagged todo', status: 'todo', labels: [label] });
        await createTask(request, token, { title: 'Untagged todo', status: 'todo' });
        await createTask(request, token, {
            title: 'Tagged blocked',
            status: 'blocked',
            labels: [label],
        });

        const board = await getBoard(request, token, `?label=${encodeURIComponent(label)}`);
        expect(columnOf(board, 'todo').total).toBe(1);
        expect(columnOf(board, 'blocked').total).toBe(1);
        expect(columnOf(board, 'todo').cards.map((card) => card.title)).toEqual(['Tagged todo']);
    });

    test('an unknown column key is a 400, not a 500', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/tasks/board/column?column=needs_you`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
    });

    test("one user's Tasks are in no column and no count of another user's board", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        await createTask(request, alice.access_token, { title: 'Alice only', status: 'todo' });

        const bobBoard = await getBoard(request, bob.access_token);
        expect(bobBoard.columns.every((column) => column.total === 0)).toBe(true);
        expect(bobBoard.columns.flatMap((column) => column.cards)).toEqual([]);

        const bobColumn = await request.get(`${API_BASE}/api/tasks/board/column?column=todo`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobColumn.status()).toBe(200);
        expect(await bobColumn.json()).toMatchObject({ key: 'todo', total: 0, cards: [] });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// B. UI — the board is an address, and its numbers match the read
// ─────────────────────────────────────────────────────────────────────────
async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    expect(access_token, 'seeded login returns a bearer token').toBeTruthy();
    return access_token;
}

const boardColumn = (page: Page, status: string) =>
    page.locator(`[data-testid="task-board-column"][data-status="${status}"]`);

test.describe('Task board — true totals and the view address (seeded UI)', () => {
    test('?view=board opens the board with the filtered true total and the p0 card first', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const label = uniq('board-count').toLowerCase();
        await createTask(request, token, {
            title: `${label} normal`,
            status: 'todo',
            priority: 'p3',
            labels: [label],
        });
        await createTask(request, token, {
            title: `${label} urgent`,
            status: 'todo',
            priority: 'p0',
            labels: [label],
        });
        await createTask(request, token, {
            title: `${label} medium`,
            status: 'todo',
            priority: 'p2',
            labels: [label],
        });
        await createTask(request, token, {
            title: `${label} review`,
            status: 'blocked',
            labels: [label],
        });

        await page.goto(`/en/tasks?view=board&label=${encodeURIComponent(label)}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.locator('button[title="Kanban"]')).toHaveAttribute(
            'aria-pressed',
            'true',
            {
                timeout: 30_000,
            },
        );

        const todo = boardColumn(page, 'todo');
        await expect(todo).toBeVisible({ timeout: 30_000 });
        await expect(todo.getByTestId('task-board-column-count')).toHaveText('3');
        await expect(
            boardColumn(page, 'blocked').getByTestId('task-board-column-count'),
        ).toHaveText('1');
        await expect(
            boardColumn(page, 'backlog').getByTestId('task-board-column-count'),
        ).toHaveText('0');
        // The column's accessible name carries its translated label and its total.
        await expect(todo).toHaveAttribute('aria-label', 'To do, 3 Tasks');

        // Priority orders the column: the p0 leads even though it is not the newest.
        await expect(todo.getByTestId('task-kanban-card').first()).toContainText(`${label} urgent`);
    });

    test('?sort= and ?done= are addresses: the board controls write them and a link reproduces them', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const label = uniq('board-options').toLowerCase();
        await createTask(request, token, {
            title: `${label} old urgent`,
            status: 'todo',
            priority: 'p0',
            labels: [label],
        });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await createTask(request, token, {
            title: `${label} fresh normal`,
            status: 'todo',
            priority: 'p3',
            labels: [label],
        });

        // A linked board opens in the order the link names.
        await page.goto(`/en/tasks?view=board&sort=updated&label=${encodeURIComponent(label)}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page).not.toHaveURL(/\/login/);
        const sortGroup = page.getByTestId('task-board-sort');
        await expect(sortGroup.getByRole('button', { name: 'Recently updated' })).toHaveAttribute(
            'aria-pressed',
            'true',
            { timeout: 30_000 },
        );
        const todo = boardColumn(page, 'todo');
        await expect(todo.getByTestId('task-board-column-count')).toHaveText('2', {
            timeout: 30_000,
        });
        await expect(todo.getByTestId('task-kanban-card').first()).toContainText(
            `${label} fresh normal`,
        );

        // Choosing Priority writes it to the URL and re-orders the column.
        await expect(async () => {
            const priority = sortGroup.getByRole('button', { name: 'Priority' });
            if ((await priority.getAttribute('aria-pressed')) !== 'true') {
                await priority.click({ timeout: 5_000 }).catch(() => undefined);
            }
            await expect(page).toHaveURL(/[?&]sort=priority/, { timeout: 4_000 });
        }).toPass({ timeout: 30_000 });
        await expect(todo.getByTestId('task-kanban-card').first()).toContainText(
            `${label} old urgent`,
            { timeout: 30_000 },
        );

        // Choosing All time writes ?done=all and the Done header says so.
        const doneGroup = page.getByTestId('task-board-done-window');
        await expect(doneGroup.getByRole('button', { name: '7 days' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(async () => {
            const allTime = doneGroup.getByRole('button', { name: 'All time' });
            if ((await allTime.getAttribute('aria-pressed')) !== 'true') {
                await allTime.click({ timeout: 5_000 }).catch(() => undefined);
            }
            await expect(page).toHaveURL(/[?&]done=all/, { timeout: 4_000 });
        }).toPass({ timeout: 30_000 });
        await expect(boardColumn(page, 'done').getByTestId('task-board-column-window')).toHaveText(
            'All time',
            { timeout: 30_000 },
        );
        // The earlier choice and the filter survive the second one.
        await expect(page).toHaveURL(/[?&]sort=priority/);
        await expect(page).toHaveURL(new RegExp(`[?&]label=${label}`));
    });

    test('choosing the board is remembered for the next visit without ?view=', async ({ page }) => {
        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        const tab = page.locator('button[title="Kanban"]');
        await expect(tab).toBeVisible({ timeout: 30_000 });

        await expect(async () => {
            if ((await tab.getAttribute('aria-pressed')) !== 'true') {
                await tab.click({ timeout: 5_000 }).catch(() => undefined);
            }
            await expect(page).toHaveURL(/[?&]view=board/, { timeout: 4_000 });
            await expect(boardColumn(page, 'in_review')).toBeVisible({ timeout: 4_000 });
        }).toPass({ timeout: 45_000 });

        // A fresh visit with no query lands on the board again.
        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('button[title="Kanban"]')).toHaveAttribute(
            'aria-pressed',
            'true',
            {
                timeout: 30_000,
            },
        );
        await expect(boardColumn(page, 'todo')).toBeVisible({ timeout: 30_000 });

        // …and the URL still wins over the remembered choice.
        await page.goto('/en/tasks?view=table', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('button[title="Table"]')).toHaveAttribute(
            'aria-pressed',
            'true',
            {
                timeout: 30_000,
            },
        );
        await expect(boardColumn(page, 'todo')).toHaveCount(0);
    });
});
