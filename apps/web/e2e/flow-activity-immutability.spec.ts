import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-activity-immutability — the append-only / tamper-resistance contract of
 * the platform Activity Log, driven END-TO-END through its real public surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Activity Log is the audit trail: every account gets a `user_signup` row,
 * every Work create/update writes a row, and the deployed directory site can
 * push website events via the ingest endpoint. The audit guarantee is that the
 * trail is APPEND-ONLY — no row may be edited, deleted, reordered, or read by
 * another user — and that the recorded SEQUENCE (createdAt DESC) is monotonic
 * and resistant to clock-tampering by a misbehaving site.
 *
 * There is NO hash-chain and NO explicit sequence column in the schema
 * (packages/agent/src/entities/activity-log.entity.ts) — the integrity
 * mechanism is: (a) the controller exposes ZERO write verbs, so the API offers
 * no mutation path at all; (b) rows order by the TypeORM @CreateDateColumn
 * `createdAt` (DESC); (c) per-id reads are `findByIdAndUserId`-scoped; (d) the
 * push-ingest path is idempotent by `(workId, ingestEventId)` and clamps
 * future-dated `occurredAt` to "now". This file pins all four, none of which the
 * existing immutability/sequence/tamper specs cover (they each fire a single
 * PATCH/PUT/DELETE and check the first-id stays put). Every shape below was
 * probed against the LIVE API (sqlite in-memory — the exact CI driver) on
 * throwaway users before any assertion was written.
 *
 *   List  GET /api/activity-log[?workId&actionType&status&limit&offset]
 *     → 200 { activities: ActivityLog[], total: number }; ordered createdAt DESC.
 *     ActivityLog row: { id(uuid), userId, workId|null, actionType, action,
 *       status, summary, details|null, metadata|null, ingestEventId|null,
 *       ipAddress|null, userAgent|null, tenantId|null, organizationId|null,
 *       createdAt(ISO, second-granularity), updatedAt, work|null }.
 *     A fresh account has exactly one `user_signup`/`user.signup`/completed row.
 *     Each Work create writes `work_created`/`work.created`; each settings PATCH
 *     writes `work_updated`/`work.updated`.
 *   Detail GET /api/activity-log/:id → 200 { activity: { …row, details:{} } }
 *     — USER-SCOPED (findByIdAndUserId): another user's id → 404, malformed id
 *     → 404, unknown uuid → 404. Sub-routes /summary /running-count /export are
 *     matched BEFORE the `:id` catch (declaration order), so `:id` never shadows
 *     them.
 *   WRITE VERBS: the controller declares only @Get + @Post('ingest'). PATCH, PUT,
 *     DELETE, and POST on `/:id` OR the collection all hit NO route → 404 (Nest
 *     has no handler — not a 405, there is simply no write surface). A burst of
 *     them leaves the list BYTE-IDENTICAL.
 *   Ingest POST /api/activity-log/ingest (Public + PlatformSecretGuard bearer,
 *     @HttpCode(202)) — the only user-reachable WRITE path:
 *     push-mode Work + valid bearer + DTO → 202 { id }.
 *     replay SAME (workId,eventId) → 202 { id } SAME id; the original row is
 *       returned UNCHANGED — a divergent replay payload is IGNORED (immutable).
 *     future occurredAt (e.g. 2099) → createdAt CLAMPED to now; the raw value is
 *       preserved in metadata.occurredAt for forensics.
 *     past occurredAt (e.g. 2021)  → createdAt PRESERVED (true event ordering),
 *       so the row sorts to the tail of the DESC feed.
 *     pull/disabled mode → 409 { error:'mode-mismatch', mode } (a default Work is
 *       'pull', so unsolicited ingest can't append to it).
 *   Export GET /api/activity-log/export → 200 text/csv; charset=utf-8, rows
 *     ordered createdAt DESC (mirrors the list ordering).
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user
 * (never the shared seeded user); unique Date.now()-suffixed names; tolerant
 * matchers (toContain / >= over exact counts) since the in-memory DB carries
 * sibling rows; createdAt is SECOND-granularity so monotonicity is asserted
 * non-strictly (>=) and the eldest-tail invariant uses the signup row; the
 * PLATFORM_API_SECRET_TOKEN is read from env with the known e2e literal as a
 * fallback so the canonical value stays out of tracked source.
 */

// The platform-wide ingest bearer — pinned deterministically in the e2e API env
// (apps/api/.env). PlatformSecretGuard compares it with timingSafeEqual.
const PLATFORM_API_SECRET_TOKEN =
    process.env.PLATFORM_API_SECRET_TOKEN ?? 'e2e-platform-secret-token-deterministic-32+chars';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface ActivityRow {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    ingestEventId: string | null;
    createdAt: string;
    metadata: Record<string, unknown> | null;
    [k: string]: unknown;
}

function uuid(): string {
    return globalThis.crypto.randomUUID();
}

/** List a user's activity log (unwraps the `{ activities, total }` envelope). */
async function listActivities(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ activities: ActivityRow[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/activity-log${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.activities)).toBe(true);
    expect(typeof body.total).toBe('number');
    return body;
}

/** Flip a Work into push mode so it accepts ingest. */
async function enablePush(request: APIRequestContext, token: string, workId: string) {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data: { activitySyncMode: 'push' },
    });
    expect(res.status(), `enable push body=${await res.text().catch(() => '')}`).toBe(200);
}

/** POST a website-sourced ingest event with the platform bearer. */
async function ingest(
    request: APIRequestContext,
    workId: string,
    overrides: Partial<{
        eventId: string;
        actionType: string;
        occurredAt: string;
        summary: string;
        metadata: Record<string, unknown>;
    }> = {},
    bearer: string = PLATFORM_API_SECRET_TOKEN,
) {
    return request.post(`${API_BASE}/api/activity-log/ingest`, {
        headers: { Authorization: `Bearer ${bearer}` },
        data: {
            workId,
            eventId: overrides.eventId ?? uuid(),
            actionType: overrides.actionType ?? 'website_user_registered',
            occurredAt: overrides.occurredAt ?? new Date().toISOString(),
            summary: overrides.summary ?? 'e2e immutability ingest event',
            ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
        },
    });
}

test.describe('Activity log — append-only: the API exposes no write surface', () => {
    test('every non-GET verb on /:id and the collection is 404 (no mutation route exists) and a tamper burst leaves the trail byte-identical', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Seed a second row so the trail has structure to compare.
        await createWorkViaAPI(request, u.access_token, { name: `Immut NoWrite ${Date.now()}` });

        const before = await listActivities(request, u.access_token, '?limit=100');
        expect(before.activities.length).toBeGreaterThanOrEqual(2);
        const target = before.activities[0];
        expect(typeof target.id).toBe('string');

        // The controller (apps/api/src/activity-log/activity-log.controller.ts)
        // declares ONLY @Get handlers + @Post('ingest'). Therefore PATCH / PUT /
        // DELETE on an existing entry id reach NO Nest route → 404. This is a
        // stronger guarantee than a 4xx authorization refusal: there is simply
        // no code path that could ever mutate an audit row.
        const idTamper = { summary: 'HACKED', status: 'failed', action: 'tampered' };
        for (const method of ['patch', 'put', 'delete'] as const) {
            const res = await request[method](`${API_BASE}/api/activity-log/${target.id}`, {
                headers: authedHeaders(u.access_token),
                data: idTamper,
            });
            expect(res.status(), `${method.toUpperCase()} /:id must hit no write route`).toBe(404);
            // The rejection must not echo back the tamper payload (the body was
            // never processed — the route doesn't exist).
            expect(
                (await res.text()).includes('HACKED'),
                `${method.toUpperCase()} echoed the tamper payload`,
            ).toBe(false);
        }
        // A stray POST to /:id (where only GET is defined) is likewise 404.
        const postId = await request.post(`${API_BASE}/api/activity-log/${target.id}`, {
            headers: authedHeaders(u.access_token),
            data: idTamper,
        });
        expect(postId.status()).toBe(404);

        // Same for the COLLECTION root: PATCH/PUT/DELETE have no handler → 404
        // (there is no bulk-edit or clear-log endpoint).
        for (const method of ['patch', 'put', 'delete'] as const) {
            const res = await request[method](`${API_BASE}/api/activity-log`, {
                headers: authedHeaders(u.access_token),
                data: idTamper,
            });
            expect(
                res.status(),
                `${method.toUpperCase()} on the collection must hit no write route`,
            ).toBe(404);
        }

        // After the full tamper burst the trail is BYTE-IDENTICAL — no row was
        // edited, deleted, reordered, or appended by any of the rejected verbs.
        const after = await listActivities(request, u.access_token, '?limit=100');
        expect(after.total).toBe(before.total);
        expect(JSON.stringify(after.activities)).toBe(JSON.stringify(before.activities));
        expect(JSON.stringify(after)).not.toContain('HACKED');
    });
});

test.describe('Activity log — sequence integrity: monotonic createdAt-DESC ordering', () => {
    test('a multi-row trail is ordered newest-first with the signup as the eldest tail, and offset windows are gap-free and non-overlapping', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Seed several rows: each Work create => one `work.created` row.
        const N = 4;
        for (let i = 0; i < N; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `Immut Seq ${i} ${Date.now()}`,
            });
        }

        const full = await listActivities(request, u.access_token, '?limit=100');
        // signup + N work.created rows (the in-memory DB is per-user-scoped here
        // because findByUserId filters on userId, so the count is exact).
        expect(full.total).toBeGreaterThanOrEqual(N + 1);
        const rows = full.activities;

        // MONOTONIC: createdAt is non-increasing down the list. Timestamps are
        // second-granularity, so equal adjacent stamps are legitimate — assert
        // non-strict (>=) descending.
        for (let i = 1; i < rows.length; i++) {
            const prev = new Date(rows[i - 1].createdAt).getTime();
            const cur = new Date(rows[i].createdAt).getTime();
            expect(
                prev,
                `row ${i - 1} (${rows[i - 1].createdAt}) must be >= row ${i} (${rows[i].createdAt})`,
            ).toBeGreaterThanOrEqual(cur);
        }

        // The `user_signup` row is the genesis event — it must be the OLDEST, i.e.
        // the LAST row in a DESC ordering (it can never be displaced upward
        // because no later row can predate the account itself).
        const signup = rows.find((r) => r.actionType === 'user_signup');
        expect(signup, 'signup genesis row').toBeTruthy();
        expect(rows[rows.length - 1].actionType, 'signup must be the eldest tail').toBe(
            'user_signup',
        );

        // GAP-FREE / NON-OVERLAPPING pagination: walking the trail in offset
        // windows must reconstruct the exact same id sequence as the single full
        // fetch — no row is skipped (a gap) and none is double-counted (an
        // overlap). This is the audit-completeness invariant.
        const pageSize = 2;
        const paged: string[] = [];
        for (let offset = 0; offset < full.total; offset += pageSize) {
            const page = await listActivities(
                request,
                u.access_token,
                `?limit=${pageSize}&offset=${offset}`,
            );
            expect(page.total, 'total is stable across pages').toBe(full.total);
            for (const r of page.activities) paged.push(r.id);
        }
        // Audit-completeness invariant: the offset windows must cover EXACTLY the
        // same SET of rows as the single full fetch — no row skipped (a gap) and
        // none double-counted (an overlap). We compare as sets, not as an ordered
        // list: createdAt is second-granularity (probed: every signup+work.created
        // row here shares the same second) and the repository orders ONLY by
        // `activity.createdAt DESC` with NO secondary tie-break key
        // (packages/agent/src/database/repositories/activity-log.repository.ts),
        // so sqlite is free to return tied rows in a different relative order across
        // two independent queries. Completeness (every id present, exactly once) is
        // the real contract; the intra-second order between separate fetches is not.
        const fullIds = rows.map((r) => r.id);
        expect(new Set(paged), 'paginated ids cover the full set with no gap').toEqual(
            new Set(fullIds),
        );
        expect(paged.length, 'paginated walk yields the same row count as the full fetch').toBe(
            fullIds.length,
        );
        // No duplicate ids leaked across page boundaries (no overlap).
        expect(new Set(paged).size, 'no id appears in two pages').toBe(paged.length);

        // The CSV export mirrors the same createdAt-DESC ordering (the audit
        // download is not a re-sorted view of the truth).
        const exportRes = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(exportRes.status()).toBe(200);
        expect((exportRes.headers()['content-type'] || '').toLowerCase()).toMatch(/csv/);
        const csv = await exportRes.text();
        const dataLines = csv.split('\n').slice(1).filter(Boolean); // drop the header
        const csvDates = dataLines.map((l) => new Date(l.split(',')[0]).getTime());
        for (let i = 1; i < csvDates.length; i++) {
            expect(csvDates[i - 1], 'CSV rows are createdAt-DESC').toBeGreaterThanOrEqual(
                csvDates[i],
            );
        }
    });
});

test.describe('Activity log — per-entry reads are user-scoped and immutable', () => {
    test('a row reads back field-for-field, the :id route never shadows the named sub-routes, and malformed/unknown ids are 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        await createWorkViaAPI(request, u.access_token, { name: `Immut Detail ${Date.now()}` });
        const list = await listActivities(request, u.access_token, '?limit=100');
        const row = list.activities[0];

        // The single-entry GET returns the SAME immutable row the list shows.
        const detailRes = await request.get(`${API_BASE}/api/activity-log/${row.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detailRes.status()).toBe(200);
        const { activity } = await detailRes.json();
        expect(activity.id).toBe(row.id);
        expect(activity.userId).toBe(row.userId);
        expect(activity.actionType).toBe(row.actionType);
        expect(activity.action).toBe(row.action);
        expect(activity.status).toBe(row.status);
        expect(activity.summary).toBe(row.summary);
        // createdAt is identical to the millisecond — the detail view does not
        // re-stamp or drift the recorded time.
        expect(new Date(activity.createdAt).getTime()).toBe(new Date(row.createdAt).getTime());

        // Declaration-order routing: /summary, /running-count, /export are static
        // segments matched BEFORE the `:id` param route, so `:id` never captures
        // them. Each returns its own well-formed payload (not an "activity not
        // found" 404 that would prove the param route swallowed them).
        const summary = await request.get(`${API_BASE}/api/activity-log/summary`, {
            headers: authedHeaders(u.access_token),
        });
        expect(summary.status()).toBe(200);
        expect(typeof (await summary.json()).counts).toBe('object');

        const running = await request.get(`${API_BASE}/api/activity-log/running-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(running.status()).toBe(200);
        expect(Number.isInteger((await running.json()).count)).toBe(true);

        const exp = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(exp.status()).toBe(200);
        expect((exp.headers()['content-type'] || '').toLowerCase()).toMatch(/csv/);

        // Unknown (well-formed) uuid → 404; malformed id → 404. Neither leaks a
        // 5xx and neither resolves to a real row.
        for (const badId of [ZERO_UUID, 'not-a-uuid']) {
            const res = await request.get(`${API_BASE}/api/activity-log/${badId}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), `GET /:id (${badId}) must be 404`).toBe(404);
        }
    });

    test('a stranger cannot read another user’s audit entry by id (findByIdAndUserId scoping → 404, not 403-with-body)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        await createWorkViaAPI(request, owner.access_token, { name: `Immut Scope ${Date.now()}` });
        const ownerList = await listActivities(request, owner.access_token, '?limit=100');
        const ownerRowId = ownerList.activities[0].id;

        // The stranger holds a VALID token but the row is not theirs. The
        // repository query is `where { id, userId }`, so a foreign id resolves to
        // nothing → 404 (the existence of the row is not even confirmed to the
        // stranger — no 403 that would leak that the id is real).
        const cross = await request.get(`${API_BASE}/api/activity-log/${ownerRowId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(cross.status(), 'cross-user per-id GET must be 404').toBe(404);

        // The stranger filtering by the owner's workId likewise sees nothing —
        // the list is userId-scoped, so it cannot enumerate the owner's trail.
        const ownerWorkId = ownerList.activities.find((r) => r.workId)?.workId;
        if (ownerWorkId) {
            const crossList = await listActivities(
                request,
                stranger.access_token,
                `?workId=${ownerWorkId}`,
            );
            expect(crossList.total, 'cross-user workId filter leaks no rows').toBe(0);
            expect(crossList.activities.length).toBe(0);
        }

        // And the owner still reads their own row fine — the scoping rejects
        // strangers, not legitimate access.
        const ownRead = await request.get(`${API_BASE}/api/activity-log/${ownerRowId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownRead.status()).toBe(200);
    });
});

test.describe('Activity log — push-ingest is append-only and idempotent', () => {
    test('replaying (workId,eventId) returns the same row UNCHANGED even when the replay payload diverges, and never duplicates the row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Immut Ingest Idem ${Date.now()}`,
        });
        await enablePush(request, owner.access_token, work.id);

        // First ingest of a fixed eventId → 202 with a freshly-created id.
        const eventId = uuid();
        const first = await ingest(request, work.id, {
            eventId,
            actionType: 'website_user_registered',
            summary: 'original ingested event',
        });
        expect(first.status(), `first body=${await first.text().catch(() => '')}`).toBe(202);
        const firstId = (await first.json()).id;
        expect(typeof firstId).toBe('string');

        // Snapshot the persisted row.
        const persisted = await request.get(`${API_BASE}/api/activity-log/${firstId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(persisted.status()).toBe(200);
        const originalRow = (await persisted.json()).activity;
        expect(originalRow.actionType).toBe('website_user_registered');
        expect(originalRow.summary).toBe('original ingested event');

        // Replay the SAME (workId, eventId) with a DELIBERATELY DIFFERENT payload.
        // The idempotency key wins: the same row id comes back and the stored row
        // is NOT overwritten by the divergent replay (append-only — a row, once
        // written, is immutable).
        const replay = await ingest(request, work.id, {
            eventId,
            actionType: 'website_item_submitted',
            occurredAt: '2020-01-01T00:00:00.000Z',
            summary: 'divergent replay that must be ignored',
        });
        expect(replay.status()).toBe(202);
        expect((await replay.json()).id, 'replay returns the original row id').toBe(firstId);

        const afterReplay = await request.get(`${API_BASE}/api/activity-log/${firstId}`, {
            headers: authedHeaders(owner.access_token),
        });
        const afterRow = (await afterReplay.json()).activity;
        expect(afterRow.actionType, 'actionType not overwritten by replay').toBe(
            originalRow.actionType,
        );
        expect(afterRow.summary, 'summary not overwritten by replay').toBe(originalRow.summary);
        expect(new Date(afterRow.createdAt).getTime(), 'createdAt not overwritten by replay').toBe(
            new Date(originalRow.createdAt).getTime(),
        );

        // No duplicate row was appended for the replayed event.
        const byEvent = await listActivities(
            request,
            owner.access_token,
            `?workId=${work.id}&actionType=website_user_registered`,
        );
        const sameEvent = byEvent.activities.filter((r) => r.ingestEventId === eventId);
        expect(sameEvent.length, 'exactly one row per (workId,eventId)').toBe(1);
    });

    test('a default (pull-mode) Work refuses unsolicited ingest with 409 mode-mismatch — the trail can’t be force-appended', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Immut Ingest Gate ${Date.now()}`,
        });

        // A fresh Work is born in 'pull' mode. An attacker (or a stale site) that
        // knows the work id and the platform bearer still cannot inject rows into
        // the owner's feed — the mode gate rejects it as a mode-mismatch.
        const before = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        const reject = await ingest(request, work.id);
        expect(reject.status(), `pull ingest body=${await reject.text().catch(() => '')}`).toBe(
            409,
        );
        expect(await reject.json()).toMatchObject({ error: 'mode-mismatch', mode: 'pull' });

        // The refused ingest appended nothing — the trail length is unchanged.
        const after = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(after.total, 'refused ingest must not append a row').toBe(before.total);

        // A missing/garbage bearer is also turned away (the write path is doubly
        // gated: bearer THEN mode), so neither a token-less nor a wrong-token
        // caller can ever append.
        const noBearer = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            data: {
                workId: work.id,
                eventId: uuid(),
                actionType: 'website_user_registered',
                occurredAt: new Date().toISOString(),
                summary: 'x',
            },
        });
        expect(noBearer.status()).toBe(401);
        const wrongBearer = await ingest(request, work.id, {}, 'definitely-not-the-token');
        expect(wrongBearer.status()).toBe(401);

        // Still nothing appended after the unauthenticated attempts.
        const final = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(final.total).toBe(before.total);
    });
});

test.describe('Activity log — tamper-resistant sequence clock', () => {
    test('a future-dated occurredAt is clamped to "now" (can’t jump the queue) while a past date is preserved, keeping the recorded order honest', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Immut Clock ${Date.now()}`,
        });
        await enablePush(request, owner.access_token, work.id);

        const ingestSentAt = Date.now();

        // FUTURE event: a misbehaving site sends occurredAt = 2099. The service
        // clamps createdAt to "now" so the row CANNOT pin itself above every
        // genuine event — the original value is kept in metadata.occurredAt for
        // forensics, not used for ordering.
        const futureId = (
            await (
                await ingest(request, work.id, {
                    occurredAt: '2099-01-01T00:00:00.000Z',
                    actionType: 'website_user_registered',
                    summary: 'future-dated event',
                })
            ).json()
        ).id;
        const futureRow = (
            await (
                await request.get(`${API_BASE}/api/activity-log/${futureId}`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).json()
        ).activity;
        const futureCreatedAt = new Date(futureRow.createdAt).getTime();
        // createdAt is "now" (well below the 2099 wall-clock), within a generous
        // window of when we POSTed it.
        expect(futureCreatedAt, 'future occurredAt clamped to ~now').toBeLessThan(
            new Date('2030-01-01T00:00:00.000Z').getTime(),
        );
        expect(futureCreatedAt).toBeGreaterThanOrEqual(ingestSentAt - 120_000);
        expect(futureCreatedAt).toBeLessThanOrEqual(Date.now() + 120_000);
        // The raw (untrusted) timestamp is retained in metadata for audit, not
        // promoted into the ordering column.
        expect(futureRow.metadata?.occurredAt).toBe('2099-01-01T00:00:00.000Z');

        // PAST event: occurredAt = 2021 is genuinely in the past, so it is
        // PRESERVED — the feed orders by when it actually happened, sinking this
        // row to the tail (below the 2026 rows).
        const pastId = (
            await (
                await ingest(request, work.id, {
                    occurredAt: '2021-03-15T08:00:00.000Z',
                    actionType: 'website_report_filed',
                    summary: 'past-dated event',
                })
            ).json()
        ).id;
        const pastRow = (
            await (
                await request.get(`${API_BASE}/api/activity-log/${pastId}`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).json()
        ).activity;
        expect(new Date(pastRow.createdAt).getTime(), 'past occurredAt preserved verbatim').toBe(
            new Date('2021-03-15T08:00:00.000Z').getTime(),
        );

        // In the owner's feed, the clamped future row sits among the recent rows
        // while the 2021 row is the eldest tail — the clock-tampering attempt did
        // NOT reorder the sequence in the attacker's favour.
        const feed = await listActivities(
            request,
            owner.access_token,
            `?workId=${work.id}&limit=100`,
        );
        const ids = feed.activities.map((r) => r.id);
        const futureIdx = ids.indexOf(futureId);
        const pastIdx = ids.indexOf(pastId);
        expect(futureIdx, 'future (clamped) row present').toBeGreaterThanOrEqual(0);
        expect(pastIdx, 'past row present').toBeGreaterThanOrEqual(0);
        // DESC ordering: the clamped-to-now future row appears BEFORE (higher up
        // than) the genuinely-old 2021 row.
        expect(futureIdx, 'clamped future row outranks the 2021 row').toBeLessThan(pastIdx);
        // And the whole work feed remains monotonic non-increasing.
        for (let i = 1; i < feed.activities.length; i++) {
            expect(new Date(feed.activities[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
                new Date(feed.activities[i].createdAt).getTime(),
            );
        }
    });
});
