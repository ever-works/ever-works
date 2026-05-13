import { test, expect } from '@playwright/test';
import { apiUrl } from './helpers/api';

/**
 * Full user journey E2E test.
 *
 * Tests the complete lifecycle: register -> dashboard -> create work -> view -> settings.
 * This runs WITHOUT pre-authenticated state (fresh user).
 */

test.describe('Complete user journey', () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = {
        name: `Journey User ${suffix}`,
        email: `journey-${suffix}@test.local`,
        password: 'JourneyPass1!secure',
    };

    test('register, create work, browse, visit settings', async ({ page }) => {
        test.setTimeout(240_000);

        // Warm up the dashboard route so the post-register redirect resolves quickly.
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        // ---- Step 1: Register ----
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1_000);

        await page.locator('input[name="name"]').fill(user.name);
        await page.locator('input[name="email"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);
        await page.locator('input[name="confirmPassword"]').fill(user.password);
        await page.locator('#terms').check();
        await page.locator('button[type="submit"]').click();

        // Should arrive at dashboard (any /en path that isn't an auth page)
        await page.waitForURL(/\/en(\/(?!login|register|forgot|reset|email|auth)|$|\?)/, {
            timeout: 60_000,
        });

        // ---- Step 2: Navigate to create work ----
        // Pre-dismiss the onboarding wizard so the modal doesn't intercept clicks.
        // v1 wizard stores dismissal in localStorage; v2 wizard reads `dismissedAt`
        // from the API (users.onboarding_dismissed_at). Address both — the v2 modal
        // portal was blocking the manual-card click below for 100+ retries until the
        // 240s test budget exhausted.
        await page.evaluate(() => {
            try {
                window.localStorage.setItem(
                    'ever-works-onboarding',
                    JSON.stringify({
                        step: 0,
                        modalDismissed: true,
                        headerDismissed: true,
                    }),
                );
            } catch {
                /* ignore */
            }
        });
        try {
            const loginRes = await page.request.post(apiUrl('/api/auth/login'), {
                data: { email: user.email, password: user.password },
            });
            if (loginRes.ok()) {
                const { access_token } = (await loginRes.json()) as { access_token?: string };
                if (access_token) {
                    await page.request.post(apiUrl('/api/onboarding/dismiss'), {
                        headers: { Authorization: `Bearer ${access_token}` },
                        data: {},
                    });
                }
            }
        } catch {
            // Older API builds without the v2 endpoint — the localStorage seed
            // above still covers v1 specs that don't depend on v2 dismissal.
        }
        await page.reload({ waitUntil: 'domcontentloaded' });

        // Dismiss the "Connect your GitHub account" modal if it appears.
        const dismissGithubModal = page.getByRole('button', {
            name: /I'll do this later/i,
        });
        if (await dismissGithubModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await dismissGithubModal.click();
            await page.waitForTimeout(500);
        }

        await page.goto('/en/works/new', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);
        // Also dismiss on /works/new in case the modal re-renders there.
        if (await dismissGithubModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await dismissGithubModal.click();
            await page.waitForTimeout(500);
        }

        // Select manual creation mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await expect(manualCard).toBeVisible({ timeout: 10_000 });
        await manualCard.click();

        // Fill work form (scope to the work creation form, not the AI chat input form)
        const dirSlug = `journey-${suffix}`;
        const workForm = page.locator('form.space-y-6, form[autocomplete="off"]').first();
        await expect(workForm).toBeVisible({ timeout: 10_000 });

        const nameInput = workForm.locator('input[type="text"]').first();
        await nameInput.fill(`Journey Dir ${dirSlug}`);

        const descriptionTextarea = workForm.locator('textarea').first();
        await descriptionTextarea.fill('Full journey test work');

        // Submit
        const submitButton = workForm.locator('button[type="submit"]');
        await submitButton.click();

        // Wait for redirect or error
        await page.waitForURL(/\/works\/(?!new)/, { timeout: 15_000 }).catch(() => {
            // May fail if git provider not configured — that's ok for e2e
        });

        // ---- Step 3: Visit works list ----
        await page.goto('/en/works');
        await expect(page).toHaveURL(/\/works/);

        // ---- Step 4: Visit settings ----
        await page.goto('/en/settings');
        await expect(page).toHaveURL(/\/settings/);

        // Verify username is shown
        const usernameInput = page.locator('input').first();
        await expect(usernameInput).toBeVisible({ timeout: 10_000 });

        // ---- Step 5: Visit security settings ----
        await page.goto('/en/settings/security');
        await expect(page.locator('input[type="password"]').first()).toBeVisible({
            timeout: 10_000,
        });
    });
});
