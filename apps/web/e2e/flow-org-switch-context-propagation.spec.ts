import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';
import {
    createOrganizationViaAPI,
    gotoDashboardWithSwitcher,
    listOrganizationsViaAPI,
    selectOrganizationInSwitcher,
    type Organization,
} from './helpers/organizations';

const PERSONAL_SCOPE = '@personal';

interface ActiveScope {
    tenantId: string | null;
    organizationId: string | null;
    organizationSlug: string | null;
}

interface MissionRow {
    id: string;
    title: string;
    tenantId: string | null;
    organizationId: string | null;
}

function scopedHeaders(token: string, scope: string | null): Record<string, string> {
    return {
        ...authedHeaders(token),
        ...(scope === null ? {} : { 'X-Scope-Slug': scope }),
    };
}

async function setLoginDefault(
    request: APIRequestContext,
    token: string,
    organizationSlug: string | null,
): Promise<ActiveScope> {
    const response = await request.post(`${API_BASE}/api/users/me/scope`, {
        headers: authedHeaders(token),
        data: { organizationSlug },
    });
    expect(response.status(), `set scope body=${await response.text().catch(() => '')}`).toBe(200);
    return response.json();
}

async function getLoginDefault(request: APIRequestContext, token: string): Promise<ActiveScope> {
    const response = await request.get(`${API_BASE}/api/users/me/scope`, {
        headers: authedHeaders(token),
    });
    expect(response.status(), `get scope body=${await response.text().catch(() => '')}`).toBe(200);
    return response.json();
}

async function createMission(
    request: APIRequestContext,
    token: string,
    scope: string | null,
    title: string,
): Promise<MissionRow> {
    const response = await request.post(`${API_BASE}/api/me/missions`, {
        headers: scopedHeaders(token, scope),
        data: {
            title,
            description: `Workspace isolation coverage for ${title}`,
            type: 'one-shot',
        },
    });
    expect(
        response.status(),
        `create Mission (${String(scope)}) body=${await response.text().catch(() => '')}`,
    ).toBe(201);
    return response.json();
}

async function findMission(
    request: APIRequestContext,
    token: string,
    scope: string,
    title: string,
): Promise<MissionRow | undefined> {
    const response = await request.get(`${API_BASE}/api/me/missions`, {
        headers: scopedHeaders(token, scope),
    });
    expect(response.status(), `list Mission body=${await response.text().catch(() => '')}`).toBe(
        200,
    );
    const rows = (await response.json()) as MissionRow[];
    return rows.find((row) => row.title === title);
}

async function expectSwitcherSelection(
    context: BrowserContext,
    page: Awaited<ReturnType<BrowserContext['newPage']>>,
    displayName: string,
): Promise<void> {
    await expect(
        page.getByRole('button', { name: 'Switch Organization' }).getByText(displayName),
    ).toBeVisible({ timeout: 30_000 });
    expect(context.pages()).toContain(page);
}

test.describe('Organization workspace request authority', () => {
    test.describe.configure({ timeout: 150_000 });

    test('parallel Ever, Yo, personal, and headerless creates keep exact request-local stamps', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const suffix = Date.now().toString(36);
        const ever = await createOrganizationViaAPI(request, user.access_token, `Ever ${suffix}`);
        const yo = await createOrganizationViaAPI(request, user.access_token, `Yo ${suffix}`);

        // Deliberately make the mutable preference disagree with the first
        // request. It is a future-login default, never request authority.
        await setLoginDefault(request, user.access_token, yo.slug);
        const sharedTitle = `parallel-same-title-${suffix}`;

        const [everMission, yoMission, personalMission, headerlessMission] = await Promise.all([
            createMission(request, user.access_token, ever.slug, sharedTitle),
            createMission(request, user.access_token, yo.slug, sharedTitle),
            createMission(request, user.access_token, PERSONAL_SCOPE, sharedTitle),
            createMission(request, user.access_token, null, sharedTitle),
        ]);

        expect(everMission).toMatchObject({
            tenantId: ever.tenantId,
            organizationId: ever.id,
        });
        expect(yoMission).toMatchObject({ tenantId: yo.tenantId, organizationId: yo.id });
        expect(personalMission).toMatchObject({
            tenantId: ever.tenantId,
            organizationId: null,
        });
        expect(headerlessMission).toMatchObject({
            tenantId: ever.tenantId,
            organizationId: null,
        });
        expect(
            new Set([everMission.id, yoMission.id, personalMission.id, headerlessMission.id]),
        ).toHaveLength(4);
    });

    test('two browser sessions stay isolated when Yo changes the login default and Ever mutates later', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerUserViaAPI(request);
        const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await request
            .post(`${API_BASE}/api/onboarding/dismiss`, {
                headers: authedHeaders(user.access_token),
            })
            .catch(() => {});
        const ever = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Ever Session ${suffix}`,
        );
        const yo = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Yo Session ${suffix}`,
        );
        await setLoginDefault(request, user.access_token, ever.slug);

        const everContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const yoContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const everPage = await everContext.newPage();
        const yoPage = await yoContext.newPage();

        try {
            await loginViaUI(everPage, { email: user.email, password: user.password });
            await loginViaUI(yoPage, { email: user.email, password: user.password });
            await expect(everPage).toHaveURL(`/org/${ever.slug}/dashboard`);
            await expect(yoPage).toHaveURL(`/org/${ever.slug}/dashboard`);
            await gotoDashboardWithSwitcher(everPage, baseURL, '/dashboard');
            await gotoDashboardWithSwitcher(yoPage, baseURL, '/dashboard');

            const persistedRequest = yoPage.waitForRequest(
                (candidate) =>
                    candidate.method() === 'POST' &&
                    new URL(candidate.url()).pathname === '/api/users/me/scope',
            );
            const canonicalNavigation = yoPage.waitForRequest(
                (candidate) =>
                    candidate.method() === 'GET' &&
                    new URL(candidate.url()).pathname === `/org/${yo.slug}/dashboard`,
            );
            await selectOrganizationInSwitcher(yoPage, yo.displayName);

            const persisted = await persistedRequest;
            expect(persisted.postDataJSON()).toEqual({ organizationSlug: yo.slug });
            expect(persisted.headers()['x-ever-workspace']).toBe(`org:${ever.slug}`);
            await canonicalNavigation;
            await expect(yoPage).toHaveURL(`/org/${yo.slug}/dashboard`);
            await expectSwitcherSelection(yoContext, yoPage, yo.displayName);

            // The account-wide preference changed, but the other session's
            // visible URL remains authoritative, including after a reload.
            await expect(everPage).toHaveURL(`/org/${ever.slug}/dashboard`);
            await everPage.reload({ waitUntil: 'domcontentloaded' });
            await expect(everPage).toHaveURL(`/org/${ever.slug}/dashboard`);
            await expectSwitcherSelection(everContext, everPage, ever.displayName);
            expect(await getLoginDefault(request, user.access_token)).toMatchObject({
                organizationId: yo.id,
                organizationSlug: yo.slug,
            });

            // A server-action mutation from the old Ever session must use the
            // current request path, not the now-Yo login preference.
            const missionTitle = `ever-after-yo-switch-${suffix}`;
            await everPage.goto(`/org/${ever.slug}/missions/new`, {
                waitUntil: 'load',
            });
            await everPage.locator('#new-mission-title').fill(missionTitle);
            await everPage
                .locator('#new-mission-description')
                .fill('This Mission must remain stamped in the Ever workspace.');
            const createMissionButton = everPage.locator(
                '[data-testid="new-mission-form"] button[type="submit"]',
            );
            await expect(createMissionButton).toBeEnabled({ timeout: 30_000 });
            await createMissionButton.click();
            await expect(everPage).toHaveURL(
                new RegExp(`/org/${ever.slug}/missions/[0-9a-f-]+$`, 'i'),
                { timeout: 90_000 },
            );

            await expect
                .poll(
                    async () =>
                        (await findMission(request, user.access_token, ever.slug, missionTitle))
                            ?.organizationId,
                    { timeout: 30_000 },
                )
                .toBe(ever.id);
            await expect(yoPage).toHaveURL(`/org/${yo.slug}/dashboard`);
        } finally {
            await Promise.all([everContext.close(), yoContext.close()]);
        }
    });

    test('fresh login hydrates the preference, while explicit personal remains personal', async ({
        browser,
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Login ${Date.now()}`,
        );
        await setLoginDefault(request, user.access_token, org.slug);

        const personal = await createMission(
            request,
            user.access_token,
            PERSONAL_SCOPE,
            `personal-after-${org.slug}`,
        );
        expect(personal).toMatchObject({ tenantId: org.tenantId, organizationId: null });

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await expect(page).toHaveURL(`/org/${org.slug}/dashboard`);
        } finally {
            await context.close();
        }
    });

    test('unknown and foreign selections share opaque 404 parity and do not change the default', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const owned = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `Owned ${Date.now()}`,
        );
        await setLoginDefault(request, owner.access_token, owned.slug);

        const stranger = await registerUserViaAPI(request);
        const foreign = await createOrganizationViaAPI(
            request,
            stranger.access_token,
            `Foreign ${Date.now()}`,
        );
        const [unknown, rejected] = await Promise.all([
            request.post(`${API_BASE}/api/users/me/scope`, {
                headers: authedHeaders(owner.access_token),
                data: { organizationSlug: `unknown-${Date.now().toString(36)}` },
            }),
            request.post(`${API_BASE}/api/users/me/scope`, {
                headers: authedHeaders(owner.access_token),
                data: { organizationSlug: foreign.slug },
            }),
        ]);

        expect(unknown.status()).toBe(404);
        expect(rejected.status()).toBe(404);
        expect((await unknown.json()).message).toBe((await rejected.json()).message);
        expect(await getLoginDefault(request, owner.access_token)).toMatchObject({
            organizationId: owned.id,
            organizationSlug: owned.slug,
        });

        const visible = await listOrganizationsViaAPI(request, owner.access_token);
        expect(visible.map((organization: Organization) => organization.id)).toContain(owned.id);
        expect(visible.map((organization: Organization) => organization.id)).not.toContain(
            foreign.id,
        );
    });
});
