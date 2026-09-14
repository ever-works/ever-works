import { test, expect, type APIRequestContext, type Browser, type Route } from '@playwright/test';
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
 * and the dashboard: every server-action round trip answering 500.
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

async function failServerActions(route: Route) {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action']) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'unavailable' });
        return;
    }
    await route.fallback();
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

            await page.route('**/*', failServerActions);
            await control.click();

            const dialog = page.getByRole('dialog');
            const error = dialog.getByTestId('whats-new-error');
            await expect(error).toBeVisible({ timeout: 15_000 });
            await expect(error).toContainText("Couldn't load updates.");
            await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
            await expect(page.getByTestId('whats-new-badge')).toHaveCount(0);

            await page.unroute('**/*', failServerActions);
            await error.getByRole('button', { name: 'Try again' }).click();

            await expect(dialog.getByTestId('whats-new-list')).toBeVisible({ timeout: 15_000 });
            await expect(dialog.getByTestId('whats-new-error')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});
