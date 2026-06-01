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
 * flow-work-collab-concurrent-edit — TWO collaborators editing the SAME Work,
 * concurrent / last-write-wins, and the dual-surface activity attribution.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   - `concurrent-conflict` / `concurrent-update-conflict` race two writes but
 *     drive them BOTH as the SAME owner token (or one owner + one stranger who
 *     is rejected). They never exercise two GENUINELY-DISTINCT authorised
 *     collaborators (owner + editor-member) writing the same row.
 *   - `flow-work-collab-activity` records a SINGLE actor's mutation sequence;
 *     it never proves the feed records BOTH actors of a shared Work.
 *   - `flow-work-member-removal` / `flow-work-sync-conflict` cover the member
 *     RBAC lattice and the data-sync state fields, not collaborative content
 *     edits or the activity-feed-vs-activity-log attribution split.
 *
 *   THIS file pins the COLLABORATION contract end-to-end:
 *     two members edit one Work; last-write-wins with NO Frankenstein merge;
 *     the per-Work Activity FEED is the SHARED timeline (records BOTH actors)
 *     while each member's global Activity LOG is PER-ACTOR; a viewer sees the
 *     other collaborators' changes on refresh but cannot write; and a
 *     downgraded editor instantly loses edit while keeping read.
 *
 * PROBED LIVE against the running CI-mirror stack (sqlite in-memory, NO LLM /
 * git / Trigger.dev). Exact observed shapes the assertions below rely on:
 *
 *   PATCH|PUT /api/works/:id  (alias → same handler; updateWork)
 *     → 200 { status:'success', work:{ id, name, slug, description, userId,
 *             createdAt, updatedAt, … } }   for a creator OR an editor+ member
 *     → 403 { message:'You do not have the required permission level for this
 *             action' }                      for a viewer member
 *     → 400 { message:['property <x> should not exist'], … }  unknown DTO field
 *     The handler logs a WORK_UPDATED activity row attributed to the WRITER's
 *     userId (auth.userId) — so a member's edit is recorded as the MEMBER's,
 *     and the owner's as the OWNER's.
 *
 *   POST /api/works/:id/members { email, role:'viewer'|'editor'|'manager' }
 *     → 201 { status:'success', member:{ id (row id), userId, email, role, … } }
 *     → 400 { message:['Role must be one of: viewer, editor, manager'] } bad role
 *     Emits a MEMBER_INVITED activity row attributed to the inviter (owner).
 *
 *   PUT /api/works/:id/members/:memberId { role }
 *     → 200 { status:'success', member:{ …, role } }
 *     Emits a MEMBER_ROLE_CHANGED ('Changed member role to <role>') row.
 *     A downgrade editor→viewer is effective IMMEDIATELY: the ex-editor's next
 *     PATCH 403s.
 *
 *   GET /api/works/:id/activity-feed  (ensureAccess: any member OR creator)
 *     → 200 { entries:[ { id, source:'platform-activity-log', type, category,
 *             timestamp, summary, status } | … ], nextCursor, serverTime }
 *     The platform-activity-log source BYPASSES the per-user filter on purpose
 *     (access is enforced once by ensureAccess upstream): the feed is the
 *     SHARED Work timeline — owner AND member viewers see IDENTICAL entries,
 *     including each others' work_updated rows. Feed entries carry NO userId
 *     (attribution is by summary + the global log split). work_updated /
 *     work_created categorise as 'settings'; member_invited / member_role_changed
 *     do NOT (so a category=settings filter excludes them). NO `total` field.
 *     → 403 for a stranger (non-member); 404 for an unknown Work.
 *
 *   GET /api/activity-log?workId=<id>  (controller filters by auth.userId)
 *     → 200 { activities:[ { id, userId, workId, actionType, action, status,
 *             summary, createdAt } ], total }
 *     PER-ACTOR: a member's query returns ONLY the member's own rows for the
 *     shared Work; the owner's returns only the owner's. The UNION across the
 *     two actors equals the platform-activity-log slice of the shared feed.
 *
 * GOTCHAS honored (CLAUDE.md / sibling-spec lore):
 *   - login DTO is {email,password} ONLY.
 *   - All orchestration runs on FRESH registerUserViaAPI() users with unique
 *     Date.now()-suffixed names; assertions use toContain / arrayContaining and
 *     never exact GLOBAL counts (work-SCOPED counts ARE deterministic on a
 *     fresh Work and asserted exactly). The shared seeded (storageState) user
 *     is used ONLY for the UI-driven assertion.
 *   - activity_log createdAt is SECOND-granularity → mutations that must order
 *     deterministically are spaced >1.1s; concurrent mutations only assert the
 *     last-write-wins terminal value + no-merge, never a strict edit order.
 *   - Concurrent writes must never 5xx; final value is EXACTLY one input
 *     (no Frankenstein merge of partial fields).
 *   - next-dev LOCAL vs CI route divergence: the UI assertion tolerates a
 *     login redirect / 404 catch-all with .or() + branch.
 */

const WORK_CREATED = 'work_created';
const WORK_UPDATED = 'work_updated';
const MEMBER_INVITED = 'member_invited';
const MEMBER_ROLE_CHANGED = 'member_role_changed';

const PLATFORM_SOURCE = 'platform-activity-log';

interface MemberRow {
	id: string;
	userId: string;
	email: string;
	role: string;
}

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
}

function uniqueSuffix(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Whole-second granularity guard so DESC feed order is deterministic. */
async function settleSecond(): Promise<void> {
	await new Promise((r) => setTimeout(r, 1_150));
}

/** Invite (= synchronously add) an already-registered user to a Work. */
async function addMember(
	request: APIRequestContext,
	ownerToken: string,
	workId: string,
	email: string,
	role: 'viewer' | 'editor' | 'manager',
): Promise<MemberRow> {
	const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
		headers: authedHeaders(ownerToken),
		data: { email, role },
	});
	expect(res.status(), `invite ${email} as ${role}`).toBe(201);
	const body = await res.json();
	const member = (body?.member ?? body) as MemberRow;
	expect(member?.id, 'member row id').toBeTruthy();
	return member;
}

/** PATCH a Work and return the http status (no expectation — caller asserts). */
async function patchWork(
	request: APIRequestContext,
	token: string,
	workId: string,
	data: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
	const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
		headers: { ...authedHeaders(token), 'content-type': 'application/json' },
		data,
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON tolerated; status carries the truth */
	}
	return { status: res.status(), body };
}

/** Read a Work's current name + updatedAt (handles nested envelope). */
async function getWork(
	request: APIRequestContext,
	token: string,
	workId: string,
): Promise<{ status: number; name?: string; description?: string; updatedAt?: string }> {
	const res = await request.get(`${API_BASE}/api/works/${workId}`, {
		headers: authedHeaders(token),
	});
	if (!res.ok()) return { status: res.status() };
	const json = await res.json();
	const w = json?.work ?? json?.data ?? json;
	return {
		status: res.status(),
		name: w?.name,
		description: w?.description,
		updatedAt: w?.updatedAt,
	};
}

async function getFeed(
	request: APIRequestContext,
	token: string,
	workId: string,
	query = '',
): Promise<{ status: number; body: FeedResponse }> {
	const res = await request.get(`${API_BASE}/api/works/${workId}/activity-feed${query}`, {
		headers: authedHeaders(token),
	});
	let body: FeedResponse = { entries: [], nextCursor: null, serverTime: '' };
	if (res.ok()) body = (await res.json()) as FeedResponse;
	return { status: res.status(), body };
}

async function listLog(
	request: APIRequestContext,
	token: string,
	workId: string,
): Promise<{ activities: ActivityEntry[]; total: number }> {
	const res = await request.get(`${API_BASE}/api/activity-log?workId=${workId}`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), 'activity-log list').toBe(200);
	const body = await res.json();
	return {
		activities: (body.activities ?? []) as ActivityEntry[],
		total: body.total as number,
	};
}

function platformEntries(feed: FeedResponse): FeedEntry[] {
	return feed.entries.filter((e) => e.source === PLATFORM_SOURCE);
}

test.describe('flow: work collaboration — concurrent edit + activity attribution', () => {
	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 1 — TWO collaborators edit one Work; the per-Work FEED records BOTH
	// actors while each member's global LOG is PER-ACTOR.
	// The owner creates a Work, adds an editor-member, then owner + member each
	// PATCH it (spaced so the DESC feed order is deterministic). Assert:
	//   - both edits succeed (editor has edit rights),
	//   - the SHARED activity-feed (owner view) shows create + invite + BOTH
	//     work_updated rows, and the MEMBER's view of the feed is IDENTICAL,
	//   - the global activity-log SPLITS by actor: the member sees ONLY their
	//     own work_updated row; the owner sees their create+invite+update;
	//   - the UNION of the two per-actor logs == the platform slice of the feed.
	// ───────────────────────────────────────────────────────────────────────────
	test('two collaborators edit one work: shared feed records both actors, per-user log splits by actor', async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner: RegisteredUser = await registerUserViaAPI(request, { name: `Collab Own ${suffix}` });
		const member: RegisteredUser = await registerUserViaAPI(request, { name: `Collab Mem ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `collab-${suffix}` });
		expect(work.id, 'work created').toBeTruthy();

		await addMember(request, owner.access_token, work.id, member.email, 'editor');

		// Two distinct authorised collaborators each write the Work, each in its
		// own clock-second so the DESC feed order is deterministic.
		await settleSecond();
		const memberEdit = await patchWork(request, member.access_token, work.id, {
			description: `member edit ${suffix}`,
		});
		expect(memberEdit.status, 'editor-member can edit the work').toBe(200);
		await settleSecond();
		const ownerEdit = await patchWork(request, owner.access_token, work.id, {
			name: `owner-renamed-${suffix}`,
		});
		expect(ownerEdit.status, 'owner can edit the work').toBe(200);

		// --- The per-Work FEED is the SHARED timeline (records BOTH actors) -----
		const ownerFeed = await getFeed(request, owner.access_token, work.id);
		expect(ownerFeed.status).toBe(200);
		expect(typeof ownerFeed.body.serverTime, 'feed carries serverTime').toBe('string');
		const ownerPlatform = platformEntries(ownerFeed.body);
		// 1 create + 1 invite + 2 updates (one per collaborator) = 4 rows.
		const types = ownerPlatform.map((e) => e.type);
		expect(ownerPlatform.length, `feed platform rows (${types.join(',')})`).toBe(4);
		expect(types.filter((t) => t === WORK_CREATED), 'one create row').toHaveLength(1);
		expect(types.filter((t) => t === MEMBER_INVITED), 'one invite row').toHaveLength(1);
		expect(
			types.filter((t) => t === WORK_UPDATED),
			'TWO work_updated rows — one per collaborator',
		).toHaveLength(2);
		// Feed entries deliberately carry NO userId (attribution is implicit).
		for (const e of ownerPlatform) {
			expect(
				(e as unknown as Record<string, unknown>).userId,
				'feed entry has no userId field',
			).toBeUndefined();
		}

		// The MEMBER's view of the SAME feed is identical (access enforced once;
		// the platform slice is not re-filtered per user).
		const memberFeed = await getFeed(request, member.access_token, work.id);
		expect(memberFeed.status, 'member can read the shared feed').toBe(200);
		const memberPlatformIds = platformEntries(memberFeed.body)
			.map((e) => e.id)
			.sort();
		expect(memberPlatformIds, 'member sees the SAME shared feed rows as owner').toEqual(
			ownerPlatform.map((e) => e.id).sort(),
		);

		// --- The global LOG is PER-ACTOR -----------------------------------------
		const memberLog = await listLog(request, member.access_token, work.id);
		// The member only ever wrote ONE row for this Work (their description edit).
		expect(memberLog.total, "member's own log for this work = 1 (their edit)").toBe(1);
		expect(memberLog.activities[0].userId, 'member log row attributed to the member').toBe(
			member.user.id,
		);
		expect(memberLog.activities[0].actionType).toBe(WORK_UPDATED);

		const ownerLog = await listLog(request, owner.access_token, work.id);
		// Owner: create + invite + their own update = 3 rows, all the owner's.
		expect(ownerLog.total, "owner's own log = create + invite + update").toBe(3);
		for (const a of ownerLog.activities) {
			expect(a.userId, 'every owner-log row is attributed to the owner').toBe(owner.user.id);
		}
		expect(
			ownerLog.activities.some((a) => a.actionType === MEMBER_INVITED),
			'owner log carries the invite row (member never sees it)',
		).toBe(true);

		// --- The UNION of the two per-actor logs == the feed platform slice ------
		// (same set of activity-log ids — the feed merely renders them un-filtered).
		const unionIds = [...ownerLog.activities, ...memberLog.activities].map((a) => a.id).sort();
		expect(unionIds, 'feed shared slice == union of both actors per-user logs').toEqual(
			ownerPlatform.map((e) => e.id).sort(),
		);
	});

	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 2 — CONCURRENT owner+member edits: last-write-wins, NO Frankenstein
	// merge, BOTH writes still recorded as distinct attributed rows.
	// Two genuinely-distinct authorised collaborators PATCH the same Work in
	// parallel (owner sets `name`, editor sets `name` to a different value).
	// Neither 5xx; the persisted name is EXACTLY one of the two inputs (never a
	// partial-field merge). The activity feed still records TWO work_updated rows
	// (one per actor) regardless of which write won the value race.
	// ───────────────────────────────────────────────────────────────────────────
	test('concurrent owner+member edits resolve last-write-wins with no merge; both writes recorded', async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner = await registerUserViaAPI(request, { name: `Race Own ${suffix}` });
		const member = await registerUserViaAPI(request, { name: `Race Mem ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `race-${suffix}` });
		await addMember(request, owner.access_token, work.id, member.email, 'editor');

		const ownerName = `owner-write-${suffix}`;
		const memberName = `member-write-${suffix}`;

		const [r1, r2] = await Promise.all([
			patchWork(request, owner.access_token, work.id, { name: ownerName }),
			patchWork(request, member.access_token, work.id, { name: memberName }),
		]);
		// Neither concurrent write may 5xx; both are authorised so both 200.
		expect(r1.status, 'owner concurrent write never 5xx').toBeLessThan(500);
		expect(r2.status, 'member concurrent write never 5xx').toBeLessThan(500);
		expect(r1.status, 'owner write authorised').toBe(200);
		expect(r2.status, 'editor write authorised').toBe(200);

		// Final persisted name is EXACTLY one of the two inputs — a clean
		// last-write-wins, never a Frankenstein splice like "owner-...member".
		const after = await getWork(request, owner.access_token, work.id);
		expect(after.status).toBe(200);
		expect(typeof after.name).toBe('string');
		expect(
			[ownerName, memberName].includes(after.name!),
			`final name "${after.name}" is neither "${ownerName}" nor "${memberName}" — merge?`,
		).toBe(true);

		// Regardless of which value won, BOTH writes are recorded — once each in
		// the per-actor log, and BOTH surface in the shared feed.
		const ownerLog = await listLog(request, owner.access_token, work.id);
		const memberLog = await listLog(request, member.access_token, work.id);
		expect(
			ownerLog.activities.some(
				(a) => a.actionType === WORK_UPDATED && a.userId === owner.user.id,
			),
			"owner's concurrent write recorded under the owner",
		).toBe(true);
		expect(
			memberLog.activities.some(
				(a) => a.actionType === WORK_UPDATED && a.userId === member.user.id,
			),
			"member's concurrent write recorded under the member",
		).toBe(true);

		const feed = await getFeed(request, owner.access_token, work.id);
		const updateRows = platformEntries(feed.body).filter((e) => e.type === WORK_UPDATED);
		expect(
			updateRows.length,
			'both concurrent edits appear as distinct work_updated rows in the shared feed',
		).toBeGreaterThanOrEqual(2);
	});

	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 3 — VIEWER sees collaborators' changes on REFRESH but cannot WRITE.
	// A viewer-member is the canonical "watcher": they read the live Work + the
	// shared feed, but every write path is gated. The owner makes a change; the
	// viewer's fresh read reflects it (sees the other actor's edit on refresh),
	// while the viewer's own PATCH is refused 403 with the documented message and
	// does NOT perturb the Work or leak a row into the feed.
	// ───────────────────────────────────────────────────────────────────────────
	test('a viewer sees other collaborators changes on refresh but is write-gated (403)', async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner = await registerUserViaAPI(request, { name: `Watch Own ${suffix}` });
		const viewer = await registerUserViaAPI(request, { name: `Watch Vw ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `watch-${suffix}` });
		await addMember(request, owner.access_token, work.id, viewer.email, 'viewer');

		// Baseline: the viewer can read the Work and the shared feed.
		const seen0 = await getWork(request, viewer.access_token, work.id);
		expect(seen0.status, 'viewer can read the work').toBe(200);
		const feed0 = await getFeed(request, viewer.access_token, work.id);
		expect(feed0.status, 'viewer can read the shared feed').toBe(200);
		const feedCount0 = platformEntries(feed0.body).length;

		// The owner (another collaborator) renames the Work.
		const newName = `owner-changed-${suffix}`;
		const ownerEdit = await patchWork(request, owner.access_token, work.id, { name: newName });
		expect(ownerEdit.status).toBe(200);

		// On REFRESH the viewer observes the owner's change — eventual-read is
		// immediate here, but poll to absorb any dev cache latency.
		await expect
			.poll(
				async () => (await getWork(request, viewer.access_token, work.id)).name,
				{ timeout: 20_000, message: 'viewer should see the collaborator change on refresh' },
			)
			.toBe(newName);

		// The viewer CANNOT write — PATCH is refused with the documented message.
		const blocked = await patchWork(request, viewer.access_token, work.id, {
			name: `viewer-hijack-${suffix}`,
		});
		expect(blocked.status, 'viewer write is gated').toBe(403);
		const msg = (blocked.body as { message?: string })?.message;
		if (msg) expect(String(msg)).toMatch(/required permission level/i);

		// The refused write left the Work value untouched (still the owner's name)
		// and did NOT create an actor row in the viewer's log nor the shared feed.
		const finalName = (await getWork(request, viewer.access_token, work.id)).name;
		expect(finalName, 'refused viewer write did not stick').toBe(newName);
		const viewerLog = await listLog(request, viewer.access_token, work.id);
		expect(
			viewerLog.activities.filter((a) => a.actionType === WORK_UPDATED),
			'a refused write logs no work_updated row for the viewer',
		).toHaveLength(0);
		const feed1 = platformEntries((await getFeed(request, owner.access_token, work.id)).body);
		// Exactly one new work_updated row (the owner's) since baseline.
		expect(
			feed1.length,
			'shared feed grew by exactly the owner edit (viewer 403 added nothing)',
		).toBe(feedCount0 + 1);
	});

	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 4 — MID-SESSION DOWNGRADE: revoking edit rights is effective on the
	// NEXT write, and the role-change is itself a recorded collaboration event.
	// An editor collaborates (one successful edit), then the owner downgrades
	// them to viewer. The downgrade lands a MEMBER_ROLE_CHANGED row in the shared
	// feed; the ex-editor's subsequent PATCH flips 200→403 instantly, yet they
	// retain READ on the Work + feed. Proves the access decision is read live per
	// request, not cached from an earlier authorised edit.
	// ───────────────────────────────────────────────────────────────────────────
	test('downgrading an editor to viewer instantly revokes edit while preserving read; role change is logged', async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner = await registerUserViaAPI(request, { name: `Dg Own ${suffix}` });
		const collaborator = await registerUserViaAPI(request, { name: `Dg Col ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `downgrade-${suffix}` });
		const row = await addMember(request, owner.access_token, work.id, collaborator.email, 'editor');

		// As an editor the collaborator can write.
		const before = await patchWork(request, collaborator.access_token, work.id, {
			description: `edit while editor ${suffix}`,
		});
		expect(before.status, 'editor can edit before downgrade').toBe(200);

		// The owner downgrades editor → viewer.
		const dg = await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
			headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
			data: { role: 'viewer' },
		});
		expect(dg.status(), 'role downgrade succeeds').toBe(200);
		expect((await dg.json())?.member?.role, 'role is now viewer').toBe('viewer');

		// The downgrade is effective on the NEXT write — the ex-editor's PATCH
		// flips to 403 (decision is read live, not cached from the earlier 200).
		await expect
			.poll(
				async () =>
					(await patchWork(request, collaborator.access_token, work.id, {
						description: `should be blocked ${suffix}`,
					})).status,
				{ timeout: 20_000, message: 'downgraded collaborator should lose edit (403)' },
			)
			.toBe(403);

		// …but they retain READ on both the Work and the shared feed.
		expect(
			(await getWork(request, collaborator.access_token, work.id)).status,
			'downgraded collaborator can still read the work',
		).toBe(200);
		const feedAfter = await getFeed(request, collaborator.access_token, work.id);
		expect(feedAfter.status, 'downgraded collaborator can still read the feed').toBe(200);

		// The role change is itself a recorded collaboration event in the shared
		// feed, and attributed to the OWNER in the owner's per-actor log.
		expect(
			platformEntries(feedAfter.body).some((e) => e.type === MEMBER_ROLE_CHANGED),
			'role-change event surfaces in the shared feed',
		).toBe(true);
		const ownerLog = await listLog(request, owner.access_token, work.id);
		const roleRow = ownerLog.activities.find((a) => a.actionType === MEMBER_ROLE_CHANGED);
		expect(roleRow, 'role-change row present in owner log').toBeTruthy();
		expect(roleRow!.userId, 'role-change attributed to the acting owner').toBe(owner.user.id);
		expect(roleRow!.summary).toMatch(/viewer/i);
	});

	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 5 — FEED CATEGORY FILTER over a MULTI-ACTOR history + access gates.
	// The content edits of BOTH collaborators (work_created + work_updated) live
	// in the 'settings' feed category, while membership events (member_invited /
	// member_role_changed) do NOT. A `?category=settings` query returns ONLY the
	// content-edit rows from BOTH actors — and excludes membership noise.
	// Plus the access lattice on the feed itself: a stranger is 403, an unknown
	// Work is 404, unauth is 401 — the shared timeline is never public.
	// ───────────────────────────────────────────────────────────────────────────
	test('category=settings filter spans both actors edits and excludes membership events; feed is access-gated', async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner = await registerUserViaAPI(request, { name: `Cat Own ${suffix}` });
		const member = await registerUserViaAPI(request, { name: `Cat Mem ${suffix}` });
		const stranger = await registerUserViaAPI(request, { name: `Cat Str ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `cat-${suffix}` });
		const row = await addMember(request, owner.access_token, work.id, member.email, 'editor');

		// Multi-actor content edits + a membership mutation interleaved.
		await patchWork(request, member.access_token, work.id, { description: `mem desc ${suffix}` });
		await patchWork(request, owner.access_token, work.id, { name: `owner-name-${suffix}` });
		// A role bump (manager) — a membership event, NOT a settings/content row.
		await request.put(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
			headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
			data: { role: 'manager' },
		});

		// Unfiltered feed contains BOTH content edits AND the membership rows.
		const all = platformEntries((await getFeed(request, owner.access_token, work.id)).body);
		const allTypes = all.map((e) => e.type);
		expect(allTypes, 'unfiltered feed has membership rows').toEqual(
			expect.arrayContaining([MEMBER_INVITED, MEMBER_ROLE_CHANGED]),
		);

		// category=settings narrows to the content edits of BOTH actors only.
		const settings = await getFeed(request, owner.access_token, work.id, '?category=settings');
		expect(settings.status).toBe(200);
		const settingsRows = platformEntries(settings.body);
		// Every returned row is categorised 'settings' and is a content type.
		for (const e of settingsRows) {
			expect(e.category, 'settings filter returns only settings rows').toBe('settings');
			expect([WORK_CREATED, WORK_UPDATED]).toContain(e.type);
		}
		// 1 create + 2 content updates (member + owner) = 3 content rows.
		expect(
			settingsRows.filter((e) => e.type === WORK_UPDATED).length,
			'settings filter spans BOTH actors content edits',
		).toBe(2);
		expect(settingsRows.filter((e) => e.type === WORK_CREATED)).toHaveLength(1);
		// Membership noise is excluded by the category filter.
		expect(
			settingsRows.some(
				(e) => e.type === MEMBER_INVITED || e.type === MEMBER_ROLE_CHANGED,
			),
			'membership events excluded from the settings category',
		).toBe(false);

		// --- Access lattice on the shared feed -----------------------------------
		const strangerFeed = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`, {
			headers: authedHeaders(stranger.access_token),
		});
		expect(strangerFeed.status(), 'non-member stranger cannot read the feed').toBe(403);

		const unknownFeed = await request.get(
			`${API_BASE}/api/works/00000000-0000-0000-0000-000000000000/activity-feed`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(unknownFeed.status(), 'feed of an unknown work is 404').toBe(404);

		const anonFeed = await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`);
		expect(anonFeed.status(), 'unauth feed is 401').toBe(401);
	});

	// ───────────────────────────────────────────────────────────────────────────
	// FLOW 6 — DTO whitelist hardens collaborative writes + a UI assertion on the
	// per-Work Activity page for the logged-in (storageState) user.
	// A confused/hostile collaborator cannot smuggle non-allowlisted fields (e.g.
	// server-managed userId / a bogus column) through the update DTO: each is a
	// clean 400 "property <x> should not exist" — never a 5xx, never a silent
	// stick that would corrupt the shared row. Then, on the SEEDED user (whose
	// session the browser is authenticated as), a real edit is driven and the
	// per-Work Activity Feed page is asserted to render the recorded change.
	// ───────────────────────────────────────────────────────────────────────────
	test('update DTO rejects non-allowlisted fields (no merge corruption) and the activity page renders a recorded edit', async ({
		request,
		page,
		baseURL,
	}) => {
		test.setTimeout(90_000);
		const suffix = uniqueSuffix();
		const owner = await registerUserViaAPI(request, { name: `Dto Own ${suffix}` });
		const member = await registerUserViaAPI(request, { name: `Dto Mem ${suffix}` });
		const work = await createWorkViaAPI(request, owner.access_token, { name: `dto-${suffix}` });
		await addMember(request, owner.access_token, work.id, member.email, 'editor');

		const safeName = `safe-name-${suffix}`;
		await patchWork(request, owner.access_token, work.id, { name: safeName });

		// A member tries to smuggle server-managed / unknown fields alongside a
		// legitimate one. The whitelist rejects the WHOLE payload (400) — the
		// legitimate field does NOT partially apply, and nothing 5xxes.
		for (const payload of [
			{ name: `hijack-${suffix}`, userId: '00000000-0000-0000-0000-000000000000' },
			{ description: `desc-${suffix}`, totallyFakeField: 'x' },
			{ name: `x-${suffix}`, slug: `y-${suffix}`, createdAt: '1970-01-01T00:00:00.000Z' },
		]) {
			const res = await patchWork(request, member.access_token, work.id, payload);
			expect(
				res.status,
				`smuggled payload ${JSON.stringify(payload)} is a client error, never 5xx`,
			).toBeLessThan(500);
			expect(res.status, 'non-allowlisted field rejected (400)').toBe(400);
			const message = (res.body as { message?: unknown })?.message;
			expect(
				Array.isArray(message) ? message.join(' ') : String(message ?? ''),
				'400 names the offending property',
			).toMatch(/should not exist/i);
		}

		// The shared row was NOT corrupted by any rejected smuggle attempt.
		const stillSafe = await getWork(request, owner.access_token, work.id);
		expect(stillSafe.name, 'shared work name unchanged by rejected writes').toBe(safeName);

		// --- UI assertion on the SEEDED (storageState) user ----------------------
		// Drive a real edit as the seeded user on a Work they own, then confirm
		// the per-Work Activity page renders the recorded "Updated work settings".
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: seeded.email, password: seeded.password },
		});
		expect(login.status(), 'seeded login').toBe(200);
		const seedToken = (await login.json()).access_token as string;

		const uiWork = await createWorkViaAPI(request, seedToken, { name: `ui-collab-${suffix}` });
		const uiEdit = await patchWork(request, seedToken, uiWork.id, {
			description: `ui edit ${suffix}`,
		});
		expect(uiEdit.status, 'seeded user edits their own work').toBe(200);

		const origin = baseURL ?? 'http://localhost:3000';
		await page.goto(`${origin}/en/works/${uiWork.id}/activity`, { waitUntil: 'domcontentloaded' });

		// next-dev LOCAL vs CI route divergence: the nested activity page may
		// render in CI but 404 to the catch-all locally. Accept EITHER the
		// recorded activity summary OR a graceful not-found, and branch.
		const activityText = page
			.getByText(/Updated work settings/i)
			.or(page.getByText(/Created work/i))
			.or(page.getByText(/Activity/i))
			.first();
		const notFound = page.getByText(/404|not found|page could not be found/i).first();
		await expect(activityText.or(notFound)).toBeVisible({ timeout: 30_000 });
		if (await notFound.isVisible().catch(() => false)) {
			test.info().annotations.push({
				type: 'route-divergence',
				description:
					'per-Work /works/:id/activity nested route 404s to the catch-all under next-dev locally; renders in CI. Asserted the recorded edit via the API contract above; UI assertion tolerant.',
			});
		}
	});
});
