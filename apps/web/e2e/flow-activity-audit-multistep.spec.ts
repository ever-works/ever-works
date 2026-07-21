import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

/**
 * flow-activity-audit-multistep.spec.ts
 *
 * MULTI-STEP, MIXED-RESOURCE audit-trail flows. A fresh user drives a chain of
 * real mutations across TWO resource kinds — a Work (create) and a Task
 * (create → update → transition → delete) — then reads the whole cross-cutting
 * activity/audit surface: the flat list + every filter, the status summary, the
 * running-count, the per-Work feed, the CSV export, and the append-only
 * (no-write-route) contract.
 *
 * ── NEW ANGLE vs the existing activity/audit specs ─────────────────────────
 * The sibling suites drive their audit rows from member events
 * (flow-activity-org-audit), login/logout (flow-activity-audit-account),
 * website ingest (flow-activity-immutability / -sequences-concurrency), or Work
 * generation (flow-activity-feed-perwork-deep). NONE of them drives the
 * **tasks-domain lifecycle** as the audit source, and none pins the quirks that
 * lifecycle exposes. This file is built entirely on that source and pins:
 *   • Task-domain rows use `action === actionType` (snake_case, e.g.
 *     'task_created') — in DELIBERATE contrast to Work rows whose `action` is
 *     DOTTED ('work.created') and signup ('user.signup').
 *   • Task-domain rows carry `workId = null` EVEN when the task belongs to a
 *     Work, so `?workId=<work>` returns ONLY the `work_created` row and EXCLUDES
 *     the task rows — while the flat (user-scoped) list includes both. The same
 *     null-workId is why task rows never surface in the per-Work Activity Feed.
 *   • Deleting the task removes the Task (GET → 404) but its audit rows PERSIST
 *     and stay immutable — an append-only trail outlives its subject.
 *   • `running-count.count === summary.counts.in_progress`, and the summary
 *     status tally reconciles field-for-field with the flat list's own tally.
 *
 * ── PROBED CONTRACT (live 127.0.0.1:3100, sqlite in-memory, 2026-07-21) ─────
 * Every mutation the acting user performs appends ONE user-scoped
 * `activity_log` row (DESC createdAt). Observed shapes:
 *   POST /api/works                         → work_created  | action 'work.created'
 *       status 'completed' | workId=<work.id> | summary `Created work: <name>`
 *       | details null
 *   POST /api/tasks                         → task_created  | action 'task_created'
 *       status 'completed' | workId=null | summary `Task <taskId> — task_created`
 *       | details { slug, title, resourceType:'task', resourceId:<taskId> }
 *   PATCH /api/tasks/:id { priority }        → task_updated | action 'task_updated'
 *       | details { priority:{ before, after }, resourceType:'task', resourceId }
 *   POST /api/tasks/:id/transition { to }    → task_transitioned
 *       | details { from, to, force:false, resourceType:'task', resourceId }
 *   DELETE /api/tasks/:id?hard=true          → task_deleted
 *       | details { slug, resourceType:'task', resourceId }
 *   (register)                              → user_signup  | action 'user.signup'
 *       | status 'completed' | workId=null | summary 'Account created'
 *
 * Read surface — all STRICTLY user-scoped (findByUserId / findByIdAndUserId):
 *   GET /api/activity-log[?actionType&workId&status&search&dateFrom&dateTo&limit&offset]
 *       → { activities[], total }  (only the caller's OWN rows)
 *   GET /api/activity-log/summary        → { counts:{ pending,in_progress,completed,failed,cancelled } }
 *   GET /api/activity-log/running-count  → { count }   (== counts.in_progress)
 *   GET /api/activity-log/export[?…]     → 200 text/csv; charset=utf-8,
 *       Content-Disposition attachment; filename=activity-log.csv,
 *       header `Date,Action Type,Action,Status,Work,Summary`; Work column is
 *       quoted-empty ("") for null-Work rows, the quoted Work name otherwise.
 *   GET /api/activity-log/:id            → { activity } for the OWNER; 404 otherwise.
 *   GET /api/works/:id/activity-feed[?category&limit&cursor]
 *       → { entries[], nextCursor, serverTime, degraded } ; work_created shows as
 *       source 'platform-activity-log', category 'settings'; a Work with no
 *       deployed site reports degraded.directorySite.reason 'not_provisioned'.
 * Immutability: PATCH/PUT/DELETE on /:id and POST/PATCH/PUT/DELETE on the
 * collection all 404 (no write route exists). Unauthenticated reads 401; the
 * public /ingest endpoint 401s without the platform secret.
 *
 * ISOLATION DISCIPLINE: every test registers its own FRESH user(s) (never the
 * shared seeded user), so each user's OWN trail is fully deterministic and can
 * be pinned with exact counts. Cross-user rows are asserted via presence/
 * absence, never via global counts. Filename uses the safe `flow-` prefix.
 */

const TASK_CREATED = 'task_created';
const TASK_UPDATED = 'task_updated';
const TASK_TRANSITIONED = 'task_transitioned';
const TASK_DELETED = 'task_deleted';
const WORK_CREATED = 'work_created';
const USER_SIGNUP = 'user_signup';

interface ActivityEntry {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    createdAt: string;
    details?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    work?: { id: string; name: string } | null;
}

interface ActivityList {
    activities: ActivityEntry[];
    total: number;
}

interface StatusCounts {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** GET /api/activity-log[query]; asserts 200 + list shape. */
async function listActivity(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ActivityList> {
    const res = await request.get(`${API_BASE}/api/activity-log${query}`, {
        headers: authedHeaders(token),
    });
    expect(
        res.status(),
        `activity-log list (q=${query}) body=${await res.text().catch(() => '')}`,
    ).toBe(200);
    const body = (await res.json()) as ActivityList;
    expect(Array.isArray(body.activities), 'activities is array').toBe(true);
    expect(typeof body.total, 'total is number').toBe('number');
    return body;
}

async function getSummary(request: APIRequestContext, token: string): Promise<StatusCounts> {
    const res = await request.get(`${API_BASE}/api/activity-log/summary`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'summary → 200').toBe(200);
    return (await res.json()).counts as StatusCounts;
}

async function getRunningCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${API_BASE}/api/activity-log/running-count`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'running-count → 200').toBe(200);
    return (await res.json()).count as number;
}

async function updateTask(
    request: APIRequestContext,
    token: string,
    taskId: string,
    patch: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
        data: patch,
    });
}

async function deleteTask(request: APIRequestContext, token: string, taskId: string) {
    return request.delete(`${API_BASE}/api/tasks/${taskId}?hard=true`, {
        headers: authedHeaders(token),
    });
}

/** Find the single row of a given actionType in a user's OWN scoped list. */
function oneRow(list: ActivityList, actionType: string): ActivityEntry {
    const rows = list.activities.filter((a) => a.actionType === actionType);
    expect(rows.length, `exactly one ${actionType} row (got ${rows.length})`).toBe(1);
    return rows[0];
}

interface Seeded {
    user: RegisteredUser;
    workId: string;
    workName: string;
    taskId: string;
    taskSlug: string;
}

/**
 * Register a fresh user, create ONE Work, then run a full Task lifecycle
 * (create → update priority → transition backlog→todo → delete-hard). Leaves a
 * deterministic 6-row trail: user_signup, work_created, task_created,
 * task_updated, task_transitioned, task_deleted — all `completed`.
 */
async function seedFullTrail(request: APIRequestContext): Promise<Seeded> {
    const user = await registerUserViaAPI(request);
    const s = stamp();
    const workName = `Audit MS ${s}`;
    const work = await createWorkViaAPI(request, user.access_token, {
        name: workName,
        slug: `audit-ms-${s}`,
    });
    const task = await createTaskViaAPI(request, user.access_token, {
        title: `Audit MS Task ${s}`,
        workId: work.id,
    });
    const upd = await updateTask(request, user.access_token, task.id, { priority: 'p1' });
    expect(upd.status(), 'task update → 200').toBe(200);
    await transitionTaskViaAPI(request, user.access_token, task.id, 'todo');
    const del = await deleteTask(request, user.access_token, task.id);
    expect(del.status(), 'task hard-delete → 200').toBe(200);
    return { user, workId: work.id, workName, taskId: task.id, taskSlug: task.slug };
}

test.describe('Activity audit — multi-step, mixed-resource trail', () => {
    test.describe.configure({ timeout: 90_000 });

    // ── A. Task-lifecycle audit trail ──────────────────────────────────────

    test('1) a single Task create appends one row: action===actionType, workId=null, resourceId details', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const s = stamp();
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Audit One ${s}`,
            slug: `audit-one-${s}`,
        });
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `One Task ${s}`,
            workId: work.id,
        });

        const list = await listActivity(request, user.access_token);
        const created = oneRow(list, TASK_CREATED);
        // Task-domain rows: `action` is the RAW snake_case actionType, NOT a
        // dotted string — the tasks.service logActivity uses `action: actionType`.
        expect(created.action, 'task action === actionType (snake_case)').toBe(TASK_CREATED);
        expect(created.action).toBe(created.actionType);
        expect(created.status, 'task_created completed').toBe('completed');
        // The task belongs to the Work, yet the audit row's workId column is null.
        expect(created.workId, 'task rows carry workId=null (not the task’s workId)').toBeNull();
        expect(created.userId, 'attributed to the actor').toBe(user.user.id);
        expect(created.summary).toBe(`Task ${task.id} — task_created`);
        expect(created.details?.resourceType).toBe('task');
        expect(created.details?.resourceId).toBe(task.id);
        expect(created.details?.slug).toBe(task.slug);
        expect(created.details?.title).toBe(`One Task ${s}`);
    });

    test('2) full lifecycle appends four ordered task rows with step-specific details; contrasts dotted work.created', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const list = await listActivity(request, seeded.user.access_token);

        // Deterministic OWN trail: signup + work_created + 4 task rows = 6.
        expect(list.total, 'signup + work_created + create/update/transition/delete = 6').toBe(6);
        const byType = list.activities.map((a) => a.actionType);
        for (const t of [
            USER_SIGNUP,
            WORK_CREATED,
            TASK_CREATED,
            TASK_UPDATED,
            TASK_TRANSITIONED,
            TASK_DELETED,
        ]) {
            expect(byType, `trail contains ${t}`).toContain(t);
        }

        // Each task row: action === actionType (snake), status completed, workId null.
        for (const a of list.activities.filter((x) => x.actionType.startsWith('task_'))) {
            expect(a.action, `${a.actionType} action===actionType`).toBe(a.actionType);
            expect(a.status).toBe('completed');
            expect(a.workId, `${a.actionType} workId null`).toBeNull();
            expect(a.details?.resourceType).toBe('task');
            expect(a.details?.resourceId).toBe(seeded.taskId);
        }

        // Step-specific details.
        const updated = oneRow(list, TASK_UPDATED);
        expect(updated.details?.priority, 'update diff carries before/after').toEqual({
            before: 'p3',
            after: 'p1',
        });
        const transitioned = oneRow(list, TASK_TRANSITIONED);
        expect(transitioned.details?.from).toBe('backlog');
        expect(transitioned.details?.to).toBe('todo');
        expect(transitioned.details?.force).toBe(false);
        const deleted = oneRow(list, TASK_DELETED);
        expect(deleted.details?.slug).toBe(seeded.taskSlug);

        // CONTRAST: the Work row's `action` is DOTTED, and signup is dotted too —
        // proving the snake-case task rows are a genuine, distinct convention.
        const work = oneRow(list, WORK_CREATED);
        expect(work.action, 'work.created is dotted').toBe('work.created');
        expect(work.action).not.toBe(work.actionType);
        expect(work.workId, 'work_created IS work-scoped').toBe(seeded.workId);
        const signup = oneRow(list, USER_SIGNUP);
        expect(signup.action).toBe('user.signup');
    });

    test('3) deleting the Task removes it (GET → 404) but its audit rows PERSIST and stay immutable', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);

        // The Task subject is gone.
        const getTask = await request.get(`${API_BASE}/api/tasks/${seeded.taskId}`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        expect(getTask.status(), 'deleted task → 404').toBe(404);

        // Yet the create + delete audit rows both survive (append-only trail).
        const list = await listActivity(request, seeded.user.access_token);
        expect(list.activities.some((a) => a.actionType === TASK_CREATED)).toBe(true);
        expect(list.activities.some((a) => a.actionType === TASK_DELETED)).toBe(true);

        // And the surviving task_created row cannot be mutated/removed via the log.
        const created = oneRow(list, TASK_CREATED);
        for (const verb of ['patch', 'put', 'delete'] as const) {
            const res = await request[verb](`${API_BASE}/api/activity-log/${created.id}`, {
                headers: authedHeaders(seeded.user.access_token),
                data: { status: 'failed' },
            });
            expect(res.status(), `${verb} on audit row → 404 (append-only)`).toBe(404);
        }
        // It still reads back unchanged.
        const reread = await listActivity(
            request,
            seeded.user.access_token,
            `?actionType=${TASK_CREATED}`,
        );
        expect(oneRow(reread, TASK_CREATED).status).toBe('completed');
    });

    test('4) the mixed trail is createdAt-DESC and chronologically consistent (tie-safe on same-second rows)', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const list = await listActivity(request, seeded.user.access_token);
        const ts = list.activities.map((a) => new Date(a.createdAt).getTime());
        // The returned order is DESC (newest-first): non-increasing timestamps.
        for (let i = 0; i < ts.length - 1; i++) {
            expect(ts[i], 'createdAt DESC monotonic non-increasing').toBeGreaterThanOrEqual(
                ts[i + 1],
            );
        }
        // Chronology (asserted on the CLOCK, not list index, so same-second ties
        // between adjacent steps cannot flake): the delete never predates the
        // create, the create never predates the work, and signup is the eldest.
        const at = (t: string) =>
            new Date(list.activities.find((a) => a.actionType === t)!.createdAt).getTime();
        expect(at(TASK_DELETED)).toBeGreaterThanOrEqual(at(TASK_CREATED));
        expect(at(TASK_CREATED)).toBeGreaterThanOrEqual(at(WORK_CREATED));
        expect(at(WORK_CREATED)).toBeGreaterThanOrEqual(at(USER_SIGNUP));
        const minTs = Math.min(...ts);
        expect(at(USER_SIGNUP), 'signup is the eldest event').toBe(minTs);
    });

    // ── B. workId-scoping quirk + filter matrix ────────────────────────────

    test('5) ?workId returns ONLY work_created — task rows (workId=null) are excluded', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);

        const scoped = await listActivity(
            request,
            seeded.user.access_token,
            `?workId=${seeded.workId}`,
        );
        expect(scoped.total, 'workId filter → just the work_created row').toBe(1);
        expect(scoped.activities[0].actionType).toBe(WORK_CREATED);
        expect(scoped.activities.every((a) => a.workId === seeded.workId)).toBe(true);

        // The very same task rows ARE present in the un-scoped list.
        const flat = await listActivity(request, seeded.user.access_token);
        expect(flat.activities.some((a) => a.actionType === TASK_CREATED)).toBe(true);
        expect(flat.total).toBeGreaterThan(scoped.total);
    });

    test('6) workId+actionType combos: work_created→1, task_created→0 (null workId is unreachable by workId)', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const wc = await listActivity(
            request,
            seeded.user.access_token,
            `?workId=${seeded.workId}&actionType=${WORK_CREATED}`,
        );
        expect(wc.total).toBe(1);
        const tc = await listActivity(
            request,
            seeded.user.access_token,
            `?workId=${seeded.workId}&actionType=${TASK_CREATED}`,
        );
        expect(tc.total, 'task rows are not reachable through the workId filter').toBe(0);
    });

    test('7) actionType filter isolates each task action; an unknown type → 200 empty', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        for (const t of [TASK_CREATED, TASK_UPDATED, TASK_TRANSITIONED, TASK_DELETED]) {
            const only = await listActivity(request, seeded.user.access_token, `?actionType=${t}`);
            expect(only.total, `${t} filter → exactly 1`).toBe(1);
            expect(only.activities[0].actionType).toBe(t);
        }
        const bogus = await listActivity(
            request,
            seeded.user.access_token,
            `?actionType=not_a_real_action_type`,
        );
        expect(bogus.total, 'unknown actionType → empty, not an error').toBe(0);
    });

    test('8) status filter: completed returns the whole trail; empty statuses → 200 empty', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const completed = await listActivity(
            request,
            seeded.user.access_token,
            `?status=completed`,
        );
        expect(completed.total, 'every seeded row is completed').toBe(6);
        expect(completed.activities.every((a) => a.status === 'completed')).toBe(true);
        for (const st of ['failed', 'in_progress', 'pending', 'cancelled']) {
            const none = await listActivity(request, seeded.user.access_token, `?status=${st}`);
            expect(none.total, `no ${st} rows in this flow`).toBe(0);
        }
        // An unknown status string is tolerated (200) and simply matches nothing.
        const unknown = await listActivity(request, seeded.user.access_token, `?status=zzz`);
        expect(unknown.total).toBe(0);
    });

    test('9) search matches the summary (task-id fragment) and the joined Work name', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        // Every task row's summary embeds the taskId → search by it finds them all.
        const byTaskId = await listActivity(
            request,
            seeded.user.access_token,
            `?search=${seeded.taskId}`,
        );
        expect(
            byTaskId.total,
            'task-id search finds all four task rows (create/update/transition/delete)',
        ).toBe(4);
        expect(byTaskId.activities.every((a) => a.summary.includes(seeded.taskId))).toBe(true);

        // Work-name search reaches the work_created row via the work join.
        const byWorkName = await listActivity(
            request,
            seeded.user.access_token,
            `?search=${encodeURIComponent(seeded.workName)}`,
        );
        expect(byWorkName.total, 'work-name search finds work_created').toBeGreaterThanOrEqual(1);
        expect(byWorkName.activities.some((a) => a.actionType === WORK_CREATED)).toBe(true);

        const nothing = await listActivity(
            request,
            seeded.user.access_token,
            `?search=zzz-no-such-summary-${stamp()}`,
        );
        expect(nothing.total).toBe(0);
    });

    test('10) date window: far-future dateFrom → empty; far-past dateTo → empty; wide window → full trail', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const future = await listActivity(
            request,
            seeded.user.access_token,
            `?dateFrom=2099-01-01`,
        );
        expect(future.total, 'future dateFrom → empty').toBe(0);
        const past = await listActivity(request, seeded.user.access_token, `?dateTo=2000-01-01`);
        expect(past.total, 'past dateTo → empty').toBe(0);
        const wide = await listActivity(
            request,
            seeded.user.access_token,
            `?dateFrom=2000-01-01&dateTo=2099-01-01`,
        );
        expect(wide.total, 'wide window → whole trail').toBe(6);
    });

    test('11) pagination: limit honoured, offset windows are gap-free and non-overlapping; oversized/garbage limits tolerated', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const full = await listActivity(request, seeded.user.access_token, `?limit=100`);
        expect(full.total).toBe(6);
        const fullIds = full.activities.map((a) => a.id);

        const page1 = await listActivity(request, seeded.user.access_token, `?limit=2&offset=0`);
        expect(page1.activities.length, 'limit honoured').toBe(2);
        expect(page1.total, 'total ignores the page window').toBe(6);
        const page2 = await listActivity(request, seeded.user.access_token, `?limit=2&offset=2`);
        const page3 = await listActivity(request, seeded.user.access_token, `?limit=2&offset=4`);
        const walked = [...page1.activities, ...page2.activities, ...page3.activities].map(
            (a) => a.id,
        );
        // Gap-free + non-overlapping: the three offset windows together cover
        // exactly the full id-set with no dupes (compared as a set so a
        // same-second tiebreak between two separate queries can't flake it).
        expect(new Set(walked).size, 'no dupes across offset windows').toBe(walked.length);
        expect([...walked].sort(), 'windows reconstruct the whole trail').toEqual(
            [...fullIds].sort(),
        );

        // Oversized limit is internally capped (still 200); non-numeric limit is
        // tolerated (returns 200, not a 400) — pinned as OBSERVED behaviour.
        const big = await request.get(`${API_BASE}/api/activity-log?limit=1000`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        expect(big.status(), 'oversized limit → 200').toBe(200);
        const garbage = await request.get(`${API_BASE}/api/activity-log?limit=abc`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        expect([200, 400], 'non-numeric limit tolerated (observed 200)').toContain(
            garbage.status(),
        );
    });

    // ── C. summary + running-count consistency ─────────────────────────────

    test('12) summary counts reconcile field-for-field with the flat list’s own status tally', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const list = await listActivity(request, seeded.user.access_token, `?limit=100`);
        const tally: Record<string, number> = {
            pending: 0,
            in_progress: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        };
        for (const a of list.activities) tally[a.status] = (tally[a.status] ?? 0) + 1;

        const counts = await getSummary(request, seeded.user.access_token);
        expect(counts.completed, 'every seeded row is completed').toBe(6);
        expect(counts.pending).toBe(0);
        expect(counts.in_progress).toBe(0);
        expect(counts.failed).toBe(0);
        expect(counts.cancelled).toBe(0);
        // The summary is exactly the list's own status histogram.
        expect(counts.completed).toBe(tally.completed);
        const summed =
            counts.pending +
            counts.in_progress +
            counts.completed +
            counts.failed +
            counts.cancelled;
        expect(summed, 'summed statuses == list total').toBe(list.total);
    });

    test('13) running-count === summary.in_progress across the two endpoints (0 for a completed-only trail)', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const counts = await getSummary(request, seeded.user.access_token);
        const running = await getRunningCount(request, seeded.user.access_token);
        expect(typeof running).toBe('number');
        expect(running, 'running-count mirrors summary.in_progress').toBe(counts.in_progress);
        expect(running, 'no in-progress work in this flow').toBe(0);
    });

    // ── D. CSV export of a mixed-resource trail ────────────────────────────

    test('14) export download contract: 200 text/csv, attachment filename, exact header', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        expect(res.status(), 'export → 200').toBe(200);
        expect((res.headers()['content-type'] || '').toLowerCase()).toContain('text/csv');
        expect(res.headers()['content-disposition'] || '').toContain('activity-log.csv');
        const lines = (await res.text()).split('\n').filter((l) => l.length > 0);
        expect(lines[0]).toBe('Date,Action Type,Action,Status,Work,Summary');
        // Header + the 6 seeded rows.
        expect(lines.length, 'header + 6 rows').toBe(7);
    });

    test('15) export body mixes dotted work.created and snake task_created; Work column quoted-empty for null-Work rows', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        const body = await res.text();
        const lines = body.split('\n').filter((l) => l.length > 0);

        // work_created: dotted action, quoted Work name in the Work column.
        const workLine = lines.find((l) => l.includes(',work_created,work.created,completed,'));
        expect(workLine, 'work_created CSV row present').toBeTruthy();
        expect(workLine!).toContain(`"${seeded.workName}"`);

        // task_created: snake action === actionType, Work column is quoted-empty.
        const taskLine = lines.find((l) => l.includes(',task_created,task_created,completed,"",'));
        expect(taskLine, 'task_created CSV row has empty Work cell + snake action').toBeTruthy();
        expect(taskLine!).toContain(`Task ${seeded.taskId} — task_created`);

        // signup is dotted too, with an empty Work cell.
        expect(
            lines.some((l) =>
                l.includes(',user_signup,user.signup,completed,"","Account created"'),
            ),
        ).toBe(true);
    });

    test('16) export honours actionType and status filters', async ({ request }) => {
        const seeded = await seedFullTrail(request);
        const onlyTaskCreated = await request.get(
            `${API_BASE}/api/activity-log/export?actionType=${TASK_CREATED}`,
            { headers: authedHeaders(seeded.user.access_token) },
        );
        const tcLines = (await onlyTaskCreated.text()).split('\n').filter((l) => l.length > 0);
        expect(tcLines[0]).toBe('Date,Action Type,Action,Status,Work,Summary');
        expect(tcLines.length, 'header + exactly one task_created row').toBe(2);
        expect(tcLines[1]).toContain(',task_created,task_created,completed,');
        // work.created must NOT be in a task_created-filtered export.
        expect(tcLines.some((l) => l.includes('work.created'))).toBe(false);

        // A status with no rows exports the header alone.
        const failedOnly = await request.get(`${API_BASE}/api/activity-log/export?status=failed`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        const fLines = (await failedOnly.text()).split('\n').filter((l) => l.length > 0);
        expect(fLines.length, 'no failed rows → header only').toBe(1);
    });

    // ── E. per-Work activity feed ──────────────────────────────────────────

    test('17) per-Work feed surfaces work_created (category settings) but NOT the null-workId task rows', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const res = await request.get(`${API_BASE}/api/works/${seeded.workId}/activity-feed`, {
            headers: authedHeaders(seeded.user.access_token),
        });
        expect(res.status(), 'feed → 200').toBe(200);
        const body = (await res.json()) as {
            entries: Array<Record<string, unknown>>;
            serverTime: string;
            nextCursor?: string | null;
            degraded?: { directorySite?: { reason?: string } };
        };
        expect(Array.isArray(body.entries), 'entries array').toBe(true);
        expect(typeof body.serverTime, 'serverTime present').toBe('string');
        expect(body.nextCursor ?? null, 'small feed → no cursor').toBeNull();

        const workEntry = body.entries.find((e) => e.type === WORK_CREATED);
        expect(workEntry, 'work_created appears in the feed').toBeTruthy();
        expect(workEntry!.source).toBe('platform-activity-log');
        expect(workEntry!.category, 'work mutations land in the settings category').toBe(
            'settings',
        );
        expect(workEntry!.summary).toBe(`Created work: ${seeded.workName}`);
        expect(workEntry!.status).toBe('completed');

        // Task-domain rows (workId=null) never reach the per-Work feed.
        expect(
            body.entries.some((e) => String(e.type ?? '').startsWith('task_')),
            'task rows excluded from the per-Work feed',
        ).toBe(false);

        // No deployed site → degraded directory-site reason.
        expect(body.degraded?.directorySite?.reason).toBe('not_provisioned');
    });

    test('18) feed validates category + id and gates cross-user access', async ({ request }) => {
        const seeded = await seedFullTrail(request);
        const token = seeded.user.access_token;

        // limit within 1..200 and category=all are accepted.
        const ok = await request.get(
            `${API_BASE}/api/works/${seeded.workId}/activity-feed?limit=5&category=all`,
            { headers: authedHeaders(token) },
        );
        expect(ok.status()).toBe(200);

        // A bogus category → 400; a non-UUID work id → 400.
        const badCat = await request.get(
            `${API_BASE}/api/works/${seeded.workId}/activity-feed?category=bogus`,
            { headers: authedHeaders(token) },
        );
        expect(badCat.status(), 'invalid category → 400').toBe(400);
        const badId = await request.get(`${API_BASE}/api/works/not-a-uuid/activity-feed`, {
            headers: authedHeaders(token),
        });
        expect(badId.status(), 'non-uuid id → 400').toBe(400);

        // A stranger cannot read the owner's Work feed.
        const stranger = await registerUserViaAPI(request);
        const cross = await request.get(`${API_BASE}/api/works/${seeded.workId}/activity-feed`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect([403, 404], 'cross-user feed is gated').toContain(cross.status());
    });

    // ── F. immutability + auth + isolation ─────────────────────────────────

    test('19) the log exposes no write route: every mutating verb 404s and the row stays byte-identical', async ({
        request,
    }) => {
        const seeded = await seedFullTrail(request);
        const token = seeded.user.access_token;
        const list = await listActivity(request, token, `?actionType=${TASK_CREATED}`);
        const row = oneRow(list, TASK_CREATED);

        // Snapshot the entry via the by-id read.
        const before = await request.get(`${API_BASE}/api/activity-log/${row.id}`, {
            headers: authedHeaders(token),
        });
        expect(before.status()).toBe(200);
        const beforeJson = JSON.stringify((await before.json()).activity);

        // A tamper burst against both the item and the collection.
        for (const verb of ['patch', 'put', 'delete'] as const) {
            const item = await request[verb](`${API_BASE}/api/activity-log/${row.id}`, {
                headers: authedHeaders(token),
                data: { status: 'failed', summary: 'tampered' },
            });
            expect(item.status(), `${verb} /:id → 404`).toBe(404);
        }
        for (const verb of ['post', 'patch', 'put', 'delete'] as const) {
            const coll = await request[verb](`${API_BASE}/api/activity-log`, {
                headers: authedHeaders(token),
                data: { summary: 'inject' },
            });
            expect(coll.status(), `${verb} collection → 404`).toBe(404);
        }

        // The row is unchanged after the burst.
        const after = await request.get(`${API_BASE}/api/activity-log/${row.id}`, {
            headers: authedHeaders(token),
        });
        expect(JSON.stringify((await after.json()).activity)).toBe(beforeJson);
    });

    test('20) unauthenticated reads 401; the public ingest endpoint 401s without the platform secret', async ({
        request,
    }) => {
        for (const path of ['', '/summary', '/running-count', '/export']) {
            const res = await request.get(`${API_BASE}/api/activity-log${path}`);
            expect(res.status(), `no-token GET /api/activity-log${path} → 401`).toBe(401);
        }
        // Ingest is @Public but PlatformSecretGuard-gated: no secret / wrong secret → 401.
        const noSecret = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            data: {
                workId: '00000000-0000-0000-0000-000000000000',
                eventId: `e-${stamp()}`,
                actionType: 'website_user_registered',
                occurredAt: new Date().toISOString(),
                summary: 'x',
            },
        });
        expect(noSecret.status(), 'ingest without secret → 401').toBe(401);
        const badSecret = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            headers: { authorization: 'Bearer wrong-secret' },
            data: {
                workId: '00000000-0000-0000-0000-000000000000',
                eventId: `e-${stamp()}`,
                actionType: 'website_user_registered',
                occurredAt: new Date().toISOString(),
                summary: 'x',
            },
        });
        expect(badSecret.status(), 'ingest with wrong secret → 401').toBe(401);
    });

    test('21) audit is strictly per-user: two users’ task trails are disjoint; cross-user by-id read 404s', async ({
        request,
    }) => {
        const a = await seedFullTrail(request);
        const b = await seedFullTrail(request);

        // Each user sees ONLY their own rows, all attributed to themselves.
        const aList = await listActivity(request, a.user.access_token, `?limit=100`);
        const bList = await listActivity(request, b.user.access_token, `?limit=100`);
        expect(aList.activities.every((x) => x.userId === a.user.user.id)).toBe(true);
        expect(bList.activities.every((x) => x.userId === b.user.user.id)).toBe(true);

        // B's task id never shows up in A's trail, and vice-versa.
        const aTaskRows = aList.activities.filter((x) => x.details?.resourceId === b.taskId);
        expect(aTaskRows.length, 'B’s task rows never leak into A’s log').toBe(0);
        const bWorkRows = bList.activities.filter((x) => x.workId === a.workId);
        expect(bWorkRows.length, 'A’s work_created never leaks into B’s log').toBe(0);

        // A's own work_created row is unreadable by B via get-by-id.
        const aWork = oneRow(
            await listActivity(request, a.user.access_token, `?actionType=${WORK_CREATED}`),
            WORK_CREATED,
        );
        const crossRead = await request.get(`${API_BASE}/api/activity-log/${aWork.id}`, {
            headers: authedHeaders(b.user.access_token),
        });
        expect(crossRead.status(), 'cross-user get-by-id → 404 (not 403-with-body)').toBe(404);
        const ownRead = await request.get(`${API_BASE}/api/activity-log/${aWork.id}`, {
            headers: authedHeaders(a.user.access_token),
        });
        expect(ownRead.status(), 'owner reads own row → 200').toBe(200);
        expect((await ownRead.json()).activity?.id).toBe(aWork.id);
    });
});
