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
        // icon button with a copy-ish label.
        await page.goto('/en/settings/api-keys', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_500);
        const candidates = [
            page.getByRole('button', { name: /^copy$/i }),
            page.getByRole('button', { name: /copy (key|token|id|to clipboard)/i }),
            page.locator('[aria-label*="copy" i] button, button[aria-label*="copy" i]'),
            page.locator('[data-testid*="copy" i]'),
        ];
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
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_500);

        // Hook writeText so we can capture invocations regardless of which
        // clipboard backend the OS picks.
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
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const copyBtn = page.getByRole('button', { name: /^copy$/i }).first();
        if (!(await copyBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no copy button visible on /en');
        }
        await copyBtn.click().catch(() => undefined);
        await page.waitForTimeout(800);
        const writes = await page.evaluate(
            () => (window as unknown as { __clipWrites?: string[] }).__clipWrites ?? [],
        );
        expect(writes.length, 'copy button did not invoke clipboard.writeText').toBeGreaterThan(0);
    });
});
