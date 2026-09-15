import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * AW-01 — the dashboard command palette, end to end against the real stack:
 * `Ctrl/Cmd+K` and the top-bar trigger open one overlay; typing reaches
 * records through `GET /api/workspace-search` (BFF → API → live fan-out);
 * Missions and Tasks stay two separate groups; commands act; and the
 * Knowledge-Base workbench keeps `Ctrl/Cmd+K` for its own palette.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token as string;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: `${title} description`, type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text()}`).toBe(201);
    return ((await res.json()) as { id: string }).id;
}

/** Dev hydration can swallow the first keypress, so retry until the overlay mounts. */
async function openWithShortcut(page: Page) {
    const palette = page.getByTestId('command-palette');
    await expect(async () => {
        if (!(await palette.isVisible())) await page.keyboard.press('Control+k');
        await expect(palette).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    return palette;
}

test.describe('Command palette', () => {
    test('Ctrl+K finds a Mission and a Task as two groups and opens the Mission', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const needle = `zeta${Date.now().toString(36)}`;
        const missionId = await createMission(request, token, `Palette ${needle} mission`);
        await createTaskViaAPI(request, token, { title: `Palette ${needle} task` });

        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        const palette = await openWithShortcut(page);
        await expect(page.getByRole('dialog', { name: 'Search and commands' })).toBeVisible();

        const input = page.getByTestId('command-palette-input');
        await expect(input).toBeFocused();
        await input.fill(needle);

        const missions = palette.locator(
            '[data-testid="command-palette-group"][data-group-kind="mission"]',
        );
        const tasks = palette.locator(
            '[data-testid="command-palette-group"][data-group-kind="task"]',
        );
        await expect(missions).toBeVisible({ timeout: 20_000 });
        await expect(tasks).toBeVisible();
        await expect(missions.getByText(`Palette ${needle} mission`)).toBeVisible();
        await expect(tasks.getByText(`Palette ${needle} task`)).toBeVisible();
        await expect(missions.getByText(`Palette ${needle} task`)).toHaveCount(0);

        await missions.getByText(`Palette ${needle} mission`).click();
        await expect(page).toHaveURL(new RegExp(`/missions/${missionId}`), { timeout: 30_000 });
        await expect(palette).toBeHidden();
    });

    test('the top-bar trigger opens the same palette, and Esc closes it', async ({ page }) => {
        await page.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        const trigger = page.getByTestId('command-palette-trigger');
        await expect(trigger).toBeVisible({ timeout: 60_000 });
        await trigger.click();

        const palette = page.getByTestId('command-palette');
        await expect(palette).toBeVisible();
        await expect(palette.locator('[data-group-kind="suggested"]')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(palette).toBeHidden();
        await expect(trigger).toBeFocused();
    });

    test('"help" opens the Help drawer without navigating', async ({ page }) => {
        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        const before = new URL(page.url()).pathname;
        await openWithShortcut(page);
        await page.getByTestId('command-palette-input').fill('open help');
        await page.keyboard.press('Enter');

        await expect(page.getByTestId('command-palette')).toBeHidden();
        await expect(page.getByRole('dialog').first()).toBeVisible();
        expect(new URL(page.url()).pathname).toBe(before);
    });

    test('"Search works" still reaches the Works list with its filter focused', async ({
        page,
    }) => {
        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        await openWithShortcut(page);
        await page.getByTestId('command-palette-input').fill('search works');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/works(\?|$)/, { timeout: 30_000 });
    });

    test('inside the Knowledge-Base workbench, Ctrl+K opens the workbench palette and stays put', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Palette KB ${Date.now().toString(36)}`,
        });
        expect(workId).toBeTruthy();

        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });

        const kbPalette = page.getByTestId('kb-workbench-search-palette');
        await expect(async () => {
            if (!(await kbPalette.isVisible())) await page.keyboard.press('Control+k');
            await expect(kbPalette).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });

        await expect(page.getByTestId('command-palette')).toBeHidden();
        await expect(page).toHaveURL(new RegExp(`/works/${workId}/kb`));
    });
});
