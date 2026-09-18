import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';
import { clickAndExpectUrl } from './helpers/nav';

/**
 * Runs ledger (AW-09) — the Activity page's Runs view + `GET /api/runs*`
 * contract.
 *
 * The ledger used to be its own page at `/runs`; it is now the `?view=runs` view
 * of `/activity`, so the four `goto`s below still work (the retired route
 * redirects, carrying the whole view state) but they land on the Activity page.
 *
 * UI: the view opens on Day / today with the timezone stated, the calendar
 * controls and keyboard shortcuts move the window and mirror it into the URL,
 * the rail names its scope, and a reload restores the view. Written to hold
 * whether or not the shared e2e user has runs: it asserts on the ledger's
 * structure (table or one of the empty answers), not on content.
 *
 * API: owner-scoped reads, the DTO bounds, and the 404 for a run id the
 * caller cannot see (the missing-vs-foreign equivalence is pinned in the
 * controller spec, where a second account's run can be constructed).
 */

test.describe('Runs ledger — UI', () => {
    test('lands on Day / today with the timezone and the rail scope stated', async ({ page }) => {
        await page.goto('/en/runs', { waitUntil: 'domcontentloaded' });

        // The page is Activity; the ledger is one of its views.
        await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
        await expect(page.getByTestId('activity-view-runs')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-timezone')).toContainText('Times shown in');
        // `exact: true`: Playwright's accessible-name match is a case-insensitive
        // SUBSTRING by default, so a bare 'Day' also matches the "Today" button
        // three elements away in the same calendar bar (strict-mode violation).
        await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute(
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
        // `exact: true`: Playwright's accessible-name match is a case-insensitive
        // SUBSTRING by default, so a bare 'Day' also matches the "Today" button
        // three elements away in the same calendar bar (strict-mode violation).
        await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    test('a filtered view survives a reload', async ({ page }) => {
        await page.goto('/en/runs?g=month&status=failed', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-filter-count')).toContainText('1 active');

        await page.reload({ waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('runs-filter-count')).toContainText('1 active');
        // Scoped to the filter bar's own control: when the window has no
        // matching runs the empty state renders a SECOND "Clear filters" CTA
        // (RunsEmptyState.tsx), and an unscoped role+name matched both. The
        // role+name assertion is kept — it still proves a button named
        // "Clear filters" lives in the filters bar.
        await page
            .getByTestId('runs-filters')
            .getByRole('button', { name: 'Clear filters' })
            .click();
        await expect(page).not.toHaveURL(/status=failed/);
    });

    test('the Agents Activity tab links to the workspace-wide Runs view', async ({ page }) => {
        // The hub's old "Sessions" tab is the Agents tab's Activity sub-tab now;
        // its detail route moved under /agents/activity, both old paths redirect.
        await page.goto('/en/agents/sessions', { waitUntil: 'domcontentloaded' });
        // A click that lands before React wires the `<Link>` is silently
        // dropped: the trace shows "click action done" and "navigations have
        // finished" 20ms later with no request at all, while the shell was still
        // firing its hydration server actions. The helper re-clicks ONLY while
        // the URL has not changed, so the claim is unchanged — it ends on the
        // same `toHaveURL`.
        await clickAndExpectUrl(
            page,
            page.getByTestId('agent-sessions-open-in-runs'),
            /\/activity\?view=runs/,
        );
        await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
        await expect(page.getByTestId('runs-rail')).toBeVisible();
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
