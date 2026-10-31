/**
 * APW-08 T52 (XC-25, FR-71, ACC-08-35) — the evolve loop's P1 surfaces are accessible.
 *
 * axe-core (WCAG 2 A + AA, injected from the CDN as in `flow-app-deploy-a11y.spec.ts`, skipped by
 * name when the CDN is blocked) reports **no serious or critical** violation on:
 *
 *   - the board's delivery chips and the App Work header (`/works/:id/tasks`);
 *   - a failed change's Task page: the Delivery section (timeline, Build links, Create a fix Task,
 *     Close anyway) and the Cost section with its containment notice (a seeded Fleet run whose
 *     node reported the ordinary path and a downgrade);
 *   - a live change's Delivery section (live URL, Deployments link);
 *   - the Work overview card and the Work cost summary;
 *   - both dialogs, open: Close anyway's confirmation and Request a change.
 *
 * Keyboard: `Tab` walks every control of the Delivery section and the cost summary in DOM order,
 * each with a visible focus indicator; each dialog opens from its opener by `Enter`, takes focus,
 * closes on `Esc` and hands focus back to the opener.
 *
 * Announcements: the Delivery section's polite live region carries the chip's state.
 *
 * RTL: in `ar` and `he` the page is `dir="rtl"`, the Delivery and Cost sections have no serious
 * violation, no chip is clipped, and the containment list indents on the inline START (right).
 *
 * Fixtures come from the non-production seed routes (`helpers/app-works-evolve.ts`, gate
 * `E2E_APP_LAUNCHER_SEED=true`); nothing here needs GitHub, a Build or a Fleet node.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
    createWorkTask,
    gotoDashboard,
    seedAppWork,
    seedTaskState,
    seededToken,
    transitionTask,
    type CreatedTask,
} from './helpers/app-works-evolve';

test.describe.configure({ mode: 'serial' });

// axe-core is injected from the CDN, which the app's own Content-Security-Policy (`script-src`
// lists no CDN) refuses: without this the script never loads and every axe check would skip
// itself. Test-only: the browser ignores the page's CSP for this file, nothing in the app changes.
test.use({ bypassCSP: true });

const LIVE_URL = 'https://a11y-e2e.example.com';

const DELIVERY = '[data-testid="task-delivery-section"]';
const COST = '[data-testid="task-cost-section"]';

interface AxeViolation {
    id: string;
    impact: string | null;
    nodes: Array<{ html?: string; target?: string[] }>;
}

/** Run axe on `include`, or `null` when axe-core could not be loaded. */
async function runAxe(page: Page, include: string[]): Promise<AxeViolation[] | null> {
    const loaded = await page.evaluate(async () => {
        if ((window as unknown as { axe?: unknown }).axe) return true;
        return new Promise<boolean>((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/axe-core@4.10/axe.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    });
    if (!loaded) return null;
    return page.evaluate(async (selectors) => {
        const w = window as unknown as {
            axe: {
                run: (
                    context: unknown,
                    options: unknown,
                ) => Promise<{ violations: AxeViolation[] }>;
            };
        };
        const result = await w.axe.run(
            { include: selectors.map((selector) => [selector]) },
            { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } },
        );
        return result.violations;
    }, include);
}

function describeViolations(violations: AxeViolation[]): string {
    return violations
        .map(
            (v) =>
                `${v.id} (${v.impact}): ${v.nodes.map((n) => (n.target ?? []).join(' ')).join(' | ')}`,
        )
        .join('; ');
}

async function expectNoSeriousViolations(page: Page, include: string[]): Promise<void> {
    const violations = await runAxe(page, include);
    test.skip(violations === null, 'axe-core could not load (CDN blocked?)');
    const serious = violations!.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, `serious+ violations: ${describeViolations(serious) || 'none'}`).toEqual([]);
}

/** The focused element carries a visible indicator: an outline, or a ring (box-shadow). */
async function expectVisibleFocus(target: Locator, name: string): Promise<void> {
    const style = await target.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
            outline: css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0,
            ring: css.boxShadow !== 'none' && css.boxShadow !== '',
        };
    });
    expect(style.outline || style.ring, `${name} shows a focus indicator`).toBe(true);
}

/**
 * Focus the first control inside `scope`, then press `Tab` once per remaining control: each press
 * must land on the next control in DOM order, with a visible focus indicator.
 */
async function expectTabWalk(page: Page, scope: Locator, name: string): Promise<number> {
    const controls = scope.locator(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]',
    );
    await expect(controls.first(), `${name} has a keyboard control`).toBeVisible();
    const count = await controls.count();
    await controls.first().focus();
    for (let index = 0; index < count; index++) {
        const control = controls.nth(index);
        if (index > 0) await page.keyboard.press('Tab');
        await expect(
            control,
            `${name}: Tab reaches control ${index + 1} of ${count}`,
        ).toBeFocused();
        await expectVisibleFocus(control, `${name} control ${index + 1}`);
    }
    return count;
}

/**
 * Open a dialog from `opener` by keyboard. Under `next dev` the server-rendered button can take
 * focus before hydration attaches its handler, so the first `Enter` may be dropped (the retry the
 * Deploy-tab a11y spec uses).
 */
async function openByKeyboard(page: Page, opener: Locator, dialog: Locator): Promise<void> {
    await expect(async () => {
        if (!(await dialog.isVisible().catch(() => false))) {
            await opener.focus();
            await page.keyboard.press('Enter');
        }
        await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    // (Headless UI's `role="dialog"` element is a zero-size positioning wrapper, so visibility
    // is asserted on the panel's own content above, not on the role.)
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
}

async function expectFocusInsideDialog(page: Page): Promise<void> {
    await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), {
            message: 'focus moves into the open dialog',
        })
        .toBe(true);
}

interface Fixture {
    workId: string;
    failed: CreatedTask;
    live: CreatedTask;
}

let fixture: Fixture | null = null;

/** One App Work with a failed change (in review, a containment record) and a live one. */
async function ensureFixture(request: Parameters<typeof seededToken>[0]): Promise<Fixture> {
    if (fixture) return fixture;
    const token = await seededToken(request);
    const { workId } = await seedAppWork(request, token, `A11y e2e ${Date.now().toString(36)}`);

    const failed = await createWorkTask(request, token, workId, { title: 'a11y failed change' });
    await transitionTask(request, token, failed.id, 'in_review');
    await seedTaskState(request, token, {
        taskId: failed.id,
        delivery: { state: 'build_failed', prNumber: 11 },
        run: {
            containment: {
                executionPath: 'ordinary',
                isolatedHome: false,
                downgrades: [{ control: 'sandbox', reason: 'no OS sandbox on this machine' }],
            },
        },
    });

    const live = await createWorkTask(request, token, workId, { title: 'a11y live change' });
    await seedTaskState(request, token, {
        taskId: live.id,
        delivery: { state: 'live', deployment: { state: 'READY', website: LIVE_URL } },
    });

    // The board's other chip shapes: progress, a failed Deployment with its outcome, closed.
    for (const [title, delivery] of [
        ['a11y building', { state: 'building' }],
        ['a11y deploy failed', { state: 'deploy_failed', deployment: { state: 'ROLLED_BACK' } }],
        ['a11y closed', { state: 'closed_without_deploy' }],
    ] as const) {
        const task = await createWorkTask(request, token, workId, { title });
        await seedTaskState(request, token, { taskId: task.id, delivery: { ...delivery } });
    }

    fixture = { workId, failed, live };
    return fixture;
}

/**
 * The locale is user state, not a path segment (`localePrefix: 'never'`: a prefixed path redirects
 * to the cookie's locale), so it is set through the `NEXT_LOCALE` cookie, as
 * `internationalization-rtl.spec.ts` does.
 */
async function useLocale(page: Page, locale: string, baseURL: string | undefined): Promise<void> {
    const origin = new URL(baseURL || 'http://localhost:3000').origin;
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: origin }]);
}

async function openTask(page: Page, taskId: string): Promise<Locator> {
    await gotoDashboard(page, `/tasks/${taskId}`);
    const section = page.locator(DELIVERY);
    await expect(section.getByTestId('task-delivery-timeline')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator(`${COST}:not([data-state="loading"])`)).toBeVisible({
        timeout: 30_000,
    });
    return section;
}

test.describe('APW-08 T52 — App Works accessibility', () => {
    test('the board: every delivery chip has its text, and no serious violation', async ({
        page,
        request,
    }) => {
        const { workId } = await ensureFixture(request);
        await gotoDashboard(page, `/en/works/${workId}/tasks`);
        await expect(page.getByTestId('work-tasks-app-header')).toBeVisible({ timeout: 45_000 });
        const chips = page.locator('main [data-testid="task-delivery-chip"]');
        await expect(chips.first()).toBeVisible({ timeout: 30_000 });
        // No colour-only state: every chip says its state in words.
        for (const chip of await chips.all()) {
            await expect(chip).toHaveText(/\p{L}{2,}/u);
        }
        await expectNoSeriousViolations(page, [
            '[data-testid="work-tasks-app-header"]',
            'main [data-testid="task-delivery-chip"]',
        ]);
    });

    test('a failed change: Delivery + Cost sections, the containment notice, keyboard walk', async ({
        page,
        request,
    }) => {
        const { failed } = await ensureFixture(request);
        const section = await openTask(page, failed.id);
        await expect(section.getByTestId('task-delivery-chip')).toHaveText(/^Build failed/);

        // FR-71 — the polite live region carries the chip's state.
        const announcer = page.getByTestId('task-delivery-announcer');
        await expect(announcer).toHaveAttribute('aria-live', 'polite');
        await expect(announcer).toHaveText(/^Build failed/);

        const notice = page.getByTestId('task-run-containment-notice');
        await expect(notice).toBeVisible();
        await expect(notice.getByTestId('task-containment-downgrade').first()).toContainText(
            'sandbox',
        );

        await expectNoSeriousViolations(page, [DELIVERY, COST]);
        const walked = await expectTabWalk(page, section, 'Delivery section');
        // Create a fix Task and Close anyway at least.
        expect(walked).toBeGreaterThanOrEqual(2);
    });

    test('Close anyway: the confirmation opens by keyboard, has no serious violation, Esc returns focus', async ({
        page,
        request,
    }) => {
        const { failed } = await ensureFixture(request);
        const section = await openTask(page, failed.id);
        const opener = section.getByTestId('task-delivery-close');
        await openByKeyboard(page, opener, page.getByTestId('task-delivery-confirm-close'));
        await expectFocusInsideDialog(page);
        await expectNoSeriousViolations(page, ['[role="dialog"]']);

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('task-delivery-confirm-close')).toHaveCount(0, {
            timeout: 10_000,
        });
        await expect(opener, 'focus returns to Close anyway').toBeFocused();
    });

    test('a live change: the Delivery section has no serious violation and walks by keyboard', async ({
        page,
        request,
    }) => {
        const { live } = await ensureFixture(request);
        const section = await openTask(page, live.id);
        await expect(section.getByTestId('task-delivery-live-url')).toHaveAttribute(
            'href',
            LIVE_URL,
        );
        await expect(page.getByTestId('task-delivery-announcer')).toHaveText(/^Live/);
        await expectNoSeriousViolations(page, [DELIVERY, COST]);
        await expectTabWalk(page, section, 'Delivery section (live)');
    });

    test('the Work overview: cost summary + Request a change dialog by keyboard, focus returns', async ({
        page,
        request,
    }) => {
        const { workId } = await ensureFixture(request);
        await gotoDashboard(page, `/en/works/${workId}`);
        const overview = page.getByTestId('app-work-overview');
        await expect(overview).toBeVisible({ timeout: 45_000 });
        const summary = page.getByTestId('work-cost-summary');
        await expect(summary).toBeVisible({ timeout: 30_000 });
        await expectNoSeriousViolations(page, [
            '[data-testid="app-work-overview"]',
            '[data-testid="work-cost-summary"]',
        ]);
        // The cost summary's controls (its Task links, when it lists any) walk by keyboard.
        if ((await summary.locator('a[href], button:not([disabled])').count()) > 0) {
            await expectTabWalk(page, summary, 'Work cost summary');
        }

        const opener = page.getByTestId('app-change-open');
        await openByKeyboard(page, opener, page.getByTestId('app-change-dialog'));
        await expectFocusInsideDialog(page);
        // The request field has its own label, and the dialog has no serious violation.
        const fieldId = await page.getByTestId('app-change-text').getAttribute('id');
        expect(fieldId, 'the request field has an id').toBeTruthy();
        await expect(page.locator(`label[for="${fieldId}"]`)).toHaveCount(1);
        await expectNoSeriousViolations(page, ['[role="dialog"]']);

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('app-change-dialog')).toHaveCount(0, { timeout: 10_000 });
        await expect(opener, 'focus returns to Request a change').toBeFocused();
    });

    for (const locale of ['ar', 'he']) {
        test(`${locale}: the page mirrors, no chip is clipped, no serious violation`, async ({
            page,
            request,
            baseURL,
        }) => {
            const { failed } = await ensureFixture(request);
            await useLocale(page, locale, baseURL);
            const section = await openTask(page, failed.id);
            await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
            expect(
                await section.evaluate((el) => getComputedStyle(el).direction),
                'the Delivery section lays out right to left',
            ).toBe('rtl');

            // No clipped chip: its text fits its box, and the box sits inside the section.
            const chip = section.getByTestId('task-delivery-chip');
            await expect(chip).toBeVisible();
            const fit = await chip.evaluate((el) => {
                const box = el.getBoundingClientRect();
                const host = el
                    .closest('[data-testid="task-delivery-section"]')!
                    .getBoundingClientRect();
                return {
                    overflow: el.scrollWidth - el.clientWidth,
                    inside: box.left >= host.left - 0.5 && box.right <= host.right + 0.5,
                };
            });
            expect(fit.overflow, 'the chip text is not cut off').toBeLessThanOrEqual(1);
            expect(fit.inside, 'the chip sits inside the section').toBe(true);

            // The containment list indents on the inline START side (right in RTL), so its
            // bullets are not pushed out of the card.
            const list = page.getByTestId('task-containment-downgrades');
            await expect(list).toBeVisible();
            const padding = await list.evaluate((el) => {
                const css = getComputedStyle(el);
                return { right: parseFloat(css.paddingRight), left: parseFloat(css.paddingLeft) };
            });
            expect(padding.right, 'the list indents on the right in RTL').toBeGreaterThan(0);
            expect(padding.left).toBe(0);

            await expectNoSeriousViolations(page, [DELIVERY, COST]);
        });
    }
});
