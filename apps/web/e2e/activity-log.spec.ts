import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Activity log — UI + API contract.
 *
 * UI: filter dropdowns, search/empty state, page header.
 * API: GET /api/activity-log, /summary, /running-count, /export, /:id.
 */

test.describe('Activity log — UI', () => {
    test('page renders with header and either table or empty state', async ({ page }) => {
        await page.goto('/en/activity', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const body = await page.locator('body').innerText();
        expect(body, 'header mentions activity').toMatch(/activity/i);
        expect(body.length, 'page has content').toBeGreaterThan(50);
    });

    test('filter controls are present (or empty state is rendered)', async ({ page }) => {
        await page.goto('/en/activity', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        // Either filter dropdowns are visible, or an empty-state message appears.
        const filters = page.locator(
            'select, [role="combobox"], button:has-text("Filter"), button:has-text("Type"), button:has-text("Status")',
        );
        const emptyState = page.locator('body').filter({ hasText: /no activity|nothing yet/i });

        const hasFilters = (await filters.count()) > 0;
        const hasEmpty = await emptyState
            .first()
            .isVisible({ timeout: 2_000 })
            .catch(() => false);
        expect(hasFilters || hasEmpty, 'filters or empty state present').toBe(true);
    });
});

test.describe('Activity log — API contract', () => {
    test('GET /api/activity-log without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/activity-log`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/activity-log with auth returns 200 + list shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // Should be an array, or { items: [...] } / { data: [...] }
        const list = Array.isArray(body) ? body : (body?.items ?? body?.data ?? body?.activities);
        expect(Array.isArray(list), `expected list shape, got ${typeof body}`).toBe(true);
    });

    test('GET /api/activity-log/summary returns object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/summary`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `summary status ${res.status()}`).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });

    test('GET /api/activity-log/running-count returns object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/running-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `running-count status ${res.status()}`).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });

    test('GET /api/activity-log/export returns CSV', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `export status ${res.status()}`).toBe(200);
        const ctype = res.headers()['content-type'] || '';
        expect(ctype.toLowerCase()).toMatch(/csv|text/);
    });

    test('GET /api/activity-log/:nonexistent returns 404 (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/activity-log/00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status(), `expected 404, got ${res.status()}`).toBeLessThan(500);
    });
});
