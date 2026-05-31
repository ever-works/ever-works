import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
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
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Organizations — create + switch via header', () => {
    test('create two orgs through the modal; both become selectable in the header switcher', async ({
        page,
        request,
        baseURL,
    }) => {
        const stamp = Date.now().toString(36);
        const alpha = `E2E Org Alpha ${stamp}`;
        const beta = `E2E Org Beta ${stamp}`;

        // Ensure the seeded user already owns ≥1 org so the UI creates below are
        // deterministically "2nd+" — they navigate straight to the new org's
        // slug URL rather than popping the first-org "Move your existing items?"
        // dialog (whose default branch hits a Postgres-only endpoint that 500s
        // on sqlite). The create+switch behaviour under test is identical either way.
        const token = await seededToken(request);
        if ((await listOrganizationsViaAPI(request, token)).length === 0) {
            await createOrganizationViaAPI(request, token, `E2E Org Seed ${stamp}`);
        }

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
        await page.waitForURL(new RegExp(`/${alphaSlug}(/|$)`), { timeout: 30_000 });
    });
});
