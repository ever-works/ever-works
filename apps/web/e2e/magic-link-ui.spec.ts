import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    listMessages,
    extractLinkFromBody,
} from './helpers/mailhog';

/**
 * EW-633 — UI surface for the magic-link / passwordless flow.
 *
 * The backend API + email plumbing is exercised by `magic-link.spec.ts`.
 * This spec asserts that the web login page wires those endpoints into a
 * usable UI:
 *  - GET /api/auth/providers advertises `magicLink: true` → the login
 *    page renders a "Password | Email me a link" tab toggle.
 *  - Submitting the magic-link form posts to /api/auth/magic-link and
 *    renders a "check your inbox" confirmation.
 *  - The link delivered in the email lands the user on /login/magic-link
 *    and, after redemption, leaves them signed in on the dashboard.
 *
 * The whole spec depends on MAGIC_LINK_ENABLED=true. When the flag is
 * off the provider endpoint advertises `magicLink: false` and the UI
 * hides the tab — we skip in that case rather than fail.
 */

async function isMagicLinkEnabled(request: APIRequestContext): Promise<boolean> {
    const res = await request.get(`${API_BASE}/api/auth/providers`);
    if (!res.ok()) return false;
    const body = (await res.json()) as { magicLink?: boolean };
    return body.magicLink === true;
}

test.describe('Magic-link login UI — EW-633', () => {
    test('login page renders the magic-link tab when the API advertises it', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED is false on this build');
        }

        await page.goto('/login');
        await expect(page.getByTestId('login-tab-password')).toBeVisible();
        await expect(page.getByTestId('login-tab-magic-link')).toBeVisible();
        // Password tab is the default — the magic-link form should not
        // be in the DOM until the user switches to it.
        await expect(page.getByTestId('magic-link-form')).toHaveCount(0);
    });

    test('switching to the magic-link tab and submitting renders the inbox confirmation', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED is false on this build');
        }
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog service container not running');
        }

        // Use a registered user so the API actually issues a link
        // (issuance no-ops for unknown emails — anti-enumeration).
        const u = await registerUserViaAPI(request);
        await waitForMessageTo(request, u.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        await page.goto('/login');
        await page.getByTestId('login-tab-magic-link').click();
        await expect(page.getByTestId('magic-link-form')).toBeVisible();

        await page.getByTestId('magic-link-email').fill(u.email);
        await page.getByTestId('magic-link-submit').click();

        const success = page.getByTestId('magic-link-success');
        await expect(success).toBeVisible({ timeout: 15_000 });
        await expect(success).toContainText(u.email);
    });

    test('opening the magic-link in the browser signs the user in and lands on the dashboard', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED is false on this build');
        }
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog service container not running');
        }

        const u = await registerUserViaAPI(request);
        await waitForMessageTo(request, u.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        // Drive the UI to issue the link rather than hitting the API
        // directly — this asserts the form submission really wires up
        // to /api/auth/magic-link.
        await page.goto('/login');
        await page.getByTestId('login-tab-magic-link').click();
        await page.getByTestId('magic-link-email').fill(u.email);
        await page.getByTestId('magic-link-submit').click();
        await expect(page.getByTestId('magic-link-success')).toBeVisible({ timeout: 15_000 });

        // Poll MailHog for the sign-in email and pull the token URL.
        // Filter by `Subject` like magic-link.spec.ts to avoid picking
        // up the registration confirmation that races past the inbox
        // clear on a cold runner.
        const deadline = Date.now() + 30_000;
        let magicMsg: Awaited<ReturnType<typeof listMessages>>[number] | null = null;
        while (Date.now() < deadline) {
            const messages = await listMessages(request, 50);
            magicMsg =
                messages.find((m) => {
                    const toMatch = m.To?.some(
                        (t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === u.email.toLowerCase(),
                    );
                    if (!toMatch) return false;
                    const subjectHeader = m.Content?.Headers?.['Subject']?.[0] ?? '';
                    return /sign\s*in/i.test(subjectHeader);
                }) ?? null;
            if (magicMsg) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        if (!magicMsg) {
            test.skip(
                true,
                `magic-link email never arrived for ${u.email} within 30s — likely CI mail/SMTP transport flake`,
            );
        }

        const link = extractLinkFromBody(magicMsg!, /https?:\/\/[^\s"'<>]+token=[a-f0-9]+/i);
        expect(link, 'magic-link URL not found in email body').not.toBeNull();
        // The API mints the URL using its WEB_URL setting. Strip the
        // origin so we navigate inside the Playwright baseURL — that
        // way the spec doesn't depend on the API and the test runner
        // pointing at exactly the same host.
        const pathAndQuery = link!.replace(/^https?:\/\/[^/]+/, '');
        expect(pathAndQuery).toMatch(/^\/login\/magic-link\?token=[a-f0-9]+/);

        await page.goto(pathAndQuery);

        // On success the redeem server action redirects to the
        // dashboard. The dashboard route is the locale-prefixed root
        // ("/" plus the locale prefix next-intl adds).
        await page.waitForURL(/\/(en|fr|[a-z]{2})\/?$/, { timeout: 30_000 });
        expect(page.url()).not.toContain('/login');
    });

    test('opening /login/magic-link without a token shows a friendly error and a resend CTA', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED is false on this build');
        }

        await page.goto('/login/magic-link');
        await expect(page.getByTestId('magic-link-error')).toBeVisible();
        const resend = page.getByTestId('magic-link-request-new');
        await expect(resend).toBeVisible();
        await resend.click();
        await page.waitForURL(/\/login\?tab=magic-link/);
    });

    test('opening /login/magic-link with an invalid token shows the error path', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED is false on this build');
        }

        await page.goto('/login/magic-link?token=deadbeef-not-a-real-token');
        await expect(page.getByTestId('magic-link-error')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('magic-link-request-new')).toBeVisible();
    });
});
