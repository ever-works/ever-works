import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * What's new (AW-14) — the in-product product changelog, end to end.
 *
 * Two halves:
 *
 * 1. The API contract the panel is built on: auth, the unread count, the
 *    signup baseline, idempotent read marks, validation of the read body, and
 *    a permalink lookup that cannot be used to discover unreleased entries.
 * 2. The UI golden path on a real dashboard: the control is in the top bar,
 *    a brand-new account has no badge, the panel opens as a dialog with the
 *    entries that ship with this build, and Escape closes it and gives focus
 *    back to the control.
 *
 * Every test uses a FRESH account. Entries are part of the build and every
 * one of them predates an account created by the test, so the signup
 * baseline (spec FR-14, S-7) makes "zero unread" a true statement here
 * rather than an assumption about test ordering. The decrement-on-read and
 * mark-all paths for a reader WITH unread entries are covered by the
 * component and service specs, which can control the clock.
 */

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;

async function freshContext(browser: Browser) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([{ name: 'sidebar-collapsed', value: '0', url: ORIGIN }]);
    return context;
}

/** A fresh account whose first-run wizard is dismissed, so it does not cover the top bar. */
async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    const user = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(user.access_token),
    });
    expect(dismissed.ok(), `dismiss body=${await dismissed.text().catch(() => '')}`).toBe(true);
    return user;
}

test.describe("What's new — API contract", () => {
    test('every changelog route refuses an anonymous reader (FR-32)', async ({ request }) => {
        for (const path of ['/api/changelog', '/api/changelog/unread-count']) {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), path).toBe(401);
        }
        const read = await request.post(`${API_BASE}/api/changelog/read`, {
            data: { slugs: ['any-entry'] },
        });
        expect(read.status()).toBe(401);
    });

    test('a brand-new account starts at zero unread and reads every shipped entry as read (FR-14, S-7)', async ({
        request,
    }) => {
        const user = await freshUser(request);
        const headers = authedHeaders(user.access_token);

        const count = await request.get(`${API_BASE}/api/changelog/unread-count`, { headers });
        expect(count.status()).toBe(200);
        expect(count.headers()['cache-control']).toContain('no-store');
        expect(await count.json()).toEqual({ count: 0 });

        const list = await request.get(`${API_BASE}/api/changelog`, { headers });
        expect(list.status()).toBe(200);
        const body = await list.json();
        expect(body.unreadCount).toBe(0);
        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(body.entries.length).toBeGreaterThanOrEqual(1);
        expect(body.entries.every((entry: { isRead: boolean }) => entry.isRead)).toBe(true);
    });

    test('read marks are idempotent and a permalink cannot probe for unreleased entries (FR-18, FR-19, S-15)', async ({
        request,
    }) => {
        const user = await freshUser(request);
        const headers = authedHeaders(user.access_token);
        const list = await (await request.get(`${API_BASE}/api/changelog`, { headers })).json();
        const slug: string = list.entries[0].slug;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const read = await request.post(`${API_BASE}/api/changelog/read`, {
                headers,
                data: { slugs: [slug, 'not-in-this-build'] },
            });
            expect(read.status()).toBe(200);
            expect(await read.json()).toEqual({ unreadCount: 0 });

            const all = await request.post(`${API_BASE}/api/changelog/read-all`, { headers });
            expect(all.status()).toBe(200);
            expect(await all.json()).toEqual({ unreadCount: 0 });
        }

        const found = await request.get(`${API_BASE}/api/changelog/${slug}`, { headers });
        expect(found.status()).toBe(200);
        expect((await found.json()).slug).toBe(slug);

        const missing = await request.get(`${API_BASE}/api/changelog/not-in-this-build`, {
            headers,
        });
        expect(missing.status()).toBe(404);
    });

    test('the read body is validated: empty, oversized and malformed batches are refused (FR-6, FR-17)', async ({
        request,
    }) => {
        const user = await freshUser(request);
        const headers = authedHeaders(user.access_token);
        const tooMany = Array.from({ length: 26 }, (_, index) => `entry-${index}`);

        for (const slugs of [[], tooMany, ['Upper-Case'], ['a/b']]) {
            const res = await request.post(`${API_BASE}/api/changelog/read`, {
                headers,
                data: { slugs },
            });
            expect(res.status(), JSON.stringify(slugs)).toBe(400);
        }
    });
});

test.describe("What's new — panel", () => {
    test('the control sits in the top bar with no badge, and the panel opens, lists entries and closes back to it', async ({
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
            await expect(control).toHaveAttribute('aria-haspopup', 'dialog');
            await expect(control).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByTestId('whats-new-badge')).toHaveCount(0);

            // The shell paints its server markup before React hydrates, and a
            // keypress that lands first is dropped (stage run 34970057817,
            // retry #2, opened nothing at all — the dialog never resolved).
            // Retry the SAME keyboard activation — never a mouse click — so
            // Enter on the focused control stays the thing under test.
            //
            // Scoped to the panel's OWN dialog: `WhatsNewPanel.tsx` puts
            // `data-testid="whats-new-panel"` on the very element that carries
            // `role="dialog"` (the stage call log resolved exactly that node).
            // `/en/works` is also where the first-run onboarding wizard mounts
            // its own dialog, so an UNSCOPED `getByRole('dialog')` could read
            // "something is already open", never press Enter, and then
            // strict-resolve against two elements.
            const dialog = page.getByRole('dialog').and(page.getByTestId('whats-new-panel'));
            await expect(async () => {
                if ((await dialog.count()) === 0) {
                    await control.focus();
                    await page.keyboard.press('Enter');
                }
                await expect(dialog).toBeAttached({ timeout: 3_000 });
            }).toPass({ timeout: 30_000 });

            // Headless UI puts role="dialog" on `<Dialog className="relative z-50">`,
            // a layout wrapper whose children are all `fixed` — it has a
            // zero-height box, so Playwright calls it hidden even while the
            // slide-over is fully painted (the CI call log resolved it 9× as
            // `data-open="" … data-headlessui-state="open"` and still said
            // "hidden"). Prove the panel opened from the control's own state
            // and from the painted surface inside the wrapper instead.
            await expect(control).toHaveAttribute('aria-expanded', 'true');
            await expect(dialog.getByRole('heading', { name: "What's new" })).toBeVisible();
            await expect(dialog.getByText('All caught up')).toBeVisible();

            const entries = dialog.getByTestId('whats-new-entry');
            // The list arrives on open through a server action (Next → API →
            // DB); the sibling whats-new-degraded.spec.ts allows the same 15s.
            await expect(entries.first()).toBeVisible({ timeout: 15_000 });
            await expect(entries.first()).toHaveAttribute('data-read', 'true');
            await expect(dialog.getByTestId('whats-new-filter-all')).toHaveAttribute(
                'aria-checked',
                'true',
            );

            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(control).toBeFocused();

            // Reload: still no badge — no state was invented by opening the panel.
            await page.reload({ waitUntil: 'networkidle' });
            await expect(page.getByTestId('whats-new-button')).toBeVisible();
            await expect(page.getByTestId('whats-new-badge')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});
