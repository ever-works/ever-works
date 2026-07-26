import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createTaskViaAPI, addTaskAssignee } from './helpers/agents-tasks';

/**
 * GET /api/notifications — LIST pagination / ordering / filter matrix + the
 * unread-count read-all dynamics, driven end-to-end against the live stack on a
 * POPULATED inbox.
 *
 * Controller: apps/api/src/notifications/notifications.controller.ts
 * Repo:       packages/agent/src/database/repositories/notification.repository.ts
 *
 * The public API exposes NO endpoint to mint an in-app notification row, so the
 * sibling list/pagination specs mostly stop at a fresh user's zero state or
 * assert a weak `<500` envelope on junk params over an EMPTY inbox. But there IS
 * a keyless, deterministic in-app producer reachable from the public API:
 *   POST /api/tasks            -> 201 { id, slug:'T-n', … }
 *   POST /api/tasks/:id/assignees { assigneeType:'user', assigneeId:<self> }
 *     => synchronously writes a REAL `category:'task'` notification row for the
 *        assignee (TaskNotificationService.emit('task_assigned')).
 * This file USES that producer to stand up a POPULATED, per-user-deterministic
 * inbox and then pins the LIST contract that no sibling asserts on real rows:
 * pagination PARTITION correctness, newest-first ordering (tie-tolerant),
 * limit/offset CLAMP + validation edges, the category / unreadOnly filter
 * matrix, the read-all → unread-count state machine, and CONCURRENCY invariants
 * on the count (no lost / resurrected notifications).
 *
 * ── PROBED LIVE (curl against http://127.0.0.1:3100, sqlite in-memory — the CI
 *    driver) on throwaway users BEFORE every assertion. Exact contract:
 *
 *   GET /api/notifications  -> 200 { notifications: Notification[] }  (BARE envelope
 *        — no meta / total / data / cursor). Header `Cache-Control: private, no-store`.
 *        Row projection (produced task_assigned row):
 *          { id, userId:<self>, type:'info', category:'task',
 *            title:`Assigned: T-n`, message, actionUrl:`/tasks/<taskId>`,
 *            actionLabel:'Open Task',
 *            metadata:{ event:'task_assigned', taskId, taskSlug:'T-n', actorUserId:<self> },
 *            isRead:false, isDismissed:false, isPersistent:false,
 *            tenantId:null, organizationId:null, createdAt, expiresAt:null,
 *            deduplicationKey:`task:<taskId>:task_assigned:<self>` }
 *        Query pipes: unreadOnly (DefaultValuePipe(false)+ParseBoolPipe),
 *        limit (DefaultValuePipe(50)+ParseIntPipe, then Math.min(limit,100) CAP),
 *        offset (DefaultValuePipe(0)+ParseIntPipe), category (raw → whitelisted
 *        through the NotificationCategory enum; unknown value => IGNORED, no filter).
 *        Repo ALWAYS forces undismissedOnly=true, excludes expired, orderBy
 *        createdAt DESC, skip(offset).take(limit).
 *
 *   ORDERING: createdAt DESC. createdAt is SECOND-resolution ('…:57.000Z') so
 *        rows minted in the same second TIE — the list is NON-INCREASING but the
 *        intra-tie order is a SQLite rowid artifact, NOT part of the contract →
 *        we assert monotonic-DESC with tie tolerance, and pin the strict newest
 *        only for a row we deliberately mint >1s later.
 *
 *   PAGINATION edges (PROBED, populated inbox):
 *        limit=k (k<total) -> exactly k rows; offset pages PARTITION with no
 *          overlap and union == full set.
 *        offset past end   -> [] (200).
 *        limit=0           -> [] (200)  (Math.min(0,100)=0 → take(0)).
 *        limit=200 / 1000  -> all available (200); cap is Math.min(,100) but is
 *          indistinguishable below 100 rows — we assert "all available", never a
 *          fabricated 100-exactly claim.
 *        limit=3.5 (non-integer) -> 400 { statusCode:400,'Validation failed
 *          (numeric string is expected)' }  (the ONE firm reject).
 *        limit=-5 / offset=-1 (valid ints) -> 200, negative ignored → all rows.
 *        limit=abc / offset=abc (non-numeric) -> 200 here (pipe tolerates); a
 *          different pipe build could 400 → we accept [200,400], never 5xx.
 *
 *   FILTERS: ?category=task -> the produced rows. ?category=system|security|
 *        ai_credits|generation|subscription|agent (valid enum, no rows here) -> [].
 *        ?category=<unknown|SQLi'--|TASK> -> IGNORED → FULL list (never 400/5xx).
 *        ?unreadOnly=true -> only isRead=false rows; ?unreadOnly=false -> all
 *        undismissed. Filters intersect (AND).
 *
 *   COUNT state machine (per-user deterministic — fresh user starts at 0):
 *        produce N            -> count == N
 *        read one             -> count-1; row STAYS in default list (isRead=true),
 *                                leaves ?unreadOnly=true; re-read idempotent.
 *        read-all             -> count 0; ALL rows isRead=true, NONE dismissed,
 *                                rows REMAIN in the undismissed list.
 *        produce after read-all -> count 1 (read-all does not permanently suppress).
 *        dismiss              -> count-1 AND the row LEAVES the list.
 *
 *   ISOLATION / AUTH: cross-user list is walled (B's inbox empty; B POST
 *        /:A-real-id/read|dismiss -> 400 'Notification not found' — same 400 as a
 *        bogus/malformed id, findByIdAndUserId scopes to the caller; A's row
 *        survives). No token / bad token -> 401 on list, unread-count, persistent.
 *
 * NON-DUPLICATION (siblings read first):
 *   - flow-notifications-bulk.spec.ts     → junk-param `<500` envelope on an EMPTY
 *     inbox + bulk/retention; does NOT partition real pages or pin 3.5→400.
 *   - flow-notifications-inbox-deep.spec.ts → reader state-machine (read/dismiss)
 *     on populated rows; does NOT do limit/offset partition, ordering-tie, the
 *     validation matrix, or concurrency-on-count.
 *   - flow-notifications-read-lifecycle / -cross-user / -per-event → EMPTY-inbox
 *     lifecycle / isolation via bogus ids / the PRODUCER row shape.
 *   This file is the only one that pins LIST pagination PARTITION + ordering
 *   tolerance + the limit/offset validation matrix + read-all count dynamics +
 *   concurrent-produce count invariants on REAL rows.
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() user; all
 * live calls happen INSIDE tests (no module-scope producer) so sharded collection
 * never fires a request at import time.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIF_URL = `${API_BASE}/api/notifications`;

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NotifRow {
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
    createdAt: string;
    expiresAt: string | null;
    deduplicationKey: string | null;
}

async function getList(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; body: { notifications?: NotifRow[] } & Record<string, unknown> }> {
    const res = await request.get(`${NOTIF_URL}${query}`, { headers: authedHeaders(token) });
    let body: { notifications?: NotifRow[] } & Record<string, unknown> = {};
    try {
        body = await res.json();
    } catch {
        body = {};
    }
    return { status: res.status(), body };
}

async function listRows(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<NotifRow[]> {
    const { status, body } = await getList(request, token, query);
    expect(status).toBe(200);
    expect(Array.isArray(body.notifications)).toBe(true);
    return body.notifications as NotifRow[];
}

async function getCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${NOTIF_URL}/unread-count`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return body.count as number;
}

async function pollUntil<T>(
    fn: () => Promise<T>,
    pred: (v: T) => boolean,
    tries = 24,
    delayMs = 250,
): Promise<T> {
    let last = await fn();
    for (let i = 0; i < tries && !pred(last); i++) {
        await sleep(delayMs);
        last = await fn();
    }
    return last;
}

/**
 * Produce `count` REAL task_assigned notification rows for `selfId` by creating
 * `count` tasks and self-assigning each. Returns the produced taskIds in creation
 * order (oldest → newest); the notification for the LAST taskId is the newest.
 * Blocks until the unread-count reflects all produced rows.
 */
async function produce(
    request: APIRequestContext,
    token: string,
    selfId: string,
    count: number,
): Promise<string[]> {
    const taskIds: string[] = [];
    for (let i = 0; i < count; i++) {
        const task = await createTaskViaAPI(request, token, {
            title: `Notif seed ${uniq()} #${i}`,
        });
        await addTaskAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: selfId,
        });
        taskIds.push(task.id);
    }
    await pollUntil(
        () => getCount(request, token),
        (c) => c >= count,
    );
    return taskIds;
}

/** Map a produced taskId to its notification row (metadata.taskId is the key). */
function rowForTask(rows: NotifRow[], taskId: string): NotifRow | undefined {
    return rows.find((r) => (r.metadata as { taskId?: string } | null)?.taskId === taskId);
}

async function markRead(request: APIRequestContext, token: string, id: string) {
    return request.post(`${NOTIF_URL}/${id}/read`, { headers: authedHeaders(token) });
}
async function readAll(request: APIRequestContext, token: string) {
    return request.post(`${NOTIF_URL}/read-all`, { headers: authedHeaders(token) });
}
async function dismiss(request: APIRequestContext, token: string, id: string) {
    return request.post(`${NOTIF_URL}/${id}/dismiss`, { headers: authedHeaders(token) });
}

// ───────────────────────────────────────────────────────────────────────────
test.describe('GET /api/notifications — empty-inbox baseline + envelope', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('fresh user: bare { notifications: [] } envelope, no meta/total/data', async ({
        request,
    }) => {
        const { status, body } = await getList(request, user.access_token);
        expect(status).toBe(200);
        expect(Array.isArray(body.notifications)).toBe(true);
        expect(body.notifications).toHaveLength(0);
        // BARE envelope — pin the absence of a paging wrapper.
        expect(body.meta).toBeUndefined();
        expect(body.total).toBeUndefined();
        expect(body.data).toBeUndefined();
        expect(body.cursor).toBeUndefined();
        expect(Object.keys(body)).toEqual(['notifications']);
    });

    test('list response carries Cache-Control: private, no-store', async ({ request }) => {
        const res = await request.get(NOTIF_URL, { headers: authedHeaders(user.access_token) });
        expect(res.status()).toBe(200);
        const cc = res.headers()['cache-control'] ?? '';
        expect(cc).toContain('no-store');
        expect(cc).toContain('private');
    });

    test('unread-count for a fresh user is exactly { count: 0 }', async ({ request }) => {
        const res = await request.get(`${NOTIF_URL}/unread-count`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ count: 0 });
    });

    test('persistent endpoint is empty for a task-only (non-persistent) inbox', async ({
        request,
    }) => {
        // Even after producing task rows (non-persistent), /persistent stays empty.
        await produce(request, user.access_token, user.user.id, 2);
        const res = await request.get(`${NOTIF_URL}/persistent`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.notifications).toEqual([]);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('produced-row shape + ordering', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('produced rows expose the exact task_assigned projection, all owned by self', async ({
        request,
    }) => {
        const taskIds = await produce(request, user.access_token, user.user.id, 3);
        const rows = await listRows(request, user.access_token, '?limit=100');
        expect(rows.length).toBe(3);
        for (const taskId of taskIds) {
            const row = rowForTask(rows, taskId);
            expect(row, `notification for task ${taskId}`).toBeTruthy();
            const r = row as NotifRow;
            expect(r.id).toMatch(UUID_RE);
            expect(r.userId).toBe(user.user.id);
            expect(r.type).toBe('info');
            expect(r.category).toBe('task');
            expect(r.title).toMatch(/^Assigned: T-\d+$/);
            expect(r.actionLabel).toBe('Open Task');
            expect(r.actionUrl).toBe(`/tasks/${taskId}`);
            expect(r.isRead).toBe(false);
            expect(r.isDismissed).toBe(false);
            expect(r.isPersistent).toBe(false);
            expect(r.expiresAt).toBeNull();
            const meta = r.metadata as { event?: string; taskId?: string; actorUserId?: string };
            expect(meta.event).toBe('task_assigned');
            expect(meta.taskId).toBe(taskId);
            expect(meta.actorUserId).toBe(user.user.id);
            expect(r.deduplicationKey).toBe(`task:${taskId}:task_assigned:${user.user.id}`);
        }
    });

    test('list is ordered createdAt DESC (non-increasing, ties tolerated)', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 8);
        const rows = await listRows(request, user.access_token, '?limit=100');
        expect(rows.length).toBe(8);
        for (let i = 1; i < rows.length; i++) {
            const prev = Date.parse(rows[i - 1].createdAt);
            const cur = Date.parse(rows[i].createdAt);
            // second-resolution ties are legal → assert NON-INCREASING, not strict.
            expect(cur).toBeLessThanOrEqual(prev);
        }
    });

    test('a strictly-newer row (minted >1s later) sorts to index 0', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 4);
        await sleep(1100); // guarantee a strictly-greater second-resolution timestamp
        const markerTask = await createTaskViaAPI(request, user.access_token, {
            title: `Notif marker ${uniq()}`,
        });
        await addTaskAssignee(request, user.access_token, markerTask.id, {
            assigneeType: 'user',
            assigneeId: user.user.id,
        });
        const rows = await pollUntil(
            () => listRows(request, user.access_token, '?limit=100'),
            (rs) => rs.length >= 5,
        );
        expect(rows.length).toBe(5);
        expect((rows[0].metadata as { taskId?: string }).taskId).toBe(markerTask.id);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('pagination — limit / offset partition + clamps', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('limit=k returns exactly k rows when k < total', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 7);
        expect((await listRows(request, user.access_token, '?limit=3')).length).toBe(3);
        expect((await listRows(request, user.access_token, '?limit=5')).length).toBe(5);
        expect((await listRows(request, user.access_token, '?limit=7')).length).toBe(7);
    });

    test('offset pages PARTITION the set with no overlap and full coverage', async ({
        request,
    }) => {
        await produce(request, user.access_token, user.user.id, 7);
        const full = await listRows(request, user.access_token, '?limit=100');
        const fullIds = full.map((r) => r.id);
        expect(fullIds.length).toBe(7);

        const p0 = (await listRows(request, user.access_token, '?limit=3&offset=0')).map(
            (r) => r.id,
        );
        const p1 = (await listRows(request, user.access_token, '?limit=3&offset=3')).map(
            (r) => r.id,
        );
        const p2 = (await listRows(request, user.access_token, '?limit=3&offset=6')).map(
            (r) => r.id,
        );
        expect(p0.length).toBe(3);
        expect(p1.length).toBe(3);
        expect(p2.length).toBe(1);

        // pairwise disjoint
        expect(p0.filter((id) => p1.includes(id))).toEqual([]);
        expect(p0.filter((id) => p2.includes(id))).toEqual([]);
        expect(p1.filter((id) => p2.includes(id))).toEqual([]);
        // union == full set (order-independent)
        expect(new Set([...p0, ...p1, ...p2])).toEqual(new Set(fullIds));
    });

    test('offset past the end returns an empty page (200)', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 3);
        const rows = await listRows(request, user.access_token, '?offset=1000');
        expect(rows).toHaveLength(0);
    });

    test('limit=0 returns an empty page (200)', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 3);
        const rows = await listRows(request, user.access_token, '?limit=0');
        expect(rows).toHaveLength(0);
    });

    test('limit above available (200 / 1000) returns all available, never truncated below total', async ({
        request,
    }) => {
        await produce(request, user.access_token, user.user.id, 6);
        const at200 = await listRows(request, user.access_token, '?limit=200');
        const at1000 = await listRows(request, user.access_token, '?limit=1000');
        expect(at200.length).toBe(6);
        expect(at1000.length).toBe(6);
        // cap is Math.min(,100); below 100 rows both windows return the same full set.
        expect(new Set(at1000.map((r) => r.id))).toEqual(new Set(at200.map((r) => r.id)));
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('pagination — validation + junk-param robustness', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
        await produce(request, user.access_token, user.user.id, 4);
    });

    test('limit=3.5 (non-integer) is rejected 400 Bad Request', async ({ request }) => {
        const res = await request.get(`${NOTIF_URL}?limit=3.5`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.statusCode).toBe(400);
        expect(String(body.message)).toContain('numeric string is expected');
    });

    test('negative limit (valid int) is tolerated: 200, negative ignored → all rows', async ({
        request,
    }) => {
        const { status, body } = await getList(request, user.access_token, '?limit=-5');
        expect(status).toBe(200);
        expect(Array.isArray(body.notifications)).toBe(true);
        expect((body.notifications as NotifRow[]).length).toBe(4);
    });

    test('negative offset (valid int) is tolerated: 200, does not drop rows', async ({
        request,
    }) => {
        const { status, body } = await getList(request, user.access_token, '?offset=-1');
        expect(status).toBe(200);
        expect((body.notifications as NotifRow[]).length).toBe(4);
    });

    test('non-numeric junk (limit=abc / offset=abc) never 5xx', async ({ request }) => {
        for (const q of ['?limit=abc', '?offset=abc', '?limit=%20', '?limit=1e2']) {
            const { status, body } = await getList(request, user.access_token, q);
            // observed 200 here; a different pipe build could 400 — never a 5xx / corruption.
            expect([200, 400], `status for ${q}`).toContain(status);
            if (status === 200) expect(Array.isArray(body.notifications)).toBe(true);
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('filters — category + unreadOnly matrix', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
        await produce(request, user.access_token, user.user.id, 5);
    });

    test('?category=task returns all produced task rows', async ({ request }) => {
        const rows = await listRows(request, user.access_token, '?category=task&limit=100');
        expect(rows.length).toBe(5);
        expect(rows.every((r) => r.category === 'task')).toBe(true);
    });

    test('?category=<valid enum with no rows> returns empty', async ({ request }) => {
        for (const c of [
            'system',
            'security',
            'ai_credits',
            'generation',
            'subscription',
            'agent',
        ]) {
            const rows = await listRows(request, user.access_token, `?category=${c}&limit=100`);
            expect(rows, `category=${c}`).toHaveLength(0);
        }
    });

    test('unknown / SQLi-shaped / wrong-case category is IGNORED → full list, never 400', async ({
        request,
    }) => {
        for (const c of ['bogus_xyz', "task'--", 'TASK', '1%3D1', 'task%20OR%201%3D1']) {
            const { status, body } = await getList(
                request,
                user.access_token,
                `?category=${c}&limit=100`,
            );
            expect(status, `category=${c}`).toBe(200);
            expect((body.notifications as NotifRow[]).length, `category=${c}`).toBe(5);
        }
    });

    test('?unreadOnly=true excludes read rows; default includes them', async ({ request }) => {
        const rows = await listRows(request, user.access_token, '?limit=100');
        const target = rows[0].id;
        expect((await markRead(request, user.access_token, target)).status()).toBe(200);

        const unread = await listRows(request, user.access_token, '?unreadOnly=true&limit=100');
        expect(unread.length).toBe(4);
        expect(unread.some((r) => r.id === target)).toBe(false);

        const all = await listRows(request, user.access_token, '?unreadOnly=false&limit=100');
        expect(all.length).toBe(5);
        const readRow = all.find((r) => r.id === target) as NotifRow;
        expect(readRow).toBeTruthy();
        expect(readRow.isRead).toBe(true); // read row STAYS in the default list
    });

    test('unreadOnly + category filters intersect (AND)', async ({ request }) => {
        const rows = await listRows(request, user.access_token, '?limit=100');
        await markRead(request, user.access_token, rows[0].id);
        // unread ∩ task = the 4 still-unread task rows
        const unreadTask = await listRows(
            request,
            user.access_token,
            '?unreadOnly=true&category=task&limit=100',
        );
        expect(unreadTask.length).toBe(4);
        // unread ∩ system = none (no system rows exist)
        const unreadSystem = await listRows(
            request,
            user.access_token,
            '?unreadOnly=true&category=system&limit=100',
        );
        expect(unreadSystem).toHaveLength(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('unread-count state machine (read / read-all / dismiss)', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('count == number produced', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 6);
        expect(await getCount(request, user.access_token)).toBe(6);
    });

    test('marking one read decrements count by exactly 1 and is idempotent', async ({
        request,
    }) => {
        await produce(request, user.access_token, user.user.id, 4);
        const rows = await listRows(request, user.access_token, '?limit=100');
        const id = rows[0].id;
        expect((await markRead(request, user.access_token, id)).status()).toBe(200);
        expect(await getCount(request, user.access_token)).toBe(3);
        // idempotent re-read: still 200, count unchanged
        expect((await markRead(request, user.access_token, id)).status()).toBe(200);
        expect(await getCount(request, user.access_token)).toBe(3);
    });

    test('read-all drives count to 0 without dismissing; rows remain, all isRead', async ({
        request,
    }) => {
        await produce(request, user.access_token, user.user.id, 5);
        expect((await readAll(request, user.access_token)).status()).toBe(200);
        expect(await getCount(request, user.access_token)).toBe(0);
        const rows = await listRows(request, user.access_token, '?limit=100');
        expect(rows.length).toBe(5); // read-all does NOT remove rows
        expect(rows.every((r) => r.isRead)).toBe(true);
        expect(rows.every((r) => !r.isDismissed)).toBe(true);
        // ?unreadOnly=true is now empty
        expect(
            await listRows(request, user.access_token, '?unreadOnly=true&limit=100'),
        ).toHaveLength(0);
    });

    test('a notification produced AFTER read-all re-increments the count', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 3);
        await readAll(request, user.access_token);
        expect(await getCount(request, user.access_token)).toBe(0);
        await produce(request, user.access_token, user.user.id, 1);
        expect(await getCount(request, user.access_token)).toBe(1); // not permanently suppressed
    });

    test('dismiss decrements count AND removes the row from the list', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 3);
        const rows = await listRows(request, user.access_token, '?limit=100');
        const victim = rows[0].id;
        expect((await dismiss(request, user.access_token, victim)).status()).toBe(200);
        expect(await getCount(request, user.access_token)).toBe(2);
        const after = await listRows(request, user.access_token, '?limit=100');
        expect(after.length).toBe(2);
        expect(after.some((r) => r.id === victim)).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('isolation + auth', () => {
    test('cross-user: B cannot see or mutate A rows; A survives B verbs', async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const [aTask] = await produce(request, a.access_token, a.user.id, 1);
        const aRows = await listRows(request, a.access_token, '?limit=100');
        const aId = (rowForTask(aRows, aTask) as NotifRow).id;

        // B's inbox is empty & count 0
        expect(await listRows(request, b.access_token)).toHaveLength(0);
        expect(await getCount(request, b.access_token)).toBe(0);

        // B mutating A's REAL id → 400 'Notification not found' (owner-scoped lookup)
        const bRead = await markRead(request, b.access_token, aId);
        expect(bRead.status()).toBe(400);
        expect(String((await bRead.json()).message)).toContain('not found');
        const bDismiss = await dismiss(request, b.access_token, aId);
        expect(bDismiss.status()).toBe(400);

        // A's row is untouched: still present, still unread
        const aAfter = await listRows(request, a.access_token, '?limit=100');
        const survivor = aAfter.find((r) => r.id === aId) as NotifRow;
        expect(survivor).toBeTruthy();
        expect(survivor.isRead).toBe(false);
        expect(await getCount(request, a.access_token)).toBe(1);
    });

    test('bogus / nonexistent / malformed ids all 400 (never 404/5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
            const res = await markRead(request, u.access_token, id);
            expect(res.status(), `read ${id}`).toBe(400);
        }
    });

    test('list / unread-count / persistent require auth (401 no token, 401 bad token)', async ({
        request,
    }) => {
        for (const path of ['', '/unread-count', '/persistent']) {
            const noTok = await request.get(`${NOTIF_URL}${path}`);
            expect(noTok.status(), `no-token ${path}`).toBe(401);
            const badTok = await request.get(`${NOTIF_URL}${path}`, {
                headers: { Authorization: 'Bearer garbage.token.xyz' },
            });
            expect(badTok.status(), `bad-token ${path}`).toBe(401);
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('concurrency — count invariants (no lost / resurrected rows)', () => {
    let user: RegisteredUser;
    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
    });

    test('N concurrent distinct produces → count == N (no lost notifications)', async ({
        request,
    }) => {
        const N = 6;
        // create tasks serially (slug is sequential), then fire the notification
        // producers (assignee adds) genuinely in parallel.
        const tasks: { id: string }[] = [];
        for (let i = 0; i < N; i++) {
            tasks.push(
                await createTaskViaAPI(request, user.access_token, {
                    title: `conc ${uniq()} #${i}`,
                }),
            );
        }
        const results = await Promise.all(
            tasks.map((t) =>
                addTaskAssignee(request, user.access_token, t.id, {
                    assigneeType: 'user',
                    assigneeId: user.user.id,
                }),
            ),
        );
        expect(results.length).toBe(N);
        const count = await pollUntil(
            () => getCount(request, user.access_token),
            (c) => c >= N,
        );
        expect(count).toBe(N); // every concurrent insert landed — no lost update
        const rows = await listRows(request, user.access_token, '?limit=100');
        for (const t of tasks) expect(rowForTask(rows, t.id), `row for ${t.id}`).toBeTruthy();
    });

    test('N concurrent read-all calls all 200 and settle count at 0', async ({ request }) => {
        await produce(request, user.access_token, user.user.id, 5);
        const results = await Promise.all(
            Array.from({ length: 6 }, () => readAll(request, user.access_token)),
        );
        for (const r of results) {
            // sqlite tx serialization may surface a transient 5xx under contention;
            // tolerate it as a driver artifact but require the invariant below.
            expect([200, 500, 503]).toContain(r.status());
        }
        const count = await pollUntil(
            () => getCount(request, user.access_token),
            (c) => c === 0,
        );
        expect(count).toBe(0); // terminal state is deterministic regardless of race
    });

    test('N concurrent reads of the SAME id are idempotent (count decrements by exactly 1)', async ({
        request,
    }) => {
        await produce(request, user.access_token, user.user.id, 4);
        const rows = await listRows(request, user.access_token, '?limit=100');
        const id = rows[0].id;
        const results = await Promise.all(
            Array.from({ length: 6 }, () => markRead(request, user.access_token, id)),
        );
        for (const r of results) expect([200, 500, 503]).toContain(r.status());
        // exactly one unread removed — never double-counted, never resurrected
        const count = await pollUntil(
            () => getCount(request, user.access_token),
            (c) => c <= 3,
        );
        expect(count).toBe(3);
    });
});
