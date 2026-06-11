import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Task chat messages — DEEP coverage of the thinly-tested
 * `PATCH /api/task-chat-messages/:id` controller (task-chat.controller.ts)
 * and the two `/api/tasks/:id/chat` routes that feed it. Pins the exact
 * request/response CONTRACTS — validation layering, the secret-scan
 * hard-reject, the edit-mutation surface (which columns the edit touches vs
 * leaves alone), list limit/offset clamping edge cases, and the
 * ownership/auth gates on the standalone message route.
 *
 * NON-DUPLICATION — `flow-task-collaboration.spec.ts` already covers the
 * happy comment lifecycle, @agent→AgentRun dispatch, the task_commented
 * audit trail, multi-page tiling, and the broad owner-scoped 404 matrix.
 * This file does NOT repeat those. It instead nails the contracts that
 * spec leaves un-pinned, all live-probed on the e2e driver:
 *
 *   POST /api/tasks/:id/chat (DTO-validated body):
 *     - missing / non-string body → 400 with class-validator ARRAY message
 *       ["body must be shorter than or equal to 16384 characters",
 *        "body must be a string"]  (NOT the bare "body is required.")
 *     - body > 16384 chars → 400 ["body must be shorter than or equal to
 *       16384 characters"]   (DTO @MaxLength, fires before the service)
 *     - whitespace-only body → 400 { message:"Chat body is required." }
 *       (passes the DTO, rejected by TaskChatService.assertBody)
 *     - secret-bearing body (sk-<≥10>) → hard-reject 4xx/5xx (today 500:
 *       assertNoSecrets throws a plain Error not mapped to an
 *       HttpException; tolerant of a hardened 400/422) — the message is
 *       never persisted either way.
 *
 *   PATCH /api/task-chat-messages/:id (TaskChatController.editChat):
 *     - missing / non-string body → 400 { message:"body is required." }
 *       (controller-level guard, distinct STRING message vs the POST DTO)
 *     - whitespace-only body → 400 { message:"Chat body is required." }
 *       (service-level assertBody)
 *     - secret-bearing body → hard-reject 4xx/5xx (same assertNoSecrets, edit path)
 *     - happy edit → 200; returns the FULL refreshed row with the new
 *       body + editedAt set (non-null) + createdAt unchanged.
 *     - editing to DROP a previously-resolved @agent mention → mentions
 *       becomes null, while attachments are PRESERVED verbatim (the edit
 *       only rewrites body+mentions; updateBodyAndMentions never touches
 *       attachments).
 *     - non-uuid id → 400 (ParseUUIDPipe); unknown uuid → 404; cross-user
 *       message → 404 with "Task <id> not found." (the parent-task
 *       ownership guard fires BEFORE the authorship check — never a 403
 *       leak that would confirm the id exists); anon → 401.
 *
 *   GET /api/tasks/:id/chat?limit&offset (TasksController.listChat clamps):
 *     - limit=1 → exactly the single oldest row (oldest-first ordering)
 *     - limit=abc (NaN) AND limit=0 (falsy) BOTH fall through to the
 *       default 50 → full thread returned
 *     - limit=99999 → clamped to the 200 ceiling (still returns all when
 *       thread < 200)
 *     - offset past the end → 200 { data: [] } (empty, never an error)
 *     - non-uuid task id → 400 (ParseUUIDPipe)
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// A token that trips the secret-scan `generic` pattern: sk- + ≥10 [A-Za-z0-9_-].
const SECRET_BODY = 'leaking sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789012345';

interface ChatMessage {
    id: string;
    taskId: string;
    authorType: 'user' | 'agent';
    authorId: string;
    body: string;
    mentions: Array<{ type: 'user' | 'agent' | 'kb'; id?: string; slug?: string }> | null;
    attachments: Array<{ uploadId: string }> | null;
    editedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

async function makeTask(request: APIRequestContext, token: string, title: string): Promise<string> {
    const t = await createTaskViaAPI(request, token, { title });
    return t.id;
}

async function postChat(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: string,
    attachments?: Array<{ uploadId: string }>,
): Promise<{ status: number; json: ChatMessage }> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/chat`, {
        headers: authedHeaders(token),
        data: attachments ? { body, attachments } : { body },
    });
    return { status: res.status(), json: (await res.json().catch(() => ({}))) as ChatMessage };
}

async function listChat(
    request: APIRequestContext,
    token: string,
    taskId: string,
    query = '',
): Promise<{ status: number; data: ChatMessage[] }> {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}/chat${query}`, {
        headers: authedHeaders(token),
    });
    const body = (await res.json().catch(() => ({ data: [] }))) as { data?: ChatMessage[] };
    return { status: res.status(), data: body.data ?? [] };
}

async function editChat(
    request: APIRequestContext,
    token: string,
    messageId: string,
    body: unknown,
): Promise<{ status: number; raw: string }> {
    const res = await request.patch(`${API_BASE}/api/task-chat-messages/${messageId}`, {
        headers: authedHeaders(token),
        data: typeof body === 'object' && body !== null ? body : { body },
    });
    return { status: res.status(), raw: await res.text().catch(() => '') };
}

/** Seed a task with `n` ordered messages, returning their bodies in post order. */
async function seedThread(
    request: APIRequestContext,
    token: string,
    taskId: string,
    n: number,
): Promise<string[]> {
    const bodies: string[] = [];
    for (let i = 1; i <= n; i++) {
        const body = `thread-line-${i}`;
        const { status } = await postChat(request, token, taskId, body);
        expect(status, `seed post #${i}`).toBe(201);
        bodies.push(body);
    }
    return bodies;
}

test.describe('Task chat messages — PATCH /task-chat-messages/:id + chat route contracts', () => {
    // ── POST /api/tasks/:id/chat — DTO + service validation layering ──

    test('1) POST rejects a missing body with the class-validator ARRAY message (DTO layer)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'post-missing-body');
        const res = await request.post(`${API_BASE}/api/tasks/${taskId}/chat`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status()).toBe(400);
        const json = (await res.json()) as { message: string[] };
        // DTO validation yields an ARRAY of messages, not the bare string the
        // PATCH controller returns — these are different surfaces.
        expect(Array.isArray(json.message)).toBe(true);
        expect(json.message).toContain('body must be a string');
    });

    test('2) POST rejects a body over 16384 chars at the DTO @MaxLength (before the service)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'post-too-long');
        const res = await request.post(`${API_BASE}/api/tasks/${taskId}/chat`, {
            headers: authedHeaders(u.access_token),
            data: { body: 'x'.repeat(17000) },
        });
        expect(res.status()).toBe(400);
        const json = (await res.json()) as { message: string[] };
        expect(json.message).toContain('body must be shorter than or equal to 16384 characters');
    });

    test('3) POST rejects a whitespace-only body at the service layer with "Chat body is required."', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'post-whitespace');
        const { status, json } = await postChat(request, u.access_token, taskId, '   ');
        expect(status).toBe(400);
        expect((json as unknown as { message: string }).message).toBe('Chat body is required.');
    });

    test('4) POST with a secret-bearing body is hard-rejected and never persists the message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'post-secret');
        const { status } = await postChat(request, u.access_token, taskId, SECRET_BODY);
        // The security invariant is "hard-reject + never persist". The live
        // status today is 500 (assertNoSecrets throws a plain Error), but a
        // hardened 400/422 is equally correct — match the established
        // tolerance from flow-agent-instruction-files-deep.spec.ts so this
        // survives the assertNoSecrets→BadRequestException fix. The one thing
        // that must NEVER happen is a silent 2xx that persists the secret.
        expect(status).toBeGreaterThanOrEqual(400);
        expect([400, 422, 500]).toContain(status);
        const { data } = await listChat(request, u.access_token, taskId);
        expect(data).toEqual([]);
    });

    // ── PATCH /api/task-chat-messages/:id — validation ──

    test('5) PATCH rejects a missing/non-string body with the controller STRING message "body is required."', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'edit-missing-body');
        const { json } = await postChat(request, u.access_token, taskId, 'original');
        // Missing body key.
        const missing = await request.patch(`${API_BASE}/api/task-chat-messages/${json.id}`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(missing.status()).toBe(400);
        expect((await missing.json()).message).toBe('body is required.');
        // Non-string body (number) — same controller guard.
        const nonString = await request.patch(`${API_BASE}/api/task-chat-messages/${json.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: 123 },
        });
        expect(nonString.status()).toBe(400);
        expect((await nonString.json()).message).toBe('body is required.');
    });

    test('6) PATCH rejects a whitespace-only body at the service layer with "Chat body is required."', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'edit-whitespace');
        const { json } = await postChat(request, u.access_token, taskId, 'original');
        const res = await request.patch(`${API_BASE}/api/task-chat-messages/${json.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: '   ' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe('Chat body is required.');
    });

    test('7) PATCH with a secret-bearing new body is hard-rejected; the prior body is untouched', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'edit-secret');
        const { json } = await postChat(request, u.access_token, taskId, 'safe original');
        const res = await editChat(request, u.access_token, json.id, SECRET_BODY);
        // Hard-reject invariant (4xx today via 500, tolerant of a hardened
        // 400/422 — see test 4's comment).
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect([400, 422, 500]).toContain(res.status);
        // The reject is pre-persist: the stored row still has the safe body.
        const { data } = await listChat(request, u.access_token, taskId);
        const row = data.find((m) => m.id === json.id);
        expect(row?.body).toBe('safe original');
        expect(row?.editedAt).toBeNull();
    });

    // ── PATCH — successful edit mutation surface ──

    test('8) PATCH happy path returns the full refreshed row: new body + editedAt set + createdAt preserved', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'edit-happy');
        const { json: posted } = await postChat(request, u.access_token, taskId, 'before edit');
        expect(posted.editedAt).toBeNull();

        const res = await request.patch(`${API_BASE}/api/task-chat-messages/${posted.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: 'after edit' },
        });
        expect(res.status(), await res.text().catch(() => '')).toBe(200);
        const edited = (await res.json()) as ChatMessage;
        expect(edited.id).toBe(posted.id);
        expect(edited.body).toBe('after edit');
        expect(edited.editedAt).not.toBeNull();
        // createdAt is immutable across an edit; only editedAt advances.
        expect(edited.createdAt).toBe(posted.createdAt);
        expect(edited.authorType).toBe('user');
        expect(edited.authorId).toBe(u.user.id);
    });

    test('9) PATCH that drops a resolved @agent mention nulls `mentions` but PRESERVES `attachments`', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Chat Edit Reviewer ${test.info().title.length}-${Date.now().toString(36)}`,
        });
        const taskId = await makeTask(request, u.access_token, 'edit-drop-mention');

        const { status, json: posted } = await postChat(
            request,
            u.access_token,
            taskId,
            `please look @${agent.slug}`,
            [{ uploadId: NIL_UUID }],
        );
        expect(status).toBe(201);
        expect((posted.mentions ?? []).map((m) => m.id)).toEqual([agent.id]);
        expect(posted.attachments).toEqual([{ uploadId: NIL_UUID }]);

        // Edit body so it no longer mentions the agent.
        const res = await request.patch(`${API_BASE}/api/task-chat-messages/${posted.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: 'never mind, handling it myself' },
        });
        expect(res.status()).toBe(200);
        const edited = (await res.json()) as ChatMessage;
        // mentions re-parse to empty → stored as null.
        expect(edited.mentions).toBeNull();
        // attachments are NOT part of the edit mutation → preserved verbatim.
        expect(edited.attachments).toEqual([{ uploadId: NIL_UUID }]);

        // Re-read confirms persistence (not just the returned object).
        const { data } = await listChat(request, u.access_token, taskId);
        const row = data.find((m) => m.id === posted.id);
        expect(row?.mentions).toBeNull();
        expect(row?.attachments).toEqual([{ uploadId: NIL_UUID }]);
    });

    // ── PATCH — id / ownership / auth gates ──

    test('10) PATCH rejects a non-uuid id with 400 (ParseUUIDPipe) and an unknown uuid with 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const badId = await editChat(request, u.access_token, 'definitely-not-a-uuid', {
            body: 'x',
        });
        expect(badId.status).toBe(400);
        const missing = await editChat(request, u.access_token, NIL_UUID, { body: 'x' });
        expect(missing.status).toBe(404);
    });

    test('11) PATCH on another user\'s message → 404 "Task <id> not found." (ownership guard fires before authorship — no existence leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const taskId = await makeTask(request, owner.access_token, 'edit-cross-user');
        const { json } = await postChat(request, owner.access_token, taskId, 'owner only');

        const res = await request.patch(`${API_BASE}/api/task-chat-messages/${json.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { body: 'hijack attempt' },
        });
        // 404 (not 403): the parent-task ownership guard throws first, so the
        // stranger cannot even confirm the message id exists.
        expect(res.status()).toBe(404);
        expect((await res.json()).message).toBe(`Task ${taskId} not found.`);

        // The owner's row is untouched by the failed cross-user edit.
        const { data } = await listChat(request, owner.access_token, taskId);
        expect(data[0].body).toBe('owner only');
        expect(data[0].editedAt).toBeNull();
    });

    test('12) PATCH without any Authorization is rejected with 401 before reaching the handler', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'edit-anon');
        const { json } = await postChat(request, u.access_token, taskId, 'original');

        // Raw fetch with NO cookies / NO bearer — independent of any
        // storageState the `request` fixture might carry.
        const anonCtx = await pwRequest.newContext();
        const res = await anonCtx.patch(`${API_BASE}/api/task-chat-messages/${json.id}`, {
            data: { body: 'anon edit' },
        });
        expect(res.status()).toBe(401);
        await anonCtx.dispose();
    });

    // ── GET /api/tasks/:id/chat — limit / offset clamping ──

    test('13) GET clamps limit edge cases: limit=1 yields the single oldest row; NaN and 0 fall through to the default', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'list-limit-clamp');
        const bodies = await seedThread(request, u.access_token, taskId, 5);

        // limit=1 → exactly the oldest message (oldest-first ordering).
        const one = await listChat(request, u.access_token, taskId, '?limit=1');
        expect(one.status).toBe(200);
        expect(one.data.length).toBe(1);
        expect(one.data[0].body).toBe(bodies[0]);

        // limit=abc → parseInt NaN → falsy → default 50 → full thread.
        const nan = await listChat(request, u.access_token, taskId, '?limit=abc');
        expect(nan.data.length).toBe(5);
        // limit=0 → falsy → ALSO default 50 (it is NOT clamped to 1) → full thread.
        const zero = await listChat(request, u.access_token, taskId, '?limit=0');
        expect(zero.data.length).toBe(5);
        // limit=99999 → clamped to the 200 ceiling; thread < 200 so all 5 return.
        const huge = await listChat(request, u.access_token, taskId, '?limit=99999');
        expect(huge.data.length).toBe(5);
    });

    test('14) GET applies offset (windowing oldest-first) and returns an empty array past the end; non-uuid task id → 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const taskId = await makeTask(request, u.access_token, 'list-offset');
        const bodies = await seedThread(request, u.access_token, taskId, 5);

        // offset=1 limit=2 → the 2nd & 3rd oldest rows, in order.
        const window = await listChat(request, u.access_token, taskId, '?limit=2&offset=1');
        expect(window.data.map((m) => m.body)).toEqual([bodies[1], bodies[2]]);

        // offset beyond the end → 200 with an empty data array (not an error).
        const beyond = await listChat(request, u.access_token, taskId, '?limit=10&offset=99');
        expect(beyond.status).toBe(200);
        expect(beyond.data).toEqual([]);

        // Malformed task id on the list route → 400 (ParseUUIDPipe).
        const bad = await request.get(`${API_BASE}/api/tasks/not-a-uuid/chat`, {
            headers: authedHeaders(u.access_token),
        });
        expect(bad.status()).toBe(400);
    });
});
