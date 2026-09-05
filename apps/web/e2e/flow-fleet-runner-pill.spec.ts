import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * Runner-status pill (self-build slice S, EW-775) — the always-visible
 * "N of M runners online" indicator in the dashboard sidebar, walked end
 * to end against a REAL enrolled node.
 *
 * `api-public-contract.spec.ts` pins the data endpoint's authz
 * (`GET /api/fleet/runner-status` is 401 anonymous). What was never
 * covered is the rendering: the pill is hidden until the account has a
 * runner, appears the moment one enrolls, reflects the node in its
 * popover, and follows a drain. That is the surface a user reads to
 * decide whether a fleet run will actually start — and the one that
 * would quietly disagree with routing if the two composers drifted.
 *
 * Every test logs in as a FRESH account in a fresh browser context
 * rather than reusing the seeded `storageState`, so the seeded user's
 * registry is never polluted and "no runner enrolled" is a true
 * statement, not an assumption about test ordering.
 *
 * Node enrollment is driven through the public protocol
 * (`POST /api/fleet/nodes/enrollment-token` → `POST /api/fleet/enroll`),
 * exactly as `flow-fleet-enrollment-contract.spec.ts` does; no daemon is
 * needed because enroll itself flips the node `online`.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrollNode(
    request: APIRequestContext,
    token: string,
    capabilities: string[] = ['terminal', 'workspace'],
): Promise<{ nodeId: string; secret: string; name: string }> {
    const name = `Pill node ${uniq()}`;
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(token),
        data: { name, kind: 'desktop-node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token: enrollmentToken } = await minted.json();

    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: {
            token: enrollmentToken,
            platform: 'linux/x64',
            version: '1.0.0',
            capabilities,
        },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    const body = await enrolled.json();
    return { nodeId: body.nodeId, secret: body.secret, name };
}

async function openDashboard(page: Page): Promise<void> {
    await page.goto('/en/works', { waitUntil: 'networkidle' });
}

test.describe('runner-status pill', () => {
    test('GET /api/fleet/runner-status: a fresh account has no runners and advertises the 30s cadence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/fleet/runner-status`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            total: 0,
            online: 0,
            busy: 0,
            offline: 0,
            drained: 0,
            // The pill takes its polling cadence FROM the payload, so the
            // caption cannot drift from the server's intent.
            refreshIntervalSec: 30,
            loadUnavailable: false,
            nodes: [],
        });
    });

    test('renders nothing until the account has an enrolled runner', async ({
        browser,
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: u.email, password: u.password });
            await openDashboard(page);

            // The sidebar has mounted (the pill lives in its footer), and
            // the status request has had a chance to resolve to `total: 0`.
            await expect(page.locator('nav, aside').first()).toBeVisible();
            await page.waitForTimeout(1_000);
            await expect(page.getByTestId('runner-status')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });

    test('appears once a node enrolls, names it in the popover and links to Fleet settings', async ({
        browser,
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollNode(request, u.access_token);

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: u.email, password: u.password });
            await openDashboard(page);

            const pill = page.getByTestId('runner-status-pill');
            await expect(pill).toBeVisible({ timeout: 15_000 });
            // Enroll flips the node online, so the count reads 1 of 1.
            await expect(page.getByTestId('runner-status-count')).toHaveText(/1\D+1/);

            await pill.click();
            const popover = page.getByTestId('runner-status-popover');
            await expect(popover).toBeVisible();
            const row = page.getByTestId(`runner-status-node-${node.nodeId}`);
            await expect(row).toBeVisible();
            await expect(row).toContainText(node.name);

            const manage = page.getByTestId('runner-status-manage');
            await expect(manage).toBeVisible();
            expect(await manage.getAttribute('href')).toContain('/settings/fleet');
        } finally {
            await context.close();
        }
    });

    test('follows a drain: the count drops to 0 of 1 after a manual refresh', async ({
        browser,
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollNode(request, u.access_token);

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: u.email, password: u.password });
            await openDashboard(page);
            await expect(page.getByTestId('runner-status-count')).toHaveText(/1\D+1/, {
                timeout: 15_000,
            });

            // Drain through the owner route: disable AND requeue. The node
            // stays enrolled (total 1) but is no longer online.
            const drained = await request.post(`${API_BASE}/api/fleet/nodes/${node.nodeId}/drain`, {
                headers: authedHeaders(u.access_token),
                data: { drain: true },
            });
            expect(drained.status(), `drain body=${await drained.text().catch(() => '')}`).toBe(
                200,
            );

            await page.getByTestId('runner-status-pill').click();
            await expect(page.getByTestId('runner-status-popover')).toBeVisible();
            await page.getByTestId('runner-status-refresh').click();
            await expect(page.getByTestId('runner-status-count')).toHaveText(/0\D+1/, {
                timeout: 15_000,
            });
        } finally {
            await context.close();
        }
    });

    test('a heartbeat with the wrong secret is 401 and leaves the pill untouched', async ({
        browser,
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollNode(request, u.access_token);

        const beat = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: { nodeId: node.nodeId, secret: 'b'.repeat(43) },
        });
        expect(beat.status()).toBe(401);

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: u.email, password: u.password });
            await openDashboard(page);
            await expect(page.getByTestId('runner-status-count')).toHaveText(/1\D+1/, {
                timeout: 15_000,
            });
        } finally {
            await context.close();
        }
    });

    test('the pill and the API agree on the same machines', async ({ browser, request }) => {
        // The pill and the run router read ONE composer. This pins the
        // half a browser can see: what the pill renders is what the
        // endpoint returns for the same account at the same moment.
        const u = await registerUserViaAPI(request);
        const first = await enrollNode(request, u.access_token);
        const second = await enrollNode(request, u.access_token, ['terminal']);

        const status = await request.get(`${API_BASE}/api/fleet/runner-status`, {
            headers: authedHeaders(u.access_token),
        });
        const body = (await status.json()) as {
            total: number;
            online: number;
            nodes: Array<{ id: string; status: string }>;
        };
        expect(body.total).toBe(2);
        expect(body.online).toBe(2);
        expect(body.nodes.map((row) => row.id).sort()).toEqual(
            [first.nodeId, second.nodeId].sort(),
        );

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: u.email, password: u.password });
            await openDashboard(page);
            await expect(page.getByTestId('runner-status-count')).toHaveText(/2\D+2/, {
                timeout: 15_000,
            });
            await page.getByTestId('runner-status-pill').click();
            for (const row of body.nodes) {
                await expect(page.getByTestId(`runner-status-node-${row.id}`)).toBeVisible();
            }
        } finally {
            await context.close();
        }
    });
});
