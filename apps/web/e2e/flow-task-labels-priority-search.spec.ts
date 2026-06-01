import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI, type Task } from './helpers/agents-tasks';

/**
 * Task LABELS · PRIORITY · SEARCH · PAGINATION — the deep query-surface
 * companion to the shallow `tasks-pagination-filter.spec.ts`.
 *
 * `tasks-pagination-filter.spec.ts` already pins the BASICS on a 5-task seed:
 * two disjoint limit/offset windows, ONE `?priority=p1`, ONE `?label=alpha`,
 * one `?search=Task 3`, and a garbage-limit-200 tolerance. It does NOT touch:
 * the full p0..p4 priority enumeration, the comma-separated multi-value IN
 * filter, the invalid-enum 400 guards, the PATCH label add/remove/replace
 * lifecycle, the exact-token label boundary, the updatedAt-DESC re-ordering on
 * mutation, full pagination-window EXHAUSTION (reconstruct the whole set with
 * no gaps/overlap), the offset-past-end empty window, every limit/offset clamp,
 * the multi-axis filter intersection (AND-narrowing), the title∥slug∥description
 * search OR, the un-escaped LIKE `%` wildcard, and cross-user count isolation.
 * Those are this file's six flows.
 *
 * SERVER SOURCE OF TRUTH (probed LIVE against http://127.0.0.1:3100 — sqlite
 * in-memory CI driver — on 2026-06-01 before every assertion below):
 *   `apps/api/src/tasks/tasks.controller.ts`           (TasksController.list / .update)
 *   `packages/agent/src/database/repositories/task.repository.ts` (findByUserIdFiltered)
 *   `packages/agent/src/tasks-domain/tasks.service.ts` (update — labels REPLACE)
 *   `packages/agent/src/entities/task.entity.ts`       (enums + defaults)
 *
 *   GET /api/tasks
 *     query: status, priority, missionId, ideaId, workId, parentTaskId,
 *            label, search, limit, offset
 *     → 200 { data:[Task…], meta:{ total, limit, offset } }
 *     - DEFAULT SORT: `ORDER BY task.updatedAt DESC` — newest-touched first.
 *       There is NO sort/order query param; mutating a row (PATCH or
 *       transition) bumps updatedAt and floats it to the head of the list.
 *     - `meta.total` is the count of the FULL filtered set (computed via
 *       getCount() BEFORE take/skip), stable across pages & past the end.
 *     - `meta.limit`/`meta.offset` echo the *effective* (clamped) window.
 *     - status / priority accept a COMMA-SEPARATED list → SQL `IN (...)`.
 *       A SINGLE unknown token anywhere → 400:
 *         priority: { message:"Invalid priority filter: <tok>", statusCode:400 }
 *         status:   { message:"Invalid status filter: <tok>",  statusCode:400 }
 *     - label is an EXACT-TOKEN substring against the serialized simple-json
 *       array: `task.labels LIKE %"<label>"%`. So `?label=lbl` does NOT match a
 *       task whose label is `lbl0` (the quotes bound the token); `?label=lbl0`
 *       does. A task may carry MANY labels; a shared label matches all of them.
 *     - search is `(title LIKE %q% OR slug LIKE %q% OR description LIKE %q%)`.
 *       The `%` in `%q%` is NOT escaped, so a search value of `%` becomes a
 *       LIKE wildcard and matches EVERY row (un-escaped LIKE — a real, pinned
 *       behaviour, not a bug we assert against).
 *     - empty `search=`/`label=`/`status=`/`priority=` are falsy → the filter
 *       is skipped entirely (no narrowing, no 400).
 *     - CLAMPS (probed exactly): limit missing→50, limit=0→50, limit=abc→50,
 *       limit=2.9→2 (parseInt floor), limit=9999→200 (cap); offset missing→0,
 *       offset=abc→0, offset=-5→0; offset past total → empty data[], meta.total
 *       still the full count.
 *
 *   POST /api/tasks { title, priority?, labels?, description?, status? } → 201
 *     - born status:'backlog', priority:'p3', slug:`T-<n>` (per-user counter).
 *   PATCH /api/tasks/:id { priority?, labels?, … } → 200 (the refreshed row)
 *     - `labels` is REPLACE-not-merge: `patch.labels = input.labels`. Passing
 *       `labels:[]` CLEARS all labels (the row then matches no `?label=` query);
 *       OMITTING labels leaves them untouched. Every PATCH bumps updatedAt.
 *
 * ISOLATION: every flow runs on its OWN `registerUserViaAPI()` user — tasks are
 * user-scoped (WHERE task.userId), per-user slug counters reset to `T-1`, and a
 * foreign user's tasks are invisible to the count. Assertions on totals/sets use
 * the freshly-seeded user so exact counts are safe (no pre-existing rows).
 */

const T = 25_000;

// The shared `Task` helper type is a narrow subset (id/slug/title/status/
// priority) and omits the `labels` array the list/get rows actually carry.
// Widen it locally rather than touching the shared helper.
type TaskRow = Task & { labels?: string[] | null };

interface ListResponse {
    data: TaskRow[];
    meta: { total: number; limit: number; offset: number };
}

/** GET /api/tasks with an arbitrary query string; asserts 200 + envelope shape. */
async function listTasks(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ListResponse> {
    const res = await request.get(`${API_BASE}/api/tasks${query}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status(), `list ${query} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(Array.isArray(body.data), 'data is an array').toBe(true);
    expect(typeof body.meta.total).toBe('number');
    return body;
}

/** Raw GET so the non-2xx 400-guard bodies can be inspected. */
function rawList(request: APIRequestContext, token: string, query: string) {
    return request.get(`${API_BASE}/api/tasks${query}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
}

async function patchTask(
    request: APIRequestContext,
    token: string,
    id: string,
    body: { priority?: string; labels?: string[] | null; title?: string },
): Promise<TaskRow> {
    const res = await request.patch(`${API_BASE}/api/tasks/${id}`, {
        headers: authedHeaders(token),
        data: body,
        timeout: T,
    });
    expect(res.status(), `patch body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Create a task carrying explicit priority+labels, asserting the 201 shape. */
async function seedTask(
    request: APIRequestContext,
    token: string,
    body: { title: string; priority?: string; labels?: string[]; description?: string },
): Promise<TaskRow> {
    const t = (await createTaskViaAPI(request, token, body)) as TaskRow;
    expect(t.id).toBeTruthy();
    expect(t.slug).toMatch(/^T-\d+$/);
    return t;
}

const idsOf = (rows: TaskRow[]) => rows.map((r) => r.id);

/**
 * The list sort is `ORDER BY task.updatedAt DESC` with NO secondary
 * tie-breaker (task.repository.ts:89). On the sqlite CI driver `updatedAt`
 * has only SECOND granularity — probed live, the column round-trips as
 * `…:43.000Z` (truncated to whole seconds). So two mutations that land in the
 * SAME wall-clock second get an IDENTICAL updatedAt, the DESC sort ties, and
 * sqlite breaks the tie by ascending rowid (insertion order) — which puts the
 * EARLIER-created row at the head, the OPPOSITE of "newest touch first". That
 * is a genuine race: when the PATCH (on `first`) and the transition (on
 * `second`) collide in one second, `first` wrongly stays at the head and no
 * amount of polling reorders it (there is no further mutation to bump the
 * clock). Gate each ordering-significant mutation behind a fresh second so the
 * updatedAt values are STRICTLY increasing and the DESC order is deterministic.
 */
async function waitForNextSecond(): Promise<void> {
    const start = Date.now();
    // Sleep just past the next whole-second boundary (+50ms cushion so the
    // server's own `new Date()` is comfortably inside the new second).
    const ms = 1000 - (start % 1000) + 50;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('Task labels · priority · search · pagination (deep API query surface)', () => {
    test('priority axis: full p0..p4 enumeration, comma-separated multi-value IN filter, and the single-bad-token 400 guard (with total invariance)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        // One task at EACH of the five priority bands. createTask defaults to p3
        // when omitted, so we pass every band explicitly to prove p0..p4 all round-trip.
        const bands = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;
        const created: Record<string, Task> = {};
        for (const p of bands) {
            created[p] = await seedTask(request, token, {
                title: `Prio ${p} ${stamp}`,
                priority: p,
            });
            expect(created[p].priority, `${p} persists on create`).toBe(p);
        }

        // Baseline: exactly five tasks, one per band.
        const all = await listTasks(request, token, '?limit=50');
        expect(all.meta.total).toBe(5);
        expect(new Set(all.data.map((t) => t.priority))).toEqual(new Set(bands));

        // Each single-band filter isolates exactly its one row.
        for (const p of bands) {
            const r = await listTasks(request, token, `?priority=${p}`);
            expect(r.meta.total, `?priority=${p} total`).toBe(1);
            expect(r.data.every((t) => t.priority === p)).toBe(true);
        }

        // Comma-separated multi-value → SQL IN(...). p0,p2,p4 selects exactly those three.
        const odd = await listTasks(request, token, '?priority=p0,p2,p4');
        expect(odd.meta.total).toBe(3);
        expect(new Set(odd.data.map((t) => t.priority))).toEqual(new Set(['p0', 'p2', 'p4']));

        // Whitespace around tokens is trimmed by the controller's split/map(trim).
        const trimmed = await listTasks(
            request,
            token,
            `?priority=${encodeURIComponent(' p1 , p3 ')}`,
        );
        expect(trimmed.meta.total).toBe(2);
        expect(new Set(trimmed.data.map((t) => t.priority))).toEqual(new Set(['p1', 'p3']));

        // A SINGLE bad token anywhere in the CSV rejects the WHOLE request 400 —
        // it is NOT silently dropped (the controller throws on first unknown enum).
        const bad = await rawList(request, token, '?priority=p1,p9');
        expect(bad.status(), `bad-priority body=${await bad.text().catch(() => '')}`).toBe(400);
        const badBody = await bad.json();
        expect(badBody.message).toMatch(/invalid priority filter/i);
        expect(badBody.message).toContain('p9');
        expect(badBody.statusCode).toBe(400);

        // The rejected request did not mutate anything: the full set is still 5,
        // and a valid filter still works (proving the 400 was the parse guard, not state).
        expect((await listTasks(request, token, '?limit=50')).meta.total).toBe(5);
    });

    test('label lifecycle via PATCH: add → exact-token match (lbl ≠ lbl0) → replace → clear; a shared label matches every carrier', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const shared = `team-${stamp}`;

        // Three tasks all carrying the SHARED label; two also carry a distinct one.
        const a = await seedTask(request, token, {
            title: `Label A ${stamp}`,
            labels: [shared, 'lbl0'],
        });
        const b = await seedTask(request, token, {
            title: `Label B ${stamp}`,
            labels: [shared, 'lbl1'],
        });
        const c = await seedTask(request, token, { title: `Label C ${stamp}`, labels: [shared] });

        // The shared label matches all three carriers.
        expect((await listTasks(request, token, `?label=${shared}`)).meta.total).toBe(3);
        // A distinct label isolates its single carrier.
        expect((await listTasks(request, token, '?label=lbl0')).meta.total).toBe(1);
        expect((await listTasks(request, token, '?label=lbl1')).meta.total).toBe(1);

        // EXACT-TOKEN boundary: `?label=lbl` must NOT match `lbl0`/`lbl1`. The
        // repo wraps the needle in quotes (`%"lbl"%`) so prefixes don't leak.
        expect(
            (await listTasks(request, token, '?label=lbl')).meta.total,
            '?label=lbl is a token, not a prefix — 0 matches',
        ).toBe(0);

        // PATCH labels is REPLACE-not-merge: swap a's labels for a brand-new set.
        const newLabel = `migrated-${stamp}`;
        const patched = await patchTask(request, token, a.id, { labels: [newLabel] });
        expect(patched.labels).toEqual([newLabel]);
        // a no longer carries lbl0 OR the shared label — only the new one.
        expect((await listTasks(request, token, '?label=lbl0')).meta.total).toBe(0);
        expect(
            (await listTasks(request, token, `?label=${shared}`)).meta.total,
            'a left the team',
        ).toBe(2);
        expect((await listTasks(request, token, `?label=${newLabel}`)).meta.total).toBe(1);

        // Clearing with labels:[] removes ALL labels → the row matches no ?label= query.
        const cleared = await patchTask(request, token, b.id, { labels: [] });
        expect(cleared.labels).toEqual([]);
        expect((await listTasks(request, token, '?label=lbl1')).meta.total).toBe(0);
        expect(
            (await listTasks(request, token, `?label=${shared}`)).meta.total,
            'b also left the team when cleared',
        ).toBe(1);
        // c is the lone remaining shared-label carrier.
        const remaining = await listTasks(request, token, `?label=${shared}`);
        expect(idsOf(remaining.data)).toEqual([c.id]);

        // Empty `label=` is falsy → the filter is skipped, so it returns everything (3).
        expect((await listTasks(request, token, '?label=')).meta.total).toBe(3);
    });

    test('default sort is updatedAt DESC, and a mutation (PATCH then transition) floats the touched row to the head of the list', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        // Create three tasks in order. updatedAt has only SECOND granularity on the
        // sqlite CI driver, so a same-second burst gives all three an IDENTICAL
        // updatedAt — the updatedAt-DESC sort then ties and sqlite breaks the tie by
        // insertion order, NOT newest-created-first. So at birth we only pin the
        // deterministic invariant (the exact three rows are present, no more no less);
        // the head-of-list ORDER is meaningless until a mutation bumps updatedAt below.
        const first = await seedTask(request, token, { title: `Sort first ${stamp}` });
        const second = await seedTask(request, token, { title: `Sort second ${stamp}` });
        const third = await seedTask(request, token, { title: `Sort third ${stamp}` });

        const initial = await listTasks(request, token, '?limit=50');
        expect([...idsOf(initial.data)].sort(), 'all three present at birth').toEqual(
            [first.id, second.id, third.id].sort(),
        );

        // Touch the OLDEST (first) via PATCH — updatedAt bumps → it must float to head.
        // Cross a whole-second boundary first so first.updatedAt is STRICTLY greater
        // than the create-burst's (sqlite second-granularity); expect.poll then absorbs
        // any residual lag while the write lands.
        await waitForNextSecond();
        await patchTask(request, token, first.id, { priority: 'p0' });
        await expect
            .poll(async () => idsOf((await listTasks(request, token, '?limit=50')).data)[0], {
                timeout: T,
                message: 'PATCHed task did not float to the head of the updatedAt-DESC list',
            })
            .toBe(first.id);

        // Now touch `second` via a TRANSITION (backlog → todo). A transition also
        // writes the row, so it likewise floats to the head over the PATCHed `first` —
        // but ONLY if second.updatedAt is strictly later than first's. Without the
        // boundary the PATCH above and this transition can share a second, tie on
        // updatedAt, and sqlite's rowid tie-break floats the EARLIER-created `first`
        // to the head instead (the residual flake this fixes). Cross the boundary so
        // the transition is unambiguously the newest touch.
        await waitForNextSecond();
        await transitionTaskViaAPI(request, token, second.id, 'todo');
        await expect
            .poll(async () => idsOf((await listTasks(request, token, '?limit=50')).data)[0], {
                timeout: T,
                message: 'transitioned task did not float to the head',
            })
            .toBe(second.id);

        // Full order is now [second (latest touch), first (earlier touch), third (untouched)].
        const reordered = await listTasks(request, token, '?limit=50');
        expect(idsOf(reordered.data)).toEqual([second.id, first.id, third.id]);
        // Sorting is a pure re-order — the total is unchanged by the mutations.
        expect(reordered.meta.total).toBe(3);
    });

    test('pagination meta windows: exhaust the full set in limit-sized pages with no gaps/overlap, offset-past-end yields an empty window, and every clamp holds', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        // Seed 7 tasks → a non-multiple-of-page count exercises the ragged last page.
        const TOTAL = 7;
        const seeded: string[] = [];
        for (let i = 0; i < TOTAL; i++) {
            const t = await seedTask(request, token, { title: `Page ${i} ${stamp}` });
            seeded.push(t.id);
        }

        // Walk the whole list in pages of 3: offsets 0,3,6 → sizes 3,3,1.
        const limit = 3;
        const seen: string[] = [];
        for (let offset = 0; offset < TOTAL; offset += limit) {
            const page = await listTasks(request, token, `?limit=${limit}&offset=${offset}`);
            // meta echoes the requested window + the stable full-set total.
            expect(page.meta).toMatchObject({ total: TOTAL, limit, offset });
            const expectedLen = Math.min(limit, TOTAL - offset);
            expect(page.data.length, `page@${offset} size`).toBe(expectedLen);
            seen.push(...idsOf(page.data));
        }
        // Exhaustion invariant: the concatenated pages cover EVERY id exactly once
        // (no gaps, no overlap) — the windows partition the set.
        expect(seen.length).toBe(TOTAL);
        expect(new Set(seen).size, 'no duplicate id across pages').toBe(TOTAL);
        expect(new Set(seen)).toEqual(new Set(seeded));

        // Offset PAST the end → empty data[] but meta.total is still the full count.
        const beyond = await listTasks(request, token, `?limit=3&offset=${TOTAL + 50}`);
        expect(beyond.data.length).toBe(0);
        expect(beyond.meta).toMatchObject({ total: TOTAL, limit: 3, offset: TOTAL + 50 });

        // ── Clamp matrix (probed exactly against the live controller) ──────────
        // limit > 200 caps at 200.
        expect((await listTasks(request, token, '?limit=9999')).meta.limit).toBe(200);
        // fractional limit is parseInt-floored (2.9 → 2).
        expect((await listTasks(request, token, '?limit=2.9')).meta.limit).toBe(2);
        // garbage / zero limit both fall back to the default 50.
        expect((await listTasks(request, token, '?limit=abc')).meta.limit).toBe(50);
        expect((await listTasks(request, token, '?limit=0')).meta.limit).toBe(50);
        // missing limit defaults to 50.
        expect((await listTasks(request, token, '')).meta.limit).toBe(50);
        // negative / garbage offset clamps to 0.
        expect((await listTasks(request, token, '?offset=-5')).meta.offset).toBe(0);
        expect((await listTasks(request, token, '?offset=abc')).meta.offset).toBe(0);
        // A garbage limit still returns a well-formed page (never a 5xx).
        const garbage = await rawList(request, token, '?limit=abc&offset=xyz');
        expect(garbage.status()).toBe(200);
    });

    test('multi-axis intersection: status × priority × label × search compose with AND-narrowing, and a foreign user’s tasks never leak into the count', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const tag = `q-${stamp}`;

        // A small matrix engineered so each added axis strictly narrows the result.
        //   target  : priority p0, label `tag`, title contains 'widget', → todo
        //   decoyP  : priority p1, label `tag`, title 'widget'           → todo   (fails priority)
        //   decoyL  : priority p0, NO `tag`,    title 'widget'           → todo   (fails label)
        //   decoyS  : priority p0, label `tag`, title 'gadget'           → todo   (fails search)
        //   decoySt : priority p0, label `tag`, title 'widget'           → backlog(fails status)
        const target = await seedTask(request, token, {
            title: `Target widget ${stamp}`,
            priority: 'p0',
            labels: [tag],
        });
        const decoyP = await seedTask(request, token, {
            title: `DecoyP widget ${stamp}`,
            priority: 'p1',
            labels: [tag],
        });
        const decoyL = await seedTask(request, token, {
            title: `DecoyL widget ${stamp}`,
            priority: 'p0',
            labels: [`other-${stamp}`],
        });
        const decoyS = await seedTask(request, token, {
            title: `DecoyS gadget ${stamp}`,
            priority: 'p0',
            labels: [tag],
        });
        // decoySt stays at backlog (the status axis filters it out); we never need
        // its id, only its presence in the table, so it is intentionally unbound.
        await seedTask(request, token, {
            title: `DecoySt widget ${stamp}`,
            priority: 'p0',
            labels: [tag],
        });

        // Move four of the five to `todo`; leave decoySt at backlog (the status axis).
        for (const t of [target, decoyP, decoyL, decoyS]) {
            await transitionTaskViaAPI(request, token, t.id, 'todo');
        }

        // Progressive narrowing — each clause peels off exactly one decoy.
        const byStatus = await listTasks(request, token, '?status=todo');
        expect(byStatus.meta.total, 'status=todo drops the backlog decoy').toBe(4);

        const byStatusPrio = await listTasks(request, token, '?status=todo&priority=p0');
        expect(byStatusPrio.meta.total, '+priority=p0 drops decoyP').toBe(3);

        const byStatusPrioLabel = await listTasks(
            request,
            token,
            `?status=todo&priority=p0&label=${tag}`,
        );
        expect(byStatusPrioLabel.meta.total, '+label drops decoyL').toBe(2);

        const full = await listTasks(
            request,
            token,
            `?status=todo&priority=p0&label=${tag}&search=widget`,
        );
        expect(full.meta.total, 'all four clauses AND to the single target').toBe(1);
        expect(idsOf(full.data)).toEqual([target.id]);

        // A foreign user with an identically-shaped task contributes ZERO to the
        // count — list is hard-scoped to WHERE task.userId.
        const other = await registerUserViaAPI(request);
        await seedTask(request, other.access_token, {
            title: `Target widget ${stamp}`,
            priority: 'p0',
            labels: [tag],
        });
        await transitionTaskViaAPI(
            request,
            other.access_token,
            (await listTasks(request, other.access_token, '?limit=1')).data[0].id,
            'todo',
        );
        // Re-running the original query for our user is unchanged — still exactly target.
        const rerun = await listTasks(
            request,
            token,
            `?status=todo&priority=p0&label=${tag}&search=widget`,
        );
        expect(rerun.meta.total, 'foreign identical task does not leak in').toBe(1);
        expect(idsOf(rerun.data)).toEqual([target.id]);
        // And the foreign user sees ONLY their own one row.
        expect((await listTasks(request, other.access_token, '?limit=50')).meta.total).toBe(1);
    });

    test('full-text search matches title OR slug OR description; the un-escaped `%` is a LIKE wildcard; empty search is ignored; no-match returns an empty window with the right meta', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const needle = `xyz${stamp}`;

        // Three tasks each hit the needle through a DIFFERENT column.
        const byTitle = await seedTask(request, token, { title: `Has ${needle} in title` });
        const byDesc = await seedTask(request, token, {
            title: 'plain title',
            description: `desc mentions ${needle} here`,
        });
        // A throwaway whose slug we then search for (slug is the third OR-branch).
        const bySlug = await seedTask(request, token, { title: 'slug carrier' });
        // One control task that the needle must NEVER match.
        const control = await seedTask(request, token, {
            title: 'unrelated',
            description: 'nothing here',
        });

        // search hits title OR description.
        const hits = await listTasks(request, token, `?search=${encodeURIComponent(needle)}`);
        expect(hits.meta.total, 'title + description matches').toBe(2);
        expect(new Set(idsOf(hits.data))).toEqual(new Set([byTitle.id, byDesc.id]));
        expect(idsOf(hits.data)).not.toContain(control.id);

        // search hits SLUG: `T-<n>` is matchable verbatim (third OR-branch).
        const slugQ = await listTasks(request, token, `?search=${encodeURIComponent(bySlug.slug)}`);
        expect(slugQ.meta.total, 'slug branch of the search OR').toBeGreaterThanOrEqual(1);
        expect(idsOf(slugQ.data)).toContain(bySlug.id);

        // The `%` is NOT escaped before being wrapped in `%...%`, so search=%
        // degrades to the LIKE wildcard `%%%` and matches EVERY row (all 4 here).
        const wildcard = await listTasks(request, token, '?search=%25');
        expect(wildcard.meta.total, 'un-escaped % is a LIKE wildcard → matches all').toBe(4);

        // Empty `search=` is falsy → the clause is skipped → unfiltered (all 4).
        expect((await listTasks(request, token, '?search=')).meta.total).toBe(4);

        // A genuine no-match → empty data[] with a correct meta (total 0, echoed window).
        const miss = await listTasks(request, token, '?search=definitelynothingmatches&limit=10');
        expect(miss.data.length).toBe(0);
        expect(miss.meta).toMatchObject({ total: 0, limit: 10, offset: 0 });

        // Search composes with pagination: matching set of 2, page of 1 → meta.total
        // reports the MATCH count (2), not the table count, and the windows are disjoint.
        const p1 = await listTasks(
            request,
            token,
            `?search=${encodeURIComponent(needle)}&limit=1&offset=0`,
        );
        const p2 = await listTasks(
            request,
            token,
            `?search=${encodeURIComponent(needle)}&limit=1&offset=1`,
        );
        expect(p1.meta.total).toBe(2);
        expect(p2.meta.total).toBe(2);
        expect(p1.data.length).toBe(1);
        expect(p2.data.length).toBe(1);
        expect(p1.data[0].id).not.toBe(p2.data[0].id);
        expect(new Set([p1.data[0].id, p2.data[0].id])).toEqual(new Set([byTitle.id, byDesc.id]));
    });
});
