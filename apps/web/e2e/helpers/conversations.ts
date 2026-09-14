import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
} from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './api';
import { loginViaUI } from './auth';

/**
 * Shared setup for the named-Conversation flows in the docked chat panel.
 *
 * Every flow runs as a FRESH user in its own browser context: the panel
 * remembers who it was talking to in localStorage, and the seeded user's
 * Agents and Conversations are shared with every other spec in the shard.
 *
 * Agents are created in `draft`. A draft Agent is still mentionable and still
 * a Conversation's address, but it is not dispatched to, so these flows never
 * depend on a background-job runtime being configured.
 */

export interface ConversationAgent {
    id: string;
    name: string;
    slug: string;
}

export async function registerConversationUser(
    request: APIRequestContext,
): Promise<RegisteredUser> {
    const user = await registerUserViaAPI(request);
    // A user with no Works gets the onboarding wizard, whose modal hides the panel.
    await request
        .post(`${API_BASE}/api/onboarding/dismiss`, { headers: authedHeaders(user.access_token) })
        .catch(() => undefined);
    return user;
}

export async function createAgentViaAPI(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<ConversationAgent> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name },
    });
    expect(res.status(), `create agent body=${await res.text()}`).toBe(201);
    const agent = await res.json();
    return { id: agent.id, name: agent.name, slug: agent.slug };
}

export async function createAgentConversationViaAPI(
    request: APIRequestContext,
    token: string,
    agentId: string,
    firstMessage?: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: { kind: 'direct', agentId },
    });
    expect(res.status(), 'create named conversation').toBe(201);
    const { id } = await res.json();
    if (firstMessage) {
        const sent = await request.post(`${API_BASE}/api/conversations/${id}/messages/send`, {
            headers: authedHeaders(token),
            data: { body: firstMessage, clientMessageId: `e2e-${Date.now()}` },
        });
        expect(sent.status(), 'send first message').toBe(202);
    }
    return id;
}

export async function listAgentConversationsViaAPI(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<Array<{ id: string; title: string | null; titleSource: string | null }>> {
    const res = await request.get(
        `${API_BASE}/api/conversations?kind=direct&agentId=${agentId}&limit=50`,
        { headers: authedHeaders(token) },
    );
    expect(res.status(), 'list named conversations').toBe(200);
    return (await res.json()).conversations;
}

export async function listMessagesViaAPI(
    request: APIRequestContext,
    token: string,
    conversationId: string,
): Promise<Array<{ id: string; content: string; status: string; mentions: unknown[] | null }>> {
    const res = await request.get(
        `${API_BASE}/api/conversations/${conversationId}/messages?limit=200`,
        {
            headers: authedHeaders(token),
        },
    );
    expect(res.status(), 'list messages').toBe(200);
    return (await res.json()).messages;
}

/** Sign the user into an isolated context with the chat panel open on `route`. */
export async function openPanelAs(
    browser: Browser,
    user: RegisteredUser,
    baseURL: string | undefined,
    route = '/works',
): Promise<{ context: BrowserContext; page: Page }> {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await loginViaUI(page, { email: user.email, password: user.password });
    await context.addCookies([
        { name: 'chat-panel-open', value: '1', url: origin },
        { name: 'sidebar-collapsed', value: '0', url: origin },
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }
    await expect(page.getByTestId('conversation-panel')).toBeVisible({ timeout: 30_000 });
    return { context, page };
}

/** From anywhere in the panel, open the switcher and pick an Agent — landing on its list. */
export async function openAgentList(page: Page, agentName: string): Promise<void> {
    const panel = page.getByTestId('conversation-panel');
    // Under `next dev` the first click can land before hydration; retry until the switcher shows.
    await expect(async () => {
        const trigger = page
            .getByTestId('chat-panel-switch')
            .or(page.getByTestId('conversation-participant-trigger'))
            .first();
        await trigger.click();
        await expect(page.getByTestId('conversation-participant-switcher')).toBeVisible({
            timeout: 3_000,
        });
    }).toPass({ timeout: 30_000 });
    await page.getByTestId('conversation-switch-agent').filter({ hasText: agentName }).click();
    await expect(panel).toHaveAttribute('data-panel-view', 'list');
}

export function composer(page: Page) {
    return page.getByTestId('conversation-panel').locator('textarea');
}
