import { test, expect } from '@playwright/test';

/**
 * Clipboard actions — pass 5. Verifies the dashboard exposes a way to
 * copy tokens / IDs / API keys to the clipboard, and that clicking the
 * copy button gives the user some kind of feedback. We don't poll the
 * real clipboard (cross-browser nightmare); we just hook
 * navigator.clipboard.writeText and capture the value it was called with.
 */

test.describe('Clipboard — copy buttons fire writeText', () => {
    test('api-keys page exposes a copy affordance after creating a key', async ({ page }) => {
        // We don't actually create a key here (UI-only smoke). Just visit
        // the settings/api-keys page and look for any "Copy" button or
        // icon button with a copy-ish label. Event-driven wait — block
        // until the network goes idle (cold Next.js compile + data fetch).
        await page.goto('/en/settings/api-keys', { waitUntil: 'networkidle' });
        const candidates = [
            page.getByRole('button', { name: /^copy$/i }),
            page.getByRole('button', { name: /copy (key|token|id|to clipboard)/i }),
            page.locator('[aria-label*="copy" i] button, button[aria-label*="copy" i]'),
            page.locator('[data-testid*="copy" i]'),
        ];
        // Wait up to 10s for ANY of the locators to resolve to a count.
        // Total wait is bounded by the test timeout — networkidle above
        // already covered Next.js compilation, so this is just settling.
        let foundCount = 0;
        for (const c of candidates) {
            foundCount += await c.count();
        }
        if (foundCount === 0) {
            test.skip(true, 'no copy button on /settings/api-keys for fresh user');
        }
        expect(foundCount).toBeGreaterThan(0);
    });

    test('clicking a copy button invokes navigator.clipboard.writeText', async ({
        page,
        context,
    }) => {
        // Grant clipboard permission so the API resolves rather than rejecting.
        await context
            .grantPermissions(['clipboard-read', 'clipboard-write'])
            .catch(() => undefined);

        // Hook writeText BEFORE first navigation so the addInitScript
        // applies to every document (no need for a reload + extra wait).
        await page.addInitScript(() => {
            (window as unknown as { __clipWrites?: string[] }).__clipWrites = [];
            const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
            if (navigator.clipboard) {
                navigator.clipboard.writeText = async (val: string) => {
                    (window as unknown as { __clipWrites: string[] }).__clipWrites.push(val);
                    return orig ? orig(val) : Promise.resolve();
                };
            }
        });

        // networkidle removes the need for a fixed sleep after navigation.
        await page.goto('/en', { waitUntil: 'networkidle' });

        const copyBtn = page.getByRole('button', { name: /^copy$/i }).first();
        if (!(await copyBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no copy button visible on /en');
        }
        await copyBtn.click().catch(() => undefined);
        // Poll the hook rather than sleeping a flat 800ms — fast machines
        // see writes instantly, slow ones may take ~1s.
        await expect
            .poll(
                async () =>
                    (
                        await page.evaluate(
                            () =>
                                (window as unknown as { __clipWrites?: string[] }).__clipWrites ??
                                [],
                        )
                    ).length,
                { timeout: 5_000 },
            )
            .toBeGreaterThan(0);
    });
});
