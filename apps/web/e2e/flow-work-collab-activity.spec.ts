import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Theme: Work collaboration + activity feed (end-to-end, multi-step).
 *
 * The platform records work-scoped activity through the NestJS event
 * pipeline (apps/api/src/activity-log + works.controller). Every Work
 * mutation that matters lands as an append-only row in `activity_log`,
 * surfaced two ways:
 *   - GET /api/activity-log[?workId=…]      → { activities[], total }
 *   - GET /api/works/:id/activity-feed      → { entries[], serverTime, … }
 * and exported via GET /api/activity-log/export → text/csv.
 *
 * These three flows drive that surface end-to-end and assert truthful,
 * observed outcomes (every shape below was probed against the live API
 * before being asserted):
 *
 *   1. Mutation sequence → ordered feed. Owner creates a Work then runs a
 *      sequence of PATCH mutations; the per-work feed AND the global
 *      activity-log record each action in the right order with the right
 *      actor (userId) + type (actionType). A targeted UI check confirms the
 *      recorded summary is observable on /en/activity for the logged-in
 *      seeded user.
 *
 *   2. Activity-log export. Generate activity, hit the CSV export endpoint,
 *      and assert the file is a real CSV download (Content-Type +
 *      Content-Disposition) whose rows contain every recorded entry, with
 *      the documented header. Filtered exports (?workId, ?actionType) are
 *      cross-checked against the JSON list.
 *
 *   3. Immutability + monotonicity. Activity entries are append-only: the
 *      controller exposes no PATCH/PUT/DELETE verb, so each is refused
 *      (404 "Cannot <VERB> …") and the entry survives unchanged. Ordering
 *      is monotonic non-increasing on createdAt (the platform stores
 *      second-granularity timestamps, so concurrent mutations may share a
 *      second — the guarantee is `>=`, not strictly `>`).
 *
 * GOTCHA NOTES (verified against the running stack):
 *   - LOGIN DTO is whitelisted to {email,password}; never POST the full
 *     loadSeededTestUser() object.
 *   - submit-item / add-item requires a connected Git account ("Please
 *     reconnect your Git account to continue.") and is NOT feasible on the
 *     keyless CI stack, so the "add item" mutation in flow 1 is realised as
 *     additional PATCH updates (which DO emit `work_updated` rows — proven
 *     by probe). Deviation noted in 'risks'.
 *   - activity_log timestamps are truncated to whole seconds; mutations are
 *     spaced >1.1s apart in flow 1 so the action order is deterministic.
 *   - API-only orchestration runs on FRESH registerUserViaAPI() users to
 *     keep the shared in-memory DB clean; the seeded storageState user is
 *     used only for the UI assertion.
 */

const WORK_CREATED = 'work_created';
const WORK_UPDATED = 'work_updated';
const USER_SIGNUP = 'user_signup';

interface ActivityEntry {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    createdAt: string;
}

interface ActivityListResponse {
    activities: ActivityEntry[];
    total: number;
}

async function listActivities(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ActivityListResponse> {
    const res = await request.get(`${API_BASE}/api/activity-log${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `activity-log list status (q=${query})`).toBe(200);
    const body = (await res.json()) as ActivityListResponse;
    expect(Array.isArray(body.activities), 'activities is array').toBe(true);
    expect(typeof body.total, 'total is number').toBe('number');
    return body;
}

interface FeedEntry {
    id: string;
    source: string;
    type: string;
    category: string;
    timestamp: string;
    summary: string;
    status?: string;
}

async function getWorkFeed(
    request: APIRequestContext,
    token: string,
    workId: string,
    query = '',
): Promise<{ entries: FeedEntry[]; serverTime: string; nextCursor: string | null }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/activity-feed${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `activity-feed status (q=${query})`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries), 'feed entries is array').toBe(true);
    expect(typeof body.serverTime, 'serverTime is string').toBe('string');
    return body;
}

/** Rename / update a Work — emits a `work_updated` activity row. */
async function patchWork(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<void> {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data,
    });
    expect(
        res.status(),
        `PATCH /api/works/${workId} body=${await res.text().catch(() => '')}`,
    ).toBe(200);
}

/** Whole-second granularity: space mutations so each lands in its own second. */
async function settleSecond(): Promise<void> {
    await new Promise((r) => setTimeout(r, 1_150));
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        // Whitelisted DTO — {email,password} ONLY (passing `name` → 400).
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

test.describe('Work collaboration + activity feed — flows', () => {
    test('1) owner mutation sequence is recorded in order with actor + type (feed + global log + UI)', async ({
        request,
        page,
    }) => {
        // --- API orchestration on a fresh owner (clean DB) -------------------
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const originalName = `Flow Collab ${stamp}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name: originalName });
        expect(work.id, 'work id').toBeTruthy();

        // Sequence of mutations, each spaced into its own clock-second so the
        // DESC-ordered feed yields a deterministic action order. Renames /
        // description edits each emit a `work_updated` row (proven by probe);
        // "add item" needs a connected Git account so is realised as updates.
        await settleSecond();
        await patchWork(request, owner.access_token, work.id, { name: `${originalName} v2` });
        await settleSecond();
        await patchWork(request, owner.access_token, work.id, { description: 'collab edit one' });
        await settleSecond();
        await patchWork(request, owner.access_token, work.id, { description: 'collab edit two' });

        // --- Per-work feed records every action, newest first ---------------
        const feed = await getWorkFeed(request, owner.access_token, work.id);
        const feedTypes = feed.entries.map((e) => e.type);

        // 1 create + 3 updates = 4 platform-activity-log rows for this work.
        const platformEntries = feed.entries.filter((e) => e.source === 'platform-activity-log');
        expect(platformEntries.length, `feed types: ${feedTypes.join(',')}`).toBe(4);

        // Feed is sorted newest-first → the oldest entry is the creation, the
        // three after it are the updates.
        const oldest = platformEntries[platformEntries.length - 1];
        expect(oldest.type, 'oldest feed entry is work_created').toBe(WORK_CREATED);
        expect(oldest.summary).toContain(originalName);
        for (const e of platformEntries.slice(0, 3)) {
            expect(e.type, 'newer feed entries are work_updated').toBe(WORK_UPDATED);
            expect(e.category, 'work mutations categorise as settings').toBe('settings');
            expect(e.status).toBe('completed');
        }

        // Timestamps strictly descending across distinct seconds (we spaced them).
        const feedTs = platformEntries.map((e) => new Date(e.timestamp).getTime());
        for (let i = 0; i < feedTs.length - 1; i++) {
            expect(feedTs[i], 'feed newest-first ordering').toBeGreaterThan(feedTs[i + 1]);
        }

        // --- Global activity-log scoped to this work mirrors the feed -------
        const scoped = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(scoped.total, 'work-scoped total = 1 create + 3 updates').toBe(4);
        // Actor + type are truthful on every row.
        for (const a of scoped.activities) {
            expect(a.userId, 'actor is the owner').toBe(owner.user.id);
            expect(a.workId, 'row scoped to the work').toBe(work.id);
            expect([WORK_CREATED, WORK_UPDATED]).toContain(a.actionType);
            expect(a.status).toBe('completed');
        }
        // Exactly one create, three updates.
        expect(scoped.activities.filter((a) => a.actionType === WORK_CREATED)).toHaveLength(1);
        expect(scoped.activities.filter((a) => a.actionType === WORK_UPDATED)).toHaveLength(3);
        // action strings match the documented mapping.
        const createRow = scoped.activities.find((a) => a.actionType === WORK_CREATED)!;
        expect(createRow.action).toBe('work.created');
        expect(createRow.summary).toBe(`Created work: ${originalName}`);
        const updateRow = scoped.activities.find((a) => a.actionType === WORK_UPDATED)!;
        expect(updateRow.action).toBe('work.updated');

        // The unscoped log additionally carries the signup row — confirming
        // cross-action ordering: every newer work row sorts above the signup.
        const unscoped = await listActivities(request, owner.access_token);
        const signup = unscoped.activities.find((a) => a.actionType === USER_SIGNUP);
        expect(signup, 'signup row present in global log').toBeTruthy();
        const newestWork = unscoped.activities.find((a) => a.workId === work.id)!;
        expect(
            new Date(newestWork.createdAt).getTime(),
            'work activity sorts above signup',
        ).toBeGreaterThanOrEqual(new Date(signup!.createdAt).getTime());

        // --- Targeted UI assertion on the logged-in seeded user -------------
        // Drive the SAME kind of mutation on the seeded user (whose session is
        // the storageState the browser is authenticated as) and confirm the
        // recorded summary is observable on the Activity page.
        const seedTok = await seededToken(request);
        const uiStamp = Date.now().toString(36);
        const uiWorkName = `Flow Collab UI ${uiStamp}`;
        const uiWork = await createWorkViaAPI(request, seedTok, { name: uiWorkName });
        expect(uiWork.id).toBeTruthy();

        await page.goto('/en/activity', { waitUntil: 'domcontentloaded' });
        // /en/activity is a dashboard route → cold Next dev compile; give it room.
        const summaryText = page.getByText(`Created work: ${uiWorkName}`, { exact: false });
        await expect(summaryText.first()).toBeVisible({ timeout: 30_000 });
    });

    test('2) activity-log export is a real CSV download containing every recorded entry', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const workName = `Flow Export ${stamp}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name: workName });

        // Generate a couple more rows so the export has multiple entries.
        await patchWork(request, owner.access_token, work.id, { description: 'export edit a' });
        await patchWork(request, owner.access_token, work.id, { name: `${workName} edited` });

        // Source of truth: the JSON list for this work.
        const scoped = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(scoped.total, '1 create + 2 updates').toBe(3);

        // --- Full export -----------------------------------------------------
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'export status').toBe(200);
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        expect(ct, `content-type: ${ct}`).toContain('text/csv');
        const cd = res.headers()['content-disposition'] || '';
        expect(cd, `content-disposition: ${cd}`).toContain('attachment');
        expect(cd).toContain('activity-log.csv');

        const csv = await res.text();
        const lines = csv.split('\n').filter((l) => l.length > 0);
        // Documented header (apps/api/.../activity-log.service.ts#exportCsv).
        expect(lines[0]).toBe('Date,Action Type,Action,Status,Work,Summary');

        // Every recorded entry id's row is represented: the export carries the
        // create + both updates + the signup row. Assert via column values
        // (the CSV doesn't include ids), tolerating any pre-existing rows.
        const dataLines = lines.slice(1);
        const createLine = dataLines.find(
            (l) => l.includes(',work_created,work.created,completed,') && l.includes(workName),
        );
        expect(createLine, 'create row in CSV').toBeTruthy();
        // The Work column reflects the CURRENT name (export joins live Work).
        expect(createLine).toContain(`"${workName} edited"`);
        const updateLines = dataLines.filter((l) =>
            l.includes(',work_updated,work.updated,completed,'),
        );
        expect(updateLines.length, 'both update rows in CSV').toBeGreaterThanOrEqual(2);
        expect(
            dataLines.some((l) => l.includes(',user_signup,user.signup,completed,')),
            'signup row in CSV',
        ).toBe(true);

        // Each data row has the documented 6-logical-column shape. The Work and
        // Summary cells are double-quoted; everything before them is plain.
        for (const l of [createLine!, ...updateLines]) {
            expect(l).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,[a-z_]+,[a-z._]+,[a-z_]+,".*",".*"$/);
        }

        // --- Filtered exports cross-check the list endpoint ------------------
        const byWork = await request.get(`${API_BASE}/api/activity-log/export?workId=${work.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(byWork.status()).toBe(200);
        const byWorkLines = (await byWork.text()).split('\n').filter((l) => l.length > 0);
        // Header + exactly the 3 work rows (signup is workId=null → excluded).
        expect(byWorkLines.length, 'workId export = header + 3 rows').toBe(1 + scoped.total);
        expect(byWorkLines.some((l) => l.includes('user_signup'))).toBe(false);

        const byType = await request.get(
            `${API_BASE}/api/activity-log/export?actionType=work_updated`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(byType.status()).toBe(200);
        const byTypeData = (await byType.text())
            .split('\n')
            .filter((l) => l.length > 0)
            .slice(1);
        expect(byTypeData.length, 'actionType=work_updated → 2 rows').toBe(2);
        expect(byTypeData.every((l) => l.includes(',work_updated,work.updated,'))).toBe(true);

        // Export requires auth.
        const anon = await request.get(`${API_BASE}/api/activity-log/export`);
        expect(anon.status(), 'export needs auth').toBe(401);
    });

    test('3) activity entries are immutable (append-only) and ordering is monotonic', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Flow Immutable ${stamp}`,
        });

        // Build a multi-row history. These run back-to-back (no spacing) on
        // purpose: several can collide into the same wall-clock second, which
        // is exactly the monotonic-`>=` edge we want to exercise.
        await patchWork(request, owner.access_token, work.id, { description: 'imm edit 1' });
        await patchWork(request, owner.access_token, work.id, { description: 'imm edit 2' });
        await patchWork(request, owner.access_token, work.id, { description: 'imm edit 3' });

        const before = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(before.total).toBe(4); // 1 create + 3 updates
        const target = before.activities[0]; // newest row
        const targetId = target.id;
        expect(targetId, 'target entry id').toBeTruthy();

        // Single-entry GET works and returns { activity: {...} }.
        const detail = await request.get(`${API_BASE}/api/activity-log/${targetId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(detail.status(), 'single-entry GET').toBe(200);
        const detailBody = await detail.json();
        const detailActivity = detailBody.activity ?? detailBody;
        expect(detailActivity.id).toBe(targetId);
        expect(detailActivity.action).toBe('work.updated');

        // --- No write verb exists on the entry: each is refused -------------
        // The controller declares only GET routes, so Nest's router 404s the
        // write verbs ("Cannot <VERB> /api/activity-log/<id>") — never 2xx,
        // never 5xx.
        for (const verb of ['patch', 'put', 'delete'] as const) {
            const res = await request[verb](`${API_BASE}/api/activity-log/${targetId}`, {
                headers: authedHeaders(owner.access_token),
                data: { action: 'tampered', status: 'failed', summary: 'TAMPERED' },
            });
            expect(res.status(), `${verb.toUpperCase()} on an audit entry must be refused`).toBe(
                404,
            );
            expect(res.status(), `${verb.toUpperCase()} must not 5xx`).toBeLessThan(500);
            const text = await res.text();
            expect(text, `${verb.toUpperCase()} body mentions the verb`).toMatch(
                new RegExp(`Cannot ${verb.toUpperCase()}`, 'i'),
            );
        }

        // A stranger cannot reach the entry either (scoped to owner).
        const stranger = await registerUserViaAPI(request);
        const strangerGet = await request.get(`${API_BASE}/api/activity-log/${targetId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status(), 'stranger 404 on owner entry').toBe(404);

        // --- The entry survived the write attempts unchanged ----------------
        const reread = await request.get(`${API_BASE}/api/activity-log/${targetId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(reread.status()).toBe(200);
        const rereadActivity = (await reread.json()).activity;
        expect(rereadActivity.id).toBe(targetId);
        expect(rereadActivity.action, 'action unchanged').toBe('work.updated');
        expect(rereadActivity.status, 'status unchanged').toBe('completed');
        expect(
            JSON.stringify(rereadActivity).includes('TAMPERED'),
            'tamper sentinel never persisted',
        ).toBe(false);

        // --- List is unchanged and ordering is monotonic non-increasing -----
        const after = await listActivities(request, owner.access_token, `?workId=${work.id}`);
        expect(after.total, 'no row added or removed by the refused writes').toBe(before.total);
        expect(
            after.activities.map((a) => a.id),
            'same set of entry ids in the same order',
        ).toEqual(before.activities.map((a) => a.id));

        // createdAt is DESC and monotonic non-increasing (second-granularity
        // means adjacent rows may legitimately share a timestamp → `>=`).
        const ts = after.activities.map((a) => new Date(a.createdAt).getTime());
        for (let i = 0; i < ts.length - 1; i++) {
            expect(
                ts[i],
                `row ${i} createdAt >= row ${i + 1} (monotonic non-increasing)`,
            ).toBeGreaterThanOrEqual(ts[i + 1]);
        }
        // And the boundary holds: the newest is the create's strict ancestor
        // only by `>=` — assert the oldest row is the creation event.
        const oldestRow = after.activities[after.activities.length - 1];
        expect(oldestRow.actionType, 'oldest entry is the creation').toBe(WORK_CREATED);
    });
});
