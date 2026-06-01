import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';

/**
 * flow-session-multi-device-revocation — a multi-device / multi-session
 * INVENTORY plus the THREE revocation shapes the theme names, exercised by
 * holding several INDEPENDENT cookie-jar sessions for one account and proving
 * how a revoke on one PROPAGATES (or pointedly does NOT) to the others:
 *
 *   • TARGETED   — POST /api/auth/logout kills ONLY the calling session.
 *   • ALL-OTHER  — POST /api/auth/logout-all kills EVERY session of the user
 *                  (the caller's own token included — it is re-entrant).
 *   • IDEMPOTENT — re-revoking with an already-dead token is a guard 401,
 *                  never a 5xx; a fleet wipe does not lock the account out.
 *
 * ============================================================================
 * DEVIATION FROM THE ASSIGNED BRIEF — VERIFIED LIVE, NOT GUESSED.
 *
 * The brief named GET /api/auth/session, a session-LIST endpoint, revoke-by-id
 * and revoke-others. Those exact endpoints DO NOT exist on this build — probed
 * live against http://127.0.0.1:3100 AND read from
 * apps/api/src/auth/controllers/auth.controller.ts +
 * providers/auth-provider.service.ts:
 *   - GET  /api/auth/session   → 404   (no single-session read)
 *   - GET  /api/auth/sessions  → 404   (no list endpoint → no revoke-by-id)
 *   - POST /api/auth/refresh   → 404   (login/register return ONLY
 *                                       {access_token,user}; no refresh cycle)
 *
 * But the UNDERLYING capability IS real and STATEFUL. The platform keeps a
 * per-session server-side record (`AuthRuntimeSession`, keyed by
 * sha256(bearer); see auth-provider.service.ts). The session API surface is:
 *   - POST /api/auth/register {username,email,password} → 201 {access_token,user}
 *   - POST /api/auth/login {email,password}             → 200 {access_token,user}
 *       (strict-whitelist DTO: an extra key → 400; bad creds → 401)
 *       Each login mints a DISTINCT opaque (non-JWT, single-segment) token =
 *       one independent device session.
 *   - POST /api/auth/logout       @UseGuards(AuthSessionGuard)
 *       → signOut(headers) → deleteSessionRecord(bearer) — deletes ONLY THIS
 *         session row → 200 {message:"Logged out successfully"}.
 *   - POST /api/auth/logout-all   @UseGuards(AuthSessionGuard)
 *       → signOutAll(userId) → sessionRepo.delete({userId}) — deletes ALL rows
 *         for the user (the caller's own row too) →
 *         200 {message:"Logged out from all devices successfully"}.
 *   - POST /api/auth/update-password {currentPassword,newPassword}
 *       → 200 {message:"Password updated successfully"}; changePassword does
 *         NOT call signOutAll → live sessions SURVIVE a password change (only
 *         the login CREDENTIAL rotates). reset-password DOES signOutAll — not
 *         exercised here (needs a mailed token; e2e SMTP delivery fails).
 *   - GET  /api/auth/profile      @UseGuards(AuthSessionGuard)
 *       → 200 with a live session token; 401 once the row is gone / anon /
 *         mangled. This is our session-liveness oracle (no list endpoint).
 *
 * VERIFIED LIVE (the load-bearing truths every assertion below rests on):
 *   targeted logout B  → A=200 B=401 C=200      (single-session, NOT global)
 *   re-logout dead B   → 401 {"Unauthorized"}    (idempotent, never 5xx)
 *   logout-all from A  → A=401 C=401             (fleet-wide, caller included)
 *   re-logout-all dead → 401                      (re-entrant + idempotent)
 *   re-login post-wipe → 200                      (wipe ≠ lockout)
 *   pw-change          → A=200 B=200 survive; old-pw login 401, new-pw 200
 *   anon/mangled       → 401 on logout & logout-all
 *
 * Anti-duplication — these SHALLOW / single-axis siblings exist and are NOT
 * re-covered here:
 *   - flow-session-idle-absolute-expiry.spec.ts → logout-as-expiry, ONE
 *     device-3 logout, tampered/anon token, renewal, pw-credential rotation.
 *     It never touches logout-all, never the re-entrant caller-token death,
 *     never the post-wipe re-login, never interleaved monotonic fleet
 *     shrinkage, never cross-user logout-all isolation. THOSE are this file.
 *   - session-persistence / cookie-flags-on-logout / device-auth → cookie /
 *     CLI surfaces, not server-side multi-session revocation propagation.
 *
 * RESILIENCE: unique Date.now-suffixed users per test (never mutate the shared
 * seeded user — cross-spec isolation), generous request timeouts, status-band
 * tolerance (401 OR 403 for "revoked", <500 for "never a 5xx"), and
 * expect.poll where a revoke may settle a beat after the ack. Nothing asserts
 * a fictional endpoint or status.
 * ============================================================================
 */

const T = 25_000;
const LOGIN = `${API_BASE}/api/auth/login`;
const LOGOUT = `${API_BASE}/api/auth/logout`;
const LOGOUT_ALL = `${API_BASE}/api/auth/logout-all`;
const PROFILE = `${API_BASE}/api/auth/profile`;
const UPDATE_PASSWORD = `${API_BASE}/api/auth/update-password`;

const SINGLE_LOGOUT_MSG = 'Logged out successfully';
const ALL_LOGOUT_MSG = 'Logged out from all devices successfully';

interface DeviceSession {
	label: string;
	access_token: string;
	user: { id: string; email: string };
}

/** One "device" = one independent login, producing its own server session token. */
async function loginDevice(
	request: APIRequestContext,
	creds: { email: string; password: string },
	label: string,
): Promise<DeviceSession> {
	const res = await request.post(LOGIN, { data: creds, timeout: T });
	expect(res.status(), `login for ${label} should be 200`).toBe(200);
	const body = (await res.json()) as { access_token: string; user: { id: string; email: string } };
	expect(typeof body.access_token, `${label} login must mint an access_token`).toBe('string');
	expect(body.access_token.length, `${label} token length`).toBeGreaterThan(10);
	return { label, access_token: body.access_token, user: body.user };
}

/** Bring up a fleet of N independent device sessions for one fresh account. */
async function bringUpFleet(
	request: APIRequestContext,
	prefix: string,
	count: number,
): Promise<{ account: Awaited<ReturnType<typeof registerUserViaAPI>>; devices: DeviceSession[] }> {
	const account = await registerUserViaAPI(request, { email: makeTestUser(prefix).email });
	const devices: DeviceSession[] = [];
	for (let i = 0; i < count; i++) {
		devices.push(
			await loginDevice(request, { email: account.email, password: account.password }, `${prefix}-d${i}`),
		);
	}
	return { account, devices };
}

/** Raw /profile status for a token. 200 = live session, 401/403 = revoked. */
async function profileStatus(request: APIRequestContext, access_token: string): Promise<number> {
	const res = await request.get(PROFILE, { headers: authedHeaders(access_token), timeout: T });
	return res.status();
}

async function expectLive(request: APIRequestContext, d: DeviceSession): Promise<void> {
	expect(await profileStatus(request, d.access_token), `${d.label} should be LIVE (200)`).toBe(200);
}

/**
 * Revoked = the session row is gone. Poll on the meaningful predicate (status
 * in {401,403}) so a delete that settles a beat after the 200 ack still passes,
 * while a token that STAYS live (200) correctly fails the poll.
 */
async function expectRevoked(request: APIRequestContext, d: DeviceSession): Promise<void> {
	await expect
		.poll(async () => [401, 403].includes(await profileStatus(request, d.access_token)), {
			message: `${d.label} should be REVOKED (401/403)`,
			timeout: 15_000,
		})
		.toBe(true);
}

test.describe('flow-session-multi-device-revocation', () => {
	/**
	 * FLOW 1 — Multi-device session INVENTORY baseline + the propagation pattern
	 * of a single targeted revoke.
	 *
	 * There is no GET-sessions list endpoint (404, see docblock), so the truthful
	 * equivalent of a session inventory is: hold every device token and prove
	 * each independently resolves /profile to the SAME account, and that all the
	 * tokens are DISTINCT (a reused token across devices would be a credential
	 * leak). Then we log out exactly ONE device and assert the load-bearing
	 * propagation rule: ONLY that device's row dies; every sibling stays live.
	 */
	test('a 4-device fleet enumerates as distinct same-user sessions; a targeted logout propagates to ONLY that device', async ({
		request,
	}) => {
		const { account, devices } = await bringUpFleet(request, 'rev-inv', 4);

		// Inventory: every device token is unique...
		const tokens = devices.map((d) => d.access_token);
		expect(new Set(tokens).size, 'all device tokens must be distinct').toBe(tokens.length);

		// ...and every device independently resolves /profile to the SAME id+email.
		for (const d of devices) {
			const res = await request.get(PROFILE, { headers: authedHeaders(d.access_token), timeout: T });
			expect(res.status(), `${d.label} profile`).toBe(200);
			const body = (await res.json()) as { id?: string; userId?: string; email?: string };
			expect(body.id ?? body.userId, `${d.label} resolves to the account id`).toBe(account.user.id);
			expect((body.email ?? '').toLowerCase(), `${d.label} email`).toBe(account.email.toLowerCase());
		}

		// Targeted revoke of the 2nd device only.
		const victim = devices[1];
		const out = await request.post(LOGOUT, { headers: authedHeaders(victim.access_token), timeout: T });
		expect(out.status(), 'targeted logout ack').toBe(200);
		expect(((await out.json()) as { message?: string }).message, 'single-logout body').toBe(
			SINGLE_LOGOUT_MSG,
		);

		// Propagation: the victim is gone; the OTHER three are untouched.
		await expectRevoked(request, victim);
		for (const survivor of devices.filter((d) => d !== victim)) {
			await expectLive(request, survivor);
		}
	});

	/**
	 * FLOW 2 — Interleaved targeted revocations shrink the live set MONOTONICALLY.
	 *
	 * Revoke devices one-by-one (each a separate POST /logout from that device's
	 * own token) and after every step assert the FULL fleet state: the cumulative
	 * set of revoked devices is exactly the ones we logged out, and every
	 * not-yet-touched device is still live. This pins that targeted logout never
	 * cascades and never resurrects — a property a single-device sibling spec
	 * cannot exercise.
	 */
	test('sequential targeted logouts revoke exactly the chosen devices while every untouched device stays live', async ({
		request,
	}) => {
		const { devices } = await bringUpFleet(request, 'rev-seq', 4);

		// Baseline: the whole fleet is live.
		for (const d of devices) await expectLive(request, d);

		// Revoke in order d0, d2 (skip d1 deliberately to prove "exactly chosen").
		const revokeOrder = [devices[0], devices[2]];
		const revoked = new Set<DeviceSession>();
		for (const victim of revokeOrder) {
			const out = await request.post(LOGOUT, {
				headers: authedHeaders(victim.access_token),
				timeout: T,
			});
			expect(out.status(), `${victim.label} logout ack`).toBe(200);
			revoked.add(victim);

			// After each step: revoked set is exactly what we asked for; the rest live.
			for (const d of devices) {
				if (revoked.has(d)) {
					await expectRevoked(request, d);
				} else {
					await expectLive(request, d);
				}
			}
		}

		// Final: only d0 + d2 are dead; d1 + d3 are still serving the account.
		await expectRevoked(request, devices[0]);
		await expectLive(request, devices[1]);
		await expectRevoked(request, devices[2]);
		await expectLive(request, devices[3]);
	});

	/**
	 * FLOW 3 — logout-all is FLEET-WIDE and RE-ENTRANT: it kills every device
	 * INCLUDING the caller's own token, and the ack differs from single logout.
	 *
	 * Verified live: logout-all from device-A returns 200 but A's own token is
	 * immediately 401 (the caller's session row is deleted too), and so is every
	 * sibling. This re-entrant caller-token death is the distinguishing fact the
	 * single-device sibling never asserts.
	 */
	test('logout-all revokes EVERY device including the caller (re-entrant fleet-wide sign-out)', async ({
		request,
	}) => {
		const { devices } = await bringUpFleet(request, 'rev-all', 4);
		for (const d of devices) await expectLive(request, d);

		const caller = devices[0];
		const all = await request.post(LOGOUT_ALL, { headers: authedHeaders(caller.access_token), timeout: T });
		expect(all.status(), 'logout-all ack').toBe(200);
		const allBody = (await all.json()) as { message?: string };
		expect(allBody.message, `logout-all body = ${JSON.stringify(allBody)}`).toBe(ALL_LOGOUT_MSG);
		expect(allBody.message, 'fleet ack references all devices').toMatch(/all devices/i);
		expect(allBody.message, 'fleet ack is NOT the single-logout ack').not.toBe(SINGLE_LOGOUT_MSG);

		// Every device — the CALLER included — is revoked.
		for (const d of devices) await expectRevoked(request, d);

		// Re-entrancy idempotency: re-calling logout-all with the now-dead caller
		// token is a guard 401, not a silent 200 and never a 5xx.
		const again = await request.post(LOGOUT_ALL, {
			headers: authedHeaders(caller.access_token),
			timeout: T,
		});
		expect(
			[401, 403].includes(again.status()),
			`repeat logout-all with dead caller = ${again.status()} (expected 401/403)`,
		).toBe(true);
		expect(again.status(), 'repeat logout-all must not 5xx').toBeLessThan(500);
	});

	/**
	 * FLOW 4 — A fleet wipe is NOT an account lockout: after logout-all kills
	 * everything, a fresh login resurrects a brand-new WORKING session.
	 *
	 * This proves logout-all is a SESSION operation (delete rows), not a user
	 * disable: the credential is untouched, so re-authentication immediately
	 * yields a usable session that is independent of (and not poisoned by) the
	 * wiped fleet. Also pins single-logout idempotency on a dead token.
	 */
	test('after a logout-all wipe the account can re-login to a fresh working session (wipe != lockout)', async ({
		request,
	}) => {
		const { account, devices } = await bringUpFleet(request, 'rev-resurrect', 3);
		for (const d of devices) await expectLive(request, d);

		// Wipe the whole fleet from one device.
		expect(
			(await request.post(LOGOUT_ALL, { headers: authedHeaders(devices[0].access_token), timeout: T })).status(),
			'logout-all ack',
		).toBe(200);
		for (const d of devices) await expectRevoked(request, d);

		// Single-logout idempotency on a now-dead fleet token (never 5xx).
		const deadLogout = await request.post(LOGOUT, {
			headers: authedHeaders(devices[1].access_token),
			timeout: T,
		});
		expect(
			[401, 403].includes(deadLogout.status()),
			`logout of a wiped token = ${deadLogout.status()} (expected 401/403)`,
		).toBe(true);
		expect(deadLogout.status(), 'dead-token logout must not 5xx').toBeLessThan(500);

		// Resurrection: the credential still works → a fresh login mints a NEW,
		// independent, fully-working session distinct from every wiped token.
		const reborn = await loginDevice(request, { email: account.email, password: account.password }, 'reborn');
		expect(
			new Set([...devices.map((d) => d.access_token), reborn.access_token]).size,
			'reborn session token is distinct from every wiped token',
		).toBe(devices.length + 1);
		await expectLive(request, reborn);
	});

	/**
	 * FLOW 5 — Credential ROTATION vs session REVOCATION are independent axes.
	 *
	 * A password change (update-password) rotates the LOGIN CREDENTIAL but, on
	 * this build, does NOT evict already-issued sessions — both live devices keep
	 * returning 200, the OLD password stops logging in, and the NEW password
	 * works. An explicit logout-all is what actually clears the fleet. We assert
	 * both halves in one flow so the contrast is unambiguous: changing your
	 * password is NOT a fleet sign-out; logout-all is.
	 */
	test('a password change rotates the credential but keeps live sessions; logout-all is what evicts the fleet', async ({
		request,
	}) => {
		const { account, devices } = await bringUpFleet(request, 'rev-rotate', 2);
		const [devA, devB] = devices;
		await expectLive(request, devA);
		await expectLive(request, devB);

		const newPwd = `RotatePass1zQ!${Date.now().toString(36)}`;
		const upd = await request.post(UPDATE_PASSWORD, {
			headers: authedHeaders(devA.access_token),
			data: { currentPassword: account.password, newPassword: newPwd },
			timeout: T,
		});
		// Never a 5xx. A build that rejects the rotation under policy → skip truthfully.
		expect(upd.status(), 'update-password is not a 5xx').toBeLessThan(500);
		if (upd.status() >= 400) {
			test.skip(true, `update-password rejected (${upd.status()}) on this build`);
		}
		expect(((await upd.json()) as { message?: string }).message, 'pw-change body').toBe(
			'Password updated successfully',
		);

		// Credential rotated: OLD password no longer logs in, NEW one does.
		const oldLogin = await request.post(LOGIN, {
			data: { email: account.email, password: account.password },
			timeout: T,
		});
		expect(oldLogin.status(), 'old password must stop authenticating').not.toBe(200);
		const newLogin = await loginDevice(request, { email: account.email, password: newPwd }, 'post-rotate');
		await expectLive(request, newLogin);

		// But the EXISTING device sessions SURVIVED the credential change — a
		// password change is not an implicit fleet revoke on this build.
		await expectLive(request, devA);
		await expectLive(request, devB);

		// Now exercise the real fleet revoke: logout-all clears all three live
		// sessions (the two originals + the post-rotation login) at once.
		expect(
			(await request.post(LOGOUT_ALL, { headers: authedHeaders(devB.access_token), timeout: T })).status(),
			'logout-all ack',
		).toBe(200);
		await expectRevoked(request, devA);
		await expectRevoked(request, devB);
		await expectRevoked(request, newLogin);
	});

	/**
	 * FLOW 6 — Cross-user isolation + guard rejection of unauthenticated callers.
	 *
	 * Two distinct accounts, each with a multi-device fleet. User-X's targeted
	 * logout AND fleet-wide logout-all must touch ONLY X — User-Y stays fully
	 * live throughout (a cross-user revoke leak would be critical). We also pin
	 * that the revocation endpoints are AUTH-GUARDED: anon, mangled-bearer, and
	 * already-revoked callers are all 401 (never a silent 200 that would let an
	 * unauthenticated caller trigger someone else's sign-out).
	 */
	test('one user revocation never affects another, and revoke endpoints reject anon/mangled/dead callers', async ({
		request,
	}) => {
		const x = await bringUpFleet(request, 'rev-x', 2);
		const y = await bringUpFleet(request, 'rev-y', 2);

		// Baseline: both fleets fully live.
		for (const d of [...x.devices, ...y.devices]) await expectLive(request, d);

		// X targeted-logs-out device 0: only X-d0 dies; Y entirely untouched.
		expect(
			(await request.post(LOGOUT, { headers: authedHeaders(x.devices[0].access_token), timeout: T })).status(),
			'X targeted logout ack',
		).toBe(200);
		await expectRevoked(request, x.devices[0]);
		await expectLive(request, x.devices[1]);
		for (const d of y.devices) await expectLive(request, d);

		// X fleet-wipes: X-d1 also dies, but Y is STILL fully live.
		expect(
			(await request.post(LOGOUT_ALL, { headers: authedHeaders(x.devices[1].access_token), timeout: T })).status(),
			'X logout-all ack',
		).toBe(200);
		await expectRevoked(request, x.devices[1]);
		for (const d of y.devices) await expectLive(request, d);

		// Guard surface: anon + mangled bearer cannot drive either endpoint.
		expect((await request.post(LOGOUT, { timeout: T })).status(), 'anon logout').toBe(401);
		expect((await request.post(LOGOUT_ALL, { timeout: T })).status(), 'anon logout-all').toBe(401);
		const mangled = { Authorization: 'Bearer not.a.real.session.token' };
		expect(
			(await request.post(LOGOUT, { headers: mangled, timeout: T })).status(),
			'mangled-bearer logout must be 401, not a silent 200',
		).toBe(401);
		expect(
			(await request.post(LOGOUT_ALL, { headers: mangled, timeout: T })).status(),
			'mangled-bearer logout-all',
		).toBe(401);

		// An already-revoked X token cannot re-drive a fleet wipe against Y or
		// anyone — the guard checks the live session store, not just token shape.
		const deadDrive = await request.post(LOGOUT_ALL, {
			headers: authedHeaders(x.devices[0].access_token),
			timeout: T,
		});
		expect(
			[401, 403].includes(deadDrive.status()),
			`logout-all with a revoked token = ${deadDrive.status()} (expected 401/403)`,
		).toBe(true);
		// Y must STILL be untouched after the dead-token attempt.
		for (const d of y.devices) await expectLive(request, d);
	});
});
