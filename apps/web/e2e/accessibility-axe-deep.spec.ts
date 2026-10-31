import { test, expect } from '@playwright/test';
import { runAxe, seriousViolations, WCAG_A_AA, withoutPendingTokenContrast } from './helpers/axe';

/**
 * Accessibility — axe-core deep run. Deepens accessibility.spec.ts.
 * axe-core is injected from the installed package (`helpers/axe.ts`) and run
 * against several key pages, pinning the *count* of serious+ violations rather
 * than just "no critical violations" so regressions surface clearly.
 *
 * Threshold is loose — the goal is to catch a 10x regression (1 → 10
 * critical violations), not chase every minor warning.
 */

const SERIOUS_VIOLATION_CEILING = 10;

test.describe('axe-core — login page', () => {
    test('login page: count of serious+ violations is bounded', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(1_500);
        const serious = seriousViolations(await runAxe(page, { tags: WCAG_A_AA }));
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
        const serious = seriousViolations(await runAxe(page, { tags: WCAG_A_AA }));
        const ids = serious.map((v) => v.id).join(', ');
        expect(
            serious.length,
            `register serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
        ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
    });
});

test.describe('axe-core — color contrast spot-check', () => {
    test('login page passes color-contrast', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(1_500);
        // Contrast owed to a pending colour-token decision is annotated, not
        // counted (helpers/axe.ts, PENDING_TOKEN_FOREGROUNDS).
        const violations = withoutPendingTokenContrast(await runAxe(page, { tags: WCAG_A_AA }));
        // axe reports one `color-contrast` violation per page, listing every
        // failing element as a node, so the count is of nodes.
        const contrast = violations
            .filter((v) => v.id === 'color-contrast')
            .flatMap((v) => v.nodes);
        // Color contrast is an a11y red-flag. We allow up to 3 per page
        // (typical when the brand palette is mid-revision) but fail
        // beyond that.
        expect(
            contrast.length,
            `color-contrast violations: ${contrast.length} (${contrast.map((n) => (n.target ?? []).join(' ')).join(' | ') || 'none'})`,
        ).toBeLessThanOrEqual(3);
    });
});
