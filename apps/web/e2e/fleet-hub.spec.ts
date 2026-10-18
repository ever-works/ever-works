import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * Fleet hub (FL-01) — the hub walked end to end against REAL enrolled nodes:
 * the sidebar entry below Teams, the six tabs and their placeholders, the
 * Overview (needs-a-look, cards, favourites first), the Computers tab (the
 * moved table and Add flow), Settings → Fleet's link card, the runner pill's
 * Manage link, the computer page (header, twelve tabs, placeholders) and the
 * 404 for a computer that is not there (ACC-FL01-01 … -09, -13).
 *
 * The hub ships behind `FLEET_HUB_ENABLED` (default off). The whole file
 * skips unless the web server under test runs with it on — with it off the
 * existing fleet specs (`flow-fleet-*.spec.ts`) pin today's behaviour, and
 * `/fleet` must 404 (asserted below when the flag is explicitly off).
 *
 * Every test uses a FRESH account (no shared registry state) in a fresh
 * context with the sidebar pinned expanded and the onboarding wizard
 * dismissed server-side, exactly as `flow-fleet-runner-pill.spec.ts` does.
 */

const HUB_ON = process.env.FLEET_HUB_ENABLED === 'true' && process.env.FLEET_ENABLED !== 'false';
const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;
const CLICK_TIMEOUT = 15_000;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrollNode(
    request: APIRequestContext,
    token: string,
    name = `Hub node ${uniq()}`,
): Promise<{ nodeId: string; name: string }> {
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(token),
        data: { name, kind: 'node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token: enrollmentToken } = await minted.json();
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: {
            token: enrollmentToken,
            platform: 'linux/x64',
            version: '1.0.0',
            capabilities: ['terminal', 'workspace'],
        },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    return { nodeId: (await enrolled.json()).nodeId, name };
}

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    const u = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(u.access_token),
    });
    expect(dismissed.status(), `dismiss body=${await dismissed.text().catch(() => '')}`).toBe(200);
    return u;
}

async function signedIn(
    browser: Browser,
    u: RegisteredUser,
): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([{ name: 'sidebar-collapsed', value: '0', url: ORIGIN }]);
    const page = await context.newPage();
    await loginViaUI(page, { email: u.email, password: u.password });
    return { page, close: () => context.close() };
}

test.describe('Fleet hub — flag off', () => {
    test.skip(HUB_ON, 'the hub is on for this run');

    test('/fleet answers 404 and the sidebar has no Fleet entry (FR-15, U2)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        const { page, close } = await signedIn(browser, u);
        try {
            const response = await page.goto('/en/fleet');
            expect(response?.status()).toBe(404);
            await page.goto('/en/works', { waitUntil: 'networkidle' });
            await expect(page.locator('nav a[href$="/fleet"]')).toHaveCount(0);
        } finally {
            await close();
        }
    });
});

test.describe('Fleet hub', () => {
    test.skip(!HUB_ON, 'FLEET_HUB_ENABLED is not on for this run');

    test('the sidebar entry sits below Teams and opens the six-tab hub (ACC-FL01-01, -02)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto('/en/works', { waitUntil: 'networkidle' });
            const labels = await page.locator('nav ul a').allTextContents();
            const teams = labels.findIndex((label) => label.trim() === 'Teams');
            expect(labels[teams + 1]?.trim()).toBe('Fleet');

            await page.locator('nav a[href$="/fleet"]').first().click({ timeout: CLICK_TIMEOUT });
            await expect(page).toHaveURL(/\/fleet$/);
            const tabs = page.getByTestId('fleet-hub-tabs').getByRole('tab');
            await expect(tabs).toHaveText([
                'Overview',
                'Computers',
                'Sessions',
                'Checkouts',
                'Commands',
                'Usage',
            ]);
            await expect(page.getByTestId('fleet-hub-empty')).toBeVisible();

            for (const [tab, epic] of [
                ['sessions', 'FL-05'],
                ['checkouts', 'FL-14'],
                ['commands', 'FL-12'],
                ['usage', 'FL-20'],
            ] as const) {
                await page.goto(`/en/fleet/${tab}`);
                const placeholder = page.getByTestId(`fleet-hub-placeholder-${tab}`);
                await expect(placeholder).toBeVisible();
                await expect(placeholder).toContainText(epic);
            }
        } finally {
            await close();
        }
    });

    test('the Overview lists computers with their state, favourites first, and nothing to look at (ACC-FL01-03, -04, -13)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        const first = await enrollNode(request, u.access_token, `alpha-${uniq()}`);
        const second = await enrollNode(request, u.access_token, `beta-${uniq()}`);
        const starred = await request.patch(`${API_BASE}/api/fleet/nodes/${second.nodeId}`, {
            headers: authedHeaders(u.access_token),
            data: { isFavorite: true },
        });
        expect(starred.status()).toBe(200);

        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto('/en/fleet', { waitUntil: 'networkidle' });
            await expect(page.getByTestId('fleet-needs-a-look-empty')).toHaveText(
                /Nothing needs a look/,
            );
            await expect(page.getByTestId('fleet-spends-nothing')).toHaveText(
                'Spends no tokens or credits',
            );
            const cards = page.locator('[data-testid^="fleet-computer-card-"][data-state]');
            await expect(cards).toHaveCount(2);
            await expect(cards.nth(0)).toHaveAttribute(
                'data-testid',
                `fleet-computer-card-${second.nodeId}`,
            );
            await expect(cards.nth(1)).toHaveAttribute(
                'data-testid',
                `fleet-computer-card-${first.nodeId}`,
            );
            await expect(cards.nth(0).getByTestId('fleet-computer-card-state')).toHaveText(
                'Online',
            );
            // No health snapshot yet: dashes, never a number.
            await expect(cards.nth(0).getByTestId('fleet-computer-card-health')).not.toContainText(
                '%',
            );
        } finally {
            await close();
        }
    });

    test('the Computers tab is the moved table: star a computer, and Add computer opens the existing flow (ACC-FL01-06)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        const node = await enrollNode(request, u.access_token);
        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto('/en/fleet/computers', { waitUntil: 'networkidle' });
            await expect(page.getByTestId('fleet-nodes-table')).toBeVisible();
            await expect(page.getByTestId(`fleet-node-row-${node.nodeId}`)).toContainText(
                node.name,
            );

            const star = page.getByTestId(`fleet-node-favourite-${node.nodeId}`);
            await expect(star).toHaveAttribute('aria-pressed', 'false');
            // The star turns on at once (optimistic); reload only once the
            // server action that stores it has answered.
            const saved = page.waitForResponse(
                (response) =>
                    response.request().method() === 'POST' &&
                    response.request().headers()['next-action'] !== undefined,
            );
            await star.click({ timeout: CLICK_TIMEOUT });
            await expect(star).toHaveAttribute('aria-pressed', 'true');
            await saved;
            await page.reload({ waitUntil: 'networkidle' });
            await expect(page.getByTestId(`fleet-node-favourite-${node.nodeId}`)).toHaveAttribute(
                'aria-pressed',
                'true',
            );

            await page
                .getByRole('button', { name: 'Add computer' })
                .click({ timeout: CLICK_TIMEOUT });
            await page
                .getByTestId('fleet-add-computer-desktop-node')
                .click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-add-name')).toBeVisible();
        } finally {
            await close();
        }
    });

    test('Settings → Fleet keeps the policies and points at the hub (FR-11)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        await enrollNode(request, u.access_token);
        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto('/en/settings/fleet', { waitUntil: 'networkidle' });
            await expect(page.getByTestId('fleet-settings-hub-link')).toBeVisible();
            await expect(page.getByTestId('fleet-nodes-table')).toHaveCount(0);
            await page.getByTestId('fleet-settings-hub-link-cta').click({ timeout: CLICK_TIMEOUT });
            await expect(page).toHaveURL(/\/fleet\/computers$/);
        } finally {
            await close();
        }
    });

    test('the runner pill’s Manage opens the hub (ACC-FL01-07)', async ({ browser, request }) => {
        const u = await freshUser(request);
        await enrollNode(request, u.access_token);
        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto('/en/works', { waitUntil: 'networkidle' });
            await page.getByTestId('runner-status-pill').click({ timeout: CLICK_TIMEOUT });
            const manage = page.getByTestId('runner-status-manage');
            await expect(manage).toBeVisible();
            expect(await manage.getAttribute('href')).toMatch(/\/fleet$/);
        } finally {
            await close();
        }
    });

    test('a computer page has its header, twelve tabs and honest placeholders (ACC-FL01-09, -11)', async ({
        browser,
        request,
    }) => {
        const u = await freshUser(request);
        const node = await enrollNode(request, u.access_token);
        const { page, close } = await signedIn(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            await expect(page.getByTestId('fleet-computer-name')).toHaveText(node.name);
            await expect(page.getByTestId('fleet-computer-state')).toHaveText('Online');
            await expect(page.getByTestId('fleet-computer-facts')).toContainText('Linux');
            await expect(page.getByTestId('fleet-computer-tabs').getByRole('tab')).toHaveCount(12);
            await expect(page.getByTestId('fleet-computer-new-session')).toBeDisabled();
            await expect(page.getByTestId('fleet-computer-desktop')).toBeDisabled();
            await expect(page.getByTestId('fleet-computer-overview')).toBeVisible();

            await page.getByTestId('fleet-computer-tab-logs').click({ timeout: CLICK_TIMEOUT });
            await expect(page).toHaveURL(/tab=logs/);
            await expect(page.getByTestId('fleet-computer-placeholder-logs')).toBeVisible();

            await page.goto(`/en/fleet/computers/${node.nodeId}?tab=settings`);
            await expect(page.getByTestId('fleet-policy-editor')).toBeVisible();
            await expect(page.getByTestId('fleet-policy-view')).toHaveValue('org-members');
        } finally {
            await close();
        }
    });

    test('a computer that is not there — or not yours — is the same 404 (FR-30, U10)', async ({
        browser,
        request,
    }) => {
        const owner = await freshUser(request);
        const node = await enrollNode(request, owner.access_token);
        const stranger = await freshUser(request);
        const { page, close } = await signedIn(browser, stranger);
        try {
            const foreign = await page.goto(`/en/fleet/computers/${node.nodeId}`);
            expect(foreign?.status()).toBe(404);
            await expect(page.getByTestId('fleet-computer-not-found')).toBeVisible();
            const unknown = await page.goto(
                '/en/fleet/computers/00000000-0000-4000-8000-000000000000',
            );
            expect(unknown?.status()).toBe(404);
        } finally {
            await close();
        }
    });
});
