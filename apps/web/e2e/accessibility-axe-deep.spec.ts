import { test, expect } from '@playwright/test';

/**
 * Accessibility — axe-core deep run. Deepens accessibility.spec.ts.
 * We load axe-core via CDN and run it against several key pages,
 * pinning the *count* of serious+ violations rather than just "no
 * critical violations" so regressions surface clearly.
 *
 * Threshold is loose — the goal is to catch a 10x regression (1 → 10
 * critical violations), not chase every minor warning.
 */

const SERIOUS_VIOLATION_CEILING = 10;

interface AxeResult {
    violations: Array<{
        id: string;
        impact: string | null;
        nodes: Array<{ html?: string; target?: string[] }>;
    }>;
}

async function runAxe(page: import('@playwright/test').Page): Promise<AxeResult | null> {
    // Try to inject axe via CDN; bail with null if blocked.
    const loaded = await page.evaluate(async () => {
        if ((window as unknown as { axe?: { run: (opts?: unknown) => Promise<unknown> } }).axe) {
            return true;
        }
        return new Promise<boolean>((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/axe-core@4.10/axe.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    });
    if (!loaded) return null;
    return page.evaluate(async () => {
        const w = window as unknown as {
            axe: { run: (opts: unknown) => Promise<AxeResult> };
        };
        return w.axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    });
}

test.describe('axe-core — login page', () => {
    test('login page: count of serious+ violations is bounded', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(1_500);
        const results = await runAxe(page);
        if (!results) test.skip(true, 'axe-core could not load (CDN blocked?)');
        const serious = results!.violations.filter(
            (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        // Log violation ids for visibility in CI output.
        const ids = serious.map((v) => v.id).join(', ');
        expect(
            serious.length,
            `serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
        ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
    });
});

test.describe('axe-core — register page', () => {
    test('register page: count of serious+ violations is bounded', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(1_500);
        const results = await runAxe(page);
        if (!results) test.skip(true, 'axe-core could not load');
        const serious = results!.violations.filter(
            (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        const ids = serious.map((v) => v.id).join(', ');
        expect(
            serious.length,
            `register serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
        ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
    });
});

test.describe('axe-core — color contrast spot-check', () => {
    test('login page passes color-contrast (or skip if axe blocked)', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(1_500);
        const results = await runAxe(page);
        if (!results) test.skip(true, 'axe-core could not load');
        const contrast = results!.violations.filter((v) => v.id === 'color-contrast');
        // Color contrast is an a11y red-flag. We allow up to 3 per page
        // (typical when the brand palette is mid-revision) but fail
        // beyond that.
        expect(
            contrast.length,
            `color-contrast violations: ${contrast.length}`,
        ).toBeLessThanOrEqual(3);
    });
});
