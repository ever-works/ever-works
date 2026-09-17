import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { clickAndExpectUrl, clickUntil } from './helpers/nav';

/**
 * Agent email (AW-05, P1) — an owner decides whether an Agent's email waits
 * for approval and how much it may send, and assigns the addresses it uses.
 *
 * Enforcement itself (a held draft makes zero provider calls; the 101st send
 * is refused) is proven by the unit suites next to the send path, because the
 * e2e stack has no real provider to send through. This spec proves the
 * surface an owner actually touches:
 *
 *   GET  /api/email/agents/:agentId/send-policy  → { inbox: null, meter } for a fresh Agent
 *   PUT  /api/email/agents/:agentId/inbox        → idempotent create-or-update
 *   POST /api/email/agents/:agentId/assignments  → assign an owned address (409 on repeat)
 *   DELETE /api/email/assignments/:id            → 204, foreign caller 404
 *   POST /api/email/messages/:id/approve         → 404 for an unknown / foreign message
 *
 * and that the Inbox tab reaches the page by clicking.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function uniq(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const s = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: s.email, password: s.password },
    });
    expect(res.status(), 'seeded login should succeed').toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
}

test.describe('Agent email — sending policy and addresses', () => {
    test('API: policy defaults, idempotent settings, limits, isolation', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Mail policy'),
        });
        const headers = authedHeaders(owner.access_token);

        // A fresh Agent has no settings: it keeps the platform behaviour.
        const initial = await request.get(`${API_BASE}/api/email/agents/${agent.id}/send-policy`, {
            headers,
        });
        expect(initial.status()).toBe(200);
        const initialBody = await initial.json();
        expect(initialBody.inbox).toBeNull();
        expect(initialBody.meter.agentId).toBe(agent.id);
        expect(initialBody.meter.modeSource).toBe('platform');
        const kinds = (initialBody.meter.windows as Array<{ kind: string }>).map((w) => w.kind);
        expect(kinds).toEqual([
            'recipientsPerMessage',
            'inboxBurst',
            'inboxRecipients',
            'inboxDaily',
            'workspaceDaily',
            'workspaceMonthly',
        ]);

        // First write creates the settings, starting in draft review.
        const created = await request.put(`${API_BASE}/api/email/agents/${agent.id}/inbox`, {
            headers,
            data: { dailySendCap: 5 },
        });
        expect(created.status()).toBe(200);
        const createdBody = await created.json();
        expect(createdBody.created).toBe(true);
        expect(createdBody.inbox.mode).toBe('draft-review');
        expect(createdBody.inbox.caps.inboxDailySends).toBe(5);
        const daily = (
            createdBody.meter.windows as Array<{ kind: string; cap: number | null; source: string }>
        ).find((w) => w.kind === 'inboxDaily');
        expect(daily).toMatchObject({ source: 'inbox' });

        // Second write updates the same row; 0 means "no limit for this Agent".
        const updated = await request.put(`${API_BASE}/api/email/agents/${agent.id}/inbox`, {
            headers,
            data: { mode: 'auto-send', dailySendCap: 0 },
        });
        expect(updated.status()).toBe(200);
        const updatedBody = await updated.json();
        expect(updatedBody.created).toBe(false);
        expect(updatedBody.inbox.id).toBe(createdBody.inbox.id);
        expect(updatedBody.inbox.mode).toBe('auto-send');
        expect(updatedBody.inbox.caps.inboxDailySends).toBe(0);

        // Validation keeps "inherit" (null) and "no limit" (0) apart from garbage.
        const invalid = await request.put(`${API_BASE}/api/email/agents/${agent.id}/inbox`, {
            headers,
            data: { dailySendCap: -1 },
        });
        expect(invalid.status()).toBe(400);
        const badMode = await request.put(`${API_BASE}/api/email/agents/${agent.id}/inbox`, {
            headers,
            data: { mode: 'whenever' },
        });
        expect(badMode.status()).toBe(400);

        // Another account cannot read or change it — the same 404 as a missing Agent.
        const foreignRead = await request.get(
            `${API_BASE}/api/email/agents/${agent.id}/send-policy`,
            {
                headers: authedHeaders(stranger.access_token),
            },
        );
        expect(foreignRead.status()).toBe(404);
        const foreignWrite = await request.put(`${API_BASE}/api/email/agents/${agent.id}/inbox`, {
            headers: authedHeaders(stranger.access_token),
            data: { mode: 'auto-send' },
        });
        expect(foreignWrite.status()).toBe(404);
        const missing = await request.get(`${API_BASE}/api/email/agents/${ZERO_UUID}/send-policy`, {
            headers,
        });
        expect(missing.status()).toBe(404);

        // Deciding a draft that does not exist (or is not yours) is a 404.
        const approveMissing = await request.post(
            `${API_BASE}/api/email/messages/${ZERO_UUID}/approve`,
            {
                headers,
            },
        );
        expect(approveMissing.status()).toBe(404);

        // Every route needs a session.
        const anon = await request.get(`${API_BASE}/api/email/agents/${agent.id}/send-policy`);
        expect(anon.status()).toBe(401);
    });

    test('API: assign, list and remove an Agent address, owner-scoped', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: uniq('Mail addresses'),
        });
        const headers = authedHeaders(owner.access_token);

        const addressRes = await request.post(`${API_BASE}/api/email/addresses`, {
            headers,
            data: {
                address: `${uniq('agent')}@example.com`,
                direction: 'outbound',
                pluginId: 'postmark',
                providerSettings: { apiKey: 'ci-fake-key' },
            },
        });
        expect(addressRes.status()).toBe(201);
        const address = (await addressRes.json()).address as { id: string; address: string };

        const assigned = await request.post(
            `${API_BASE}/api/email/agents/${agent.id}/assignments`,
            {
                headers,
                data: { emailAddressId: address.id, direction: 'outbound' },
            },
        );
        expect(assigned.status()).toBe(201);
        const assignment = (await assigned.json()).assignment;
        expect(assignment).toMatchObject({
            agentId: agent.id,
            emailAddressId: address.id,
            address: address.address,
            direction: 'outbound',
            priority: 100,
        });
        expect(JSON.stringify(assignment)).not.toContain('ci-fake-key');

        // A send-only address cannot be assigned for receiving, and repeats are refused.
        const wrongUse = await request.post(
            `${API_BASE}/api/email/agents/${agent.id}/assignments`,
            {
                headers,
                data: { emailAddressId: address.id, direction: 'inbound' },
            },
        );
        expect(wrongUse.status()).toBe(400);
        const repeat = await request.post(`${API_BASE}/api/email/agents/${agent.id}/assignments`, {
            headers,
            data: { emailAddressId: address.id, direction: 'outbound' },
        });
        expect(repeat.status()).toBe(409);

        const listed = await request.get(`${API_BASE}/api/email/agents/${agent.id}/assignments`, {
            headers,
        });
        expect(listed.status()).toBe(200);
        expect(
            ((await listed.json()).assignments as Array<{ id: string }>).map((a) => a.id),
        ).toEqual([assignment.id]);

        // The stranger cannot see, add to or remove from this Agent.
        const strangerHeaders = authedHeaders(stranger.access_token);
        expect(
            (
                await request.get(`${API_BASE}/api/email/agents/${agent.id}/assignments`, {
                    headers: strangerHeaders,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${API_BASE}/api/email/assignments/${assignment.id}`, {
                    headers: strangerHeaders,
                })
            ).status(),
        ).toBe(404);

        const removed = await request.delete(`${API_BASE}/api/email/assignments/${assignment.id}`, {
            headers,
        });
        expect(removed.status()).toBe(204);
        const after = await request.get(`${API_BASE}/api/email/agents/${agent.id}/assignments`, {
            headers,
        });
        expect((await after.json()).assignments).toEqual([]);
    });

    test('UI: the Inbox tab reaches the page, and a send limit saves', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        const agent = await createAgentViaAPI(request, token, {
            name: uniq('Mail UI'),
            scope: 'tenant',
        });
        const origin = baseURL ?? 'http://localhost:3000';

        await page.goto(`${origin}/agents/${agent.id}/activity`, { waitUntil: 'domcontentloaded' });
        // Scope to the Agent tab strip: the dashboard sidebar has its own "Inbox".
        const tabStrip = page
            .locator('nav')
            .filter({ has: page.getByRole('link', { name: 'Budgets', exact: true }) });
        const inboxTab = tabStrip.getByRole('link', { name: 'Inbox', exact: true });
        await expect(inboxTab).toBeVisible({ timeout: 30_000 });
        await expect(inboxTab).toHaveAttribute('href', `/agents/${agent.id}/inbox`);
        // A click that lands before React hydrates the tab strip is silently
        // dropped: the link is visible, enabled and stable, Playwright reports
        // the click as successful, and the URL never moves (stage run
        // 34970057817 — 33 polls over 30s, every one of them ".../activity").
        // `clickAndExpectUrl` re-clicks ONLY while the URL has not arrived, so
        // "clicking Inbox reaches the page" is proven exactly as before.
        await clickAndExpectUrl(page, inboxTab, new RegExp(`/agents/${agent.id}/inbox`));

        const panel = page.getByTestId('agent-email-send-policy');
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(panel.getByRole('heading', { name: 'Sending policy' })).toBeVisible();
        await expect(panel.getByTestId('email-cap-meter')).toBeVisible();

        await panel.getByTestId('email-cap-dailySendCap').fill('7');
        // If the tab click above landed pre-hydration as a plain anchor
        // navigation, the inbox document arrives unhydrated too and the Save
        // click is exposed to the same swallow. `clickUntil` re-clicks only
        // while the success notice is still absent, so a Save that DID land is
        // never undone, and the notice remains the proof. Safe by construction:
        // `save()` PUTs a field diff (idempotent) and the notice has no
        // auto-dismiss, so the post-condition cannot flip back to false.
        const saveButton = panel.getByRole('button', { name: 'Save', exact: true });
        const savedNotice = panel.getByText('Sending policy saved');
        await clickUntil(saveButton, () => savedNotice.isVisible());
        await expect(savedNotice).toBeVisible();

        const saved = await request.get(`${API_BASE}/api/email/agents/${agent.id}/send-policy`, {
            headers: authedHeaders(token),
        });
        expect(saved.status()).toBe(200);
        expect((await saved.json()).inbox.caps.inboxDailySends).toBe(7);
    });
});
