import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Tasks — exhaustive VALIDATION + AUTHZ MATRIX.
 *
 * Sibling task specs already own the behavioural angles: the legal state
 * lattice + side-effects (`flow-task-state-machine`), the blocker/approver
 * GATES and their force semantics (`flow-task-full-lattice`,
 * `flow-task-approvers-gate`), reviewer/relation/spend shapes
 * (`flow-tasks-advanced-deep`), assignee lifecycle (`flow-task-assignees-deep`)
 * and tenant isolation (`flow-tenant-isolation-resources`). This file
 * deliberately does NOT re-walk those flows. Instead it is a single-purpose
 * MATRIX that pins, field-by-field, how the DTO/controller/service reject bad
 * input and enforce ownership — one assertion cluster per Create/Update/
 * Transition/actor DTO field, plus the full authz set on every verb.
 *
 * ── Verified contract (probed live against http://127.0.0.1:3100, sqlite
 *    in-memory — the driver CI uses — BEFORE any assertion was written):
 *
 *   Auth: POST /api/auth/register { username, email, password }
 *       → 201 { access_token, user:{ id } }.
 *
 *   POST /api/tasks (CreateTaskDto — global ValidationPipe: whitelist +
 *   forbidNonWhitelisted; class-validator `message` is a STRING[]; controller/
 *   service throws carry a single STRING `message`):
 *     title      required @IsString @MaxLength(200)
 *       - missing / non-string  → 400 ["title must be a string", …]
 *       - "" (empty)            → 400 "title is required."           (controller guard)
 *       - "   " (whitespace)    → 400 "Task title is required."      (service trim guard)
 *       - 200 chars             → 201 (boundary OK);  201 chars → 400
 *     status     @IsOptional @IsEnum(TaskStatus)   bad → 400; 'todo' → 201 (echoed)
 *     priority   @IsOptional @IsEnum(TaskPriority)  bad → 400; 'p0'  → 201 (echoed)
 *     labels     @IsOptional @IsArray @IsString(each) @MaxLength(80,each)
 *       - non-array → 400; element >80 → 400; non-string element → 400; ok → 201
 *     missionId/ideaId/workId/parentTaskId  @IsOptional @IsUUID()
 *       - malformed        → 400 ["<field> must be a UUID"]          (DTO layer)
 *       - unknown VALID v4 → 400 "<Work|Mission|Idea|Parent Task> … not found."
 *                                                                    (service ownership)
 *     scope exclusivity: >1 of work/mission/idea (all valid uuids)
 *                        → 400 "Task must be scoped to exactly zero or one …"
 *     requireAllApprovers @IsOptional @IsBoolean  non-bool → 400
 *     unknown field       → 400 "property <x> should not exist"
 *     null optional fields → 201 (@IsOptional admits null)
 *     no auth → 401
 *
 *   PATCH /api/tasks/:id (UpdateTaskDto — NOTE: NO `status` field; status only
 *   moves via /transition):
 *     status:<x>   → 400 "property status should not exist"  (forbidNonWhitelisted)
 *     priority bad → 400;  title 201 chars → 400;  unknown field → 400
 *     parentTaskId unknown valid uuid → 400 "Parent Task … not found."
 *     parentTaskId == self            → 409 "…would create a sub-task cycle."
 *     empty body {} → 200 (no-op);  cross-user → 404 (no 403 existence leak)
 *
 *   POST /api/tasks/:id/transition (TransitionTaskDto { to @IsEnum, force?
 *   @IsBoolean }):
 *     missing/bad `to` → 400 ["to must be one of …"];  force non-bool → 400
 *     illegal hop (backlog→done) → 400 "Cannot transition Task from backlog to
 *       done."  — AND force:true does NOT bypass the LATTICE (still 400; force
 *       only overrides the approver GATE, a 409)
 *     cross-user → 404;  unknown uuid → 404;  malformed uuid → 400
 *
 *   Actor sub-resources — symmetric DTOs:
 *     POST assignees  { assigneeType @IsIn(user,agent), assigneeId @IsString @MaxLength(128) }
 *     POST reviewers  { reviewerType, reviewerId }
 *     POST approvers  { approverType, approverId }
 *       missing/bad type → 400 ["<x>Type must be one of the following values: user, agent"]
 *       missing id       → 400 ["<x>Id must be a string", …]
 *       id 129 chars     → 400 ["<x>Id must be shorter than or equal to 128 characters"]
 *       agent-type + unknown agent id → 400 "Agent … is not reachable for this user — cannot assign."
 *       user-type happy  → 201;  duplicate → 409;  cross-user task → 404;  no auth → 401
 *     DELETE assignees/:assigneeId — unknown → 404; malformed → 400
 *
 *   Blockers/relations DTO guards:
 *     POST blocks   { blockedByTaskId @IsUUID }  missing/malformed → 400; self → 400
 *     POST relations{ relatedTaskId @IsUUID, kind @IsIn(related,duplicates,follow-up) }
 *       bad/missing kind → 400; self → 400
 *
 *   Path `:id` is guarded by ParseUUIDPipe → a MALFORMED id 400s
 *   ("Validation failed (uuid is expected)") BEFORE the handler; a well-formed
 *   unknown/foreign uuid reaches the service and 404s. Cross-user reads/writes
 *   404 (never 403) — no existence leak.
 *
 * Every test registers FRESH users (never the shared seeded user) and asserts
 * pinned status codes + error-message substrings.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNKNOWN_UUID_2 = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** class-validator returns message:string[]; thrown HttpExceptions a string. */
function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function post(request: APIRequestContext, token: string, path: string, data: unknown) {
    return request.post(`${API_BASE}${path}`, { headers: authedHeaders(token), data });
}

/** Create a task via API and return its id (asserts 201 for setup fixtures). */
async function makeTask(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown> = {},
): Promise<{ id: string; slug: string; status: string }> {
    const res = await post(request, token, '/api/tasks', { title: `t-${uniq()}`, ...body });
    expect(res.status(), `setup makeTask body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

test.describe('POST /api/tasks — CreateTaskDto validation matrix', () => {
    test('title: missing / non-string / empty / whitespace / boundary all rejected with truthful codes', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // Missing → class-validator array (IsString + MaxLength both fire).
        const missing = await post(request, u.access_token, '/api/tasks', {});
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('title must be a string');

        // Non-string type.
        const numeric = await post(request, u.access_token, '/api/tasks', { title: 123 });
        expect(numeric.status()).toBe(400);
        expect(errText(await numeric.json())).toContain('title must be a string');

        // Empty string passes the DTO (IsString ok, MaxLength ok) then the
        // controller `if (!body.title)` guard rejects it with a single string.
        const empty = await post(request, u.access_token, '/api/tasks', { title: '' });
        expect(empty.status()).toBe(400);
        expect(errText(await empty.json())).toBe('title is required.');

        // Whitespace-only is truthy → passes the controller, the SERVICE trims
        // and rejects with its own message. Distinct code path from empty.
        const ws = await post(request, u.access_token, '/api/tasks', { title: '   ' });
        expect(ws.status()).toBe(400);
        expect(errText(await ws.json())).toBe('Task title is required.');
    });

    test('title length boundary: exactly 200 chars is accepted, 201 is rejected', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const ok = await post(request, u.access_token, '/api/tasks', { title: 'a'.repeat(200) });
        expect(ok.status()).toBe(201);

        const tooLong = await post(request, u.access_token, '/api/tasks', {
            title: 'a'.repeat(201),
        });
        expect(tooLong.status()).toBe(400);
        expect(errText(await tooLong.json())).toContain(
            'title must be shorter than or equal to 200 characters',
        );
    });

    test('status: bad enum → 400 (enumerates legal values); a valid status is persisted', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const bad = await post(request, u.access_token, '/api/tasks', {
            title: `s-${uniq()}`,
            status: 'nope',
        });
        expect(bad.status()).toBe(400);
        expect(errText(await bad.json())).toContain(
            'status must be one of the following values: backlog, todo, in_progress, in_review, blocked, done, cancelled',
        );

        const good = await post(request, u.access_token, '/api/tasks', {
            title: `s-${uniq()}`,
            status: 'todo',
        });
        expect(good.status()).toBe(201);
        expect((await good.json()).status).toBe('todo');
    });

    test('priority: bad enum → 400 (enumerates p0..p4); a valid priority is persisted', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const bad = await post(request, u.access_token, '/api/tasks', {
            title: `p-${uniq()}`,
            priority: 'p9',
        });
        expect(bad.status()).toBe(400);
        expect(errText(await bad.json())).toContain(
            'priority must be one of the following values: p0, p1, p2, p3, p4',
        );

        const good = await post(request, u.access_token, '/api/tasks', {
            title: `p-${uniq()}`,
            priority: 'p0',
        });
        expect(good.status()).toBe(201);
        expect((await good.json()).priority).toBe('p0');
    });

    test('labels: non-array / oversized element / non-string element rejected; a valid array persists', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const notArray = await post(request, u.access_token, '/api/tasks', {
            title: `l-${uniq()}`,
            labels: 'nope',
        });
        expect(notArray.status()).toBe(400);
        expect(errText(await notArray.json())).toContain('labels must be an array');

        const tooLong = await post(request, u.access_token, '/api/tasks', {
            title: `l-${uniq()}`,
            labels: ['y'.repeat(81)],
        });
        expect(tooLong.status()).toBe(400);
        expect(errText(await tooLong.json())).toContain(
            'each value in labels must be shorter than or equal to 80 characters',
        );

        const nonString = await post(request, u.access_token, '/api/tasks', {
            title: `l-${uniq()}`,
            labels: [123],
        });
        expect(nonString.status()).toBe(400);
        expect(errText(await nonString.json())).toContain('each value in labels must be a string');

        const good = await post(request, u.access_token, '/api/tasks', {
            title: `l-${uniq()}`,
            labels: ['alpha', 'beta'],
        });
        expect(good.status()).toBe(201);
        expect((await good.json()).labels).toEqual(['alpha', 'beta']);
    });

    test('scope uuid fields: a malformed value is rejected at the DTO layer for EACH of the four uuid fields', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        for (const field of ['missionId', 'ideaId', 'workId', 'parentTaskId']) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `u-${uniq()}`,
                [field]: 'not-a-uuid',
            });
            expect(res.status(), `${field} malformed`).toBe(400);
            expect(errText(await res.json())).toContain(`${field} must be a UUID`);
        }
    });

    test('scope ownership: a well-formed but unreachable uuid 400s at the SERVICE layer with a per-field message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const cases: Array<[string, string]> = [
            ['workId', 'Work'],
            ['missionId', 'Mission'],
            ['ideaId', 'Idea'],
            ['parentTaskId', 'Parent Task'],
        ];
        for (const [field, label] of cases) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `o-${uniq()}`,
                [field]: UNKNOWN_UUID,
            });
            expect(res.status(), `${field} unreachable`).toBe(400);
            expect(errText(await res.json())).toContain(`${label} ${UNKNOWN_UUID} not found.`);
        }
    });

    test('scope exclusivity: supplying more than one of work/mission/idea → 400 (exactly zero or one)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await post(request, u.access_token, '/api/tasks', {
            title: `x-${uniq()}`,
            workId: UNKNOWN_UUID,
            missionId: UNKNOWN_UUID_2,
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain(
            'Task must be scoped to exactly zero or one of missionId / ideaId / workId.',
        );
    });

    test('requireAllApprovers must be boolean; unknown top-level field is forbidden', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const badBool = await post(request, u.access_token, '/api/tasks', {
            title: `b-${uniq()}`,
            requireAllApprovers: 'yes',
        });
        expect(badBool.status()).toBe(400);
        expect(errText(await badBool.json())).toContain(
            'requireAllApprovers must be a boolean value',
        );

        const extra = await post(request, u.access_token, '/api/tasks', {
            title: `b-${uniq()}`,
            bogusField: 'x',
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property bogusField should not exist');
    });

    test('explicit null on every optional field is accepted (@IsOptional admits null)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await post(request, u.access_token, '/api/tasks', {
            title: `n-${uniq()}`,
            description: null,
            labels: null,
            missionId: null,
            ideaId: null,
            workId: null,
            parentTaskId: null,
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.id).toBeTruthy();
        expect(body.status).toBe('backlog');
        expect(body.priority).toBe('p3');
    });

    test('create requires auth: no bearer token → 401 (never reaches validation)', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/tasks`, { data: { title: 'anon' } });
        expect(res.status()).toBe(401);
    });
});

test.describe('PATCH /api/tasks/:id — UpdateTaskDto validation matrix', () => {
    test('`status` is NOT an updatable field — it is rejected by forbidNonWhitelisted', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const res = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { status: 'done' },
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('property status should not exist');
    });

    test('priority enum, title length, and unknown field are all validated on update', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const badPriority = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { priority: 'p9' },
        });
        expect(badPriority.status()).toBe(400);
        expect(errText(await badPriority.json())).toContain(
            'priority must be one of the following values: p0, p1, p2, p3, p4',
        );

        const longTitle = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { title: 'a'.repeat(201) },
        });
        expect(longTitle.status()).toBe(400);
        expect(errText(await longTitle.json())).toContain(
            'title must be shorter than or equal to 200 characters',
        );

        const extra = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { nope: 1 },
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property nope should not exist');
    });

    test('parentTaskId on update: unreachable uuid → 400, self-parent → 409 cycle', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const unknownParent = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { parentTaskId: UNKNOWN_UUID },
        });
        expect(unknownParent.status()).toBe(400);
        expect(errText(await unknownParent.json())).toContain(
            `Parent Task ${UNKNOWN_UUID} not found.`,
        );

        const selfParent = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
            data: { parentTaskId: task.id },
        });
        expect(selfParent.status()).toBe(409);
        expect(errText(await selfParent.json())).toContain('would create a sub-task cycle');
    });

    test('empty patch body is a 200 no-op; a stranger patching → 404 (no 403 existence leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token, { title: `patch-${uniq()}` });

        const noop = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(noop.status()).toBe(200);

        const cross = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { title: 'hijack' },
        });
        expect(cross.status()).toBe(404);
        expect(errText(await cross.json())).toContain('not found');
    });
});

test.describe('POST /api/tasks/:id/transition — DTO + lattice + authz', () => {
    test('`to` is a required enum and `force` must be boolean', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const missing = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {});
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('to must be one of the following values');

        const badEnum = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {
            to: 'nope',
        });
        expect(badEnum.status()).toBe(400);
        expect(errText(await badEnum.json())).toContain('to must be one of the following values');

        const badForce = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {
            to: 'todo',
            force: 'yes',
        });
        expect(badForce.status()).toBe(400);
        expect(errText(await badForce.json())).toContain('force must be a boolean value');
    });

    test('an ILLEGAL lattice hop is 400 — and force:true does NOT bypass the lattice (still 400)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token); // status: backlog

        const illegal = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {
            to: 'done',
        });
        expect(illegal.status()).toBe(400);
        expect(errText(await illegal.json())).toBe('Cannot transition Task from backlog to done.');

        // `force` overrides the approver GATE (a 409), never the lattice itself.
        const forced = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {
            to: 'done',
            force: true,
        });
        expect(forced.status()).toBe(400);
        expect(errText(await forced.json())).toBe('Cannot transition Task from backlog to done.');

        // A LEGAL hop from the same state succeeds — proving the 400s above were
        // the lattice guard, not a broken endpoint.
        const legal = await post(request, u.access_token, `/api/tasks/${task.id}/transition`, {
            to: 'todo',
        });
        expect(legal.status()).toBe(200);
        expect((await legal.json()).status).toBe('todo');
    });

    test('transition authz: cross-user → 404, unknown uuid → 404, malformed uuid → 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);

        const cross = await post(
            request,
            stranger.access_token,
            `/api/tasks/${task.id}/transition`,
            {
                to: 'todo',
            },
        );
        expect(cross.status()).toBe(404);

        const unknown = await post(
            request,
            owner.access_token,
            `/api/tasks/${UNKNOWN_UUID}/transition`,
            { to: 'todo' },
        );
        expect(unknown.status()).toBe(404);

        const malformed = await post(
            request,
            owner.access_token,
            `/api/tasks/not-a-uuid/transition`,
            { to: 'todo' },
        );
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');
    });
});

test.describe('POST assignees/reviewers/approvers — actor DTO symmetric matrix', () => {
    // The three endpoints share an identical DTO shape (<role>Type @IsIn +
    // <role>Id @IsString @MaxLength(128)); asserting them symmetrically proves
    // the contract is uniform and no endpoint drifted.
    const roles = [
        { path: 'assignees', typeField: 'assigneeType', idField: 'assigneeId' },
        { path: 'reviewers', typeField: 'reviewerType', idField: 'reviewerId' },
        { path: 'approvers', typeField: 'approverType', idField: 'approverId' },
    ] as const;

    for (const role of roles) {
        test(`${role.path}: type must be user|agent, id required & <=128 chars`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            const task = await makeTask(request, u.access_token);
            const url = `/api/tasks/${task.id}/${role.path}`;

            const missingType = await post(request, u.access_token, url, { [role.idField]: 'x' });
            expect(missingType.status()).toBe(400);
            expect(errText(await missingType.json())).toContain(
                `${role.typeField} must be one of the following values: user, agent`,
            );

            const badType = await post(request, u.access_token, url, {
                [role.typeField]: 'robot',
                [role.idField]: 'x',
            });
            expect(badType.status()).toBe(400);
            expect(errText(await badType.json())).toContain(
                `${role.typeField} must be one of the following values: user, agent`,
            );

            const missingId = await post(request, u.access_token, url, {
                [role.typeField]: 'user',
            });
            expect(missingId.status()).toBe(400);
            expect(errText(await missingId.json())).toContain(`${role.idField} must be a string`);

            const longId = await post(request, u.access_token, url, {
                [role.typeField]: 'user',
                [role.idField]: 'z'.repeat(129),
            });
            expect(longId.status()).toBe(400);
            expect(errText(await longId.json())).toContain(
                `${role.idField} must be shorter than or equal to 128 characters`,
            );
        });
    }

    test('agent-type assignee referencing an unreachable agent → 400 (ownership validated)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const res = await post(request, u.access_token, `/api/tasks/${task.id}/assignees`, {
            assigneeType: 'agent',
            assigneeId: UNKNOWN_UUID,
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('is not reachable for this user');
    });

    test('user-type assignee happy path → 201, exact duplicate → 409 conflict', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const url = `/api/tasks/${task.id}/assignees`;

        const first = await post(request, u.access_token, url, {
            assigneeType: 'user',
            assigneeId: u.user.id,
        });
        expect(first.status()).toBe(201);
        const row = await first.json();
        expect(row.taskId).toBe(task.id);
        expect(row.assigneeType).toBe('user');
        expect(row.assigneeId).toBe(u.user.id);

        const dup = await post(request, u.access_token, url, {
            assigneeType: 'user',
            assigneeId: u.user.id,
        });
        expect(dup.status()).toBe(409);
        expect(errText(await dup.json())).toContain('already has assignee');
    });

    test('assignee sub-resource authz: cross-user → 404, no auth → 401, malformed task uuid → 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);

        const cross = await post(
            request,
            stranger.access_token,
            `/api/tasks/${task.id}/assignees`,
            {
                assigneeType: 'user',
                assigneeId: stranger.user.id,
            },
        );
        expect(cross.status()).toBe(404);

        const anon = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            data: { assigneeType: 'user', assigneeId: owner.user.id },
        });
        expect(anon.status()).toBe(401);

        const malformed = await post(
            request,
            owner.access_token,
            `/api/tasks/not-a-uuid/assignees`,
            {
                assigneeType: 'user',
                assigneeId: owner.user.id,
            },
        );
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');
    });

    test('DELETE assignee: unknown assignee uuid → 404, malformed → 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const unknown = await request.delete(
            `${API_BASE}/api/tasks/${task.id}/assignees/${UNKNOWN_UUID}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(unknown.status()).toBe(404);
        expect(errText(await unknown.json())).toContain('not found');

        const malformed = await request.delete(
            `${API_BASE}/api/tasks/${task.id}/assignees/bad-uuid`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');
    });
});

test.describe('blockers + relations — DTO + integrity guards', () => {
    test('POST /blocks: missing / malformed uuid → 400, self-block → 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const url = `/api/tasks/${task.id}/blocks`;

        const missing = await post(request, u.access_token, url, {});
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('blockedByTaskId must be a UUID');

        const malformed = await post(request, u.access_token, url, { blockedByTaskId: 'nope' });
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('blockedByTaskId must be a UUID');

        const selfBlock = await post(request, u.access_token, url, { blockedByTaskId: task.id });
        expect(selfBlock.status()).toBe(400);
        expect(errText(await selfBlock.json())).toBe('Task cannot block itself.');
    });

    test('POST /blocks: an unreachable blocker task id → 400 (ownership checked)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const res = await post(request, u.access_token, `/api/tasks/${task.id}/blocks`, {
            blockedByTaskId: UNKNOWN_UUID,
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain(`Blocking Task ${UNKNOWN_UUID} not found.`);
    });

    test('POST /relations: bad/missing kind → 400, self-relation → 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const a = await makeTask(request, u.access_token);
        const b = await makeTask(request, u.access_token);
        const url = `/api/tasks/${a.id}/relations`;

        const badKind = await post(request, u.access_token, url, {
            relatedTaskId: b.id,
            kind: 'cousin',
        });
        expect(badKind.status()).toBe(400);
        expect(errText(await badKind.json())).toContain(
            'kind must be one of the following values: related, duplicates, follow-up',
        );

        const missingKind = await post(request, u.access_token, url, { relatedTaskId: b.id });
        expect(missingKind.status()).toBe(400);
        expect(errText(await missingKind.json())).toContain('kind must be one of the following');

        const selfRel = await post(request, u.access_token, url, {
            relatedTaskId: a.id,
            kind: 'related',
        });
        expect(selfRel.status()).toBe(400);
        expect(errText(await selfRel.json())).toBe('Task cannot relate to itself.');
    });
});

test.describe('cross-cutting read authz closure', () => {
    test('GET /api/tasks/:id: own 200, cross-user 404, unknown uuid 404, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);

        const own = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(own.status()).toBe(200);
        expect((await own.json()).id).toBe(task.id);

        const cross = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status()).toBe(404);
        expect(errText(await cross.json())).toContain('not found');

        const unknown = await request.get(`${API_BASE}/api/tasks/${UNKNOWN_UUID}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(unknown.status()).toBe(404);

        const malformed = await request.get(`${API_BASE}/api/tasks/not-a-uuid`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');

        const anon = await request.get(`${API_BASE}/api/tasks/${task.id}`);
        expect(anon.status()).toBe(401);
    });

    test('DELETE /api/tasks/:id: a stranger gets 404 and the owner can still read the task', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);

        const cross = await request.delete(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status()).toBe(404);

        // The failed cross-user delete must NOT have removed the row.
        const stillThere = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(stillThere.status()).toBe(200);
    });
});
