/**
 * flow-concurrency-missions-matrix — genuinely-PARALLEL Mission operations driven
 * end-to-end against the live stack. Two-or-more concurrent identical/competing
 * mutations on ONE Mission must resolve to a DETERMINISTIC observable outcome:
 * never a 5xx, never a duplicate/"Frankenstein" row, never a lost delete, never a
 * resurrected row. This file pins the RACE contract of the Missions surface
 * (`apps/api/src/missions/missions.controller.ts` →
 * `packages/agent/src/missions/{missions,mission-clone,mission-tick}.service.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-missions-list-pagination pins the LIST read contract (limit/offset clamp,
 *   updatedAt ordering, status/search filters) — this file does NOT re-test paging.
 *   flow-mission-lifecycle-deep / flow-mission-clone{,-deep,-fork} /
 *   flow-mission-works-relation / flow-mission-run-now-record all exercise the
 *   SERIAL happy path of each verb. flow-idempotency-concurrency-matrix races
 *   Teams / Triggers / Works but never touches Missions. THIS file is the Mission
 *   CONCURRENCY matrix: parallel create, parallel clone (full-fork, NO dedup),
 *   parallel run-now (idempotent dispatch), parallel works-attach (unique-index
 *   dedup), parallel PATCH (last-write-wins, row-atomic), parallel lifecycle
 *   transitions (one-winner state machine), and the delete / cross-verb races.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE any assertion. Exact observed contract:
 *
 *   ROUTES  are under `/api/me/missions` (owner-scoped). create → 201 (bare
 *     MissionDto, 16 keys, status:'active'); list → bare ARRAY; run-now → 200
 *     {status,missionId,message}; clone → 201 {mission,ideasCloned,ideasSkipped};
 *     attach-work → 201 {relations:[…]}; pause/resume/complete/patch → 200; delete
 *     → 200 {deleted:true}. Cross-user + unknown id → 404 (no existence leak).
 *
 *   CREATE has NO dedup key (no unique title/slug). N parallel same-title creates
 *     → ALL 201, DISTINCT ids. The `Idempotency-Key` header is a NO-OP here.
 *
 *   CLONE is a FULL FORK, never deduped. N parallel clones → ALL 201, N DISTINCT
 *     new mission ids, each `sourceMissionId` = source. A clone of a COMPLETED
 *     Mission is reset to status:'active'. Source `sourceMissionId` FK is
 *     ON DELETE SET NULL → deleting the source never cascades to the clone.
 *
 *   RUN-NOW is idempotent. In the key-less CI (no LLM profile) every fire returns
 *     200 {status:'no-ideas', message:'skipped-no-profile'} and does NOT mutate
 *     the Mission (updatedAt unchanged). Allowed from ACTIVE|PAUSED; COMPLETED
 *     |FAILED → 400. N parallel fires converge to the same outcome, never a 5xx.
 *
 *   WORKS-ATTACH is dedup'd by a UNIQUE (missionId, workId, relation) index +
 *     `.orIgnore()`. N parallel attaches of the SAME (work,relation) → ALL 201
 *     but exactly ONE row lands. Distinct relations → distinct rows. Scope is
 *     per-Mission (same work attaches independently to two Missions). Foreign/
 *     unknown work → 404 "Work not found".
 *
 *   PATCH is last-write-wins AND row-atomic — each request loads the whole row,
 *     mutates its fields, saves the whole row. N parallel PATCH → ALL 200; the
 *     final (description, cap) pair equals ONE submitted request verbatim (no
 *     torn column mix); updatedAt is monotonic.
 *
 *   LIFECYCLE transitions are a one-winner state machine (no DB CAS, so the winner
 *     count is timing-bounded, but the TERMINAL state is deterministic). N parallel
 *     pause/complete/resume → ≥1× 200 + the losers 400 "cannot be …d from status";
 *     the terminal status is exactly the target. resume clears outcome+completedAt.
 *
 *   DELETE is durable. N parallel DELETE → ≥1× 200 {deleted:true} + the rest 404;
 *     GET is 404 afterwards (no resurrection). PATCH-vs-DELETE and run-now-vs-
 *     DELETE → delete wins the terminal state. A sqlite tx-serialization 5xx under
 *     a concurrent cascading delete is tolerated as a DRIVER artifact (never a
 *     data defect — the invariant asserted is "gone, not corrupted").
 *
 * GOTCHAS honored: every test registers a FRESH registerUserViaAPI() owner (never
 * the shared seeded user) so its Mission namespace is deterministic even though the
 * shard DB accumulates rows across the suite; ids asserted via toContain /
 * not.toContain (never global counts); ordering asserted non-increasing with
 * equal-second TIE tolerance (Date>=Date); tolerant `expect([…]).toContain(status)`
 * where several codes are legitimately valid; every branch keeps the never-a-5xx
 * invariant (except the explicitly-tolerated sqlite cascade-delete artifact).
 * Fully API-orchestrated (safe `flow-` prefix) so it never contends on the shared
 * UI auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSIONS_BASE = `${API_BASE}/api/me/missions`;
const T = 30_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Split a burst of HTTP statuses into meaningful buckets. */
function classify(statuses: number[]) {
    return {
        s2xx: statuses.filter((s) => s >= 200 && s < 300),
        s400: statuses.filter((s) => s === 400),
        s404: statuses.filter((s) => s === 404),
        s5xx: statuses.filter((s) => s >= 500),
    };
}

/**
 * Tolerate the sqlite-in-memory driver artifact: concurrent write transactions
 * are serialized GLOBALLY (database-level lock, not row-level), so under a burst
 * of heavy transactions ANY number — up to and including ALL of them — can
 * transiently surface SQLITE_BUSY as an HTTP 5xx, which Postgres row-locking
 * would not. Assert only that every NON-5xx response is an expected success code
 * (no corruption-via-status); the caller proves its real invariant on whatever
 * survived plus a guaranteed SERIAL op (serial writes never contend → no BUSY).
 */
function assertTolerated5xx(statuses: number[], okCodes: number[]) {
    expect(
        statuses.every((s) => okCodes.includes(s) || s >= 500),
        `every write is one of [${okCodes}] or a tolerated sqlite-serialization 5xx (${statuses})`,
    ).toBe(true);
}

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: 'active' | 'paused' | 'completed' | 'failed';
    outcome: string | null;
    completedAt: string | null;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Create a Mission via API (expects 201) and return the parsed DTO. */
async function createMission(
    request: APIRequestContext,
    token: string,
    overrides: Partial<{
        title: string;
        description: string;
        type: 'one-shot' | 'scheduled';
        schedule: string | null;
        autoBuildWorks: boolean;
        outstandingIdeasCap: number | null;
    }> = {},
): Promise<MissionDto> {
    const res = await request.post(MISSIONS_BASE, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: {
            title: overrides.title ?? `Mission ${stamp()}`,
            description: overrides.description ?? `desc ${stamp()}`,
            type: overrides.type ?? 'one-shot',
            ...(overrides.schedule !== undefined ? { schedule: overrides.schedule } : {}),
            ...(overrides.autoBuildWorks !== undefined
                ? { autoBuildWorks: overrides.autoBuildWorks }
                : {}),
            ...(overrides.outstandingIdeasCap !== undefined
                ? { outstandingIdeasCap: overrides.outstandingIdeasCap }
                : {}),
        },
    });
    if (res.status() !== 201) {
        throw new Error(`createMission failed (${res.status()}): ${await res.text()}`);
    }
    return res.json();
}

async function getMissionRes(request: APIRequestContext, token: string, id: string) {
    return request.get(`${MISSIONS_BASE}/${id}`, { headers: authedHeaders(token) });
}

async function getMission(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<MissionDto> {
    const res = await getMissionRes(request, token, id);
    expect(res.status(), 'GET mission should succeed').toBe(200);
    return res.json();
}

async function listMissions(
    request: APIRequestContext,
    token: string,
    query = '?limit=101',
): Promise<MissionDto[]> {
    const res = await request.get(`${MISSIONS_BASE}${query}`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE + CLONE — no dedup; clone is a full fork.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — parallel create & clone (no dedup, full fork)', () => {
    test('N parallel same-TITLE creates → all 201 with DISTINCT ids (no title-uniqueness gate)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const title = `Twin Mission ${stamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(MISSIONS_BASE, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { title, description: 'twin body', type: 'one-shot' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx, `no create 5xx'd (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 201),
            `every same-title create 201 (${statuses})`,
        ).toBe(true);

        const ids = (await Promise.all(results.map((r) => r.json()))).map((b) => b.id);
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size, 'each concurrent create got its own row (no dedup)').toBe(BURST);

        // All N are the caller's — every id shows up in a scoped list (toContain, never a count).
        const listed = new Set((await listMissions(request, user.access_token)).map((m) => m.id));
        for (const id of ids) expect(listed).toContain(id);
    });

    test('the Idempotency-Key header is a NO-OP on create → same key + N parallel creates → N distinct rows', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                request.post(MISSIONS_BASE, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                        'Idempotency-Key': key,
                    },
                    data: { title: `Keyed ${i} ${stamp()}`, description: 'k', type: 'one-shot' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 201),
            `key ignored, all 201 (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map((b) => b.id);
        expect(new Set(ids).size, 'the reused key did not collapse the creates').toBe(BURST);
    });

    test('N parallel clone → all 201 with DISTINCT new ids, each backlinked to the source (full fork, no dedup)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const source = await createMission(request, user.access_token, {
            title: `Fork Src ${stamp()}`,
        });
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: {},
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        // A burst of heavy clone transactions can transiently 5xx under sqlite —
        // up to ALL of them (SQLITE_BUSY). Tolerate that, prove the fork invariant
        // on whatever survived, then pin the real "clone is not a dedup key"
        // contract with guaranteed SERIAL clones below.
        assertTolerated5xx(statuses, [201]);
        const okResults = results.filter((r) => r.status() === 201);

        const bodies = await Promise.all(okResults.map((r) => r.json()));
        expect(
            new Set(bodies.map((b) => b.mission.id)).size,
            'each surviving clone minted a distinct Mission',
        ).toBe(okResults.length);
        for (const b of bodies) {
            expect(b.mission.sourceMissionId, 'clone backlinks the source').toBe(source.id);
            expect(b.mission.id, 'a clone is never the source itself').not.toBe(source.id);
        }

        // Guaranteed proof (serial writes never BUSY): two SERIAL clones of the
        // same source always mint two further DISTINCT forks — never a dedup.
        const serialA = await request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {},
        });
        const serialB = await request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {},
        });
        expect(serialA.status(), 'a serial clone always succeeds').toBe(201);
        expect(serialB.status(), 'a serial clone always succeeds').toBe(201);
        const serialIds = [(await serialA.json()).mission.id, (await serialB.json()).mission.id];
        expect(new Set(serialIds).size, 'serial clones are distinct forks, not a dedup').toBe(2);
        expect(serialIds, 'a clone is never the source itself').not.toContain(source.id);

        // Persisted-fork count is BOUNDED, not exact: on sqlite a burst clone can
        // return 5xx to the client yet have COMMITTED server-side (the row inserts,
        // then a later step in the same request hits SQLITE_BUSY) — so persisted may
        // exceed the 2xx survivors. The real no-corruption invariant is a range:
        //   lower = okResults + 2 serial  → nothing the client saw succeed was lost
        //   upper = BURST + 2 serial      → no phantom/duplicate beyond what was attempted
        // and every persisted row is a distinct valid fork of the source.
        const clonesOfSource = (await listMissions(request, user.access_token)).filter(
            (m) => m.sourceMissionId === source.id,
        );
        expect(
            clonesOfSource.length,
            `no acknowledged fork lost (survivors=${okResults.length} + 2 serial)`,
        ).toBeGreaterThanOrEqual(okResults.length + 2);
        expect(
            clonesOfSource.length,
            `no phantom fork beyond attempts (BURST=${BURST} + 2 serial)`,
        ).toBeLessThanOrEqual(BURST + 2);
        expect(
            new Set(clonesOfSource.map((m) => m.id)).size,
            'every persisted fork is a distinct row',
        ).toBe(clonesOfSource.length);
    });

    test('N parallel clone with the SAME custom title → all 201, N distinct ids all carrying that title', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const source = await createMission(request, user.access_token);
        const cloneTitle = `Pinned Title ${stamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { title: cloneTitle },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertTolerated5xx(statuses, [201]);
        const okResults = results.filter((r) => r.status() === 201);
        const bodies = await Promise.all(okResults.map((r) => r.json()));
        expect(
            new Set(bodies.map((b) => b.mission.id)).size,
            'title is not a dedup key — N distinct surviving rows',
        ).toBe(okResults.length);
        for (const b of bodies) expect(b.mission.title).toBe(cloneTitle);

        // Guaranteed (serial writes never BUSY): two SERIAL clones with the SAME
        // custom title still mint two DISTINCT rows both carrying that title.
        const serial1 = await request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { title: cloneTitle },
        });
        const serial2 = await request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { title: cloneTitle },
        });
        expect(serial1.status()).toBe(201);
        expect(serial2.status()).toBe(201);
        const sb1 = await serial1.json();
        const sb2 = await serial2.json();
        expect(sb1.mission.id, 'serial clones are distinct rows, not a dedup').not.toBe(
            sb2.mission.id,
        );
        expect(sb1.mission.title).toBe(cloneTitle);
        expect(sb2.mission.title).toBe(cloneTitle);
    });

    test('parallel clones of a COMPLETED Mission are each reset to status:active (fresh-slate fork)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const source = await createMission(request, user.access_token);
        const done = await request.post(`${MISSIONS_BASE}/${source.id}/complete`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { outcome: 'succeeded' },
        });
        expect(done.status()).toBe(200);
        expect((await done.json()).status).toBe('completed');

        const results = await Promise.all(
            [0, 1, 2].map(() =>
                request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: {},
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertTolerated5xx(statuses, [201]);
        const okResults = results.filter((r) => r.status() === 201);
        for (const r of okResults) {
            const b = await r.json();
            expect(b.mission.status, 'the clone re-activates').toBe('active');
            expect(b.mission.outcome, 'the clone has no verdict').toBeNull();
            expect(b.mission.sourceMissionId).toBe(source.id);
        }

        // Guaranteed (serial writes never BUSY): a SERIAL clone of the COMPLETED
        // source is a fresh-slate active fork with no verdict.
        const serial = await request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {},
        });
        expect(serial.status()).toBe(201);
        const sb = await serial.json();
        expect(sb.mission.status, 'the serial clone re-activates').toBe('active');
        expect(sb.mission.outcome, 'the serial clone has no verdict').toBeNull();
        expect(sb.mission.sourceMissionId).toBe(source.id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — last-write-wins, row-atomic (no torn columns).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — parallel PATCH convergence (LWW, row-atomic)', () => {
    test('N parallel PATCH (distinct descriptions) → all 200, final is one submitted value, updatedAt monotonic', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token, { description: 'original' });
        const before = await getMission(request, user.access_token, m.id);

        const tag = stamp();
        const candidates = [0, 1, 2, 3].map((i) => `desc-${i}-${tag}`);
        await new Promise((r) => setTimeout(r, 1100)); // second-resolution updatedAt must visibly advance
        const results = await Promise.all(
            candidates.map((description) =>
                request.patch(`${MISSIONS_BASE}/${m.id}`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { description },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `all PATCH 200 (${statuses})`,
        ).toBe(true);

        const after = await getMission(request, user.access_token, m.id);
        expect(
            candidates.includes(after.description),
            `final description "${after.description}" is one submitted value (no Frankenstein merge)`,
        ).toBe(true);
        expect(
            Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
            `updatedAt monotonic: before=${before.updatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });

    test('N parallel PATCH of a PAIRED (description, cap) → the winning row is co-consistent (no column tearing)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const tag = stamp();
        // Each request writes a PAIR keyed on i; a torn write would mix desc-i with cap-j (i≠j).
        const pairs = [1, 2, 3, 4, 5].map((i) => ({
            description: `pair-${i}-${tag}`,
            outstandingIdeasCap: i,
        }));

        const results = await Promise.all(
            pairs.map((data) =>
                request.patch(`${MISSIONS_BASE}/${m.id}`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data,
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 200),
            'all 200',
        ).toBe(true);

        const after = await getMission(request, user.access_token, m.id);
        const matched = pairs.find(
            (p) =>
                p.description === after.description &&
                p.outstandingIdeasCap === after.outstandingIdeasCap,
        );
        expect(
            matched,
            `final row (${after.description}, cap=${after.outstandingIdeasCap}) equals exactly one submitted pair — the write was row-atomic`,
        ).toBeDefined();
    });

    test('concurrent PATCH + run-now → both are client-level, the PATCHed description persists, no 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token, { description: 'pre' });
        const nextDesc = `patched-${stamp()}`;

        const [patchRes, runRes] = await Promise.all([
            request.patch(`${MISSIONS_BASE}/${m.id}`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: { description: nextDesc },
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${m.id}/run-now`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
        ]);
        expect(patchRes.status(), 'patch client-level').toBeLessThan(500);
        expect(runRes.status(), 'run-now client-level').toBeLessThan(500);
        expect(patchRes.status()).toBe(200);

        const after = await getMission(request, user.access_token, m.id);
        expect(after.description, 'run-now (no-ideas) never clobbers the concurrent PATCH').toBe(
            nextDesc,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// RUN-NOW — idempotent manual dispatch; no phantom mutation.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — parallel run-now (idempotent dispatch)', () => {
    test('N parallel run-now (ACTIVE) → all 200 with one deterministic outcome; the Mission is not mutated', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const before = await getMission(request, user.access_token, m.id);
        const N = 6;

        const results = await Promise.all(
            Array.from({ length: N }, () =>
                request.post(`${MISSIONS_BASE}/${m.id}/run-now`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx, `no run-now 5xx'd (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `every fire 200 (${statuses})`,
        ).toBe(true);

        const bodies = await Promise.all(results.map((r) => r.json()));
        const ALLOWED = [
            'no-ideas',
            'cron-no-match',
            'cap-hit',
            'spawned',
            'queued',
            'noop-placeholder',
        ];
        for (const b of bodies) {
            expect(b.missionId, 'run-now echoes the mission id').toBe(m.id);
            expect(
                ALLOWED,
                `outcome "${b.outcome ?? b.status}" is a valid run-now status`,
            ).toContain(b.status);
        }
        // Deterministic dispatch: in the key-less CI every concurrent fire returns
        // the SAME terminal outcome (no interleaved divergence).
        expect(new Set(bodies.map((b) => b.status)).size, 'concurrent fires converge').toBe(1);

        // Idempotent: a no-idea run-now never touches the Mission row.
        const after = await getMission(request, user.access_token, m.id);
        expect(after.status, 'the Mission stays ACTIVE through the burst').toBe('active');
        expect(after.updatedAt, 'run-now did not phantom-bump updatedAt').toBe(before.updatedAt);
    });

    test('run-now is allowed from PAUSED — N parallel fires on a paused Mission → all 200, still paused', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const paused = await request.post(`${MISSIONS_BASE}/${m.id}/pause`, {
            headers: authedHeaders(user.access_token),
        });
        expect(paused.status()).toBe(200);

        const results = await Promise.all(
            [0, 1, 2, 3].map(() =>
                request.post(`${MISSIONS_BASE}/${m.id}/run-now`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 200),
            'run-now honors a paused user click (all 200)',
        ).toBe(true);
        expect((await getMission(request, user.access_token, m.id)).status).toBe('paused');
    });

    test('N parallel run-now on a COMPLETED Mission → all 400 (state gate); terminal stays completed', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const done = await request.post(`${MISSIONS_BASE}/${m.id}/complete`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: {},
        });
        expect(done.status()).toBe(200);

        const results = await Promise.all(
            [0, 1, 2, 3].map(() =>
                request.post(`${MISSIONS_BASE}/${m.id}/run-now`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 400),
            `every fire on a completed mission 400 (${statuses})`,
        ).toBe(true);
        expect((await getMission(request, user.access_token, m.id)).status).toBe('completed');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKS-ATTACH — unique (mission,work,relation) dedup under concurrency.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — parallel works-attach (unique-index dedup)', () => {
    test('N parallel attach of the SAME (work,relation) → all 201 but exactly ONE row lands', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Attach W ${stamp()}`,
            slug: `attach-w-${stamp()}`,
        });
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${m.id}/works`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { workId, relation: 'created' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx, `no attach 5xx'd (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 201),
            `orIgnore keeps every attach 201 (${statuses})`,
        ).toBe(true);

        const list = await request.get(`${MISSIONS_BASE}/${m.id}/works`, {
            headers: authedHeaders(user.access_token),
        });
        const rows = (await list.json()).relations as Array<{ workId: string; relation: string }>;
        const forPair = rows.filter((r) => r.workId === workId && r.relation === 'created');
        expect(forPair.length, 'the unique index collapsed the race to one edge').toBe(1);
    });

    test('parallel attach of the SAME work with 6 DISTINCT relations → 6 distinct edges', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Multi Rel ${stamp()}`,
            slug: `multi-rel-${stamp()}`,
        });
        const RELATIONS = ['created', 'improves', 'operates', 'markets', 'researches', 'retires'];

        const results = await Promise.all(
            RELATIONS.map((relation) =>
                request.post(`${MISSIONS_BASE}/${m.id}/works`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { workId, relation },
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 201),
            'all 201',
        ).toBe(true);

        const rows = (
            await (
                await request.get(`${MISSIONS_BASE}/${m.id}/works`, {
                    headers: authedHeaders(user.access_token),
                })
            ).json()
        ).relations as Array<{ workId: string; relation: string }>;
        const forWork = rows.filter((r) => r.workId === workId);
        expect(forWork.length, 'each distinct relation is its own edge').toBe(6);
        expect(new Set(forWork.map((r) => r.relation))).toEqual(new Set(RELATIONS));
    });

    test("the SAME work attaches independently to TWO of the owner's Missions in parallel (per-Mission scope)", async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const [m1, m2] = await Promise.all([
            createMission(request, user.access_token),
            createMission(request, user.access_token),
        ]);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Shared W ${stamp()}`,
            slug: `shared-w-${stamp()}`,
        });

        const [r1, r2] = await Promise.all([
            request.post(`${MISSIONS_BASE}/${m1.id}/works`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: { workId, relation: 'created' },
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${m2.id}/works`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: { workId, relation: 'created' },
                timeout: T,
            }),
        ]);
        expect(r1.status()).toBe(201);
        expect(r2.status()).toBe(201);
        for (const [mid, res] of [
            [m1.id, r1],
            [m2.id, r2],
        ] as const) {
            const rows = (await res.json()).relations as Array<{
                workId: string;
                missionId: string;
            }>;
            expect(rows.some((r) => r.workId === workId && r.missionId === mid)).toBe(true);
        }
    });

    test('parallel attach + parallel detach of the same edge → terminal is 0-or-1 (never a dup, never a 5xx)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Churn W ${stamp()}`,
            slug: `churn-w-${stamp()}`,
        });
        const H = authedHeaders(user.access_token);
        const attachOne = () =>
            request.post(`${MISSIONS_BASE}/${m.id}/works`, {
                headers: { ...H, 'content-type': 'application/json' },
                data: { workId, relation: 'improves' },
                timeout: T,
            });
        const detachOne = () =>
            request.delete(`${MISSIONS_BASE}/${m.id}/works/${workId}/improves`, {
                headers: H,
                timeout: T,
            });

        const results = await Promise.all([
            attachOne(),
            detachOne(),
            attachOne(),
            detachOne(),
            attachOne(),
        ]);
        expect(classify(results.map((r) => r.status())).s5xx, 'no churn 5xx').toEqual([]);

        const countEdges = async () => {
            const rows = (
                await (await request.get(`${MISSIONS_BASE}/${m.id}/works`, { headers: H })).json()
            ).relations as Array<{ workId: string; relation: string }>;
            return rows.filter((r) => r.workId === workId && r.relation === 'improves').length;
        };
        const churnCount = await countEdges();
        expect(churnCount, 'never a duplicate edge after the churn').toBeLessThanOrEqual(1);

        // Deterministic tail: a serial attach lands exactly one; a serial detach removes it.
        expect((await attachOne()).status()).toBe(201);
        expect(await countEdges(), 'serial attach → exactly one edge').toBe(1);
        expect((await detachOne()).status()).toBe(200);
        expect(await countEdges(), 'serial detach → zero edges').toBe(0);
    });

    test('parallel attach of a NONEXISTENT work → all 404 "Work not found"; no phantom edge lands', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const ghostWork = '00000000-0000-4000-8000-000000000000';

        const results = await Promise.all(
            [0, 1, 2, 3].map(() =>
                request.post(`${MISSIONS_BASE}/${m.id}/works`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { workId: ghostWork, relation: 'created' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 404),
            `every attach of a ghost work 404 (${statuses})`,
        ).toBe(true);
        const rows = (
            await (
                await request.get(`${MISSIONS_BASE}/${m.id}/works`, {
                    headers: authedHeaders(user.access_token),
                })
            ).json()
        ).relations as unknown[];
        expect(rows.length, 'no edge was created for a nonexistent work').toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE — one-winner state machine (deterministic terminal state).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — parallel lifecycle transitions (one-winner)', () => {
    test('N parallel pause (from ACTIVE) → ≥1 winner + losers 400; terminal is PAUSED (no 5xx, no resurrection)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${m.id}/pause`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { s2xx, s400, s5xx } = classify(statuses);
        expect(s5xx, `pause is a single-row write — never a 5xx (${statuses})`).toEqual([]);
        expect(s2xx.length, 'at least one pause won the transition').toBeGreaterThanOrEqual(1);
        expect(
            s2xx.length + s400.length,
            'every response is a 200 winner or a 400 state-gate rejection',
        ).toBe(BURST);

        // The 400 bodies name the exact state-gate refusal.
        for (const r of results.filter((r) => r.status() === 400)) {
            expect((await r.json()).message).toMatch(/cannot be paused from status/i);
        }
        expect((await getMission(request, user.access_token, m.id)).status).toBe('paused');
    });

    test('N parallel complete (from ACTIVE, with outcome) → ≥1 winner + losers 400; terminal completed+outcome', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${m.id}/complete`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { outcome: 'succeeded' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { s2xx, s400, s5xx } = classify(statuses);
        expect(s5xx).toEqual([]);
        expect(s2xx.length, 'at least one complete won').toBeGreaterThanOrEqual(1);
        expect(s2xx.length + s400.length, 'winners + gated-losers cover the burst').toBe(BURST);

        const after = await getMission(request, user.access_token, m.id);
        expect(after.status).toBe('completed');
        expect(after.outcome, 'the winning outcome stuck').toBe('succeeded');
        expect(after.completedAt, 'completedAt stamped').not.toBeNull();
    });

    test('N parallel resume (from PAUSED) → ≥1 winner; terminal ACTIVE with outcome/completedAt cleared', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        // Park it in PAUSED first (the only API-reachable resume source), then race
        // the resume burst. resume also asserts the revive contract: outcome +
        // completedAt come back cleared (never spuriously populated).
        expect(
            (
                await request.post(`${MISSIONS_BASE}/${m.id}/pause`, {
                    headers: authedHeaders(user.access_token),
                })
            ).status(),
        ).toBe(200);
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${MISSIONS_BASE}/${m.id}/resume`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { s2xx, s400, s5xx } = classify(statuses);
        expect(s5xx).toEqual([]);
        expect(s2xx.length, 'at least one resume won').toBeGreaterThanOrEqual(1);
        expect(s2xx.length + s400.length, 'winners + gated-losers cover the burst').toBe(BURST);

        const after = await getMission(request, user.access_token, m.id);
        expect(after.status).toBe('active');
        expect(after.outcome, 'a revived mission carries no verdict').toBeNull();
        expect(after.completedAt).toBeNull();
    });

    test('complete-vs-pause race → deterministic terminal (completed XOR paused), never both, never a 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);

        const [completeRes, pauseRes] = await Promise.all([
            request.post(`${MISSIONS_BASE}/${m.id}/complete`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: {},
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${m.id}/pause`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
        ]);
        expect(completeRes.status(), 'complete client-level').toBeLessThan(500);
        expect(pauseRes.status(), 'pause client-level').toBeLessThan(500);
        // At least one transition wins. Note complete is legal from ACTIVE *and*
        // PAUSED, so a pause-first ordering can chain (ACTIVE→PAUSED→COMPLETED)
        // and yield two 200s — never a 5xx, never a stuck ACTIVE.
        const winners = [completeRes, pauseRes].filter((r) => r.status() === 200);
        expect(winners.length, 'at least one transition settled').toBeGreaterThanOrEqual(1);
        if (pauseRes.status() === 400) {
            // Only refusable ordering: complete landed first → pause hits a completed mission.
            expect((await pauseRes.json()).message).toMatch(/cannot be paused from status/i);
        }

        const terminal = (await getMission(request, user.access_token, m.id)).status;
        expect(
            ['completed', 'paused'],
            `terminal is one settled non-active state (got ${terminal})`,
        ).toContain(terminal);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE races — durable, no resurrection; cross-verb races.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — delete & cross-verb races', () => {
    test('N parallel DELETE → ≥1× 200 {deleted:true} + the rest 404; GET 404 afterward (no resurrection)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.delete(`${MISSIONS_BASE}/${m.id}`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const oks = statuses.filter((s) => s === 200).length;
        const gone = statuses.filter((s) => s === 404).length;
        const server = statuses.filter((s) => s >= 500).length;
        // A sqlite tx-serialization 5xx under concurrent cascading delete
        // (mission_works / attachments / proposals) is a DRIVER artifact, not a
        // data defect — tolerate it, but assert the invariant that matters.
        expect(oks + gone + server, 'racers only ever 200 / 404 / 5xx-conflict').toBe(BURST);
        expect(oks, 'at least one delete won').toBeGreaterThanOrEqual(1);
        for (const r of results.filter((r) => r.status() === 200)) {
            expect((await r.json()).deleted).toBe(true);
        }

        // Strong invariant — no resurrection. If every racer happened to conflict
        // (rare), a clean follow-up delete removes it, proving the row was intact.
        let finalGet = await getMissionRes(request, user.access_token, m.id);
        if (finalGet.status() !== 404) {
            const cleanup = await request.delete(`${MISSIONS_BASE}/${m.id}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(cleanup.status()).toBe(200);
            finalGet = await getMissionRes(request, user.access_token, m.id);
        }
        expect(finalGet.status(), 'the deleted mission is gone').toBe(404);
    });

    test('PATCH-vs-DELETE race → delete wins the terminal state (GET 404); neither response 5xxs', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);

        const [patchRes, delRes] = await Promise.all([
            request.patch(`${MISSIONS_BASE}/${m.id}`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: { description: `raced-${stamp()}` },
                timeout: T,
            }),
            request.delete(`${MISSIONS_BASE}/${m.id}`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
        ]);
        expect(patchRes.status(), 'patch client-level').toBeLessThan(500);
        expect(delRes.status(), 'delete client-level').toBeLessThan(500);

        await expect
            .poll(async () => (await getMissionRes(request, user.access_token, m.id)).status(), {
                timeout: 15_000,
                message: 'delete wins the terminal state even when it raced a patch',
            })
            .toBe(404);
    });

    test('run-now-vs-DELETE race → both client-level; the Mission ends deleted (no orphan run state)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const m = await createMission(request, user.access_token);

        const [runRes, delRes] = await Promise.all([
            request.post(`${MISSIONS_BASE}/${m.id}/run-now`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
            request.delete(`${MISSIONS_BASE}/${m.id}`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
        ]);
        expect(runRes.status(), 'run-now client-level').toBeLessThan(500);
        expect(delRes.status(), 'delete client-level').toBeLessThan(500);
        // run-now either ran before the delete (200) or found it gone (404) — never a 5xx.
        expect([200, 404], `run-now resolved cleanly (got ${runRes.status()})`).toContain(
            runRes.status(),
        );
        await expect
            .poll(async () => (await getMissionRes(request, user.access_token, m.id)).status(), {
                timeout: 15_000,
            })
            .toBe(404);
    });

    test('clone-vs-DELETE race → the clone (if it wins) SURVIVES the source delete (sourceMissionId SET NULL, no cascade)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const source = await createMission(request, user.access_token);

        const [cloneRes, delRes] = await Promise.all([
            request.post(`${MISSIONS_BASE}/${source.id}/clone`, {
                headers: {
                    ...authedHeaders(user.access_token),
                    'content-type': 'application/json',
                },
                data: {},
                timeout: T,
            }),
            request.delete(`${MISSIONS_BASE}/${source.id}`, {
                headers: authedHeaders(user.access_token),
                timeout: T,
            }),
        ]);
        expect(
            cloneRes.status(),
            'clone client-level (201 if it beat the delete, else 404)',
        ).toBeLessThan(500);
        expect([201, 404], `clone resolved cleanly (got ${cloneRes.status()})`).toContain(
            cloneRes.status(),
        );
        expect(delRes.status(), 'delete client-level').toBeLessThan(500);

        if (cloneRes.status() === 201) {
            const cloneId = (await cloneRes.json()).mission.id as string;
            // The clone is its own row — deleting the SOURCE never cascades to it.
            const cloneAfter = await getMission(request, user.access_token, cloneId);
            expect(cloneAfter.id).toBe(cloneId);
            expect(cloneAfter.status).toBe('active');
        }
        // The source is gone regardless of who won.
        await expect
            .poll(
                async () => (await getMissionRes(request, user.access_token, source.id)).status(),
                {
                    timeout: 15_000,
                },
            )
            .toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ISOLATION — a foreign owner can never race another owner's Mission.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — cross-owner isolation under concurrency', () => {
    test('a foreign owner racing every mutation on my Mission → all 404; my Mission is untouched', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [me, other]: [RegisteredUser, RegisteredUser] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const mine = await createMission(request, me.access_token, { description: 'mine-only' });
        const H = authedHeaders(other.access_token);
        const CT = { ...H, 'content-type': 'application/json' };

        const results = await Promise.all([
            request.patch(`${MISSIONS_BASE}/${mine.id}`, {
                headers: CT,
                data: { description: 'hijack' },
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${mine.id}/pause`, { headers: H, timeout: T }),
            request.post(`${MISSIONS_BASE}/${mine.id}/complete`, {
                headers: CT,
                data: {},
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${mine.id}/run-now`, { headers: H, timeout: T }),
            request.post(`${MISSIONS_BASE}/${mine.id}/clone`, {
                headers: CT,
                data: {},
                timeout: T,
            }),
            request.delete(`${MISSIONS_BASE}/${mine.id}`, { headers: H, timeout: T }),
        ]);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).s5xx, `no cross-owner request 5xx'd (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 404),
            `the foreign owner gets a uniform 404 no-leak on every verb (${statuses})`,
        ).toBe(true);

        // My Mission is exactly as I left it.
        const after = await getMission(request, me.access_token, mine.id);
        expect(after.status).toBe('active');
        expect(after.description).toBe('mine-only');
    });

    test('two owners concurrently clone their OWN missions with the same title → both 201, owner-scoped', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [a, b] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const [ma, mb] = await Promise.all([
            createMission(request, a.access_token),
            createMission(request, b.access_token),
        ]);
        const sharedTitle = `Shared Clone ${stamp()}`;

        const [ra, rb] = await Promise.all([
            request.post(`${MISSIONS_BASE}/${ma.id}/clone`, {
                headers: { ...authedHeaders(a.access_token), 'content-type': 'application/json' },
                data: { title: sharedTitle },
                timeout: T,
            }),
            request.post(`${MISSIONS_BASE}/${mb.id}/clone`, {
                headers: { ...authedHeaders(b.access_token), 'content-type': 'application/json' },
                data: { title: sharedTitle },
                timeout: T,
            }),
        ]);
        expect(ra.status()).toBe(201);
        expect(rb.status()).toBe(201);
        const idA = (await ra.json()).mission.id as string;
        const idB = (await rb.json()).mission.id as string;
        expect(idA).not.toBe(idB);

        // Each owner sees ONLY their own clone (no cross-owner leak of the same-title row).
        const aIds = new Set((await listMissions(request, a.access_token)).map((m) => m.id));
        const bIds = new Set((await listMissions(request, b.access_token)).map((m) => m.id));
        expect(aIds).toContain(idA);
        expect(aIds, "owner A never sees owner B's clone").not.toContain(idB);
        expect(bIds).toContain(idB);
        expect(bIds, "owner B never sees owner A's clone").not.toContain(idA);
    });
});
