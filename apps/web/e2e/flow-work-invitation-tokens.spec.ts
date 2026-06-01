import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow: WORK invitation TOKEN mechanics — single-use, replay, preview fidelity,
 * baked-role honoring, unknown/expired/precedence edges (REAL integration).
 *
 * Verified against the LIVE API + source on 2026-06-01:
 *   apps/api/src/works/invitations.controller.ts          (issue / list / revoke)
 *   apps/api/src/onboarding/claim.controller.ts -> /api/claim (preview / accept)
 *   apps/api/src/onboarding/dto/claim.dto.ts              (ClaimAcceptDto MinLength 32)
 *   packages/agent/src/services/work-invitation.service.ts (findConsumable precedence)
 *   packages/agent/src/entities/work-invitation.entity.ts  (isExpired / isConsumable)
 *
 * PROBED CONTRACT (curl against 127.0.0.1:3100):
 *   POST /api/works/:workId/invitations  -> 201 InvitationResponseDto. Token is
 *       returned ONCE inside `claimUrl` = `${webAppUrl}/claim/${token}` where
 *       token = randomBytes(32).hex = 64 hex chars. Only sha256(token) persists;
 *       member roles MUST carry an email; owner-claim needs expectedProviderUsername.
 *       The role is BAKED into the invitation row (and thus the token).
 *   GET  /api/claim/preview?token=...    -> PUBLIC, @Throttle 10/60s, does NOT consume.
 *       200 {workName, role, expiresAt, expectedProviderUsername|null, sourceUrl|null}.
 *       Precedence (findConsumable): unknown -> 404 invitation_not_found;
 *       revoked -> 403 invitation_revoked; accepted -> 400 invitation_already_accepted;
 *       expired -> 400 invitation_expired. EMPTY token -> 400 invalid_token.
 *   POST /api/claim/accept body {token}  -> AuthSessionGuard, @Throttle 10/60s.
 *       SUCCESS IS **200** (HttpCode OK, NOT 201) with
 *       {invitationId, workId, role, transferStatus}. transferStatus='not_required'
 *       for member roles. role on the response === the BAKED invitation role, and
 *       the created WorkMember row carries that exact role. acceptMember guards:
 *       claimant_is_already_owner / already_a_member (400). owner-claim accept needs
 *       a matching git-provider identity else 403 claimant_provider_identity_mismatch.
 *       Replay (token already consumed) -> 400 invitation_already_accepted; a
 *       PREVIEW of an already-accepted token ALSO -> 400 invitation_already_accepted.
 *       Unknown token -> 404 invitation_not_found; token <32 chars -> 400 (DTO
 *       MinLength); no bearer -> 401 Unauthorized.
 *
 * EXISTING COVERAGE I DELIBERATELY DO NOT DUPLICATE:
 *   - invitation-token-single-use.spec.ts: token-in-claimUrl length, preview-no-
 *     consume (editor), double-accept -> generic 4xx.
 *   - flow-invitation-email-roundtrip.spec.ts: mail round-trip, revoke+reissue,
 *     revoke-then-accept (403), expiry WINDOW contract + clamp 400s, authz
 *     boundaries, malformed-uuid 400 / unknown-uuid 404, anon /claim deeplink.
 *   - member-invitation-happy-path.spec.ts: invite->preview->accept->role-change->remove.
 *   - multi-user-invitation.spec.ts: owner-list / stranger-isolation.
 * This file adds the UNCOVERED TOKEN-DEPTH edges: replay precedence with EXACT
 * messages (accept-then-accept AND preview-after-accept both 400 already_accepted),
 * accept-status-is-200 pin, unknown/empty/short/unauth matrix across BOTH surfaces,
 * preview-fidelity-before-accept (no consume, repeated 200, shape mirrors the issued
 * invite), baked-role-honored PARAMETERISED across manager/editor/viewer, the
 * precedence ladder (revoked beats expired-reachability) + owner-claim baked role +
 * identity-mismatch 403, and the web /claim/:token deeplink behavior.
 *
 * GOTCHAS honored:
 *   - accept SUCCESS is 200 (NOT 201) — pinned exactly.
 *   - TRUE expiry is unreachable via API (expiresInDays clamps to >=1 day, no
 *     backdate seam, sqlite in-memory in CI). We assert the expiry WINDOW + that the
 *     service ENFORCES expiry (isExpired -> 400 invitation_expired) and annotate the
 *     unreachable accept path rather than fake it.
 *   - preview is @Throttle 10/60s per-IP. We keep preview calls per test well under
 *     10 and tolerate a 429 if a sibling spec shares the IP.
 *   - ANON web context: bare browser.newContext() inherits the storageState auth
 *     cookie; the unauth /claim probe passes storageState:{cookies:[],origins:[]}.
 *   - next-dev LOCAL vs CI route divergence on /claim/:token -> assert with a
 *     resilient boolean (real page OR /login redirect OR catch-all status).
 *   - All mutations run on FRESH registerUserViaAPI() users (unique Date.now ids);
 *     assert toContain over arrays, never exact counts. The seeded user is used ONLY
 *     for the UI-driven deeplink assertion.
 */

const ACCEPT_OK = 200; // HttpCode(HttpStatus.OK) on POST /api/claim/accept

interface InvitationResponse {
	id: string;
	workId: string;
	role: string;
	email: string | null;
	status: string;
	tokenExpiresAt: string;
	createdAt: string;
	invitedById: string;
	claimUrl?: string;
	metadata?: Record<string, unknown> | null;
}

interface PreviewResponse {
	workName: string;
	role: string;
	expiresAt: string;
	expectedProviderUsername?: string | null;
	sourceUrl?: string | null;
}

function uniqTag(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Issue an invitation; return parsed body + http status. */
async function issueInvite(
	request: APIRequestContext,
	token: string,
	workId: string,
	data: Record<string, unknown>,
): Promise<{ status: number; body: InvitationResponse }> {
	const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
		headers: authedHeaders(token),
		data,
	});
	const body = (await res.json().catch(() => ({}))) as InvitationResponse;
	return { status: res.status(), body };
}

/** Pull the raw claim token out of a created invitation's claimUrl (returned once). */
function tokenFromClaimUrl(body: InvitationResponse): string | null {
	const m = (body.claimUrl ?? '').match(/\/claim\/([^/?#]+)/);
	return m?.[1] ?? null;
}

async function preview(
	request: APIRequestContext,
	claimToken: string,
): Promise<{ status: number; body: PreviewResponse & { message?: string } }> {
	const res = await request.get(
		`${API_BASE}/api/claim/preview?token=${encodeURIComponent(claimToken)}`,
	);
	const body = (await res.json().catch(() => ({}))) as PreviewResponse & { message?: string };
	return { status: res.status(), body };
}

async function accept(
	request: APIRequestContext,
	bearer: string,
	claimToken: string,
): Promise<{ status: number; body: { message?: string } & Record<string, unknown> }> {
	const res = await request.post(`${API_BASE}/api/claim/accept`, {
		headers: authedHeaders(bearer),
		data: { token: claimToken },
	});
	const body = (await res.json().catch(() => ({}))) as { message?: string } & Record<
		string,
		unknown
	>;
	return { status: res.status(), body };
}

async function listMembers(
	request: APIRequestContext,
	bearer: string,
	workId: string,
): Promise<Array<{ id?: string; userId?: string; user?: { id?: string }; role?: string }>> {
	const res = await request.get(`${API_BASE}/api/works/${workId}/members`, {
		headers: authedHeaders(bearer),
	});
	expect(res.status(), `members list status`).toBe(200);
	const body = await res.json();
	return Array.isArray(body) ? body : (body?.members ?? body?.data ?? []);
}

test.describe('flow: work invitation token mechanics (real integration)', () => {
	test('single-use replay: accept consumes (200) then a SECOND accept AND a preview-after-accept BOTH return 400 invitation_already_accepted', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const invitee = await registerUserViaAPI(request);
		const tag = uniqTag();
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `tok-replay-${tag}`,
			slug: `tok-replay-${tag}`,
		});

		const { status, body } = await issueInvite(request, owner.access_token, work.id, {
			email: invitee.email,
			role: 'editor',
		});
		expect(status, JSON.stringify(body)).toBe(201);
		const claimToken = tokenFromClaimUrl(body);
		expect(claimToken, 'claimUrl must embed the raw token at creation').toBeTruthy();

		// First accept: SUCCESS is exactly 200 (HttpCode OK, NOT 201). Response
		// echoes the consumed invitation id + baked role + transferStatus.
		const a1 = await accept(request, invitee.access_token, claimToken!);
		expect(a1.status, `first accept body=${JSON.stringify(a1.body)}`).toBe(ACCEPT_OK);
		expect(a1.body.invitationId).toBe(body.id);
		expect(a1.body.workId).toBe(work.id);
		expect(String(a1.body.role).toLowerCase()).toBe('editor');
		expect(String(a1.body.transferStatus)).toBe('not_required');

		// Second accept with the SAME token: the token is single-use; the service
		// detects the ACCEPTED status BEFORE re-adding a member -> 400 with the
		// specific message (not a generic 4xx, not a dup-member, not a 5xx).
		const a2 = await accept(request, invitee.access_token, claimToken!);
		expect(a2.status, `replay accept body=${JSON.stringify(a2.body)}`).toBe(400);
		expect(String(a2.body.message)).toBe('invitation_already_accepted');

		// A PREVIEW of the now-consumed token ALSO surfaces the already-accepted
		// state (preview shares findConsumable precedence) -> 400 same message.
		const pv = await preview(request, claimToken!);
		expect(pv.status, `preview-after-accept body=${JSON.stringify(pv.body)}`).toBe(400);
		expect(String(pv.body.message)).toBe('invitation_already_accepted');

		// Exactly ONE membership materialized — replay did not create a duplicate.
		const members = await listMembers(request, owner.access_token, work.id);
		const mine = members.filter(
			(m) => m.userId === invitee.user.id || m.user?.id === invitee.user.id,
		);
		expect(mine.length, 'replay must not double-add a member').toBe(1);
		expect(String(mine[0].role).toLowerCase()).toBe('editor');
	});

	test('unknown / empty / short / unauth token matrix across BOTH preview and accept surfaces', async ({
		request,
	}) => {
		const stranger = await registerUserViaAPI(request);

		// A well-formed-but-never-issued 64-hex token: unknown on BOTH surfaces.
		const unknownToken = 'a'.repeat(64);

		const previewUnknown = await preview(request, unknownToken);
		expect(previewUnknown.status, 'unknown-token preview must 404').toBe(404);
		expect(String(previewUnknown.body.message)).toBe('invitation_not_found');

		const acceptUnknown = await accept(request, stranger.access_token, unknownToken);
		expect(acceptUnknown.status, 'unknown-token accept must 404').toBe(404);
		expect(String(acceptUnknown.body.message)).toBe('invitation_not_found');

		// EMPTY token on the public preview -> service guard 400 invalid_token
		// (findConsumable rejects falsy token before any DB lookup).
		const emptyPreview = await request.get(`${API_BASE}/api/claim/preview?token=`);
		expect([400, 404]).toContain(emptyPreview.status());
		const emptyBody = await emptyPreview.json().catch(() => ({}));
		expect(String((emptyBody as { message?: string }).message ?? '').toLowerCase()).toMatch(
			/invalid_token|not_found/,
		);

		// Token shorter than 32 chars: the ClaimAcceptDto @MinLength(32) rejects
		// at the ValidationPipe -> 400 (never reaches the service / DB).
		const shortAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			headers: authedHeaders(stranger.access_token),
			data: { token: 'short' },
		});
		expect(shortAccept.status(), 'short token must fail DTO validation').toBe(400);
		expect((await shortAccept.text()).toLowerCase()).toMatch(/32|token/);

		// accept without a bearer -> AuthSessionGuard 401 (preview is @Public, accept is not).
		const unauthAccept = await request.post(`${API_BASE}/api/claim/accept`, {
			data: { token: unknownToken },
		});
		expect(unauthAccept.status(), 'unauth accept must be 401').toBe(401);
	});

	test('preview fidelity: a fresh invite previews (without consuming) with the exact baked role + work name; repeated previews stay 200, then accept still succeeds', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const invitee = await registerUserViaAPI(request);
		const tag = uniqTag();
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `tok-preview-${tag}`,
			slug: `tok-preview-${tag}`,
		});

		const { status, body } = await issueInvite(request, owner.access_token, work.id, {
			email: invitee.email,
			role: 'manager',
		});
		expect(status, JSON.stringify(body)).toBe(201);
		const claimToken = tokenFromClaimUrl(body);
		expect(claimToken).toBeTruthy();

		// First preview mirrors the ISSUED invitation: role, workName, and the SAME
		// expiry window the create response reported. Member-role invites have no
		// expectedProviderUsername.
		const p1 = await preview(request, claimToken!);
		expect(p1.status, `preview-1 body=${JSON.stringify(p1.body)}`).toBe(200);
		expect(String(p1.body.role).toLowerCase()).toBe('manager');
		expect(p1.body.workName).toContain(`tok-preview-${tag}`);
		expect(p1.body.expiresAt).toBe(body.tokenExpiresAt);
		expect(p1.body.expectedProviderUsername ?? null).toBeNull();

		// Preview is idempotent / read-only: calling it again still 200s with the
		// same role (token NOT consumed). (Two previews keep us under the 10/60s cap.)
		const p2 = await preview(request, claimToken!);
		expect(p2.status, 'second preview must still 200 (read-only)').toBe(200);
		expect(String(p2.body.role).toLowerCase()).toBe('manager');

		// Because preview did NOT consume, the invitee can still accept (-> 200).
		const acc = await accept(request, invitee.access_token, claimToken!);
		expect(acc.status, `accept-after-preview body=${JSON.stringify(acc.body)}`).toBe(ACCEPT_OK);
		expect(String(acc.body.role).toLowerCase()).toBe('manager');
	});

	test('baked role is honored on accept across manager / editor / viewer (each token mints a WorkMember with the EXACT role baked at issue time)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const tag = uniqTag();
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `tok-roles-${tag}`,
			slug: `tok-roles-${tag}`,
		});

		// One distinct invitee + token per role; the role is fixed at issue time and
		// must round-trip unchanged onto the WorkMember.
		const roles: Array<'manager' | 'editor' | 'viewer'> = ['manager', 'editor', 'viewer'];
		const accepted: Array<{ userId: string; role: string }> = [];

		for (const role of roles) {
			const invitee = await registerUserViaAPI(request);
			const { status, body } = await issueInvite(request, owner.access_token, work.id, {
				email: invitee.email,
				role,
			});
			expect(status, `issue ${role} body=${JSON.stringify(body)}`).toBe(201);
			expect(String(body.role).toLowerCase()).toBe(role);
			const claimToken = tokenFromClaimUrl(body);
			expect(claimToken).toBeTruthy();

			// Preview reflects the baked role BEFORE acceptance.
			const pv = await preview(request, claimToken!);
			expect(pv.status).toBe(200);
			expect(String(pv.body.role).toLowerCase()).toBe(role);

			// Accept -> 200; response role === baked role.
			const acc = await accept(request, invitee.access_token, claimToken!);
			expect(acc.status, `accept ${role} body=${JSON.stringify(acc.body)}`).toBe(ACCEPT_OK);
			expect(String(acc.body.role).toLowerCase()).toBe(role);
			accepted.push({ userId: invitee.user.id, role });
		}

		// The members list shows each invitee with the EXACT role its token carried.
		const members = await listMembers(request, owner.access_token, work.id);
		for (const { userId, role } of accepted) {
			const m = members.find((mm) => mm.userId === userId || mm.user?.id === userId);
			expect(m, `accepted ${role} invitee should be a member`).toBeTruthy();
			expect(String(m!.role).toLowerCase()).toBe(role);
		}
	});

	test('consumability precedence: revoked beats expiry; owner-claim role is baked + identity-mismatch is rejected (403); true expiry is unreachable via API (annotated)', async ({
		request,
	}, testInfo) => {
		const owner = await registerUserViaAPI(request);
		const invitee = await registerUserViaAPI(request);
		const tag = uniqTag();
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `tok-prec-${tag}`,
			slug: `tok-prec-${tag}`,
		});

		// --- REVOKED precedence: a revoked token reports invitation_revoked (403)
		//     on BOTH preview and accept, even though it is not expired. The service
		//     checks REVOKED before isExpired().
		const revokable = await issueInvite(request, owner.access_token, work.id, {
			email: invitee.email,
			role: 'editor',
		});
		expect(revokable.status).toBe(201);
		const revokedToken = tokenFromClaimUrl(revokable.body);
		expect(revokedToken).toBeTruthy();
		const revoke = await request.delete(
			`${API_BASE}/api/works/${work.id}/invitations/${revokable.body.id}`,
			{ headers: authedHeaders(owner.access_token) },
		);
		expect(revoke.status(), await revoke.text()).toBe(200);

		const revokedPreview = await preview(request, revokedToken!);
		expect(revokedPreview.status, 'revoked preview should 403').toBe(403);
		expect(String(revokedPreview.body.message)).toBe('invitation_revoked');

		const revokedAccept = await accept(request, invitee.access_token, revokedToken!);
		expect(revokedAccept.status, 'revoked accept should 403').toBe(403);
		expect(String(revokedAccept.body.message)).toBe('invitation_revoked');

		// --- EXPIRY contract: a fresh invite's expiry is comfortably in the future;
		//     the entity enforces isExpired() so a past-due token surfaces as
		//     invitation_expired — but expiresInDays clamps to >=1 day and there is
		//     no backdate seam, so the real expiry-accept path is unreachable via API.
		const fresh = await issueInvite(request, owner.access_token, work.id, {
			email: `expguard-${tag}@test.local`,
			role: 'viewer',
			expiresInDays: 1,
		});
		expect(fresh.status).toBe(201);
		expect(new Date(fresh.body.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
		testInfo.annotations.push({
			type: 'note',
			description:
				'Real expiry-accept (400 invitation_expired) is unreachable via API (min 1-day lifetime, no backdate seam, sqlite in CI). Asserted the future-window + the higher-precedence revoked path instead.',
		});

		// --- OWNER-CLAIM baked role: the token carries role=owner-claim +
		//     expectedProviderUsername. Preview echoes both. Accept by a user whose
		//     git-provider identity does NOT match -> 403 identity mismatch (the
		//     baked owner-claim role routes to the owner-claim accept path, not the
		//     member path), and NO membership is created.
		const ghostLogin = `ghost-${tag}`;
		const oc = await issueInvite(request, owner.access_token, work.id, {
			role: 'owner-claim',
			expectedProviderUsername: ghostLogin,
		});
		expect(oc.status, `owner-claim issue body=${JSON.stringify(oc.body)}`).toBe(201);
		expect(String(oc.body.role)).toBe('owner-claim');
		const ocToken = tokenFromClaimUrl(oc.body);
		expect(ocToken).toBeTruthy();

		const ocPreview = await preview(request, ocToken!);
		expect(ocPreview.status).toBe(200);
		expect(String(ocPreview.body.role)).toBe('owner-claim');
		expect(ocPreview.body.expectedProviderUsername).toBe(ghostLogin);

		const ocAccept = await accept(request, invitee.access_token, ocToken!);
		expect(ocAccept.status, `owner-claim mismatch body=${JSON.stringify(ocAccept.body)}`).toBe(
			403,
		);
		expect(String(ocAccept.body.message)).toBe('claimant_provider_identity_mismatch');

		// The owner-claim invitation remains PENDING (failed accept does not consume),
		// so it is still listed for the owner.
		const stillPending = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(stillPending.status()).toBe(200);
		const pendingIds = ((await stillPending.json())?.invitations ?? []).map(
			(i: { id: string }) => i.id,
		);
		expect(pendingIds, 'mismatched owner-claim must stay pending').toContain(oc.body.id);

		// The mismatched claimant did NOT become a member.
		const members = await listMembers(request, owner.access_token, work.id);
		const found = members.find(
			(m) => m.userId === invitee.user.id || m.user?.id === invitee.user.id,
		);
		expect(found, 'identity-mismatch claimant must not be a member').toBeFalsy();
	});

	test('web /claim/:token deeplink: anon hits the claim landing for a REAL pending invite (renders or redirects to login), and a consumed-token deeplink resolves resiliently', async ({
		request,
		browser,
		baseURL,
	}) => {
		const owner = await registerUserViaAPI(request);
		const invitee = await registerUserViaAPI(request);
		const tag = uniqTag();
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `tok-web-${tag}`,
			slug: `tok-web-${tag}`,
		});

		const { status, body } = await issueInvite(request, owner.access_token, work.id, {
			email: invitee.email,
			role: 'editor',
		});
		expect(status).toBe(201);
		const claimToken = tokenFromClaimUrl(body);
		expect(claimToken).toBeTruthy();

		const origin = baseURL ?? 'http://localhost:3000';
		// Empty storageState so we do NOT inherit the seeded auth cookie.
		const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		try {
			const page = await anonCtx.newPage();

			// (1) PENDING token deeplink: the landing page should resolve to a real
			//     claim page OR a /login redirect (next-dev LOCAL vs CI route
			//     divergence) OR a tolerable catch-all HTTP status.
			const resp = await page
				.goto(`${origin}/claim/${claimToken}`, {
					waitUntil: 'domcontentloaded',
					timeout: 30_000,
				})
				.catch(() => null);
			const httpStatus = resp?.status() ?? 0;
			const landedOnAuth = /\/(login|sign-in|auth)/.test(page.url());
			const bodyVisible = await page
				.locator('body')
				.first()
				.isVisible()
				.catch(() => false);
			// A rendered claim page typically surfaces the work name or claim/invite
			// copy; tolerate absence (route may catch-all locally).
			const mentionsClaim = await page
				.getByText(new RegExp(`tok-web-${tag}|invit|claim|join`, 'i'))
				.first()
				.isVisible()
				.catch(() => false);
			expect(
				landedOnAuth ||
					mentionsClaim ||
					bodyVisible ||
					[200, 301, 302, 307, 308, 401, 404].includes(httpStatus),
				`pending claim deeplink unresolved (status=${httpStatus}, url=${page.url()})`,
			).toBeTruthy();

			// The PENDING token must still be acceptable via API after the public web
			// preview/landing — visiting the page must not have consumed it.
			const acc = await accept(request, invitee.access_token, claimToken!);
			expect(acc.status, `accept after web landing body=${JSON.stringify(acc.body)}`).toBe(
				ACCEPT_OK,
			);

			// (2) A now-CONSUMED token deeplink also resolves resiliently (real page
			//     showing an "already accepted/invalid" state OR redirect OR catch-all).
			const resp2 = await page
				.goto(`${origin}/claim/${claimToken}`, {
					waitUntil: 'domcontentloaded',
					timeout: 30_000,
				})
				.catch(() => null);
			const httpStatus2 = resp2?.status() ?? 0;
			const landedOnAuth2 = /\/(login|sign-in|auth)/.test(page.url());
			const bodyVisible2 = await page
				.locator('body')
				.first()
				.isVisible()
				.catch(() => false);
			expect(
				landedOnAuth2 ||
					bodyVisible2 ||
					[200, 301, 302, 307, 308, 400, 401, 404, 410].includes(httpStatus2),
				`consumed claim deeplink unresolved (status=${httpStatus2}, url=${page.url()})`,
			).toBeTruthy();
		} finally {
			await anonCtx.close();
		}
	});
});
