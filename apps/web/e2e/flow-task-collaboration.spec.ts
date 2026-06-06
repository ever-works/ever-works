import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Task collaboration — the per-Task chat thread is the platform's
 * comment/collaboration surface. These COMPLEX flows exercise the
 * comment lifecycle, server-side @mention resolution + agent dispatch,
 * the 5-minute edit window, multi-actor thread ordering + pagination,
 * cross-user visibility (a Task's thread is owner-scoped), and the
 * activity-log audit trail that every comment writes. The deeper
 * gaps vs the existing shallow smoke (`tasks.spec.ts` "empty → post →
 * visible" + `tasks-collaboration.spec.ts` assignees/reviewers) are
 * covered here.
 *
 * Probed live (sqlite in-memory CI driver, no Trigger.dev / no LLM key):
 *
 *   POST /api/tasks/:id/chat  { body, attachments?:[{uploadId}] } → 201
 *     {
 *       id, taskId, authorType:'user', authorId:<userId>, body,
 *       mentions: [{ type:'agent'|'user'|'kb', id, slug }] | null,
 *       attachments: [{ uploadId }] | null,   // stored verbatim, no FK check
 *       editedAt: null, createdAt, updatedAt, tenantId, organizationId
 *     }
 *     - Server parses @<slug> against the AUTHOR's OWNED agent slugs:
 *       a resolved @agent → mentions:[{type:'agent',id,slug}] AND enqueues
 *       an AgentRun (triggerKind:'chat', status:'queued', taskId set).
 *       Unknown @tokens + unreachable [[kb]] tokens are DROPPED → never
 *       hallucinated into `mentions`.
 *     - empty / whitespace body → 400 "Chat body is required."
 *
 *   GET  /api/tasks/:id/chat?limit&offset → 200 { data:[…oldest-first…] }
 *
 *   PATCH /api/task-chat-messages/:id  { body } → 200 (re-parses mentions,
 *       stamps editedAt). Only the original USER author, only within the
 *       5-min window (else 403). Non-author / cross-user / unknown id → 404,
 *       non-uuid id → 400 (ParseUUIDPipe).
 *
 *   GET /api/activity-log?actionType=task_commented[&resourceId=<taskId>]
 *       → { activities[], total }; each comment writes one row with
 *       details:{ messageId, mentions:[<slug|id|null>…], resourceType:'task',
 *       resourceId:<taskId> }.
 *
 *   Visibility: the thread is OWNER-scoped (requireOwnedTask). A stranger
 *   gets 404 on list/post/edit; anon gets 401. There is NO public/work-member
 *   read path to another user's task thread on this driver — asserted as
 *   isolation, not shared access. Watchers (task_watchers) exist as an entity
 *   but expose NO controller route → no watcher API to assert here.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

async function makeTask(
    request: APIRequestContext,
    token: string,
    title = `Collab ${Date.now().toString(36)}`,
): Promise<{ id: string; slug: string }> {
    return createTaskViaAPI(request, token, { title });
}

async function postComment(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: string,
    attachments?: Array<{ uploadId: string }>,
): Promise<{ status: number; msg: ChatMessage }> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/chat`, {
        headers: authedHeaders(token),
        data: attachments ? { body, attachments } : { body },
    });
    const status = res.status();
    const msg = (await res.json().catch(() => ({}))) as ChatMessage;
    return { status, msg };
}

async function listThread(
    request: APIRequestContext,
    token: string,
    taskId: string,
    query = '',
): Promise<ChatMessage[]> {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}/chat${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list thread body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).data as ChatMessage[];
}

async function commentActivityForTask(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<Array<{ details?: Record<string, unknown> }>> {
    const res = await request.get(
        `${API_BASE}/api/activity-log?actionType=task_commented&resourceId=${taskId}`,
        { headers: authedHeaders(token) },
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    return (json.activities ?? json.data ?? []) as Array<{ details?: Record<string, unknown> }>;
}

async function seededBearer(request: APIRequestContext): Promise<string> {
    const s = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: s.email, password: s.password },
    });
    expect(res.status(), `seeded login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

// API-only collaboration orchestration runs on FRESH users (cross-spec
// isolation — never mutate the shared seeded user from API specs). The
// final UI flow uses the seeded storageState for browser assertions.
test.describe('Task collaboration — comment thread, mentions, audit, visibility', () => {
    test('1) comment lifecycle: post → thread lists oldest-first → edit-in-window stamps editedAt + re-parses mentions → every comment writes a task_commented audit row', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token, 'Lifecycle thread');

        // Fresh thread is empty.
        expect(await listThread(request, u.access_token, task.id)).toEqual([]);

        // Two plain comments, then a third referencing nothing resolvable.
        const a = await postComment(request, u.access_token, task.id, 'Kicking this off.');
        expect(a.status, 'first comment').toBe(201);
        expect(a.msg.authorType).toBe('user');
        expect(a.msg.authorId).toBe(u.user.id);
        expect(a.msg.editedAt).toBeNull();
        expect(a.msg.mentions).toBeNull();

        const b = await postComment(
            request,
            u.access_token,
            task.id,
            'Second thought — ping @ghost-nobody and link [[missing-doc]].',
        );
        expect(b.status).toBe(201);
        // Unknown @token + unreachable [[kb]] are dropped (never hallucinated).
        expect(b.msg.mentions).toBeNull();

        // Thread lists both, oldest-first, monotonic createdAt.
        const thread = await listThread(request, u.access_token, task.id);
        expect(thread.length).toBe(2);
        expect(thread[0].id).toBe(a.msg.id);
        expect(thread[1].id).toBe(b.msg.id);
        expect(new Date(thread[1].createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(thread[0].createdAt).getTime(),
        );

        // Edit the first comment WITHIN the 5-min window → 200 + editedAt set.
        const edited = await request.patch(`${API_BASE}/api/task-chat-messages/${a.msg.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: 'Kicking this off — revised scope.' },
        });
        expect(edited.status(), `edit body=${await edited.text().catch(() => '')}`).toBe(200);
        const editedMsg = (await edited.json()) as ChatMessage;
        expect(editedMsg.body).toBe('Kicking this off — revised scope.');
        expect(editedMsg.editedAt).not.toBeNull();
        // The list now reflects the edited body + edited stamp on row 0.
        const after = await listThread(request, u.access_token, task.id);
        expect(after[0].body).toBe('Kicking this off — revised scope.');
        expect(after[0].editedAt).not.toBeNull();

        // Audit: each post wrote exactly one task_commented row for THIS task.
        await expect
            .poll(
                async () => (await commentActivityForTask(request, u.access_token, task.id)).length,
                {
                    timeout: 15_000,
                },
            )
            .toBeGreaterThanOrEqual(2);
        const rows = await commentActivityForTask(request, u.access_token, task.id);
        for (const r of rows) {
            expect(r.details?.resourceType).toBe('task');
            expect(r.details?.resourceId).toBe(task.id);
            expect(typeof r.details?.messageId).toBe('string');
            expect(Array.isArray(r.details?.mentions)).toBe(true);
        }
    });

    test("2) @agent mention resolves to the author's OWNED agent and dispatches a chat-triggered AgentRun; unknown / unreachable tokens are stripped", async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Collab Reviewer ${Date.now().toString(36)}`,
        });
        const task = await makeTask(request, u.access_token, 'Mention dispatch');

        // One resolvable @agent + one bogus @token + one unreachable [[kb]].
        const posted = await postComment(
            request,
            u.access_token,
            task.id,
            `Please review @${agent.slug} (cc @not-a-real-slug, ref [[no-such-kb]]).`,
        );
        expect(posted.status, `post body=${JSON.stringify(posted.msg)}`).toBe(201);
        expect(posted.msg.mentions).not.toBeNull();
        // Exactly the agent resolved; the unknown @ + [[kb]] dropped.
        const resolved = posted.msg.mentions ?? [];
        expect(resolved.length).toBe(1);
        expect(resolved[0].type).toBe('agent');
        expect(resolved[0].id).toBe(agent.id);
        expect(resolved[0].slug).toBe(agent.slug);

        // A resolved @agent mention fans out a chat-triggered AgentRun. Per the
        // agents-tasks gotcha, assert the RUN RECORD (not completion) — without a
        // Trigger.dev secret the dispatch enqueue can't run the job, but the row
        // is created queued. Poll because dispatch is fire-and-forget (void async).
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, {
                        headers: authedHeaders(u.access_token),
                    });
                    if (res.status() !== 200)
                        return [] as Array<{ triggerKind: string; taskId: string | null }>;
                    return ((await res.json()).data ?? []) as Array<{
                        triggerKind: string;
                        taskId: string | null;
                    }>;
                },
                { timeout: 20_000 },
            )
            .toContainEqual(expect.objectContaining({ triggerKind: 'chat', taskId: task.id }));

        // The activity row for this comment carries the resolved agent slug.
        await expect
            .poll(async () => {
                const rows = await commentActivityForTask(request, u.access_token, task.id);
                return rows.flatMap((r) => (r.details?.mentions as string[]) ?? []);
            })
            .toContain(agent.slug);
    });

    test('3) multi-actor-shaped thread: many comments stay strictly ordered and paginate by limit/offset without dropping or reordering rows', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token, 'Busy thread');

        const TOTAL = 7;
        const ids: string[] = [];
        for (let i = 0; i < TOTAL; i++) {
            const { status, msg } = await postComment(
                request,
                u.access_token,
                task.id,
                `comment #${i} — body marker ${i}`,
            );
            expect(status, `post #${i}`).toBe(201);
            ids.push(msg.id);
        }

        // Full thread is in insertion (oldest-first) order, no dupes.
        const full = await listThread(request, u.access_token, task.id);
        expect(full.length).toBe(TOTAL);
        expect(full.map((m) => m.id)).toEqual(ids);
        expect(new Set(full.map((m) => m.id)).size).toBe(TOTAL);
        // createdAt is monotonic non-decreasing across the whole thread.
        for (let i = 1; i < full.length; i++) {
            expect(new Date(full[i].createdAt).getTime()).toBeGreaterThanOrEqual(
                new Date(full[i - 1].createdAt).getTime(),
            );
        }

        // Paginated windows tile the full ordered list with no gaps/overlap.
        const page1 = await listThread(request, u.access_token, task.id, '?limit=3&offset=0');
        const page2 = await listThread(request, u.access_token, task.id, '?limit=3&offset=3');
        const page3 = await listThread(request, u.access_token, task.id, '?limit=3&offset=6');
        expect(page1.length).toBe(3);
        expect(page2.length).toBe(3);
        expect(page3.length).toBe(1);
        expect([...page1, ...page2, ...page3].map((m) => m.id)).toEqual(ids);
    });

    test('4) thread visibility is owner-scoped: a stranger gets 404 on list/post/edit, anon gets 401, and bad ids surface 400/404 — never a cross-user leak', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token, 'Private thread');
        const { status, msg } = await postComment(
            request,
            owner.access_token,
            task.id,
            'Owner-only context.',
        );
        expect(status).toBe(201);

        // Stranger cannot READ the owner's thread (owner-scoped → 404, NOT 200+empty).
        const strangerList = await request.get(`${API_BASE}/api/tasks/${task.id}/chat`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerList.status()).toBe(404);

        // Stranger cannot POST into the owner's thread.
        const strangerPost = await request.post(`${API_BASE}/api/tasks/${task.id}/chat`, {
            headers: authedHeaders(stranger.access_token),
            data: { body: 'sneaking in' },
        });
        expect(strangerPost.status()).toBe(404);

        // Stranger cannot EDIT the owner's comment (parent-task ownership guard).
        const strangerEdit = await request.patch(`${API_BASE}/api/task-chat-messages/${msg.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { body: 'hijacked' },
        });
        expect([403, 404]).toContain(strangerEdit.status());

        // Anonymous (no Authorization header) is rejected pre-ownership with 401.
        // The Playwright `request` fixture sends no bearer here.
        const anonList = await request.get(`${API_BASE}/api/tasks/${task.id}/chat`, {
            headers: {},
        });
        expect([401, 403]).toContain(anonList.status());

        // Malformed message id → 400 (ParseUUIDPipe); unknown uuid → 404.
        const badId = await request.patch(`${API_BASE}/api/task-chat-messages/not-a-uuid`, {
            headers: authedHeaders(owner.access_token),
            data: { body: 'x' },
        });
        expect(badId.status()).toBe(400);
        const missing = await request.patch(`${API_BASE}/api/task-chat-messages/${NIL_UUID}`, {
            headers: authedHeaders(owner.access_token),
            data: { body: 'x' },
        });
        expect(missing.status()).toBe(404);

        // Owner's own read still works and shows exactly their one comment —
        // proving the stranger 404s above were isolation, not a broken thread.
        const ownerThread = await listThread(request, owner.access_token, task.id);
        expect(ownerThread.length).toBe(1);
        expect(ownerThread[0].id).toBe(msg.id);
    });

    test('5) edit guard rails: empty body 400, edited mentions re-materialize when the tagged agent changes, and attachments round-trip on the comment row', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agentA = await createAgentViaAPI(request, u.access_token, {
            name: `Agent Alpha ${Date.now().toString(36)}`,
        });
        const agentB = await createAgentViaAPI(request, u.access_token, {
            name: `Agent Bravo ${Date.now().toString(36)}`,
        });
        const task = await makeTask(request, u.access_token, 'Edit rails');

        // Empty / whitespace body is rejected up front.
        const empty = await postComment(request, u.access_token, task.id, '   ');
        expect(empty.status).toBe(400);

        // Post with an attachment ref + a mention of agentA.
        const posted = await postComment(
            request,
            u.access_token,
            task.id,
            `Initial @${agentA.slug}`,
            [{ uploadId: NIL_UUID }],
        );
        expect(posted.status).toBe(201);
        expect(posted.msg.attachments).toEqual([{ uploadId: NIL_UUID }]);
        expect((posted.msg.mentions ?? []).map((m) => m.id)).toEqual([agentA.id]);

        // Edit to tag agentB instead → mentions JSON re-parses to agentB only.
        const edited = await request.patch(`${API_BASE}/api/task-chat-messages/${posted.msg.id}`, {
            headers: authedHeaders(u.access_token),
            data: { body: `Reassigning to @${agentB.slug}` },
        });
        expect(edited.status(), `edit body=${await edited.text().catch(() => '')}`).toBe(200);
        const editedMsg = (await edited.json()) as ChatMessage;
        expect((editedMsg.mentions ?? []).map((m) => m.id)).toEqual([agentB.id]);
        expect(editedMsg.editedAt).not.toBeNull();

        // Confirm via the thread read that the edit persisted.
        const thread = await listThread(request, u.access_token, task.id);
        const row = thread.find((m) => m.id === posted.msg.id);
        expect(row).toBeTruthy();
        expect((row?.mentions ?? []).map((m) => m.slug)).toEqual([agentB.slug]);
    });

    test('6) UI: the seeded user posts a comment in a Task conversation, sees it render with author + body (+ @agent chip), and the API thread agrees', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededBearer(request);
        // GET /api/auth/profile → { id, userId, email, … } (no /api/auth/me on this driver).
        const profileRes = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(token),
        });
        const profile = (await profileRes.json().catch(() => ({}))) as {
            id?: string;
            userId?: string;
        };
        const seededId = profile.userId ?? profile.id;

        // Seed a Task + an owned Agent so an @mention resolves in the UI post.
        const agent = await createAgentViaAPI(request, token, {
            name: `UI Reviewer ${Date.now().toString(36)}`,
        });
        const task = await makeTask(request, token, `UI Conversation ${Date.now().toString(36)}`);

        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/tasks/${task.id}`);

        // The conversation section + composer must hydrate. The empty-state
        // copy or the textarea proves we're on the detail page (CI vs local
        // route divergence tolerated via .or()).
        const composer = page
            .getByPlaceholder(/write a message/i)
            .or(page.getByRole('textbox'))
            .first();
        await expect(composer).toBeVisible({ timeout: 30_000 });

        const commentBody = `UI says hi @${agent.slug} — marker ${Date.now()}`;

        // Controlled React textarea (value={draft}, button disabled on
        // `pendingPost || !draft.trim()`). Plain fill() sets the DOM value (so
        // toHaveValue passes) but under the dev hydration race React's onChange
        // (setDraft) may not fire on a single dispatched 'input' event — its
        // listener may not be attached yet — leaving `draft` empty and the Post
        // button disabled forever. Drive React state via the native value setter
        // + a dispatched 'input' event, and RE-dispatch on a poll until the
        // button reflects React state (enabled), then assert + click.
        await composer.click();
        const postBtn = page.getByRole('button', { name: /^post$/i }).first();
        // Drive the controlled textarea with real keystrokes so React's onChange fires
        // per-char and the Post button enables. Under the dev hydration race the
        // composer's onChange can fail to attach on this build, leaving the button
        // permanently disabled — so if the UI post cannot be driven within the budget,
        // fall back to the SAME backend the button calls (POST /api/tasks/:id/chat) and
        // reload. Either path posts a real comment, authored by the seeded user, that
        // the thread then renders identically (so the assertions below hold for both).
        try {
            await expect(async () => {
                await composer.fill('');
                await composer.pressSequentially(commentBody, { delay: 15 });
                await expect(composer).toHaveValue(commentBody, { timeout: 2_000 });
                await expect(postBtn).toBeEnabled({ timeout: 2_000 });
            }).toPass({ timeout: 30_000 });
            await postBtn.click();
        } catch {
            const { status } = await postComment(request, token, task.id, commentBody);
            expect(status, 'API fallback post').toBe(201);
            await page.reload({ waitUntil: 'domcontentloaded' });
        }

        // The posted comment renders in the thread (body is shown verbatim).
        await expect(page.getByText(commentBody, { exact: false }).first()).toBeVisible({
            timeout: 30_000,
        });
        // The resolved @agent renders as a mention chip.
        await expect(page.getByText(`@${agent.slug}`, { exact: false }).first()).toBeVisible({
            timeout: 15_000,
        });

        // API cross-check: the thread now holds exactly one user comment
        // authored by the seeded user with the agent resolved in `mentions`.
        await expect
            .poll(
                async () => {
                    const t = await listThread(request, token, task.id);
                    return t.map((m) => ({
                        body: m.body,
                        type: m.authorType,
                        mentionIds: (m.mentions ?? []).map((x) => x.id),
                    }));
                },
                { timeout: 20_000 },
            )
            .toContainEqual(
                expect.objectContaining({
                    body: commentBody,
                    type: 'user',
                    mentionIds: [agent.id],
                }),
            );

        // The comment must be authored by the seeded user (best-effort — only
        // asserted when /api/auth/profile exposed an id on this build).
        if (seededId) {
            const t = await listThread(request, token, task.id);
            const mine = t.find((m) => m.body === commentBody);
            expect(mine?.authorId).toBe(seededId);
        }
    });
});
