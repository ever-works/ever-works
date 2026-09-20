import {
    test,
    expect,
    type APIRequestContext,
    type Browser,
    type Response,
    type Route,
} from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * What's new (AW-14) — degradation. A changelog is never important enough to
 * take the dashboard down with it.
 *
 * The panel reaches the API through Next server actions, which the browser
 * posts to the page URL with a `Next-Action` header; the API call itself
 * happens server-side where the browser cannot intercept it. So the failure
 * injected here is the one a reader can actually hit between their browser
 * and the dashboard: the panel's list round trip answering 500.
 *
 * Only THAT round trip fails. Spec S-10 is "the request for entries fails"
 * while "the rest of the dashboard is unaffected"; failing every server
 * action also failed the shell's own start-up actions, which can still be
 * starting after `networkidle`, and the AI chat provider then raised its own
 * (designed) "Failed to load AI providers" toast — a false red on the
 * no-toast assertion that says nothing about the changelog panel. The
 * no-toast assertion itself stays page-wide and unfiltered.
 *
 * The shell-render half of spec S-11 (the unread count failing while the
 * layout renders) runs entirely on the server and is pinned by
 * `src/lib/api/changelog.unit.spec.ts` instead.
 */

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;

async function freshContext(browser: Browser) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([{ name: 'sidebar-collapsed', value: '0', url: ORIGIN }]);
    return context;
}

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    const user = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(user.access_token),
    });
    expect(dismissed.ok()).toBe(true);
    return user;
}

/**
 * The panel's list action is `getChangelog` (`src/app/actions/changelog.ts`).
 * Its successful response is the only server-action payload that carries the
 * list DTO's `categoriesWithEntries` field (`ChangelogListResponseDto`), so
 * that field identifies it without depending on a build-specific action id.
 */
async function isChangelogListResponse(response: Response): Promise<boolean> {
    const request = response.request();
    if (request.method() !== 'POST' || !request.headers()['next-action']) {
        return false;
    }
    const body = await response.text().catch(() => '');
    return body.includes('"categoriesWithEntries"');
}

/** 500 every round trip to ONE server action; everything else goes through untouched. */
function failServerAction(actionId: string) {
    return async (route: Route) => {
        const request = route.request();
        if (request.method() === 'POST' && request.headers()['next-action'] === actionId) {
            await route.fulfill({ status: 500, contentType: 'text/plain', body: 'unavailable' });
            return;
        }
        await route.fallback();
    };
}

test.describe("What's new — degradation", () => {
    test('S-10: a panel that cannot load shows the error state, no toast, and recovers on retry', async ({
        browser,
        request,
    }) => {
        const user = await freshUser(request);
        const context = await freshContext(browser);
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await page.goto('/en/works', { waitUntil: 'networkidle' });

            const control = page.getByTestId('whats-new-button');
            await expect(control).toBeVisible();

            // Scoped to the panel's own dialog, as in whats-new-panel.spec.ts:
            // `/en/works` can also mount the onboarding wizard's dialog.
            const dialog = page.getByRole('dialog').and(page.getByTestId('whats-new-panel'));

            // Learn the panel's own list action first: open the panel once for
            // real and read the `Next-Action` id off the response that carries
            // the list. A fresh account has zero unread entries
            // (whats-new-panel.spec.ts, FR-14), so this open marks nothing read
            // and leaves no badge behind. The click is retried only while no
            // dialog is attached — a click that lands before hydration is
            // dropped.
            const [listResponse] = await Promise.all([
                page.waitForResponse(isChangelogListResponse, { timeout: 45_000 }),
                expect(async () => {
                    if ((await dialog.count()) === 0) {
                        await control.click({ timeout: 3_000 });
                    }
                    await expect(dialog).toBeAttached({ timeout: 3_000 });
                }).toPass({ timeout: 30_000 }),
            ]);
            const changelogActionId = listResponse.request().headers()['next-action'];
            await expect(dialog.getByTestId('whats-new-list')).toBeVisible({ timeout: 15_000 });
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);

            const failChangelogList = failServerAction(changelogActionId);
            await page.route('**/*', failChangelogList);
            await control.click();

            const error = dialog.getByTestId('whats-new-error');
            await expect(error).toBeVisible({ timeout: 15_000 });
            await expect(error).toContainText("Couldn't load updates.");
            await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
            await expect(page.getByTestId('whats-new-badge')).toHaveCount(0);

            await page.unroute('**/*', failChangelogList);
            await error.getByRole('button', { name: 'Try again' }).click();

            await expect(dialog.getByTestId('whats-new-list')).toBeVisible({ timeout: 15_000 });
            await expect(dialog.getByTestId('whats-new-error')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});
