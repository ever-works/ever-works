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
 *   B. UI (seeded user) — `?view=board` is an address: it opens the board,
 *      the header count is the filtered total, the p0 card leads its column,
 *      and the chosen view is remembered across a visit without the query.
 *
 * The seeded user is shared with every other spec, so the UI journeys narrow
 * the board to their own fixtures with a unique `label` — the same filter a
 * user applies — and never assert on unfiltered totals.
 */

type BoardColumn = {
    key: string;
    statuses: string[];
    total: number;
    cards: Array<{ id: string; title: string; priority: string; status: string }>;
    offset: number;
    limit: number;
    failed: boolean;
};

type BoardResult = {
    layout: string;
    columns: BoardColumn[];
    columnLimit: number;
    terminalWindowDays: number;
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
        });
        await createTask(request, token, {
            title: `${label} urgent`,
            status: 'todo',
            priority: 'p0',
        });
        await createTask(request, token, {
            title: `${label} medium`,
            status: 'todo',
            priority: 'p2',
        });
        await createTask(request, token, { title: `${label} review`, status: 'blocked' });

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
