import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Agents — sub-resources beyond core CRUD: metadata update, the JSON
 * export envelope, attachments, the archive → hard-delete lifecycle, and
 * auth-gating of the Trigger.dev-backed run endpoints. Pinned to live shapes.
 *
 * Note: POST /assign-task and /run-now require a bound Trigger.dev adapter
 * (TRIGGER_ENABLED is off locally and in CI), so only their auth gate is
 * asserted here — the happy path isn't reachable without Trigger.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

async function makeAgent(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    name = 'Sub Agent',
) {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name },
    });
    return res.json();
}

test.describe('Agents — metadata, export, attachments', () => {
    test('PATCH updates metadata and a follow-up GET reflects it', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const agent = await makeAgent(request, u.access_token);

        const patch = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers,
            data: { title: 'Updated Title' },
        });
        expect(patch.status(), `patch body=${await patch.text()}`).toBe(200);
        expect((await patch.json()).title).toBe('Updated Title');

        const reread = await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers })
        ).json();
        expect(reread.title).toBe('Updated Title');
    });

    test('GET /export returns a versioned envelope with identity + runtime', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const agent = await makeAgent(request, u.access_token, 'Exportable Agent');

        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, { headers });
        expect(res.status()).toBe(200);
        const env = await res.json();
        expect(env.version).toBe(1);
        expect(env.meta.sourceAgentId).toBe(agent.id);
        expect(typeof env.meta.exportedAt).toBe('string');
        expect(env.identity.name).toBe('Exportable Agent');
        expect(env.identity.scope).toBe('tenant');
        // The export carries the permission matrix so an import is faithful.
        expect(env.runtime.permissions).toMatchObject({ canSpend: false, canCommitToRepo: false });
    });

    test('GET /attachments is an (initially empty) array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const agent = await makeAgent(request, u.access_token);
        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/attachments`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

test.describe('Agents — archive → hard-delete lifecycle', () => {
    test('soft delete archives (kept for audit, hidden from list); hard delete removes', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const agent = await makeAgent(request, u.access_token, 'Disposable Agent');

        const soft = await request.delete(`${API_BASE}/api/agents/${agent.id}`, { headers });
        expect(soft.status()).toBe(200);
        expect(await soft.json()).toMatchObject({ archived: true });

        // Archived agent is excluded from the default list but still queryable for audit.
        const list = await (await request.get(`${API_BASE}/api/agents`, { headers })).json();
        expect(list.data.find((a: { id: string }) => a.id === agent.id)).toBeUndefined();
        const stillThere = await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers })
        ).json();
        expect(stillThere.status).toBe('archived');

        const hard = await request.delete(`${API_BASE}/api/agents/${agent.id}?hard=true`, {
            headers,
        });
        expect(hard.status()).toBe(200);
        expect(await hard.json()).toMatchObject({ deleted: true });

        const gone = await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers });
        expect([403, 404]).toContain(gone.status());
    });
});

test.describe('Agents — auth gating + isolation', () => {
    test('run endpoints require auth (assign-task, run-now)', async ({ request }) => {
        expect(
            (
                await request.post(`${API_BASE}/api/agents/${UNKNOWN_UUID}/assign-task`, {
                    data: { taskId: UNKNOWN_UUID },
                })
            ).status(),
        ).toBe(401);
        expect(
            (await request.post(`${API_BASE}/api/agents/${UNKNOWN_UUID}/run-now`)).status(),
        ).toBe(401);
    });

    test('a stranger cannot export or patch my agent', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const agent = await makeAgent(request, alice.access_token, 'Private Agent');

        const exp = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(exp.status());
        const patch = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(bob.access_token),
            data: { title: 'hacked' },
        });
        expect([403, 404]).toContain(patch.status());
    });
});
