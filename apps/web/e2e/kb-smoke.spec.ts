import { test, expect } from '@playwright/test';

/**
 * Knowledge-Base e2e harness sanity check.
 *
 * Confirms that KB-prefixed specs are picked up by the existing
 * `apps/web/e2e/` Playwright harness — i.e. the authenticated `chromium`
 * project (with the shared `storageState` from global-setup) runs them and
 * the test-server bootstrap exposes the dashboard routes the future A12-A17
 * acceptance specs will need.
 *
 * Does NOT exercise the KB UI itself (that arrives in `kb-upload.spec.ts`
 * and friends as row 19+ lands). Keeping this minimal so the heavy
 * `e2e.yml` run on develop pushes doesn't grow a flake surface before the
 * acceptance specs need it.
 *
 * Replaces the orphaned `apps/web-e2e/` workspace bootstrapped in PR #946 —
 * the existing `apps/web/e2e/` already owns auth fixtures, MailHog,
 * service containers, server bootstrapping, and the 150-min budget, so
 * standing up a parallel harness would have been duplicate plumbing.
 */

test.describe('Knowledge Base — e2e harness smoke', () => {
    test('authenticated session reaches /en/works without redirect to login', async ({ page }) => {
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });

        // The chromium project mounts the shared storageState produced by
        // global-setup, so we MUST land somewhere under /en that isn't an
        // auth page. If we slipped back to /login the storageState wiring
        // is broken and every downstream KB acceptance spec is dead in
        // the water — surface that here, not 200 lines into A12.
        await expect(page).not.toHaveURL(/\/(login|register|forgot|reset|email|auth)/);

        // The dashboard shell — sidebar (aside) or header (nav) — should
        // render. We're explicitly NOT pinning a KB-specific selector
        // because no Work exists in the fresh test DB yet, so the KB pages
        // (which live at /works/[id]/kb/...) aren't directly reachable
        // without a fixture work. That fixture is row 19's job (A12).
        const navChrome = page.locator('aside, nav').first();
        await expect(navChrome).toBeVisible({ timeout: 15_000 });
    });
});
