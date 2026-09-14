import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Runs ledger (AW-09) — `/runs` UI + `GET /api/runs*` contract.
 *
 * UI: the page lands on Day / today with the timezone stated, the calendar
 * controls and keyboard shortcuts move the window and mirror it into the
 * URL, the rail names its scope, and a reload restores the view. Written to
 * hold whether or not the shared e2e user has runs: it asserts on the
 * ledger's structure (table or one of the empty answers), not on content.
 *
 * API: owner-scoped reads, the DTO bounds, and the 404 for a run id the
 * caller cannot see (the missing-vs-foreign equivalence is pinned in the
 * controller spec, where a second account's run can be constructed).
 */

test.describe('Runs ledger — UI', () => {
    test('lands on Day / today with the timezone and the rail scope stated', async ({ page }) => {
        await page.goto('/en/runs', { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
        await expect(page.getByTestId('runs-timezone')).toContainText('Times shown in');
        await expect(page.getByRole('button', { name: 'Day' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-rail')).toContainText('THIS DAY');

        // Either the window's runs or one of the honest empty answers.
        const table = page.getByTestId('runs-table');
        const empty = page.getByTestId('runs-empty');
        await expect(table.or(empty)).toBeVisible();
    });

    test('keyboard shortcuts move the window and the URL follows', async ({ page }) => {
        await page.goto('/en/runs?g=day', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('runs-window-label')).toBeVisible();
        await page.locator('body').click({ position: { x: 5, y: 5 } });

        await page.keyboard.press('w');
        await expect(page).toHaveURL(/[?&]g=week/);
        await expect(page.getByTestId('runs-rail')).toContainText('THIS WEEK');

        const weekLabel = await page.getByTestId('runs-window-label').innerText();
        await page.keyboard.press('ArrowLeft');
        await expect(page).toHaveURL(/[?&]d=\d{4}-\d{2}-\d{2}/);
        await expect(page.getByTestId('runs-window-label')).not.toHaveText(weekLabel);

        await page.keyboard.press('t');
        await expect(page).not.toHaveURL(/[?&]d=/);
    });

    test('typing in the search box never triggers a shortcut', async ({ page }) => {
        await page.goto('/en/runs?g=day', { waitUntil: 'domcontentloaded' });
        const search = page.getByRole('searchbox', { name: 'Search summaries and errors' });
        await search.click();
        await search.pressSequentially('dw');

        await expect(search).toHaveValue('dw');
        await expect(page.getByRole('button', { name: 'Day' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    test('a filtered view survives a reload', async ({ page }) => {
        await page.goto('/en/runs?g=month&status=failed', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Month' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-filter-count')).toContainText('1 active');

        await page.reload({ waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('button', { name: 'Month' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-filter-count')).toContainText('1 active');
        await page.getByRole('button', { name: 'Clear filters' }).click();
        await expect(page).not.toHaveURL(/status=failed/);
    });

    test('the Sessions tab links to Runs', async ({ page }) => {
        await page.goto('/en/agents/sessions', { waitUntil: 'domcontentloaded' });
        await page.getByTestId('agent-sessions-open-in-runs').click();
        await expect(page).toHaveURL(/\/runs/);
        await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
    });
});

test.describe('Runs ledger — API contract', () => {
    test('GET /api/runs without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/runs`);
        expect(res.status()).toBe(401);
    });

    test('a new account reads an empty, resolved window and knows it never ran', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/runs?granularity=week&timezone=Asia/Tokyo`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.window).toMatchObject({ granularity: 'week', timezone: 'Asia/Tokyo' });
        expect(body.rows).toEqual([]);
        expect(body.total).toBe(0);
        expect(body.limit).toBe(50);
        expect(body.everRan).toBe(false);

        const stats = await request.get(`${API_BASE}/api/runs/stats?granularity=week`, {
            headers: authedHeaders(user.access_token),
        });
        expect(stats.status()).toBe(200);
        const totals = await stats.json();
        expect(totals.total).toBe(0);
        expect(totals.successRate).toBeNull();
        expect(totals.costCents).toBeNull();
    });

    test('rejects a page size over 200, a one-character search and an unknown timezone', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        for (const query of ['limit=500', 'q=a', 'timezone=Mars/Olympus', 'userId=someone']) {
            const res = await request.get(`${API_BASE}/api/runs?${query}`, { headers });
            expect(res.status(), query).toBe(400);
        }
    });

    test('an unknown run id returns 404, and a literal segment never reaches the id route', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const missing = await request.get(
            `${API_BASE}/api/runs/9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f/receipt`,
            { headers },
        );
        expect(missing.status()).toBe(404);

        // A literal segment is never read as a run id.
        const calendar = await request.get(`${API_BASE}/api/runs/calendar?month=2026-09`, {
            headers,
        });
        expect(calendar.status()).toBe(200);
    });
});
