/**
 * GET /api/me/missions — LIST shape, filters, pagination, ordering & edges (DEEP).
 *
 * The Missions list endpoint (`MissionsController.list`) is a thin read surface
 * over `MissionsService.listForUser`. Sibling specs touch it only in passing
 * (`flow-mission-lifecycle-deep.spec.ts` does a happy-path limit/offset smoke;
 * `flow-missions-validation-authz-matrix.spec.ts` checks a few 400s). THIS file
 * deliberately drills the pagination / ordering / filter contract to the metal
 * and pins the OBSERVED behavior, covering angles the siblings do NOT:
 *
 *   • Wire shape: a BARE ARRAY of the full MissionDto projection — NOT a
 *     { data, meta } / { items, total } envelope. Every row carries all 16
 *     DTO keys and belongs to the caller.
 *   • Ordering: `updatedAt DESC` (most-recently-touched first). PATCH and a
 *     lifecycle transition (pause) both bump `updatedAt` → the row jumps to the
 *     front. Timestamps are SECOND-resolution, so same-second creates TIE and
 *     fall back to insertion order — ordering is therefore asserted with tie
 *     tolerance (Date>=Date), and strict order only where writes are spaced >1s.
 *   • limit clamp `Math.min(101, Math.max(1, n))`: limit=0 and limit=-5 clamp
 *     UP to 1 (return exactly 1 row — NOT empty, NOT 400); oversized clamps to
 *     101 (no 400); non-integer ('abc', '2.5') → 400; integer-valued '1.0' → 200.
 *   • offset clamp `Math.max(0, n)`: negative clamps to 0; past-the-end → [];
 *     non-integer → 400. Windowed pages are disjoint and their union == full set.
 *   • status filter: exact lowercase enum only (active|paused|completed|failed);
 *     `bogus` AND uppercase `ACTIVE` both → 400 (the enum is lowercase).
 *   • search: case-insensitive ILIKE substring across title OR description;
 *     empty/whitespace → no filter; >500 chars → 400; SQL-quote payload is
 *     parameter-bound (0 rows, never a 5xx).
 *   • Unsupported query params (?type, ?missionId, ?sort) are NOT wired → they
 *     are silently ignored (200, no filtering effect), including an injection
 *     payload in ?sort.
 *   • Auth (401 unauth / 401 bad token) and cross-user isolation: paging &
 *     filtering never leak another owner's rows.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) BEFORE any assertion was written. Every test registers a FRESH
 *    owner via registerUserViaAPI(), so that owner's mission set is fully
 *    deterministic (only the rows this test created) even though the shard DB
 *    accumulates rows across the suite. Fully API-orchestrated (`flow-` prefix,
 *    never matched by the no-auth testIgnore regex) so it never contends on UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const DTO_KEYS = [
    'id',
    'title',
    'description',
    'type',
    'status',
    'outcome',
    'completedAt',
    'schedule',
    'autoBuildWorks',
    'outstandingIdeasCap',
    'guardrailsOverride',
    'missionTemplateRepo',
    'missionRepo',
    'sourceMissionId',
    'createdAt',
    'updatedAt',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function tick(ms = 1100): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface MissionRow {
    id: string;
    title: string;
    description: string;
    type: string;
    status: string;
    outcome: string | null;
    completedAt: string | null;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
    [k: string]: unknown;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    body: { title?: string; description: string; type?: string; schedule?: string | null },
): Promise<MissionRow> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { type: 'one-shot', ...body },
    });
    if (res.status() !== 201) {
        throw new Error(`createMission failed (${res.status()}): ${await res.text()}`);
    }
    return res.json();
}

async function list(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; body: unknown }> {
    const res = await request.get(`${API_BASE}/api/me/missions${query}`, {
        headers: authedHeaders(token),
    });
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        body = await res.text();
    }
    return { status: res.status(), body };
}

/** Register a fresh owner + create a labeled corpus of `n` one-shot missions
 *  (all in the same second → tie on updatedAt). Returns owner + ordered ids. */
async function seedCorpus(
    request: APIRequestContext,
    n: number,
): Promise<{ owner: RegisteredUser; sfx: string; ids: string[]; titles: string[] }> {
    const owner = await registerUserViaAPI(request);
    const sfx = stamp();
    const ids: string[] = [];
    const titles: string[] = [];
    for (let i = 1; i <= n; i++) {
        const title = `Corpus-${sfx}-${String(i).padStart(2, '0')}`;
        const m = await createMission(request, owner.access_token, {
            title,
            description: `corpus body ${i} tag-${sfx}`,
        });
        ids.push(m.id);
        titles.push(title);
    }
    return { owner, sfx, ids, titles };
}

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — list shape & DTO projection', () => {
    test('fresh user → a bare empty array (not a wrapped envelope)', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { status, body } = await list(request, owner.access_token);
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect(body).toEqual([]);
    });

    test('single mission → array of one row carrying the FULL MissionDto', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const created = await createMission(request, owner.access_token, {
            title: `Solo-${sfx}`,
            description: `solo body ${sfx}`,
        });
        const { status, body } = await list(request, owner.access_token);
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        const rows = body as MissionRow[];
        expect(rows).toHaveLength(1);
        const row = rows[0];
        for (const k of DTO_KEYS) expect(row).toHaveProperty(k);
        expect(row.id).toBe(created.id);
        expect(row.id).toMatch(UUID_RE);
        expect(row.title).toBe(`Solo-${sfx}`);
        // Create defaults pinned by the service.
        expect(row.status).toBe('active');
        expect(row.type).toBe('one-shot');
        expect(row.outcome).toBeNull();
        expect(row.completedAt).toBeNull();
        expect(row.schedule).toBeNull();
        expect(row.autoBuildWorks).toBe(false);
        expect(row.sourceMissionId).toBeNull();
        expect(typeof row.createdAt).toBe('string');
        expect(new Date(row.createdAt).toString()).not.toBe('Invalid Date');
    });

    test('list is a bare array — NO data/meta/items/total envelope keys', async ({ request }) => {
        const { owner, ids } = await seedCorpus(request, 3);
        const { status, body } = await list(request, owner.access_token);
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        const rows = body as MissionRow[];
        expect(rows).toHaveLength(3);
        // A bare array has none of the common envelope keys.
        for (const k of ['data', 'meta', 'items', 'total', 'page', 'results']) {
            expect(body).not.toHaveProperty(k);
        }
        // Every returned id belongs to this owner's corpus.
        const returned = rows.map((r) => r.id);
        for (const id of ids) expect(returned).toContain(id);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — ordering (updatedAt DESC)', () => {
    test('distinct-timestamp creates are returned newest-first (strict)', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const a = await createMission(request, owner.access_token, {
            title: `Ord-A-${sfx}`,
            description: 'oldest',
        });
        await tick();
        const b = await createMission(request, owner.access_token, {
            title: `Ord-B-${sfx}`,
            description: 'newest',
        });
        const { body } = await list(request, owner.access_token);
        const rows = body as MissionRow[];
        expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    });

    test('PATCH bumps updatedAt → the edited row jumps to the front', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const a = await createMission(request, owner.access_token, {
            title: `Bump-A-${sfx}`,
            description: 'first',
        });
        await tick();
        const b = await createMission(request, owner.access_token, {
            title: `Bump-B-${sfx}`,
            description: 'second',
        });
        // Before the edit, B (newer) leads.
        expect(
            ((await list(request, owner.access_token)).body as MissionRow[]).map((r) => r.id),
        ).toEqual([b.id, a.id]);
        await tick();
        const patch = await request.patch(`${API_BASE}/api/me/missions/${a.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { description: 'first-edited' },
        });
        expect(patch.status()).toBe(200);
        // A's updatedAt is now the freshest → it leads.
        expect(
            ((await list(request, owner.access_token)).body as MissionRow[]).map((r) => r.id),
        ).toEqual([a.id, b.id]);
    });

    test('a lifecycle transition (pause) also bumps updatedAt to the front', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const a = await createMission(request, owner.access_token, {
            title: `Life-A-${sfx}`,
            description: 'a',
        });
        await tick();
        const b = await createMission(request, owner.access_token, {
            title: `Life-B-${sfx}`,
            description: 'b',
        });
        await tick();
        const paused = await request.post(`${API_BASE}/api/me/missions/${a.id}/pause`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(paused.status()).toBe(200);
        const rows = (await list(request, owner.access_token)).body as MissionRow[];
        expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
        expect(rows[0].status).toBe('paused');
    });

    test('same-second bulk create: all present, non-increasing updatedAt (tie tolerant)', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 6);
        const rows = (await list(request, owner.access_token)).body as MissionRow[];
        expect(rows).toHaveLength(6);
        const returned = rows.map((r) => r.id).sort();
        expect(returned).toEqual([...ids].sort());
        // DESC with second-resolution ties → each row's updatedAt is >= the next.
        for (let i = 1; i < rows.length; i++) {
            const prev = new Date(rows[i - 1].updatedAt).getTime();
            const cur = new Date(rows[i].updatedAt).getTime();
            expect(prev).toBeGreaterThanOrEqual(cur);
        }
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — limit clamp Math.min(101, Math.max(1, n))', () => {
    test('limit caps the page size without dropping other rows from the corpus', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 7);
        const rows = (await list(request, owner.access_token, '?limit=3')).body as MissionRow[];
        expect(rows).toHaveLength(3);
        for (const r of rows) expect(ids).toContain(r.id);
    });

    test('limit=0 clamps UP to 1 — returns exactly one row, not empty, not 400', async ({
        request,
    }) => {
        const { owner } = await seedCorpus(request, 4);
        const { status, body } = await list(request, owner.access_token, '?limit=0');
        expect(status).toBe(200);
        expect(body as MissionRow[]).toHaveLength(1);
    });

    test('limit=-5 clamps UP to 1 (never negative, never empty)', async ({ request }) => {
        const { owner } = await seedCorpus(request, 4);
        const { status, body } = await list(request, owner.access_token, '?limit=-5');
        expect(status).toBe(200);
        expect(body as MissionRow[]).toHaveLength(1);
    });

    test('oversized limit is clamped (no 400) and still returns the whole small corpus', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 5);
        const { status, body } = await list(request, owner.access_token, '?limit=500');
        expect(status).toBe(200);
        const rows = body as MissionRow[];
        expect(rows).toHaveLength(5);
        expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    });

    test('limit=101 (the exact max) is accepted', async ({ request }) => {
        const { owner } = await seedCorpus(request, 2);
        const { status, body } = await list(request, owner.access_token, '?limit=101');
        expect(status).toBe(200);
        expect(body as MissionRow[]).toHaveLength(2);
    });

    test('non-integer limits are rejected with 400', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        for (const bad of ['abc', '2.5', '1e', 'NaN']) {
            const { status, body } = await list(request, owner.access_token, `?limit=${bad}`);
            expect(status).toBe(400);
            expect((body as { message?: string }).message).toContain('limit must be an integer');
        }
    });

    test('integer-valued float limit "1.0" is accepted and returns one row', async ({
        request,
    }) => {
        const { owner } = await seedCorpus(request, 3);
        const { status, body } = await list(request, owner.access_token, '?limit=1.0');
        expect(status).toBe(200);
        expect(body as MissionRow[]).toHaveLength(1);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — offset clamp & windowing', () => {
    test('windowed pages are disjoint and their union equals the full set', async ({ request }) => {
        const { owner, ids } = await seedCorpus(request, 7);
        const p1 = (
            (await list(request, owner.access_token, '?limit=3&offset=0')).body as MissionRow[]
        ).map((r) => r.id);
        const p2 = (
            (await list(request, owner.access_token, '?limit=3&offset=3')).body as MissionRow[]
        ).map((r) => r.id);
        const p3 = (
            (await list(request, owner.access_token, '?limit=3&offset=6')).body as MissionRow[]
        ).map((r) => r.id);
        expect(p1).toHaveLength(3);
        expect(p2).toHaveLength(3);
        expect(p3).toHaveLength(1); // 7 - 6
        const union = new Set([...p1, ...p2, ...p3]);
        expect(union.size).toBe(7); // fully disjoint (no id repeats across pages)
        expect([...union].sort()).toEqual([...ids].sort());
    });

    test('offset past the end returns an empty array (200, not an error)', async ({ request }) => {
        const { owner } = await seedCorpus(request, 3);
        const { status, body } = await list(request, owner.access_token, '?offset=9999');
        expect(status).toBe(200);
        expect(body).toEqual([]);
    });

    test('negative offset clamps to 0 (returns the whole corpus)', async ({ request }) => {
        const { owner, ids } = await seedCorpus(request, 4);
        const { status, body } = await list(request, owner.access_token, '?offset=-3');
        expect(status).toBe(200);
        expect((body as MissionRow[]).map((r) => r.id).sort()).toEqual([...ids].sort());
    });

    test('non-integer offset is rejected with 400', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { status, body } = await list(request, owner.access_token, '?offset=xyz');
        expect(status).toBe(400);
        expect((body as { message?: string }).message).toContain('offset must be an integer');
    });

    test('limit+offset produce correctly sized full and trailing partial pages', async ({
        request,
    }) => {
        const { owner } = await seedCorpus(request, 5);
        const full = (await list(request, owner.access_token, '?limit=2&offset=0'))
            .body as MissionRow[];
        const mid = (await list(request, owner.access_token, '?limit=2&offset=2'))
            .body as MissionRow[];
        const tail = (await list(request, owner.access_token, '?limit=2&offset=4'))
            .body as MissionRow[];
        expect(full).toHaveLength(2);
        expect(mid).toHaveLength(2);
        expect(tail).toHaveLength(1); // 5 - 4
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — status filter', () => {
    test('status partitions the corpus and every row matches the requested status', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const keepActive = await createMission(request, owner.access_token, {
            title: `St-active-${sfx}`,
            description: 'stays active',
        });
        const toPause = await createMission(request, owner.access_token, {
            title: `St-paused-${sfx}`,
            description: 'will pause',
        });
        await request.post(`${API_BASE}/api/me/missions/${toPause.id}/pause`, {
            headers: authedHeaders(owner.access_token),
        });

        const active = (await list(request, owner.access_token, '?status=active'))
            .body as MissionRow[];
        const paused = (await list(request, owner.access_token, '?status=paused'))
            .body as MissionRow[];
        const completed = (await list(request, owner.access_token, '?status=completed'))
            .body as MissionRow[];

        expect(active.map((r) => r.id)).toContain(keepActive.id);
        expect(active.map((r) => r.id)).not.toContain(toPause.id);
        for (const r of active) expect(r.status).toBe('active');

        expect(paused.map((r) => r.id)).toEqual([toPause.id]);
        for (const r of paused) expect(r.status).toBe('paused');

        expect(completed).toEqual([]);
    });

    test('status=failed is a valid filter (empty for a fresh owner, not a 400)', async ({
        request,
    }) => {
        const { owner } = await seedCorpus(request, 2);
        const { status, body } = await list(request, owner.access_token, '?status=failed');
        expect(status).toBe(200);
        expect(body).toEqual([]);
    });

    test('invalid + wrong-case status values are rejected with 400', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        // Garbage enum → 400.
        const bogus = await list(request, owner.access_token, '?status=bogus');
        expect(bogus.status).toBe(400);
        expect((bogus.body as { message?: string }).message).toContain('Invalid status filter');
        // The enum is lowercase; UPPERCASE is NOT accepted → 400.
        const upper = await list(request, owner.access_token, '?status=ACTIVE');
        expect(upper.status).toBe(400);
    });

    test('status composes with pagination (status=active&limit=2 → at most 2 active rows)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        for (let i = 0; i < 4; i++) {
            await createMission(request, owner.access_token, {
                title: `Compose-${sfx}-${i}`,
                description: `c ${i}`,
            });
        }
        const { status, body } = await list(request, owner.access_token, '?status=active&limit=2');
        expect(status).toBe(200);
        const rows = body as MissionRow[];
        expect(rows.length).toBeLessThanOrEqual(2);
        for (const r of rows) expect(r.status).toBe('active');
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — search filter', () => {
    test('search matches a case-insensitive substring of the TITLE', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const hit = await createMission(request, owner.access_token, {
            title: `SearchTITLE-${sfx}`,
            description: 'body without the needle',
        });
        await createMission(request, owner.access_token, {
            title: `Other-${sfx}`,
            description: 'nope',
        });
        // Lowercased query against a mixed-case title → still matches (ILIKE).
        const { status, body } = await list(
            request,
            owner.access_token,
            `?search=searchtitle-${sfx.toLowerCase()}`,
        );
        expect(status).toBe(200);
        expect((body as MissionRow[]).map((r) => r.id)).toEqual([hit.id]);
    });

    test('search matches the DESCRIPTION too, case-insensitively', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const hit = await createMission(request, owner.access_token, {
            title: `PlainTitle-${sfx}`,
            description: `Haystack NEEDLE-${sfx} body`,
        });
        await createMission(request, owner.access_token, {
            title: `NoMatch-${sfx}`,
            description: 'elsewhere',
        });
        const { body } = await list(
            request,
            owner.access_token,
            `?search=needle-${sfx.toLowerCase()}`,
        );
        expect((body as MissionRow[]).map((r) => r.id)).toEqual([hit.id]);
    });

    test('empty and whitespace-only search behave as NO filter (returns everything)', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 3);
        const empty = (await list(request, owner.access_token, '?search=')).body as MissionRow[];
        const ws = (await list(request, owner.access_token, '?search=%20%20')).body as MissionRow[];
        expect(empty.map((r) => r.id).sort()).toEqual([...ids].sort());
        expect(ws.map((r) => r.id).sort()).toEqual([...ids].sort());
    });

    test('a no-match search returns an empty array', async ({ request }) => {
        const { owner } = await seedCorpus(request, 3);
        const { status, body } = await list(
            request,
            owner.access_token,
            `?search=zzz-no-such-mission-${stamp()}`,
        );
        expect(status).toBe(200);
        expect(body).toEqual([]);
    });

    test('a SQL-quote search payload is parameter-bound (0 rows, never a 5xx)', async ({
        request,
    }) => {
        const { owner } = await seedCorpus(request, 3);
        const { status, body } = await list(
            request,
            owner.access_token,
            `?search=${encodeURIComponent("' OR 1=1--")}`,
        );
        expect(status).toBe(200); // treated as a literal substring, not SQL
        expect(body).toEqual([]);
    });

    test('search longer than 500 characters is rejected with 400', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { status, body } = await list(
            request,
            owner.access_token,
            `?search=${'q'.repeat(501)}`,
        );
        expect(status).toBe(400);
        expect((body as { message?: string }).message).toContain('search must be 500 characters');
    });

    test('search composes with status (AND — both predicates must hold)', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const sfx = stamp();
        const activeHit = await createMission(request, owner.access_token, {
            title: `AndCase-${sfx}`,
            description: 'active + matches',
        });
        const pausedHit = await createMission(request, owner.access_token, {
            title: `AndCase-${sfx}`,
            description: 'will be paused + matches',
        });
        await request.post(`${API_BASE}/api/me/missions/${pausedHit.id}/pause`, {
            headers: authedHeaders(owner.access_token),
        });
        const { body } = await list(
            request,
            owner.access_token,
            `?status=active&search=andcase-${sfx.toLowerCase()}`,
        );
        const ids = (body as MissionRow[]).map((r) => r.id);
        expect(ids).toContain(activeHit.id);
        expect(ids).not.toContain(pausedHit.id);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — unsupported params & injection are inert', () => {
    test('?type is NOT a wired filter — it is silently ignored (returns all)', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 3); // all one-shot
        // Asking for scheduled would filter everything out IF ?type were wired;
        // instead the param is ignored and every one-shot row still comes back.
        const { status, body } = await list(request, owner.access_token, '?type=scheduled');
        expect(status).toBe(200);
        expect((body as MissionRow[]).map((r) => r.id).sort()).toEqual([...ids].sort());
    });

    test('?missionId is NOT a wired scope — it is ignored (full list, not one row)', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 3);
        const { status, body } = await list(request, owner.access_token, `?missionId=${ids[0]}`);
        expect(status).toBe(200);
        expect(body as MissionRow[]).toHaveLength(3);
    });

    test('an injection payload in the (unsupported) ?sort param is inert → 200, data intact', async ({
        request,
    }) => {
        const { owner, ids } = await seedCorpus(request, 3);
        const payload = encodeURIComponent('title; DROP TABLE missions;--');
        const { status, body } = await list(request, owner.access_token, `?sort=${payload}`);
        expect(status).toBe(200);
        // Table clearly not dropped: the corpus is still fully readable.
        expect((body as MissionRow[]).map((r) => r.id).sort()).toEqual([...ids].sort());
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/me/missions — auth & cross-user isolation', () => {
    test('unauthenticated request → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/missions`);
        expect(res.status()).toBe(401);
    });

    test('a garbage bearer token → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders('not-a-real-token'),
        });
        expect(res.status()).toBe(401);
    });

    test("paging & filtering never leak another owner's missions", async ({ request }) => {
        const a = await seedCorpus(request, 4);
        const b = await registerUserViaAPI(request);

        // B's own list is empty regardless of A's rows.
        const bList = (await list(request, b.access_token)).body as MissionRow[];
        expect(bList).toEqual([]);

        // B paging into A's offset range still sees nothing of A's.
        const bPaged = (await list(request, b.access_token, '?limit=50&offset=0'))
            .body as MissionRow[];
        for (const id of a.ids) expect(bPaged.map((r) => r.id)).not.toContain(id);

        // A searching for A's own tag finds rows; B searching the same tag finds none.
        const aHits = (await list(request, a.owner.access_token, `?search=tag-${a.sfx}`))
            .body as MissionRow[];
        expect(aHits.length).toBeGreaterThanOrEqual(1);
        const bHits = (await list(request, b.access_token, `?search=tag-${a.sfx}`))
            .body as MissionRow[];
        expect(bHits).toEqual([]);
    });
});
