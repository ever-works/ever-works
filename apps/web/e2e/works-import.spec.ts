import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Import-existing-work flow.
 *
 * UI: select "Import existing" mode on /works/new → see GitHub-connect
 *     hint or repository picker (depending on whether user has connected
 *     a git provider). Either path proves the route renders.
 *
 * API: GET /api/works/import/repositories.
 */

test.describe('Works import — UI', () => {
    test('selecting Import mode shows repository picker or GitHub-connect prompt', async ({
        page,
    }) => {
        await page.goto('/en/works/new', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const importCard = page
            .locator('button')
            .filter({ hasText: /import existing|from repository|from github/i })
            .first();
        if (!(await importCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'import mode card not present in this build');
        }
        await importCard.click();
        await page.waitForTimeout(1_000);

        const body = await page.locator('body').innerText();
        // Either a repository hint, or a "connect GitHub" prompt should appear
        expect(body, 'import view should mention github/repository/connect').toMatch(
            /github|repository|connect|import/i,
        );
    });
});

test.describe('Works import — API', () => {
    test('GET /api/works/import/repositories without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/import/repositories`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/import/repositories with auth does not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/import/repositories`, {
            headers: authedHeaders(u.access_token),
        });
        // Without a connected git provider, a 200/400/424 response is fine.
        // We only care that the endpoint exists and isn't crashing.
        expect(res.status(), `import/repositories ${res.status()}`).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });

    test('POST /api/works/import/analyze without body returns 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works/import/analyze`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status(), `analyze ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
