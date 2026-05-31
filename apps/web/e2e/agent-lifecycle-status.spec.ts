import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent status lifecycle — real draft → active ⇄ paused state machine.
 *
 * An Agent (apps/api/src/agents/*) is a scoped AI worker whose status follows
 * a strict state machine. A freshly-created agent is `draft` with every one of
 * its 8 capability flags OFF. The status only changes via the lifecycle
 * endpoints the web app's own `agentsAPI` wraps:
 *   - POST /api/agents/:id/pause   (active → paused; illegal from draft)
 *   - POST /api/agents/:id/resume  (draft → active, paused → active)
 *
 * Verified live (sqlite in-memory, the CI driver) before writing assertions:
 *   - create → 201 { status:'draft', permissions:{ all false } }
 *   - draft → pause → 400 "Cannot transition Agent from draft to paused."
 *   - resume → 200 'active'; pause → 200 'paused'; resume → 200 'active'
 *
 * The dashboard surfaces the status read-only (no UI pause/resume button
 * exists yet — Phase 5 placeholder, see agents/[id]/page.tsx + AgentCard.tsx),
 * so this spec drives the transition through the real lifecycle endpoint and
 * then asserts BOTH the persisted API status AND the server-rendered UI:
 *   - the `/agents/:id` detail dashboard Summary tile ("Status" → value), and
 *   - the `/agents` catalog card's status badge.
 * The page is a server component, so a fresh navigation reflects each change
 * with no client cache to fight. No LLM is involved — fully deterministic.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
	const seeded = loadSeededTestUser();
	const res = await request.post(`${API_BASE}/api/auth/login`, {
		data: { email: seeded.email, password: seeded.password },
	});
	expect(res.status()).toBe(200);
	return (await res.json()).access_token;
}

/** GET a single agent (the same read the detail page server-renders from). */
async function getAgent(request: APIRequestContext, token: string, id: string) {
	const res = await request.get(`${API_BASE}/api/agents/${id}`, {
		headers: authedHeaders(token),
	});
	expect(res.status()).toBe(200);
	return res.json();
}

test.describe('Agent lifecycle — status state machine', () => {
	test('a new agent is a locked-down draft; resume/pause walk active⇄paused (API)', async ({
		request,
	}) => {
		const token = await seededToken(request);
		const stamp = Date.now().toString(36);

		// 1. Create → starts as a draft with every capability OFF.
		const agent = await createAgentViaAPI(request, token, {
			name: `Lifecycle API Agent ${stamp}`,
			scope: 'tenant',
		});
		expect(agent.status).toBe('draft');
		// Sample a couple of the 8 default-false permission flags (the trimmed
		// helper type omits `permissions`, so read the full agent off a GET).
		const fresh = await getAgent(request, token, agent.id);
		expect(fresh.status).toBe('draft');
		expect(fresh.permissions).toMatchObject({
			canAssignTasks: false,
			canSpend: false,
			canCommitToRepo: false,
			canCallExternalTools: false,
		});

		const headers = authedHeaders(token);

		// 2a. A draft has never been activated — pausing it is an illegal hop.
		const badPause = await request.post(`${API_BASE}/api/agents/${agent.id}/pause`, {
			headers,
		});
		expect(badPause.status()).toBe(400);
		expect((await badPause.json()).message).toMatch(/cannot transition/i);
		// The rejected transition left the agent untouched.
		expect((await getAgent(request, token, agent.id)).status).toBe('draft');

		// 2b. resume → active.
		const resume = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, { headers });
		expect(resume.status()).toBe(200);
		expect((await resume.json()).status).toBe('active');

		// 2c. pause → paused (now legal: it was active).
		const pause = await request.post(`${API_BASE}/api/agents/${agent.id}/pause`, { headers });
		expect(pause.status()).toBe(200);
		expect((await pause.json()).status).toBe('paused');

		// 2d. resume → active again.
		const resume2 = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, { headers });
		expect(resume2.status()).toBe(200);
		expect((await resume2.json()).status).toBe('active');

		// A follow-up GET confirms the persisted terminal status.
		expect((await getAgent(request, token, agent.id)).status).toBe('active');
	});

	test('the agent detail page + catalog card reflect the lifecycle status', async ({
		page,
		request,
	}) => {
		const token = await seededToken(request);
		const headers = authedHeaders(token);
		const stamp = Date.now().toString(36);
		const name = `Lifecycle UI Agent ${stamp}`;

		const agent = await createAgentViaAPI(request, token, { name, scope: 'tenant' });
		expect(agent.status).toBe('draft');

		// --- DRAFT renders as the detail Summary status value. ---
		// The dashboard tab is the default landing surface for /agents/:id and
		// shows a "Status" <dt>/<dd> pair (page.tsx). The <dd> is `capitalize`
		// styled, so the *text content* stays the raw lowercase status word.
		await page.goto(`/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
		const statusValue = page
			.locator('dt', { hasText: /^Status$/ })
			.locator('xpath=following-sibling::dd[1]');
		await expect(statusValue).toHaveText(/draft/i, { timeout: 30_000 });

		// --- Drive the transition through the REAL lifecycle endpoint that the
		//     web app's own agentsAPI.resume() wraps, then re-render the page. ---
		const resume = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, { headers });
		expect(resume.status()).toBe(200);
		expect((await resume.json()).status).toBe('active');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(statusValue).toHaveText(/active/i, { timeout: 30_000 });

		// --- Pause the now-active agent; the UI must follow to 'paused'. ---
		const pause = await request.post(`${API_BASE}/api/agents/${agent.id}/pause`, { headers });
		expect(pause.status()).toBe(200);
		expect((await pause.json()).status).toBe('paused');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(statusValue).toHaveText(/paused/i, { timeout: 30_000 });

		// The persisted API status agrees with what the UI shows.
		expect((await getAgent(request, token, agent.id)).status).toBe('paused');

		// --- The /agents catalog card also carries the live status badge. ---
		// AgentCard renders an i18n status label ("Draft"/"Active"/"Paused").
		await page.goto('/agents', { waitUntil: 'domcontentloaded' });
		const card = page
			.locator('a', { has: page.getByRole('heading', { name, level: 3 }) })
			.first();
		await expect(card).toBeVisible({ timeout: 30_000 });
		// The paused card shows the "Paused" badge (i18n label) and not "Draft".
		await expect(card.getByText(/^Paused$/i)).toBeVisible({ timeout: 30_000 });
	});
});
