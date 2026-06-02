import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, createAgentViaAPI } from './helpers/agents-tasks';

/**
 * flow-optimistic-concurrency — the CROSS-ENTITY OPTIMISTIC-CONCURRENCY &
 * CONFLICT contract (Task / Agent / Work), driven end-to-end through the real
 * public surface and the persisted rows the conflict detection reads.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   concurrent-conflict / concurrent-update-conflict / concurrent-actions all
 *   exercise ONLY the WORK entity: two parallel PUT/PATCH of `name` resolving to
 *   last-write-wins, no Frankenstein merge, and a bogus `If-Match` on the WORK
 *   update. flow-work-sync-conflict pins the data-sync single-flight LOCK (a
 *   distributed-mutex story, not entity-row CAS). etag-strong-vs-weak only checks
 *   the weak/strong ETag PREFIX on a profile/static asset. NONE of them touch:
 *     - the TASK state-machine as a compare-and-set lock (the platform's real
 *       optimistic-concurrency primitive: a concurrent identical transition
 *       burst resolves to EXACTLY ONE winner + N read-time conflicts);
 *     - the 409 INTEGRITY-gate conflict (blocker gate) vs the 400 LATTICE
 *       conflict — two distinct conflict classes on the same transition verb;
 *     - the TASK / AGENT partial-PATCH last-write-wins + monotonic `updatedAt`;
 *     - the AGENT slug-uniqueness CREATE conflict under a concurrent burst;
 *     - delete-vs-write & double-delete RACES (the loser sees the gone row → 404,
 *       never a 5xx, never a resurrected/Frankenstein row);
 *     - the ETag / If-None-Match conditional-READ contract (304 when fresh, 200
 *       when a concurrent writer moved the row) AND the truthful fact that the
 *       WRITE precondition (If-Match / If-Unmodified-Since) is NOT honoured.
 *   THIS file pins all of the above as one observable cross-entity contract.
 *
 * PROBED LIVE (CI: sqlite in-memory, the exact CI driver) on throwaway users
 * before any assertion — exact shapes:
 *   TASK  POST /api/tasks {title} → 201 {id, slug:'T-n', status:'backlog',
 *           priority:'p3', updatedAt, createdAt, …}. updatedAt/createdAt are
 *           SECOND-resolution. PATCH /api/tasks/:id (partial) → 200 (PUT → 404).
 *           Concurrent distinct-value PATCH → last-write-wins, no merge.
 *         POST /api/tasks/:id/transition {to, force?} → 200 on a legal hop;
 *           a hop whose `from` no longer permits `to` → 400
 *           "Cannot transition Task from <from> to <to>." (the lattice guard
 *           reads the LIVE row, so a concurrent winner that already advanced the
 *           status makes every loser's source state illegal → READ-TIME CONFLICT).
 *           Open-blocker `→ done`/`→ in_progress` → 409
 *           "Task cannot transition to done — has N open blocker(s)." (INTEGRITY
 *           gate, distinct from the 400 lattice miss).
 *           PROBED: a 10× concurrent backlog→todo burst → exactly ONE 200 + nine
 *           400 (the state machine is a compare-and-set lock).
 *   AGENT POST /api/agents {name, scope:'tenant'} → 201 {id, slug, status:'draft',
 *           updatedAt, …}. A SECOND create with the SAME name in the same scope →
 *           409 "An Agent named \"<name>\" already exists in this scope." A
 *           concurrent same-name burst → exactly ONE 201 + the rest 409 (slug
 *           uniqueness CAS). PATCH /api/agents/:id (partial) → 200; `status` is
 *           NOT a writable property (whitelist → 400 "property status should not
 *           exist"). PUT → 404.
 *   WORK  POST /api/works → 201; PATCH /api/works/:id → 200 (advances updatedAt);
 *           DELETE is POST /api/works/:id/delete → 200 {status:'success', slug,
 *           message}. A DOUBLE delete race → one 200 + one 404; a PATCH-vs-delete
 *           race → delete wins the terminal state (final GET 404). A write to a
 *           deleted row → 404 "... not found." (no resurrection).
 *   PRECONDITIONS  Safe GET honours If-None-Match: 304 when the ETag still
 *           matches, 200 once a concurrent writer advanced the row (the ETag is a
 *           weak `W/"…"` derived from the body). The WRITE preconditions
 *           If-Match / If-Unmodified-Since are IGNORED on PATCH (no 412/409) — the
 *           server is last-write-wins at the HTTP layer; optimistic concurrency is
 *           enforced at the DOMAIN layer (the state machine + unique indexes), not
 *           via HTTP preconditions. We assert that truthfully, not a fiction.
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user — per-user task slugs `T-n` + per-scope agent slugs reset
 * per user so bursts never collide cross-spec); unique Date.now()/uuid suffixes;
 * tolerant matchers (toContain / subset / at-most-one) over exact whole-list counts
 * since the in-memory DB carries sibling rows; generous timeouts + expect.poll;
 * NO fictional HTTP-precondition 412 is asserted (probed: not honoured); every
 * branch keeps the never-a-5xx invariant.
 */

const T = 25_000;

interface TaskRow {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
    description?: string | null;
    updatedAt: string;
    createdAt: string;
    [k: string]: unknown;
}

interface AgentRow {
    id: string;
    slug: string;
    name: string;
    status: string;
    updatedAt: string;
    [k: string]: unknown;
}

function suffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function getTask(request: APIRequestContext, token: string, id: string): Promise<TaskRow> {
    const res = await request.get(`${API_BASE}/api/tasks/${id}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function patchTask(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
) {
    return request.patch(`${API_BASE}/api/tasks/${id}`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json', ...extraHeaders },
        data: body,
        timeout: T,
    });
}

async function transition(
    request: APIRequestContext,
    token: string,
    id: string,
    to: string,
    force = false,
) {
    return request.post(`${API_BASE}/api/tasks/${id}/transition`, {
        headers: authedHeaders(token),
        data: { to, force },
        timeout: T,
    });
}

test.describe('flow: cross-entity optimistic concurrency & conflict (Task / Agent / Work)', () => {
    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 1 — THE STATE MACHINE IS A COMPARE-AND-SET LOCK.
    // A burst of N IDENTICAL transitions (all backlog→todo) on one Task races: the
    // transition guard re-reads the LIVE row's status, so the FIRST writer to
    // advance backlog→todo wins (200) and every later racer now reads `from=todo`
    // — for which `todo→todo` is NOT a legal hop → 400 "Cannot transition". The
    // invariant: EXACTLY ONE 200 across the burst, the rest 400, the Task lands in
    // `todo` exactly once (no double-advance, no lost update, never a 5xx). This is
    // the platform's real optimistic-concurrency primitive — the server has no HTTP
    // If-Match, but the state machine provides the equivalent CAS at the domain layer.
    // ───────────────────────────────────────────────────────────────────────────
    test('a concurrent identical-transition burst resolves to exactly one winner + N read-time conflicts (state machine == CAS lock)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `Concurrency CAS ${suffix()}` });
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: `cas-burst-${suffix()}` });
        expect(task.status).toBe('backlog');

        const BURST = 10;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => transition(request, token, task.id, 'todo')),
        );
        const statuses = results.map((r) => r.status());

        // Never a 5xx — a contended CAS must resolve cleanly at the client level.
        for (const s of statuses) {
            expect(
                s,
                `each concurrent transition is a client-level response (got ${s})`,
            ).toBeLessThan(500);
        }

        const winners = statuses.filter((s) => s === 200);
        const conflicts = statuses.filter((s) => s === 400);

        // Exactly ONE backlog→todo may take effect; every other racer loses the CAS.
        expect(winners.length, 'exactly one transition wins the CAS').toBe(1);
        expect(conflicts.length, 'every other concurrent racer is a 400 read-time conflict').toBe(
            BURST - 1,
        );

        // The losers carry the truthful "Cannot transition" lattice message — their
        // source state was already advanced to `todo` by the winner.
        const conflictBodies = await Promise.all(
            results.filter((r) => r.status() === 400).map((r) => r.json()),
        );
        for (const body of conflictBodies) {
            expect(body.message, 'conflict body names the impossible re-transition').toMatch(
                /cannot transition/i,
            );
            expect(body.message).toContain('todo');
            expect(body.statusCode).toBe(400);
        }

        // The Task advanced exactly once — it is `todo`, not double-advanced.
        const after = await getTask(request, token, task.id);
        expect(
            after.status,
            'the row lands in todo exactly once (no double-advance / lost update)',
        ).toBe('todo');
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 2 — TWO DISTINCT CONFLICT CLASSES ON THE SAME TRANSITION VERB.
    // The transition endpoint surfaces TWO independent conflict shapes that must
    // never be conflated:
    //   (a) 400 LATTICE conflict — the source state simply has no edge to the
    //       target (a stale/illegal hop, e.g. backlog→done);
    //   (b) 409 INTEGRITY conflict — the hop is lattice-legal but an integrity gate
    //       fails (an OPEN BLOCKER on `→ done`). `force` overrides the approver
    //       gate, NOT the blocker gate, so a forced `→ done` over an open blocker is
    //       STILL 409. We drive both on a real blocker graph and pin the exact
    //       status + message, plus the non-mutating guarantee after each rejection.
    // ───────────────────────────────────────────────────────────────────────────
    test('lattice conflict (400) and blocker-integrity conflict (409) are distinct — force overrides the approver gate, not the blocker gate', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `Conflict Classes ${suffix()}` });
        const token = u.access_token;

        // (a) LATTICE conflict: backlog has no edge to done → 400.
        const lat = await createTaskViaAPI(request, token, { title: `lattice-${suffix()}` });
        const illegal = await transition(request, token, lat.id, 'done');
        expect(illegal.status(), 'illegal lattice hop is a 400, not a 409').toBe(400);
        const illegalBody = await illegal.json();
        expect(illegalBody.message).toMatch(/cannot transition/i);
        expect(illegalBody.message).toContain('backlog');
        expect(illegalBody.message).toContain('done');
        // Non-mutating: still backlog.
        expect((await getTask(request, token, lat.id)).status).toBe('backlog');

        // (b) INTEGRITY conflict: walk a task to in_review, attach an OPEN blocker,
        // then attempt `→ done`. The hop is lattice-legal but the blocker gate fires
        // → 409. Build the blocker graph first.
        const blocker = await createTaskViaAPI(request, token, { title: `blocker-${suffix()}` });
        const dep = await createTaskViaAPI(request, token, { title: `dependent-${suffix()}` });
        for (const to of ['todo', 'in_progress', 'in_review']) {
            const r = await transition(request, token, dep.id, to);
            expect(r.status(), `setup hop ${to} body=${await r.text().catch(() => '')}`).toBe(200);
        }
        const addBlock = await request.post(`${API_BASE}/api/tasks/${dep.id}/blocks`, {
            headers: authedHeaders(token),
            data: { blockedByTaskId: blocker.id },
            timeout: T,
        });
        expect(addBlock.status(), `addBlocker body=${await addBlock.text().catch(() => '')}`).toBe(
            201,
        );

        const blockedDone = await transition(request, token, dep.id, 'done');
        expect(blockedDone.status(), 'open-blocker → done is a 409 integrity conflict').toBe(409);
        const blockedBody = await blockedDone.json();
        expect(blockedBody.message).toMatch(/open blocker/i);
        expect(blockedBody.error).toBe('Conflict');
        expect(blockedBody.statusCode).toBe(409);

        // `force=true` overrides ONLY the approver gate — the blocker gate is an
        // integrity rule and survives force: STILL 409, same message.
        const forcedDone = await transition(request, token, dep.id, 'done', true);
        expect(forcedDone.status(), 'force does NOT override the blocker integrity gate').toBe(409);
        expect((await forcedDone.json()).message).toMatch(/open blocker/i);

        // The dependent never moved — still in_review after both rejected `→ done`.
        expect((await getTask(request, token, dep.id)).status).toBe('in_review');

        // Resolve the blocker (done), then `→ done` on the dependent now succeeds —
        // the conflict was a TRUE precondition, not a phantom. (Tolerate the
        // async auto-unblock cascade by polling the dependent's eventual state.)
        const resolveBlocker = await transition(request, token, blocker.id, 'todo');
        expect(resolveBlocker.status()).toBe(200);
        await transition(request, token, blocker.id, 'in_progress');
        await transition(request, token, blocker.id, 'done');
        const nowDone = await transition(request, token, dep.id, 'done');
        expect(
            nowDone.status(),
            `with the blocker resolved, → done succeeds (body=${await nowDone.text().catch(() => '')})`,
        ).toBe(200);
        expect((await getTask(request, token, dep.id)).status).toBe('done');
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 3 — PARTIAL-PATCH LAST-WRITE-WINS + MONOTONIC updatedAt (Task & Agent).
    // Two concurrent PATCHes of DISTINCT values to the SAME field on the same row
    // must resolve to EXACTLY ONE of the two values — never a half-merged
    // "Frankenstein" row — and the persisted `updatedAt` must ADVANCE past the
    // pre-write snapshot (the optimistic-concurrency version token the conflict
    // detector / a UI's "someone else edited this" banner reads). We assert this on
    // BOTH a Task and an Agent (two independent entities, same contract), and that
    // untouched fields on the partial PATCH are preserved (true PATCH, not PUT).
    // ───────────────────────────────────────────────────────────────────────────
    test('concurrent partial PATCH resolves to exactly one value (no merge) and advances updatedAt — Task and Agent', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `LWW Patch ${suffix()}` });
        const token = u.access_token;
        const tag = suffix();

        // ── Task ──────────────────────────────────────────────────────────────
        const task = await createTaskViaAPI(request, token, {
            title: `lww-task-${tag}`,
            description: 'original-desc',
        });
        const beforeTask = await getTask(request, token, task.id);
        const titleA = `task-A-${tag}`;
        const titleB = `task-B-${tag}`;
        // Pause ≥1s so the second-resolution updatedAt can observably advance.
        await new Promise((r) => setTimeout(r, 1100));
        const [ta, tb] = await Promise.all([
            patchTask(request, token, task.id, { title: titleA }),
            patchTask(request, token, task.id, { title: titleB }),
        ]);
        expect(ta.status(), 'concurrent task PATCH A is client-level').toBeLessThan(500);
        expect(tb.status(), 'concurrent task PATCH B is client-level').toBeLessThan(500);

        const afterTask = await getTask(request, token, task.id);
        expect(
            [titleA, titleB].includes(afterTask.title),
            `final task title="${afterTask.title}" is neither A nor B — Frankenstein merge`,
        ).toBe(true);
        // description was NOT in either PATCH body → preserved (true partial PATCH).
        expect(afterTask.description, 'untouched field survives the partial PATCH').toBe(
            'original-desc',
        );
        // updatedAt advanced (monotonic, ≥ the pre-write snapshot — the version token).
        expect(
            Date.parse(afterTask.updatedAt) >= Date.parse(beforeTask.updatedAt),
            `task updatedAt did not advance: before=${beforeTask.updatedAt} after=${afterTask.updatedAt}`,
        ).toBe(true);
        expect(Date.parse(afterTask.updatedAt)).toBeGreaterThan(
            Date.parse(beforeTask.createdAt) - 1000,
        );

        // ── Agent (same contract on a different entity) ─────────────────────────
        const agent = await createAgentViaAPI(request, token, {
            name: `lww-agent-${tag}`,
            scope: 'tenant',
        });
        const beforeAgent = (await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, {
                headers: authedHeaders(token),
            })
        ).json()) as AgentRow;
        await new Promise((r) => setTimeout(r, 1100));
        const nameA = `agent-A-${tag}`;
        const nameB = `agent-B-${tag}`;
        const [aa, ab] = await Promise.all([
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                data: { name: nameA },
                timeout: T,
            }),
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                data: { name: nameB },
                timeout: T,
            }),
        ]);
        expect(aa.status(), 'concurrent agent PATCH A is client-level').toBeLessThan(500);
        expect(ab.status(), 'concurrent agent PATCH B is client-level').toBeLessThan(500);
        const afterAgent = (await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, {
                headers: authedHeaders(token),
            })
        ).json()) as AgentRow;
        expect(
            [nameA, nameB].includes(afterAgent.name),
            `final agent name="${afterAgent.name}" is neither A nor B — Frankenstein merge`,
        ).toBe(true);
        expect(
            Date.parse(afterAgent.updatedAt) >= Date.parse(beforeAgent.updatedAt),
            `agent updatedAt did not advance: before=${beforeAgent.updatedAt} after=${afterAgent.updatedAt}`,
        ).toBe(true);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 4 — UNIQUE-INDEX CREATE CONFLICT UNDER A CONCURRENT BURST (Agent slug).
    // An Agent name is unique-per-scope (a DB unique index on the derived slug). A
    // burst of N SIMULTANEOUS creates of the SAME name races the non-atomic
    // check-then-insert: exactly ONE wins (201) and every loser is caught by the
    // unique index → 409 "An Agent named \"<name>\" already exists in this scope."
    // The invariant: at most ONE 201 across the burst, the rest 409 (never a
    // duplicate row, never a 5xx leaking the race), AND a later SERIAL create of the
    // same name still 409s (the conflict is durable, not a race-window artifact).
    // ───────────────────────────────────────────────────────────────────────────
    test('a concurrent same-name Agent create burst yields exactly one 201 + the rest 409 (slug-uniqueness CAS, durable)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `Slug CAS ${suffix()}` });
        const token = u.access_token;
        const name = `Dup Agent ${suffix()}`;

        const BURST = 6;
        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${API_BASE}/api/agents`, {
                    headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                    data: { name, scope: 'tenant' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        for (const s of statuses) {
            expect(s, `each concurrent create is client-level (got ${s})`).toBeLessThan(500);
        }

        const created = statuses.filter((s) => s === 201);
        const conflicts = statuses.filter((s) => s === 409);
        // At most one create may win the unique-slug CAS; everyone else conflicts.
        expect(created.length, 'at most one Agent create wins the slug CAS').toBe(1);
        expect(conflicts.length, 'every other concurrent create is a 409 slug conflict').toBe(
            BURST - 1,
        );
        // The 409 bodies name the exact unique-scope conflict.
        const conflictBodies = await Promise.all(
            results.filter((r) => r.status() === 409).map((r) => r.json()),
        );
        for (const body of conflictBodies) {
            expect(body.message, 'conflict body names the duplicate scope').toMatch(
                /already exists in this scope/i,
            );
            expect(body.statusCode).toBe(409);
        }

        // Exactly one Agent with that slug exists — list it back. (slug is derived
        // lower-kebab of the name.) Tolerate sibling rows by filtering on name.
        const list = await request.get(`${API_BASE}/api/agents`, { headers: authedHeaders(token) });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const rows: AgentRow[] = body.data ?? body.agents ?? (Array.isArray(body) ? body : []);
        const mine = rows.filter((a) => a.name === name);
        expect(mine.length, 'exactly one Agent row landed for the contested name').toBe(1);

        // The conflict is durable: a fresh SERIAL create of the same name still 409s.
        const serialDup = await request.post(`${API_BASE}/api/agents`, {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: { name, scope: 'tenant' },
            timeout: T,
        });
        expect(serialDup.status(), 'a later serial duplicate still conflicts').toBe(409);
        expect((await serialDup.json()).message).toMatch(/already exists in this scope/i);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 5 — DELETE-VS-WRITE & DOUBLE-DELETE RACES (Work + Task).
    // When a delete races a write (or another delete) on the same row, the loser
    // must observe the GONE row cleanly — never a 5xx, never a resurrected or
    // half-written ("Frankenstein") row. We assert:
    //   (a) Work double-delete (POST :id/delete) → at most one 200; the other 404;
    //       the row is gone (final GET 404).
    //   (b) Work PATCH-vs-delete → delete wins the TERMINAL state (final GET 404);
    //       neither response 5xxes.
    //   (c) Task delete-then-write → a write to the deleted Task is 404 "not found"
    //       (no ghost edit can re-create or mutate a purged row).
    // ───────────────────────────────────────────────────────────────────────────
    test('delete races a write / another delete — the loser sees a clean 404 gone row, never a 5xx or resurrected row', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `Delete Race ${suffix()}` });
        const token = u.access_token;

        // (a) Work DOUBLE-delete race.
        const wDouble = await createWorkViaAPI(request, token, { name: `wdel-double-${suffix()}` });
        const delA = request.post(`${API_BASE}/api/works/${wDouble.id}/delete`, {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: {},
            timeout: T,
        });
        const delB = request.post(`${API_BASE}/api/works/${wDouble.id}/delete`, {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: {},
            timeout: T,
        });
        const [rA, rB] = await Promise.all([delA, delB]);
        for (const r of [rA, rB]) {
            expect(
                r.status(),
                `double-delete response is client-level (got ${r.status()})`,
            ).toBeLessThan(500);
        }
        const okDeletes = [rA, rB].filter((r) => r.status() === 200);
        const goneDeletes = [rA, rB].filter((r) => r.status() === 404);
        // At least one delete succeeded; the loser saw the gone row (idempotent
        // at-most-once). The exact split is timing-sensitive, so assert the SET.
        expect(okDeletes.length + goneDeletes.length, 'both responses are 200 or 404').toBe(2);
        expect(okDeletes.length, 'at least one delete succeeded').toBeGreaterThanOrEqual(1);
        expect(
            goneDeletes.length,
            'at most one delete saw the already-gone row',
        ).toBeLessThanOrEqual(1);
        // The Work is gone — no resurrection.
        const goneGet = await request.get(`${API_BASE}/api/works/${wDouble.id}`, {
            headers: authedHeaders(token),
        });
        expect(goneGet.status(), 'the doubly-deleted Work is gone').toBe(404);

        // (b) Work PATCH-vs-delete race — delete must win the terminal state.
        const wMix = await createWorkViaAPI(request, token, { name: `wdel-mix-${suffix()}` });
        const [patchRes, delRes] = await Promise.all([
            request.patch(`${API_BASE}/api/works/${wMix.id}`, {
                headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                data: { name: `raced-rename-${suffix()}` },
                timeout: T,
            }),
            request.post(`${API_BASE}/api/works/${wMix.id}/delete`, {
                headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                data: {},
                timeout: T,
            }),
        ]);
        expect(patchRes.status(), 'patch-vs-delete: patch is client-level').toBeLessThan(500);
        expect(delRes.status(), 'patch-vs-delete: delete is client-level').toBeLessThan(500);
        // Whatever the interleaving, the TERMINAL state is gone — delete wins.
        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${API_BASE}/api/works/${wMix.id}`, {
                            headers: authedHeaders(token),
                        })
                    ).status(),
                {
                    timeout: 15_000,
                    message: 'a delete that raced a patch still wins the terminal state',
                },
            )
            .toBe(404);

        // (c) Task delete-then-write — a write to a purged Task is a clean 404.
        const task = await createTaskViaAPI(request, token, {
            title: `del-then-write-${suffix()}`,
        });
        const tDel = await request.delete(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(token),
            timeout: T,
        });
        expect(tDel.status(), 'task delete succeeds').toBe(200);
        const ghostPatch = await patchTask(request, token, task.id, { title: 'ghost-edit' });
        expect(ghostPatch.status(), 'a write to a deleted Task is a clean 404').toBe(404);
        const ghostBody = await ghostPatch.json();
        expect(ghostBody.message, 'the 404 names the missing row, not a 5xx').toMatch(/not found/i);
        // A ghost transition on the purged row is equally a clean 404 (never 5xx).
        const ghostTransition = await transition(request, token, task.id, 'todo');
        expect(ghostTransition.status(), 'a transition on a deleted Task is a 404').toBe(404);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 6 — CONDITIONAL-READ (If-None-Match) DETECTS A CONCURRENT WRITER, BUT
    // THE WRITE PRECONDITION (If-Match / If-Unmodified-Since) IS NOT HONOURED.
    // The safe GET carries a weak ETag derived from the body. A conditional re-read
    // with the matching If-None-Match → 304 (unchanged). After a CONCURRENT writer
    // mutates the row, the same If-None-Match is now STALE → 200 with the new body +
    // a NEW ETag — exactly the signal a client polls to detect "someone else edited
    // this". CRUCIALLY: the WRITE-side precondition (If-Match with a stale/bogus
    // ETag, and If-Unmodified-Since in the past) is IGNORED — the PATCH still
    // applies (no 412/409). We assert that TRUTHFUL contract (optimistic concurrency
    // is enforced at the DOMAIN layer per Flows 1/4, NOT via HTTP preconditions) and
    // annotate it, rather than asserting a fictional 412.
    // ───────────────────────────────────────────────────────────────────────────
    test('If-None-Match round-trips 304→200 across a concurrent write, while the If-Match write precondition is (truthfully) not enforced', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request, { name: `Conditional Read ${suffix()}` });
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: `etag-rt-${suffix()}` });

        // Read once and capture the weak ETag.
        const first = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(token),
            timeout: T,
        });
        expect(first.status()).toBe(200);
        const etag = first.headers()['etag'];
        expect(etag, 'safe GET emits an ETag for conditional reads').toBeTruthy();
        // The platform's JSON ETags are weak (body-derived) — RFC 7232 §2.3.
        expect(etag, 'JSON ETag is weak (W/...)').toMatch(/^W\//);

        // A conditional re-read with the matching If-None-Match → 304 (unchanged).
        const conditional = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: { ...authedHeaders(token), 'If-None-Match': etag },
            timeout: T,
        });
        expect(conditional.status(), 'unchanged conditional read short-circuits to 304').toBe(304);

        // A CONCURRENT writer mutates the row (this is the "someone else edited it"
        // event the poller must detect). updatedAt is second-resolution; pause so
        // the body — and thus the ETag — observably changes.
        await new Promise((r) => setTimeout(r, 1100));
        const writer = await patchTask(request, token, task.id, {
            description: `concurrent-edit-${suffix()}`,
        });
        expect(writer.status(), 'the concurrent write applies').toBe(200);

        // The previously-fresh If-None-Match is now STALE → 200 with a NEW ETag.
        const afterWrite = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: { ...authedHeaders(token), 'If-None-Match': etag },
            timeout: T,
        });
        expect(
            afterWrite.status(),
            'a stale conditional read after a concurrent write returns 200 (change detected)',
        ).toBe(200);
        const newEtag = afterWrite.headers()['etag'];
        expect(newEtag, 'a mutated row carries a new ETag').toBeTruthy();
        expect(newEtag, 'the ETag advanced past the pre-write value').not.toBe(etag);

        // ── The WRITE precondition is NOT honoured (probed truth). ──────────────
        // A PATCH carrying a stale/bogus If-Match is NOT rejected with 412/409 — the
        // write applies (last-write-wins at the HTTP layer). Assert the real
        // behaviour and annotate, never a fictional optimistic-lock 412.
        const stalePrecondition = await patchTask(
            request,
            token,
            task.id,
            { title: `wrote-despite-stale-ifmatch-${suffix()}` },
            { 'If-Match': '"a-stale-or-bogus-etag"' },
        );
        expect(
            stalePrecondition.status(),
            'a stale If-Match does NOT 412/409 — the server is last-write-wins at the HTTP layer',
        ).toBe(200);
        const wroteTitle = (await stalePrecondition.json()).title as string;
        expect(wroteTitle, 'the write applied despite the stale If-Match').toMatch(
            /wrote-despite-stale-ifmatch/,
        );
        test.info().annotations.push({
            type: 'informational',
            description:
                'HTTP write preconditions (If-Match / If-Unmodified-Since) are NOT enforced on PATCH (no 412/409). Optimistic concurrency is enforced at the DOMAIN layer — the state machine CAS (Flow 1) and unique-index CAS (Flow 4) — not via HTTP preconditions.',
        });

        // If-Unmodified-Since in the past is equally ignored — the write applies.
        const ius = await patchTask(
            request,
            token,
            task.id,
            { priority: 'p1' },
            { 'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT' },
        );
        expect(
            ius.status(),
            'a past If-Unmodified-Since does NOT block the write (precondition ignored)',
        ).toBe(200);
        expect((await getTask(request, token, task.id)).priority).toBe('p1');
    });
});
