import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Click a client-side (soft) navigation control and wait for the URL to change.
 *
 * WHY THIS EXISTS — two distinct traps, both of which produced CI-only reds:
 *
 * 1. `page.waitForURL()` defaults to `waitUntil: 'load'`. A Next.js App Router
 *    soft navigation never fires another document `load` event, so the call
 *    hangs to its timeout *even though the URL already changed*:
 *
 *        TimeoutError: page.waitForURL: Timeout 30000ms exceeded.
 *        waiting for navigation until "load"
 *
 *    `expect(page).toHaveURL()` polls the URL only, so it is the correct
 *    assertion for a soft nav.
 *
 * 2. The click itself can land BEFORE React has hydrated and wired the
 *    `<Link>`/router handler. The element is present and clickable, the click
 *    "succeeds", and nothing happens — no navigation is ever initiated. Under
 *    CI shard load this is common; on a fast dev box it is nearly invisible.
 *
 * So the reliable pattern is: click, give the router a moment, and re-click if
 * the URL still has not changed — until it does or we run out of budget. That
 * is what this helper does.
 *
 * @param page     the page under test
 * @param control  the link/button that triggers the navigation
 * @param urlRe    the URL the navigation should land on
 * @param timeout  total budget for the whole click-and-land dance
 */
export async function clickAndExpectUrl(
    page: Page,
    control: Locator,
    urlRe: RegExp,
    timeout = 45_000,
): Promise<void> {
    await expect(control).toBeVisible({ timeout: Math.min(timeout, 30_000) });

    await expect(async () => {
        if (!urlRe.test(page.url())) {
            // `noWaitAfter` — we are polling the URL ourselves; we must not let
            // Playwright's own auto-wait block on a navigation that a
            // not-yet-hydrated handler may never start.
            await control.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
        }
        await expect(page).toHaveURL(urlRe, { timeout: 5_000 });
    }).toPass({ timeout });
}

/**
 * Click a control until the world reaches the expected state.
 *
 * Same hydration hazard as `clickAndExpectUrl`, but for in-page interactions
 * (filter chips, checkboxes, toggles) rather than navigations. A click that
 * lands before React attaches the handler is silently swallowed: the element is
 * visible, enabled and stable, Playwright reports the click as successful, and
 * nothing happens. Playwright sometimes says so outright —
 * `locator.check: Clicking the checkbox did not change its state`.
 *
 * `reached()` MUST describe the post-condition (not merely "the click
 * happened"), because we only re-click while it is still false — so a click
 * that DID land is never undone by a retry. That makes this safe for toggles.
 *
 * @param control the chip/checkbox/toggle to click
 * @param reached predicate that becomes true once the interaction took effect
 * @param timeout total budget
 */
export async function clickUntil(
    control: Locator,
    reached: () => Promise<boolean>,
    timeout = 45_000,
): Promise<void> {
    await expect(control).toBeVisible({ timeout: Math.min(timeout, 30_000) });

    await expect(async () => {
        if (!(await reached())) {
            await control.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
        }
        expect(await reached()).toBe(true);
    }).toPass({ timeout });
}
