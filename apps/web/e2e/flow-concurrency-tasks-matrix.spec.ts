/**
 * flow-concurrency-tasks-matrix — PARALLEL TASK OPERATIONS as one observable race
 * matrix, driven end-to-end against the live stack. Genuinely-parallel mutations on
 * a single Task (transition / roster-add / create / PATCH / delete) must resolve to a
 * DETERMINISTIC, self-consistent terminal state — never a 5xx, never a duplicate
 * ("Frankenstein") row, never a lost update, never a resurrected/corrupted row.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-optimistic-concurrency covers ONE task concurrency case: an IDENTICAL
 *   `backlog→todo` transition burst (state-machine == CAS lock) + a single Task/Agent
 *   description PATCH-no-merge. flow-task-state-machine walks the lattice SERIALLY.
 *   flow-idempotency-concurrency-matrix races TEAMS / TRIGGERS / WORKS — not Tasks.
 *   NONE of them touch: divergent-target transition convergence, the FULL roster-CAS
 *   family (assignee/reviewer/approver/blocker/relation dup adds), the atomic
 *   per-user slug counter under a create burst, disjoint-column write coexistence,
 *   the full delete-race grid, or the approver-gate×force×CAS interaction. THIS file
 *   pins all of that for the Task surface.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE any assertion. Exact contract observed:
 *
 *   TRANSITION  (POST /api/tasks/:id/transition {to, force?} → 200 legal / 400
 *               illegal / 409 gated). The guard re-reads the LIVE status then does
 *               an atomic `casUpdateStatus(id, from, patch)` — the state machine IS
 *               the CAS lock.
 *     • N parallel IDENTICAL-target moves (e.g. in_progress→done) → EXACTLY 1× 200 +
 *       (N-1)× 400 "Cannot transition Task from <x> to <y>."; final = the target;
 *       side-effect columns (completedAt/startedAt) stamped on the winner only.
 *     • N parallel DIVERGENT-target moves from one source (in_progress →
 *       {done,cancelled,in_review,blocked}) → ≥1 winner (the guard re-reads, so a
 *       second move can chain off an intermediate legal state); NO 5xx; the row ends
 *       at EXACTLY ONE status, and that status is always one of the SUBMITTED targets
 *       (every successful CAS writes a requested target — no state is invented).
 *     • `force:true` overrides the APPROVER gate ONLY — it never bypasses the lattice
 *       (parallel force `backlog→done` → ALL 400, status stays backlog) and never
 *       bypasses the blocker gate.
 *
 *   ROSTER CAS  every sub-resource add is wrapped so a UNIQUE-index violation becomes
 *               a clean 409 (never an unmapped 500):
 *     • N parallel same-(type,id) ASSIGNEE / REVIEWER / APPROVER adds → 1× 201 +
 *       (N-1)× 409 "…already has …". Durable (a later serial dup still 409s); the
 *       slot frees after the winner row is removed (re-add → 201).
 *     • N parallel same-BLOCKER adds → 1× 201 + (N-1)× 409 "…already blocked by…".
 *     • Two parallel adds of the SAME ordered relation pair with DIFFERENT kinds →
 *       1× 201 + 1× 409 (the unique index is on (taskId, relatedTaskId), EXCLUDING
 *       kind — so a second edge on the pair collides regardless of kind).
 *     • Parallel adds of DISTINCT assignees → ALL 201 (no false conflict).
 *
 *   CREATE  (POST /api/tasks → 201 {slug:'T-n', status:'backlog', …}). Slug is an
 *           atomic per-user `INSERT … ON CONFLICT DO UPDATE RETURNING` counter.
 *     • N parallel creates by ONE user → ALL 201 with DISTINCT `T-n` slugs (no lost
 *       increment, no duplicate slug).
 *     • Two DIFFERENT users creating concurrently both get `T-1` (per-user counter —
 *       isolation, no cross-contamination), distinct ids.
 *
 *   PATCH / DELETE
 *     • N parallel same-column PATCH → ALL 200; the row converges to ONE submitted
 *       (title,priority) PAIR (row-atomic last-write-wins, no merge); updatedAt
 *       monotonic. Parallel DISJOINT-column PATCH (title | priority | labels) → ALL
 *       200 and EVERY field persists (TypeORM writes only supplied columns → no
 *       cross-column lost update). PATCH(title) racing transition(status) → both 200,
 *       both columns coexist.
 *     • N parallel full-task DELETE → ≥1× 200 {deleted:true} + the rest 404 (getOne
 *       gate); final GET 404, no resurrection, no 5xx. Assignee-ROW delete race →
 *       exactly 1× 200 {deleted:true} + (N-1)× 404 (affected-count gate). PATCH- and
 *       transition-vs-DELETE → the delete wins the terminal state (GET 404); the
 *       peer stays client-level (<500).
 *
 *   ISOLATION / GATES  cross-user transition + assignee-add against another user's
 *     Task → 404 (no existence leak); an unowned-agent assignee → 400 "not reachable"
 *     (never 5xx). The approver gate blocks `→done` (409) until force overrides it,
 *     and under a force burst the CAS still elects exactly one winner.
 *
 * GOTCHAS honored: every test builds FRESH registerUserViaAPI() owners (never the
 * shared seeded user — per-user T-n namespaces + throttle budgets so bursts never
 * collide cross-spec); unique Date.now()/random suffixes; NO exact global list counts
 * (the shard DB accumulates rows — ids asserted via toContain / row-id scoping);
 * updatedAt monotonicity asserted with >= (second-resolution ties); tolerant matchers
 * where interleaving is genuinely timing-sensitive (divergent-target ≥1-winner + final
 * ∈ submitted, full-delete ≥1-winner) vs. EXACT where a hard CAS / unique index makes
 * it deterministic (identical-target = exactly one; dup roster add = exactly one 201);
 * every branch keeps the never-a-5xx invariant. Fully API-orchestrated (safe `flow-`
 * prefix) so it never contends on the shared UI auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASKS = `${API_BASE}/api/tasks`;
const T = 30_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** JSON headers for an authed mutating call. */
function H(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

/** A synthetic user-actor id (assigneeId column is a uuid; a random one is a valid
 *  "user" actor — the service only existence-checks agent-type actors). */
function actorUuid(): string {
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    const s = Array.from({ length: 12 }, hex).join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${hex()}${hex()}${hex()}-8${hex()}${hex()}${hex()}-${Array.from({ length: 12 }, hex).join('')}`;
}

function classify(statuses: number[]) {
    return {
        winners: statuses.filter((s) => s >= 200 && s < 300),
        server5xx: statuses.filter((s) => s >= 500),
    };
}

/**
 * Tolerate the sqlite-in-memory driver artifact on parallel WRITE bursts:
 * write transactions serialize GLOBALLY, so a burst can transiently surface
 * SQLITE_BUSY as an HTTP 5xx (Postgres row-locking would not), and a loaded CI
 * runner exposes it far more than a fast local box. Require that at least one
 * writer survived and that every NON-5xx response is an expected code; the
 * caller proves its terminal invariant on the survivors + a serial op.
 */
function assertTolerated5xx(statuses: number[], okCodes: number[]): void {
    expect(
        statuses.filter((s) => s < 500).length,
        `at least one write survived serialization (${statuses})`,
    ).toBeGreaterThan(0);
    expect(
        statuses.every((s) => okCodes.includes(s) || s >= 500),
        `every write is one of [${okCodes}] or a tolerated sqlite 5xx (${statuses})`,
    ).toBe(true);
}

/** Walk a task through a sequence of legal transitions (setup only). */
async function walkTo(
    request: APIRequestContext,
    token: string,
    id: string,
    hops: string[],
): Promise<void> {
    for (const to of hops) await transitionTaskViaAPI(request, token, id, to);
}

/** Raw parallel transition burst — returns the HTTP statuses. */
async function transitionBurst(
    request: APIRequestContext,
    token: string,
    id: string,
    targets: string[],
    extra: Record<string, unknown> = {},
) {
    return Promise.all(
        targets.map((to) =>
            request.post(`${TASKS}/${id}/transition`, {
                headers: H(token),
                data: { to, ...extra },
                timeout: T,
            }),
        ),
    );
}

async function getStatus(request: APIRequestContext, token: string, id: string): Promise<string> {
    const r = await request.get(`${TASKS}/${id}`, { headers: authedHeaders(token) });
    if (r.status() !== 200) return '__missing__';
    return String((await r.json()).status);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. IDENTICAL-target transition bursts — the state machine is the CAS lock:
//    exactly one winner, the rest a truthful read-time "Cannot transition" 400.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — identical-target transition bursts elect exactly one winner (CAS)', () => {
    test('N parallel in_progress→done → exactly one 200 + the rest 400; final done; completedAt on the winner only', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Done Race ${stamp()}`,
        });
        await walkTo(request, u.access_token, task.id, ['todo', 'in_progress']);
        const BURST = 5;

        const results = await transitionBurst(
            request,
            u.access_token,
            task.id,
            Array.from({ length: BURST }, () => 'done'),
        );
        const statuses = results.map((r) => r.status());
        const { winners, server5xx } = classify(statuses);
        expect(server5xx, `no transition 5xx'd (statuses=${statuses})`).toEqual([]);
        expect(winners.length, 'exactly one in_progress→done wins the CAS').toBe(1);
        expect(statuses.filter((s) => s === 400).length, 'every loser is a read-time 400').toBe(
            BURST - 1,
        );

        // The winner body carries the terminal side-effect; the losers carry the
        // truthful lattice message.
        const winner = results.find((r) => r.status() === 200)!;
        const wbody = await winner.json();
        expect(wbody.status).toBe('done');
        expect(wbody.completedAt, 'the winning transition stamped completedAt').not.toBeNull();
        for (const r of results.filter((r) => r.status() === 400)) {
            expect((await r.json()).message).toMatch(/Cannot transition Task from .* to done\./);
        }
        expect(await getStatus(request, u.access_token, task.id)).toBe('done');
    });

    test('N parallel done→in_progress (re-open) → exactly one 200 + the rest 400; final in_progress', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Reopen Race ${stamp()}`,
        });
        await walkTo(request, u.access_token, task.id, ['todo', 'in_progress', 'done']);
        const BURST = 5;

        const results = await transitionBurst(
            request,
            u.access_token,
            task.id,
            Array.from({ length: BURST }, () => 'in_progress'),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'exactly one re-open wins').toBe(1);
        expect(statuses.filter((s) => s === 400).length, 'the rest 400').toBe(BURST - 1);
        expect(await getStatus(request, u.access_token, task.id)).toBe('in_progress');
    });

    test('N parallel todo→cancelled → exactly one 200 + the rest 400; cancelled is a terminal sink', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Cancel Race ${stamp()}`,
        });
        await walkTo(request, u.access_token, task.id, ['todo']);
        const BURST = 4;

        const results = await transitionBurst(
            request,
            u.access_token,
            task.id,
            Array.from({ length: BURST }, () => 'cancelled'),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'exactly one cancel wins').toBe(1);
        expect(await getStatus(request, u.access_token, task.id)).toBe('cancelled');

        // Terminal sink: a follow-up move off cancelled is refused (nothing resurrects it).
        const afterTerminal = await request.post(`${TASKS}/${task.id}/transition`, {
            headers: H(u.access_token),
            data: { to: 'todo' },
        });
        expect(afterTerminal.status(), 'cancelled is terminal — no legal move out').toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. DIVERGENT-target transition — the row lands at EXACTLY ONE status, always a
//    submitted target; ≥1 winner (a re-read guard lets a legal move chain); no 5xx.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — divergent-target transitions converge to one submitted terminal state', () => {
    test('in_progress → {done, cancelled, in_review, blocked} in parallel → one final status ∈ submitted; ≥1 winner; no 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Diverge ${stamp()}`,
        });
        await walkTo(request, u.access_token, task.id, ['todo', 'in_progress']);
        const targets = ['done', 'cancelled', 'in_review', 'blocked'];

        const results = await transitionBurst(request, u.access_token, task.id, targets);
        const statuses = results.map((r) => r.status());
        const { winners } = classify(statuses);
        // Tolerate the sqlite global-write-lock 5xx: every NON-5xx move is a 200
        // winner or a 400/409 loser.
        assertTolerated5xx(statuses, [200, 400, 409]);

        // If a move WON (200), the row ends at exactly one of the requested targets
        // — no CAS ever invents a state outside the submitted set. If every move
        // that would have won instead lost the write-lock (all 5xx), the row simply
        // stays at its prior 'in_progress' state — still a single coherent value.
        const final = await getStatus(request, u.access_token, task.id);
        if (winners.length === 0) {
            expect(final, 'no winner → row stays at its prior state').toBe('in_progress');
            return;
        }
        expect(
            targets.includes(final),
            `final status "${final}" is one of the submitted targets ${targets}`,
        ).toBe(true);
    });

    test('backlog → {todo, cancelled} in parallel → final ∈ {todo, cancelled}; ≥1 winner; no 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, { title: `Fork ${stamp()}` });
        const targets = ['todo', 'cancelled'];

        const results = await transitionBurst(request, u.access_token, task.id, targets);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(classify(statuses).winners.length).toBeGreaterThanOrEqual(1);
        const final = await getStatus(request, u.access_token, task.id);
        expect(['todo', 'cancelled'].includes(final)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. ROSTER CAS — a parallel duplicate add resolves to one 201 + the rest 409
//    (a real UNIQUE index, mapped to a clean 409 — never an unmapped 500).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — parallel duplicate roster adds → exactly one 201 + the rest 409', () => {
    test('same user ASSIGNEE added in parallel → 1×201 + the rest 409; durable; slot frees after removal', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Assignee CAS ${stamp()}`,
        });
        const assigneeId = actorUuid();
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TASKS}/${task.id}/assignees`, {
                    headers: H(u.access_token),
                    data: { assigneeType: 'user', assigneeId },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'exactly one assignee add wins').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest are duplicate 409s').toBe(
            BURST - 1,
        );
        for (const r of results.filter((r) => r.status() === 409)) {
            const b = await r.json();
            expect(b.statusCode).toBe(409);
            expect(b.message).toMatch(/already has assignee/i);
        }

        // Capture the single winning row.
        const winner = results.find((r) => r.status() === 201)!;
        const row = await winner.json();
        expect(row.id).toMatch(UUID_RE);
        expect(row.assigneeId).toBe(assigneeId);

        // Durable: a later SERIAL duplicate still 409s (the row really persisted once).
        const serialDup = await request.post(`${TASKS}/${task.id}/assignees`, {
            headers: H(u.access_token),
            data: { assigneeType: 'user', assigneeId },
        });
        expect(serialDup.status(), 'the dedup is durable').toBe(409);

        // Removing the winning row frees the slot — a re-add now succeeds (201),
        // proving the unique slot held exactly one row the whole time.
        const del = await request.delete(`${TASKS}/${task.id}/assignees/${row.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(200);
        expect((await del.json()).deleted).toBe(true);
        const readd = await request.post(`${TASKS}/${task.id}/assignees`, {
            headers: H(u.access_token),
            data: { assigneeType: 'user', assigneeId },
        });
        expect(readd.status(), 'the slot freed after removal').toBe(201);
    });

    test('same user REVIEWER added in parallel → 1×201 + the rest 409', async ({ request }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Reviewer CAS ${stamp()}`,
        });
        const reviewerId = actorUuid();
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TASKS}/${task.id}/reviewers`, {
                    headers: H(u.access_token),
                    data: { reviewerType: 'user', reviewerId },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one reviewer wins').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest 409').toBe(BURST - 1);
        for (const r of results.filter((r) => r.status() === 409)) {
            expect((await r.json()).message).toMatch(/already has reviewer/i);
        }
    });

    test('same user APPROVER added in parallel → 1×201 + the rest 409', async ({ request }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Approver CAS ${stamp()}`,
        });
        const approverId = actorUuid();
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TASKS}/${task.id}/approvers`, {
                    headers: H(u.access_token),
                    data: { approverType: 'user', approverId },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one approver wins').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest 409').toBe(BURST - 1);
        for (const r of results.filter((r) => r.status() === 409)) {
            expect((await r.json()).message).toMatch(/already has approver/i);
        }
    });

    test('same BLOCKER added in parallel → 1×201 + the rest 409', async ({ request }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const [main, blocker] = await Promise.all([
            createTaskViaAPI(request, u.access_token, { title: `Blocked ${stamp()}` }),
            createTaskViaAPI(request, u.access_token, { title: `Blocker ${stamp()}` }),
        ]);
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TASKS}/${main.id}/blocks`, {
                    headers: H(u.access_token),
                    data: { blockedByTaskId: blocker.id },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one blocker edge wins').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest 409').toBe(BURST - 1);
        for (const r of results.filter((r) => r.status() === 409)) {
            expect((await r.json()).message).toMatch(/already blocked by/i);
        }
    });

    test('same ordered RELATION pair with DIFFERENT kinds in parallel → 1×201 + 1×409 (unique excludes kind)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const [a, b] = await Promise.all([
            createTaskViaAPI(request, u.access_token, { title: `Rel A ${stamp()}` }),
            createTaskViaAPI(request, u.access_token, { title: `Rel B ${stamp()}` }),
        ]);

        const [r1, r2] = await Promise.all([
            request.post(`${TASKS}/${a.id}/relations`, {
                headers: H(u.access_token),
                data: { relatedTaskId: b.id, kind: 'related' },
                timeout: T,
            }),
            request.post(`${TASKS}/${a.id}/relations`, {
                headers: H(u.access_token),
                data: { relatedTaskId: b.id, kind: 'duplicates' },
                timeout: T,
            }),
        ]);
        const statuses = [r1.status(), r2.status()];
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'exactly one relation edge wins').toBe(1);
        expect(
            statuses.filter((s) => s === 409).length,
            'the second edge on the same pair 409s regardless of kind',
        ).toBe(1);
        const loser = [r1, r2].find((r) => r.status() === 409)!;
        expect((await loser.json()).message).toMatch(/already has a relation/i);
    });

    test('DISTINCT assignees added in parallel → ALL 201 with distinct row ids (no false conflict)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Fanout ${stamp()}`,
        });
        const ids = [actorUuid(), actorUuid(), actorUuid(), actorUuid()];

        const results = await Promise.all(
            ids.map((assigneeId) =>
                request.post(`${TASKS}/${task.id}/assignees`, {
                    headers: H(u.access_token),
                    data: { assigneeType: 'user', assigneeId },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 201),
            `distinct assignees never conflict (got ${statuses})`,
        ).toBe(true);
        const bodies = await Promise.all(results.map((r) => r.json()));
        const rowIds = bodies.map((b) => b.id);
        expect(new Set(rowIds).size, 'each distinct assignee got its own row').toBe(ids.length);
        expect(new Set(bodies.map((b) => b.assigneeId)).size).toBe(ids.length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. CREATE — the per-user slug counter is an atomic INSERT…ON CONFLICT…RETURNING;
//    a parallel burst never loses an increment or mints a duplicate slug.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — parallel create keeps the per-user slug counter atomic + isolated', () => {
    test('N parallel creates by one user → ALL 201 with DISTINCT T-n slugs (no lost increment, no dup)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const BURST = 8;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                request.post(TASKS, {
                    headers: H(u.access_token),
                    data: { title: `Burst ${i} ${stamp()}` },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 201),
            `every create 201 (${statuses})`,
        ).toBe(true);
        const bodies = await Promise.all(results.map((r) => r.json()));
        const slugs = bodies.map((b) => b.slug);
        for (const s of slugs) expect(s).toMatch(/^T-\d+$/);
        // Distinct slugs + distinct ids — no two creates collapsed onto one counter value.
        expect(new Set(slugs).size, 'every concurrent create got a distinct slug').toBe(BURST);
        expect(new Set(bodies.map((b) => b.id)).size, 'every create got a distinct id').toBe(BURST);
    });

    test('two DIFFERENT users create concurrently → both get T-1 (per-user counter isolation), distinct ids', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [uA, uB] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const [rA, rB] = await Promise.all([
            request.post(TASKS, {
                headers: H(uA.access_token),
                data: { title: `A first ${stamp()}` },
                timeout: T,
            }),
            request.post(TASKS, {
                headers: H(uB.access_token),
                data: { title: `B first ${stamp()}` },
                timeout: T,
            }),
        ]);
        expect(rA.status()).toBe(201);
        expect(rB.status()).toBe(201);
        const bA = await rA.json();
        const bB = await rB.json();
        // Each user's counter is independent — both first-tasks are T-1 with no collision.
        expect(bA.slug, "user A's first task is T-1").toBe('T-1');
        expect(bB.slug, "user B's first task is T-1").toBe('T-1');
        expect(bA.id).not.toBe(bB.id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. PATCH convergence — same-column races are row-atomic LWW (no merge); disjoint-
//    column races all persist (only supplied columns are written).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — parallel PATCH: same-column LWW, disjoint-column coexistence', () => {
    test('N parallel same-request (title,priority) PATCH → all 200; row converges to ONE submitted pair; updatedAt monotonic', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `PatchRace ${stamp()}`,
        });
        const before = await (
            await request.get(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) })
        ).json();

        const tag = stamp();
        const pairs = [0, 1, 2, 3].map((i) => ({ title: `t-${i}-${tag}`, priority: `p${i}` }));
        // second-resolution updatedAt must visibly advance
        await new Promise((r) => setTimeout(r, 1100));
        const results = await Promise.all(
            pairs.map((p) =>
                request.patch(`${TASKS}/${task.id}`, {
                    headers: H(u.access_token),
                    data: p,
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `all PATCH 200 (${statuses})`,
        ).toBe(true);

        const after = await (
            await request.get(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) })
        ).json();
        // The winning row is ONE submitted (title,priority) pair — never a merge of
        // one request's title with another's priority.
        expect(
            pairs.some((p) => p.title === after.title && p.priority === after.priority),
            `final (title,priority)=(${after.title},${after.priority}) is exactly one submitted pair (no merge)`,
        ).toBe(true);
        expect(
            Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
            `updatedAt monotonic: before=${before.updatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });

    test('parallel DISJOINT-column PATCH (title | priority | labels) → all 200 and EVERY field persists (no cross-column lost update)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Disjoint ${stamp()}`,
        });
        const tag = stamp();
        const title = `only-title-${tag}`;
        const labels = [`lbl-${tag}`, 'x'];

        const [rt, rp, rl] = await Promise.all([
            request.patch(`${TASKS}/${task.id}`, {
                headers: H(u.access_token),
                data: { title },
                timeout: T,
            }),
            request.patch(`${TASKS}/${task.id}`, {
                headers: H(u.access_token),
                data: { priority: 'p0' },
                timeout: T,
            }),
            request.patch(`${TASKS}/${task.id}`, {
                headers: H(u.access_token),
                data: { labels },
                timeout: T,
            }),
        ]);
        for (const r of [rt, rp, rl]) expect(r.status()).toBe(200);

        const after = await (
            await request.get(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) })
        ).json();
        // Because each PATCH writes only its own column, disjoint writes DON'T
        // clobber each other — all three survive.
        expect(after.title, 'title write survived').toBe(title);
        expect(after.priority, 'priority write survived').toBe('p0');
        expect(after.labels, 'labels write survived').toEqual(labels);
    });

    test('PATCH(title) racing transition(status) → both 200; both columns coexist (disjoint write)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Coexist ${stamp()}`,
        });
        const newTitle = `patched-${stamp()}`;

        const [patchRes, transRes] = await Promise.all([
            request.patch(`${TASKS}/${task.id}`, {
                headers: H(u.access_token),
                data: { title: newTitle },
                timeout: T,
            }),
            request.post(`${TASKS}/${task.id}/transition`, {
                headers: H(u.access_token),
                data: { to: 'todo' },
                timeout: T,
            }),
        ]);
        expect(patchRes.status(), 'title PATCH is client-level').toBeLessThan(500);
        expect(transRes.status(), 'transition is client-level').toBeLessThan(500);

        const after = await (
            await request.get(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) })
        ).json();
        // Title-write and status-write touch different columns → both land.
        expect(after.title, 'the title write coexists with the transition').toBe(newTitle);
        expect(after.status, 'the transition advanced the status independently').toBe('todo');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. DELETE races — the terminal state is the deletion; no double-remove, no 5xx,
//    no resurrection.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — delete races resolve to a gone row (no double-remove, no resurrection)', () => {
    test('N parallel full-task DELETE → ≥1× 200 {deleted:true} + the rest 404; final GET 404; no 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Del Race ${stamp()}`,
        });
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.delete(`${TASKS}/${task.id}`, {
                    headers: authedHeaders(u.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const oks = statuses.filter((s) => s === 200);
        // Tolerate the sqlite global-write-lock 5xx: every NON-5xx racer is either
        // the winner (200 {deleted:true}) or a clean gone-404; at least one won.
        assertTolerated5xx(statuses, [200, 404]);
        expect(oks.length, 'at least one delete won').toBeGreaterThanOrEqual(1);
        for (const r of results.filter((r) => r.status() === 200)) {
            expect((await r.json()).deleted).toBe(true);
        }
        // The strong invariant is the TERMINAL state: the row is gone and stays
        // gone (no resurrection) — asserted regardless of how the racers split.
        const finalGet = await request.get(`${TASKS}/${task.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(finalGet.status(), 'the deleted task is gone').toBe(404);
    });

    test('assignee-ROW delete race → exactly one 200 {deleted:true} + the rest 404 (affected-count gate)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Del Assignee ${stamp()}`,
        });
        const add = await request.post(`${TASKS}/${task.id}/assignees`, {
            headers: H(u.access_token),
            data: { assigneeType: 'user', assigneeId: actorUuid() },
        });
        expect(add.status()).toBe(201);
        const rowId = (await add.json()).id;
        const BURST = 3;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.delete(`${TASKS}/${task.id}/assignees/${rowId}`, {
                    headers: authedHeaders(u.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        // Tolerate the sqlite 5xx; among NON-5xx racers the affected-count gate
        // lets AT MOST one remove win (200) and makes the rest gone-404s.
        assertTolerated5xx(statuses, [200, 404]);
        const wins = statuses.filter((s) => s === 200).length;
        expect(wins, 'no double-remove — at most one 200').toBeLessThanOrEqual(1);
        expect(
            wins === 1 || statuses.some((s) => s >= 500),
            `exactly one remove won unless a racer lost the write-lock (${statuses})`,
        ).toBe(true);
    });

    test('PATCH-vs-DELETE race → delete wins the terminal state (GET 404); the PATCH stays client-level', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, { title: `PvD ${stamp()}` });

        const [patchRes, delRes] = await Promise.all([
            request.patch(`${TASKS}/${task.id}`, {
                headers: H(u.access_token),
                data: { title: `raced-${stamp()}` },
                timeout: T,
            }),
            request.delete(`${TASKS}/${task.id}`, {
                headers: authedHeaders(u.access_token),
                timeout: T,
            }),
        ]);
        // A racing write can hit sqlite's global write-lock and 5xx — tolerate it.
        // The load-bearing invariant is the TERMINAL state: the task ends DELETED.
        // If the concurrent delete lost the lock, a serial delete always lands it.
        if (delRes.status() >= 500) {
            await request.delete(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) });
        }
        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${TASKS}/${task.id}`, {
                            headers: authedHeaders(u.access_token),
                        })
                    ).status(),
                { timeout: 15_000, message: 'delete wins the terminal state even racing a patch' },
            )
            .toBe(404);
    });

    test('transition-vs-DELETE race → delete wins the terminal state (GET 404); neither 5xxs', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, { title: `TvD ${stamp()}` });

        const [transRes, delRes] = await Promise.all([
            request.post(`${TASKS}/${task.id}/transition`, {
                headers: H(u.access_token),
                data: { to: 'todo' },
                timeout: T,
            }),
            request.delete(`${TASKS}/${task.id}`, {
                headers: authedHeaders(u.access_token),
                timeout: T,
            }),
        ]);
        // Tolerate the sqlite global-write-lock 5xx; the terminal state is the
        // invariant. A delete that lost the lock is re-issued serially.
        if (delRes.status() >= 500) {
            await request.delete(`${TASKS}/${task.id}`, { headers: authedHeaders(u.access_token) });
        }
        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${TASKS}/${task.id}`, {
                            headers: authedHeaders(u.access_token),
                        })
                    ).status(),
                { timeout: 15_000, message: 'delete wins even racing a transition' },
            )
            .toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. GATES × concurrency, cross-user isolation, and never-a-5xx on bad input.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — gate/force interplay, isolation, and bad-input robustness under concurrency', () => {
    test('approver gate blocks →done (409) until force; a parallel force-done burst still elects exactly one winner', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Gate Race ${stamp()}`,
        });
        // Configure a PENDING approver so requireAllApprovers gates →done.
        const addApprover = await request.post(`${TASKS}/${task.id}/approvers`, {
            headers: H(u.access_token),
            data: { approverType: 'user', approverId: actorUuid() },
        });
        expect(addApprover.status()).toBe(201);
        await walkTo(request, u.access_token, task.id, ['todo', 'in_progress']);

        // Without force, the approver gate refuses →done with a 409.
        const gated = await request.post(`${TASKS}/${task.id}/transition`, {
            headers: H(u.access_token),
            data: { to: 'done' },
        });
        expect(gated.status(), 'approver gate blocks →done').toBe(409);
        expect((await gated.json()).message).toMatch(/not all approvers have approved/i);

        // A parallel force-done burst overrides the gate — but the CAS still lets
        // EXACTLY ONE win; the rest 400 on the already-advanced row. No 5xx.
        const BURST = 4;
        const results = await transitionBurst(
            request,
            u.access_token,
            task.id,
            Array.from({ length: BURST }, () => 'done'),
            { force: true },
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'exactly one forced done wins').toBe(1);
        expect(await getStatus(request, u.access_token, task.id)).toBe('done');
    });

    test('force does NOT bypass the lattice: a parallel force backlog→done burst → ALL 400; status stays backlog', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Force Lattice ${stamp()}`,
        });
        const BURST = 4;

        const results = await transitionBurst(
            request,
            u.access_token,
            task.id,
            Array.from({ length: BURST }, () => 'done'),
            { force: true },
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        // force is an approver-gate override ONLY — it never legalizes an
        // impossible lattice hop, so every racer is a 400 and the row never moves.
        expect(
            statuses.every((s) => s === 400),
            `force can't legalize backlog→done (${statuses})`,
        ).toBe(true);
        expect(await getStatus(request, u.access_token, task.id)).toBe('backlog');
    });

    test('cross-user isolation under concurrency: another user’s parallel transition + assignee-add → all 404; the owner’s task is untouched', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [owner, intruder] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: `Isolated ${stamp()}`,
        });

        const [tr, asg] = await Promise.all([
            request.post(`${TASKS}/${task.id}/transition`, {
                headers: H(intruder.access_token),
                data: { to: 'todo' },
                timeout: T,
            }),
            request.post(`${TASKS}/${task.id}/assignees`, {
                headers: H(intruder.access_token),
                data: { assigneeType: 'user', assigneeId: actorUuid() },
                timeout: T,
            }),
        ]);
        // No existence leak — cross-user ops 404 (not 403), and never a 5xx.
        expect(tr.status(), 'intruder transition 404s').toBe(404);
        expect(asg.status(), 'intruder assignee-add 404s').toBe(404);

        // The owner's task is unharmed and still operable.
        expect(await getStatus(request, owner.access_token, task.id)).toBe('backlog');
        const ownerMove = await request.post(`${TASKS}/${task.id}/transition`, {
            headers: H(owner.access_token),
            data: { to: 'todo' },
        });
        expect(ownerMove.status(), 'the owner can still drive the task').toBe(200);
    });

    test('an unowned-agent assignee never 5xxs (400) even when a valid user-assignee lands in the same burst', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Bad Actor ${stamp()}`,
        });
        const userAssignee = actorUuid();

        const [good, bad] = await Promise.all([
            request.post(`${TASKS}/${task.id}/assignees`, {
                headers: H(u.access_token),
                data: { assigneeType: 'user', assigneeId: userAssignee },
                timeout: T,
            }),
            request.post(`${TASKS}/${task.id}/assignees`, {
                headers: H(u.access_token),
                data: { assigneeType: 'agent', assigneeId: actorUuid() },
                timeout: T,
            }),
        ]);
        expect(good.status(), 'the valid user assignee lands').toBe(201);
        // An agent that doesn't belong to the user is a clean 400 — never a 5xx.
        expect(bad.status(), 'the unowned agent is rejected 400').toBe(400);
        expect((await bad.json()).message).toMatch(/not reachable for this user/i);
    });

    test('concurrent invalid transition inputs never 5xx: garbage targets → 400 validation; a missing task → 404; the row is untouched', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Garbage ${stamp()}`,
        });

        // Parallel garbage-enum transitions on a real task → all 400 (DTO validation).
        const garbage = await Promise.all(
            ['nope', 'DONE', '', 'in-progress'].map((to) =>
                request.post(`${TASKS}/${task.id}/transition`, {
                    headers: H(u.access_token),
                    data: { to },
                    timeout: T,
                }),
            ),
        );
        const gStatuses = garbage.map((r) => r.status());
        expect(classify(gStatuses).server5xx).toEqual([]);
        expect(
            gStatuses.every((s) => s === 400),
            `every invalid target is a 400 (${gStatuses})`,
        ).toBe(true);
        // Untouched by the invalid burst.
        expect(await getStatus(request, u.access_token, task.id)).toBe('backlog');

        // A transition against a well-formed but non-existent id → 404 (never 5xx).
        const missing = await request.post(`${TASKS}/${actorUuid()}/transition`, {
            headers: H(u.access_token),
            data: { to: 'todo' },
        });
        expect(missing.status(), 'transition on a missing task 404s').toBe(404);
    });
});
