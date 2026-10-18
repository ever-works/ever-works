import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './api';
import { loginViaUI } from './auth';

/**
 * Fleet hub (FL-01) — what the hub's browser walks share: whether the hub is
 * on for this run, a fresh account with the onboarding wizard dismissed, a
 * REAL enrolled node (minted token → enroll, exactly what a machine does) and
 * a signed-in context with the sidebar pinned expanded.
 */

export const FLEET_HUB_ON =
    process.env.FLEET_HUB_ENABLED === 'true' && process.env.FLEET_ENABLED !== 'false';
export const FLEET_HUB_ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000')
    .origin;
export const FLEET_HUB_CLICK_TIMEOUT = 15_000;

export function fleetUniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function enrollFleetNode(
    request: APIRequestContext,
    token: string,
    name = `Hub node ${fleetUniq()}`,
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

export async function freshFleetUser(request: APIRequestContext): Promise<RegisteredUser> {
    const u = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(u.access_token),
    });
    expect(dismissed.status(), `dismiss body=${await dismissed.text().catch(() => '')}`).toBe(200);
    return u;
}

export async function signedInFleetUser(
    browser: Browser,
    u: RegisteredUser,
): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([{ name: 'sidebar-collapsed', value: '0', url: FLEET_HUB_ORIGIN }]);
    const page = await context.newPage();
    await loginViaUI(page, { email: u.email, password: u.password });
    return { page, close: () => context.close() };
}

/** Resolves once a server action's POST has answered (the web's writes go through them). */
export function serverActionAnswered(page: Page) {
    return page.waitForResponse(
        (response) =>
            response.request().method() === 'POST' &&
            response.request().headers()['next-action'] !== undefined,
    );
}
