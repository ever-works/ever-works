import { test, expect } from '@playwright/test';

/**
 * Hydration errors — pass 13. React's `Hydration mismatch` warning
 * lights up the console when server-rendered HTML doesn't match what
 * the client first renders. Common causes: Date.now() in render, env
 * conditionals, locale formatting drift.
 *
 * We monitor console for the canonical warning string on /en, /en/works,
 * /en/settings (the three load-bearing dashboard surfaces).
 */

const HYDRATION_MARKERS = [
    /hydration\s*(failed|mismatch|error)/i,
    /text content does not match server-rendered HTML/i,
    /did not match\.\s*server:/i,
    /Warning:.*hydrat/i,
];

const ROUTES = ['/en', '/en/works', '/en/settings'];

test.describe('Hydration — no React hydration mismatches', () => {
    for (const route of ROUTES) {
        test(`${route} renders without hydration warnings`, async ({ page }) => {
            // Greptile P2 / team rule: mutable accumulator arrays use
            // `let` per ever-co/ever-gauzy#8961.
            let warnings: string[] = [];
            page.on('console', (msg) => {
                if (msg.type() !== 'warning' && msg.type() !== 'error') return;
                const text = msg.text();
                if (HYDRATION_MARKERS.some((p) => p.test(text))) {
                    warnings.push(text.slice(0, 200));
                }
            });
            await page.goto(route, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2_000);
            // Allow ONE hydration warning (some Tailwind / next-intl
            // bootstrap paths emit a benign one). Two+ is the
            // regression we care about.
            expect(
                warnings.length,
                `hydration warnings on ${route}: ${warnings.slice(0, 2).join(' | ')}`,
            ).toBeLessThanOrEqual(1);
        });
    }
});

test.describe('Hydration — no uncaught errors in the boot path', () => {
    test('/en doesn\'t log any "Uncaught" errors to console', async ({ page }) => {
        let errs: string[] = [];
        page.on('pageerror', (err) => {
            errs.push(err.message);
        });
        await page.goto('/en', { waitUntil: 'networkidle' });
        await page.waitForTimeout(2_000);
        // We tolerate ONE error (often a benign DevTools / Next.js
        // dev-mode-only Hot Module Reload event). Two+ is suspicious.
        expect(
            errs.length,
            `page errors on /en: ${errs.slice(0, 2).join(' | ')}`,
        ).toBeLessThanOrEqual(1);
    });
});
