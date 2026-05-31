import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * Organizations / Tenants helpers.
 *
 * Verified against a live stack (sqlite in-memory, the e2e DB driver):
 *   - POST /api/organizations { name }            → 201 { id, tenantId, slug, displayName, registrationStatus, ... }
 *   - GET  /api/organizations                      → bare array of the above
 *
 * UI (apps/web/src/components/layout/WorkspaceSwitcher.tsx):
 *   - The switcher is a headlessui Menu. Its trigger now carries
 *     aria-label "Switch Organization" (dropdown-menu.tsx forwards aria-label
 *     — previously dropped, so the trigger had no accessible name).
 *   - Dropdown items: one per org (labelled by displayName) + a
 *     "Create Organization" item. The active org's row carries a Check icon
 *     with aria-label "Active organization".
 *   - "Create Organization" opens CreateOrganizationModal (name input label
 *     "Name", submit "Create"). The FIRST org also shows the
 *     "Move your existing items?" dialog — we pick "Start empty" → "Continue"
 *     (the default "Move existing items" hits a Postgres-only endpoint that
 *     500s on sqlite). 2nd+ orgs skip it and navigate to /{slug}/dashboard.
 */

export interface Organization {
    id: string;
    tenantId: string;
    slug: string;
    displayName: string;
    registrationStatus?: string;
}

export async function createOrganizationViaAPI(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<Organization> {
    const res = await request.post(`${API_BASE}/api/organizations`, {
        headers: authedHeaders(token),
        data: { name },
    });
    if (!res.ok()) {
        throw new Error(`createOrganizationViaAPI failed (${res.status()}): ${await res.text()}`);
    }
    return res.json();
}

export async function listOrganizationsViaAPI(
    request: APIRequestContext,
    token: string,
): Promise<Organization[]> {
    const res = await request.get(`${API_BASE}/api/organizations`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list orgs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/**
 * Navigate to a dashboard route with the sidebar expanded (so the
 * WorkspaceSwitcher renders its full trigger) and the chat panel closed (so
 * it doesn't overlap clicks). Cookies are read server-side by the dashboard
 * layout, so they must be set before navigation.
 */
export async function gotoDashboardWithSwitcher(
    page: Page,
    baseURL: string | undefined,
    route = '/works',
): Promise<void> {
    const origin = new URL(baseURL || 'http://localhost:3000').origin;
    await page.context().addCookies([
        { name: 'sidebar-collapsed', value: '0', url: origin },
        { name: 'chat-panel-open', value: '0', url: origin },
    ]);
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(switcherTrigger(page)).toBeVisible({ timeout: 30_000 });
}

function switcherTrigger(page: Page) {
    return page.getByRole('button', { name: 'Switch Organization' });
}

/** Open the organization switcher dropdown (retry-on-open to ride out the
 * dev-mode hydration race where the first click lands before the headlessui
 * menu is interactive). */
export async function openWorkspaceSwitcher(page: Page): Promise<void> {
    const trigger = switcherTrigger(page);
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    const createItem = page.getByRole('menuitem', { name: 'Create Organization' });
    for (let attempt = 0; attempt < 4; attempt++) {
        await trigger.click();
        if (await createItem.isVisible({ timeout: 2_500 }).catch(() => false)) return;
        await page.waitForTimeout(500);
    }
    await expect(createItem).toBeVisible({ timeout: 10_000 });
}

/**
 * Create an Organization through the UI switcher → modal flow. Handles the
 * first-org "Start empty" branch and the 2nd+-org direct-navigation branch.
 * Returns once the browser lands on the new org's /{slug}/dashboard.
 */
export async function createOrganizationViaUI(page: Page, name: string): Promise<void> {
    await openWorkspaceSwitcher(page);
    await page.getByRole('menuitem', { name: 'Create Organization' }).click();

    const nameInput = page.getByLabel('Name', { exact: true });
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(name);

    await page.waitForTimeout(600); // let the debounced slug check settle
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const emptyOption = page.getByText('Start empty', { exact: false });
    if (await emptyOption.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await emptyOption.click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }

    await page.waitForURL(/\/[^/]+\/dashboard(\?|$)/, { timeout: 30_000 });
}

/**
 * Select an existing Organization from the switcher dropdown. The switcher
 * routes to the org's slug-scoped URL (`/{slug}/…`). NB: the slug-scoped
 * dashboard page itself is Phase-7-pending web-side (see use-active-scope.ts),
 * so callers should assert the URL slug, not the destination page content.
 */
export async function selectOrganizationInSwitcher(page: Page, displayName: string): Promise<void> {
    await openWorkspaceSwitcher(page);
    await page.getByRole('menuitem', { name: displayName }).first().click();
}

/**
 * Open the switcher and assert the given org is present and selectable in the
 * header dropdown. Leaves the dropdown closed.
 */
export async function expectOrgListedInSwitcher(page: Page, displayName: string): Promise<void> {
    await openWorkspaceSwitcher(page);
    await expect(page.getByRole('menuitem', { name: displayName }).first()).toBeVisible({
        timeout: 10_000,
    });
    await page.keyboard.press('Escape');
}
