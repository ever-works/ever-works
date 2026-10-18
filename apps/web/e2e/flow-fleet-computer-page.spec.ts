import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import {
    FLEET_HUB_CLICK_TIMEOUT as CLICK_TIMEOUT,
    FLEET_HUB_ON,
    enrollFleetNode,
    freshFleetUser,
    serverActionAnswered,
    signedInFleetUser,
} from './helpers/fleet-hub';

/**
 * Fleet hub (FL-01, T-26, ACC-FL01-12, -13) — the computer page's ⋯ menu,
 * walked against a REAL enrolled node: rename inline (no dialog), favourite
 * (survives a reload), pause with a toast, drain behind one confirmation
 * naming the jobs it releases, then return, and remove behind the typed name
 * — each read back from the API, and each lifecycle act leaving its audit row.
 *
 * Skips unless the web server under test runs with `FLEET_HUB_ENABLED=true`.
 */

test.describe('Fleet hub — the computer page ⋯ menu', () => {
    test.skip(!FLEET_HUB_ON, 'FLEET_HUB_ENABLED is not on for this run');

    test('rename, favourite, pause, drain and return apply from the menu (FR-22, FR-23)', async ({
        browser,
        request,
    }) => {
        const u = await freshFleetUser(request);
        const node = await enrollFleetNode(request, u.access_token);
        const headers = authedHeaders(u.access_token);
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            const menu = page.getByTestId('fleet-computer-menu-trigger');

            // Rename — inline, no dialog.
            const renamed = `${node.name} renamed`;
            await menu.click({ timeout: CLICK_TIMEOUT });
            await page.getByTestId('fleet-computer-menu-rename').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByRole('dialog')).toHaveCount(0);
            const input = page.getByTestId('fleet-computer-rename-input');
            await input.fill(renamed);
            const renameSaved = serverActionAnswered(page);
            await input.press('Enter');
            await renameSaved;
            await expect(page.getByTestId('fleet-computer-name')).toHaveText(renamed);

            // Favourite — no dialog, survives a reload.
            await menu.click({ timeout: CLICK_TIMEOUT });
            const starSaved = serverActionAnswered(page);
            await page
                .getByTestId('fleet-computer-menu-favourite')
                .click({ timeout: CLICK_TIMEOUT });
            await starSaved;
            await page.reload({ waitUntil: 'networkidle' });
            await menu.click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-menu-favourite')).toHaveText(
                /Remove from favourites/,
            );
            await page.keyboard.press('Escape');

            // Pause — a toast, no dialog.
            await menu.click({ timeout: CLICK_TIMEOUT });
            await page.getByTestId('fleet-computer-menu-pause').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByText(/Paused .*New work stops/)).toBeVisible();
            await expect(page.getByTestId('fleet-computer-state')).toHaveText('Paused');

            // Resume, then drain behind one confirmation that counts the jobs.
            await menu.click({ timeout: CLICK_TIMEOUT });
            await page.getByTestId('fleet-computer-menu-pause').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByText(new RegExp(`Resumed`))).toBeVisible();
            await menu.click({ timeout: CLICK_TIMEOUT });
            await page.getByTestId('fleet-computer-menu-drain').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-drain-body')).toContainText(
                'No jobs are in flight.',
            );
            await page
                .getByTestId('fleet-computer-drain-confirm')
                .click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-state')).toHaveText('Disabled');

            // Return to fleet — plain.
            await menu.click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-menu-drain')).toHaveText(
                /Return to fleet/,
            );
            await page.getByTestId('fleet-computer-menu-drain').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-state')).not.toHaveText('Disabled');

            // Every lifecycle act left its row (ACC-FL01-12).
            const audit = await request.get(`${API_BASE}/api/fleet/nodes/${node.nodeId}/audit`, {
                headers,
            });
            expect(audit.status()).toBe(200);
            const actions = ((await audit.json()) as { action: string }[]).map((row) => row.action);
            for (const action of ['node.rename', 'node.pause', 'node.drain']) {
                expect(actions, `audit has ${action}`).toContain(action);
            }
        } finally {
            await close();
        }
    });

    test('remove needs the typed name, then the page is gone (FR-23, U10)', async ({
        browser,
        request,
    }) => {
        const u = await freshFleetUser(request);
        const node = await enrollFleetNode(request, u.access_token);
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            await page.getByTestId('fleet-computer-menu-trigger').click({ timeout: CLICK_TIMEOUT });
            await page.getByTestId('fleet-computer-menu-remove').click({ timeout: CLICK_TIMEOUT });
            const confirm = page.getByTestId('fleet-computer-remove-confirm');
            await expect(confirm).toBeDisabled();
            await page.getByTestId('fleet-computer-remove-name').fill(`${node.name}x`);
            await expect(confirm).toBeDisabled();
            await page.getByTestId('fleet-computer-remove-name').fill(node.name);
            await confirm.click({ timeout: CLICK_TIMEOUT });
            await expect(page).toHaveURL(/\/fleet\/computers$/);

            const gone = await page.goto(`/en/fleet/computers/${node.nodeId}`);
            expect(gone?.status()).toBe(404);
        } finally {
            await close();
        }
    });
});
