import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Mission ↔ Work M:N relation (PR-2, domain-model evolution) — INTEGRATION
 * flows for the explicit `mission_works` edge. Every status code and body
 * shape asserted below is pinned to the implemented contract in
 * `apps/api/src/missions/missions.controller.ts` +
 * `packages/agent/src/missions/missions.service.ts` +
 * `packages/agent/src/database/repositories/mission-work.repository.ts`.
 *
 * REST surface under test (owner-scoped, base /api/me/missions):
 *   - GET    :id/works                      → 200 { relations: MissionWorkWithWork[] }
 *                                             rows: { id, missionId, workId, relation,
 *                                             createdAt, workName, workSlug }
 *   - POST   :id/works {workId, relation}   → 201 { relations } (full updated list);
 *                                             IDEMPOTENT on the (mission, work, relation)
 *                                             triple (INSERT … ON CONFLICT DO NOTHING —
 *                                             the ORIGINAL edge row survives, same id).
 *   - DELETE :id/works/:workId/:relation    → 200 { deleted: true }; missing edge → 404
 *                                             "Relation not found"; malformed relation
 *                                             segment → 400 (controller allowlist guard).
 *   - GET    related-to-work/:workId        → 200 { relations: MissionWorkWithMission[] }
 *                                             rows: { …, missionTitle, missionStatus }
 *                                             (reverse lookup; static prefix, so it can
 *                                             never be shadowed by the ':id' routes).
 *
 * Relation vocabulary (MISSION_WORK_RELATIONS): created | improves | operates
 * | markets | researches | retires — anything else 400s at the DTO (@IsIn).
 *
 * INVARIANTS pinned as truthful contract:
 *   - I-7: Missions never OWN Works. Attaching is a cheap reference — the Work's
 *     owner/record is untouched, and one Work may relate to MANY Missions over
 *     its lifetime (scenario F below: launch mission creates it, growth mission
 *     markets it).
 *   - I-6: detaching a relation and even DELETING the Mission never touches the
 *     Work — only the edge rows CASCADE away; GET /api/works/:id stays 200.
 *   - IDOR contract mirrors the Idea-accept path (#1280): a foreign or unknown
 *     workId → 404 (existence-leak-safe), a foreign missionId → 404.
 *
 * Cross-spec isolation: every test runs on a FRESH registerUserViaAPI() user
 * with its own Missions/Works (unique stamped names), so exact-count
 * assertions on that user's own edges are safe. No module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

/** mission_works row hydrated with the Work's display fields (forward list). */
interface MissionWorkRow {
    id: string;
    missionId: string;
    workId: string;
    relation: string;
    createdAt: string;
    workName: string | null;
    workSlug: string | null;
}

/** mission_works row hydrated with the Mission's display fields (reverse list). */
interface WorkMissionRow {
    id: string;
    missionId: string;
    workId: string;
    relation: string;
    createdAt: string;
    missionTitle: string | null;
    missionStatus: string | null;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a one-shot Mission and return its DTO (201-asserted). */
async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<{ id: string; title: string; status: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title,
            description: `Mission↔Work relation spec mission — ${title}`,
            type: 'one-shot',
        },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const mission = await res.json();
    expect(mission.id).toMatch(UUID_RE);
    return mission;
}

/** GET :id/works — 200-asserted, returns the unwrapped relations array. */
async function listMissionWorks(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<MissionWorkRow[]> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}/works`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list mission works body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.relations)).toBe(true);
    return body.relations as MissionWorkRow[];
}

/** POST :id/works — raw response (callers assert status themselves). */
function attachWork(
    request: APIRequestContext,
    token: string,
    missionId: string,
    workId: string,
    relation: string,
) {
    return request.post(`${API_BASE}/api/me/missions/${missionId}/works`, {
        headers: authedHeaders(token),
        data: { workId, relation },
    });
}

/** GET related-to-work/:workId — 200-asserted reverse lookup. */
async function listMissionsForWork(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<WorkMissionRow[]> {
    const res = await request.get(`${API_BASE}/api/me/missions/related-to-work/${workId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `related-to-work body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.relations)).toBe(true);
    return body.relations as WorkMissionRow[];
}

/** Tolerant Work-name extraction across the works read-DTO shapes. */
function workNameOf(body: unknown): string | undefined {
    const b = body as {
        name?: string;
        work?: { name?: string };
        data?: { name?: string };
    };
    return b?.work?.name ?? b?.name ?? b?.data?.name;
}

test.describe('Mission ↔ Work relations (mission_works edge, fresh API user)', () => {
    test('attach: POST :id/works creates the typed edge (201 + hydrated workName), GET agrees, and re-attaching the same triple is an idempotent no-op that preserves the original edge row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const mission = await createMission(request, token, `Attach Mission ${s}`);
        const workName = `Attach Work ${s}`;
        const work = await createWorkViaAPI(request, token, { name: workName });
        expect(work.id).toMatch(UUID_RE);

        // A fresh Mission starts with ZERO relations.
        expect(await listMissionWorks(request, token, mission.id)).toHaveLength(0);

        // ── 1. Attach W as 'improves' → 201 with the full (1-row) list ──────
        const attach = await attachWork(request, token, mission.id, work.id, 'improves');
        expect(attach.status(), `attach body=${await attach.text()}`).toBe(201);
        const attached = (await attach.json()).relations as MissionWorkRow[];
        expect(attached).toHaveLength(1);
        const edge = attached[0];
        expect(edge.id).toMatch(UUID_RE);
        expect(edge.missionId).toBe(mission.id);
        expect(edge.workId).toBe(work.id);
        expect(edge.relation).toBe('improves');
        expect(edge.createdAt).toBeTruthy();
        // The row is hydrated with the Work's display fields — the UI never
        // needs a second fetch to render the relation chip.
        expect(edge.workName).toBe(workName);
        expect(typeof edge.workSlug).toBe('string');

        // ── 2. GET :id/works agrees with the POST-returned list ─────────────
        const listed = await listMissionWorks(request, token, mission.id);
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe(edge.id);
        expect(listed[0].workId).toBe(work.id);
        expect(listed[0].relation).toBe('improves');

        // ── 3. Idempotent re-attach: same (mission, work, relation) triple is
        //      a no-op (orIgnore) — still 201, still ONE row, and the ORIGINAL
        //      edge row survives (same id, not delete-and-recreate) ──────────
        const again = await attachWork(request, token, mission.id, work.id, 'improves');
        expect(again.status(), `re-attach body=${await again.text()}`).toBe(201);
        const afterAgain = (await again.json()).relations as MissionWorkRow[];
        expect(afterAgain).toHaveLength(1);
        expect(afterAgain[0].id).toBe(edge.id);
    });

    test('multiple relation kinds + scenario F: one Work relates to one Mission twice (improves + operates) and to a SECOND Mission (markets) — the reverse lookup sees 3 edges across 2 Missions', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const m1 = await createMission(request, token, `Launch Mission ${s}`);
        const m2 = await createMission(request, token, `Growth Mission ${s}`);
        const work = await createWorkViaAPI(request, token, { name: `Shared Work ${s}` });

        // ── 1. Same Work, same Mission, TWO different relation kinds — the
        //      unique key is (missionId, workId, relation), so this is two
        //      distinct edges, not a conflict ───────────────────────────────
        expect((await attachWork(request, token, m1.id, work.id, 'improves')).status()).toBe(201);
        const two = await attachWork(request, token, m1.id, work.id, 'operates');
        expect(two.status(), `second-kind attach body=${await two.text()}`).toBe(201);
        const m1Rows = (await two.json()).relations as MissionWorkRow[];
        expect(m1Rows).toHaveLength(2);
        expect(m1Rows.map((r) => r.relation).sort()).toEqual(['improves', 'operates']);
        expect(new Set(m1Rows.map((r) => r.workId))).toEqual(new Set([work.id]));

        // ── 2. Scenario F — the SAME Work attached to a second Mission with
        //      yet another relation (growth mission markets what the launch
        //      mission improves/operates) ──────────────────────────────────
        const m2Attach = await attachWork(request, token, m2.id, work.id, 'markets');
        expect(m2Attach.status()).toBe(201);
        const m2Rows = (await m2Attach.json()).relations as MissionWorkRow[];
        // The attach response is scoped to THAT Mission — M2 has exactly its
        // own single edge, never M1's.
        expect(m2Rows).toHaveLength(1);
        expect(m2Rows[0].relation).toBe('markets');
        expect(m2Rows[0].missionId).toBe(m2.id);

        // ── 3. Reverse lookup: related-to-work/:workId aggregates the edges
        //      from BOTH Missions — 3 relations across 2 Missions, hydrated
        //      with each Mission's title + status ──────────────────────────
        const reverse = await listMissionsForWork(request, token, work.id);
        expect(reverse).toHaveLength(3);
        expect(new Set(reverse.map((r) => r.missionId))).toEqual(new Set([m1.id, m2.id]));
        expect(reverse.map((r) => r.relation).sort()).toEqual(['improves', 'markets', 'operates']);
        const byMission = new Map<string, WorkMissionRow[]>();
        for (const row of reverse) {
            byMission.set(row.missionId, [...(byMission.get(row.missionId) ?? []), row]);
        }
        expect(byMission.get(m1.id)).toHaveLength(2);
        expect(byMission.get(m2.id)).toHaveLength(1);
        for (const row of reverse) {
            expect(row.workId).toBe(work.id);
            expect(row.missionTitle).toBe(row.missionId === m1.id ? m1.title : m2.title);
            expect(row.missionStatus).toBe('active');
        }
    });

    test('detach: DELETE :id/works/:workId/:relation removes ONLY the named edge → {deleted:true}, a second delete 404s, and the Work itself survives untouched (invariant I-6)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const mission = await createMission(request, token, `Detach Mission ${s}`);
        const workName = `Detach Work ${s}`;
        const work = await createWorkViaAPI(request, token, { name: workName });

        // Two edges so the detach can prove it is relation-scoped, not
        // "remove every edge for this Work".
        expect((await attachWork(request, token, mission.id, work.id, 'improves')).status()).toBe(
            201,
        );
        expect((await attachWork(request, token, mission.id, work.id, 'operates')).status()).toBe(
            201,
        );
        expect(await listMissionWorks(request, token, mission.id)).toHaveLength(2);

        // ── 1. Detach the 'improves' edge → { deleted: true } ───────────────
        const detach = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${work.id}/improves`,
            { headers: authedHeaders(token) },
        );
        expect(detach.status(), `detach body=${await detach.text()}`).toBe(200);
        expect(await detach.json()).toEqual({ deleted: true });

        // Only the named edge is gone — the 'operates' edge survives.
        const remaining = await listMissionWorks(request, token, mission.id);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].relation).toBe('operates');

        // ── 2. Deleting the SAME edge again → 404 (idempotency is the
        //      caller's problem; the API is truthful about a missing edge) ───
        const again = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${work.id}/improves`,
            { headers: authedHeaders(token) },
        );
        expect(again.status()).toBe(404);
        expect(String((await again.json()).message)).toMatch(/relation not found/i);

        // ── 3. INVARIANT I-6: detaching never touches the Work — it still
        //      reads back 200 with its name intact ──────────────────────────
        const workAfter = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(token),
        });
        expect(workAfter.status(), `work read body=${await workAfter.text()}`).toBe(200);
        expect(workNameOf(await workAfter.json())).toBe(workName);
    });

    test('authz + validation: foreign/unknown workId → 404, out-of-vocabulary relation → 400 (POST and DELETE), a foreign Mission is invisible (404), anon → 401 — and no rejected attempt leaves an edge behind', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const ownerToken = owner.access_token;
        const stranger = await registerUserViaAPI(request);
        const strangerToken = stranger.access_token;
        const s = stamp();

        const mission = await createMission(request, ownerToken, `Authz Mission ${s}`);
        const ownWork = await createWorkViaAPI(request, ownerToken, { name: `Own Work ${s}` });
        const foreignWork = await createWorkViaAPI(request, strangerToken, {
            name: `Foreign Work ${s}`,
        });

        // ── 1. Attaching a STRANGER's Work → 404, existence-leak-safe (the
        //      IDOR contract mirrors the Idea-accept path #1280: foreign and
        //      unknown ids are indistinguishable) ─────────────────────────────
        const foreign = await attachWork(
            request,
            ownerToken,
            mission.id,
            foreignWork.id,
            'improves',
        );
        expect(foreign.status(), `foreign-work attach body=${await foreign.text()}`).toBe(404);

        // ── 2. Unknown-but-well-formed workId → the same 404 ────────────────
        const ghost = await attachWork(request, ownerToken, mission.id, UNKNOWN_UUID, 'improves');
        expect(ghost.status()).toBe(404);

        // ── 3. Out-of-vocabulary relation ('owns' — Missions never own Works,
        //      invariant I-7, so it is NOT in the vocabulary) → 400 at the DTO
        //      even with a perfectly valid own workId ─────────────────────────
        const owns = await attachWork(request, ownerToken, mission.id, ownWork.id, 'owns');
        expect(owns.status()).toBe(400);
        const ownsMsg = (await owns.json()).message;
        expect(Array.isArray(ownsMsg) ? ownsMsg.join(' ') : String(ownsMsg)).toMatch(
            /relation must be one of the following values: created, improves, operates, markets, researches, retires/i,
        );

        // The DELETE path guards the same vocabulary (controller allowlist).
        const delOwns = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${ownWork.id}/owns`,
            { headers: authedHeaders(ownerToken) },
        );
        expect(delOwns.status()).toBe(400);
        expect(String((await delOwns.json()).message)).toMatch(/invalid relation/i);

        // ── 4. A foreign Mission is INVISIBLE: the stranger reading (or
        //      writing) the owner's Mission relations gets a 404, not a 403 ───
        const strangerRead = await request.get(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(strangerToken),
        });
        expect(strangerRead.status()).toBe(404);
        const strangerWrite = await attachWork(
            request,
            strangerToken,
            mission.id,
            foreignWork.id,
            'improves',
        );
        expect(strangerWrite.status()).toBe(404);

        // ── 5. Anonymous → 401 on every verb of the surface ─────────────────
        const anonList = await request.get(`${API_BASE}/api/me/missions/${mission.id}/works`);
        expect(anonList.status()).toBe(401);
        const anonAttach = await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            data: { workId: ownWork.id, relation: 'improves' },
        });
        expect(anonAttach.status()).toBe(401);
        const anonDetach = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${ownWork.id}/improves`,
        );
        expect(anonDetach.status()).toBe(401);
        const anonReverse = await request.get(
            `${API_BASE}/api/me/missions/related-to-work/${ownWork.id}`,
        );
        expect(anonReverse.status()).toBe(401);

        // ── 6. None of the rejected attempts above persisted an edge ────────
        expect(await listMissionWorks(request, ownerToken, mission.id)).toHaveLength(0);
        expect(await listMissionsForWork(request, strangerToken, foreignWork.id)).toHaveLength(0);
    });

    test('mission deletion leaves the Work intact (I-6/I-7): DELETE /api/me/missions/:id cascades ONLY the edge rows — the Work still reads 200 and the reverse lookup no longer lists the dead Mission', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const mission = await createMission(request, token, `Doomed Mission ${s}`);
        const workName = `Survivor Work ${s}`;
        const work = await createWorkViaAPI(request, token, { name: workName });

        // ── 1. Attach, and confirm the reverse lookup sees the edge ─────────
        const attach = await attachWork(request, token, mission.id, work.id, 'researches');
        expect(attach.status(), `attach body=${await attach.text()}`).toBe(201);
        const before = await listMissionsForWork(request, token, work.id);
        expect(before).toHaveLength(1);
        expect(before[0].missionId).toBe(mission.id);
        expect(before[0].relation).toBe('researches');

        // ── 2. Delete the Mission (allowed from any status) ─────────────────
        const del = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), `mission delete body=${await del.text()}`).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);

        // ── 3. INVARIANT: the Work survives its Mission — Missions never own
        //      Works (I-7), and deleting one never touches the Work (I-6).
        //      Only the mission_works edge rows CASCADE away. ────────────────
        const workAfter = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(token),
        });
        expect(workAfter.status(), `work read body=${await workAfter.text()}`).toBe(200);
        expect(workNameOf(await workAfter.json())).toBe(workName);

        // ── 4. The reverse lookup no longer lists the dead Mission ──────────
        expect(await listMissionsForWork(request, token, work.id)).toHaveLength(0);
    });
});
