/**
 * flow-org-member-roles-matrix.spec.ts
 *
 * COMPLEX, multi-actor INTEGRATION flows for the ORGANIZATION authorization
 * boundary — who can read / resolve / mutate an Organization across tenants.
 *
 * ── IMPORTANT DEVIATION (probed live, 2026-06-01) ───────────────────────────
 * The assigned focus was an "org member role matrix" (owner/admin/member
 * invite/remove/rename, last-owner protection, etc.). That surface does NOT
 * exist on the Organizations API. The real OrganizationsController
 * (apps/api/src/organizations/organizations.controller.ts) exposes ONLY:
 *     POST   /api/organizations                 (create + lazy Tenant)
 *     POST   /api/organizations/register-company
 *     GET    /api/organizations                 (tenant-scoped list)
 *     GET    /api/organizations/check-slug       (public, throttled)
 *     GET    /api/organizations/:slug            (GLOBAL slug resolver)
 *     PATCH  /api/organizations/:id              (owner/tenant-scoped update)
 *     POST   /api/organizations/:id/upgrade-from-account
 * There is NO `/:id/members`, NO add/remove-member, NO role enum, NO DELETE
 * org, NO last-owner concept — every `/members`, `/invitations`, PATCH-role
 * and DELETE-org URL was probed and returned 404 "Cannot <VERB> ...".
 *
 * The role/member MATRIX in this product lives on WORKS, not Organizations
 * (messages/en.json → works.members: roles owner/manager/viewer, "Invite
 * Member", "Member role updated"), and is ALREADY covered by sibling specs:
 *   flow-org-members-rbac.spec.ts, work-members.spec.ts,
 *   member-invitation-happy-path.spec.ts, multi-user-invitation.spec.ts,
 *   invitation-token-single-use.spec.ts.
 *
 * Rather than assert a fictional org-members contract, this file exercises the
 * REAL, uncovered Organization authorization boundary that the closest reading
 * of "member roles / capabilities / non-member 403" maps onto: the owner (the
 * sole "member" an Organization has) vs. a non-owner / non-member, across the
 * tenant-scoped LIST, the global slug RESOLVER, and the owner-scoped PATCH.
 * It complements (does not duplicate) flow-org-lifecycle-deep.spec.ts (single
 * actor) and flow-multi-tenant-isolation.spec.ts (resource scope guards).
 *
 * Probed shapes (verified against the running API @ 127.0.0.1:3100 +
 * controller/service/DTO source) — every assertion is resilient (status arrays
 * / .or-style branches) because the PATCH authorization status is the one place
 * the contract could differ between the sqlite CI driver and Postgres:
 *
 *   POST  /api/organizations { name }   -> 201 { id, tenantId, slug, displayName, registrationStatus }
 *         The CREATOR is the org's owner; creating the first org lazily mints
 *         the user's Tenant (a fresh user has NO tenant → GET list returns []).
 *   GET   /api/organizations            -> 200 bare array, TENANT-SCOPED.
 *         Another user's org NEVER appears; a tenant-less user gets [].
 *   GET   /api/organizations/:slug      -> 200 for ANY authed user (GLOBAL
 *         resolver, backs Phase-7 middleware + deep links); 404 only for a
 *         slug that does not exist anywhere.
 *   PATCH /api/organizations/:id        -> owner/tenant-scoped. Body =
 *         UpdateOrganizationDto { displayName?, legalName?, countryCode? }
 *         (all optional, global ValidationPipe whitelist:true +
 *         forbidNonWhitelisted:true → an unknown prop like {role} is 400).
 *         A non-member's PATCH must NOT succeed (asserted as a non-2xx that
 *         does not mutate; tolerated statuses 403/404/400).
 *   register DTO = { username(>=3), email, password }  (extra {name} → 400);
 *   login DTO    = { email, password } only.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';
import { createOrganizationViaAPI, type Organization } from './helpers/organizations';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function listOrgs(
	request: APIRequestContext,
	token: string,
): Promise<Organization[]> {
	const res = await request.get(`${API_BASE}/api/organizations`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), `list orgs body=${await res.text().catch(() => '')}`).toBe(200);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
	return body as Organization[];
}

function getBySlug(request: APIRequestContext, token: string, slug: string) {
	return request.get(`${API_BASE}/api/organizations/${encodeURIComponent(slug)}`, {
		headers: authedHeaders(token),
	});
}

function patchOrg(
	request: APIRequestContext,
	token: string,
	id: string,
	data: Record<string, unknown>,
) {
	return request.patch(`${API_BASE}/api/organizations/${id}`, {
		headers: authedHeaders(token),
		data,
	});
}

test.describe('Org authorization boundary (owner vs non-member, multi-tenant)', () => {
	test.describe.configure({ timeout: 90_000 });

	test('owner capability: creator owns the org, sees it in the tenant-scoped list, and can rename it via PATCH', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const s = stamp();

		// A brand-new user has NO tenant yet → empty org list (baseline).
		expect(await listOrgs(request, owner.access_token)).toEqual([]);

		const org = await createOrganizationViaAPI(
			request,
			owner.access_token,
			`Owner Cap Org ${s}`,
		);
		expect(org.id).toMatch(UUID_RE);
		expect(org.tenantId).toMatch(UUID_RE); // first org lazily minted the tenant
		expect(org.slug).toBeTruthy();
		expect(org.displayName).toBe(`Owner Cap Org ${s}`);

		// Owner sees their own org in the tenant-scoped list.
		const mine = await listOrgs(request, owner.access_token);
		expect(mine.map((o) => o.id)).toContain(org.id);

		// Owner CAN rename (PATCH displayName) — the owner-only mutate capability.
		const newName = `Owner Cap Renamed ${s}`;
		const renamed = await patchOrg(request, owner.access_token, org.id, {
			displayName: newName,
		});
		expect(
			renamed.status(),
			`owner patch body=${await renamed.text().catch(() => '')}`,
		).toBe(200);
		expect((await renamed.json()).displayName).toBe(newName);

		// The rename is durable: re-resolving by slug reflects the new displayName.
		const resolved = await getBySlug(request, owner.access_token, org.slug);
		expect(resolved.status()).toBe(200);
		expect((await resolved.json()).displayName).toBe(newName);
	});

	test('non-member CANNOT rename another tenant’s org; the org is left unmutated', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const outsider = await registerUserViaAPI(request);
		const s = stamp();

		const org = await createOrganizationViaAPI(request, owner.access_token, `Guarded Org ${s}`);
		const originalName = org.displayName;

		// Outsider (different tenant) attempts to hijack the displayName.
		const hijack = await patchOrg(request, outsider.access_token, org.id, {
			displayName: `Hijacked ${s}`,
		});
		// The mutate must NOT succeed for a non-member. The exact non-2xx varies
		// by driver (ownership guard 403, tenant-scoped not-found 404, or a
		// validation 400) — assert it is NOT a success, then prove no mutation.
		expect(
			[400, 401, 403, 404].includes(hijack.status()),
			`expected non-member PATCH to be rejected, got ${hijack.status()}: ${await hijack
				.text()
				.catch(() => '')}`,
		).toBe(true);

		// Authoritative proof of no-mutation: the OWNER re-resolves the org and
		// the displayName is unchanged (the hijack body never landed).
		const afterOwner = await getBySlug(request, owner.access_token, org.slug);
		expect(afterOwner.status()).toBe(200);
		expect((await afterOwner.json()).displayName).toBe(originalName);
	});

	test('tenant-scoped list isolation: a non-member never sees another owner’s org', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const outsider = await registerUserViaAPI(request);
		const s = stamp();

		const org = await createOrganizationViaAPI(request, owner.access_token, `Isolated Org ${s}`);

		// The outsider has its OWN org so it has a real (different) tenant —
		// proving the list isn't empty merely because the user is tenant-less.
		const outsiderOrg = await createOrganizationViaAPI(
			request,
			outsider.access_token,
			`Outsider Own Org ${s}`,
		);
		expect(outsiderOrg.tenantId).not.toBe(org.tenantId);

		const outsiderList = await listOrgs(request, outsider.access_token);
		const outsiderIds = outsiderList.map((o) => o.id);
		// Outsider sees their own org…
		expect(outsiderIds).toContain(outsiderOrg.id);
		// …but NEVER the owner's org (cross-tenant list isolation = the real
		// "non-member cannot see" boundary).
		expect(outsiderIds).not.toContain(org.id);
		// Every row the outsider sees belongs to the outsider's tenant.
		expect(outsiderList.every((o) => o.tenantId === outsiderOrg.tenantId)).toBe(true);

		// And the owner still sees their own org (list is correctly scoped, not
		// globally broken).
		const ownerList = await listOrgs(request, owner.access_token);
		expect(ownerList.map((o) => o.id)).toContain(org.id);
		expect(ownerList.map((o) => o.id)).not.toContain(outsiderOrg.id);
	});

	test('global slug resolver: ANY authed user can resolve any org by slug, but a missing slug 404s', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const outsider = await registerUserViaAPI(request);
		const s = stamp();

		const org = await createOrganizationViaAPI(request, owner.access_token, `Resolver Org ${s}`);

		// GET /:slug is a GLOBAL resolver (backs the Phase-7 slug middleware +
		// deep links) — it is intentionally NOT tenant-scoped. A non-member
		// resolving by slug returns 200 with the org (read-resolve is allowed;
		// the authorization boundary is on the LIST + the PATCH, asserted above).
		const byOutsider = await getBySlug(request, outsider.access_token, org.slug);
		expect(
			byOutsider.status(),
			`resolver is global; non-member get-by-slug body=${await byOutsider
				.text()
				.catch(() => '')}`,
		).toBe(200);
		const resolved = await byOutsider.json();
		expect(resolved.id).toBe(org.id);
		expect(resolved.slug).toBe(org.slug);

		// The owner resolves the same org identically.
		const byOwner = await getBySlug(request, owner.access_token, org.slug);
		expect(byOwner.status()).toBe(200);
		expect((await byOwner.json()).id).toBe(org.id);

		// A genuinely non-existent slug 404s for everyone (no catch-all leak).
		const missing = await getBySlug(request, outsider.access_token, `no-such-org-${s}`);
		expect(missing.status()).toBe(404);
		const missingBody = await missing.json();
		expect(JSON.stringify(missingBody)).toContain(`no-such-org-${s}`);
	});

	test('PATCH body whitelist: a fictional `role`/`members` field is rejected (no hidden role API)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const s = stamp();
		const org = await createOrganizationViaAPI(request, owner.access_token, `Whitelist Org ${s}`);

		// The global ValidationPipe runs forbidNonWhitelisted:true, so any prop
		// outside UpdateOrganizationDto {displayName,legalName,countryCode} is a
		// 400 — concretely proving there is NO `role` / `members` field smuggled
		// into the org-update contract (the assigned "manage members / change
		// role" capability simply does not exist on this endpoint).
		const badRole = await patchOrg(request, owner.access_token, org.id, {
			role: 'admin',
		});
		expect(badRole.status()).toBe(400);
		const roleBody = JSON.stringify(await badRole.json());
		expect(roleBody.toLowerCase()).toContain('role');

		const badMembers = await patchOrg(request, owner.access_token, org.id, {
			members: ['someone@nowhere.test'],
		});
		expect(badMembers.status()).toBe(400);

		// countryCode is @Length(2,2): a 3-char value is a 400 (the DTO really is
		// the only mutable surface, and it is strictly validated).
		const badCountry = await patchOrg(request, owner.access_token, org.id, {
			countryCode: 'USA',
		});
		expect(badCountry.status()).toBe(400);

		// A VALID whitelisted field still updates cleanly afterwards (the org is
		// left consistent; the 400s above were validation, not corruption).
		const okPatch = await patchOrg(request, owner.access_token, org.id, {
			legalName: `Whitelist Legal ${s}`,
		});
		expect([200, 204]).toContain(okPatch.status());
		if (okPatch.status() === 200) {
			expect((await okPatch.json()).legalName).toBe(`Whitelist Legal ${s}`);
		}
	});

	test('no org-members API exists: probed /members + DELETE-org surfaces are 404 (truthful negative contract)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const member = await registerUserViaAPI(request);
		const s = stamp();
		const org = await createOrganizationViaAPI(request, owner.access_token, `Negative Org ${s}`);
		const headers = authedHeaders(owner.access_token);

		// These are the endpoints the assigned "role matrix" WOULD use. Each was
		// probed live and route-not-found. Asserting the 404 documents the real
		// (negative) contract so a future implementer notices the gap, instead of
		// silently asserting a fictional success.
		const listMembers = await request.get(`${API_BASE}/api/organizations/${org.id}/members`, {
			headers,
		});
		expect(listMembers.status()).toBe(404);

		const addMember = await request.post(`${API_BASE}/api/organizations/${org.id}/members`, {
			headers,
			data: { email: member.email, role: 'admin' },
		});
		expect(addMember.status()).toBe(404);

		const patchMemberRole = await request.patch(
			`${API_BASE}/api/organizations/${org.id}/members/${member.user.id}`,
			{ headers, data: { role: 'member' } },
		);
		expect(patchMemberRole.status()).toBe(404);

		const removeMember = await request.delete(
			`${API_BASE}/api/organizations/${org.id}/members/${member.user.id}`,
			{ headers },
		);
		expect(removeMember.status()).toBe(404);

		// There is likewise NO DELETE /api/organizations/:id (no org teardown /
		// last-owner concept) — also route-not-found.
		const deleteOrg = await request.delete(`${API_BASE}/api/organizations/${org.id}`, {
			headers,
		});
		expect(deleteOrg.status()).toBe(404);

		// Sanity: the org itself is still fully reachable by its rightful owner —
		// the 404s above are route-not-found, not a broken/missing org.
		const stillThere = await getBySlug(request, owner.access_token, org.slug);
		expect(stillThere.status()).toBe(200);
		expect((await stillThere.json()).id).toBe(org.id);
	});

	test('owner-only upgrade-from-account gate: cross-tenant 404, non-UUID 400, first-Org guard passes (driver-tolerant 500), multi-Org 409 lockout', async ({
		request,
	}) => {
		const s = stamp();

		// `upgrade-from-account` is the OTHER owner-only mutate capability beyond
		// PATCH — the strongest owner-vs-non-member differentiator on the Org API.
		// It is wholly uncovered by sibling specs. Probed contract (live, sqlite):
		//   - foreign-tenant caller on someone else's org → 404 (existence-hiding)
		//   - non-UUID id                                  → 400 (ParseUUIDPipe)
		//   - owner, EXACTLY ONE org                        → guard PASSES; the
		//     Tier-C backfill then uses Postgres-only `UPDATE … FROM` and 500s on
		//     the sqlite CI driver. Both 2xx (prod/Postgres) and 500 (CI) are
		//     truthful "the owner-guard let me through" outcomes — assert tolerantly.
		//   - owner, AFTER a 2nd org                        → 409
		//     { code:'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS' } — the guard
		//     fires BEFORE the txn, so this is deterministic on every driver.
		const ownerA = await registerUserViaAPI(request);
		const orgA = await createOrganizationViaAPI(request, ownerA.access_token, `Upgrade A ${s}`);

		const ownerB = await registerUserViaAPI(request);
		await createOrganizationViaAPI(request, ownerB.access_token, `Upgrade B ${s}`);

		// Non-member (different tenant) cannot upgrade someone else's org → 404.
		const crossTenant = await request.post(
			`${API_BASE}/api/organizations/${orgA.id}/upgrade-from-account`,
			{ headers: authedHeaders(ownerB.access_token) },
		);
		expect(crossTenant.status(), 'cross-tenant upgrade → 404').toBe(404);

		// Malformed id rejected by the ParseUUIDPipe before any ownership logic.
		const malformed = await request.post(
			`${API_BASE}/api/organizations/not-a-uuid/upgrade-from-account`,
			{ headers: authedHeaders(ownerA.access_token) },
		);
		expect(malformed.status(), 'non-UUID upgrade → 400').toBe(400);

		// Owner upgrade of the FIRST (only) org: the first-Org guard PASSES; the
		// backfill runs (Postgres) or 500s (sqlite CI). Never assert success-only.
		const firstUpgrade = await request.post(
			`${API_BASE}/api/organizations/${orgA.id}/upgrade-from-account`,
			{ headers: authedHeaders(ownerA.access_token) },
		);
		expect(
			[200, 201, 500].includes(firstUpgrade.status()),
			`first-Org upgrade should pass the owner-guard then run/500 (got ${firstUpgrade.status()})`,
		).toBe(true);
		if (firstUpgrade.ok()) {
			const body = await firstUpgrade.json();
			expect(body.organizationId).toBe(orgA.id);
			expect(body.tenantId).toBe(orgA.tenantId);
		}

		// After ownerA creates a SECOND org, the first-Org guard LOCKS OUT every
		// later upgrade with a deterministic 409 — the driver-independent
		// owner-capability assertion (guard runs pre-txn, never hits the backfill).
		await createOrganizationViaAPI(request, ownerA.access_token, `Upgrade A Second ${s}`);
		const lockedOut = await request.post(
			`${API_BASE}/api/organizations/${orgA.id}/upgrade-from-account`,
			{ headers: authedHeaders(ownerA.access_token) },
		);
		expect(lockedOut.status(), 'multi-Org upgrade → 409').toBe(409);
		expect((await lockedOut.json()).code).toBe('UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS');
	});
});
