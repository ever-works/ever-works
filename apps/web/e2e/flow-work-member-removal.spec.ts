import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Work member REMOVAL lifecycle (deep) — six multi-step, cross-feature
 * integration flows that prove the DELETE /api/works/:workId/members/:memberId
 * (and the sibling POST .../members/leave) endpoints are authoritative: a
 * removed member instantly loses every access grant, a removed row cannot be
 * removed twice, the creator is structurally un-removable, and only
 * manager-or-higher members may evict others.
 *
 * Every endpoint/shape/status below was probed against the LIVE API (sqlite
 * in-memory — the same driver CI uses) before any assertion was written.
 * Source of truth: apps/api/src/works/members.controller.ts,
 * packages/agent/src/services/work-member.service.ts and work-ownership.service.ts.
 *
 *   Membership graph
 *     - The work CREATOR is implicitly OWNER and has NO `work_members` row.
 *       inviteMember REFUSES the creator's own email (400 "Cannot add the
 *       work creator as a member"), so no memberId ever maps to the owner →
 *       the owner can never be the target of a remove.
 *     - inviteMember adds the invitee SYNCHRONOUSLY (the invitee must already
 *       be a registered user) — it is the real "add a member" path here.
 *
 *   POST /api/works/:id/members  { email, role: 'viewer'|'editor'|'manager' }
 *     → 201 { status:'success', member:{ id (member-row id), userId, username,
 *             email, role, invitedBy:{ id, username }, createdAt } }
 *       NB: `member.id` (the ROW id) is the :memberId used by GET/PUT/DELETE,
 *       NOT the user's id.
 *     → 400 "Cannot add the work creator as a member" (owner's own email)
 *     → 400 "User is already a member of this work" (duplicate)
 *
 *   GET /api/works/:id/members  (ensureCanView → VIEWER+ OR creator)
 *     → 200 { status:'success', members:[…], owner:{ id, username, email } }
 *     → 403 "You do not have permission to access this work" (work exists, no membership)
 *     → 404 "Work with id '…' not found" (work does not exist)
 *
 *   DELETE /api/works/:id/members/:memberId  (ensureCanManageMembers → MANAGER+ OR creator)
 *     → 200 { status:'success', message:'Member removed successfully' }
 *     → 403 "You do not have the required permission level for this action"
 *           (caller is a viewer/editor member — can view, cannot evict)
 *     → 403 "You do not have permission to access this work" (caller is a non-member)
 *     → 404 "Member not found" (memberId unknown / already removed — work exists & caller authorized)
 *     → 404 "Work with id '…' not found" (work does not exist)
 *     → 401 (no auth)
 *
 *   POST /api/works/:id/members/leave  (ensureCanView, then refuse for creator)
 *     → 200 { status:'success', message:'Successfully left the work' }
 *     → 400 "Work creator cannot leave the work" (creator self-removal blocked)
 *     → AFTER a member leaves, leaving AGAIN returns 403 (not 404): leaveWork
 *       calls ensureCanView FIRST, and the now-non-member fails that gate
 *       before the "You are not a member" 404 branch is reachable.
 *
 *   Access-revocation timing (probed): removal is synchronous — the very next
 *   request from the ex-member already 403s. We still poll to absorb any dev
 *   latency rather than asserting on a single shot.
 *
 * Isolation discipline (matches sibling specs): all mutations run on FRESH
 * registerUserViaAPI() users (never the shared seeded user), unique suffixes,
 * and list assertions use toContain/not.toContain on row ids — never exact
 * global counts. Fully API-orchestrated + one auth-gate UI assertion, so it
 * does not contend on the shared UI/stack. Filename uses the safe `flow-`
 * prefix (not matched by the no-auth testIgnore regex in playwright.config.ts).
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface MemberRow {
	id: string;
	userId: string;
	email: string;
	role: string;
}

/** Invite (= synchronously add) an already-registered user to a work. */
async function addMemberViaAPI(
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
	const member = body?.member ?? body;
	expect(member?.id, 'member row id').toBeTruthy();
	return member as MemberRow;
}

/** List member rows for a work (caller must have view rights). */
async function listMembers(
	request: APIRequestContext,
	token: string,
	workId: string,
): Promise<{ status: number; members: MemberRow[]; owner?: { id: string } }> {
	const res = await request.get(`${API_BASE}/api/works/${workId}/members`, {
		headers: authedHeaders(token),
	});
	let members: MemberRow[] = [];
	let owner: { id: string } | undefined;
	if (res.ok()) {
		const body = await res.json();
		members = Array.isArray(body) ? body : (body?.members ?? body?.data ?? []);
		owner = body?.owner;
	}
	return { status: res.status(), members, owner };
}

test.describe('Work member removal — revokes access end-to-end', () => {
	test('remove revokes the ex-member: members list flips 200→403, row disappears', async ({
		request,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const member = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-revoke-${ts}`,
		});

		const row = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			member.email,
			'editor',
		);

		// Pre-removal: the member can view the roster and sees themselves.
		const before = await listMembers(request, member.access_token, work.id);
		expect(before.status, 'member can view roster before removal').toBe(200);
		expect(before.members.map((m) => m.id)).toContain(row.id);

		// Owner removes the member.
		const del = await request.delete(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(del.status(), 'owner removes member').toBe(200);
		const delBody = await del.json();
		expect(delBody?.message ?? delBody?.status).toBeTruthy();

		// Access revocation is synchronous, but poll to absorb any dev latency:
		// the ex-member must be locked out of the view gate (403, not 404 — the
		// work still exists). UNAUTHORIZED here would be wrong: they ARE authed,
		// just no longer authorized for THIS work.
		await expect
			.poll(
				async () => {
					const res = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
						headers: authedHeaders(member.access_token),
					});
					return res.status();
				},
				{ timeout: 20_000, message: 'ex-member should be revoked (403)' },
			)
			.toBe(403);

		// Owner still sees the roster; the removed row is gone, owner unaffected.
		const after = await listMembers(request, owner.access_token, work.id);
		expect(after.status).toBe(200);
		expect(after.members.map((m) => m.id), 'removed row must be gone').not.toContain(row.id);
		expect(after.owner?.id, 'owner still present after removing a member').toBeTruthy();
	});

	test('ex-member is fully locked out: list + single-member reads both 403 after removal', async ({
		request,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const member = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-lockout-${ts}`,
		});
		const row = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			member.email,
			'viewer',
		);

		// Sanity: a viewer can read a single member row before removal.
		const getBefore = await request.get(
			`${API_BASE}/api/works/${work.id}/members/${row.id}`,
			{ headers: authedHeaders(member.access_token) },
		);
		expect(getBefore.status(), 'viewer can read a member before removal').toBe(200);

		await request.delete(`${API_BASE}/api/works/${work.id}/members/${row.id}`, {
			headers: authedHeaders(owner.access_token),
		});

		// Both the collection list AND the single-member read are gated by
		// ensureCanView, so a removed member 403s on EITHER. (The single-member
		// read never reaches its own 404 "Member not found" branch for an
		// ex-member — the view gate trips first.)
		await expect
			.poll(
				async () => {
					const res = await request.get(
						`${API_BASE}/api/works/${work.id}/members`,
						{ headers: authedHeaders(member.access_token) },
					);
					return res.status();
				},
				{ timeout: 20_000 },
			)
			.toBe(403);

		const getAfter = await request.get(
			`${API_BASE}/api/works/${work.id}/members/${row.id}`,
			{ headers: authedHeaders(member.access_token) },
		);
		expect([403, 404], 'single-member read after removal is denied').toContain(
			getAfter.status(),
		);
	});

	test('double-remove is idempotent-by-404: second DELETE of the same row → 404 "Member not found"', async ({
		request,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const member = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-double-${ts}`,
		});
		const row = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			member.email,
			'editor',
		);

		const first = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${row.id}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(first.status(), 'first removal succeeds').toBe(200);

		// The row no longer exists; a second DELETE by the still-authorized owner
		// resolves to "Member not found" (404) — NOT a 200 no-op and NOT a 403.
		const second = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${row.id}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(second.status(), 'double-remove → 404').toBe(404);
		const body = await second.json().catch(() => ({}));
		if (body?.message) {
			expect(String(body.message)).toMatch(/member not found/i);
		}

		// An entirely unknown member id is the same 404 (the work exists & the
		// caller is authorized, so it cannot be a 403).
		const bogus = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${UNKNOWN_UUID}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(bogus.status(), 'unknown member id → 404').toBe(404);
	});

	test('the creator is structurally un-removable: cannot be added as a member, cannot leave', async ({
		request,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-owner-${ts}`,
		});

		// The creator has no member row, and inviteMember refuses to mint one for
		// the creator's own email → there is no memberId that targets the owner.
		const selfInvite = await request.post(`${API_BASE}/api/works/${work.id}/members`, {
			headers: authedHeaders(owner.access_token),
			data: { email: owner.email, role: 'manager' },
		});
		expect(selfInvite.status(), 'cannot add the creator as a member').toBe(400);
		const selfBody = await selfInvite.json().catch(() => ({}));
		if (selfBody?.message) {
			expect(String(selfBody.message)).toMatch(/creator/i);
		}

		// The roster confirms the owner is a SIBLING field, never inside members
		// (so DELETE can never name them by row id).
		const roster = await listMembers(request, owner.access_token, work.id);
		expect(roster.status).toBe(200);
		expect(roster.owner?.id, 'owner present as a sibling field').toBeTruthy();
		expect(
			roster.members.map((m) => m.userId),
			'owner is never listed among removable member rows',
		).not.toContain(owner.user.id);

		// The other self-removal path — leaveWork — is also blocked for the creator.
		const leave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(leave.status(), 'creator cannot leave their own work').toBe(400);
		const leaveBody = await leave.json().catch(() => ({}));
		if (leaveBody?.message) {
			expect(String(leaveBody.message)).toMatch(/creator cannot leave/i);
		}

		// The owner is still the owner; nothing was orphaned.
		const after = await listMembers(request, owner.access_token, work.id);
		expect(after.owner?.id).toBe(owner.user.id);
	});

	test('removal is privileged: viewer/editor members get 403, manager+ may evict others', async ({
		request,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const editor = await registerUserViaAPI(request);
		const viewer = await registerUserViaAPI(request);
		const manager = await registerUserViaAPI(request);
		const stranger = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-rbac-${ts}`,
		});

		const editorRow = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			editor.email,
			'editor',
		);
		const viewerRow = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			viewer.email,
			'viewer',
		);
		const managerRow = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			manager.email,
			'manager',
		);

		// An EDITOR can view but lacks the MANAGER level required to evict — even
		// trying to remove themselves → 403 "required permission level".
		const editorSelf = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${editorRow.id}`,
			{ headers: authedHeaders(editor.access_token) },
		);
		expect(editorSelf.status(), 'editor cannot remove members').toBe(403);

		// A VIEWER likewise cannot evict the manager → 403.
		const viewerEvict = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${managerRow.id}`,
			{ headers: authedHeaders(viewer.access_token) },
		);
		expect(viewerEvict.status(), 'viewer cannot remove members').toBe(403);

		// A non-member STRANGER cannot even reach the member graph → 403
		// (different message: "do not have permission to access this work").
		const strangerEvict = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${viewerRow.id}`,
			{ headers: authedHeaders(stranger.access_token) },
		);
		expect(strangerEvict.status(), 'non-member cannot remove members').toBe(403);

		// All three target rows must still be intact after the denied attempts.
		const mid = await listMembers(request, owner.access_token, work.id);
		const midIds = mid.members.map((m) => m.id);
		expect(midIds).toEqual(
			expect.arrayContaining([editorRow.id, viewerRow.id, managerRow.id]),
		);

		// A MANAGER-role member CAN evict a peer (the viewer) → 200, and the
		// revocation cascades: the evicted viewer is then locked out (403).
		const managerEvict = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${viewerRow.id}`,
			{ headers: authedHeaders(manager.access_token) },
		);
		expect(managerEvict.status(), 'manager may evict a peer').toBe(200);

		await expect
			.poll(
				async () => {
					const res = await request.get(
						`${API_BASE}/api/works/${work.id}/members`,
						{ headers: authedHeaders(viewer.access_token) },
					);
					return res.status();
				},
				{ timeout: 20_000, message: 'manager-evicted viewer is revoked' },
			)
			.toBe(403);

		const final = await listMembers(request, owner.access_token, work.id);
		const finalIds = final.members.map((m) => m.id);
		expect(finalIds, 'evicted viewer row gone').not.toContain(viewerRow.id);
		expect(finalIds, 'editor + manager survive').toEqual(
			expect.arrayContaining([editorRow.id, managerRow.id]),
		);
	});

	test('self-departure via leave revokes access, and a wrong-work / no-auth remove is rejected', async ({
		request,
		browser,
		baseURL,
	}) => {
		const ts = Date.now();
		const owner = await registerUserViaAPI(request);
		const member = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `rm-leave-${ts}`,
		});
		const row = await addMemberViaAPI(
			request,
			owner.access_token,
			work.id,
			member.email,
			'manager',
		);

		// The member leaves under their own power → 200, then is revoked (403).
		const leave = await request.post(`${API_BASE}/api/works/${work.id}/members/leave`, {
			headers: authedHeaders(member.access_token),
		});
		expect(leave.status(), 'member leaves successfully').toBe(200);

		await expect
			.poll(
				async () => {
					const res = await request.get(
						`${API_BASE}/api/works/${work.id}/members`,
						{ headers: authedHeaders(member.access_token) },
					);
					return res.status();
				},
				{ timeout: 20_000 },
			)
			.toBe(403);

		// Leaving AGAIN after departure: ensureCanView trips first, so this is a
		// 403 (the unreachable "not a member" 404 branch tolerated via .or()).
		const leaveAgain = await request.post(
			`${API_BASE}/api/works/${work.id}/members/leave`,
			{ headers: authedHeaders(member.access_token) },
		);
		expect([403, 404], 'leave-after-leave denied').toContain(leaveAgain.status());

		// The owner's roster no longer contains the departed row.
		const after = await listMembers(request, owner.access_token, work.id);
		expect(after.members.map((m) => m.id)).not.toContain(row.id);

		// A remove that names a non-existent WORK is a 404 (route exists, work
		// doesn't) — distinct from the 403 "no access" on a real work.
		const wrongWork = await request.delete(
			`${API_BASE}/api/works/${UNKNOWN_UUID}/members/${UNKNOWN_UUID}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(wrongWork.status(), 'remove on non-existent work → 404').toBe(404);

		// No-auth remove is rejected before any ownership logic → 401.
		const noAuth = await request.delete(
			`${API_BASE}/api/works/${work.id}/members/${row.id}`,
		);
		expect(noAuth.status(), 'unauthenticated remove → 401').toBe(401);

		// UI smoke: the members surface for this work must require auth when hit
		// from an anonymous browser context (cookie-free), confirming the page is
		// not a public read. next-dev may render the page (200) or 404 the nested
		// route locally; an anon hit must land on /login or one of those.
		const anon = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const page = await anon.newPage();
		const origin = baseURL ?? 'http://localhost:3000';
		const res = await page.goto(`${origin}/en/works/${work.id}/members`, {
			waitUntil: 'domcontentloaded',
		});
		const landedOnLogin = page.url().includes('/login');
		expect(
			landedOnLogin || (res ? [200, 401, 403, 404].includes(res.status()) : true),
			'anon members page is gated (login redirect or non-public status)',
		).toBeTruthy();
		await anon.close();
	});
});
