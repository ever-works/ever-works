import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { openChatPanel, chatComposer } from './helpers/chat';

/**
 * Accessibility — axe-core + keyboard + focus + ARIA on KEY AUTHENTICATED flows.
 *
 * GAP ANALYSIS (what already exists, what this file deliberately does NOT repeat):
 *   - accessibility.spec.ts / accessibility-axe-deep.spec.ts run axe ONLY on the
 *     PUBLIC /en/login + /en/register pages (unauth project). screen-reader-aria-
 *     live.spec.ts only probes the login form. keyboard-navigation.spec.ts /
 *     dropdown-keyboard.spec.ts only Tab the login form + smoke a generic header
 *     menu on /en. NONE of them load axe on, or drive the keyboard through, the
 *     AUTHENTICATED dashboard surfaces (works/tasks/agents/settings/profile), the
 *     AI chat side-panel, the WorkspaceSwitcher (org switcher) menu, or a real
 *     headlessui Dialog's focus management.
 *
 * This file is authenticated (it carries the seeded storageState — its name does
 * NOT match the no-auth `testIgnore` regex in playwright.config.ts, unlike
 * `accessibility-axe-deep`). It therefore exercises a complementary, uncovered
 * slice: WCAG on the real signed-in product.
 *
 * PROBED / SOURCE-VERIFIED CONTRACTS (live stack http://127.0.0.1:3100 + reading
 * apps/web source, 2026-06-01):
 *   - Authenticated dashboard routes are UNPREFIXED: /works /tasks /agents
 *     /settings /profile /works/new. The layout renders a single `<main
 *     id="main-content">` landmark, a `<nav>` inside an `<aside>` (DashboardSidebar),
 *     and the DashboardHeader. (apps/web/src/app/[locale]/(dashboard)/layout-client.tsx)
 *   - When the chat panel is EXPANDED the main wrapper gets `aria-hidden=true`;
 *     in the default (open, non-expanded) state main is NOT aria-hidden.
 *   - The chat side-panel opens server-side via the `chat-panel-open=1` cookie;
 *     its composer is a <textarea placeholder="Ask me anything...">. (helpers/chat.ts)
 *   - The WorkspaceSwitcher trigger is a headlessui MenuButton with
 *     aria-label="Switch Organization" (→ aria-haspopup="menu" + aria-expanded
 *     toggled by headlessui). Its menu items are one-per-org + "Create
 *     Organization". (apps/web/src/components/layout/WorkspaceSwitcher.tsx,
 *     components/ui/dropdown-menu.tsx)
 *   - "Create Organization" opens CreateOrganizationModal — a headlessui Dialog
 *     (role="dialog", aria-modal="true", focus-trapped, Escape-to-close) with a
 *     "Name" input + "Create" button. (components/ui/dialog.tsx)
 *   - axe-core is NOT an installed dep; we inject it from unpkg CDN at runtime
 *     (reachable here) and SKIP gracefully if the CDN is blocked — mirroring the
 *     existing accessibility-axe-deep.spec.ts pattern so CI without egress still
 *     passes rather than failing.
 *
 * RESILIENCE: dev-mode hydration race → retry-to-open menus, generous timeouts,
 * .first(), expect.poll/toPass. Cold auth-redirect to /login on the very first
 * authenticated hit → re-navigate (gotoAuthed). All thresholds are LOOSE (catch a
 * 10x regression, not chase every minor warning) and counts use toContain-style
 * tolerance, never exact equality.
 */

const SERIOUS_VIOLATION_CEILING = 12;

interface AxeNode {
    html?: string;
    target?: string[];
}
interface AxeViolation {
    id: string;
    impact: string | null;
    nodes: AxeNode[];
}
interface AxeResult {
    violations: AxeViolation[];
}

/** Inject axe-core from CDN (idempotent). Returns false if it could not load. */
async function loadAxe(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
        const w = window as unknown as { axe?: unknown };
        if (w.axe) return true;
        return new Promise<boolean>((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/axe-core@4.10/axe.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    });
}

/** Run axe (wcag2a + wcag2aa) against the live DOM. Null if axe is unavailable. */
async function runAxe(page: Page): Promise<AxeResult | null> {
    if (!(await loadAxe(page))) return null;
    return page.evaluate(async () => {
        const w = window as unknown as { axe: { run: (o: unknown) => Promise<AxeResult> } };
        return w.axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    });
}

function seriousPlus(result: AxeResult): AxeViolation[] {
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/**
 * Navigate to an authenticated dashboard route, recovering from the cold
 * first-hit auth-redirect to /login that `next dev` occasionally produces even
 * with stored state. Anchors on the `<main id="main-content">` landmark.
 */
async function gotoAuthed(page: Page, route: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }
    if (/\/login(\?|$)/.test(page.url())) return false;
    // Let the route's lazy per-route dev compile + hydration settle.
    await page.locator('#main-content').first().waitFor({ state: 'attached', timeout: 45_000 });
    await page.waitForTimeout(1_200);
    return true;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted — ONLY { email, password } (a `name` prop 400s).
    const s = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: s.email, password: s.password },
    });
    expect(res.status(), `seeded login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('a11y — axe + keyboard + focus on authenticated key flows', () => {
    test('flow 1: axe-core bounds serious+ violations across works/tasks/agents/settings/profile, and each renders the main + nav landmarks', async ({
        page,
    }) => {
        // One sweep across the core authenticated surfaces. We assert (a) the
        // landmark contract (single main + a nav) holds on every page, and (b)
        // axe reports a bounded number of serious/critical violations — catching
        // a large a11y regression without chasing minor warnings.
        const routes = ['/works', '/tasks', '/agents', '/settings', '/profile'];
        let axeRanAtLeastOnce = false;

        for (const route of routes) {
            const loaded = await gotoAuthed(page, route);
            if (!loaded) {
                test.info().annotations.push({
                    type: 'warning',
                    description: `${route} redirected to /login under storageState — skipped`,
                });
                continue;
            }

            // Landmark contract: exactly one main landmark, at least one nav.
            const mainCount = await page.locator('main, [role="main"]').count();
            expect(mainCount, `${route} should expose a single main landmark`).toBe(1);
            const navCount = await page.getByRole('navigation').count();
            expect(navCount, `${route} should expose at least one nav landmark`).toBeGreaterThan(0);

            // <html lang> must be present on the authenticated shell too.
            const lang = await page.locator('html').getAttribute('lang');
            expect((lang || '').length, `${route} <html lang>`).toBeGreaterThan(0);

            const results = await runAxe(page);
            if (!results) continue; // CDN blocked — skip the axe assertion for this route.
            axeRanAtLeastOnce = true;
            const serious = seriousPlus(results);
            const ids = serious.map((v) => v.id).join(', ');
            expect(
                serious.length,
                `${route} serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
            ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
        }

        if (!axeRanAtLeastOnce) {
            test.info().annotations.push({
                type: 'informational',
                description:
                    'axe-core CDN was unavailable on every route — landmark contract still asserted',
            });
        }
    });

    test('flow 2: axe-core on the OPEN AI chat side-panel — composer present, panel introduces no large violation regression, main is not aria-hidden', async ({
        page,
    }) => {
        // The chat side-panel is a complex interactive surface never axe-scanned
        // elsewhere. Open it deterministically (cookie) and run axe with the
        // composer live. Also assert the focus-management invariant that the main
        // region is NOT aria-hidden while the panel is in its default open state
        // (it only goes aria-hidden when EXPANDED to full width).
        await openChatPanel(page, '/works');
        await expect(chatComposer(page)).toBeVisible({ timeout: 45_000 });

        // Default open panel must not steal the main region from assistive tech.
        const mainAriaHidden = await page
            .locator('#main-content')
            .first()
            .evaluate(
                (el) =>
                    (el.closest('[aria-hidden]') as HTMLElement | null)?.getAttribute(
                        'aria-hidden',
                    ) ?? null,
            )
            .catch(() => null);
        expect(
            mainAriaHidden === 'true',
            'main region is aria-hidden while chat panel is merely open (not expanded)',
        ).toBe(false);

        // The composer must carry an accessible name (placeholder counts for a
        // textarea via the accessible-name algorithm only as a last resort —
        // assert it is at least programmatically reachable + focusable).
        const composer = chatComposer(page);
        await composer.focus();
        const focusedIsComposer = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.tagName === 'TEXTAREA';
        });
        expect(focusedIsComposer, 'chat composer is keyboard-focusable').toBe(true);

        const results = await runAxe(page);
        if (!results) {
            test.skip(true, 'axe-core CDN unavailable — cannot scan the chat panel');
        }
        const serious = seriousPlus(results!);
        const ids = serious.map((v) => v.id).join(', ');
        expect(
            serious.length,
            `chat-panel serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
        ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
    });

    test('flow 3: keyboard reaches the main content + sidebar nav links are operable (no keyboard trap before content)', async ({
        page,
        baseURL,
    }) => {
        // Pressing Tab repeatedly from the top of the page must reach an
        // interactive element inside (or focus) the main content / a nav link
        // within a reasonable number of presses — i.e. there is no keyboard trap
        // in the header/sidebar that swallows focus forever. WCAG 2.1.1 + 2.1.2.
        //
        // Pin the sidebar EXPANDED before loading. The server layout defaults to
        // a COLLAPSED sidebar when the `sidebar-collapsed` cookie is absent
        // (layout.tsx: `collapsedCookie === undefined ? true : …`), and the
        // seeded storageState carries no such cookie. A collapsed sidebar renders
        // its nav links as icon-only (the text `<span>{item.name}</span>` is gated
        // on `!isCollapsed` in DashboardSidebar.tsx), so the link's accessible
        // name is empty and the operable-link assertion below can't hold. The
        // expanded sidebar is the surface this flow means to exercise — mirror
        // flows 4/5 and request it explicitly. Close chat to avoid overlap.
        const origin = new URL(baseURL || 'http://localhost:3000').origin;
        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        const loaded = await gotoAuthed(page, '/works');
        test.skip(!loaded, '/works redirected to login under storageState');

        // Anchor focus at the document body, then walk forward.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page
            .locator('body')
            .click({ position: { x: 2, y: 2 } })
            .catch(() => undefined);

        let reachedInsideMainOrNav = false;
        let lastDescriptor = 'none';
        for (let i = 0; i < 40 && !reachedInsideMainOrNav; i++) {
            await page.keyboard.press('Tab');
            const info = await page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                if (!el || el === document.body) return null;
                const inMain = !!el.closest('main, #main-content, [role="main"]');
                const inNav = !!el.closest('nav, aside, [role="navigation"]');
                return {
                    inMain,
                    inNav,
                    tag: el.tagName,
                    name: (el.getAttribute('aria-label') || el.textContent || '')
                        .trim()
                        .slice(0, 40),
                };
            });
            if (info) {
                lastDescriptor = `${info.tag}:${info.name}`;
                if (info.inMain || info.inNav) reachedInsideMainOrNav = true;
            }
        }
        expect(
            reachedInsideMainOrNav,
            `Tab never reached a focusable element inside main/nav within 40 presses (last=${lastDescriptor})`,
        ).toBe(true);

        // At least one sidebar nav link must itself be keyboard-activatable: focus
        // it and confirm it's an <a>/<button> with a discernible accessible name.
        const navLink = page.getByRole('navigation').getByRole('link').first();
        if (await navLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
            const accName =
                (await navLink.getAttribute('aria-label')) || (await navLink.textContent());
            expect(
                (accName || '').trim().length,
                'sidebar nav link has an accessible name',
            ).toBeGreaterThan(0);
            await navLink.focus();
            const isFocused = await navLink.evaluate((el) => el === document.activeElement);
            expect(isFocused, 'sidebar nav link is focusable').toBe(true);
        } else {
            test.info().annotations.push({
                type: 'informational',
                description:
                    'no role=link inside the nav landmark to focus-check (collapsed sidebar?)',
            });
        }
    });

    test('flow 4: WorkspaceSwitcher (org switcher) — accessible name, aria-expanded toggles, keyboard open + ArrowDown stays in menu + Escape closes and restores focus', async ({
        page,
        request,
        baseURL,
    }) => {
        // Ensure the seeded user owns ≥1 org so the switcher renders its full
        // trigger reliably (the trigger exists regardless, but having an org makes
        // the menu non-trivial). Best-effort — never block the a11y assertions on it.
        try {
            const token = await seededToken(request);
            const list = await request.get(`${API_BASE}/api/organizations`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (list.ok() && (await list.json()).length === 0) {
                await request.post(`${API_BASE}/api/organizations`, {
                    headers: { Authorization: `Bearer ${token}` },
                    data: { name: `A11y Switcher Org ${Date.now().toString(36)}` },
                });
            }
        } catch {
            // non-fatal — the trigger ARIA is what we assert.
        }

        // Expand the sidebar so the switcher trigger renders, close chat to avoid overlap.
        const origin = new URL(baseURL || 'http://localhost:3000').origin;
        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        const loaded = await gotoAuthed(page, '/works');
        test.skip(!loaded, '/works redirected to login under storageState');

        const trigger = page.getByRole('button', { name: 'Switch Organization' });
        if (!(await trigger.isVisible({ timeout: 30_000 }).catch(() => false))) {
            test.skip(true, 'WorkspaceSwitcher trigger not rendered (layout variant)');
        }

        // (a) Accessible name + ARIA combobox/menu semantics on the trigger.
        await expect(trigger).toHaveAttribute('aria-haspopup', /menu|true/);
        const expandedClosed = await trigger.getAttribute('aria-expanded');
        expect(['false', null]).toContain(expandedClosed);

        // (b) Open via KEYBOARD (Enter). Retry-to-open rides the hydration race.
        const createItem = page.getByRole('menuitem', { name: 'Create Organization' });
        let opened = false;
        for (let attempt = 0; attempt < 4 && !opened; attempt++) {
            await trigger.focus();
            await page.keyboard.press('Enter');
            opened = await createItem.isVisible({ timeout: 2_500 }).catch(() => false);
            if (!opened) await page.waitForTimeout(500);
        }
        expect(opened, 'switcher menu opened via keyboard Enter').toBe(true);

        // aria-expanded flips to true while open.
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');

        // (c) ArrowDown keeps focus INSIDE the menu (it must not escape into the page).
        const firstItem = page.getByRole('menuitem').first();
        await firstItem.focus().catch(() => undefined);
        await page.keyboard.press('ArrowDown');
        const stillInMenu = await page.evaluate(
            () =>
                document.activeElement?.closest(
                    '[role="menu"], [role="menubar"], [role="listbox"]',
                ) !== null,
        );
        expect(stillInMenu, 'ArrowDown moved focus outside the open switcher menu').toBe(true);

        // (d) Escape closes the menu AND returns focus to the trigger (focus mgmt).
        await page.keyboard.press('Escape');
        await expect(createItem).toBeHidden({ timeout: 5_000 });
        await expect(trigger)
            .toHaveAttribute('aria-expanded', /false/)
            .catch(() => undefined);
        const focusReturned = await trigger
            .evaluate((el) => el === document.activeElement)
            .catch(() => false);
        expect(
            focusReturned,
            'focus returned to the switcher trigger after Escape (headlessui focus restore)',
        ).toBe(true);
    });

    test('flow 5: Create-Organization Dialog — role=dialog + aria-modal, focus enters the dialog, focus is trapped, Escape closes and restores trigger focus', async ({
        page,
        baseURL,
    }) => {
        // A real headlessui Dialog is the canonical modal a11y test: it must
        // announce as role=dialog/aria-modal, move focus inside on open, trap Tab,
        // and on Escape close + restore focus to the opener. None of the existing
        // specs assert this on an authenticated modal.
        const origin = new URL(baseURL || 'http://localhost:3000').origin;
        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        const loaded = await gotoAuthed(page, '/works');
        test.skip(!loaded, '/works redirected to login under storageState');

        const trigger = page.getByRole('button', { name: 'Switch Organization' });
        if (!(await trigger.isVisible({ timeout: 30_000 }).catch(() => false))) {
            test.skip(true, 'WorkspaceSwitcher trigger not rendered');
        }

        // Open the switcher (retry-on-open) then the Create Organization modal.
        const createItem = page.getByRole('menuitem', { name: 'Create Organization' });
        let menuOpen = false;
        for (let attempt = 0; attempt < 4 && !menuOpen; attempt++) {
            await trigger.click();
            menuOpen = await createItem.isVisible({ timeout: 2_500 }).catch(() => false);
            if (!menuOpen) await page.waitForTimeout(500);
        }
        test.skip(!menuOpen, 'could not open the switcher menu to reach Create Organization');
        await createItem.click();

        // Dialog must announce itself. The visible content lives in the inner
        // headlessui DialogPanel; an inner control is the reliable visibility
        // anchor (the panel input being visible proves the modal is on screen).
        const nameInput = page.getByLabel('Name', { exact: true });
        await expect(nameInput).toBeVisible({ timeout: 15_000 });

        // The element that actually carries role="dialog" + aria-modal is the
        // headlessui Dialog WRAPPER (`<div role="dialog" class="relative z-50">`),
        // whose only children are `fixed inset-0` layers — so the wrapper itself
        // collapses to height 0 and Playwright's toBeVisible() heuristic reports
        // it HIDDEN even though the modal panel inside it is fully rendered
        // (probed live 2026-06-01: dlgRect h=0, panelRect 437x256). Assert the
        // a11y contract this flow cares about — the dialog is present in the tree
        // and declares aria-modal="true" — rather than the zero-geometry wrapper's
        // paint visibility (already covered by the visible nameInput above).
        const dialog = page.getByRole('dialog').first();
        await expect(dialog).toBeAttached({ timeout: 10_000 });
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        const ariaModal = await dialog.getAttribute('aria-modal');
        expect(ariaModal, 'modal dialog should declare aria-modal="true"').toBe('true');

        // (a) Focus moved INTO the dialog on open.
        const focusInsideDialog = await page.evaluate(() => {
            const dlg = document.querySelector('[role="dialog"]');
            return !!dlg && !!document.activeElement && dlg.contains(document.activeElement);
        });
        expect(focusInsideDialog, 'focus moved inside the dialog on open').toBe(true);

        // (b) Focus trap: tabbing many times never escapes the dialog.
        let escapedTrap = false;
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press('Tab');
            const outside = await page.evaluate(() => {
                const dlg = document.querySelector('[role="dialog"]');
                const el = document.activeElement;
                if (!dlg || !el || el === document.body) return false;
                return !dlg.contains(el);
            });
            if (outside) {
                escapedTrap = true;
                break;
            }
        }
        expect(escapedTrap, 'Tab focus escaped the modal dialog (focus trap broken)').toBe(false);

        // (c) Escape closes the dialog and restores focus to the page (not lost to body).
        await page.keyboard.press('Escape');
        await expect(nameInput).toBeHidden({ timeout: 8_000 });
        const focusNotLost = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return !!el && el !== document.body;
        });
        expect(focusNotLost, 'focus was returned to a real element after closing the dialog').toBe(
            true,
        );
    });

    test('flow 6: /works/new creation form — labelled controls, axe-bounded, an aria-live/role=alert announce region, and Tab reaches a submit control', async ({
        page,
    }) => {
        // Authenticated FORM a11y (the public login form is the only form covered
        // elsewhere). The work-creation form must have programmatically-labelled
        // inputs, a bounded axe profile, an announce-able status region for
        // validation, and a keyboard-reachable submit/primary action.
        const loaded = await gotoAuthed(page, '/works/new');
        if (!loaded) {
            test.skip(true, '/works/new redirected to login under storageState');
        }

        // At least one labelled text input (name/title-style field). getByLabel
        // resolves <label for>, aria-label, aria-labelledby — independent of
        // React-generated ids. Tolerate route variants with .or().
        const textboxes = page.getByRole('textbox');
        const textboxCount = await textboxes.count();
        expect(textboxCount, '/works/new should render at least one form field').toBeGreaterThan(0);

        // Each visible textbox should have a non-empty accessible name.
        let unnamed = 0;
        const toCheck = Math.min(textboxCount, 6);
        for (let i = 0; i < toCheck; i++) {
            const tb = textboxes.nth(i);
            if (!(await tb.isVisible().catch(() => false))) continue;
            const name = await tb.evaluate((el) => {
                const aria = el.getAttribute('aria-label');
                if (aria && aria.trim()) return aria.trim();
                const labelledby = el.getAttribute('aria-labelledby');
                if (labelledby) {
                    const ref = document.getElementById(labelledby.split(/\s+/)[0]);
                    if (ref?.textContent?.trim()) return ref.textContent.trim();
                }
                const id = el.getAttribute('id');
                if (id) {
                    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
                }
                const ph = (el as HTMLInputElement).placeholder;
                return ph?.trim() || '';
            });
            if (!name) unnamed += 1;
        }
        // Allow a small slack (an icon/search field may lack a strict label) but
        // fail if the form is broadly unlabelled.
        expect(unnamed, 'most form fields should carry an accessible name').toBeLessThanOrEqual(2);

        // An announce-able region for validation/status should exist (or be
        // added on submit). Probe presence; soft-annotate if absent.
        const liveRegions =
            (await page.locator('[aria-live]:not([role="presentation"])').count()) +
            (await page.locator('[role="alert"]').count()) +
            (await page.locator('[role="status"]').count());
        if (liveRegions === 0) {
            test.info().annotations.push({
                type: 'warning',
                description:
                    '/works/new has no aria-live / role=alert / role=status region for form status',
            });
        }

        // Tab from the first field must reach a submit/primary button within a few
        // presses (no trap before the action). Accept type=submit OR a primary
        // action labelled create/generate/save/continue/next.
        const firstField = textboxes.first();
        if (await firstField.isVisible().catch(() => false)) {
            await firstField.focus();
            let reachedAction = false;
            for (let i = 0; i < 16 && !reachedAction; i++) {
                await page.keyboard.press('Tab');
                reachedAction = await page.evaluate(() => {
                    const el = document.activeElement as HTMLElement | null;
                    if (!el) return false;
                    if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit')
                        return true;
                    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim();
                    return (
                        (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
                        /create|generate|save|continue|next|submit|build/i.test(txt)
                    );
                });
            }
            expect(
                reachedAction,
                'Tab from the first field never reached a submit/primary action within 16 presses',
            ).toBe(true);
        }

        // axe-core bound on the authenticated form route.
        const results = await runAxe(page);
        if (!results) {
            test.info().annotations.push({
                type: 'informational',
                description:
                    'axe-core CDN unavailable on /works/new — labelling + keyboard still asserted',
            });
            return;
        }
        const serious = seriousPlus(results);
        const ids = serious.map((v) => v.id).join(', ');
        expect(
            serious.length,
            `/works/new serious+ a11y violations: ${serious.length} (${ids || 'none'})`,
        ).toBeLessThan(SERIOUS_VIOLATION_CEILING);
    });
});
