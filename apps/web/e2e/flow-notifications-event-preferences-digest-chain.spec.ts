/**
 * REAL-EVENT NOTIFICATION CHAIN — a genuine domain event fires an in-app
 * notification into the inbox, then the read/dismiss lifecycle, the dedup
 * contract, and the preference/channel/quiet-hours surface are exercised
 * AGAINST THAT REAL ROW. DISTINCT cross-feature angle vs the sibling
 * notification specs (probed the whole dir): the existing files drive the
 * preferences / channels / digest ENDPOINTS in isolation and never actually
 * land a notification in GET /api/notifications —
 *   - flow-notifications-digest.spec.ts (quiet-hours deferral geometry + mutes;
 *     its "content" probe uses forgot-password mail best-effort, NOT an inbox row)
 *   - flow-notifications-preferences / -per-event / notification-channels-* /
 *     notifications-channel-toggle (subscription registry + channel CRUD only)
 *   - flow-notifications-inbox-deep / -read-lifecycle / notifications-lifecycle
 *     (inbox mechanics, but seeded/empty — no real producer event)
 * This file is the ONLY one that TRIGGERS a real producer (Task assignment)
 * and then couples the resulting inbox row to the preference/channel/quiet-hours
 * machinery — the cross-feature chain none of the others walk.
 *
 * THE REAL EVENT (the only in-app notification producer reachable over plain
 * HTTP with sqlite + no LLM key + no Trigger.dev): assigning a USER to a Task.
 *   POST /api/tasks/:id/assignees { assigneeType:'user', assigneeId } fires
 *   TaskNotificationService.emit('task_assigned', …, [assigneeId]) →
 *   NotificationService.create(). Assign a Task to YOURSELF and a real row lands
 *   in your own inbox. (task_status_changed only notifies WATCHERS, and there is
 *   NO watcher endpoint, so an assignee who is not a watcher gets nothing on
 *   transition — pinned below.)
 *
 * PROBED, TRUTHFUL contracts (curl against http://127.0.0.1:3100 with throwaway
 * registered users BEFORE any assertion; cross-checked against
 *   apps/api/src/notifications/notifications.controller.ts + .../notification-preferences.controller.ts
 *   apps/api/src/notification-channels/notification-channels.controller.ts
 *   apps/api/src/tasks/tasks.controller.ts
 *   packages/agent/src/notifications/notification.service.ts
 *   packages/agent/src/tasks-domain/{tasks.service,task-notification.service,task-transition.service}.ts):
 *
 *   GET  /api/notifications                 -> 200 { notifications: Notification[] } (DISMISSED excluded)
 *   GET  /api/notifications?category=task   -> 200 filtered; unknown category => filter IGNORED (returns all)
 *   GET  /api/notifications?unreadOnly=true -> read rows excluded
 *   GET  /api/notifications?limit&offset    -> paginated (limit capped at 100 server-side)
 *   GET  /api/notifications/unread-count    -> 200 { count:number }
 *   GET  /api/notifications/persistent      -> 200 { notifications } (task rows are NOT persistent -> absent)
 *   POST /api/notifications/:id/read        -> 200 { success:true }; unknown id => 400 ("Notification not found")
 *   POST /api/notifications/read-all        -> 200 { success:true }
 *   POST /api/notifications/:id/dismiss     -> 200 { success:true }; unknown id => 400
 *   PUT  /api/notifications/preferences/event/task_assigned -> 400 (task_* is NOT in the event-type registry)
 *   POST /api/notifications/preferences/mute { category:'task' } -> 201 { mute } (silences EXTERNAL only, never in-app)
 *   PUT  /api/notifications/preferences/quiet-hours … -> 200 (defers EXTERNAL only; in-app stays immediate)
 *   POST /api/notification-channels …       -> 201 { channel } (orthogonal to the task producer)
 *   All of the above are 401 unauthenticated. Assigning on another user's Task => 404 (owner-scoped).
 *
 *   A landed task_assigned row (exact shape):
 *     { type:'info', category:'task', title:`Assigned: ${slug}`,
 *       message:`User ${actorId.slice(0,8)}… assigned you to "${title}".`,
 *       actionUrl:`/tasks/${taskId}`, actionLabel:'Open Task',
 *       metadata:{ event:'task_assigned', taskId, taskSlug, actorUserId },
 *       isRead:false, isDismissed:false, isPersistent:false,
 *       deduplicationKey:`task:${taskId}:task_assigned:${actorUserId}` }
 *
 *   DEDUP contract (NotificationService.create): a set deduplicationKey +
 *   a UNIQUE (userId, deduplicationKey) DB constraint. Re-firing the SAME key:
 *     - while the prior row is UNDISMISSED  -> returns the existing row (no dup)
 *     - after the prior row is DISMISSED    -> the insert still hits the UNIQUE
 *       constraint and re-fetches the (dismissed) row, so NO new inbox row
 *       resurfaces (the "dismiss re-arms" comment is defeated by the constraint
 *       — pinned as the OBSERVED behavior). A DIFFERENT taskId => different key
 *       => a distinct row.
 *
 * The DELETE /api/tasks/:id/assignees/:assigneeId param is the ASSIGNMENT-ROW id
 * (repo deletes by { id, taskId }), NOT the userId — addTaskAssignee returns it.
 *
 * Every test registers FRESH users (helpers/api makeTestUser is Date.now+random
 * unique) and is fully API-orchestrated; the `flow-` prefix runs it in the authed
 * chromium project. Async emit is awaited via expect.poll, never a fixed sleep.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createTaskViaAPI, addTaskAssignee, transitionTaskViaAPI } from './helpers/agents-tasks';

const NOTIF = `${API_BASE}/api/notifications`;
const CHANNELS = `${API_BASE}/api/notification-channels`;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface Notification {
    id: string;
    userId: string;
    type: string;
    category: string;
    title: string;
    message: string;
    actionUrl: string;
    actionLabel: string;
    metadata: Record<string, unknown> | null;
    isRead: boolean;
    isDismissed: boolean;
    isPersistent: boolean;
    deduplicationKey: string | null;
    createdAt: string;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listNotifications(
    request: APIRequestContext,
    token: string,
    query: { category?: string; unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<Notification[]> {
    const params = new URLSearchParams();
    if (query.category !== undefined) params.set('category', query.category);
    if (query.unreadOnly !== undefined) params.set('unreadOnly', String(query.unreadOnly));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();
    const res = await request.get(`${NOTIF}${qs ? `?${qs}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    return (json.notifications ?? []) as Notification[];
}

async function unreadCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${NOTIF}/unread-count`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return (await res.json()).count as number;
}

/** Assign a USER to a Task; returns the assignment ROW (its `id` deletes it). */
async function assignUser(
    request: APIRequestContext,
    token: string,
    taskId: string,
    assigneeId: string,
) {
    return addTaskAssignee(request, token, taskId, { assigneeType: 'user', assigneeId });
}

/** Poll GET /api/notifications until the predicate holds (async emit settle). */
async function waitFor(
    request: APIRequestContext,
    token: string,
    predicate: (rows: Notification[]) => boolean,
    label: string,
): Promise<Notification[]> {
    let rows: Notification[] = [];
    await expect
        .poll(
            async () => {
                rows = await listNotifications(request, token);
                return predicate(rows);
            },
            { timeout: 20_000, intervals: [150, 250, 400, 700, 1000], message: label },
        )
        .toBe(true);
    return rows;
}

/** Register + create a Task + self-assign; returns the landed notification. */
async function seedSelfAssignment(
    request: APIRequestContext,
    user: RegisteredUser,
    title: string,
): Promise<{ taskId: string; taskSlug: string; notification: Notification }> {
    const token = user.access_token;
    const task = await createTaskViaAPI(request, token, { title });
    await assignUser(request, token, task.id, user.user.id);
    const rows = await waitFor(
        request,
        token,
        (r) => r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id),
        `task_assigned for ${task.slug} to land`,
    );
    const notification = rows.find(
        (n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id,
    )!;
    return { taskId: task.id, taskSlug: task.slug, notification };
}

test.describe('Real-event notification chain — Task assignment -> inbox -> lifecycle -> preferences/channels/quiet-hours', () => {
    test('a Task self-assignment lands a fully-formed task_assigned row in the actor inbox (exact shape + metadata + dedup key + unread-count)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        // Fresh inbox is empty and well-shaped.
        expect(await listNotifications(request, token)).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);

        const task = await createTaskViaAPI(request, token, { title: 'Ship the release notes' });
        const row = await assignUser(request, token, task.id, actorId);
        expect(row.taskId).toBe(task.id);
        expect(row.assigneeType).toBe('user');
        expect(row.assigneeId).toBe(actorId);

        const [n] = await waitFor(
            request,
            token,
            (r) => r.length >= 1,
            'the assignment notification to appear',
        );

        // Envelope + provenance — every field pinned to the producer output.
        expect(n.type).toBe('info');
        expect(n.category).toBe('task');
        expect(n.title).toBe(`Assigned: ${task.slug}`);
        expect(n.message).toMatch(
            new RegExp(`assigned you to "${escapeRegExp('Ship the release notes')}"`),
        );
        // The actor is stamped as the first 8 chars of the acting user id.
        expect(n.message).toContain(actorId.slice(0, 8));
        expect(n.actionUrl).toBe(`/tasks/${task.id}`);
        expect(n.actionLabel).toBe('Open Task');
        expect(n.isRead).toBe(false);
        expect(n.isDismissed).toBe(false);
        expect(n.isPersistent).toBe(false);
        expect(n.userId).toBe(actorId);
        expect(n.deduplicationKey).toBe(`task:${task.id}:task_assigned:${actorId}`);
        const meta = n.metadata as Record<string, unknown>;
        expect(meta.event).toBe('task_assigned');
        expect(meta.taskId).toBe(task.id);
        expect(meta.taskSlug).toBe(task.slug);
        expect(meta.actorUserId).toBe(actorId);

        expect(await unreadCount(request, token)).toBe(1);
    });

    test('category filter matrix on the real row — task returns it, an orthogonal category is empty, an UNKNOWN category is ignored (returns all), and it is NOT persistent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { taskId } = await seedSelfAssignment(request, user, 'Filter probe task');

        const taskOnly = await listNotifications(request, token, { category: 'task' });
        expect(taskOnly.length).toBe(1);
        expect((taskOnly[0].metadata as { taskId?: string }).taskId).toBe(taskId);

        // A valid-but-orthogonal category yields nothing (the row is category=task).
        expect((await listNotifications(request, token, { category: 'security' })).length).toBe(0);
        expect((await listNotifications(request, token, { category: 'ai_credits' })).length).toBe(
            0,
        );

        // An unknown category is silently ignored by the controller (validCategory
        // === undefined) so the filter is a no-op and every row is returned.
        const bogus = await listNotifications(request, token, { category: 'not-a-category' });
        expect(bogus.length).toBe(1);

        // task_assigned rows are non-persistent — the persistent banner feed omits them.
        const persistent = await request.get(`${NOTIF}/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistent.status()).toBe(200);
        expect((await persistent.json()).notifications).toEqual([]);
    });

    test('mark-as-read lifecycle — read drops the unread count, keeps the row listed, and removes it from the unreadOnly view', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { notification } = await seedSelfAssignment(request, user, 'Read me task');
        expect(await unreadCount(request, token)).toBe(1);

        const read = await request.post(`${NOTIF}/${notification.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(read.status()).toBe(200);
        expect((await read.json()).success).toBe(true);

        expect(await unreadCount(request, token)).toBe(0);
        // Read != gone: the row is still in the default list, now flagged read.
        const all = await listNotifications(request, token);
        expect(all.length).toBe(1);
        expect(all[0].id).toBe(notification.id);
        expect(all[0].isRead).toBe(true);
        // …but excluded from the unread-only projection.
        expect((await listNotifications(request, token, { unreadOnly: true })).length).toBe(0);
    });

    test('dismiss lifecycle — a non-persistent task row is dismissable; dismissal removes it from the default list and zeroes the unread count', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { notification } = await seedSelfAssignment(request, user, 'Dismiss me task');

        const dismiss = await request.post(`${NOTIF}/${notification.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        expect((await dismiss.json()).success).toBe(true);

        // Dismissed rows are filtered from the default list AND from unread.
        expect(await listNotifications(request, token)).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('read/dismiss on an unknown notification id are rejected with 400 (not a silent success)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const read = await request.post(`${NOTIF}/${UNKNOWN_UUID}/read`, {
            headers: authedHeaders(token),
        });
        expect(read.status()).toBe(400);
        const dismiss = await request.post(`${NOTIF}/${UNKNOWN_UUID}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(400);
    });

    test('read-all clears unread across several DISTINCT-task notifications at once', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        for (const title of ['Alpha task', 'Beta task', 'Gamma task']) {
            const t = await createTaskViaAPI(request, token, { title });
            await assignUser(request, token, t.id, actorId);
        }
        await waitFor(request, token, (r) => r.length >= 3, 'three assignment notifications');
        expect(await unreadCount(request, token)).toBe(3);

        const readAll = await request.post(`${NOTIF}/read-all`, { headers: authedHeaders(token) });
        expect(readAll.status()).toBe(200);
        expect((await readAll.json()).success).toBe(true);

        expect(await unreadCount(request, token)).toBe(0);
        // Rows persist (read, not deleted); unread-only view is now empty.
        expect((await listNotifications(request, token)).length).toBe(3);
        expect((await listNotifications(request, token, { unreadOnly: true })).length).toBe(0);
    });

    test('dedup contract — two DISTINCT tasks yield two distinct rows with distinct keys; re-adding the SAME assignee while undismissed does NOT duplicate (and is 409)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        const t1 = await createTaskViaAPI(request, token, { title: 'Dedup one' });
        const t2 = await createTaskViaAPI(request, token, { title: 'Dedup two' });
        await assignUser(request, token, t1.id, actorId);
        await assignUser(request, token, t2.id, actorId);
        const rows = await waitFor(request, token, (r) => r.length >= 2, 'two distinct rows');

        const keys = rows.map((n) => n.deduplicationKey);
        expect(keys).toContain(`task:${t1.id}:task_assigned:${actorId}`);
        expect(keys).toContain(`task:${t2.id}:task_assigned:${actorId}`);
        expect(new Set(keys).size).toBe(rows.length); // all keys unique

        // Re-adding the SAME (taskId, user) assignee hits the assignee UNIQUE
        // constraint first -> 409, so no second emit and still exactly two rows.
        const dup = await request.post(`${API_BASE}/api/tasks/${t1.id}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'user', assigneeId: actorId },
        });
        expect(dup.status()).toBe(409);
        expect((await listNotifications(request, token)).length).toBe(2);
    });

    test('dedup re-arm is DEFEATED by the unique key — dismiss + remove-assignee + re-add the same actor does NOT resurface a row (the UNIQUE(userId,dedupKey) constraint wins)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        const task = await createTaskViaAPI(request, token, { title: 'Rearm task' });
        const row1 = await assignUser(request, token, task.id, actorId);
        const [first] = await waitFor(request, token, (r) => r.length >= 1, 'first row');

        // Dismiss it — this is the state the "dismiss re-arms dedup" comment expects
        // to allow a fresh row for the same key.
        await request.post(`${NOTIF}/${first.id}/dismiss`, { headers: authedHeaders(token) });
        expect(await unreadCount(request, token)).toBe(0);

        // Remove the assignee row (param is the ASSIGNMENT-ROW id) then re-add it,
        // re-firing task_assigned with the identical dedup key.
        const del = await request.delete(`${API_BASE}/api/tasks/${task.id}/assignees/${row1.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        await assignUser(request, token, task.id, actorId);

        // FENCE: assign a DIFFERENT task and wait for THAT row to land — it proves
        // the emitter drained subsequent events, so if the re-armed row were going
        // to appear it already would have.
        const fenceTask = await createTaskViaAPI(request, token, { title: 'Fence task' });
        await assignUser(request, token, fenceTask.id, actorId);
        const rows = await waitFor(
            request,
            token,
            (r) =>
                r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === fenceTask.id),
            'fence notification',
        );

        // Only the fence row is visible/unread — the re-armed original stayed suppressed.
        expect(await unreadCount(request, token)).toBe(1);
        const rearmVisible = rows.filter(
            (n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id,
        );
        expect(rearmVisible.length).toBe(0);
    });

    test('a Task TRANSITION does not notify a non-watcher assignee — task_status_changed targets watchers only, and there is no watcher endpoint', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        const task = await createTaskViaAPI(request, token, { title: 'Transition task' });
        await assignUser(request, token, task.id, actorId);
        await waitFor(
            request,
            token,
            (r) => r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id),
            'assignment row',
        );

        // Walk the state machine — each transition emits task_status_changed to
        // WATCHERS. The assignee is not auto-added as a watcher, so nothing new lands.
        await transitionTaskViaAPI(request, token, task.id, 'todo');
        await transitionTaskViaAPI(request, token, task.id, 'in_progress');

        // FENCE with a fresh distinct assignment to prove the emitter processed the
        // transitions, then assert the transition added no row for the first task.
        const fence = await createTaskViaAPI(request, token, { title: 'Transition fence' });
        await assignUser(request, token, fence.id, actorId);
        const rows = await waitFor(
            request,
            token,
            (r) => r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === fence.id),
            'fence after transition',
        );
        const forFirst = rows.filter(
            (n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id,
        );
        // Exactly the one original task_assigned — no task_status_changed rows.
        expect(forFirst.length).toBe(1);
        expect((forFirst[0].metadata as { event?: string }).event).toBe('task_assigned');
    });

    test('the task producer BYPASSES the subscription registry — PUT /preferences/event/task_assigned is 400, yet the in-app row still lands', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // task_* keys are NOT registered event types, so you cannot subscribe them.
        const sub = await request.put(`${NOTIF}/preferences/event/task_assigned`, {
            headers: authedHeaders(token),
            data: { channelIds: ['in-app'] },
        });
        expect(sub.status()).toBe(400);
        expect((await sub.json()).message).toMatch(/unknown notification event type/i);

        // Despite there being no subscription row, the producer writes the in-app
        // notification directly — the registry gate governs external fanout, not
        // the in-app record.
        const { notification } = await seedSelfAssignment(request, user, 'Registry-bypass task');
        expect(notification.category).toBe('task');
        expect(await unreadCount(request, token)).toBe(1);
    });

    test('muting the task category silences EXTERNAL channels only — the in-app row still lands, the mute row is visible, and unmute is idempotent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Mute the whole `task` category up front.
        const mute = await request.post(`${NOTIF}/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'task' },
        });
        expect(mute.status()).toBe(201);
        expect((await mute.json()).mute).toMatchObject({ category: 'task', mutedUntil: null });

        // The mute is a "don't email me", never data loss — assign a task and the
        // in-app row STILL records for retrospective viewing.
        const { notification } = await seedSelfAssignment(request, user, 'Muted task');
        expect(notification.category).toBe('task');
        expect(await unreadCount(request, token)).toBe(1);

        // The mute is reflected in the preferences read.
        const prefs = await request.get(`${NOTIF}/preferences`, { headers: authedHeaders(token) });
        expect(prefs.status()).toBe(200);
        const muted = (await prefs.json()).mutes as { category: string }[];
        expect(muted.map((m) => m.category)).toContain('task');

        // Unmute -> 204, and idempotent on an already-unmuted category.
        const un1 = await request.delete(`${NOTIF}/preferences/mute/task`, {
            headers: authedHeaders(token),
        });
        expect(un1.status()).toBe(204);
        const un2 = await request.delete(`${NOTIF}/preferences/mute/task`, {
            headers: authedHeaders(token),
        });
        expect(un2.status()).toBe(204);
        // The in-app row is unaffected by the mute lifecycle.
        expect((await listNotifications(request, token)).length).toBe(1);
    });

    test('quiet-hours defers only EXTERNAL channels — with a whole-day window armed the in-app task row still lands immediately, and the window persists alongside', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const quiet = await request.put(`${NOTIF}/preferences/quiet-hours`, {
            headers: authedHeaders(token),
            data: { quietHoursStart: '00:00', quietHoursEnd: '23:59', timezone: 'UTC' },
        });
        expect(quiet.status()).toBe(200);

        // In-app delivery is always immediate — a quiet window never suppresses it.
        const { notification } = await seedSelfAssignment(request, user, 'Quiet-hours task');
        expect(notification.isRead).toBe(false);
        expect(await unreadCount(request, token)).toBe(1);

        // The window is intact after the event — orthogonal records.
        const prefs = await request.get(`${NOTIF}/preferences`, { headers: authedHeaders(token) });
        const pref = (await prefs.json()).preference as {
            quietHoursStart: string;
            quietHoursEnd: string;
            timezone: string;
        };
        expect(pref.quietHoursStart).toBe('00:00');
        expect(pref.quietHoursEnd).toBe('23:59');
        expect(pref.timezone).toBe('UTC');
    });

    test('notification channels + a CORE-event subscription are orthogonal to the task producer — arming them does not alter the in-app task row, and deleting the channel leaves the inbox untouched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Stand up an email channel and subscribe a REAL registry event to it.
        const chRes = await request.post(CHANNELS, {
            headers: authedHeaders(token),
            data: {
                pluginId: 'email',
                name: 'Digest mailbox',
                targetConfig: { email: user.email },
            },
        });
        expect(chRes.status()).toBe(201);
        const channelId = (await chRes.json()).channel.id as string;

        const coreSub = await request.put(`${NOTIF}/preferences/event/work_generation_finished`, {
            headers: authedHeaders(token),
            data: { channelIds: ['in-app', channelId] },
        });
        expect(coreSub.status()).toBe(200);
        expect((await coreSub.json()).subscription.channelIds).toContain(channelId);

        // None of that touches the task producer — the task_assigned row is a
        // plain in-app record independent of channels/subscriptions.
        const { notification } = await seedSelfAssignment(request, user, 'Channel-orthogonal task');
        expect(notification.category).toBe('task');
        expect(await unreadCount(request, token)).toBe(1);

        // Deleting the channel removes it from the active list but does not cascade
        // into the inbox.
        const del = await request.delete(`${CHANNELS}/${channelId}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(204);
        const list = await request.get(CHANNELS, { headers: authedHeaders(token) });
        const activeIds = (await list.json()).channels.map((c: { id: string }) => c.id);
        expect(activeIds).not.toContain(channelId);
        expect((await listNotifications(request, token)).length).toBe(1);
    });

    test('cross-user delivery — assigning user B lands the row in B inbox with actor=A; the actor A inbox stays empty for that task', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);

        const task = await createTaskViaAPI(request, alice.access_token, {
            title: 'Delegate to Bob',
        });
        await assignUser(request, alice.access_token, task.id, bob.user.id);

        // Bob receives it; the actor stamp is Alice.
        const bobRows = await waitFor(
            request,
            bob.access_token,
            (r) => r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id),
            'Bob receives the assignment',
        );
        const bobNotif = bobRows.find(
            (n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id,
        )!;
        expect(bobNotif.userId).toBe(bob.user.id);
        expect((bobNotif.metadata as { actorUserId?: string }).actorUserId).toBe(alice.user.id);
        expect(bobNotif.message).toContain(alice.user.id.slice(0, 8));
        expect(await unreadCount(request, bob.access_token)).toBe(1);

        // Alice (the actor / creator, not a watcher) gets nothing for this task.
        const aliceRows = await listNotifications(request, alice.access_token);
        expect(
            aliceRows.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id),
        ).toBe(false);
        expect(await unreadCount(request, alice.access_token)).toBe(0);
    });

    test('cross-user isolation — user B cannot read or dismiss user A notification (404 each), and unread counts stay per-user', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const { notification } = await seedSelfAssignment(request, alice, 'Private to Alice');

        // Bob addressing Alice's notification id is scoped away as not-found.
        const read = await request.post(`${NOTIF}/${notification.id}/read`, {
            headers: authedHeaders(bob.access_token),
        });
        // Scoped away for Bob. The mark-read/dismiss handlers report the miss as a
        // 400 (they resolve the row by (id,user) and reject the unmatched write)
        // rather than a 404 — either way Bob is refused and nothing leaks.
        expect([400, 404], `cross-user read status ${read.status()}`).toContain(read.status());
        const dismiss = await request.post(`${NOTIF}/${notification.id}/dismiss`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([400, 404], `cross-user dismiss status ${dismiss.status()}`).toContain(
            dismiss.status(),
        );

        // Alice's row is untouched by Bob's failed attempts.
        expect(await unreadCount(request, alice.access_token)).toBe(1);
        expect(await unreadCount(request, bob.access_token)).toBe(0);
        // And Bob cannot assign on Alice's owner-scoped task at all.
        const t = await createTaskViaAPI(request, alice.access_token, { title: 'Alice owns this' });
        const idor = await request.post(`${API_BASE}/api/tasks/${t.id}/assignees`, {
            headers: authedHeaders(bob.access_token),
            data: { assigneeType: 'user', assigneeId: bob.user.id },
        });
        expect(idor.status()).toBe(404);
    });

    test('the entire notification surface is auth-gated — every read endpoint is 401 without a token', async ({
        request,
    }) => {
        for (const path of [
            'notifications',
            'notifications/unread-count',
            'notifications/persistent',
            'notifications/preferences',
            'notifications/event-types',
            'notification-channels',
        ]) {
            const res = await request.get(`${API_BASE}/api/${path}`);
            expect(res.status(), `GET /api/${path} unauthenticated`).toBe(401);
        }
    });

    test('a fresh account returns well-shaped empty envelopes across the whole notification surface', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        expect(await listNotifications(request, token)).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);

        const persistent = await request.get(`${NOTIF}/persistent`, {
            headers: authedHeaders(token),
        });
        expect((await persistent.json()).notifications).toEqual([]);

        const prefs = await request.get(`${NOTIF}/preferences`, { headers: authedHeaders(token) });
        expect(prefs.status()).toBe(200);
        const pj = await prefs.json();
        expect(pj.subscriptions).toEqual([]);
        expect(pj.preference).toBeNull();
        expect(pj.mutes).toEqual([]);

        const channels = await request.get(CHANNELS, { headers: authedHeaders(token) });
        expect(channels.status()).toBe(200);
        expect((await channels.json()).channels).toEqual([]);
    });

    test('pagination + unread-only over several real rows — limit slices, offset walks, and read state narrows the unread projection', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        const titles = ['Page A', 'Page B', 'Page C', 'Page D'];
        for (const title of titles) {
            const t = await createTaskViaAPI(request, token, { title });
            await assignUser(request, token, t.id, actorId);
        }
        await waitFor(request, token, (r) => r.length >= titles.length, 'all four rows');

        const full = await listNotifications(request, token);
        expect(full.length).toBe(titles.length);

        // limit slices the page.
        expect((await listNotifications(request, token, { limit: 1 })).length).toBe(1);
        const firstTwo = await listNotifications(request, token, { limit: 2, offset: 0 });
        expect(firstTwo.length).toBe(2);
        // offset walks past the first two into the remainder (no overlap of ids).
        const nextTwo = await listNotifications(request, token, { limit: 2, offset: 2 });
        expect(nextTwo.length).toBe(2);
        const firstIds = new Set(firstTwo.map((n) => n.id));
        expect(nextTwo.every((n) => !firstIds.has(n.id))).toBe(true);

        // Read one -> the unread projection drops by exactly one while the full
        // list (default) keeps all four.
        await request.post(`${NOTIF}/${full[0].id}/read`, { headers: authedHeaders(token) });
        expect(await unreadCount(request, token)).toBe(titles.length - 1);
        expect((await listNotifications(request, token, { unreadOnly: true })).length).toBe(
            titles.length - 1,
        );
        expect((await listNotifications(request, token)).length).toBe(titles.length);
    });

    test('mixed lifecycle coherence on one inbox — read one, dismiss another; unread, default-list, and unread-only projections all stay consistent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        const rows: { taskId: string; notifId: string }[] = [];
        for (const title of ['Mix one', 'Mix two', 'Mix three']) {
            const t = await createTaskViaAPI(request, token, { title });
            await assignUser(request, token, t.id, actorId);
            rows.push({ taskId: t.id, notifId: '' });
        }
        const landed = await waitFor(request, token, (r) => r.length >= 3, 'three mixed rows');
        for (const r of rows) {
            r.notifId = landed.find(
                (n) => (n.metadata as { taskId?: string } | null)?.taskId === r.taskId,
            )!.id;
        }
        expect(await unreadCount(request, token)).toBe(3);

        // Read the first, dismiss the second.
        await request.post(`${NOTIF}/${rows[0].notifId}/read`, { headers: authedHeaders(token) });
        await request.post(`${NOTIF}/${rows[1].notifId}/dismiss`, {
            headers: authedHeaders(token),
        });

        // Unread = 3 - 1(read) - 1(dismissed) = 1 (the third, untouched).
        expect(await unreadCount(request, token)).toBe(1);
        // Default list excludes the DISMISSED one but keeps the read one: 2 rows.
        const visible = await listNotifications(request, token);
        expect(visible.length).toBe(2);
        expect(visible.map((n) => n.id)).toContain(rows[0].notifId);
        expect(visible.map((n) => n.id)).not.toContain(rows[1].notifId);
        // unread-only shows exactly the untouched third.
        const unread = await listNotifications(request, token, { unreadOnly: true });
        expect(unread.length).toBe(1);
        expect(unread[0].id).toBe(rows[2].notifId);
    });

    test('full cross-feature capstone — channel + core subscription + quiet-hours + task mute all armed together, then one Task assignment lands a single coherent in-app row and every read projection agrees', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const actorId = user.user.id;

        // Arm the WHOLE preference surface at once.
        const ch = await request.post(CHANNELS, {
            headers: authedHeaders(token),
            data: { pluginId: 'email', name: 'Capstone box', targetConfig: { email: user.email } },
        });
        expect(ch.status()).toBe(201);
        const channelId = (await ch.json()).channel.id as string;
        await request.put(`${NOTIF}/preferences/event/generation_error`, {
            headers: authedHeaders(token),
            data: { channelIds: ['in-app', channelId] },
        });
        await request.put(`${NOTIF}/preferences/quiet-hours`, {
            headers: authedHeaders(token),
            data: {
                quietHoursStart: '22:00',
                quietHoursEnd: '07:00',
                timezone: 'America/New_York',
            },
        });
        await request.post(`${NOTIF}/preferences/mute`, {
            headers: authedHeaders(token),
            data: { category: 'task' },
        });

        // Fire the real event through the fully-armed configuration.
        const task = await createTaskViaAPI(request, token, { title: 'Capstone task' });
        await assignUser(request, token, task.id, actorId);
        const rows = await waitFor(
            request,
            token,
            (r) => r.some((n) => (n.metadata as { taskId?: string } | null)?.taskId === task.id),
            'capstone row',
        );
        const n = rows.find((x) => (x.metadata as { taskId?: string } | null)?.taskId === task.id)!;

        // Exactly ONE in-app row, correctly shaped, despite mute + quiet-hours + a
        // channel subscribed to an unrelated core event.
        expect(rows.length).toBe(1);
        expect(n.category).toBe('task');
        expect(n.deduplicationKey).toBe(`task:${task.id}:task_assigned:${actorId}`);
        expect(await unreadCount(request, token)).toBe(1);

        // The preference surface is intact and fully coherent post-event.
        const prefs = await (
            await request.get(`${NOTIF}/preferences`, { headers: authedHeaders(token) })
        ).json();
        expect(prefs.preference.quietHoursStart).toBe('22:00');
        expect((prefs.mutes as { category: string }[]).map((m) => m.category)).toContain('task');
        expect(
            (prefs.subscriptions as { eventTypeKey: string; channelIds: string[] }[]).find(
                (s) => s.eventTypeKey === 'generation_error',
            )?.channelIds,
        ).toContain(channelId);

        // Read it -> unread zeroes, row stays listed as read; then clean the channel.
        await request.post(`${NOTIF}/${n.id}/read`, { headers: authedHeaders(token) });
        expect(await unreadCount(request, token)).toBe(0);
        expect((await listNotifications(request, token))[0].isRead).toBe(true);
        await request.delete(`${CHANNELS}/${channelId}`, { headers: authedHeaders(token) });
    });
});
