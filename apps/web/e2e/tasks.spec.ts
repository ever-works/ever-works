import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { loginViaAPI } from './helpers/auth';

/**
 * Tasks — deep coverage of the Task-tracking feature (Agents/Skills/Tasks
 * build). The feature had ZERO dedicated e2e specs before this file; the
 * assertions here are pinned against the live API shapes (verified on a
 * running stack), not the permissive `status < 500` smoke pattern.
 *
 * API surface (`apps/api/src/tasks/*`):
 *   - GET    /api/tasks                 list (+ status/priority/scope/label/search filters, pagination)
 *   - POST   /api/tasks                 create (auto slug `T-<n>`, status defaults to `backlog`)
 *   - GET    /api/tasks/:id             get one (cross-user 404)
 *   - PATCH  /api/tasks/:id             partial update
 *   - DELETE /api/tasks/:id             delete
 *   - POST   /api/tasks/:id/transition  status state-machine (rejects illegal hops with 400)
 *   - GET/POST /api/tasks/:id/chat      flat chat thread
 *
 * UI (`apps/web/.../tasks/*` + components/tasks/*):
 *   - /tasks            list (cards/table/kanban + status filter)
 *   - /tasks/new        create form (title/description/priority/labels)
 *   - /tasks/:id        detail (status transitions + chat)
 *
 * The UI tests run authenticated via the storageState from global-setup
 * (the default `chromium` project). The API-contract tests register their
 * own isolated users so they don't depend on the seeded session.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Tasks — API contract', () => {
    test('GET /api/tasks without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/tasks`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/tasks without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/tasks`, { data: { title: 'x' } });
        expect(res.status()).toBe(401);
    });

    test('GET /api/tasks for a fresh user → empty {data, meta}', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBe(0);
    });

    test('POST /api/tasks creates with slug + backlog default + echoed fields', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const createRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: {
                title: 'Ship the launch checklist',
                description: 'all the things',
                priority: 'p1',
                labels: ['launch', 'urgent'],
            },
        });
        expect(createRes.status(), `create body=${await createRes.text()}`).toBe(201);
        const task = await createRes.json();

        expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(task.slug).toMatch(/^T-\d+$/);
        expect(task.title).toBe('Ship the launch checklist');
        expect(task.description).toBe('all the things');
        expect(task.priority).toBe('p1');
        expect(task.labels).toEqual(['launch', 'urgent']);
        // New tasks always start in `backlog`, created by a human (not an agent).
        expect(task.status).toBe('backlog');
        expect(task.createdByType).toBe('user');

        // It shows up in the owner's list.
        const listRes = await request.get(`${API_BASE}/api/tasks`, { headers });
        const list = await listRes.json();
        expect(list.data.find((t: { id: string }) => t.id === task.id)).toBeTruthy();
    });

    test('GET /api/tasks honours status filter + pagination meta', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        await request.post(`${API_BASE}/api/tasks`, { headers, data: { title: 'A backlog task' } });

        // A fresh user has no `todo` tasks yet → empty page, meta echoes the query.
        const res = await request.get(`${API_BASE}/api/tasks?status=todo&limit=5`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBe(0);
        expect(body.meta).toMatchObject({ total: 0, limit: 5, offset: 0 });
    });

    test('transition: valid chain backlog → todo → in_progress → in_review → done', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Walk the state machine' },
            })
        ).json();
        expect(task.status).toBe('backlog');

        for (const to of ['todo', 'in_progress', 'in_review', 'done'] as const) {
            const res = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
                headers,
                data: { to },
            });
            expect(res.status(), `transition to ${to} body=${await res.text()}`).toBe(200);
            expect((await res.json()).status).toBe(to);
        }
    });

    test('transition: illegal hop todo → done is rejected 400 (state machine enforced server-side)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Cannot skip review' },
            })
        ).json();

        await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
            headers,
            data: { to: 'todo' },
        });
        const res = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
            headers,
            data: { to: 'done' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toMatch(/cannot transition/i);
    });

    test('chat: empty thread → post → message visible with author + body', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Discuss the plan' },
            })
        ).json();

        const before = await request.get(`${API_BASE}/api/tasks/${task.id}/chat`, { headers });
        expect(before.status()).toBe(200);
        expect((await before.json()).data).toEqual([]);

        const postRes = await request.post(`${API_BASE}/api/tasks/${task.id}/chat`, {
            headers,
            data: { body: 'Kicking this off — who can own it?' },
        });
        expect(postRes.status()).toBe(201);
        const msg = await postRes.json();
        expect(msg.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(msg.authorType).toBe('user');
        expect(msg.body).toBe('Kicking this off — who can own it?');

        const after = await request.get(`${API_BASE}/api/tasks/${task.id}/chat`, { headers });
        const afterData = (await after.json()).data;
        expect(afterData.length).toBe(1);
        expect(afterData[0].body).toBe('Kicking this off — who can own it?');
    });

    test('scoping: ?missionId filters to the owning mission', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: 'Scope mission', description: 'owns a task', type: 'one-shot' },
            })
        ).json();

        const scoped = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Mission-scoped task', missionId: mission.id },
            })
        ).json();
        expect(scoped.missionId).toBe(mission.id);

        // Also create an unscoped task to prove the filter actually filters.
        await request.post(`${API_BASE}/api/tasks`, { headers, data: { title: 'Unscoped task' } });

        const filtered = await request.get(`${API_BASE}/api/tasks?missionId=${mission.id}`, {
            headers,
        });
        expect(filtered.status()).toBe(200);
        const ids = (await filtered.json()).data.map((t: { id: string }) => t.id);
        expect(ids).toContain(scoped.id);
        expect(ids.length).toBe(1);

        // Unknown mission → empty.
        const none = await request.get(`${API_BASE}/api/tasks?missionId=${UNKNOWN_UUID}`, {
            headers,
        });
        expect((await none.json()).data.length).toBe(0);
    });

    test('cross-user isolation: another user gets 403/404 on my task', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers: authedHeaders(alice.access_token),
                data: { title: "Alice's private task" },
            })
        ).json();

        const res = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('DELETE removes the task (subsequent GET → 404)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, { headers, data: { title: 'Delete me' } })
        ).json();

        const del = await request.delete(`${API_BASE}/api/tasks/${task.id}`, { headers });
        expect([200, 204]).toContain(del.status());

        const after = await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers });
        expect([403, 404]).toContain(after.status());
    });
});

test.describe('Tasks — UI (authenticated as the seeded user)', () => {
    test('/tasks/new renders the form, creates a task, and lands on its detail page', async ({
        page,
    }) => {
        await page.goto('/tasks/new', { waitUntil: 'domcontentloaded' });
        // Let dev-mode hydration finish before typing — otherwise an early
        // fill() lands in the DOM before React attaches its onChange and the
        // controlled `title` state stays empty (Create button stuck disabled).
        await page.waitForLoadState('networkidle');

        // Accessible name comes from the placeholder ("Add a task title").
        const titleInput = page.getByRole('textbox', { name: 'Add a task title' });
        await expect(titleInput).toBeVisible();

        const unique = `E2E UI task ${Date.now().toString(36)}`;
        await titleInput.click();
        await titleInput.pressSequentially(unique, { delay: 15 });
        await expect(titleInput).toHaveValue(unique);

        // Scope to the form's Create button by name — the dashboard chrome
        // also renders a global chat composer with its own submit button.
        const submit = page.getByRole('button', { name: 'Create', exact: true });
        await expect(submit).toBeEnabled();
        await submit.click();

        // Routes to ROUTES.DASHBOARD_TASK(id) — /tasks/<uuid> (locale prefix optional).
        await page.waitForURL(/\/(en\/)?tasks\/[0-9a-f-]{36}/, { timeout: 60_000 });
        await expect(page.getByText(unique).first()).toBeVisible();
    });

    test('a task created via API for the seeded user appears on /tasks', async ({
        page,
        request,
    }) => {
        // Create the task as the SAME user the browser is authenticated as,
        // so it shows up in this session's list (cross-layer: API write → UI read).
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(page.url() || 'http://localhost:3000', {
            email: seeded.email,
            password: seeded.password,
        });
        const unique = `E2E list task ${Date.now().toString(36)}`;
        const createRes = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(access_token),
            data: { title: unique },
        });
        expect(createRes.status()).toBe(201);

        await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 30_000 });
    });
});
