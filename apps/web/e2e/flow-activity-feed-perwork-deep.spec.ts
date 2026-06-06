import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-activity-feed-perwork-deep — the per-Work Activity Feed
 * (`GET /api/works/:id/activity-feed`, EW-120) driven END-TO-END through its
 * real public surface, focused on the four uncovered themes:
 *   (1) each mutation records actor + type + timestamp IN ORDER,
 *   (2) cursor + limit PAGINATION,
 *   (3) per-Work SCOPING isolation, and
 *   (4) the feed REFLECTS MULTI-ACTOR (member) activity.
 *
 * EVERY shape below was probed against the LIVE API (sqlite in-memory — the
 * exact CI driver) on throwaway users before any assertion was written.
 *
 * ─── FEED RESPONSE (ActivityFeedService.compose) ───────────────────────────
 *   GET /api/works/:id/activity-feed[?limit&cursor&category]
 *     → 200 { entries: FeedEntry[], nextCursor: string|null, serverTime, degraded? }
 *   FeedEntry (platform-activity-log variant — the only source on the keyless
 *   CI stack; generation-history + directory-site need a real pipeline / deploy):
 *     { id, source:'platform-activity-log', type, category, timestamp, summary, status, details }
 *   - Work mutations land as `platform-activity-log` rows:
 *       work_created  → summary "Created work: <name>"   category 'settings' status 'completed'
 *       work_updated  → summary "Updated work settings"  category 'settings' status 'completed'
 *       member_invited→ summary "Invited <email> as <role> to <name>" category 'settings'
 *   - Entries are sorted NEWEST-FIRST (b.timestamp.localeCompare(a.timestamp)).
 *   - Timestamps are WHOLE-SECOND granularity → mutations spaced >1.1s apart get a
 *     strictly-descending order; back-to-back ones may legitimately share a second.
 *
 * ─── PAGINATION (probed) ───────────────────────────────────────────────────
 *   - `nextCursor` = timestamp of the LAST entry in a FULL page (entries.length === limit),
 *     else null. A short page (< limit) always returns nextCursor:null (terminal page).
 *   - The cursor predicate is INCLUSIVE (`dateTo <= cursor`, second-granularity), so a
 *     page boundary that falls mid-second can RE-EMIT one boundary row on the next page
 *     — pages are NOT guaranteed disjoint. The guarantee is: walking nextCursor moves
 *     strictly BACKWARD in time and the UNION of pages covers every entry. We assert the
 *     union (unique ids) + monotonic-backward cursor, never strict page disjointness.
 *   - limit bounds (FeedQueryDto @Min(1)@Max(200)): limit=0 → 400, limit=201 → 400,
 *     limit=200 → 200. An invalid category (@IsEnum) → 400. A non-date cursor parses to
 *     null and is IGNORED (200, full list) — parseCursor() swallows it.
 *
 * ─── SCOPING (probed) ──────────────────────────────────────────────────────
 *   - fetchActivityLog calls `findByWork({ workId })` — the feed is scoped to ONE Work.
 *     Two Works owned by the same user have DISJOINT feeds (no entry-id crossover).
 *   - Access gate (controller → WorkOwnershipService.ensureAccess): unauth 401,
 *     stranger (no membership) 403, unknown work 404.
 *
 * ─── MULTI-ACTOR / MEMBERS (the headline NET-NEW finding, probed) ───────────
 *   - POST /api/works/:workId/members { email, role } (InviteMemberDto: @IsEmail,
 *     role ∈ {viewer,editor,manager}) → 201 and creates a `work_members` row, giving
 *     the invitee IMMEDIATE access. A `member_invited` activity row (actor = inviter)
 *     is recorded for the Work.
 *   - CRITICAL ASYMMETRY: the activity-feed `findByWork` BYPASSES the userId filter
 *     (access is enforced upstream), so the feed surfaces EVERY actor's rows scoped to
 *     the Work. The actor-scoped `GET /api/activity-log?workId=…` list, by contrast,
 *     only returns the CALLER's own rows. So an editor member's `work_updated` shows in
 *     the FEED for both owner and member, but NOT in the owner's actor-scoped log list.
 *   - Owner and any member see the IDENTICAL feed (same ordered entry ids) — it is a
 *     Work-scoped timeline, not a per-viewer one. A viewer can READ the feed (200) but
 *     cannot mutate (PATCH → 403), so it never authors `work_updated` rows.
 *
 * NOT DUPLICATED (surveyed activity-feed-perwork.spec.ts,
 * flow-work-collab-activity.spec.ts, flow-activity-sync-modes.spec.ts, activity-log*.spec.ts):
 *   - activity-feed-perwork.spec → shallow API contract only (401, array shape,
 *     stranger 403/404, limit<=10). No cursor walk, no category, no multi-actor, no scoping.
 *   - flow-work-collab-activity → ordered mutations via the GLOBAL `?workId` activity-LOG
 *     list + CSV export + immutability. It touches the feed once (4 platform rows) but
 *     never paginates the cursor, never filters by category, never exercises members, and
 *     never proves Work-to-Work isolation through the feed.
 *   - flow-activity-sync-modes → the pull/push/disabled TRANSPORT lifecycle + degraded
 *     compose + access gates. It uses the feed only to drive platformSync* observability.
 *   NET-NEW HERE: the nextCursor pagination WALK (full-page cursor, inclusive-boundary
 *   overlap, terminal short page), limit/category/cursor VALIDATION on the feed DTO,
 *   category-chip filtering of the feed, Work-to-Work feed ISOLATION, and the full
 *   multi-actor story (member gets feed access on invite; member-authored rows surface in
 *   the feed but not the owner's actor-scoped log; owner & member see the same feed;
 *   viewer reads but cannot author).
 *
 * GOTCHAS honored: every mutation runs on FRESH registerUserViaAPI() users (never the
 * shared seeded user — used only for the read-only UI assertion); unique Date.now()-suffixed
 * names; tolerant matchers (toContain / >= over exact counts) since the shared in-memory DB
 * may carry sibling rows for a given user; generous timeouts; second-granularity mutations
 * spaced >1.1s apart where deterministic order matters; the inclusive cursor means pages can
 * share a boundary row, so we assert the UNION of unique ids, never disjoint pages.
 */

const WORK_CREATED = 'work_created';
const WORK_UPDATED = 'work_updated';
const MEMBER_INVITED = 'member_invited';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface FeedEntry {
    id: string;
    source: string;
    type: string;
    category: string;
    timestamp: string;
    summary: string;
    status?: string;
}

interface FeedResponse {
    entries: FeedEntry[];
    nextCursor: string | null;
    serverTime: string;
    degraded?: unknown;
}

/** GET the per-Work feed; asserts the stable 200 envelope and returns it. */
async function getFeed(
    request: APIRequestContext,
    token: string,
    workId: string,
    query = '',
): Promise<FeedResponse> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/activity-feed${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `feed status (q=${query}) body=${await res.text().catch(() => '')}`).toBe(
        200,
    );
    const body = (await res.json()) as FeedResponse;
    expect(Array.isArray(body.entries), 'entries is array').toBe(true);
    expect(typeof body.serverTime, 'serverTime is string').toBe('string');
    expect(body, 'response carries nextCursor key').toHaveProperty('nextCursor');
    return body;
}

/** PATCH a Work — emits a `work_updated` activity row (NOT git-gated). */
async function patchWork(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<number> {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data,
    });
    return res.status();
}

/** Invite a registered user (by email) onto a Work; returns the raw response. */
async function inviteMember(
    request: APIRequestContext,
    token: string,
    workId: string,
    email: string,
    role: 'viewer' | 'editor' | 'manager',
) {
    return request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(token),
        data: { email, role },
    });
}

/** GET the actor-scoped global activity-log list (filtered to a Work). */
async function listWorkLog(request: APIRequestContext, token: string, workId: string) {
    const res = await request.get(`${API_BASE}/api/activity-log?workId=${workId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'activity-log list status').toBe(200);
    const body = await res.json();
    return {
        total: body.total as number,
        activities: (body.activities ?? []) as Array<{
            id: string;
            userId: string;
            actionType: string;
            workId: string | null;
        }>,
    };
}

/** Whole-second granularity: space mutations so each lands in its own second. */
async function settleSecond(): Promise<void> {
    await new Promise((r) => setTimeout(r, 1_150));
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        // Whitelisted DTO — {email,password} ONLY (passing extra fields → 400).
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

test.describe('Per-work activity feed — deep integration flows', () => {
    test('1) each mutation records actor + type + timestamp, newest-first, with truthful summaries', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const originalName = `Feed Order ${stamp}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name: originalName });
        expect(work.id, 'work id').toBeTruthy();

        // A sequence of mutations, each spaced into its own clock-second so the
        // DESC feed yields a deterministic action order (rename → 2 edits).
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { name: `${originalName} v2` }),
        ).toBe(200);
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'feed edit one' }),
        ).toBe(200);
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'feed edit two' }),
        ).toBe(200);

        const feed = await getFeed(request, owner.access_token, work.id, '?limit=200');

        // 1 create + 3 updates = 4 platform-activity-log rows for this Work.
        const platform = feed.entries.filter((e) => e.source === 'platform-activity-log');
        expect(platform.length, `feed types: ${feed.entries.map((e) => e.type).join(',')}`).toBe(4);

        // Newest-first: oldest entry is the creation; the three newer are updates.
        const oldest = platform[platform.length - 1];
        expect(oldest.type, 'oldest feed entry is work_created').toBe(WORK_CREATED);
        expect(oldest.summary, 'create summary').toBe(`Created work: ${originalName}`);
        expect(oldest.category, 'create categorises as settings').toBe('settings');
        expect(oldest.status, 'create status').toBe('completed');
        for (const e of platform.slice(0, 3)) {
            expect(e.type, 'newer feed entries are work_updated').toBe(WORK_UPDATED);
            expect(e.summary, 'update summary').toBe('Updated work settings');
            expect(e.category, 'work mutations categorise as settings').toBe('settings');
            expect(e.status, 'update status').toBe('completed');
        }

        // Timestamp ordering is strictly descending across the distinct seconds we spaced.
        const ts = platform.map((e) => new Date(e.timestamp).getTime());
        for (let i = 0; i < ts.length - 1; i++) {
            expect(ts[i], `feed[${i}] newer than feed[${i + 1}]`).toBeGreaterThan(ts[i + 1]);
        }
        // Every entry carries a parseable ISO timestamp at or before serverTime.
        const serverMs = new Date(feed.serverTime).getTime();
        for (const e of platform) {
            const ms = new Date(e.timestamp).getTime();
            expect(Number.isFinite(ms), `entry timestamp parseable: ${e.timestamp}`).toBe(true);
            expect(ms, 'entry timestamp <= serverTime').toBeLessThanOrEqual(serverMs + 2_000);
        }

        // Actor attribution cross-check via the actor-scoped activity-log list: every
        // row for this Work is attributed to the owner (the sole actor here).
        const log = await listWorkLog(request, owner.access_token, work.id);
        expect(log.total, 'owner-scoped log: 1 create + 3 updates').toBe(4);
        for (const a of log.activities) {
            expect(a.userId, 'actor is the owner').toBe(owner.user.id);
            expect(a.workId, 'row scoped to the work').toBe(work.id);
            expect([WORK_CREATED, WORK_UPDATED]).toContain(a.actionType);
        }
    });

    test('2) cursor + limit pagination walks the whole feed backward in time to the creation row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed Paginate ${stamp}`,
        });

        // 1 create + 4 spaced updates = 5 distinct-second entries.
        for (let i = 0; i < 4; i++) {
            await settleSecond();
            expect(
                await patchWork(request, owner.access_token, work.id, { description: `p${i}` }),
            ).toBe(200);
        }

        // Baseline: the full feed has exactly these 5 entries and (being a short
        // page under the default 50 limit) returns no cursor.
        const all = await getFeed(request, owner.access_token, work.id, '?limit=200');
        const allIds = all.entries.map((e) => e.id);
        expect(allIds.length, 'create + 4 updates = 5 entries').toBe(5);
        expect(all.nextCursor, 'non-full page → terminal (null) cursor').toBeNull();

        // Walk pages of 2 via nextCursor. The cursor predicate is inclusive at
        // second-granularity, so adjacent pages MAY re-emit a boundary row — we
        // assert the UNION of unique ids covers everything, the cursor steps
        // strictly backward, and the walk terminates on a short page.
        let cursor: string | null = null;
        const seen = new Set<string>();
        const cursors: number[] = [];
        let pages = 0;
        for (;;) {
            const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const page = await getFeed(request, owner.access_token, work.id, q);
            pages++;
            for (const e of page.entries) seen.add(e.id);
            expect(page.entries.length, `page ${pages} not over budget`).toBeLessThanOrEqual(2);
            // Every entry on a cursored page is at or older than the cursor we asked from.
            if (cursor) {
                const cursorMs = new Date(cursor).getTime();
                for (const e of page.entries) {
                    expect(
                        new Date(e.timestamp).getTime(),
                        'cursored entries are <= the cursor',
                    ).toBeLessThanOrEqual(cursorMs);
                }
            }
            if (page.nextCursor) {
                // A full page yields a cursor equal to its last (oldest) entry's timestamp.
                expect(page.nextCursor, 'nextCursor matches last entry timestamp').toBe(
                    page.entries[page.entries.length - 1].timestamp,
                );
                cursors.push(new Date(page.nextCursor).getTime());
                cursor = page.nextCursor;
            } else {
                // Terminal page is short (fewer than the limit).
                expect(page.entries.length, 'terminal page is short').toBeLessThan(2);
                break;
            }
            expect(pages, 'pagination terminates').toBeLessThan(12);
        }

        // The union of pages reproduces the full entry set exactly.
        expect(seen.size, 'cursor walk visited every entry').toBe(allIds.length);
        expect([...seen].sort(), 'same id set as the full feed').toEqual([...allIds].sort());

        // Cursors move strictly backward in time across successive full pages.
        for (let i = 0; i < cursors.length - 1; i++) {
            expect(cursors[i], `cursor[${i}] newer than cursor[${i + 1}]`).toBeGreaterThan(
                cursors[i + 1],
            );
        }

        // A cursor pinned to before the creation returns nothing.
        const beforeAll = await getFeed(
            request,
            owner.access_token,
            work.id,
            `?cursor=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`,
        );
        expect(beforeAll.entries.length, 'cursor before all history → empty').toBe(0);
        expect(beforeAll.nextCursor, 'empty page → null cursor').toBeNull();
    });

    test('3) feed DTO validates limit/category and tolerates a non-date cursor', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed Validation ${Date.now()}`,
        });
        const base = `${API_BASE}/api/works/${work.id}/activity-feed`;

        // limit bounds — FeedQueryDto @Min(1) @Max(200).
        expect(
            (
                await request.get(`${base}?limit=0`, { headers: authedHeaders(owner.access_token) })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${base}?limit=201`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${base}?limit=-5`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(400);
        // The exact maximum is accepted.
        expect(
            (
                await request.get(`${base}?limit=200`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(200);
        // A non-integer limit is rejected by @IsInt.
        expect(
            (
                await request.get(`${base}?limit=abc`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
        ).toBe(400);

        // category — FeedQueryDto @IsEnum(FEED_CATEGORIES).
        const badCat = await request.get(`${base}?category=bogus`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(badCat.status(), 'unknown category → 400').toBe(400);
        // Every documented chip is accepted (200), even ones that yield no rows here.
        for (const category of [
            'all',
            'generation',
            'items',
            'deployment',
            'settings',
            'comparisons',
            'communityPr',
            'users',
            'submissions',
            'reports',
            'sync',
        ] as const) {
            const ok = await getFeed(request, owner.access_token, work.id, `?category=${category}`);
            expect(Array.isArray(ok.entries), `category=${category} returns entries[]`).toBe(true);
        }

        // A non-date cursor parses to null and is IGNORED — the feed returns the
        // full list rather than erroring (parseCursor swallows the bad value).
        const garbageCursor = await getFeed(
            request,
            owner.access_token,
            work.id,
            '?cursor=not-a-date',
        );
        expect(garbageCursor.entries.length, 'bad cursor ignored → create row present').toBe(1);
        expect(garbageCursor.entries[0].type).toBe(WORK_CREATED);
    });

    test('4) category chips filter the feed; settings carries every Work-mutation row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed Category ${stamp}`,
        });
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'cat edit a' }),
        ).toBe(200);
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'cat edit b' }),
        ).toBe(200);

        // On the keyless CI stack the only feed source is the platform activity-log,
        // and Work CRUD rows all categorise as 'settings' (work_created/work_updated).
        const all = await getFeed(request, owner.access_token, work.id, '?limit=200');
        const allPlatform = all.entries.filter((e) => e.source === 'platform-activity-log');
        expect(allPlatform.length, '1 create + 2 updates').toBe(3);
        expect(
            allPlatform.every((e) => e.category === 'settings'),
            'all CRUD rows categorise as settings',
        ).toBe(true);

        // ?category=settings returns exactly the same set as ?category=all here.
        const settings = await getFeed(
            request,
            owner.access_token,
            work.id,
            '?category=settings&limit=200',
        );
        expect(
            settings.entries.map((e) => e.id).sort(),
            'settings chip = the full feed (all rows are settings)',
        ).toEqual(all.entries.map((e) => e.id).sort());
        expect(settings.entries.every((e) => e.category === 'settings')).toBe(true);

        // Chips with no matching source on this stack return an empty, well-formed feed
        // (NOT an error) — proving the filter is applied, not ignored.
        for (const category of ['generation', 'items', 'deployment', 'comparisons'] as const) {
            const empty = await getFeed(
                request,
                owner.access_token,
                work.id,
                `?category=${category}&limit=200`,
            );
            expect(empty.entries.length, `category=${category} excludes settings rows`).toBe(0);
            expect(empty.nextCursor, `category=${category} short page → null`).toBeNull();
        }
    });

    test('5) feed is per-Work scoped: two Works of one owner have disjoint feeds; cross-account gates hold', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const workA = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed Scope A ${stamp}`,
        });
        const workB = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed Scope B ${stamp}`,
        });

        // Mutate each Work independently with distinguishable payloads.
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, workA.id, { description: 'A only edit' }),
        ).toBe(200);
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, workB.id, {
                description: 'B only edit 1',
            }),
        ).toBe(200);
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, workB.id, {
                description: 'B only edit 2',
            }),
        ).toBe(200);

        const feedA = await getFeed(request, owner.access_token, workA.id, '?limit=200');
        const feedB = await getFeed(request, owner.access_token, workB.id, '?limit=200');

        // Distinct row counts: A = 1 create + 1 update; B = 1 create + 2 updates.
        const platA = feedA.entries.filter((e) => e.source === 'platform-activity-log');
        const platB = feedB.entries.filter((e) => e.source === 'platform-activity-log');
        expect(platA.length, 'feed A: create + 1 update').toBe(2);
        expect(platB.length, 'feed B: create + 2 updates').toBe(3);

        // Zero entry-id crossover — each feed surfaces only its own Work's rows.
        const idsA = new Set(feedA.entries.map((e) => e.id));
        const idsB = new Set(feedB.entries.map((e) => e.id));
        const overlap = [...idsA].filter((id) => idsB.has(id));
        expect(overlap.length, 'feeds A and B share no entry ids').toBe(0);

        // Each create row names its OWN Work (proving rows aren't bleeding across).
        const createA = platA.find((e) => e.type === WORK_CREATED)!;
        const createB = platB.find((e) => e.type === WORK_CREATED)!;
        expect(createA.summary).toBe(`Created work: Feed Scope A ${stamp}`);
        expect(createB.summary).toBe(`Created work: Feed Scope B ${stamp}`);

        // --- Access gates on the feed endpoint --------------------------------
        // Unauthenticated → 401 (global JWT guard).
        const unauth = await request.get(`${API_BASE}/api/works/${workA.id}/activity-feed`);
        expect(unauth.status(), 'unauth feed → 401').toBe(401);

        // A stranger with no membership → 403 (ensureAccess rejects).
        const stranger = await registerUserViaAPI(request);
        const forbidden = await request.get(`${API_BASE}/api/works/${workA.id}/activity-feed`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(forbidden.status(), 'stranger feed → 403').toBe(403);

        // Unknown work id → 404.
        const unknown = await request.get(`${API_BASE}/api/works/${ZERO_UUID}/activity-feed`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(unknown.status(), 'unknown work feed → 404').toBe(404);
    });

    test('6) the feed reflects MULTI-ACTOR activity — member-authored rows surface in the work-scoped feed', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Feed MultiActor ${stamp}`,
        });

        // Before any membership, the editor is a stranger → no feed access.
        const preInvite = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
            headers: authedHeaders(editor.access_token),
        });
        expect(preInvite.status(), 'pre-invite editor is a stranger → 403').toBe(403);

        // Invite the editor by email → 201, immediate membership + a member_invited row.
        const invite = await inviteMember(
            request,
            owner.access_token,
            work.id,
            editor.email,
            'editor',
        );
        expect(invite.status(), `invite body=${await invite.text().catch(() => '')}`).toBe(201);
        expect((await invite.json()).member?.role).toBe('editor');

        // The editor now has feed access (200) and sees the create + member_invited rows.
        const editorFeed = await getFeed(request, editor.access_token, work.id, '?limit=200');
        expect(
            editorFeed.entries.map((e) => e.type),
            'editor sees create + member_invited',
        ).toEqual(expect.arrayContaining([WORK_CREATED, MEMBER_INVITED]));
        const invitedRow = editorFeed.entries.find((e) => e.type === MEMBER_INVITED)!;
        expect(invitedRow.summary, 'member_invited summary names the invitee + role').toContain(
            editor.email,
        );
        expect(invitedRow.summary).toContain('editor');

        // The editor mutates the Work → a work_updated row authored by the EDITOR.
        await settleSecond();
        expect(
            await patchWork(request, editor.access_token, work.id, {
                description: 'edit by member',
            }),
        ).toBe(200);
        // And the owner mutates it too → a work_updated row authored by the OWNER.
        await settleSecond();
        expect(
            await patchWork(request, owner.access_token, work.id, { description: 'edit by owner' }),
        ).toBe(200);

        // The WORK-SCOPED feed (findByWork bypasses the userId filter) surfaces BOTH
        // actors' updates. Owner and editor see the SAME ordered timeline.
        const ownerFeed = await getFeed(request, owner.access_token, work.id, '?limit=200');
        const editorFeed2 = await getFeed(request, editor.access_token, work.id, '?limit=200');
        expect(
            ownerFeed.entries.map((e) => e.id),
            'owner and editor see the identical work-scoped feed',
        ).toEqual(editorFeed2.entries.map((e) => e.id));

        const updates = ownerFeed.entries.filter((e) => e.type === WORK_UPDATED);
        expect(updates.length, 'feed carries BOTH the owner and member updates').toBe(2);
        // Feed total = create + member_invited + 2 updates.
        expect(ownerFeed.entries.filter((e) => e.source === 'platform-activity-log').length).toBe(
            4,
        );

        // ── The asymmetry: actor-scoped activity-LOG vs work-scoped FEED ───────
        // The owner's actor-scoped list does NOT include the member-authored update
        // (it filters by the caller's userId), yet the feed above DID surface it.
        const ownerLog = await listWorkLog(request, owner.access_token, work.id);
        for (const a of ownerLog.activities) {
            expect(a.userId, "owner's log only carries the owner's own rows").toBe(owner.user.id);
        }
        // The member's own actor-scoped list carries the member-authored update only.
        const editorLog = await listWorkLog(request, editor.access_token, work.id);
        expect(
            editorLog.activities.length,
            'editor authored exactly one logged row',
        ).toBeGreaterThanOrEqual(1);
        for (const a of editorLog.activities) {
            expect(a.userId, "editor's log only carries the editor's own rows").toBe(
                editor.user.id,
            );
        }
        // Net proof: the feed's update count (2) exceeds either single actor's log
        // update count (1 each) — the feed is the union, the log is per-actor.
        expect(
            updates.length,
            'feed unifies actors; neither single-actor log does',
        ).toBeGreaterThan(editorLog.activities.filter((a) => a.actionType === WORK_UPDATED).length);

        // ── A viewer can READ the feed but cannot AUTHOR rows ──────────────────
        const inviteViewer = await inviteMember(
            request,
            owner.access_token,
            work.id,
            viewer.email,
            'viewer',
        );
        expect(inviteViewer.status()).toBe(201);
        // Viewer reads the same work-scoped feed.
        const viewerFeed = await getFeed(request, viewer.access_token, work.id, '?limit=200');
        expect(
            viewerFeed.entries.some((e) => e.type === WORK_UPDATED),
            'viewer sees the multi-actor updates',
        ).toBe(true);
        // Viewer cannot mutate → 403 (no work_updated authored by the viewer).
        const viewerPatch = await patchWork(request, viewer.access_token, work.id, {
            description: 'viewer cannot edit',
        });
        expect(viewerPatch, 'viewer PATCH is forbidden').toBe(403);
    });

    test('7) UI: the seeded user observes a recorded work mutation on the Activity page', async ({
        request,
        page,
        baseURL,
    }) => {
        // Drive a mutation on the SEEDED user (whose session the browser is
        // authenticated as) and confirm the recorded summary is observable on the
        // global Activity page — the read-side UI surface fed by the same rows.
        const token = await seededToken(request);
        const uiStamp = Date.now().toString(36);
        const uiWorkName = `Feed UI ${uiStamp}`;
        const uiWork = await createWorkViaAPI(request, token, { name: uiWorkName });
        expect(uiWork.id, 'seeded UI work id').toBeTruthy();

        // The per-Work feed records the creation (API source of truth for the UI).
        const feed = await getFeed(request, token, uiWork.id);
        expect(feed.entries.some((e) => e.summary === `Created work: ${uiWorkName}`)).toBe(true);

        // The global Activity page (/en/activity is a dashboard route → cold Next
        // dev compile; give it room) shows the same recorded summary.
        const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
        await page.goto(`${origin}/en/activity`, { waitUntil: 'domcontentloaded' });
        const summary = page.getByText(`Created work: ${uiWorkName}`, { exact: false });
        await expect(summary.first()).toBeVisible({ timeout: 30_000 });
    });
});
