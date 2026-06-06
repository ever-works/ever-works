import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-activity-sequences-concurrency — the ACTIVITY-LOG SEQUENCE & ORDERING
 * contract under concurrent + high-frequency mutation, driven entirely through
 * its real public surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * The activity log has NO monotonic integer `sequence` column. Its "sequence" is
 * derived purely from the persisted `createdAt` timestamp, ordered DESC, with the
 * row `id` (a uuid) as the stable identity. Because website-ingested events pin
 * `createdAt` to the caller-supplied `occurredAt` (see ActivityLogService
 * .ingestFromWebsite), the push-ingest endpoint is the cleanest deterministic
 * lever we have to drive a precise, reproducible sequence and then assert it
 * survives: out-of-order insertion, concurrent identical/distinct writes,
 * pagination, per-scope isolation, and a simulated reconnect ("restart"). EVERY
 * shape below was probed against the LIVE API (sqlite in-memory — the exact CI
 * driver) on throwaway users before any assertion was written.
 *
 *   PUSH INGEST (POST /api/activity-log/ingest, PlatformSecretGuard bearer):
 *     bearer = PLATFORM_API_SECRET_TOKEN (apps/api/.env). push-mode Work + valid
 *     DTO → 202 { id }. createdAt is PINNED to occurredAt (future clamps to now).
 *     Idempotent by (workId, eventId): a replay (even CONCURRENT) returns the
 *     SAME row id and persists exactly ONE row — the non-atomic check-then-insert
 *     race is caught by the (workId, ingestEventId) partial-unique index and the
 *     loser falls back to the winner's row (service.isUniqueViolation).
 *     DTO: workId+eventId @IsUUID, actionType @IsEnum(WEBSITE_*),
 *          occurredAt @IsISO8601, summary @MaxLength(500). no-bearer → 401
 *          'Missing Bearer token'.
 *
 *   LIST (GET /api/activity-log?workId=&limit=&offset=):
 *     → { activities[], total }. userId-SCOPED (a stranger filtering by another
 *     user's workId gets ZERO rows). ORDER BY activity.createdAt DESC (no
 *     secondary tiebreaker — but ties resolve DETERMINISTICALLY: identical across
 *     repeated reads). Pagination via take(limit)/skip(offset) over the SAME
 *     ordered set: limit≤100, distinct offsets are disjoint, total is stable.
 *
 *   WORK ACTIVITY FEED (GET /api/works/:id/activity-feed?limit=&cursor=&category=):
 *     → { entries[], nextCursor, serverTime, degraded? }. push-mode ⇒ NO
 *     `degraded`. entries newest-first by `timestamp`. `nextCursor` is the last
 *     entry's timestamp ONLY when the page is FULL (entries.length === limit),
 *     else null. The cursor predicate is INCLUSIVE (`createdAt <= cursor`), so the
 *     boundary entry can REPEAT across adjacent pages — overlap is ≤ 1 (the
 *     shared boundary timestamp), never a gap. limit bounds 1..200 (0/500 → 400).
 *     category filter narrows entries to a single chip. cross-account → 403.
 *
 * NOT DUPLICATED (surveyed audit-log-sequences, audit-log-immutable,
 * concurrent-actions, concurrent-conflict, flow-activity-sync-modes,
 * flow-activity-export-sanitization, activity-log, activity-feed-perwork):
 *   - audit-log-sequences/immutable → PATCH/PUT/DELETE rejection on a single
 *     activity row (append-only), NOT multi-row sequence ordering.
 *   - concurrent-actions → two contexts read the same profile / one work appears
 *     in a list, NOT activity-log sequence integrity under concurrent ingest.
 *   - flow-activity-sync-modes → the mode-SWITCH lifecycle + a single push 202 +
 *     basic (workId,eventId) idempotency, NOT a deterministic multi-row SEQUENCE,
 *     NOT CONCURRENT idempotency (no-dup race), NOT createdAt-DESC ordering of an
 *     out-of-order batch, NOT cursor-boundary overlap, NOT per-scope sequence
 *     isolation, NOT same-timestamp tie stability, NOT restart/reconnect stability.
 *   NET-NEW HERE: (1) out-of-order ingest → strict createdAt-DESC sequence with
 *   no gaps/dups; (2) CONCURRENT identical eventId → one row, one id (race-safe);
 *   (3) concurrent DISTINCT events → every row present exactly once + total
 *   accurate; (4) per-scope (per-Work) sequence isolation — two Works never bleed;
 *   (5) feed cursor pagination — inclusive-boundary overlap ≤ 1, never a gap,
 *   newest-first preserved across pages; (6) same-timestamp high-frequency burst
 *   → deterministic tie ordering stable across a simulated reconnect ("restart").
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user); unique Date.now()/uuid-suffixed names; tolerant matchers
 * (toContain / subset checks over exact whole-list counts) since the shared
 * in-memory DB carries sibling rows from the bootstrap work.created/work.updated;
 * generous timeouts; the PLATFORM_API_SECRET_TOKEN is read from env with the known
 * e2e literal as a fallback so the canonical value stays out of tracked source.
 */

// Platform-wide ingest bearer — pinned deterministically in the e2e API env
// (apps/api/.env). PlatformSecretGuard timingSafeEqual-compares it.
const PLATFORM_API_SECRET_TOKEN =
    process.env.PLATFORM_API_SECRET_TOKEN ?? 'e2e-platform-secret-token-deterministic-32+chars';

const WEBSITE_ACTION_TYPES = [
    'website_user_registered',
    'website_item_submitted',
    'website_report_filed',
    'website_report_resolved',
] as const;

interface ActivityRow {
    id: string;
    summary: string;
    createdAt: string;
    actionType: string;
    action: string;
    status: string;
}

interface FeedEntry {
    id: string;
    timestamp: string;
    summary: string;
    category: string;
    source: string;
    type: string;
    status: string;
}

function uuid(): string {
    return globalThis.crypto.randomUUID();
}

/** ISO timestamp `base + offsetMinutes`. */
function isoAt(base: Date, offsetMinutes: number): string {
    return new Date(base.getTime() + offsetMinutes * 60_000).toISOString();
}

/** Create a Work and immediately switch it into push mode (opens the ingest gate). */
async function createPushWork(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<string> {
    const work = await createWorkViaAPI(request, token, { name });
    expect(work.id, 'work create returned no id').toBeTruthy();
    const patch = await request.patch(`${API_BASE}/api/works/${work.id}`, {
        headers: authedHeaders(token),
        data: { activitySyncMode: 'push' },
    });
    expect(patch.status(), `switch to push body=${await patch.text().catch(() => '')}`).toBe(200);
    return work.id;
}

/** POST one ingest event with the platform bearer. */
async function ingest(
    request: APIRequestContext,
    workId: string,
    fields: {
        eventId?: string;
        actionType?: (typeof WEBSITE_ACTION_TYPES)[number];
        occurredAt: string;
        summary: string;
        metadata?: Record<string, unknown>;
    },
    bearer: string = PLATFORM_API_SECRET_TOKEN,
) {
    return request.post(`${API_BASE}/api/activity-log/ingest`, {
        headers: { Authorization: `Bearer ${bearer}` },
        data: {
            workId,
            eventId: fields.eventId ?? uuid(),
            actionType: fields.actionType ?? 'website_user_registered',
            occurredAt: fields.occurredAt,
            summary: fields.summary,
            ...(fields.metadata ? { metadata: fields.metadata } : {}),
        },
    });
}

/**
 * Ingest one event, RETRYING only on a 429. The ingest endpoint inherits the
 * global per-IP throttlers (short 50/1s, medium 300/10s, long 1000/60s — see
 * apps/api/src/config/throttler.config.ts) plus a 60/min cap on the route. Under
 * a workers=4 run all four workers share one IP, so a dense burst can momentarily
 * exhaust the per-second budget and bounce a 202 to 429. That is a transient
 * rate-limit, NOT a contract failure: we re-send the SAME event (idempotent by
 * (workId, eventId)) until it is accepted, so every event still lands exactly
 * once and the 202 contract is asserted, never weakened.
 */
async function ingestAccepted(
    request: APIRequestContext,
    workId: string,
    fields: {
        eventId?: string;
        actionType?: (typeof WEBSITE_ACTION_TYPES)[number];
        occurredAt: string;
        summary: string;
        metadata?: Record<string, unknown>;
    },
) {
    let res = await ingest(request, workId, fields);
    // Bounded back-off; the per-second window refills in ~1s, so a few tries
    // across a couple of seconds comfortably clears even a sustained 429 streak.
    for (let attempt = 0; res.status() === 429 && attempt < 12; attempt += 1) {
        await new Promise((r) => setTimeout(r, 400 + attempt * 200));
        res = await ingest(request, workId, fields);
    }
    expect(res.status(), `ingest body=${await res.text().catch(() => '')}`).toBe(202);
    return res;
}

/** List the activity log scoped to a Work, returning the activities array. */
async function listActivities(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: { limit?: number; offset?: number } = {},
): Promise<{ activities: ActivityRow[]; total: number }> {
    const qs = new URLSearchParams({
        workId,
        limit: String(opts.limit ?? 100),
        offset: String(opts.offset ?? 0),
    });
    const res = await request.get(`${API_BASE}/api/activity-log?${qs.toString()}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return { activities: body.activities ?? [], total: body.total ?? 0 };
}

/** GET one page of the per-Work activity feed. */
async function feedPage(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: { limit?: number; cursor?: string; category?: string } = {},
): Promise<{ entries: FeedEntry[]; nextCursor: string | null; degraded: unknown }> {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.category) qs.set('category', opts.category);
    const res = await request.get(
        `${API_BASE}/api/works/${workId}/activity-feed?${qs.toString()}`,
        { headers: authedHeaders(token) },
    );
    expect(res.status(), `feed body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return {
        entries: body.entries ?? [],
        nextCursor: body.nextCursor ?? null,
        degraded: body.degraded ?? null,
    };
}

/** True iff `arr` is non-increasing (DESC) under string compare. */
function isDescending(arr: string[]): boolean {
    for (let i = 0; i < arr.length - 1; i += 1) {
        if (arr[i] < arr[i + 1]) return false;
    }
    return true;
}

test.describe('Activity sequence — ordering & integrity under concurrent / high-frequency mutation', () => {
    test('out-of-order ingest collapses into a strict createdAt-DESC sequence with no gaps or dups', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, `Seq Order ${Date.now()}`);

        // A deterministic ladder of 7 events whose occurredAt strictly increases
        // 1..7. createdAt is pinned to occurredAt, so the logical sequence is
        // fixed regardless of the ORDER WE POST THEM IN. Use a base far in the
        // past so the bootstrap work.created/work.updated rows (stamped "now")
        // always sit ABOVE this ladder and never interleave it.
        const base = new Date('2021-01-01T00:00:00.000Z');
        const rungs = [1, 2, 3, 4, 5, 6, 7];
        // Post in a SCRAMBLED order to prove the server re-sequences by timestamp.
        const postOrder = [4, 1, 6, 2, 7, 3, 5];
        const expectedIdByRung = new Map<number, string>();
        for (const n of postOrder) {
            // Retry on the per-IP rate-limit (429) so a parallel-run throttle
            // bounce on the shared 60/min ingest budget can't drop a rung. The
            // event is idempotent, so it still lands exactly once; `ingestAccepted`
            // asserts the 202 contract internally (never weakening the throttle).
            const res = await ingestAccepted(request, workId, {
                occurredAt: isoAt(base, n),
                summary: `rung-${n}`,
            });
            const { id } = await res.json();
            expect(typeof id).toBe('string');
            expectedIdByRung.set(n, id);
        }

        const { activities } = await listActivities(request, owner.access_token, workId);
        const ladder = activities.filter((a) => /^rung-\d+$/.test(a.summary));

        // (a) Every rung is present EXACTLY once — no gap (lost write), no dup.
        expect(ladder.length).toBe(rungs.length);
        const rungNumbers = ladder.map((a) => Number(a.summary.split('-')[1]));
        expect([...rungNumbers].sort((x, y) => x - y)).toEqual(rungs);
        expect(new Set(ladder.map((a) => a.id)).size).toBe(rungs.length);

        // (b) The list is ordered strictly createdAt-DESC → rungs read 7,6,…,1
        // even though we inserted them as 4,1,6,2,7,3,5.
        expect(rungNumbers).toEqual([...rungs].reverse());
        expect(isDescending(ladder.map((a) => a.createdAt))).toBe(true);

        // (c) The createdAt that the server persisted is EXACTLY the occurredAt we
        // supplied (pinned), and each row carries the id the ingest returned.
        for (const row of ladder) {
            const n = Number(row.summary.split('-')[1]);
            expect(row.createdAt).toBe(isoAt(base, n));
            expect(row.id).toBe(expectedIdByRung.get(n));
            expect(row.action).toBe('website.website_user_registered');
            expect(row.status).toBe('completed');
        }
    });

    test('CONCURRENT replays of one (workId, eventId) yield a single row and a single id (race-safe idempotency)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, `Seq Idem ${Date.now()}`);

        // Fire 10 SIMULTANEOUS ingests of the SAME (workId, eventId). The
        // check-then-insert in ingestFromWebsite is not atomic, so several can
        // pass the existence check and race to INSERT — the partial-unique index
        // on (workId, ingestEventId) must let exactly one win and the rest fall
        // back to that row. The sequence must NOT gain duplicate rows.
        const eventId = uuid();
        const occurredAt = isoAt(new Date('2021-02-01T00:00:00.000Z'), 0);
        // Fire the 10 SIMULTANEOUS ingests so the non-atomic check-then-insert
        // actually races. A shared-IP parallel run can momentarily exhaust the
        // 60/min per-IP ingest budget and bounce some of this wave to 429; that
        // is a transient rate-limit, NOT a 409/5xx leaking the race, so we
        // resolve each response to its accepted (202) outcome by retrying the
        // SAME idempotent event. The (workId, eventId) idempotency guarantees a
        // retry still lands on the one winning row, so the no-dup contract is
        // asserted, never weakened.
        const firstWave = await Promise.all(
            Array.from({ length: 10 }, () =>
                ingest(request, workId, { eventId, occurredAt, summary: 'concurrent-idem' }),
            ),
        );
        const responses = await Promise.all(
            firstWave.map(async (r) => {
                if (r.status() === 202) return r;
                expect(r.status(), `concurrent ingest body=${await r.text().catch(() => '')}`).toBe(
                    429,
                );
                return ingestAccepted(request, workId, {
                    eventId,
                    occurredAt,
                    summary: 'concurrent-idem',
                });
            }),
        );

        // Every concurrent caller ultimately gets a clean 202 (no 409/5xx
        // leaking the race).
        for (const r of responses) {
            expect(r.status(), `concurrent ingest body=${await r.text().catch(() => '')}`).toBe(
                202,
            );
        }
        // …and they ALL return the SAME id — the idempotent contract the deployed
        // site relies on when it retries.
        const ids = await Promise.all(responses.map(async (r) => (await r.json()).id as string));
        expect(new Set(ids).size, `expected one id, got ${JSON.stringify([...new Set(ids)])}`).toBe(
            1,
        );

        // Exactly ONE row landed in the sequence for that eventId.
        const { activities } = await listActivities(request, owner.access_token, workId);
        const matching = activities.filter((a) => a.summary === 'concurrent-idem');
        expect(matching.length).toBe(1);
        expect(matching[0].id).toBe(ids[0]);

        // A later (serial) replay of the same eventId still resolves to that same
        // row — the no-dup guarantee is durable, not just a race-window artifact.
        // `ingestAccepted` tolerates a shared-IP 429 bounce while still asserting
        // the 202 contract; idempotency pins the reply to the winning row id.
        const replay = await ingestAccepted(request, workId, {
            eventId,
            occurredAt,
            summary: 'concurrent-idem-replay-ignored',
        });
        expect((await replay.json()).id).toBe(ids[0]);
        const after = await listActivities(request, owner.access_token, workId);
        expect(after.activities.filter((a) => a.id === ids[0]).length).toBe(1);
    });

    test('CONCURRENT distinct events all persist exactly once and the total count is accurate', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, `Seq Burst ${Date.now()}`);

        // 24 DISTINCT events fired concurrently, each its own eventId + a unique
        // occurredAt minute so the resulting sequence is fully ordered. The
        // sequence must contain every one — no write lost to the contention.
        const base = new Date('2021-03-01T00:00:00.000Z');
        const count = 24;
        const fields = Array.from({ length: count }, (_unused, i) => ({
            eventId: uuid(),
            occurredAt: isoAt(base, i),
            summary: `burst-${String(i).padStart(2, '0')}`,
            actionType: WEBSITE_ACTION_TYPES[i % WEBSITE_ACTION_TYPES.length],
        }));
        // Fire all 24 DISTINCT events concurrently so the insert storm actually
        // contends. A shared-IP parallel run can momentarily exhaust the 60/min
        // per-IP ingest budget and bounce part of the wave to 429 — a transient
        // rate-limit, not a lost write. We pin an explicit eventId per event so
        // each one is idempotent, then resolve every 429 to its accepted (202)
        // outcome by retrying that SAME event. The retry lands on the same row,
        // so the "every event present exactly once" contract holds and the 202
        // is asserted, never weakened.
        const firstWave = await Promise.all(fields.map((f) => ingest(request, workId, f)));
        const responses = await Promise.all(
            firstWave.map(async (r, i) => {
                if (r.status() === 202) return r;
                expect(r.status(), `burst body=${await r.text().catch(() => '')}`).toBe(429);
                return ingestAccepted(request, workId, fields[i]);
            }),
        );
        for (const r of responses) {
            expect(r.status(), `burst body=${await r.text().catch(() => '')}`).toBe(202);
        }
        const returnedIds = await Promise.all(
            responses.map(async (r) => (await r.json()).id as string),
        );
        // 24 distinct events → 24 distinct ids.
        expect(new Set(returnedIds).size).toBe(count);

        const { activities, total } = await listActivities(request, owner.access_token, workId);
        const burst = activities.filter((a) => /^burst-\d\d$/.test(a.summary));
        // Every burst event is present, exactly once.
        expect(burst.length).toBe(count);
        expect(new Set(burst.map((a) => a.id)).size).toBe(count);
        const seen = burst.map((a) => a.summary).sort();
        const expected = Array.from(
            { length: count },
            (_u, i) => `burst-${String(i).padStart(2, '0')}`,
        );
        expect(seen).toEqual(expected);

        // total counts the WHOLE work-scoped sequence (burst rows + the two
        // bootstrap rows). It must be at least our 24 and consistent with the
        // page we read.
        expect(total).toBeGreaterThanOrEqual(count);
        expect(total).toBe(activities.length);

        // The burst sub-sequence is still strict createdAt-DESC after the
        // concurrent insert storm.
        expect(isDescending(burst.map((a) => a.createdAt))).toBe(true);
    });

    test('the sequence is per-scope: two Works owned by the same user never bleed into each other', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now();
        const workA = await createPushWork(request, owner.access_token, `Seq Scope A ${stamp}`);
        const workB = await createPushWork(request, owner.access_token, `Seq Scope B ${stamp}`);

        // Interleave writes to A and B at the SAME timestamps so any cross-scope
        // bleed (a row attributed to the wrong workId) would be impossible to
        // hide behind ordering.
        const base = new Date('2021-04-01T00:00:00.000Z');
        for (let i = 0; i < 6; i += 1) {
            const occurredAt = isoAt(base, i);
            // Retry on the per-IP rate-limit (429) so a parallel-run throttle
            // bounce can't drop a rung — the events are idempotent and each
            // must land with a 202. `ingestAccepted` asserts the 202 contract
            // internally (never weakening the throttle), so the scope-isolation
            // proof below still sees all six A-* and all six B-* rows.
            await ingestAccepted(request, workA, { occurredAt, summary: `A-${i}` });
            await ingestAccepted(request, workB, { occurredAt, summary: `B-${i}` });
        }

        const a = await listActivities(request, owner.access_token, workA);
        const b = await listActivities(request, owner.access_token, workB);

        // A's sequence contains all six A-* and ZERO B-*; symmetric for B.
        const aSummaries = a.activities.map((r) => r.summary);
        const bSummaries = b.activities.map((r) => r.summary);
        for (let i = 0; i < 6; i += 1) {
            expect(aSummaries).toContain(`A-${i}`);
            expect(bSummaries).toContain(`B-${i}`);
        }
        expect(aSummaries.some((s) => /^B-\d$/.test(s))).toBe(false);
        expect(bSummaries.some((s) => /^A-\d$/.test(s))).toBe(false);

        // Row ids are disjoint between the two scopes — no shared physical row.
        const aIds = new Set(a.activities.map((r) => r.id));
        const bIds = new Set(b.activities.map((r) => r.id));
        const intersection = [...aIds].filter((id) => bIds.has(id));
        expect(intersection).toEqual([]);

        // A STRANGER filtering the activity log by the owner's workId sees an
        // EMPTY sequence — the list query is userId-scoped (it cannot be used to
        // read another account's activity even with a known workId).
        const stranger = await registerUserViaAPI(request);
        const strangerView = await listActivities(request, stranger.access_token, workA);
        expect(strangerView.activities.length).toBe(0);

        // And the work-feed for that Work is forbidden to the stranger (the
        // ownership guard fires before any sequence is composed).
        const forbidden = await request.get(`${API_BASE}/api/works/${workA}/activity-feed`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(forbidden.status()).toBe(403);
    });

    test('activity-feed cursor paging walks the whole sequence newest-first with an inclusive boundary (overlap ≤ 1, never a gap)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(
            request,
            owner.access_token,
            `Seq Cursor ${Date.now()}`,
        );

        // 9 events, each a DISTINCT minute, so the feed's timestamp ordering is a
        // total order with no ties on the website rows. (Two bootstrap rows share
        // the "now" minute — the inclusive cursor means at most that boundary
        // repeats, which is exactly what we assert below.)
        const base = new Date('2021-05-01T00:00:00.000Z');
        const total = 9;
        for (let i = 0; i < total; i += 1) {
            // Retry on the per-IP rate-limit (429) so a parallel-run throttle
            // bounce can't drop a rung — the event is idempotent and must land.
            await ingestAccepted(request, workId, {
                occurredAt: isoAt(base, i),
                summary: `cur-${i}`,
                actionType: 'website_report_filed',
            });
        }

        // Page through with limit=3. Walk until nextCursor is null. Collect the
        // ordered id stream and the per-page timestamps.
        const limit = 3;
        const pages: FeedEntry[][] = [];
        let cursor: string | undefined;
        // Hard cap the loop so a paging bug can't spin forever.
        for (let guard = 0; guard < 20; guard += 1) {
            const page = await feedPage(request, owner.access_token, workId, { limit, cursor });
            // push-mode feed never degrades.
            expect(page.degraded).toBeNull();
            pages.push(page.entries);

            // Within a page, entries are newest-first.
            expect(isDescending(page.entries.map((e) => e.timestamp))).toBe(true);

            if (!page.nextCursor) {
                // A non-full final page MUST signal end-of-stream (nextCursor null).
                break;
            }
            // A full page hands back the last timestamp as the next cursor.
            expect(page.entries.length).toBe(limit);
            expect(page.nextCursor).toBe(page.entries[page.entries.length - 1].timestamp);
            cursor = page.nextCursor;
        }
        expect(pages.length, 'expected the feed to paginate into multiple pages').toBeGreaterThan(
            1,
        );

        // Reconstruct the global stream. Adjacent pages may SHARE exactly the
        // boundary entry (the cursor predicate is `timestamp <= cursor`), so we
        // de-dup by id while asserting any overlap is bounded to that one row.
        for (let p = 0; p < pages.length - 1; p += 1) {
            const thisIds = new Set(pages[p].map((e) => e.id));
            const overlap = pages[p + 1].filter((e) => thisIds.has(e.id));
            // Inclusive boundary ⇒ at most ONE shared row between neighbours, and
            // if shared it is the boundary (last of this page == first of next).
            expect(overlap.length).toBeLessThanOrEqual(1);
            if (overlap.length === 1) {
                expect(overlap[0].id).toBe(pages[p][pages[p].length - 1].id);
                expect(overlap[0].id).toBe(pages[p + 1][0].id);
            }
        }

        // The merged, de-duplicated stream must (a) be globally newest-first and
        // (b) cover EVERY website event in our sequence with NO GAP.
        const merged: FeedEntry[] = [];
        const seenIds = new Set<string>();
        for (const page of pages) {
            for (const e of page) {
                if (!seenIds.has(e.id)) {
                    seenIds.add(e.id);
                    merged.push(e);
                }
            }
        }
        expect(isDescending(merged.map((e) => e.timestamp))).toBe(true);
        const curSummaries = merged.map((e) => e.summary).filter((s) => /^cur-\d$/.test(s));
        // Newest-first ⇒ cur-8, cur-7, …, cur-0, every one present, no gap.
        expect(curSummaries).toEqual(
            Array.from({ length: total }, (_u, i) => `cur-${total - 1 - i}`),
        );
    });

    test('a same-timestamp high-frequency burst is recorded losslessly and orders DETERMINISTICALLY across a simulated reconnect ("restart")', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, `Seq Ties ${Date.now()}`);

        // 12 events that ALL share one identical occurredAt → createdAt. This is
        // the pathological tie case: ORDER BY createdAt DESC has no secondary
        // tiebreaker, yet the engine must (a) keep every row (no collision) and
        // (b) return a STABLE order. We pin down both, then prove the order is
        // reproducible after the client throws away its token and re-authenticates
        // (the observable analogue of a server restart / fresh DB connection —
        // the sequence is derived from persisted state, not in-memory counters).
        const sameTs = isoAt(new Date('2021-06-01T12:00:00.000Z'), 0);
        const burst = 12;
        const postedIds: string[] = [];
        for (let i = 0; i < burst; i += 1) {
            // Retry on the per-IP rate-limit (429) so the burst is recorded
            // losslessly even when a parallel run momentarily saturates the
            // per-second throttle window.
            const res = await ingestAccepted(request, workId, {
                eventId: uuid(),
                occurredAt: sameTs,
                summary: `tie-${String(i).padStart(2, '0')}`,
                actionType: 'website_item_submitted',
            });
            postedIds.push((await res.json()).id);
        }
        // 12 events → 12 distinct rows; the shared timestamp caused NO collision.
        expect(new Set(postedIds).size).toBe(burst);

        const first = await listActivities(request, owner.access_token, workId);
        const tieRows1 = first.activities.filter((a) => /^tie-\d\d$/.test(a.summary));
        expect(tieRows1.length).toBe(burst);
        expect(new Set(tieRows1.map((a) => a.id)).size).toBe(burst);
        // All share the identical createdAt — they really are a tie group.
        expect(new Set(tieRows1.map((a) => a.createdAt)).size).toBe(1);
        expect(tieRows1[0].createdAt).toBe(sameTs);
        const order1 = tieRows1.map((a) => a.id);

        // A second read on the SAME token returns the identical tie ordering
        // (no run-to-run shuffle within a process).
        const second = await listActivities(request, owner.access_token, workId);
        const order2 = second.activities
            .filter((a) => /^tie-\d\d$/.test(a.summary))
            .map((a) => a.id);
        expect(order2).toEqual(order1);

        // Simulated reconnect / "restart": discard the token, log back in for a
        // FRESH bearer + DB session, and re-read. The persisted sequence — and
        // its tie ordering — must be byte-for-byte identical. Tolerate the
        // magic-link/login throttle by retrying the login a couple of times.
        let freshToken = '';
        await expect
            .poll(
                async () => {
                    const res = await request.post(`${API_BASE}/api/auth/login`, {
                        data: { email: owner.email, password: owner.password },
                    });
                    if (res.status() !== 200 && res.status() !== 201) return '';
                    freshToken = (await res.json()).access_token ?? '';
                    return freshToken;
                },
                { timeout: 20_000, intervals: [500, 1000, 2000, 3000] },
            )
            .not.toBe('');

        const afterRestart = await listActivities(request, freshToken, workId);
        const order3 = afterRestart.activities
            .filter((a) => /^tie-\d\d$/.test(a.summary))
            .map((a) => a.id);
        // Same rows, same count, same deterministic order after the reconnect.
        expect(order3).toEqual(order1);
        expect(new Set(order3)).toEqual(new Set(postedIds));
    });
});
