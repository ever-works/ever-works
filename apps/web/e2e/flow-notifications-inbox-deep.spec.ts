import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createTaskViaAPI, addTaskAssignee } from './helpers/agents-tasks';

/**
 * Notifications INBOX — POPULATED-ROW read/count/dismiss ROUND-TRIP (deep).
 *
 * Theme: the sibling notification specs almost all carry the same DEVIATION —
 * "there is no public endpoint to mint an in-app row, so we can only assert the
 * empty-inbox contract" — and stop at a fresh user's zero state. But there IS a
 * keyless, deterministic in-app producer reachable from the public API:
 *   POST /api/tasks/:id/assignees { assigneeType:'user', assigneeId:<self> }
 * fires TaskNotificationService.emit('task_assigned') and writes a REAL
 * `category:'task'` notification row for the assignee. flow-notifications-per-
 * event.spec.ts already pins the PRODUCER shape of that row. This file goes the
 * other way: it USES that producer to stand up a POPULATED inbox and then drives
 * the full READER contract on real rows — the exact transitions the bell + inbox
 * page consume — which NO sibling exercises end-to-end:
 *   produce → unread-count INCREMENTS → mark one read → count DECREMENTS by one →
 *   read row stays in default list (isRead=true) but leaves ?unreadOnly=true →
 *   read-all drives count to 0 without dismissing → dismiss removes the row from
 *   the list → cross-user 400 on a REAL foreign id → category routing of `task`.
 *
 * PROBED LIVE (curl against http://127.0.0.1:3100, sqlite in-memory CI driver)
 * before every assertion. Confirmed exact contract on REAL produced rows:
 *
 *   producing a row (self-assign a freshly-created task):
 *     POST /api/tasks                         -> 201 { id, slug:'T-n', … }
 *     POST /api/tasks/:id/assignees           -> 201 (assigneeType:'user')
 *       => within ~1-2s a row lands in GET /api/notifications:
 *          { category:'task', type:'info', isRead:false, isDismissed:false,
 *            isPersistent:false, title:`Assigned: T-n`,
 *            deduplicationKey:`task:<taskId>:task_assigned:<userId>` }
 *       => GET /api/notifications/unread-count.count increments by exactly 1.
 *
 *   reader transitions on the real row:
 *     POST /api/notifications/:id/read        -> 200 { success:true }
 *       => count DECREMENTS by 1; the row STAYS in GET /api/notifications with
 *          isRead=true (read does NOT remove it); it LEAVES ?unreadOnly=true.
 *       => re-reading the SAME id is idempotent (200, count unchanged).
 *     POST /api/notifications/read-all        -> 200 { success:true }
 *       => count -> 0; ALL list rows now isRead=true; read-all does NOT dismiss
 *          (the rows remain in the default undismissed list).
 *     POST /api/notifications/:id/dismiss     -> 200 { success:true }
 *       => the row LEAVES GET /api/notifications (undismissedOnly); persistent
 *          endpoint stays empty (task rows are non-persistent); re-reading a
 *          DISMISSED id is STILL 200 (the owner-scoped lookup still finds it —
 *          probed; markAsRead never checks isDismissed).
 *
 *   category routing (controller maps the raw query through the
 *   NotificationCategory enum, see notifications.controller.ts):
 *     ?category=task returns the produced rows even though `task` is NOT in the
 *     controller's @ApiQuery enum (ai_credits|subscription|generation|system|
 *     security) — `task` IS a NotificationCategory value, so the data layer
 *     filters by it. ?category=system (a valid enum value) therefore EXCLUDES the
 *     task rows (returns 0 for a task-only inbox). An UNKNOWN value not in the enum
 *     (e.g. totally_bogus) resolves to validCategory=undefined → NO filter → the
 *     FULL list comes back (the unknown value is ignored, never a 400/empty).
 *
 *   cross-user on a REAL id (the strong isolation case the empty-inbox specs
 *   cannot make — here the row genuinely EXISTS for A):
 *     B POST /api/notifications/<A's real id>/read     -> 400 "Notification not found"
 *     B POST /api/notifications/<A's real id>/dismiss  -> 400 "Notification not found"
 *       (findByIdAndUserId scopes to the caller; a foreign-but-existing id is the
 *        SAME 400 as a non-existent id — no 403 that would confirm A's row.) B's
 *       own count stays 0 throughout; A's row survives B's failed verbs.
 *
 * NON-DUPLICATION (verified by reading the siblings first):
 *   - flow-notifications-read-lifecycle.spec.ts  → EMPTY-inbox count/dismiss
 *     contract + the bell UI; explicitly documents it cannot produce a row.
 *   - flow-notifications-bulk.spec.ts            → pagination envelope / junk
 *     params / read-all idempotency on an EMPTY inbox + bell parity.
 *   - flow-notifications-cross-user.spec.ts      → isolation via activity-log
 *     attribution + BOGUS foreign ids (never a real foreign notification id).
 *   - flow-notifications-per-event.spec.ts       → the PRODUCER side: exact
 *     task_assigned row shape, dedup, mute-doesn't-suppress, event-type registry.
 *   - flow-notifications-preferences / -digest / -realtime / -per-event → prefs,
 *     channels, fanout, event subscriptions — not the reader round-trip.
 *   This file is the only one that drives the READER state machine on REAL,
 *   populated rows (produce → read → count-decrement → read-all → dismiss) and
 *   the cross-user 400 on a genuinely-existing foreign id.
 *
 * Cross-spec isolation: every flow registers FRESH users via registerUserViaAPI
 * (unique email per test, derived from the test title — never a module-scope
 * clock). All assertions are scoped to a user's own freshly-produced rows; the
 * shared seeded storageState user is never touched. Counts converge with
 * expect.poll to tolerate the contended shared in-memory DB / throttler.
 */

const BOGUS_ID = '00000000-0000-0000-0000-000000000000';
const PRODUCE_TIMEOUT = 20_000;

interface NotificationRow {
    id: string;
    userId: string;
    type: string;
    category: string;
    title: string;
    message: string;
    isRead: boolean;
    isDismissed: boolean;
    isPersistent: boolean;
    metadata?: { event?: string; taskId?: string; taskSlug?: string } | null;
    deduplicationKey?: string | null;
    createdAt: string;
}

async function listNotifications(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<NotificationRow[]> {
    const res = await request.get(`${API_BASE}/api/notifications${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()).notifications ?? []) as NotificationRow[];
}

async function unreadCount(request: APIRequestContext, token: string): Promise<number> {
    let count = -1;
    await expect(async () => {
        const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), `unread-count status ${res.status()}`).toBe(200);
        count = (await res.json()).count as number;
    }).toPass({ timeout: 30_000 });
    return count;
}

/** Poll the unread count until it satisfies `predicate`, tolerating the lagging
 * shared in-memory DB / throttle, then return the settled value. */
async function expectCountToConverge(
    request: APIRequestContext,
    token: string,
    predicate: (count: number) => boolean,
    message: string,
): Promise<number> {
    let last = -1;
    await expect(async () => {
        last = await unreadCount(request, token);
        expect(predicate(last), `${message} (observed ${last})`).toBe(true);
    }).toPass({ timeout: 30_000 });
    return last;
}

/** Resolve the caller's own userId, falling back to a probe task that echoes it. */
async function resolveUserId(request: APIRequestContext, user: RegisteredUser): Promise<string> {
    if (user.user?.id) return user.user.id;
    const probe = await createTaskViaAPI(request, user.access_token, {
        title: `id-probe ${Date.now()}`,
    });
    const raw = probe as unknown as { userId?: string; createdById?: string };
    const id = raw.userId ?? raw.createdById;
    if (!id) throw new Error('resolveUserId: could not determine userId');
    return id;
}

/**
 * Produce ONE real in-app notification by self-assigning a freshly-created task,
 * then poll until the task_assigned row for that task is observable in the inbox.
 * Returns the produced row + the task so callers can assert against its shape.
 */
async function produceTaskNotification(
    request: APIRequestContext,
    token: string,
    userId: string,
    title: string,
): Promise<{ row: NotificationRow; taskId: string; taskSlug: string }> {
    const task = await createTaskViaAPI(request, token, { title });
    await addTaskAssignee(request, token, task.id, { assigneeType: 'user', assigneeId: userId });

    let row: NotificationRow | undefined;
    await expect
        .poll(
            async () => {
                const rows = await listNotifications(request, token, '?category=task');
                row = rows.find((r) => r.metadata?.taskId === task.id);
                return Boolean(row);
            },
            { timeout: PRODUCE_TIMEOUT, message: `no task_assigned row for task ${task.id}` },
        )
        .toBe(true);
    return { row: row!, taskId: task.id, taskSlug: task.slug };
}

test.describe('Notifications inbox — populated-row read/count/dismiss round-trip', () => {
    test('produce → unread-count increments → mark read → count decrements; read row stays in list but leaves unreadOnly', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-read-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: fresh inbox is empty + count is exactly 0 (the baseline the
        //             empty-inbox specs stop at). ---
        expect(await listNotifications(request, token)).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 2: producing a real row drives the unread count to EXACTLY 1
        //             (the increment the badge relies on). ---
        const { row, taskId, taskSlug } = await produceTaskNotification(
            request,
            token,
            userId,
            `RT read ${Date.now()}`,
        );
        expect(row.category).toBe('task');
        expect(row.isRead).toBe(false);
        expect(row.isPersistent).toBe(false);
        expect(row.title).toBe(`Assigned: ${taskSlug}`);
        expect(row.deduplicationKey).toBe(`task:${taskId}:task_assigned:${userId}`);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 1,
            'count is 1 after producing one row',
        );

        // --- Step 3: marking that row read DECREMENTS the count by exactly one. ---
        const read = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(read.status()).toBe(200);
        expect((await read.json()).success).toBe(true);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 0,
            'count drops to 0 after reading the only row',
        );

        // --- Step 4: read does NOT remove the row — it STAYS in the default
        //             (undismissed) list, now flipped to isRead=true. ---
        const afterRead = await listNotifications(request, token);
        const stillThere = afterRead.find((r) => r.id === row.id);
        expect(stillThere, 'read row remains in the default list').toBeTruthy();
        expect(stillThere!.isRead).toBe(true);
        expect(stillThere!.isDismissed).toBe(false);

        // --- Step 5: but the read row LEAVES the ?unreadOnly=true projection, which
        //             must now equal the unread-count (both empty). ---
        const unreadOnly = await listNotifications(request, token, '?unreadOnly=true');
        expect(unreadOnly.some((r) => r.id === row.id)).toBe(false);
        expect(unreadOnly.length).toBe(await unreadCount(request, token));

        // --- Step 6: re-reading the SAME already-read id is idempotent (200, no
        //             negative count, no phantom decrement). ---
        const reRead = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(reRead.status()).toBe(200);
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('multi-row inbox: partial reads decrement step-by-step; read-all clears the count without dismissing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-multi-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce THREE distinct real rows (three self-assigned tasks). ---
        const produced: NotificationRow[] = [];
        for (let i = 0; i < 3; i++) {
            const { row } = await produceTaskNotification(
                request,
                token,
                userId,
                `RT multi ${i} ${Date.now()}`,
            );
            produced.push(row);
        }
        expect(new Set(produced.map((r) => r.id)).size).toBe(3);
        await expectCountToConverge(request, token, (c) => c === 3, 'count is 3 after three rows');

        // --- Step 2: reading ONE row decrements the count to exactly 2 (per-row
        //             granularity, not an all-or-nothing flip). ---
        const readOne = await request.post(`${API_BASE}/api/notifications/${produced[0].id}/read`, {
            headers: authedHeaders(token),
        });
        expect(readOne.status()).toBe(200);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 2,
            'count is 2 after reading one of three',
        );

        // --- Step 3: the unreadOnly list now holds exactly the OTHER two rows. ---
        const unreadOnly = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        const unreadIds = new Set(unreadOnly.map((r) => r.id));
        expect(unreadIds.has(produced[0].id)).toBe(false);
        expect(unreadIds.has(produced[1].id)).toBe(true);
        expect(unreadIds.has(produced[2].id)).toBe(true);

        // --- Step 4: read-all drives the count to 0 and flips EVERY list row to
        //             isRead=true — but does NOT dismiss them (rows remain visible). ---
        const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll.status()).toBe(200);
        expect((await readAll.json()).success).toBe(true);
        await expectCountToConverge(request, token, (c) => c === 0, 'read-all clears the count');

        const afterReadAll = await listNotifications(request, token, '?limit=100');
        expect(afterReadAll.length).toBeGreaterThanOrEqual(3);
        expect(afterReadAll.every((r) => r.isRead === true)).toBe(true);
        expect(afterReadAll.every((r) => r.isDismissed === false)).toBe(true);

        // --- Step 5: the unreadOnly projection is now empty, agreeing with count 0. ---
        const unreadAfter = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        expect(unreadAfter).toEqual([]);
    });

    test('dismiss removes a real row from the list; persistent stays empty; re-reading a dismissed id is still 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-dismiss-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        const { row } = await produceTaskNotification(
            request,
            token,
            userId,
            `RT dismiss ${Date.now()}`,
        );
        await expectCountToConverge(request, token, (c) => c === 1, 'count is 1 before dismiss');

        // --- Step 1: a task row is non-persistent, so the persistent endpoint is
        //             empty even with a populated main inbox. ---
        const persistent = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistent.status()).toBe(200);
        expect((await persistent.json()).notifications).toEqual([]);

        // --- Step 2: dismissing the real row succeeds and (repo.dismiss sets
        //             isRead=true too) clears the unread count. ---
        const dismiss = await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        expect((await dismiss.json()).success).toBe(true);

        // --- Step 3: the dismissed row LEAVES the default (undismissedOnly) list and
        //             every category projection of it. ---
        const afterList = await listNotifications(request, token, '?limit=100');
        expect(afterList.some((r) => r.id === row.id)).toBe(false);
        const afterTaskCat = await listNotifications(request, token, '?category=task&limit=100');
        expect(afterTaskCat.some((r) => r.id === row.id)).toBe(false);
        await expectCountToConverge(request, token, (c) => c === 0, 'count is 0 after dismiss');

        // --- Step 4: re-reading the DISMISSED id is STILL 200 (probed: the
        //             owner-scoped lookup finds the dismissed row; markAsRead never
        //             checks isDismissed) — it is NOT a 400 not-found. ---
        const reRead = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(reRead.status()).toBe(200);
        expect((await reRead.json()).success).toBe(true);
        // The dismissed row stays out of the visible list regardless.
        expect((await listNotifications(request, token)).some((r) => r.id === row.id)).toBe(false);
    });

    test('cross-user: B cannot read/dismiss A’s REAL notification id (400 not-found, never a leak); A’s row survives', async ({
        request,
    }) => {
        const stamp = Date.now();
        const alice = await registerUserViaAPI(request, {
            email: `notif-rt-a-${stamp}@test.local`,
        });
        const bob = await registerUserViaAPI(request, { email: `notif-rt-b-${stamp}@test.local` });
        const aliceId = await resolveUserId(request, alice);

        // --- Step 1: Alice produces a real, genuinely-existing row. Bob is empty. ---
        const { row } = await produceTaskNotification(
            request,
            alice.access_token,
            aliceId,
            `RT cross ${stamp}`,
        );
        expect(row.userId).toBe(aliceId);
        await expectCountToConverge(
            request,
            alice.access_token,
            (c) => c === 1,
            'Alice has 1 unread',
        );
        expect(await unreadCount(request, bob.access_token)).toBe(0);

        // --- Step 2: Bob reading Alice's REAL id is "Notification not found" 400 —
        //             the SAME response as a non-existent id, so a foreign-but-real
        //             row is invisible (no 403 confirming it exists for someone). ---
        const bobRead = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobRead.status()).toBe(400);
        expect((await bobRead.json()).message).toBe('Notification not found');

        const bobDismiss = await request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobDismiss.status()).toBe(400);
        expect((await bobDismiss.json()).message).toBe('Notification not found');

        // --- Step 3: Bob's own surface stays pristine; his read-all cannot touch
        //             Alice's row. ---
        const bobReadAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobReadAll.status()).toBe(200);
        expect(await unreadCount(request, bob.access_token)).toBe(0);
        expect(await listNotifications(request, bob.access_token)).toEqual([]);

        // --- Step 4: Alice's row is wholly unperturbed by Bob's failed verbs — it is
        //             still present, still UNREAD, and her count is still 1. ---
        const aliceList = await listNotifications(request, alice.access_token);
        const survivor = aliceList.find((r) => r.id === row.id);
        expect(survivor, "Alice's row survived Bob's attempts").toBeTruthy();
        expect(survivor!.isRead).toBe(false);
        expect(survivor!.isDismissed).toBe(false);
        await expectCountToConverge(
            request,
            alice.access_token,
            (c) => c === 1,
            "Alice's count untouched",
        );

        // --- Step 5: only ALICE can act on her own row (read then dismiss succeed). ---
        const aliceRead = await request.post(`${API_BASE}/api/notifications/${row.id}/read`, {
            headers: authedHeaders(alice.access_token),
        });
        expect(aliceRead.status()).toBe(200);
        await expectCountToConverge(
            request,
            alice.access_token,
            (c) => c === 0,
            'Alice cleared her own row',
        );
    });

    test('category routing on a populated inbox: ?category=task returns the rows, mismatched categories exclude them', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-cat-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce two real `task` rows. ---
        const a = await produceTaskNotification(request, token, userId, `RT cat A ${Date.now()}`);
        const b = await produceTaskNotification(request, token, userId, `RT cat B ${Date.now()}`);
        const producedIds = new Set([a.row.id, b.row.id]);
        await expectCountToConverge(request, token, (c) => c === 2, 'two task rows produced');

        // --- Step 2: ?category=task returns the produced rows even though `task` is
        //             NOT in the controller's advertised enum — the data layer still
        //             filters by it. Every returned row genuinely carries category. ---
        const taskCat = await listNotifications(request, token, '?category=task&limit=100');
        expect(taskCat.length).toBeGreaterThanOrEqual(2);
        expect(
            producedIds.has(taskCat[0].id) || producedIds.has(taskCat[taskCat.length - 1].id),
        ).toBe(true);
        expect(taskCat.every((r) => r.category === 'task')).toBe(true);
        for (const id of producedIds) {
            expect(taskCat.some((r) => r.id === id)).toBe(true);
        }

        // --- Step 3: a MISMATCHED enum category excludes the task rows entirely
        //             (the rows are `task`, not `system`/`security`/etc.). ---
        for (const category of ['system', 'security', 'subscription', 'generation', 'ai_credits']) {
            const list = await listNotifications(request, token, `?category=${category}&limit=100`);
            expect(
                list.some((r) => producedIds.has(r.id)),
                `category=${category} must exclude task rows`,
            ).toBe(false);
        }

        // --- Step 4: an UNKNOWN category is tolerated (200) and — per the controller
        //             contract — IGNORED: a value not in the NotificationCategory enum
        //             resolves to `validCategory=undefined`, so NO filter is applied and
        //             the FULL list (including the task rows) comes back, never a 400 or
        //             an empty result. (This is the opposite of `system`, a valid enum
        //             value with no matching rows, which DOES filter to empty above.) ---
        const unknown = await listNotifications(
            request,
            token,
            '?category=totally_bogus&limit=100',
        );
        for (const id of producedIds) {
            expect(
                unknown.some((r) => r.id === id),
                'unknown category is ignored, not filtered',
            ).toBe(true);
        }

        // --- Step 5: the unfiltered list is a SUPERSET of the task-category subset,
        //             and the newest-first (createdAt DESC) ordering invariant holds. ---
        const full = await listNotifications(request, token, '?limit=100');
        const fullIds = new Set(full.map((r) => r.id));
        expect(taskCat.every((r) => fullIds.has(r.id))).toBe(true);
        const times = full.map((r) => new Date(r.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }
    });

    test('dedup contract on a real row: re-assigning the same (task, actor) collapses; auth is enforced on every verb', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-dedup-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        const { row, taskId } = await produceTaskNotification(
            request,
            token,
            userId,
            `RT dedup ${Date.now()}`,
        );
        await expectCountToConverge(request, token, (c) => c === 1, 'one row after first assign');

        // --- Step 1: a duplicate assignee write for the SAME (task, user) is rejected
        //             at the unique-constraint layer (uq_task_assignee) BEFORE any
        //             second emit — so the inbox still holds exactly one row for the
        //             (task, actor) dedup key. ---
        const dupAssign = await request.post(`${API_BASE}/api/tasks/${taskId}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'user', assigneeId: userId },
        });
        expect(dupAssign.status(), 'duplicate assignee rejected').toBeGreaterThanOrEqual(400);

        const rowsForTask = (
            await listNotifications(request, token, '?category=task&limit=100')
        ).filter((r) => r.metadata?.taskId === taskId);
        expect(rowsForTask, 'exactly one row per (task, actor)').toHaveLength(1);
        expect(rowsForTask[0].id).toBe(row.id);
        expect(rowsForTask[0].deduplicationKey).toBe(`task:${taskId}:task_assigned:${userId}`);

        // --- Step 2: the unread count never double-counts the dedup-collapsed row. ---
        expect(await unreadCount(request, token)).toBe(1);

        // --- Step 3: every notification verb is auth-gated — a missing bearer is a
        //             hard 401 on each route, including the ones targeting a REAL id. ---
        for (const probe of [
            () => request.get(`${API_BASE}/api/notifications`),
            () => request.get(`${API_BASE}/api/notifications/unread-count`),
            () => request.get(`${API_BASE}/api/notifications/persistent`),
            () => request.post(`${API_BASE}/api/notifications/read-all`),
            () => request.post(`${API_BASE}/api/notifications/${row.id}/read`),
            () => request.post(`${API_BASE}/api/notifications/${row.id}/dismiss`),
            () => request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`),
        ]) {
            const res = await probe();
            expect(res.status()).toBe(401);
        }
    });

    test('paging window walk over a populated inbox: offset/limit windows are disjoint, ordered, and cover every row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-page-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce FIVE real rows so paging has something to slice. ---
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const { row } = await produceTaskNotification(
                request,
                token,
                userId,
                `RT page ${i} ${Date.now()}`,
            );
            ids.push(row.id);
        }
        await expectCountToConverge(request, token, (c) => c === 5, 'five rows produced');

        // --- Step 2: a full scan returns all five in newest-first (createdAt DESC)
        //             order. This is the canonical projection windows must agree with. ---
        const full = await listNotifications(request, token, '?limit=100&offset=0');
        expect(full.length).toBe(5);
        const fullOrder = full.map((r) => r.id);
        const times = full.map((r) => new Date(r.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }

        // --- Step 3: walk limit=2 windows (offset 0,2,4). Windows must be DISJOINT,
        //             each <= the page size, together COVER every produced row, and
        //             preserve the same DESC order as the full scan. ---
        const seen: string[] = [];
        for (const offset of [0, 2, 4]) {
            const win = await listNotifications(request, token, `?limit=2&offset=${offset}`);
            expect(win.length, `window offset=${offset} size`).toBeLessThanOrEqual(2);
            for (const r of win) {
                expect(seen.includes(r.id), `dup id across windows: ${r.id}`).toBe(false);
                seen.push(r.id);
            }
        }
        // Concatenated windows reconstruct the full DESC ordering exactly.
        expect(seen).toEqual(fullOrder);
        // And every produced id was reached by the paging walk.
        for (const id of ids) {
            expect(seen.includes(id)).toBe(true);
        }

        // --- Step 4: a window PAST the end is an empty (not erroring) tail page. ---
        const tail = await listNotifications(request, token, '?limit=10&offset=999999');
        expect(tail).toEqual([]);
    });

    test('cache headers: the list route is private/no-store but unread-count is NOT, even with a populated inbox', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-cache-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // Populate the inbox so the headers are asserted against a real 200 payload,
        // not just an empty envelope.
        await produceTaskNotification(request, token, userId, `RT cache ${Date.now()}`);
        await expectCountToConverge(request, token, (c) => c === 1, 'one row before header check');

        // --- Step 1: GET /api/notifications carries the controller's explicit
        //             Cache-Control: private, no-store (the list must never be cached). ---
        const listRes = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status()).toBe(200);
        expect(listRes.headers()['cache-control'] ?? '').toContain('no-store');

        // --- Step 2: GET /api/notifications/unread-count carries NO no-store header
        //             (it is a distinct surface without the @Header decorator). ---
        const countRes = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(token),
        });
        expect(countRes.status()).toBe(200);
        expect(countRes.headers()['cache-control'] ?? '').not.toContain('no-store');

        // --- Step 3: the persistent route also returns 200 and is its own surface. ---
        const persistentRes = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistentRes.status()).toBe(200);
    });

    test('read-all then dismiss interplay on real rows: count floors at 0, dismissed rows leave, read-but-undismissed rows remain', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-interplay-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce three real rows, then read-all → count 0, all rows
        //             read but still listed (read-all never dismisses). ---
        const rows: NotificationRow[] = [];
        for (let i = 0; i < 3; i++) {
            const { row } = await produceTaskNotification(
                request,
                token,
                userId,
                `RT interplay ${i} ${Date.now()}`,
            );
            rows.push(row);
        }
        await expectCountToConverge(request, token, (c) => c === 3, 'three rows before read-all');

        const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll.status()).toBe(200);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 0,
            'read-all floors the count at 0',
        );

        const afterReadAll = await listNotifications(request, token, '?limit=100');
        expect(afterReadAll.length).toBeGreaterThanOrEqual(3);
        expect(afterReadAll.every((r) => r.isRead === true)).toBe(true);
        expect(afterReadAll.every((r) => r.isDismissed === false)).toBe(true);

        // --- Step 2: dismissing ONE already-read row removes only that row from the
        //             list; the count stays at 0 (the row was already read). ---
        const dismiss = await request.post(`${API_BASE}/api/notifications/${rows[0].id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        const afterDismiss = await listNotifications(request, token, '?limit=100');
        expect(afterDismiss.some((r) => r.id === rows[0].id)).toBe(false);
        expect(afterDismiss.some((r) => r.id === rows[1].id)).toBe(true);
        expect(afterDismiss.some((r) => r.id === rows[2].id)).toBe(true);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 3: a follow-up read-all on the now-all-read inbox is a clean no-op,
        //             and the count never dips below zero. ---
        const readAll2 = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll2.status()).toBe(200);
        const floor = await expectCountToConverge(
            request,
            token,
            (c) => c === 0,
            'idempotent read-all stays at 0',
        );
        expect(floor).toBeGreaterThanOrEqual(0);
    });

    test('unreadOnly list and unread-count stay equal across every read transition (the bell-badge invariant)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-invariant-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // The invariant under test: len(?unreadOnly=true) === unread-count at EVERY
        // point. This is exactly what the bell badge renders, so it must hold as the
        // inbox transitions empty → populated → partially-read → fully-read.
        const assertInvariant = async (label: string) => {
            await expect(async () => {
                const unread = await listNotifications(
                    request,
                    token,
                    '?unreadOnly=true&limit=100',
                );
                const count = await unreadCount(request, token);
                expect(unread.length, `${label}: unreadOnly len === count`).toBe(count);
                expect(unread.every((r) => r.isRead === false)).toBe(true);
            }).toPass({ timeout: 30_000 });
        };

        // --- Step 1: empty inbox — invariant holds at 0. ---
        await assertInvariant('empty');

        // --- Step 2: produce two rows — invariant holds at 2. ---
        const a = await produceTaskNotification(request, token, userId, `RT inv A ${Date.now()}`);
        const b = await produceTaskNotification(request, token, userId, `RT inv B ${Date.now()}`);
        await assertInvariant('two-unread');
        expect(await unreadCount(request, token)).toBe(2);

        // --- Step 3: read one — invariant holds at 1. ---
        await request.post(`${API_BASE}/api/notifications/${a.row.id}/read`, {
            headers: authedHeaders(token),
        });
        await assertInvariant('one-read');
        expect(await unreadCount(request, token)).toBe(1);

        // --- Step 4: dismiss the other (dismiss also marks read) — invariant holds at 0. ---
        await request.post(`${API_BASE}/api/notifications/${b.row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        await assertInvariant('all-cleared');
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('limit cap is honoured on a populated inbox and the list never exceeds the requested window', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-limit-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce four real rows. ---
        for (let i = 0; i < 4; i++) {
            await produceTaskNotification(request, token, userId, `RT limit ${i} ${Date.now()}`);
        }
        await expectCountToConverge(request, token, (c) => c === 4, 'four rows produced');

        // --- Step 2: limit=1 returns at most one row (the newest), proving the
        //             take() window is applied to a populated set, not ignored. ---
        const one = await listNotifications(request, token, '?limit=1&offset=0');
        expect(one.length).toBe(1);

        // --- Step 3: an over-cap limit (200) is accepted (never 5xx) and clamped
        //             server-side to <= 100; with four rows it returns exactly four. ---
        const overCap = await listNotifications(request, token, '?limit=200&offset=0');
        expect(overCap.length).toBeLessThanOrEqual(100);
        expect(overCap.length).toBe(4);

        // --- Step 4: limit=3 returns exactly three and limit=10 returns all four —
        //             the window tracks the requested size up to the row count. ---
        const three = await listNotifications(request, token, '?limit=3&offset=0');
        expect(three.length).toBe(3);
        const ten = await listNotifications(request, token, '?limit=10&offset=0');
        expect(ten.length).toBe(4);
    });

    test('persistent endpoint is a strict non-dismissed subset and never includes the transient task rows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-persist-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: produce two transient (non-persistent) task rows. ---
        const a = await produceTaskNotification(
            request,
            token,
            userId,
            `RT persist A ${Date.now()}`,
        );
        const b = await produceTaskNotification(
            request,
            token,
            userId,
            `RT persist B ${Date.now()}`,
        );
        const producedIds = new Set([a.row.id, b.row.id]);
        await expectCountToConverge(request, token, (c) => c === 2, 'two transient rows produced');

        // --- Step 2: the produced rows are isPersistent=false, so the persistent
        //             endpoint must be EMPTY even though the main inbox is populated. ---
        expect(a.row.isPersistent).toBe(false);
        expect(b.row.isPersistent).toBe(false);
        const persistentRes = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistentRes.status()).toBe(200);
        const persistent = (await persistentRes.json()).notifications as NotificationRow[];
        expect(Array.isArray(persistent)).toBe(true);
        // None of the transient task rows leak into the persistent surface.
        expect(persistent.some((r) => producedIds.has(r.id))).toBe(false);

        // --- Step 3: invariant — persistent is a SUBSET of the (persistent+undismissed)
        //             main list and every persistent row is non-dismissed. ---
        const full = await listNotifications(request, token, '?limit=100');
        const fullIds = new Set(full.map((r) => r.id));
        expect(persistent.every((r) => fullIds.has(r.id))).toBe(true);
        expect(persistent.every((r) => r.isDismissed === false)).toBe(true);
        expect(persistent.every((r) => r.isPersistent === true)).toBe(true);

        // --- Step 4: dismissing a transient row is allowed (it is NOT persistent),
        //             confirming the persistent-undismissable guard does not block it. ---
        const dismiss = await request.post(`${API_BASE}/api/notifications/${a.row.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismiss.status()).toBe(200);
        expect((await dismiss.json()).success).toBe(true);
    });

    test('immediate-consistency: a produced row is observable within the SLA and its full shape matches the producer contract', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-shape-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        const { row, taskId, taskSlug } = await produceTaskNotification(
            request,
            token,
            userId,
            `RT shape ${Date.now()}`,
        );

        // --- The reader sees the EXACT shape the producer wrote (the contract the
        //     inbox/bell rendering depends on). This binds the producer (asserted in
        //     flow-notifications-per-event) to the READER surface this file owns. ---
        expect(row.userId).toBe(userId);
        expect(row.category).toBe('task');
        expect(row.type).toBe('info');
        expect(row.isRead).toBe(false);
        expect(row.isDismissed).toBe(false);
        expect(row.isPersistent).toBe(false);
        expect(row.title).toBe(`Assigned: ${taskSlug}`);
        expect(row.message).toContain('assigned you to');
        expect(row.metadata?.event).toBe('task_assigned');
        expect(row.metadata?.taskId).toBe(taskId);
        expect(row.metadata?.taskSlug).toBe(taskSlug);
        expect(row.deduplicationKey).toBe(`task:${taskId}:task_assigned:${userId}`);

        // The same row is reachable by id-equality from BOTH the default list and the
        // category-filtered list — the two reader projections agree on it.
        const byDefault = (await listNotifications(request, token)).find((r) => r.id === row.id);
        const byCategory = (await listNotifications(request, token, '?category=task')).find(
            (r) => r.id === row.id,
        );
        expect(byDefault, 'row present in default list').toBeTruthy();
        expect(byCategory, 'row present in category=task list').toBeTruthy();
        expect(byDefault!.deduplicationKey).toBe(byCategory!.deduplicationKey);
    });

    test('count monotonicity under interleaved produce/read: only produce raises it, only read/dismiss lowers it, never negative', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-rt-monotonic-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const userId = await resolveUserId(request, user);

        // --- Step 1: baseline is exactly 0. ---
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 2: produce → +1 → produce → +1 (the count tracks the unread set
        //             upward as new rows arrive). ---
        const r1 = await produceTaskNotification(request, token, userId, `RT mono 1 ${Date.now()}`);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 1,
            'count is 1 after first produce',
        );
        const r2 = await produceTaskNotification(request, token, userId, `RT mono 2 ${Date.now()}`);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 2,
            'count is 2 after second produce',
        );

        // --- Step 3: read one → -1 (down to 1). The count only moves down on a read. ---
        const read = await request.post(`${API_BASE}/api/notifications/${r1.row.id}/read`, {
            headers: authedHeaders(token),
        });
        expect(read.status()).toBe(200);
        await expectCountToConverge(request, token, (c) => c === 1, 'count is 1 after reading one');

        // --- Step 4: produce again → +1 (back to 2) — interleaving a produce after a
        //             read still raises the count by exactly one. ---
        const r3 = await produceTaskNotification(request, token, userId, `RT mono 3 ${Date.now()}`);
        await expectCountToConverge(
            request,
            token,
            (c) => c === 2,
            'count is 2 after interleaved produce',
        );

        // --- Step 5: dismiss the remaining two unread rows → 0, and a final read-all
        //             cannot push the count below zero (the hard floor). ---
        for (const id of [r2.row.id, r3.row.id]) {
            const dismiss = await request.post(`${API_BASE}/api/notifications/${id}/dismiss`, {
                headers: authedHeaders(token),
            });
            expect(dismiss.status()).toBe(200);
        }
        await expectCountToConverge(
            request,
            token,
            (c) => c === 0,
            'count is 0 after dismissing both',
        );
        await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        const floor = await unreadCount(request, token);
        expect(floor).toBe(0);
        expect(floor).toBeGreaterThanOrEqual(0);
    });
});
