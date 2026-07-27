import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, apiUrl, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

/**
 * Onboarding — Communication step connects IN PLACE + the wizard's
 * "What do you do" answers persist at ORGANIZATION level.
 *
 * Audit items (b) and A53.
 *
 * (b) The Slack card used to be a link OUT to `/plugins/slack-connector`,
 *     which threw the user out of the wizard mid-flow. It now expands an
 *     inline panel carrying the connector's own settings form plus an
 *     Enable action wired to the existing `enablePlugin` server action.
 *
 * A53 `PATCH /api/onboarding/state { state: { profile } }` now mirrors the
 *     answers onto `organization_onboarding_profiles` for the request's
 *     resolved organization scope and echoes them back as
 *     `organizationProfile`.
 *
 * Environment-adaptive by design (house rule): `slack-connector` ships
 * with `distribution: "registry"`, so a given image may or may not have
 * it loaded. The UI test asserts the in-place panel when the connector is
 * present and the (still-supported) settings link when it is not — what
 * it never tolerates is a navigation away from the wizard.
 */

const SLACK_PLUGIN_ID = 'slack-connector';
const DISCORD_PLUGIN_ID = 'discord-connector';

interface CatalogResponse {
    plugins: Array<{ pluginId: string }>;
}

interface StateResponse {
    completedAt: string | null;
    dismissedAt: string | null;
    state: { profile?: { roles?: string[]; teamSize?: string } };
    organizationProfile?: { roles?: string[]; teamSize?: string } | null;
}

async function getState(
    request: APIRequestContext,
    token: string,
    scopeSlug?: string,
): Promise<StateResponse> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    const res = await request.get(apiUrl('/api/onboarding/state'), { headers });
    expect(res.status(), `GET state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function patchProfile(
    request: APIRequestContext,
    token: string,
    profile: { roles?: string[]; teamSize?: string },
    scopeSlug?: string,
): Promise<StateResponse> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    const res = await request.patch(apiUrl('/api/onboarding/state'), {
        headers,
        data: { state: { profile } },
    });
    expect(res.status(), `PATCH state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Onboarding — Communication step connects in place (audit item b)', () => {
    let token: string;

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        try {
            const user = await registerUserViaAPI(ctx, {});
            token = user.access_token;
        } finally {
            await ctx.dispose();
        }
    });

    test('the connectors owned by the Communication step are not ALSO offered as generic plugin cards', async ({
        request,
    }) => {
        const res = await request.get(apiUrl('/api/onboarding/catalog'), {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const catalog = (await res.json()) as CatalogResponse;

        const ids = (catalog.plugins ?? []).map((p) => p.pluginId);
        expect(ids).not.toContain(SLACK_PLUGIN_ID);
        expect(ids).not.toContain(DISCORD_PLUGIN_ID);
    });

    test('UI: the Slack card connects inside the wizard instead of navigating to Settings', async ({
        page,
    }) => {
        // The standalone /onboarding route force-opens the wizard for an
        // authenticated user (onboarding-page-client.tsx), which is far more
        // deterministic than the dashboard's auto-open heuristics.
        await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Get started with Ever Works')).toBeVisible({
            timeout: 45_000,
        });

        // Jump to the Communication step via its SideNav entry. Retry-to-open
        // rides out the dev-mode hydration race (the first click can land
        // before the dialog is interactive).
        const communicationNav = page.getByRole('button', { name: 'Communication' });
        const connectAction = page.getByTestId('onboarding-communication-connect-slack');
        await expect(async () => {
            await communicationNav.click();
            await expect(connectAction).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 45_000 });

        // The Discord coming-soon chip still renders — the step is additive.
        await expect(page.getByTestId('onboarding-communication-discord-soon')).toBeVisible();

        const urlBefore = page.url();
        const isInPlace = (await connectAction.evaluate((el) => el.tagName)) === 'BUTTON';

        if (isInPlace) {
            // Connector present in this image → connect WITHOUT leaving the wizard.
            await expect(connectAction).toHaveAttribute('aria-expanded', 'false');
            await connectAction.click();

            const panel = page.getByTestId('onboarding-communication-slack-panel');
            await expect(panel).toBeVisible({ timeout: 15_000 });
            // The enable affordance lives inside the panel (or the "already
            // connected" badge when the plugin is enabled for this user).
            await expect(
                page
                    .getByTestId('onboarding-communication-slack-enable')
                    .or(page.getByTestId('onboarding-communication-slack-enabled'))
                    .first(),
            ).toBeVisible({ timeout: 15_000 });
            // The advanced-settings escape hatch is kept, as a secondary link.
            await expect(
                page.getByTestId('onboarding-communication-slack-settings-link'),
            ).toHaveAttribute('href', new RegExp(`/plugins/${SLACK_PLUGIN_ID}$`));

            // Collapsing puts the card back — still no navigation.
            await connectAction.click();
            await expect(panel).toBeHidden({ timeout: 10_000 });
        } else {
            // Connector absent (registry-distributed) → the pre-existing
            // degraded path: a link to the plugin's settings page.
            await expect(connectAction).toHaveAttribute(
                'href',
                new RegExp(`/plugins/${SLACK_PLUGIN_ID}$`),
            );
        }

        // Either way the wizard stayed put: no step ever navigates the browser.
        expect(page.url()).toBe(urlBefore);
        await expect(page.getByText('Get started with Ever Works')).toBeVisible();
    });
});

test.describe('Onboarding profile persists at organization level (A53)', () => {
    test('PATCH mirrors the answers onto the request-scoped organization', async ({ request }) => {
        const user = await registerUserViaAPI(request, {});
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Comms Org ${Date.now().toString(36)}`,
        );

        const patched = await patchProfile(
            request,
            user.access_token,
            { roles: ['marketing', 'sales'], teamSize: 'small-2-10' },
            org.slug,
        );

        // Per-user answers still persist (unchanged behaviour) …
        expect(patched.state.profile).toEqual({
            roles: ['marketing', 'sales'],
            teamSize: 'small-2-10',
        });
        // … and are now ALSO readable at organization level.
        expect(patched.organizationProfile).toEqual({
            roles: ['marketing', 'sales'],
            teamSize: 'small-2-10',
        });

        const reread = await getState(request, user.access_token, org.slug);
        expect(reread.organizationProfile).toEqual({
            roles: ['marketing', 'sales'],
            teamSize: 'small-2-10',
        });
    });

    test('a roles-only patch keeps the organization team size (field-level merge)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {});
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Comms Org ${Date.now().toString(36)}b`,
        );

        await patchProfile(
            request,
            user.access_token,
            { roles: ['product'], teamSize: 'mid-11-50' },
            org.slug,
        );
        const second = await patchProfile(
            request,
            user.access_token,
            { roles: ['engineering'] },
            org.slug,
        );

        expect(second.organizationProfile).toEqual({
            roles: ['engineering'],
            teamSize: 'mid-11-50',
        });
    });

    test('unknown role ids are still rejected with a 400 (org write must not widen the contract)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {});
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Comms Org ${Date.now().toString(36)}c`,
        );

        const res = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: { ...authedHeaders(user.access_token), 'X-Scope-Slug': org.slug },
            data: { state: { profile: { roles: ['astronaut'] } } },
        });
        expect(res.status()).toBe(400);
    });

    test('a user with no organization gets a null organizationProfile', async ({ request }) => {
        const user = await registerUserViaAPI(request, {});

        const patched = await patchProfile(request, user.access_token, {
            roles: ['founder-ceo'],
            teamSize: 'solo',
        });

        expect(patched.state.profile).toEqual({ roles: ['founder-ceo'], teamSize: 'solo' });
        expect(patched.organizationProfile ?? null).toBeNull();
    });
});
