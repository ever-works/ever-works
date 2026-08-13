import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Agents — list filtering + pagination semantics (status, search, limit/offset).
 * Pins real behaviour, including that archived agents are excluded from list
 * queries entirely. Verified against the live API.
 */

// Seeds: Alpha (draft), Beta (active), Gamma (archived).
async function seedAgents(request: import('@playwright/test').APIRequestContext) {
    const u = await registerUserViaAPI(request);
    const headers = authedHeaders(u.access_token);
    const mk = async (name: string) =>
        (
            await request.post(`${API_BASE}/api/agents`, {
                headers,
                data: { scope: 'tenant', name },
            })
        ).json();
    const alpha = await mk('Alpha Researcher');
    const beta = await mk('Beta Builder');
    const gamma = await mk('Gamma Archived');
    await request.post(`${API_BASE}/api/agents/${beta.id}/resume`, { headers }); // draft -> active
    await request.delete(`${API_BASE}/api/agents/${gamma.id}`, { headers }); // -> archived
    return { headers, alpha, beta, gamma };
}

test.describe('Agents — list filtering', () => {
    test('default list excludes archived agents', async ({ request }) => {
        const { headers, gamma } = await seedAgents(request);
        const list = await (await request.get(`${API_BASE}/api/agents`, { headers })).json();
        expect(list.meta.total).toBe(2);
        expect(list.data.map((a: { id: string }) => a.id)).not.toContain(gamma.id);
    });

    test('?status filters to a single lifecycle state', async ({ request }) => {
        const { headers } = await seedAgents(request);

        const draft = await (
            await request.get(`${API_BASE}/api/agents?status=draft`, { headers })
        ).json();
        expect(draft.data.length).toBe(1);
        expect(draft.data[0].status).toBe('draft');
        expect(draft.data[0].name).toBe('Alpha Researcher');

        const active = await (
            await request.get(`${API_BASE}/api/agents?status=active`, { headers })
        ).json();
        expect(active.data.length).toBe(1);
        expect(active.data[0].status).toBe('active');

        // Archived agents are hidden from list queries BY DEFAULT, but are
        // returned when explicitly requested — `AgentRepository
        // .findByUserIdScoped` has a deliberate carve-out for exactly this,
        // and `/agents/archived/page.tsx` depends on it: it renders
        // `agentsAPI.list({ status: 'archived' })`.
        //
        // This assertion used to expect an empty list ("archived agents stay
        // out of list queries even when explicitly requested"), which is the
        // behaviour the carve-out was added to FIX — the repository's own
        // comment notes that without it "the archived view is always empty".
        // So the spec was pinning a state in which the Archived tab could
        // never show anything, and failed against the shipped code.
        //
        // The default-exclusion half is covered by the sibling test above,
        // 'default list excludes archived agents'.
        const archived = await (
            await request.get(`${API_BASE}/api/agents?status=archived`, { headers })
        ).json();
        expect(archived.data.length).toBe(1);
        expect(archived.data[0].status).toBe('archived');
        expect(archived.data[0].name).toBe('Gamma Archived');
    });

    test('?search matches on agent name', async ({ request }) => {
        const { headers } = await seedAgents(request);
        const res = await (
            await request.get(`${API_BASE}/api/agents?search=Beta`, { headers })
        ).json();
        expect(res.data.length).toBe(1);
        expect(res.data[0].name).toBe('Beta Builder');
    });

    test('limit/offset paginate without overlap', async ({ request }) => {
        const { headers } = await seedAgents(request);
        const p1 = await (
            await request.get(`${API_BASE}/api/agents?limit=1&offset=0`, { headers })
        ).json();
        const p2 = await (
            await request.get(`${API_BASE}/api/agents?limit=1&offset=1`, { headers })
        ).json();
        expect(p1.data.length).toBe(1);
        expect(p2.data.length).toBe(1);
        expect(p1.meta.total).toBe(2);
        expect(p1.data[0].id).not.toBe(p2.data[0].id);
    });
});
