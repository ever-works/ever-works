import { test, expect, type Page } from '@playwright/test';

/**
 * `/settings/billing` + `/settings/usage` — the Wave 13 money surfaces.
 *
 * Both pages are SERVER components that fan out to
 * `/api/credits/{balance,ledger,usage-summary}` and
 * `/api/subscriptions/{plan,plans}` with a `.catch(() => null)` per
 * call, so every fetch degrades independently. That design means a
 * broken API call does NOT throw — it silently renders an empty
 * section. Exactly the class of regression that ships unnoticed, and
 * exactly what this journey pins.
 *
 * Runs as the seeded storageState user; no fixtures are needed because
 * both pages render for an account with zero spend (that is the state
 * the assertions target — a fresh account must see real empty states,
 * never the load-error banner).
 *
 * Note on flag-gated sections: purchase / payment-method / auto-recharge
 * ship behind the server-side `PAYMENTS_ENABLED` flag (default OFF), so
 * the spec accepts either arm — the top-up controls OR the
 * "coming soon" card — and only insists that exactly one is present.
 */

async function gotoSettings(page: Page, path: string, anchorTestId: string): Promise<void> {
    await page.goto(`/en/settings/${path}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId(anchorTestId)).toBeVisible({ timeout: 30_000 });
}

test.describe('/settings/billing', () => {
    test('renders the shell, the current plan and the credits balance — not the load-error banner', async ({
        page,
    }) => {
        await gotoSettings(page, 'billing', 'billing-settings');

        // The load-error banner only appears when EVERY upstream call
        // failed; seeing it here means the credits/subscriptions proxies
        // are broken, which is the silent-failure mode we care about.
        await expect(page.getByTestId('billing-load-error')).toHaveCount(0);

        await expect(page.getByTestId('billing-current-plan')).toBeVisible();
        const balance = page.getByTestId('billing-balance');
        await expect(balance).toBeVisible();
        // Either a formatted amount or the explicit em-dash placeholder —
        // never an empty node.
        await expect(balance).not.toBeEmpty();
    });

    test('the credits ledger renders a table or its empty state, never nothing', async ({
        page,
    }) => {
        await gotoSettings(page, 'billing', 'billing-settings');

        const table = page.getByTestId('billing-ledger-table');
        const empty = page.getByTestId('billing-ledger-empty');
        const error = page.getByTestId('billing-ledger-error');

        // A fresh account has no movements, so the empty state is the
        // expected arm — but a seeded account with a daily-free grant
        // legitimately shows the table. Both are correct; an ERROR is not.
        await expect(error).toHaveCount(0);
        await expect(table.or(empty).first()).toBeVisible();

        if (await table.isVisible().catch(() => false)) {
            await expect(page.getByTestId('billing-ledger-row').first()).toBeVisible();
        }
    });

    test('the purchase surface is present in exactly one of its two flag arms', async ({
        page,
    }) => {
        await gotoSettings(page, 'billing', 'billing-settings');

        const comingSoon = page.getByTestId('billing-payments-coming-soon');
        const topupPreset = page.locator('[data-testid^="billing-topup-"]').first();

        await expect(comingSoon.or(topupPreset).first()).toBeVisible();

        // The two arms are mutually exclusive: showing both would mean the
        // PAYMENTS_ENABLED branch leaked.
        const comingSoonCount = await comingSoon.count();
        const topupCount = await topupPreset.count();
        expect(comingSoonCount === 0 || topupCount === 0).toBe(true);
    });
});

test.describe('/settings/usage', () => {
    test('renders the summary tiles with real numbers, not the load-error banner', async ({
        page,
    }) => {
        await gotoSettings(page, 'usage', 'usage-credits-settings');

        await expect(page.getByTestId('usage-load-error')).toHaveCount(0);
        await expect(page.getByTestId('usage-summary-tiles')).toBeVisible();

        // All seven §4.1/§4.2 tiles, each with a rendered value.
        for (const tile of [
            'usage-tile-balance',
            'usage-tile-consumed',
            'usage-tile-added',
            'usage-tile-spend',
            'usage-tile-tasks',
            'usage-tile-works',
            'usage-tile-runs',
        ]) {
            const node = page.getByTestId(tile);
            await expect(node, `${tile} renders`).toBeVisible();
            await expect(node, `${tile} has a value`).not.toBeEmpty();
        }
    });

    test('the three breakdown charts mount (with their empty labels when there is no spend)', async ({
        page,
    }) => {
        await gotoSettings(page, 'usage', 'usage-credits-settings');

        // `UsageBreakdownChart` swaps its own testid for `<testId>-empty`
        // when it has no rows, so a zero-spend account is the `-empty`
        // arm. Either is a MOUNT; neither being present is the regression.
        for (const chart of [
            'usage-by-model-chart',
            'usage-by-agent-chart',
            'usage-by-work-chart',
        ]) {
            const mounted = page.getByTestId(chart);
            const empty = page.getByTestId(`${chart}-empty`);
            await expect(mounted.or(empty).first(), `${chart} mounts`).toBeVisible();
        }
    });

    test('the 7d / 30d toggle refetches the by-day chart without erroring', async ({ page }) => {
        await gotoSettings(page, 'usage', 'usage-credits-settings');

        const sevenDay = page.getByTestId('usage-range-7d');
        const thirtyDay = page.getByTestId('usage-range-30d');
        await expect(sevenDay).toBeVisible();
        await expect(thirtyDay).toBeVisible();

        await sevenDay.click();
        // The client refetches through the `/api/credits/usage-summary`
        // proxy; the loading state is transient, the ERROR state is not.
        await expect(page.getByTestId('usage-by-day-loading')).toHaveCount(0, { timeout: 20_000 });
        await expect(page.getByTestId('usage-by-day-error')).toHaveCount(0);

        await thirtyDay.click();
        await expect(page.getByTestId('usage-by-day-loading')).toHaveCount(0, { timeout: 20_000 });
        await expect(page.getByTestId('usage-by-day-error')).toHaveCount(0);
    });

    test('B20 — the month picker offers calendar months and selecting one refetches', async ({
        page,
    }) => {
        await gotoSettings(page, 'usage', 'usage-credits-settings');

        const monthPicker = page.getByTestId('usage-period-month');
        await expect(monthPicker).toBeVisible();

        // The picker must actually be populated with `YYYY-MM` values —
        // the whole point of B20 is that the month option is reachable.
        const values = await monthPicker
            .locator('option')
            .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
            );
        expect(values.length).toBeGreaterThan(1);
        for (const value of values) {
            expect(value).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
        }

        // Picking a past month refetches every panel through the proxy;
        // the loading state is transient, the ERROR state is not.
        await monthPicker.selectOption(values[1]);
        await expect(page.getByTestId('usage-by-day-loading')).toHaveCount(0, { timeout: 20_000 });
        await expect(page.getByTestId('usage-by-day-error')).toHaveCount(0);
        await expect(page.getByTestId('usage-load-error')).toHaveCount(0);
    });

    test('B21/B29 — the CSV export control points at the account-wide export endpoint', async ({
        page,
    }) => {
        await gotoSettings(page, 'usage', 'usage-credits-settings');

        const exportLink = page.getByTestId('usage-export-csv');
        await expect(exportLink).toBeVisible();
        // The export is an `<a href download>`, which cannot send a header, so
        // the workspace selector rides on the URL as `?scope=` and the BFF
        // route turns it into `X-Scope-Slug`. Asserted rather than tolerated:
        // if the carrier ever disappears the export silently goes back to
        // ignoring the Organization the user is standing in, which is the
        // defect it was added to fix.
        await expect(exportLink).toHaveAttribute(
            'href',
            /^\/api\/credits\/usage\/export\?period=(\d{4}-(0[1-9]|1[0-2])|7d|30d)&scope=(personal|org%3A[a-z0-9-]+)$/,
        );

        // The proxy must answer with a CSV attachment, not an HTML error
        // page — a broken export is otherwise invisible from the UI.
        const href = await exportLink.getAttribute('href');
        const response = await page.request.get(href as string);
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('text/csv');
        expect(response.headers()['content-disposition']).toContain('attachment');
        // Header row is the pinned column contract.
        expect(await response.text()).toContain('occurredAt,pluginId,capability');
    });
});
