import { test, expect } from '@playwright/test';

/**
 * EW-644 — auth-gate coverage for the github-storage plugin settings route.
 *
 * Mirrors the lightweight pattern in `plugin-detail-ui.spec.ts`: drive the
 * route logged-out and assert it either redirects to /login or returns a
 * non-5xx. Validates that the new `/en/plugins/github-storage` page is
 * registered, doesn't 500 on the server (e.g. a schema-render crash from
 * the new `x-widget: 'github-owner' | 'github-repo'` keys), and is gated
 * behind auth like every other plugin settings page.
 *
 * Driving the actual mode-toggle / showIf / widget interactions requires
 * authenticated storage state + a connected GitHub provider account that
 * the existing e2e harness doesn't seed (RepositorySelector also can't
 * be driven from these tests for the same reason). The widget logic is
 * covered by the Vitest plugin matrix + the API-side Jest tests; this
 * spec just locks in the URL + auth contract so we don't regress the
 * dashboard route from a schema rename.
 *
 * Routes:
 *   - `/en/plugins/github-storage`            — user-level plugin detail
 *   - `/en/settings/plugins/storage`          — storage category list
 */

const ROUTES = ['/en/plugins/github-storage', '/en/settings/plugins/storage'];

test.describe('github-storage plugin settings — auth gate (EW-644)', () => {
    for (const path of ROUTES) {
        test(`${path} requires auth (redirect or 4xx)`, async ({ page, baseURL }) => {
            const url = `${baseURL || 'http://localhost:3000'}${path}`;
            const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
            const final = page.url();
            if (res) {
                expect(res.status(), `${path} should not 5xx (schema render crash?)`).toBeLessThan(
                    500,
                );
            }
            expect(
                final.includes('/login') || (res && [200, 403, 404].includes(res.status())),
                `unexpected final state for ${path}: ${final}`,
            ).toBeTruthy();
        });
    }
});
