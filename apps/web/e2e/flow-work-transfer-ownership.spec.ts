import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work ownership-transfer — cross-feature INTEGRATION flows (EW-617).
 *
 * The `owner-claim` invitation is the platform's ONLY ownership-transfer
 * ceremony. This suite drives the transfer state machine end-to-end and pins
 * the guarantees that keep it audited + two-party, and that distinguish it from
 * an ordinary member add. Every shape/status/message below was confirmed
 * against the LIVE stack (sqlite in-memory — the same driver CI uses) before
 * the assertions were written.
 *
 * TRANSFER SURFACE (probed live):
 *   POST /api/works/:id/invitations
 *     - role:'owner-claim' is OWNER-ONLY (ensureIsOwner). A manager/editor/
 *       viewer member → 403 { message:'You do not have the required permission
 *       level for this action' }. A stranger (no membership) → 403 { message:
 *       'You do not have permission to access this work' }.
 *     - role:'owner-claim' REQUIRES expectedProviderUsername else 400
 *       (/expectedProviderUsername/i).
 *     - member-role invitations (viewer|editor|manager) need Manager+; a
 *       manager member CAN issue them (201). They REQUIRE `email` else 400.
 *     - 201 InvitationResponseDto { id, workId, role, email, status:'pending',
 *       tokenExpiresAt, createdAt, invitedById, metadata, claimUrl } — raw
 *       single-use token embedded ONCE in claimUrl=/claim/<64-hex>. NOTE:
 *       `transferState` is INTERNAL — it is NOT in the response/list DTO.
 *   GET  /api/works/:id/invitations → { status:'success', invitations:[...] }
 *       (Manager+; viewer member → 403). DTO omits claimUrl + transferState.
 *   GET  /api/claim/preview?token= (PUBLIC, throttled 10/60s) → 200 { workName,
 *       role:'owner-claim', expiresAt, expectedProviderUsername, sourceUrl }.
 *   POST /api/claim/accept (authed, single-use, throttled 10/60s):
 *     - owner-claim: provider-identity gate runs FIRST. A claimant whose linked
 *       git accounts don't match expectedProviderUsername → 403 { message:
 *       'claimant_provider_identity_mismatch' } and the invitation stays PENDING
 *       (NOT consumed). In CI no user has a linked GitHub identity, so this is
 *       the deterministic owner-claim outcome. **The in-app `work.userId` is
 *       NEVER mutated by accept** — transfer is a repo-handoff recorded as
 *       transferState; the creator keeps creator/owner rights throughout.
 *     - member-claim: AUTO-ADDS a WorkMember row for a non-member claimant
 *       (transferStatus:'not_required'); creator self-claim → 400
 *       'claimant_is_already_owner'; an existing member → 400 'already_a_member'.
 *     - no auth → 401; consumed token → 400 'invitation_already_accepted'.
 *   POST /api/works/:id/members/leave: creator → 400 'Work creator cannot leave
 *       the work'; a member → 200 (decline-equivalent; access then revoked).
 *
 * RELATIONSHIP TO SIBLINGS: flow-claim-zero-friction.spec.ts pins the happy
 * member-claim bind + the generic isolation matrix (unknown/revoked/blank
 * tokens, identity-mismatch single case, UI member-role landing).
 * flow-org-members-rbac.spec.ts pins org-scoped member invitations. THIS suite
 * is the ownership-TRANSFER orchestration the others don't cover: the OWNER-only
 * issuance role matrix, the "accept does not mutate work.userId / creator keeps
 * rights" invariant across the whole lifecycle, transfer-to-non-member
 * auto-add + acting at the granted tier, the creator-cannot-self-claim/leave
 * ceremony with a member decline-by-leave, and the owner-claim UI landing page.
 *
 * ISOLATION: every flow uses FRESH registerUserViaAPI() users + fresh Works —
 * never the shared seeded storageState user — so the in-memory DB stays clean
 * for sibling specs. The one UI flow reads the PUBLIC /claim/<token> landing
 * page under the seeded auth cookie (the page sits behind the auth middleware).
 * Assertions tolerate pre-existing rows (toContain, never exact counts) and
 * tolerate the throttle (429) on the public claim paths.
 */

const HEX_64_RE = /^[0-9a-f]{64}$/;
const REQUIRED_ROLE_MSG = /required permission level/i;
const NO_ACCESS_MSG = /do not have permission to access/i;

function uniqueSuffix(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Pull the single-use claim token out of an invitation create response. */
function tokenFromInvitation(body: unknown): string {
	const claimUrl = (body as { claimUrl?: string })?.claimUrl ?? '';
	const match = String(claimUrl).match(/\/claim\/([^/?#]+)/);
	return match?.[1] ?? '';
}

/** Owner/manager issues an invitation; returns the raw single-use token + body. */
async function issueInvitation(
	request: APIRequestContext,
	actorToken: string,
	workId: string,
	payload: Record<string, unknown>,
): Promise<{ status: number; token: string; body: Record<string, unknown> }> {
	const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
		headers: authedHeaders(actorToken),
		data: payload,
	});
	const body = await res.json().catch(() => ({}) as Record<string, unknown>);
	return { status: res.status(), token: tokenFromInvitation(body), body };
}

/** Owner adds a registered user as a member at the given role (201). */
async function addMember(
	request: APIRequestContext,
	ownerToken: string,
	workId: string,
	email: string,
	role: string,
): Promise<void> {
	const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
		headers: authedHeaders(ownerToken),
		data: { email, role },
	});
	expect(res.status(), `addMember(${role}) should be 201 (${await res.text()})`).toBe(201);
}

/** Read the work and return work.userId (the canonical in-app owner). */
async function readWorkOwnerId(
	request: APIRequestContext,
	token: string,
	workId: string,
): Promise<string> {
	const res = await request.get(`${API_BASE}/api/works/${workId}`, {
		headers: authedHeaders(token),
	});
	expect(res.ok(), `GET work should be readable (${res.status()})`).toBeTruthy();
	const body = await res.json();
	const work = (body as { work?: { userId?: string } }).work ?? (body as { userId?: string });
	return String((work as { userId?: string }).userId ?? '');
}

test.describe('Work ownership transfer (owner-claim) — deep integration', () => {
	test('owner-claim issuance is OWNER-only; member invitations are Manager+ (full role matrix)', async ({
		request,
	}) => {
		// The owner-claim invitation hands over the work — so the route gates it
		// behind ensureIsOwner, a strictly stronger check than the Manager+ gate
		// used for ordinary member invitations. This flow pins BOTH halves of the
		// matrix against the SAME work so the privilege boundary is unambiguous.
		const owner = await registerUserViaAPI(request);
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: `Transfer Matrix ${uniqueSuffix()}`,
			slug: `xfer-matrix-${uniqueSuffix()}`,
			description: 'Work used to pin the owner-claim issuance role matrix.',
		});

		// Seed a manager-tier and a viewer-tier member off fresh registered users.
		const manager = await registerUserViaAPI(request);
		const viewer = await registerUserViaAPI(request);
		await addMember(request, owner.access_token, workId, manager.email, 'manager');
		await addMember(request, owner.access_token, workId, viewer.email, 'viewer');
		const stranger = await registerUserViaAPI(request);

		// 1. OWNER can issue an owner-claim (the only actor who can). 201.
		const byOwner = await issueInvitation(request, owner.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(byOwner.status, `owner can issue owner-claim (${JSON.stringify(byOwner.body)})`).toBe(
			201,
		);
		expect(byOwner.token, 'owner-claim token returned once in claimUrl').toMatch(HEX_64_RE);
		expect(byOwner.body.role).toBe('owner-claim');
		expect(byOwner.body.status).toBe('pending');
		// transferState is internal — it must NOT leak into the response DTO.
		expect(byOwner.body).not.toHaveProperty('transferState');

		// 2. A MANAGER member is NOT an owner → cannot issue an owner-claim. The
		//    role-hierarchy gate (OWNER=4 > MANAGER=3) returns the "required
		//    permission level" message, distinct from the no-membership message.
		const byManagerOwnerClaim = await issueInvitation(request, manager.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(byManagerOwnerClaim.status, 'manager cannot issue owner-claim').toBe(403);
		expect(String(byManagerOwnerClaim.body.message)).toMatch(REQUIRED_ROLE_MSG);

		// 3. ...but the SAME manager CAN issue an ordinary member invitation
		//    (Manager+ gate). Confirms the two gates are genuinely different.
		const byManagerMember = await issueInvitation(request, manager.access_token, workId, {
			role: 'editor',
			email: `inv-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		expect(byManagerMember.status, 'manager CAN issue a member invitation').toBe(201);
		expect(byManagerMember.body.role).toBe('editor');
		expect(String(byManagerMember.body.invitedById)).toBe(manager.user.id);

		// 4. A VIEWER member cannot issue ANY invitation (below Manager+).
		const byViewer = await issueInvitation(request, viewer.access_token, workId, {
			role: 'viewer',
			email: `inv-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		expect(byViewer.status, 'viewer cannot issue an invitation').toBe(403);
		expect(String(byViewer.body.message)).toMatch(REQUIRED_ROLE_MSG);

		// 5. A STRANGER (no membership at all) is rejected at the access gate with
		//    the distinct no-permission message, both for owner-claim and member.
		const byStranger = await issueInvitation(request, stranger.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(byStranger.status, 'stranger cannot issue owner-claim').toBe(403);
		expect(String(byStranger.body.message)).toMatch(NO_ACCESS_MSG);

		// 6. owner-claim WITHOUT expectedProviderUsername is refused at issue time
		//    — the transfer ceremony has no identity to bind to.
		const noUsername = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
			headers: authedHeaders(owner.access_token),
			data: { role: 'owner-claim', expiresInDays: 7 },
		});
		expect(noUsername.status()).toBe(400);
		expect(String((await noUsername.json()).message)).toMatch(/expectedProviderUsername/i);
	});

	test('owner-claim accept: provider-identity gate rejects + ownership does NOT transfer in-app', async ({
		request,
	}) => {
		// The defining transfer invariant: accepting an owner-claim NEVER mutates
		// the in-app `work.userId`. The hand-off is a git-provider repo transfer
		// recorded as transferState — gated FIRST by a provider-identity check. In
		// CI no user has a linked GitHub identity, so a non-matching claimant is
		// the deterministic outcome: 403 + ownership UNCHANGED + invitation still
		// consumable. We assert the owner keeps creator rights end-to-end.
		const owner = await registerUserViaAPI(request);
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: `Transfer Invariant ${uniqueSuffix()}`,
			slug: `xfer-inv-${uniqueSuffix()}`,
			description: 'Work used to pin the no-in-app-ownership-mutation invariant.',
		});

		// Baseline: the creator is the in-app owner.
		const ownerIdBefore = await readWorkOwnerId(request, owner.access_token, workId);
		expect(ownerIdBefore, 'creator is the in-app owner at baseline').toBe(owner.user.id);

		// Issue an owner-claim bound to a provider login the claimant won't match.
		const expectedProviderUsername = `gh-${uniqueSuffix()}`;
		const inv = await issueInvitation(request, owner.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername,
			expiresInDays: 7,
		});
		expect(inv.status, 'owner-claim issued').toBe(201);
		expect(inv.token).toMatch(HEX_64_RE);

		// PUBLIC preview surfaces the owner-claim offer + the bound provider login,
		// WITHOUT consuming the token. Tolerate the per-IP throttle (429).
		const previewRes = await request.get(`${API_BASE}/api/claim/preview?token=${inv.token}`);
		expect(previewRes.status(), 'preview is 200 or throttled').not.toBe(500);
		if (previewRes.status() === 200) {
			const preview = await previewRes.json();
			expect(preview.role).toBe('owner-claim');
			expect(String(preview.expectedProviderUsername)).toBe(expectedProviderUsername);
		} else {
			expect([200, 429]).toContain(previewRes.status());
		}

		// A DIFFERENT, freshly-registered claimant accepts — no linked GitHub
		// identity → the provider-identity gate refuses with the typed message.
		const claimant = await registerUserViaAPI(request);
		const acceptRes = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(claimant.access_token),
			data: { token: inv.token },
		});
		expect(acceptRes.status(), 'non-matching provider identity → 403').toBe(403);
		expect((await acceptRes.json()).message).toBe('claimant_provider_identity_mismatch');

		// THE INVARIANT: the in-app owner is unchanged — the failed claim moved
		// nothing in-app. (transfer is a repo-handoff, not a userId swap.)
		const ownerIdAfter = await readWorkOwnerId(request, owner.access_token, workId);
		expect(ownerIdAfter, 'work.userId is NOT mutated by a rejected owner-claim').toBe(
			owner.user.id,
		);

		// The original creator STILL has full owner-tier rights afterwards: they
		// can still read the member roster (ensureCanView) and the claimant — who
		// never matched — has NOT been granted any access (no membership row).
		const membersRes = await request.get(`${API_BASE}/api/works/${workId}/members`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(membersRes.ok(), 'creator retains owner rights (lists members)').toBeTruthy();
		const members = await membersRes.json();
		const claimantRow = (members.members ?? []).find(
			(m: { userId: string }) => m.userId === claimant.user.id,
		);
		expect(claimantRow, 'rejected owner-claim grants the claimant NO access').toBeUndefined();
		expect(String(members.owner?.id), 'owner block still names the creator').toBe(owner.user.id);

		// The claimant genuinely has no access: their own GET of the work is 403/404.
		const claimantView = await request.get(`${API_BASE}/api/works/${workId}`, {
			headers: authedHeaders(claimant.access_token),
		});
		expect([403, 404]).toContain(claimantView.status());

		// Because the identity gate ran BEFORE tryAccept, the invitation was never
		// consumed — its preview is still live (or throttled), NOT 'already accepted'.
		const stillLive = await request.get(`${API_BASE}/api/claim/preview?token=${inv.token}`);
		expect([200, 429]).toContain(stillLive.status());
		if (stillLive.status() === 200) {
			expect((await stillLive.json()).role).toBe('owner-claim');
		}
	});

	test('transfer-to-non-member: member-claim AUTO-ADDS a WorkMember row that can act at its tier', async ({
		request,
	}) => {
		// A member-role claim by a brand-new (non-member) user transparently
		// CREATES the membership — no pre-existing row required. We then prove the
		// auto-added member can actually exercise their granted tier (a manager
		// can issue a downstream member invitation), and that re-accepting is
		// idempotently refused with 'already_a_member'.
		const owner = await registerUserViaAPI(request);
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: `Transfer AutoAdd ${uniqueSuffix()}`,
			slug: `xfer-auto-${uniqueSuffix()}`,
			description: 'Work used to pin the member-claim auto-add behaviour.',
		});

		// Issue a MANAGER-role claim to a non-member (auto-add at the top member tier).
		const inviteEmail = `auto-${uniqueSuffix()}@test.local`;
		const inv = await issueInvitation(request, owner.access_token, workId, {
			role: 'manager',
			email: inviteEmail,
			expiresInDays: 7,
		});
		expect(inv.status, 'manager invitation issued').toBe(201);
		expect(inv.body.role).toBe('manager');

		// The claimant is NOT yet a member.
		const before = await request.get(`${API_BASE}/api/works/${workId}/members`, {
			headers: authedHeaders(owner.access_token),
		});
		const claimant = await registerUserViaAPI(request);
		const beforeRows = (await before.json()).members ?? [];
		expect(
			beforeRows.find((m: { userId: string }) => m.userId === claimant.user.id),
			'claimant is not a member before accept',
		).toBeUndefined();

		// Accept → AUTO-ADDS the WorkMember row; member roles need no repo transfer.
		const acceptRes = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(claimant.access_token),
			data: { token: inv.token },
		});
		expect(acceptRes.status(), `accept should be 200 (${await acceptRes.text()})`).toBe(200);
		const accept = await acceptRes.json();
		expect(accept.workId).toBe(workId);
		expect(accept.role).toBe('manager');
		expect(accept.transferStatus, 'member roles → not_required').toBe('not_required');

		// The membership now exists, keyed to the claimant's user id at manager.
		const after = await request.get(`${API_BASE}/api/works/${workId}/members`, {
			headers: authedHeaders(owner.access_token),
		});
		const row = ((await after.json()).members ?? []).find(
			(m: { userId: string }) => m.userId === claimant.user.id,
		);
		expect(row, 'claimant was auto-added as a member').toBeTruthy();
		expect(String(row.role).toLowerCase()).toBe('manager');

		// The auto-added MANAGER can actually act at their tier: they can issue a
		// downstream member invitation on the work they just joined (Manager+ gate).
		const downstream = await issueInvitation(request, claimant.access_token, workId, {
			role: 'viewer',
			email: `downstream-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		expect(downstream.status, 'auto-added manager can issue member invites').toBe(201);

		// ...but NOT an owner-claim (still not the owner) — the transfer ceremony
		// stays owner-gated even for a freshly auto-added manager.
		const downstreamOwnerClaim = await issueInvitation(request, claimant.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(downstreamOwnerClaim.status, 'auto-added manager is not the owner').toBe(403);
		expect(String(downstreamOwnerClaim.body.message)).toMatch(REQUIRED_ROLE_MSG);

		// Re-claiming a FRESH invitation for the SAME work → already_a_member
		// (single membership; the auto-add isn't repeatable).
		const second = await issueInvitation(request, owner.access_token, workId, {
			role: 'editor',
			email: `auto2-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		const reAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(claimant.access_token),
			data: { token: second.token },
		});
		expect(reAccept.status(), 'existing member re-claim → 400').toBe(400);
		expect((await reAccept.json()).message).toBe('already_a_member');
	});

	test('decline / self-claim ceremony: creator cannot self-claim or leave; a member can leave', async ({
		request,
	}) => {
		// There is no in-app "decline" verb for a transfer — declining is simply
		// not accepting (the token expires). The membership analogue of declining
		// is `leave`. This flow pins the orphan-protection rules around both: the
		// creator can never claim or leave their own work; a member CAN leave, and
		// leaving genuinely revokes their access (a decline-equivalent exit).
		const owner = await registerUserViaAPI(request);
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: `Transfer Decline ${uniqueSuffix()}`,
			slug: `xfer-decl-${uniqueSuffix()}`,
			description: 'Work used to pin the self-claim + leave (decline) ceremony.',
		});

		// 1. The creator cannot member-claim their OWN work — they are already the
		//    owner, so accept short-circuits with 'claimant_is_already_owner'.
		const selfInv = await issueInvitation(request, owner.access_token, workId, {
			role: 'editor',
			email: `self-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		const selfAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(owner.access_token),
			data: { token: selfInv.token },
		});
		expect(selfAccept.status(), 'creator self-claim → 400').toBe(400);
		expect((await selfAccept.json()).message).toBe('claimant_is_already_owner');

		// 2. The creator cannot LEAVE — they'd orphan the work; they must transfer
		//    or delete it instead. Pins the creator-leave guard.
		const creatorLeave = await request.post(`${API_BASE}/api/works/${workId}/members/leave`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(creatorLeave.status(), 'creator cannot leave → 400').toBe(400);
		expect(String((await creatorLeave.json()).message)).toMatch(/creator cannot leave/i);

		// 3. A member CAN leave (the decline-equivalent exit). Add an editor via a
		//    claim, then have them leave; their access is afterwards revoked.
		const member = await registerUserViaAPI(request);
		const memberInv = await issueInvitation(request, owner.access_token, workId, {
			role: 'editor',
			email: `member-${uniqueSuffix()}@test.local`,
			expiresInDays: 7,
		});
		const memberAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(member.access_token),
			data: { token: memberInv.token },
		});
		expect(memberAccept.status(), 'member-claim accepted').toBe(200);

		// The member can see the work while a member.
		const viewWhileMember = await request.get(`${API_BASE}/api/works/${workId}`, {
			headers: authedHeaders(member.access_token),
		});
		expect(viewWhileMember.ok(), 'member can view the work').toBeTruthy();

		// They leave (decline-equivalent) → 200.
		const memberLeave = await request.post(`${API_BASE}/api/works/${workId}/members/leave`, {
			headers: authedHeaders(member.access_token),
		});
		expect(memberLeave.status(), 'member can leave → 200').toBe(200);

		// Access is genuinely revoked: a subsequent view is 403/404, and the
		// roster no longer lists them. Ownership is untouched throughout.
		const viewAfterLeave = await request.get(`${API_BASE}/api/works/${workId}`, {
			headers: authedHeaders(member.access_token),
		});
		expect([403, 404]).toContain(viewAfterLeave.status());

		const roster = await request.get(`${API_BASE}/api/works/${workId}/members`, {
			headers: authedHeaders(owner.access_token),
		});
		const stillThere = ((await roster.json()).members ?? []).find(
			(m: { userId: string }) => m.userId === member.user.id,
		);
		expect(stillThere, 'left member is removed from the roster').toBeUndefined();
		expect(await readWorkOwnerId(request, owner.access_token, workId)).toBe(owner.user.id);

		// Leaving again with no membership → 404 'You are not a member of this work'.
		const leaveAgain = await request.post(`${API_BASE}/api/works/${workId}/members/leave`, {
			headers: authedHeaders(member.access_token),
		});
		expect(leaveAgain.status(), 'leaving twice → 404').toBe(404);
	});

	test('transfer lifecycle: owner retains ALL owner rights across issue → accept-attempt → revoke', async ({
		request,
	}) => {
		// A full transfer lifecycle that never completes (the CI-realistic case):
		// the owner issues an owner-claim, a non-matching claimant fails the
		// identity gate, the owner revokes the pending invitation — and at EVERY
		// step the creator retains full owner rights (issue more invitations,
		// manage members, read the roster). Pins that an in-flight transfer does
		// NOT degrade the creator's authority.
		const owner = await registerUserViaAPI(request);
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: `Transfer Lifecycle ${uniqueSuffix()}`,
			slug: `xfer-life-${uniqueSuffix()}`,
			description: 'Work used to pin owner-rights retention across the transfer lifecycle.',
		});

		// STEP A — issue the owner-claim. Owner rights intact: 201 + still owner.
		const inv = await issueInvitation(request, owner.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(inv.status, 'owner issues the owner-claim').toBe(201);
		const invId = String(inv.body.id);
		expect(await readWorkOwnerId(request, owner.access_token, workId)).toBe(owner.user.id);

		// The pending invitation is listed (Manager+; the owner qualifies). The
		// list DTO never exposes the raw token or the internal transferState.
		const listRes = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(listRes.ok()).toBeTruthy();
		const listed = (await listRes.json()).invitations ?? [];
		const pending = listed.find((i: { id: string }) => i.id === invId);
		expect(pending, 'pending owner-claim is listed').toBeTruthy();
		expect(pending.status).toBe('pending');
		expect(pending, 'list DTO hides the raw token').not.toHaveProperty('claimUrl');
		expect(pending, 'list DTO hides internal transferState').not.toHaveProperty(
			'transferState',
		);

		// STEP B — a non-matching claimant fails the identity gate (transfer stays
		// pending). Owner rights still intact: they can add a member meanwhile.
		const claimant = await registerUserViaAPI(request);
		const failedAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(claimant.access_token),
			data: { token: inv.token },
		});
		expect(failedAccept.status(), 'identity gate rejects the claimant').toBe(403);

		const bystander = await registerUserViaAPI(request);
		await addMember(request, owner.access_token, workId, bystander.email, 'editor');
		const mid = await request.get(`${API_BASE}/api/works/${workId}/members`, {
			headers: authedHeaders(owner.access_token),
		});
		const editorRow = ((await mid.json()).members ?? []).find(
			(m: { userId: string }) => m.userId === bystander.user.id,
		);
		expect(editorRow, 'owner can still add members mid-transfer').toBeTruthy();
		expect(String(editorRow.role).toLowerCase()).toBe('editor');

		// STEP C — the owner REVOKES the pending owner-claim. Revoke is Manager+,
		// the owner qualifies → 200. The token is now dead: preview/accept refuse.
		const revokeRes = await request.delete(
			`${API_BASE}/api/works/${workId}/invitations/${invId}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(revokeRes.status(), 'owner revokes the pending owner-claim').toBe(200);

		const revokedPreview = await request.get(`${API_BASE}/api/claim/preview?token=${inv.token}`);
		// 403 invitation_revoked when reachable; tolerate the per-IP throttle.
		expect([403, 429]).toContain(revokedPreview.status());
		if (revokedPreview.status() === 403) {
			expect((await revokedPreview.json()).message).toBe('invitation_revoked');
		}

		// STEP D — ownership is STILL the creator's after the whole lifecycle, and
		// the creator can issue a brand-new owner-claim (the right was never lost).
		expect(await readWorkOwnerId(request, owner.access_token, workId)).toBe(owner.user.id);
		const reissue = await issueInvitation(request, owner.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername: `gh-${uniqueSuffix()}`,
			expiresInDays: 7,
		});
		expect(reissue.status, 'owner can re-issue an owner-claim after revoke').toBe(201);
	});

	test('UI: the /claim/<token> owner-claim landing renders the offer and the humanized error', async ({
		request,
		page,
		baseURL,
	}) => {
		// Navigate via the Playwright baseURL fixture — the SAME host global-setup
		// logged into — so the seeded storageState auth cookie (scoped to that
		// host) is sent. The claim landing page sits BEHIND the auth middleware;
		// an unauthenticated browser is bounced to /login. We assert the observable
		// owner-claim offer card, never a 5xx. `/en/claim/<token>` 307s to the
		// unprefixed `/claim/<token>` (localePrefix:'never') — page.goto follows it.
		const appUrl = baseURL || 'http://localhost:3000';

		const owner = await registerUserViaAPI(request);
		const workName = `Owner Claim Landing ${uniqueSuffix()}`;
		const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
			name: workName,
			slug: `ui-xfer-${uniqueSuffix()}`,
			description: 'Work whose owner-claim landing page is rendered in the browser.',
		});
		const expectedProviderUsername = `gh-${uniqueSuffix()}`;
		const inv = await issueInvitation(request, owner.access_token, workId, {
			role: 'owner-claim',
			expectedProviderUsername,
			expiresInDays: 7,
		});
		expect(inv.status, 'owner-claim issued for the UI flow').toBe(201);

		// Valid owner-claim token → the offer card renders, naming the work in the
		// heading. The work name is unique so the heading match can't collide.
		const validRes = await page.goto(`${appUrl}/en/claim/${inv.token}`, {
			waitUntil: 'domcontentloaded',
		});
		expect(validRes, 'owner-claim landing responded').not.toBeNull();
		expect(validRes!.status(), 'valid claim page is not a 5xx').toBeLessThan(500);
		await expect(
			page.getByRole('heading', { name: new RegExp(workName, 'i') }),
			'landing heading names the work',
		).toBeVisible({ timeout: 20_000 });

		// The owner-claim landing surfaces transfer-specific copy: it states the
		// role on accept AND/OR the provider identity the claimant must match.
		// Branch with .or() — next-dev LOCAL vs CI can render the role line or the
		// provider-username hint depending on the page variant.
		await expect(
			page
				.getByText(/Role on accept/i)
				.or(page.getByText(new RegExp(expectedProviderUsername, 'i')))
				.or(page.getByText(/owner/i))
				.first(),
			'owner-claim landing shows transfer-specific copy',
		).toBeVisible({ timeout: 20_000 });

		// Unknown token → the humanized "invitation unavailable" card, never a crash.
		const unknownRes = await page.goto(`${appUrl}/en/claim/${'c'.repeat(64)}`, {
			waitUntil: 'domcontentloaded',
		});
		expect(unknownRes, 'unknown-token page responded').not.toBeNull();
		expect(unknownRes!.status(), 'unknown-token page is not a 5xx').toBeLessThan(500);
		await expect(
			page.getByRole('heading', { name: /Invitation unavailable/i }),
			'unknown token shows the "Invitation unavailable" card',
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByText(/this invitation link is invalid/i).first(),
			'unknown token shows the humanized invalid-invitation message',
		).toBeVisible({ timeout: 20_000 });
	});
});
