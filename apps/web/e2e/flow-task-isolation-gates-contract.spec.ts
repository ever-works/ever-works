import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Worktree-per-Task isolation + quality gates — API CONTRACT matrix.
 *
 * The 2026-07 feature program added three optional fields to the Task
 * create/patch DTOs and two branch-lifecycle endpoints, and shipped ZERO
 * e2e coverage for any of it. This file is the contract tripwire.
 *
 * Deliberately NOT re-walking `flow-tasks-validation-authz-matrix`
 * (title/status/priority/labels/scope/actor DTOs) — only the NEW surface.
 *
 * ── Contract under test (read from the source of truth) ─────────────
 *
 *   CreateTaskDto / UpdateTaskDto (apps/api/src/tasks/tasks.dto.ts) —
 *   global ValidationPipe: whitelist + forbidNonWhitelisted.
 *     isolationMode      @IsOptional @IsIn('on','off')   — null inherits
 *                        the Work's `taskIsolation` setting.
 *     acceptanceChecks   @IsOptional @IsArray @ArrayMaxSize(20)
 *                        @ValidateNested(each) → AcceptanceCheckDto
 *                          id       slug-safe `^[a-z0-9][a-z0-9-_]{0,40}$`
 *                          name     1..120
 *                          kind     build|test|lint|typecheck|custom
 *                          command  1..2000
 *                          required boolean
 *                          cwd? timeoutSec?(1..3600) disabled? envPassthrough?
 *     maxGateAttempts    @IsOptional @IsInt @Min(1) @Max(5) — null inherits
 *
 *   POST /api/tasks/:id/resolve-conflicts
 *     200 when the Task branch is in `conflict`
 *     409 "Task branch is not in a conflict state" otherwise
 *     404 unknown / cross-user   400 malformed uuid   401 anon
 *
 *   POST /api/tasks/:id/discard-branch
 *     200 { ok: true } — IDEMPOTENT: a Task with no branch is a no-op
 *     404 unknown / cross-user   400 malformed uuid   401 anon
 *
 * `branchState = 'conflict'` is only ever written by the worker's
 * workspace finalize path, so the 200-arm of resolve-conflicts is not
 * reachable from the public API. This spec therefore pins the REFUSAL
 * arm (409) and the authz closure, which is exactly the half a silent
 * prod regression would break.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function patch(request: APIRequestContext, token: string, path: string, data: unknown) {
    return request.patch(`${API_BASE}${path}`, { headers: authedHeaders(token), data });
}

/** A minimal VALID acceptance check (every required field, nothing else). */
function validCheck(overrides: Record<string, unknown> = {}) {
    return {
        id: 'build',
        name: 'Build',
        kind: 'build',
        command: 'pnpm build',
        required: true,
        ...overrides,
    };
}

async function makeTask(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown> = {},
): Promise<{ id: string }> {
    const res = await post(request, token, '/api/tasks', { title: `gate-${uniq()}`, ...body });
    expect(res.status(), `setup makeTask body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

test.describe('CreateTaskDto — isolationMode / acceptanceChecks / maxGateAttempts', () => {
    test('isolationMode accepts on|off and explicit null (inherit), rejects anything else', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        for (const mode of ['on', 'off']) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `iso-${uniq()}`,
                isolationMode: mode,
            });
            expect(res.status(), `isolationMode=${mode}`).toBe(201);
            expect((await res.json()).isolationMode).toBe(mode);
        }

        // null is the documented "inherit the Work's taskIsolation" value.
        const inherit = await post(request, u.access_token, '/api/tasks', {
            title: `iso-${uniq()}`,
            isolationMode: null,
        });
        expect(inherit.status()).toBe(201);
        expect((await inherit.json()).isolationMode ?? null).toBeNull();

        const bad = await post(request, u.access_token, '/api/tasks', {
            title: `iso-${uniq()}`,
            isolationMode: 'worktree', // that is the WORK-level value, not the Task's
        });
        expect(bad.status()).toBe(400);
        expect(errText(await bad.json())).toContain('isolationMode');
    });

    test('maxGateAttempts is an int clamped to 1..5; 0 / 6 / non-int are rejected', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const ok = await post(request, u.access_token, '/api/tasks', {
            title: `gate-${uniq()}`,
            maxGateAttempts: 3,
        });
        expect(ok.status()).toBe(201);
        expect((await ok.json()).maxGateAttempts).toBe(3);

        for (const value of [0, 6, 2.5, 'three']) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `gate-${uniq()}`,
                maxGateAttempts: value,
            });
            expect(res.status(), `maxGateAttempts=${String(value)}`).toBe(400);
            expect(errText(await res.json())).toContain('maxGateAttempts');
        }

        // The boundaries themselves are legal.
        for (const value of [1, 5]) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `gate-${uniq()}`,
                maxGateAttempts: value,
            });
            expect(res.status(), `boundary maxGateAttempts=${value}`).toBe(201);
        }
    });

    test('acceptanceChecks: a well-formed array persists; each nested field is validated', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const ok = await post(request, u.access_token, '/api/tasks', {
            title: `checks-${uniq()}`,
            acceptanceChecks: [
                validCheck(),
                validCheck({
                    id: 'unit-tests',
                    name: 'Unit tests',
                    kind: 'test',
                    command: 'pnpm test',
                    required: false,
                    timeoutSec: 600,
                }),
            ],
        });
        expect(ok.status(), `checks body=${await ok.text().catch(() => '')}`).toBe(201);
        const created = await ok.json();
        expect(Array.isArray(created.acceptanceChecks)).toBe(true);
        expect(created.acceptanceChecks).toHaveLength(2);
        expect(created.acceptanceChecks[0].id).toBe('build');
        expect(created.acceptanceChecks[1].required).toBe(false);

        // Nested validation fires per field.
        const cases: Array<[string, Record<string, unknown>]> = [
            ['id', validCheck({ id: 'NOT SLUG SAFE' })],
            ['name', validCheck({ name: '' })],
            ['kind', validCheck({ kind: 'deploy' })],
            ['command', validCheck({ command: '' })],
            ['required', validCheck({ required: 'yes' })],
            ['timeoutSec', validCheck({ timeoutSec: 0 })],
        ];
        for (const [field, check] of cases) {
            const res = await post(request, u.access_token, '/api/tasks', {
                title: `checks-${uniq()}`,
                acceptanceChecks: [check],
            });
            expect(res.status(), `nested ${field}`).toBe(400);
            expect(errText(await res.json()), `nested ${field} message`).toContain(field);
        }
    });

    test('acceptanceChecks is capped at 20 entries and rejects a non-array', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const twenty = Array.from({ length: 20 }, (_, i) => validCheck({ id: `check-${i}` }));
        const atCap = await post(request, u.access_token, '/api/tasks', {
            title: `cap-${uniq()}`,
            acceptanceChecks: twenty,
        });
        expect(atCap.status(), 'exactly 20 checks is accepted').toBe(201);

        const overCap = await post(request, u.access_token, '/api/tasks', {
            title: `cap-${uniq()}`,
            acceptanceChecks: [...twenty, validCheck({ id: 'check-20' })],
        });
        expect(overCap.status(), '21 checks is rejected').toBe(400);

        const notArray = await post(request, u.access_token, '/api/tasks', {
            title: `cap-${uniq()}`,
            acceptanceChecks: 'nope',
        });
        expect(notArray.status()).toBe(400);
        expect(errText(await notArray.json())).toContain('acceptanceChecks');
    });

    test('envPassthrough takes NAMES only — a `NAME=value` pair is rejected', async ({
        request,
    }) => {
        // Security-relevant: checks run with a scrubbed environment and
        // listing a name is a deliberate grant. Accepting `FOO=bar` would
        // let a check smuggle a literal value past the scrubber.
        const u = await registerUserViaAPI(request);

        const ok = await post(request, u.access_token, '/api/tasks', {
            title: `env-${uniq()}`,
            acceptanceChecks: [validCheck({ envPassthrough: ['CI', 'NODE_ENV'] })],
        });
        expect(ok.status(), `env body=${await ok.text().catch(() => '')}`).toBe(201);

        const bad = await post(request, u.access_token, '/api/tasks', {
            title: `env-${uniq()}`,
            acceptanceChecks: [validCheck({ envPassthrough: ['SECRET=hunter2'] })],
        });
        expect(bad.status()).toBe(400);
        expect(errText(await bad.json())).toContain('envPassthrough');
    });
});

test.describe('UpdateTaskDto — the same three fields on PATCH', () => {
    test('PATCH round-trips isolationMode / maxGateAttempts / acceptanceChecks and null reverts to inherit', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token, {
            isolationMode: 'on',
            maxGateAttempts: 2,
            acceptanceChecks: [validCheck()],
        });

        const updated = await patch(request, u.access_token, `/api/tasks/${task.id}`, {
            isolationMode: 'off',
            maxGateAttempts: 5,
            acceptanceChecks: [validCheck({ id: 'lint', name: 'Lint', kind: 'lint' })],
        });
        expect(updated.status(), `patch body=${await updated.text().catch(() => '')}`).toBe(200);
        const body = await updated.json();
        expect(body.isolationMode).toBe('off');
        expect(body.maxGateAttempts).toBe(5);
        expect(body.acceptanceChecks).toHaveLength(1);
        expect(body.acceptanceChecks[0].id).toBe('lint');

        // Explicit null on all three = revert to inheriting the Work.
        const reverted = await patch(request, u.access_token, `/api/tasks/${task.id}`, {
            isolationMode: null,
            maxGateAttempts: null,
            acceptanceChecks: null,
        });
        expect(reverted.status()).toBe(200);
        const rb = await reverted.json();
        expect(rb.isolationMode ?? null).toBeNull();
        expect(rb.maxGateAttempts ?? null).toBeNull();
        expect(rb.acceptanceChecks ?? null).toBeNull();
    });

    test('PATCH still rejects bad values and unknown fields (forbidNonWhitelisted intact)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const badMode = await patch(request, u.access_token, `/api/tasks/${task.id}`, {
            isolationMode: 'sometimes',
        });
        expect(badMode.status()).toBe(400);

        const badAttempts = await patch(request, u.access_token, `/api/tasks/${task.id}`, {
            maxGateAttempts: 99,
        });
        expect(badAttempts.status()).toBe(400);

        // The neighbouring branch columns are SERVER-owned — a client must
        // not be able to declare its own branch state.
        for (const field of ['branchRef', 'branchState', 'conflictPaths', 'prUrl']) {
            const res = await patch(request, u.access_token, `/api/tasks/${task.id}`, {
                [field]: 'x',
            });
            expect(res.status(), `${field} is not client-writable`).toBe(400);
            expect(errText(await res.json())).toContain(`property ${field} should not exist`);
        }
    });
});

test.describe('POST /api/tasks/:id/resolve-conflicts', () => {
    test('a Task that is not in conflict → 409 with the documented message', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);

        const res = await post(
            request,
            u.access_token,
            `/api/tasks/${task.id}/resolve-conflicts`,
            {},
        );
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(409);
        expect(errText(await res.json())).toContain('not in a conflict state');
    });

    test('authz closure: cross-user 404, unknown uuid 404, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);
        const path = `/api/tasks/${task.id}/resolve-conflicts`;

        // A stranger must be unable to tell "exists but not yours" (409)
        // from "does not exist" (404) — both answer 404.
        const cross = await post(request, stranger.access_token, path, {});
        expect(cross.status()).toBe(404);

        const unknown = await post(
            request,
            owner.access_token,
            `/api/tasks/${UNKNOWN_UUID}/resolve-conflicts`,
            {},
        );
        expect(unknown.status()).toBe(404);

        const malformed = await post(
            request,
            owner.access_token,
            `/api/tasks/not-a-uuid/resolve-conflicts`,
            {},
        );
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');

        const anon = await request.post(`${API_BASE}${path}`, { data: {} });
        expect(anon.status()).toBe(401);
    });
});

test.describe('POST /api/tasks/:id/discard-branch', () => {
    test('is idempotent on a Task with no branch → 200 { ok: true }, twice', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const task = await makeTask(request, u.access_token);
        const path = `/api/tasks/${task.id}/discard-branch`;

        const first = await post(request, u.access_token, path, {});
        expect(first.status(), `body=${await first.text().catch(() => '')}`).toBe(200);
        expect((await first.json()).ok).toBe(true);

        const second = await post(request, u.access_token, path, {});
        expect(second.status(), 'discard is idempotent').toBe(200);
        expect((await second.json()).ok).toBe(true);

        // A no-branch discard must NOT invent a branchState on the row.
        const after = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(after.status()).toBe(200);
        expect((await after.json()).branchRef ?? null).toBeNull();
    });

    test('authz closure: cross-user 404 and the row survives, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await makeTask(request, owner.access_token);
        const path = `/api/tasks/${task.id}/discard-branch`;

        const cross = await post(request, stranger.access_token, path, {});
        expect(cross.status()).toBe(404);

        const stillThere = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(stillThere.status(), 'a refused discard must not touch the Task').toBe(200);

        const malformed = await post(
            request,
            owner.access_token,
            `/api/tasks/not-a-uuid/discard-branch`,
            {},
        );
        expect(malformed.status()).toBe(400);

        const anon = await request.post(`${API_BASE}${path}`, { data: {} });
        expect(anon.status()).toBe(401);
    });
});
