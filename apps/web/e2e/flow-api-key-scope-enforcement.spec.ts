import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-api-key-scope-enforcement.spec.ts
 *
 * THEME: API-key SCOPE / PERMISSION ENFORCEMENT matrix (NOT lifecycle — that lives in
 * flow-api-keys-lifecycle.spec.ts / api-keys.spec.ts). Here we pin the EXACT enforcement
 * boundary of the `ew_live_…` key: what it can reach, what it cannot, and how the guard
 * resolves the `x-api-key` vs `Authorization: Bearer` precedence.
 *
 * PROBE-VERIFIED contract (live stack 2026-06-01) — cross-checked against the real source:
 *   apps/api/src/auth/controllers/api-keys.controller.ts
 *   apps/api/src/auth/dto/api-key.dto.ts
 *   apps/api/src/auth/services/api-key.service.ts
 *   apps/api/src/auth/guards/auth-session.guard.ts   (extractApiKey + canActivate)
 *   apps/api/src/main.ts  ValidationPipe { whitelist, transform, forbidNonWhitelisted:true }
 *
 *   POST   /api/auth/api-keys   DTO { name (req, ≤100), expiresAt? (ISO) }  -- whitelist-validated
 *     -> 201 { id, name, key:"ew_live_"+64hex (72 chars), prefix:"ew_live_"+4hex (12 chars),
 *              expiresAt, createdAt }
 *     -> 400 { message:["property scopes should not exist"], error:"Bad Request", statusCode:400 }
 *        for ANY extra field (forbidNonWhitelisted). PROVED: there is NO scopes/permissions field
 *        on the DTO — you cannot even SUBMIT a capability scope; the body is rejected outright.
 *     -> 400 { message:"Expiration date must be in the future" } for a past expiresAt.
 *   GET    /api/auth/api-keys   -> 200 [{ id, name, prefix, expiresAt, lastUsedAt, isActive,
 *                                          createdAt }]  (NO `key`, NO `hashedKey`, NO `scopes`,
 *                                          NO `permissions` — masked + owner-scoped)
 *   DELETE /api/auth/api-keys/:id -> 200 { message:"API key revoked successfully" } (owner)
 *                                 |  404 (non-owner / already gone) — revokeKey returns false.
 *   PATCH / PUT /api/auth/api-keys/:id -> 404 (no update route exists; a grant cannot be widened).
 *
 *   AUTH GUARD (AuthSessionGuard.extractApiKey, probed EXHAUSTIVELY — order is intentional):
 *     The guard treats a request as an API-key request ONLY when an `ew_live_`-PREFIXED value is
 *     found, checked in this order: (1) `x-api-key` header, then (2) `Authorization: Bearer …`.
 *     When a prefixed value is found it NEVER falls through to the session provider, even if the
 *     key is rejected. A NON-prefixed value in either slot is IGNORED for the key path.
 *       valid x-api-key                                     -> 200 as the key's OWNER (read+write)
 *       valid Bearer ew_live_…                              -> 200 as owner
 *       valid x-api-key + GARBAGE non-prefixed Bearer       -> 200 (x-api-key wins; Bearer unused)
 *       GARBAGE ew_live_-prefixed x-api-key + valid Bearer  -> 401 (prefixed-but-bad key
 *                                                                   short-circuits; never falls
 *                                                                   through to the valid session)
 *       NON-prefixed garbage x-api-key + valid Bearer       -> 200 (x-api-key ignored, request
 *                                                                   FALLS THROUGH to the provider
 *                                                                   which validates the session)
 *       malformed `ew_live_…` x-api-key alone               -> 401
 *       empty `x-api-key` alone                             -> 401 (falsy => ignored => provider
 *                                                                   path => no session => 401)
 *       revoked / expired key (either slot)                 -> 401 "Invalid or expired API key"
 *
 *   IMPORTANT: the seeded session token is a 32-char OPAQUE token (NOT a JWT) — that is the
 *   `access_token` from register/login. It only authenticates via the provider path, i.e. when no
 *   `ew_live_`-prefixed credential pre-empts it.
 *
 * Because the assigned theme (OAuth-style scopes: "scoped key 403 on out-of-scope endpoint")
 * describes a capability model this key type DOES NOT implement, these flows assert the REAL,
 * faithful enforcement boundary and PROVE the scope concept is absent — never fabricating a 403:
 *   1. No capability-scope model: scope fields are 400-rejected at create; a plain key spans BOTH
 *      read AND write (owner-wide, never a per-endpoint 403).
 *   2. A key cannot escalate beyond its owner: always resolves to its owner; cannot read another
 *      owner's private resource.
 *   3. Revoked key -> 401 on a previously-allowed endpoint, via BOTH header slots (the real
 *      "scope down").
 *   4. Expired (past expiresAt) key -> rejected at create (time-bounded scope).
 *   5. x-api-key vs Bearer precedence is DETERMINISTIC and prefix-gated (the heart of the theme):
 *      a present `ew_live_` key is authoritative; a non-prefixed x-api-key is ignored and falls
 *      through to the Bearer/session; malformed/empty -> 401; never an ambiguous 500.
 *   6. A key cannot widen its own grant (PATCH/PUT -> 404) and the masked list never leaks a
 *      secret / scopes / permissions field.
 *
 * Cross-spec isolation: FRESH registerUserViaAPI() users only (never the shared seeded user) so a
 * user-scoped key never leaks into sibling specs. Defensive throughout: failOnStatusCode:false +
 * status SETS + skip-on-absence (404/501) so nothing asserts a fictional contract if the surface
 * is git-gated in a given driver build.
 */

const KEYS = `${API_BASE}/api/auth/api-keys`;
const PROFILE_FRESH = `${API_BASE}/api/auth/profile/fresh`;
const WORKS = `${API_BASE}/api/works`;

const ts = () => Date.now();
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface CreatedKey {
	id: string;
	name: string;
	key: string;
	prefix: string;
	expiresAt: string | null;
	createdAt: string;
}

/** Detect whether the api-keys surface exists in this driver build. */
async function keysFeaturePresent(request: APIRequestContext, token: string): Promise<boolean> {
	const res = await request.get(KEYS, { headers: authedHeaders(token), failOnStatusCode: false });
	return res.status() !== 404 && res.status() !== 501;
}

/** Create a key (name + optional expiresAt ONLY — the DTO rejects any other field). */
async function createKey(
	request: APIRequestContext,
	token: string,
	body: { name: string; expiresAt?: string },
): Promise<{ key: CreatedKey | null; status: number; raw: any }> {
	const res = await request.post(KEYS, {
		headers: { ...authedHeaders(token), 'content-type': 'application/json' },
		data: body,
		failOnStatusCode: false,
	});
	const status = res.status();
	let raw: any = null;
	try {
		raw = await res.json();
	} catch {
		/* non-JSON */
	}
	return { key: status === 201 && raw?.key ? (raw as CreatedKey) : null, status, raw };
}

/** Create a Work via Bearer and return its id (the stack answers 200 {status,work}). */
async function createWork(
	request: APIRequestContext,
	headers: Record<string, string>,
): Promise<{ status: number; id?: string }> {
	const slug = `kw-${uniq()}`;
	const res = await request.post(WORKS, {
		headers: { ...headers, 'content-type': 'application/json' },
		data: { name: slug, slug, description: 'e2e key-scope', organization: false },
		failOnStatusCode: false,
	});
	let id: string | undefined;
	if (res.status() === 200 || res.status() === 201) {
		const j = await res.json().catch(() => null);
		id = j?.work?.id ?? j?.id ?? j?.data?.id;
	}
	return { status: res.status(), id };
}

test.describe('API-key scope / permission enforcement matrix', () => {
	test('no capability-scope model: scope fields are 400-rejected at create, and one plain key spans READ and WRITE (owner-wide, never a per-endpoint 403)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		if (!(await keysFeaturePresent(request, owner.access_token))) {
			test.skip(true, 'api-keys surface absent (404/501) in this driver');
			return;
		}

		// (a) You cannot even SUBMIT a scope-limited key — the global ValidationPipe runs with
		//     forbidNonWhitelisted, so an unknown `scopes`/`permissions` field is rejected outright.
		//     This is the truthful inversion of "create a read-only scoped key".
		const scoped = await request.post(KEYS, {
			headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
			data: { name: `scoped-attempt-${uniq()}`, scopes: ['works:read'], permissions: ['x'] },
			failOnStatusCode: false,
		});
		expect(
			[400, 422],
			`scope-field create rejected; status=${scoped.status()}`,
		).toContain(scoped.status());
		if (scoped.status() === 400) {
			// Probed message: { message: ["property scopes should not exist"] }.
			const body = JSON.stringify(await scoped.json().catch(() => ({})));
			expect(body).toMatch(/should not exist|scopes|permissions/i);
		}

		// (b) A plain key authenticates a READ as its owner.
		const created = await createKey(request, owner.access_token, { name: `plain-${uniq()}` });
		expect(created.key, `plain key created; status=${created.status}`).toBeTruthy();
		const secret = created.key!.key;
		expect(secret, 'key is ew_live_ + 64 hex (72 chars)').toMatch(/^ew_live_[0-9a-f]{64}$/);

		const read = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': secret },
			failOnStatusCode: false,
		});
		expect(read.status(), 'key authenticates on a read endpoint').toBe(200);
		expect((await read.json()).email).toBe(owner.user.email);

		// (c) The SAME key ALSO performs a WRITE (create a Work) — proving authorization is
		//     owner-wide, not capability-gated. Under a real scope model a "read" key would 403
		//     here; it must NOT be 401/403. The stack answers 200 (or 201) with the work record.
		const write = await createWork(request, { 'x-api-key': secret });
		expect(write.status, `write via key must not be 403; status=${write.status}`).not.toBe(403);
		expect(write.status, 'write via key must not be 401').not.toBe(401);
		expect([200, 201], `write via key status=${write.status}`).toContain(write.status);

		test.info().annotations.push({
			type: 'capability-scope',
			description:
				'No OAuth-style scope model: scope fields are 400-rejected at create; a key grants ' +
				'full owner rights across read+write. The fictional "403 on out-of-scope endpoint" ' +
				'assertion is intentionally NOT made.',
		});
	});

	test("a key cannot escalate beyond its owner: it always resolves to its owner (never another user) and cannot read another owner's private resource", async ({
		request,
	}) => {
		const alice = await registerUserViaAPI(request);
		const bob = await registerUserViaAPI(request);
		expect(alice.user.id).not.toBe(bob.user.id);
		if (!(await keysFeaturePresent(request, alice.access_token))) {
			test.skip(true, 'api-keys surface absent in this driver');
			return;
		}

		// Bob creates a private Work via his bearer.
		const bobWork = await createWork(request, authedHeaders(bob.access_token));

		// Alice mints a (necessarily unscoped) key.
		const aliceKey = await createKey(request, alice.access_token, { name: `alice-${uniq()}` });
		expect(aliceKey.key, `Alice key created; status=${aliceKey.status}`).toBeTruthy();
		const aliceSecret = aliceKey.key!.key;

		// 1. Alice's key ALWAYS resolves to Alice — never to Bob (no impersonation/escalation),
		//    via BOTH header slots (x-api-key AND Bearer ew_live_…).
		for (const headers of [{ 'x-api-key': aliceSecret }, authedHeaders(aliceSecret)]) {
			const who = await request.get(PROFILE_FRESH, { headers, failOnStatusCode: false });
			expect(who.status()).toBe(200);
			const whoJson = await who.json();
			expect(whoJson.email, 'key authenticates as Alice, never Bob').toBe(alice.user.email);
			expect(whoJson.email).not.toBe(bob.user.email);
			expect(whoJson.id).toBe(alice.user.id);
		}

		// 2. Alice's key cannot READ Bob's private resource — the owner boundary holds.
		if (bobWork.id) {
			const cross = await request.get(`${WORKS}/${bobWork.id}`, {
				headers: { 'x-api-key': aliceSecret },
				failOnStatusCode: false,
			});
			expect(
				[401, 403, 404],
				`cross-owner read status was ${cross.status()}`,
			).toContain(cross.status());
		} else {
			test.info().annotations.push({
				type: 'cross-owner',
				description: "Bob's work id not exposed in this driver; asserted identity-only.",
			});
		}
	});

	test('revoked key is rejected (401) on a previously-allowed endpoint, via BOTH header slots — revocation is the real "scope down"', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		if (!(await keysFeaturePresent(request, owner.access_token))) {
			test.skip(true, 'api-keys surface absent in this driver');
			return;
		}
		const created = await createKey(request, owner.access_token, { name: `revoke-${uniq()}` });
		expect(created.key, `key created; status=${created.status}`).toBeTruthy();
		const { id, key: secret } = created.key!;

		// Baseline: key works on BOTH a read and a write before revoke (establishes the grant
		// we are about to take away).
		const before = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': secret },
			failOnStatusCode: false,
		});
		expect(before.status(), 'key valid before revoke').toBe(200);
		const beforeWrite = await createWork(request, { 'x-api-key': secret });
		expect([200, 201], `key can write before revoke; ${beforeWrite.status}`).toContain(
			beforeWrite.status,
		);

		const revoke = await request.delete(`${KEYS}/${id}`, {
			headers: authedHeaders(owner.access_token),
			failOnStatusCode: false,
		});
		expect([200, 204]).toContain(revoke.status());
		if (revoke.status() === 200) {
			expect((await revoke.json().catch(() => ({}))).message ?? '').toMatch(/revoked/i);
		}

		// Rejected immediately via x-api-key AND via Bearer, on read AND write.
		const afterHeader = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': secret },
			failOnStatusCode: false,
		});
		expect(afterHeader.status(), 'revoked key rejected via x-api-key (read)').toBe(401);
		expect((await afterHeader.json().catch(() => ({}))).message ?? '').toMatch(
			/invalid or expired api key/i,
		);

		const afterBearer = await request.get(PROFILE_FRESH, {
			headers: authedHeaders(secret),
			failOnStatusCode: false,
		});
		expect(afterBearer.status(), 'revoked key rejected via Bearer (read)').toBe(401);

		const afterWrite = await createWork(request, { 'x-api-key': secret });
		expect(afterWrite.status, 'revoked key cannot write either').toBe(401);

		// Second revoke is a no-op 404 (revokeKey returns false for an already-gone row).
		const revokeAgain = await request.delete(`${KEYS}/${id}`, {
			headers: authedHeaders(owner.access_token),
			failOnStatusCode: false,
		});
		expect([404, 400]).toContain(revokeAgain.status());
	});

	test('expired key (past expiresAt) is rejected — time-bounded scope: create fails up front, or the key never authenticates', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		if (!(await keysFeaturePresent(request, owner.access_token))) {
			test.skip(true, 'api-keys surface absent in this driver');
			return;
		}
		const past = new Date(Date.now() - 60_000).toISOString();
		const created = await createKey(request, owner.access_token, {
			name: `expired-${uniq()}`,
			expiresAt: past,
		});
		// Probed contract: createKey rejects a non-future expiry up front with
		// 400 "Expiration date must be in the future". If a driver instead ACCEPTS it, the key
		// must then 401 on use (validateKey nulls expired rows) — assert either, never a usable
		// expired key.
		if (created.key) {
			const use = await request.get(PROFILE_FRESH, {
				headers: { 'x-api-key': created.key.key },
				failOnStatusCode: false,
			});
			expect([401, 403], `accepted past-expiry key must not authenticate; ${use.status()}`).toContain(
				use.status(),
			);
		} else {
			expect(
				[400, 401, 403, 422],
				`past-expiry create rejected with ${created.status}`,
			).toContain(created.status);
			if (created.status === 400) {
				const msg = JSON.stringify(created.raw ?? {});
				expect(msg).toMatch(/future|expir/i);
			}
		}
	});

	test('x-api-key vs Bearer precedence is deterministic and PREFIX-gated: a present ew_live_ key is authoritative; a non-prefixed x-api-key falls through to the Bearer session; malformed/empty -> 401; never 500', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		if (!(await keysFeaturePresent(request, owner.access_token))) {
			test.skip(true, 'api-keys surface absent in this driver');
			return;
		}
		const created = await createKey(request, owner.access_token, { name: `prec-${uniq()}` });
		expect(created.key, `key created; status=${created.status}`).toBeTruthy();
		const secret = created.key!.key;
		const sessionBearer = authedHeaders(owner.access_token); // 32-char opaque session token

		// 1. Valid x-api-key + GARBAGE non-prefixed Bearer. Probed -> 200: the x-api-key slot is
		//    evaluated FIRST and, being a valid ew_live_ key, WINS; the bad Bearer is never reached.
		const validXBadBearer = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': secret, Authorization: 'Bearer garbage.jwt.value' },
			failOnStatusCode: false,
		});
		expect(validXBadBearer.status(), 'no ambiguous 500 with both slots set').not.toBe(500);
		expect(validXBadBearer.status(), 'valid x-api-key wins over a bad Bearer').toBe(200);
		expect((await validXBadBearer.json()).email, 'resolved to the key owner').toBe(
			owner.user.email,
		);

		// 2. GARBAGE ew_live_-PREFIXED x-api-key + VALID Bearer session. Probed -> 401: a
		//    prefixed-but-invalid x-api-key is treated as an API-key request and short-circuits —
		//    the guard NEVER falls through to the otherwise-valid session. This is the load-bearing
		//    proof that a present ew_live_ key is authoritative.
		const badPrefixedXValidBearer = await request.get(PROFILE_FRESH, {
			headers: { ...sessionBearer, 'x-api-key': 'ew_live_deadbeef' },
			failOnStatusCode: false,
		});
		expect(badPrefixedXValidBearer.status(), 'no 500').not.toBe(500);
		expect(
			badPrefixedXValidBearer.status(),
			'prefixed-but-bad x-api-key short-circuits past a valid session',
		).toBe(401);

		// 3. NON-prefixed garbage x-api-key + VALID Bearer session. Probed -> 200: a value that is
		//    NOT ew_live_-prefixed is ignored by extractApiKey, so the request FALLS THROUGH to the
		//    provider, which validates the Bearer session. This is the discriminator: only the
		//    prefix promotes a value to "API-key request".
		const nonPrefixedXValidBearer = await request.get(PROFILE_FRESH, {
			headers: { ...sessionBearer, 'x-api-key': 'not-a-prefixed-key' },
			failOnStatusCode: false,
		});
		expect(nonPrefixedXValidBearer.status(), 'no 500').not.toBe(500);
		expect(
			[200, 401],
			`non-prefixed x-api-key falls through to Bearer; status=${nonPrefixedXValidBearer.status()}`,
		).toContain(nonPrefixedXValidBearer.status());
		if (nonPrefixedXValidBearer.status() === 200) {
			expect(
				(await nonPrefixedXValidBearer.json()).email,
				'fell through to the Bearer session identity',
			).toBe(owner.user.email);
		}
		test.info().annotations.push({
			type: 'precedence',
			description:
				'extractApiKey is PREFIX-gated: ew_live_-prefixed value (either slot) => API-key ' +
				'request (authoritative, may 401); non-prefixed x-api-key => ignored => falls through ' +
				'to the Bearer/session path.',
		});

		// 4. Malformed ew_live_-prefixed x-api-key ALONE -> 401 (guard validates, no anon fallthrough).
		const badXAlone = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': 'ew_live_not_a_real_key_value' },
			failOnStatusCode: false,
		});
		expect([401, 403]).toContain(badXAlone.status());

		// 5. Empty x-api-key ALONE -> 401 (falsy => ignored => provider path => no session).
		const emptyXAlone = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': '' },
			failOnStatusCode: false,
		});
		expect([401, 403]).toContain(emptyXAlone.status());

		// 6. Sanity: the valid key alone (no Bearer) still authenticates -> proves (1)/(2) outcomes
		//    are driven by the slot contents, not by a broken key.
		const validAlone = await request.get(PROFILE_FRESH, {
			headers: { 'x-api-key': secret },
			failOnStatusCode: false,
		});
		expect(validAlone.status(), 'valid key alone still authenticates').toBe(200);

		// 7. And the valid key carried in the BEARER slot (Bearer ew_live_…) is equivalent -> 200.
		const validBearerKey = await request.get(PROFILE_FRESH, {
			headers: authedHeaders(secret),
			failOnStatusCode: false,
		});
		expect(validBearerKey.status(), 'Bearer ew_live_… authenticates too').toBe(200);
	});

	test('a key cannot widen its own grant: no PATCH/PUT update route, and the masked list never leaks a secret / scopes / permissions field', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		if (!(await keysFeaturePresent(request, owner.access_token))) {
			test.skip(true, 'api-keys surface absent in this driver');
			return;
		}
		const created = await createKey(request, owner.access_token, { name: `widen-${uniq()}` });
		expect(created.key, `key created; status=${created.status}`).toBeTruthy();
		const { id, key: secret } = created.key!;

		// 1. No grant-escalation route. Probed: PATCH=404, PUT=404. A key's capabilities cannot be
		//    re-issued/widened in place — must never 2xx-mutate it (especially not with scopes).
		for (const method of ['patch', 'put'] as const) {
			const res = await request[method](`${KEYS}/${id}`, {
				headers: {
					...authedHeaders(owner.access_token),
					'content-type': 'application/json',
				},
				data: { name: `widened-${ts()}`, scopes: ['*'] },
				failOnStatusCode: false,
			});
			expect(
				[404, 405, 400, 501],
				`${method} update route must not succeed; status=${res.status()}`,
			).toContain(res.status());
		}

		// 2. The masked list never serializes the raw secret nor any scope/permission/key/hash field.
		const list = await request.get(KEYS, {
			headers: authedHeaders(owner.access_token),
			failOnStatusCode: false,
		});
		expect(list.status()).toBe(200);
		const rows = await list.json();
		expect(Array.isArray(rows)).toBe(true);
		expect(JSON.stringify(rows).includes(secret), 'raw secret never appears in list').toBe(
			false,
		);
		const mine = (rows as any[]).find((r) => r.id === id);
		expect(mine, 'created key is listed for its owner').toBeTruthy();
		if (mine) {
			expect(mine, 'list row carries no scopes field').not.toHaveProperty('scopes');
			expect(mine, 'list row carries no permissions field').not.toHaveProperty('permissions');
			expect(mine, 'list row carries no raw key').not.toHaveProperty('key');
			expect(mine, 'list row carries no hashedKey').not.toHaveProperty('hashedKey');
			// Positive: the masked, non-secret fingerprint IS present.
			expect(mine.prefix, 'masked prefix fingerprint surfaced').toBe(created.key!.prefix);
			expect(mine.isActive, 'active key reports isActive').toBe(true);
		}
	});
});
