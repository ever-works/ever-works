import { test, expect, type BrowserContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';
import {
    createOrganizationViaAPI,
    createOrganizationViaUI,
    selectOrganizationInSwitcher,
    listOrganizationsViaAPI,
    expectOrgListedInSwitcher,
    gotoDashboardWithSwitcher,
} from './helpers/organizations';

/**
 * Organizations — real create + header-switcher integration flow.
 *
 * User ask: "when a new Organization is created, the user can switch to it in
 * the site header." This drives the real WorkspaceSwitcher end-to-end: create
 * two orgs through the modal and confirm both become selectable entries in the
 * header switcher (the "switch" affordance), cross-checked against
 * GET /api/organizations. Selecting an org routes to its slug-scoped URL.
 *
 * Scope notes:
 *  - Creating the first Organization runs a tenantId backfill that used
 *    Postgres-only `$n` placeholders → 500 under the sqlite e2e DB. Fixed in
 *    organization.service.ts (query-builder placeholders); without it this
 *    flow is impossible on the e2e stack.
 *  - The slug-scoped dashboard page (`/{slug}/dashboard`) is Phase-7-pending
 *    web-side (see apps/web/src/lib/hooks/use-active-scope.ts), so we assert
 *    the switcher LISTS + routes to each org, not the destination page.
 *  - Runs as a FRESH, isolated user (its own empty-storageState context) rather
 *    than the shared seeded storageState user. The header WorkspaceSwitcher
 *    lists EVERY org the current user owns in a single `overflow-hidden`,
 *    fixed-position headlessui menu with no scroll (WorkspaceSwitcher.tsx +
 *    ui/dropdown-menu.tsx). Across a full sharded run the seeded user
 *    accumulates dozens of orgs from sibling org specs, which pushes the
 *    trailing "Create Organization" item below the viewport fold — where its
 *    (config has no `actionTimeout`, so untimed) click never becomes
 *    actionable and hangs to the 120s test timeout. A dedicated user keeps the
 *    switcher bounded to the three orgs THIS test creates, so the item is
 *    always reachable.
 */

test.describe('Organizations — create + switch via header', () => {
    test('create two orgs through the modal; both become selectable in the header switcher', async ({
        browser,
        request,
        baseURL,
    }) => {
        // Modal create + header-switch drives several first-hit dashboard +
        // slug-scoped routes, each cold-compiling under Next.js dev mode in
        // CI — budget generously so the slug navigation below doesn't race it.
        test.setTimeout(120_000);
        const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const alpha = `E2E Org Alpha ${stamp}`;
        const beta = `E2E Org Beta ${stamp}`;

        // Fresh, isolated user — see the file docblock for why (bounded switcher
        // menu so the "Create Organization" item can never fall below the fold).
        const fresh = await registerUserViaAPI(request);
        const token = fresh.access_token;

        // A brand-new user with zero works trips the dashboard's auto-open
        // onboarding wizard, whose modal portal intercepts clicks and covers the
        // header switcher. Mark onboarding dismissed server-side BEFORE the UI
        // login (mirrors global-setup for the seeded user) so the post-login
        // render reads `dismissedAt` and the wizard stays closed. Best-effort: a
        // 404 on older API builds is harmless.
        await request
            .post(`${API_BASE}/api/onboarding/dismiss`, { headers: authedHeaders(token) })
            .catch(() => {});

        // Pre-seed one org via API so the two UI creates below are
        // deterministically "2nd+" — they navigate straight to the new org's
        // slug URL rather than popping the first-org "Move your existing items?"
        // dialog (whose default branch hits a Postgres-only endpoint that 500s
        // on sqlite). The create+switch behaviour under test is identical either way.
        await createOrganizationViaAPI(request, token, `E2E Org Seed ${stamp}`);

        // Sign the fresh user into its OWN isolated browser context (empty
        // storageState so it doesn't inherit the seeded auth cookie).
        const context: BrowserContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();
        try {
            // UI auth is cookie-based (Better Auth) — log the fresh user in via the form.
            await loginViaUI(page, { email: fresh.email, password: fresh.password });

            // 1. Create the first org through the header → modal flow.
            await gotoDashboardWithSwitcher(page, baseURL);
            await createOrganizationViaUI(page, alpha);

            // 2. Back on a built dashboard route, the new org is selectable in the header.
            await gotoDashboardWithSwitcher(page, baseURL);
            await expectOrgListedInSwitcher(page, alpha);

            // 3. Create a second org the same way.
            await createOrganizationViaUI(page, beta);
            await gotoDashboardWithSwitcher(page, baseURL);

            // 4. Both orgs are now selectable in the header switcher.
            await expectOrgListedInSwitcher(page, alpha);
            await expectOrgListedInSwitcher(page, beta);

            // 5. Both orgs are persisted server-side for this user.
            const names = (await listOrganizationsViaAPI(request, token)).map((o) => o.displayName);
            expect(names).toContain(alpha);
            expect(names).toContain(beta);

            // 6. Selecting an org from the header routes to that org's slug-scoped URL.
            await selectOrganizationInSwitcher(page, alpha);
            const alphaSlug = (await listOrganizationsViaAPI(request, token)).find(
                (o) => o.displayName === alpha,
            )?.slug;
            expect(alphaSlug, 'alpha should have a slug').toBeTruthy();
            // Client soft-nav (router.push) — poll the URL rather than waiting on a
            // load event.
            await expect(page).toHaveURL(new RegExp(`/${alphaSlug}(/|$)`), { timeout: 90_000 });
        } finally {
            await context.close();
        }
    });
});
