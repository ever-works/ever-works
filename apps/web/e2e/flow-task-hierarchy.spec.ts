import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Task subtasks + hierarchy — complex, multi-step, cross-feature API
 * integration flows for the Tasks domain. Each test() orchestrates several
 * real endpoints in sequence and asserts the platform's TRUE, observable
 * behaviour at every step (parent/child wiring, filter AND-ing, pagination
 * windows, full-text-ish search across title/slug/description).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   POST /api/auth/register {username(>=3 chars),email,password}
 *        -> 201 { access_token (32-char opaque), user:{ id,email,username } }
 *
 *   POST /api/tasks { title, description?, status?, priority?, labels?,
 *                     missionId?, ideaId?, workId?, parentTaskId?,
 *                     requireAllApprovers? }
 *        -> 201 (full Task entity)
 *           { id, userId, slug:'T-n', title, description:null, status:'backlog',
 *             priority:'p3'(default), labels|null, missionId|null, ideaId|null,
 *             workId|null, parentTaskId|null, createdByType:'user',
 *             createdById, requireAllApprovers:true, ... createdAt, updatedAt }
 *        -> creating a child with a non-existent parentTaskId is 400
 *           { message:'Parent Task <id> not found.', error:'Bad Request', statusCode:400 }
 *
 *   GET  /api/tasks?<filters>
 *        -> 200 { data:[Task...], meta:{ total, limit, offset } }
 *        Filters (controller + TaskRepository.findByUserIdFiltered):
 *          - parentTaskId : exact equality (task.parentTaskId = :id)
 *          - priority     : single 'p1' OR comma-list 'p1,p2' (IN clause)
 *          - status       : single 'backlog' OR comma-list (IN clause)
 *          - label        : substring match against the serialized simple-json
 *                           labels column (LIKE %"<label>"%) — matches a task
 *                           that carries the label among several
 *          - search       : LIKE %term% across (title OR slug OR description)
 *        Filters AND together (parentTaskId + priority narrows to the
 *        intersection). limit clamps to [1,200] (default 50); offset >= 0
 *        (default 0). A non-numeric limit (e.g. ?limit=abc) is tolerated
 *        (parseInt(...)||50 -> 200, never 5xx). Order is updatedAt DESC.
 *        Invalid priority/status filter values are rejected with 400
 *        ('Invalid priority filter: <v>' / 'Invalid status filter: <v>').
 *
 * ───────────────────────────────────────────────────────────────────────────
 * METHOD / ISOLATION:
 *   These flows are pure API orchestration (there is no dedicated Tasks UI
 *   page in apps/web yet — no app/[locale]/**\/tasks route exists — so a UI
 *   driver would have nothing truthful to assert against). The assignment
 *   explicitly permits "deterministic API-orchestrated assertions"; we lean
 *   into that. Every flow runs on its OWN fresh registerUserViaAPI() user so
 *   the shared in-memory DB stays clean for sibling specs and so per-user
 *   `total` counts are exact and deterministic (slug counter + task rows are
 *   user-scoped). Each title carries a unique suffix; search terms use
 *   high-entropy markers so they cannot collide with sibling data.
 *
 * NOTE ON ORDERING: the repository sorts by updatedAt DESC. Tasks created in
 *   rapid succession share a second-granular updatedAt, so cross-page row
 *   ORDER is not stable enough to assert. We therefore assert pagination via
 *   meta + window SIZE + cross-window DISJOINTNESS + full-set COVERAGE rather
 *   than a positional order (mirrors tasks-pagination-filter.spec.ts).
 */

interface Task {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
    parentTaskId: string | null;
    labels: string[] | null;
    description: string | null;
}

interface TaskListResponse {
    data: Task[];
    meta: { total: number; limit: number; offset: number };
}

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a Task via the live API, asserting the 201 + entity shape. */
async function createTask(
    request: APIRequestContext,
    token: string,
    body: {
        title: string;
        description?: string;
        priority?: string;
        status?: string;
        labels?: string[];
        parentTaskId?: string;
    },
): Promise<Task> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `createTask body=${await res.text().catch(() => '')}`).toBe(201);
    const task = (await res.json()) as Task;
    expect(task.id, 'created task has an id').toBeTruthy();
    expect(task.slug, 'created task has a T-n slug').toMatch(/^T-\d+$/);
    return task;
}

/** List Tasks with an arbitrary query string, asserting the 200 + envelope. */
async function listTasks(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<TaskListResponse> {
    const res = await request.get(`${API_BASE}/api/tasks${query ? `?${query}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `listTasks(${query}) body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as TaskListResponse;
    expect(Array.isArray(body.data), 'list envelope has a data array').toBe(true);
    expect(typeof body.meta?.total, 'list envelope has numeric meta.total').toBe('number');
    expect(typeof body.meta?.limit, 'list envelope has numeric meta.limit').toBe('number');
    expect(typeof body.meta?.offset, 'list envelope has numeric meta.offset').toBe('number');
    return body;
}

test.describe('Task hierarchy — subtasks, filters/pagination, search', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: parent + several subtasks. GET ?parentTaskId returns ONLY the
    //         children (not the parent, not unrelated tasks); the children
    //         all carry parentTaskId === parent.id; a bogus parentTaskId is
    //         rejected at create time; filtering by a random parent yields an
    //         empty (but well-formed) page.
    // ───────────────────────────────────────────────────────────────────────
    test('parent task lists exactly its subtasks via ?parentTaskId', async ({ request }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const sfx = uniqueSuffix();

        // --- Step 1: create the parent (an "epic"). ---
        const parent = await createTask(request, token, {
            title: `Parent Epic ${sfx}`,
            priority: 'p1',
            labels: ['epic'],
        });
        expect(parent.parentTaskId, 'a root task has no parent').toBeNull();
        expect(parent.status, 'a fresh task starts in backlog').toBe('backlog');

        // --- Step 2: create several subtasks under it. ---
        const childTitles = [
            `Child A ${sfx}`,
            `Child B ${sfx}`,
            `Child C ${sfx}`,
            `Child D ${sfx}`,
        ];
        const children: Task[] = [];
        for (const title of childTitles) {
            const child = await createTask(request, token, {
                title,
                parentTaskId: parent.id,
                priority: 'p2',
                labels: ['child'],
            });
            expect(child.parentTaskId, 'child is wired to the parent').toBe(parent.id);
            children.push(child);
        }

        // --- Step 3: an unrelated root task that must NOT leak into the
        //         parent's child listing. ---
        const unrelated = await createTask(request, token, {
            title: `Unrelated Root ${sfx}`,
            priority: 'p3',
        });
        expect(unrelated.parentTaskId, 'the unrelated task is itself a root').toBeNull();

        // --- Step 4: GET ?parentTaskId returns EXACTLY the children. ---
        const subtaskList = await listTasks(request, token, `parentTaskId=${parent.id}`);
        expect(subtaskList.meta.total, 'parentTaskId filter total == #subtasks').toBe(
            childTitles.length,
        );
        expect(subtaskList.data.length, 'parentTaskId page returns all subtasks').toBe(
            childTitles.length,
        );
        // Every returned row is a genuine child of the parent...
        expect(
            subtaskList.data.every((t) => t.parentTaskId === parent.id),
            'every subtask carries the parent id',
        ).toBe(true);
        // ...and the set is precisely the children we created.
        const returnedChildIds = subtaskList.data.map((t) => t.id).sort();
        const expectedChildIds = children.map((t) => t.id).sort();
        expect(returnedChildIds, 'the subtask set is exactly our children').toEqual(
            expectedChildIds,
        );
        // The parent itself is NOT in its own child listing.
        expect(
            subtaskList.data.map((t) => t.id),
            'the parent is not listed among its children',
        ).not.toContain(parent.id);
        // ...nor is the unrelated root.
        expect(
            subtaskList.data.map((t) => t.id),
            'an unrelated root task does not leak into the child listing',
        ).not.toContain(unrelated.id);

        // --- Step 5: the parent appears in the UNFILTERED listing as a root
        //         (parentTaskId null), alongside every child + the unrelated
        //         task. Total for this fresh user == parent + children + 1. ---
        const allList = await listTasks(request, token, 'limit=200');
        expect(allList.meta.total, 'fresh user total == parent + children + unrelated').toBe(
            childTitles.length + 2,
        );
        const parentRow = allList.data.find((t) => t.id === parent.id);
        expect(parentRow, 'the parent is present in the full listing').toBeTruthy();
        expect(parentRow?.parentTaskId, 'the parent stays a root in the full listing').toBeNull();

        // --- Step 6: a parentTaskId pointing at a task with NO children
        //         (the unrelated root) yields an empty, well-formed page. ---
        const noChildren = await listTasks(request, token, `parentTaskId=${unrelated.id}`);
        expect(noChildren.meta.total, 'a childless parent reports total 0').toBe(0);
        expect(noChildren.data.length, 'a childless parent returns no rows').toBe(0);

        // --- Step 7: creating a subtask under a NON-EXISTENT parent is
        //         rejected (400) — the hierarchy refuses dangling edges. ---
        const orphanRes = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: {
                title: `Orphan ${sfx}`,
                parentTaskId: '00000000-0000-0000-0000-000000000000',
            },
        });
        expect(orphanRes.status(), 'child of a missing parent is rejected (400)').toBe(400);
        const orphanBody = await orphanRes.json();
        expect(String(orphanBody.message), 'error names the missing parent').toMatch(
            /parent task .* not found/i,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: filtering + pagination across a large-ish set. Build many tasks
    //         with deterministic label/priority/status combinations, then
    //         assert label / priority (single + comma-list) / status filters,
    //         the AND-ing of two filters, pagination meta + disjoint windows
    //         covering the whole set, and limit clamping + garbage tolerance.
    // ───────────────────────────────────────────────────────────────────────
    test('subtask filtering by label/priority/status + pagination meta windows', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const sfx = uniqueSuffix();

        // A parent + 9 subtasks with a known matrix of attributes. We track
        // expected counts locally so assertions are exact for this clean user.
        const parent = await createTask(request, token, {
            title: `Filter Parent ${sfx}`,
            priority: 'p4',
            labels: ['epic'],
        });

        // 9 subtasks. priority distribution: p0 x2, p1 x3, p2 x4.
        // label `urgent` on indices {0,2,5}; everyone also has the shared
        // `child` label so label filtering must match a label among several.
        const subtaskSpecs: Array<{ priority: string; labels: string[] }> = [
            { priority: 'p0', labels: ['child', 'urgent'] }, // 0
            { priority: 'p0', labels: ['child'] }, // 1
            { priority: 'p1', labels: ['child', 'urgent'] }, // 2
            { priority: 'p1', labels: ['child'] }, // 3
            { priority: 'p1', labels: ['child'] }, // 4
            { priority: 'p2', labels: ['child', 'urgent'] }, // 5
            { priority: 'p2', labels: ['child'] }, // 6
            { priority: 'p2', labels: ['child'] }, // 7
            { priority: 'p2', labels: ['child'] }, // 8
        ];
        const subtasks: Task[] = [];
        for (let i = 0; i < subtaskSpecs.length; i++) {
            const spec = subtaskSpecs[i];
            subtasks.push(
                await createTask(request, token, {
                    title: `Sub ${i} ${sfx}`,
                    parentTaskId: parent.id,
                    priority: spec.priority,
                    labels: spec.labels,
                }),
            );
        }

        const countP0 = subtaskSpecs.filter((s) => s.priority === 'p0').length; // 2
        const countP1 = subtaskSpecs.filter((s) => s.priority === 'p1').length; // 3
        const countP2 = subtaskSpecs.filter((s) => s.priority === 'p2').length; // 4
        const countUrgent = subtaskSpecs.filter((s) => s.labels.includes('urgent')).length; // 3

        // --- Step 1: label filter — every subtask carries `child`, so the
        //         label filter scoped to the parent returns all 9. ---
        const childLabel = await listTasks(request, token, `parentTaskId=${parent.id}&label=child`);
        expect(childLabel.meta.total, 'all subtasks carry the child label').toBe(
            subtaskSpecs.length,
        );
        expect(
            childLabel.data.every((t) => (t.labels ?? []).includes('child')),
            'every returned row actually carries the child label',
        ).toBe(true);

        // --- Step 2: label filter — `urgent` is on a subset; the filter must
        //         match a task that carries the label AMONG several. ---
        const urgent = await listTasks(request, token, `parentTaskId=${parent.id}&label=urgent`);
        expect(urgent.meta.total, 'urgent label narrows to the labelled subset').toBe(countUrgent);
        expect(
            urgent.data.every((t) => (t.labels ?? []).includes('urgent')),
            'every urgent row carries the urgent label (among others)',
        ).toBe(true);

        // --- Step 3: priority filter — single value returns only that band. ---
        const p1Only = await listTasks(request, token, `parentTaskId=${parent.id}&priority=p1`);
        expect(p1Only.meta.total, 'priority=p1 count').toBe(countP1);
        expect(
            p1Only.data.every((t) => t.priority === 'p1'),
            'priority=p1 returns only p1 tasks',
        ).toBe(true);

        // --- Step 4: priority filter — comma-list is an IN(...) union. ---
        const p0p1 = await listTasks(request, token, `parentTaskId=${parent.id}&priority=p0,p1`);
        expect(p0p1.meta.total, 'priority=p0,p1 is the union').toBe(countP0 + countP1);
        expect(
            p0p1.data.every((t) => t.priority === 'p0' || t.priority === 'p1'),
            'comma-list priority returns only the requested bands',
        ).toBe(true);

        // --- Step 5: two filters AND together (parentTaskId + priority + label).
        //         Intersection of {urgent} and {p2} among the subtasks == 1
        //         (only index 5 is p2 AND urgent). ---
        const p2Urgent = await listTasks(
            request,
            token,
            `parentTaskId=${parent.id}&priority=p2&label=urgent`,
        );
        const expectedP2Urgent = subtaskSpecs.filter(
            (s) => s.priority === 'p2' && s.labels.includes('urgent'),
        ).length;
        expect(p2Urgent.meta.total, 'parentTaskId + priority + label AND to the intersection').toBe(
            expectedP2Urgent,
        );
        expect(
            p2Urgent.data.every((t) => t.priority === 'p2' && (t.labels ?? []).includes('urgent')),
            'intersection rows satisfy BOTH filters',
        ).toBe(true);

        // --- Step 6: status filter — all subtasks are still `backlog`. Move
        //         ONE subtask to `todo` and prove the status filter splits the
        //         set (backlog count drops by one; todo gains one). ---
        const beforeBacklog = await listTasks(
            request,
            token,
            `parentTaskId=${parent.id}&status=backlog`,
        );
        expect(beforeBacklog.meta.total, 'all subtasks begin in backlog').toBe(subtaskSpecs.length);

        const moved = subtasks[0];
        const transitionRes = await request.post(`${API_BASE}/api/tasks/${moved.id}/transition`, {
            headers: authedHeaders(token),
            data: { to: 'todo' },
        });
        expect(transitionRes.status(), 'transition backlog -> todo is legal (200)').toBe(200);
        const movedBody = (await transitionRes.json()) as Task;
        expect(movedBody.status, 'transitioned task is now todo').toBe('todo');

        const afterBacklog = await listTasks(
            request,
            token,
            `parentTaskId=${parent.id}&status=backlog`,
        );
        expect(afterBacklog.meta.total, 'backlog count drops by one after the move').toBe(
            subtaskSpecs.length - 1,
        );
        const afterTodo = await listTasks(request, token, `parentTaskId=${parent.id}&status=todo`);
        expect(afterTodo.meta.total, 'todo now holds the moved subtask').toBe(1);
        expect(afterTodo.data[0]?.id, 'the moved subtask is the one in todo').toBe(moved.id);

        // status comma-list re-unions the two bands back to the full subtask set.
        const backlogOrTodo = await listTasks(
            request,
            token,
            `parentTaskId=${parent.id}&status=backlog,todo`,
        );
        expect(backlogOrTodo.meta.total, 'status=backlog,todo re-unions to all subtasks').toBe(
            subtaskSpecs.length,
        );

        // --- Step 7: pagination — page through the subtasks in windows of 4
        //         and prove meta is honest, windows are disjoint, and the
        //         union of pages covers the entire subtask set exactly once. ---
        const PAGE = 4;
        const collected: string[] = [];
        for (let offset = 0; offset < subtaskSpecs.length; offset += PAGE) {
            const page = await listTasks(
                request,
                token,
                `parentTaskId=${parent.id}&limit=${PAGE}&offset=${offset}`,
            );
            // total is invariant across pages — it counts the whole filtered set.
            expect(page.meta.total, `meta.total is the full set on page@${offset}`).toBe(
                subtaskSpecs.length,
            );
            expect(page.meta.limit, `meta.limit echoes the requested limit @${offset}`).toBe(PAGE);
            expect(page.meta.offset, `meta.offset echoes the requested offset @${offset}`).toBe(
                offset,
            );
            const remaining = subtaskSpecs.length - offset;
            const expectedRows = Math.min(PAGE, remaining);
            expect(page.data.length, `window size is correct @${offset}`).toBe(expectedRows);
            collected.push(...page.data.map((t) => t.id));
        }
        // The pages together cover every subtask exactly once (disjoint + full).
        const uniqueCollected = new Set(collected);
        expect(collected.length, 'no row appears on two pages (disjoint windows)').toBe(
            uniqueCollected.size,
        );
        expect(uniqueCollected.size, 'pagination covers the whole subtask set').toBe(
            subtaskSpecs.length,
        );
        const expectedSubtaskIds = new Set(subtasks.map((t) => t.id));
        expect(
            [...uniqueCollected].every((id) => expectedSubtaskIds.has(id)),
            'every paged id is one of our subtasks',
        ).toBe(true);

        // --- Step 8: limit clamping + garbage tolerance (no 5xx). ---
        // A non-numeric limit falls back to the default 50 (parseInt||50), so a
        // single page returns all 9 subtasks with meta.limit 50.
        const garbageLimit = await listTasks(request, token, `parentTaskId=${parent.id}&limit=abc`);
        expect(garbageLimit.meta.limit, 'a non-numeric limit falls back to default 50').toBe(50);
        expect(garbageLimit.data.length, 'garbage limit still returns the whole small set').toBe(
            subtaskSpecs.length,
        );

        // --- Step 9: an invalid priority/status filter VALUE is a 400, not a
        //         silent empty result — the platform validates the enum. ---
        const badPriority = await request.get(`${API_BASE}/api/tasks?priority=zzz`, {
            headers: authedHeaders(token),
        });
        expect(badPriority.status(), 'invalid priority filter is rejected (400)').toBe(400);
        expect(String((await badPriority.json()).message)).toMatch(/invalid priority filter/i);

        const badStatus = await request.get(`${API_BASE}/api/tasks?status=nope`, {
            headers: authedHeaders(token),
        });
        expect(badStatus.status(), 'invalid status filter is rejected (400)').toBe(400);
        expect(String((await badStatus.json()).message)).toMatch(/invalid status filter/i);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: search. Create tasks with distinctive, high-entropy titles (and
    //         one with the marker only in its description). GET ?search=<term>
    //         returns matches across title / slug / description and NOTHING
    //         else; a substring matches multiple tasks; a never-used term
    //         returns an empty page.
    // ───────────────────────────────────────────────────────────────────────
    test('?search matches across title/slug/description and excludes non-matches', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const sfx = uniqueSuffix();

        // A high-entropy marker unique to this run so search totals are exact.
        const marker = `Zarquon${sfx}`;

        // Two tasks whose TITLE contains the unique marker.
        const titleHitA = await createTask(request, token, {
            title: `Alpha ${marker} report`,
            priority: 'p1',
        });
        const titleHitB = await createTask(request, token, {
            title: `Beta ${marker} review`,
            priority: 'p2',
        });

        // One task whose marker lives ONLY in the description, not the title.
        const descHit = await createTask(request, token, {
            title: `Plain title ${sfx}`,
            description: `this body mentions ${marker} once`,
            priority: 'p3',
        });

        // Two decoys that must NOT match the marker search.
        const decoyA = await createTask(request, token, {
            title: `Gamma unrelated ${sfx}`,
            priority: 'p3',
        });
        const decoyB = await createTask(request, token, {
            title: `Delta unrelated ${sfx}`,
            description: `nothing special here ${sfx}`,
            priority: 'p4',
        });

        // --- Step 1: searching the unique marker returns the three hits
        //         (two title hits + the description hit) and excludes decoys. ---
        const hits = await listTasks(request, token, `search=${encodeURIComponent(marker)}`);
        expect(hits.meta.total, 'marker search matches title + description hits').toBe(3);
        const hitIds = hits.data.map((t) => t.id).sort();
        expect(hitIds, 'the matched set is exactly the three marker-bearing tasks').toEqual(
            [titleHitA.id, titleHitB.id, descHit.id].sort(),
        );
        expect(hitIds, 'decoy A is excluded from the marker search').not.toContain(decoyA.id);
        expect(hitIds, 'decoy B is excluded from the marker search').not.toContain(decoyB.id);

        // --- Step 2: a more specific title-only phrase narrows to one task. ---
        const phrase = `${marker} report`;
        const phraseHits = await listTasks(request, token, `search=${encodeURIComponent(phrase)}`);
        expect(phraseHits.meta.total, 'the "<marker> report" phrase matches one title').toBe(1);
        expect(phraseHits.data[0]?.id, 'the phrase matches the right title').toBe(titleHitA.id);

        // --- Step 3: search ALSO matches the slug. Every task has a per-user
        //         T-n slug; searching a task's own slug returns at least that
        //         task. (The marker tasks share no slug, so we target one.) ---
        const slugHits = await listTasks(
            request,
            token,
            `search=${encodeURIComponent(titleHitA.slug)}`,
        );
        expect(
            slugHits.meta.total,
            'searching a slug returns at least that task',
        ).toBeGreaterThanOrEqual(1);
        expect(
            slugHits.data.map((t) => t.id),
            'the slug search includes the task whose slug it is',
        ).toContain(titleHitA.id);

        // --- Step 4: the description-only marker task is reachable BY the
        //         marker but its plain title is NOT among the title hits for a
        //         title-only phrase — proving search spans description, not
        //         just title. ---
        expect(hitIds, 'the description-only task is reachable via the marker').toContain(
            descHit.id,
        );
        expect(
            phraseHits.data.map((t) => t.id),
            'the description-only task is NOT a title-phrase hit',
        ).not.toContain(descHit.id);

        // --- Step 5: a never-used search term returns an empty, well-formed
        //         page (total 0, empty data) — not a 5xx, not a leak. ---
        const miss = await listTasks(request, token, `search=NoSuchTerm${sfx}XYZ`);
        expect(miss.meta.total, 'a never-used term matches nothing').toBe(0);
        expect(miss.data.length, 'empty search result is a well-formed empty page').toBe(0);
    });
});
