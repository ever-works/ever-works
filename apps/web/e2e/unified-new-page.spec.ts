import { test, expect } from '@playwright/test';

/**
 * Unified `/new` page — PR CC2 introduced a single creation entry
 * point with a chip strip (`Mission` / `Idea` / `Website` /
 * `Landing Page` / `Blog` / `Directory` / `Awesome Repo` in that
 * fixed order). PR Y added an optional `?template=…` query param
 * that pre-fills the prompt when the user lands from a Mission
 * template card.
 *
 * Unit tests at `apps/web/src/components/new/NewPageClient.unit.spec.tsx`
 * already pin the chip-list contract + submit routing. This e2e
 * spec adds a smoke check that the page renders at all under the
 * real Next.js runtime.
 */

const NEW_PAGE_ROUTES = ['/en/new', '/en/new?type=mission', '/en/new?type=idea'];

test.describe('Unified /new page — smoke', () => {
    for (const route of NEW_PAGE_ROUTES) {
        test(`${route} renders without 5xx and exposes a prompt field`, async ({ page }) => {
            const responses: number[] = [];
            page.on('response', (r) => {
                if (r.url().includes(route.split('?')[0])) {
                    responses.push(r.status());
                }
            });
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1_500);

            // Page may redirect unauthenticated users to /login — that's
            // fine; we only care that there's no 5xx during render.
            for (const s of responses) {
                expect(s, `${route} returned ${s}`).toBeLessThan(500);
            }

            // If we land on /new (not redirected), the prompt textarea
            // must be present. If we're redirected to /login, the test
            // exits successfully — auth gating is its own contract.
            const url = page.url();
            if (url.includes('/new')) {
                // The textarea id is `new-prompt` per NewPageClient.tsx.
                const textarea = page.locator('#new-prompt, textarea').first();
                await expect(textarea).toBeVisible({ timeout: 5_000 });
            }
        });
    }

    test("/en/new?type=<garbage> doesn't break the page", async ({ page }) => {
        // Server page validates the type query param against a 7-element
        // whitelist; unknown values fall through to "no chip selected".
        // Pin that the page still renders rather than 500ing.
        const res = await page.goto('/en/new?type=not-a-real-chip', {
            waitUntil: 'domcontentloaded',
        });
        // Page may redirect — we just need a non-5xx final state.
        const status = res?.status() ?? 0;
        expect(status).toBeLessThan(500);
    });
});
