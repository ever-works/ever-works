import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Agents — deep coverage of the Agents feature (Agents/Skills/Tasks build).
 * Zero dedicated e2e specs existed before this file. Assertions are pinned
 * against live API shapes (verified on a running stack).
 *
 * An Agent is a scoped (tenant/mission/idea/work) AI worker with a status
 * lifecycle (draft → active ⇄ paused → archived), 8 default-false
 * permissions, canonical instruction files (SOUL.md/AGENTS.md/…), a budget,
 * and a run history.
 *
 * API surface (`apps/api/src/agents/*`):
 *   - GET  /api/agents                 list `{data, meta}` (+ scope/status/parent filters)
 *   - POST /api/agents                 create (scope required; status defaults to `draft`)
 *   - GET  /api/agents/:id             get one (cross-user 404)
 *   - POST /api/agents/:id/{pause,resume}  status state-machine
 *   - GET/PUT /api/agents/:id/files/:name  canonical instruction files
 *   - GET  /api/agents/:id/budget      `{currentSpendCents, capCents, period…, currency}`
 *   - GET  /api/agents/:id/runs        `{data, meta}`
 */

test.describe('Agents — API contract', () => {
	test('GET /api/agents without auth → 401', async ({ request }) => {
		expect((await request.get(`${API_BASE}/api/agents`)).status()).toBe(401);
	});

	test('GET /api/agents for a fresh user → empty {data, meta}', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const res = await request.get(`${API_BASE}/api/agents`, { headers: authedHeaders(u.access_token) });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBe(0);
		expect(body.meta).toMatchObject({ total: 0 });
	});

	test('POST /api/agents creates a draft tenant agent with locked-down permissions', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const headers = authedHeaders(u.access_token);
		const res = await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'tenant', name: 'Research Agent' } });
		expect(res.status(), `create body=${await res.text()}`).toBe(201);
		const agent = await res.json();
		expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(agent.slug).toBe('research-agent');
		expect(agent.scope).toBe('tenant');
		// New agents start as drafts; every capability defaults to OFF.
		expect(agent.status).toBe('draft');
		expect(agent.permissions).toMatchObject({
			canCreateAgents: false,
			canAssignTasks: false,
			canEditAgentFiles: false,
			canSpend: false,
			canCommitToRepo: false,
			canCallExternalTools: false
		});

		const list = await (await request.get(`${API_BASE}/api/agents`, { headers })).json();
		expect(list.data.find((a: { id: string }) => a.id === agent.id)).toBeTruthy();
	});

	test('status state-machine: draft cannot pause; resume activates; active⇄paused', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const headers = authedHeaders(u.access_token);
		const agent = await (await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'tenant', name: 'Lifecycle Agent' } })).json();
		expect(agent.status).toBe('draft');

		// A draft has never been activated — pausing it is an illegal hop.
		const badPause = await request.post(`${API_BASE}/api/agents/${agent.id}/pause`, { headers });
		expect(badPause.status()).toBe(400);
		expect((await badPause.json()).message).toMatch(/cannot transition/i);

		const resume = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, { headers });
		expect(resume.status()).toBe(200);
		expect((await resume.json()).status).toBe('active');

		const pause = await request.post(`${API_BASE}/api/agents/${agent.id}/pause`, { headers });
		expect(pause.status()).toBe(200);
		expect((await pause.json()).status).toBe('paused');

		const resume2 = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, { headers });
		expect(resume2.status()).toBe(200);
		expect((await resume2.json()).status).toBe('active');
	});

	test('instruction files: SOUL.md starts empty, PUT persists body + returns matching hash', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const headers = authedHeaders(u.access_token);
		const agent = await (await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'tenant', name: 'Documented Agent' } })).json();

		const empty = await request.get(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, { headers });
		expect(empty.status()).toBe(200);
		const before = await empty.json();
		expect(before).toMatchObject({ name: 'SOUL.md', body: '', storage: 'db' });

		const body = '# Soul\n\nI research developer tools and write crisp summaries.';
		const put = await request.put(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, { headers, data: { body } });
		expect(put.status()).toBe(200);
		const { newHash } = await put.json();
		expect(newHash).toMatch(/^[0-9a-f]{64}$/);

		const after = await (await request.get(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, { headers })).json();
		expect(after.body).toBe(body);
		expect(after.hash).toBe(newHash);
	});

	test('budget + runs surfaces: zero-spend defaults and empty run history', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const headers = authedHeaders(u.access_token);
		const agent = await (await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'tenant', name: 'Budgeted Agent' } })).json();

		const budget = await (await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, { headers })).json();
		expect(budget.currentSpendCents).toBe(0);
		expect(budget.currency).toBe('USD');
		expect(typeof budget.periodStart).toBe('string');

		const runs = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, { headers });
		expect(runs.status()).toBe(200);
		const runsBody = await runs.json();
		expect(Array.isArray(runsBody.data)).toBe(true);
		expect(runsBody.data.length).toBe(0);
	});

	test('scoping: mission-scoped agent requires missionId; filter returns only that scope', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const headers = authedHeaders(u.access_token);

		const noParent = await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'mission', name: 'Orphan' } });
		expect(noParent.status()).toBe(400);
		expect((await noParent.json()).message).toMatch(/missionId/i);

		const mission = await (await request.post(`${API_BASE}/api/me/missions`, { headers, data: { title: 'AgentMission', description: 'd', type: 'one-shot' } })).json();
		const agent = await (await request.post(`${API_BASE}/api/agents`, { headers, data: { scope: 'mission', missionId: mission.id, name: 'Mission Worker' } })).json();
		expect(agent.missionId).toBe(mission.id);

		const filtered = await (await request.get(`${API_BASE}/api/agents?scope=mission&missionId=${mission.id}`, { headers })).json();
		const ids = filtered.data.map((a: { id: string }) => a.id);
		expect(ids).toContain(agent.id);
		expect(ids.length).toBe(1);
	});

	test('cross-user isolation: another user gets 403/404 on my agent', async ({ request }) => {
		const alice = await registerUserViaAPI(request);
		const bob = await registerUserViaAPI(request);
		const agent = await (await request.post(`${API_BASE}/api/agents`, {
			headers: authedHeaders(alice.access_token), data: { scope: 'tenant', name: 'Private Agent' }
		})).json();
		const res = await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers: authedHeaders(bob.access_token) });
		expect([403, 404]).toContain(res.status());
	});
});

test.describe('Agents — UI (authenticated as the seeded user)', () => {
	test('/agents index renders and lists an agent created via API', async ({ page, request }) => {
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, { data: { email: seeded.email, password: seeded.password } });
		const { access_token } = await login.json();
		const name = `E2E Agent ${Date.now().toString(36)}`;
		const create = await request.post(`${API_BASE}/api/agents`, { headers: authedHeaders(access_token), data: { scope: 'tenant', name } });
		expect(create.status()).toBe(201);
		const agent = await create.json();

		await page.goto('/agents', { waitUntil: 'domcontentloaded' });
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });

		// Detail page renders the agent's name too.
		await page.goto(`/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
	});
});
