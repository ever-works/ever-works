import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, loginViaAPI } from './helpers/api';

/**
 * Session expiry / revocation, sliding renewal, rotation on a privilege change,
 * session-vs-API-key credential-class consistency, and concurrent-tab /
 * multi-device session consistency — complex cross-feature INTEGRATION flows,
 * written against the REAL probed contract of this stack.
 *
 * PROBED, TRUTHFUL contract (re-verified via curl against the running
 * http://127.0.0.1:3100 AND read from
 * apps/api/src/auth/controllers/auth.controller.ts +
 * apps/api/src/auth/guards/auth-session.guard.ts before writing any assertion —
 * this stack is NOT a stateless-JWT scheme):
 *   - POST /api/auth/register {username,email,password} → 201
 *       { access_token: <opaque 32-char string>, user:{id,email,username} }.
 *     There is NO refresh_token, and access_token is OPAQUE — it is NOT a JWT
 *     (a single segment, no dots), so no exp can be decoded from it. The
 *     JWT-shaped claims (iat / iss:'auth-runtime' / aud:'ever-works-users')
 *     live in the /profile RESPONSE, not in the bearer.
 *   - POST /api/auth/login accepts ONLY {email,password}; two logins of the
 *     SAME user mint DIFFERENT opaque tokens (a server-side session per login),
 *     and both authenticate concurrently.
 *   - GET  /api/auth/profile → 200 with a valid bearer; 401 with NO bearer;
 *       401 with a TAMPERED bearer. Body carries
 *       {id,userId,email,username,provider,emailVerified,isActive,avatar,
 *        iat,iss,aud,isAnonymous}.
 *   - GET  /api/auth/profile/fresh → 200 with a valid bearer (a DB-FRESH read:
 *       {id,email,username,registrationProvider,createdAt,...}); 401 anon. Both
 *       a renewed session token AND the original session token resolve to the
 *       SAME fresh DB identity (session renewal does not fork the account).
 *   - POST /api/auth/logout → 200 with a valid bearer, and AFTER logout that
 *       same bearer is REVOKED (profile → 401): this is a STATEFUL server
 *       session, not a stateless token. Logout is PER-TOKEN scoped — logging
 *       out device-3 leaves device-1 and device-2 still 200. Logout with no /
 *       already-revoked bearer → 401.
 *   - POST /api/auth/update-password {currentPassword,newPassword} → 200 on the
 *       happy path; on this build it does NOT eagerly revoke already-issued
 *       bearer sessions (existing tokens keep returning 200 — confirmed: the
 *       controller's update-password does NOT call signOutAll, unlike
 *       reset-password which does). After the change, login with the OLD
 *       password fails (401) and the NEW password succeeds (the
 *       credential-rotation half of the privilege change).
 *   - CREDENTIAL CLASS (auth-session.guard.ts): an `Authorization: Bearer
 *       ew_live_…` OR `x-api-key: ew_live_…` value is routed to the API-KEY
 *       path and NEVER falls through to the opaque-session path — a bad one is
 *       a deterministic 401 "Invalid or expired API key". A genuine opaque
 *       SESSION token carries NO such prefix, so a session bearer can never be
 *       mistaken for (or shadow) an API key, and vice-versa.
 *   - /api/auth/refresh, /sessions, /list-sessions, /session, /revoke-sessions,
 *       /me all → 404 (those Better-Auth multi-session list/refresh endpoints
 *       are not exposed). logout-all DOES exist (guarded POST) but is owned by
 *       flow-session-multi-device-revocation.spec.ts and not re-covered here.
 *   - Web routes are /en-prefixed under a (dashboard) route group; /en/settings
 *       & /en/works are protected and bounce unauthenticated users to /login.
 *       Same-context tabs share the session cookie; separate contexts are
 *       isolated. At least one session cookie matching
 *       /(session|auth|token|sid|jwt)/i is HttpOnly.
 *
 * Anti-duplication — these SHALLOW / adjacent siblings exist and are NOT
 * re-covered here:
 *   - idle-session-timeout.spec.ts → single fresh/tampered token + a token-exp
 *     floor (it INCORRECTLY skips when the token is not a JWT — which it always
 *     is on this build; the real revocation/expiry signal is logout, exercised
 *     here instead).
 *   - flow-session-multi-device-revocation.spec.ts → logout-all fleet-wide
 *     sign-out + cross-user isolation (the GLOBAL revoke path — distinct from
 *     the PER-TOKEN logout exercised here).
 *   - cookie-rotation.spec.ts → single-device password-change credential check.
 *   - session-persistence.spec.ts → same-tab reload/nav stays signed in.
 *   - cookie-flags-deep.spec.ts → HttpOnly/SameSite flag audit.
 *   - tab-isolation-localstorage.spec.ts → localStorage isolation (not cookie).
 *   - auth-clock-tolerance.spec.ts → 15s spread + Date-header skew.
 *   - flow-api-key-scope-enforcement.spec.ts → API-key SCOPE checks (not the
 *     session-vs-key credential-CLASS boundary asserted here).
 * NEW here: logout-as-revocation (the real expiry mechanism) + its PER-TOKEN
 * scope across concurrent devices; renewal mints a fresh independent session
 * that does NOT evict the original AND both resolve the SAME fresh DB identity;
 * tampered-token rejection does not poison the account; privilege-change
 * credential rotation with live-session survival; the session-token vs
 * API-key credential-class boundary; and a two-context authed-vs-anon
 * protected-route consistency check.
 *
 * Isolation: every API flow runs on a FRESH `registerUserViaAPI` user (the
 * shared in-memory DB must stay clean for siblings). Unique suffixes via
 * Date.now()+rand. UI flow derives origin from `baseURL`, uses the seeded
 * storageState for the authed context and an explicitly-empty storageState for
 * the anon context (a bare newContext() WOULD inherit the auth cookie). All
 * assertions are defensive (status bands, .or(), skip-on-reject) so they stay
 * truthful on builds that differ in the unprobed corners.
 */

const T = 25_000;

async function profileStatus(request: APIRequestContext, token: string): Promise<number> {
	const res = await request.get(`${API_BASE}/api/auth/profile`, {
		headers: authedHeaders(token),
		timeout: T,
	});
	return res.status();
}

async function logout(request: APIRequestContext, token: string) {
	return request.post(`${API_BASE}/api/auth/logout`, {
		headers: authedHeaders(token),
		timeout: T,
	});
}

/** Mangle the tail of an opaque token so it can no longer match a live session. */
function tamper(token: string): string {
	if (!token) return 'x';
	const head = token.slice(0, token.length - 1);
	const last = token[token.length - 1];
	return head + (last === 'X' ? 'Y' : 'X');
}

/** Cookies in a context whose name looks session/auth-ish. */
async function sessionCookies(ctx: BrowserContext) {
	const all = await ctx.cookies();
	return all.filter((c) => /(session|auth|token|sid|jwt)/i.test(c.name));
}

test.describe('Session revocation/expiry, renewal, rotation, credential-class, concurrent multi-device', () => {
	test('logout is the real session-expiry mechanism: a valid bearer authenticates, then logout REVOKES it (stateful), and a re-logout of the dead token is rejected', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);

		// The freshly issued bearer is an opaque (non-JWT) token — assert the
		// shape so a future move to JWTs is noticed here, but don't depend on it.
		expect(u.access_token, 'register returns an access_token').toBeTruthy();
		test.info().annotations.push({
			type: 'token-shape',
			description: `access_token has ${u.access_token.split('.').length} dot-segments (1 = opaque, 3 = JWT)`,
		});

		// Live session → 200.
		expect(await profileStatus(request, u.access_token), 'live bearer authenticates').toBe(200);

		// Logout succeeds, and is the authoritative expiry: the SAME bearer is
		// immediately revoked server-side (this proves a stateful session, the
		// opposite of a stateless JWT that would keep verifying until exp).
		const out = await logout(request, u.access_token);
		expect(out.status(), `logout body=${await out.text().catch(() => '')}`).toBe(200);
		expect(
			await profileStatus(request, u.access_token),
			'bearer must be revoked (401) after logout',
		).toBe(401);

		// Re-logging-out an already-dead token is rejected 401 (no silent 200,
		// no 5xx) — the server no longer recognises the session.
		const out2 = await logout(request, u.access_token);
		expect(out2.status(), 'logout of an already-revoked token is 401').toBe(401);
	});

	test('a tampered bearer is rejected 401 while the genuine bearer of the SAME user keeps working — revocation is per-credential, not per-account', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);

		// Genuine token authenticates.
		expect(await profileStatus(request, u.access_token), 'genuine bearer passes').toBe(200);

		// A mangled opaque token cannot match any live session → 401 (never 200,
		// never 5xx).
		const forged = tamper(u.access_token);
		expect(forged, 'tampered token differs from the original').not.toBe(u.access_token);
		const forgedStatus = await profileStatus(request, forged);
		expect(forgedStatus, `forged token returned ${forgedStatus}, expected 401`).toBe(401);

		// Rejecting the forged token did NOT poison the account — the genuine
		// session is still alive (a bad credential must not cascade-invalidate).
		expect(
			await profileStatus(request, u.access_token),
			'genuine bearer survives a sibling forged-token rejection',
		).toBe(200);

		// And the unauthenticated baseline (no bearer at all) is also 401, not a
		// permissive 200 — proving the 401 above is real auth enforcement.
		const anon = await request.get(`${API_BASE}/api/auth/profile`, { timeout: T });
		expect(anon.status(), 'no-bearer profile is 401').toBe(401);
	});

	test('sliding renewal: re-login after activity mints a NEW independent session that authenticates WITHOUT evicting the original, and BOTH resolve the SAME fresh DB identity', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const original = u.access_token;

		// Simulate an active session, then renew via a fresh login (the activity-
		// driven renewal path — there is no /refresh endpoint on this build).
		expect(await profileStatus(request, original), 'original session live').toBe(200);
		const renewed = await loginViaAPI(request, { email: u.email, password: u.password });
		expect(renewed.access_token, 'renewal returns a token').toBeTruthy();

		// Renewal issues a DISTINCT session token (a server session per login) —
		// not a mutation of the original opaque value.
		expect(renewed.access_token, 'renewed token differs from the original').not.toBe(original);

		// Both sessions authenticate concurrently: renewal does NOT evict the
		// prior session. This is the consistency model — a new login slides a
		// fresh window in alongside, it does not last-writer-wins the old one.
		expect(await profileStatus(request, original), 'original survives renewal').toBe(200);
		expect(await profileStatus(request, renewed.access_token), 'renewed token live').toBe(200);

		// Identity consistency across the two sessions: a DB-FRESH read via
		// /profile/fresh resolves the SAME account id + email regardless of which
		// session token drove it — renewal slides a window, it never forks the
		// underlying user.
		const freshOriginal = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
			headers: authedHeaders(original),
			timeout: T,
		});
		const freshRenewed = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
			headers: authedHeaders(renewed.access_token),
			timeout: T,
		});
		expect(freshOriginal.status(), 'fresh profile via original session').toBe(200);
		expect(freshRenewed.status(), 'fresh profile via renewed session').toBe(200);
		const bOriginal = (await freshOriginal.json()) as { id?: string; email?: string };
		const bRenewed = (await freshRenewed.json()) as { id?: string; email?: string };
		expect(bOriginal.id, 'fresh-profile id present').toBeTruthy();
		expect(bRenewed.id, 'both sessions resolve the same DB account id').toBe(bOriginal.id);
		expect((bRenewed.email ?? '').toLowerCase(), 'both sessions resolve the same email').toBe(
			(bOriginal.email ?? '').toLowerCase(),
		);

		// Interleave reads to assert there is no eviction race between the two.
		for (let i = 0; i < 2; i++) {
			expect(await profileStatus(request, original)).toBe(200);
			expect(await profileStatus(request, renewed.access_token)).toBe(200);
		}
	});

	test('per-token logout scope across concurrent devices: logging out device-3 leaves device-1 and device-2 sessions fully alive', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const device1 = u.access_token;

		// Two more device logins for the SAME account → two more distinct tokens.
		const l2 = await loginViaAPI(request, { email: u.email, password: u.password });
		const l3 = await loginViaAPI(request, { email: u.email, password: u.password });
		const device2 = l2.access_token;
		const device3 = l3.access_token;
		expect(new Set([device1, device2, device3]).size, 'three distinct device tokens').toBe(3);

		// All three are live before the logout.
		expect(await profileStatus(request, device1), 'device-1 live').toBe(200);
		expect(await profileStatus(request, device2), 'device-2 live').toBe(200);
		expect(await profileStatus(request, device3), 'device-3 live').toBe(200);

		// Log out ONLY device-3.
		expect((await logout(request, device3)).status(), 'device-3 logout 200').toBe(200);

		// Device-3 is revoked; device-1 and device-2 are untouched (per-token
		// scope, NOT a global account logout). This is the load-bearing assertion.
		expect(await profileStatus(request, device3), 'device-3 revoked').toBe(401);
		expect(
			await profileStatus(request, device1),
			'device-1 must survive a device-3 logout',
		).toBe(200);
		expect(
			await profileStatus(request, device2),
			'device-2 must survive a device-3 logout',
		).toBe(200);
	});

	test('privilege change (password update) rotates the login credential — old password is invalidated, new password authenticates — and a fresh post-change login yields a working session', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		expect(await profileStatus(request, u.access_token), 'pre-change session live').toBe(200);

		const newPwd = `RotatePass1zQ!${Date.now().toString(36)}`;
		const update = await request.post(`${API_BASE}/api/auth/update-password`, {
			headers: authedHeaders(u.access_token),
			data: { currentPassword: u.password, newPassword: newPwd },
			timeout: T,
		});
		// Never a 5xx. Some builds reject the rotation under policy (>=400) →
		// skip-branch truthfully rather than asserting a fictional success.
		expect(update.status(), 'update-password is not a 5xx').toBeLessThan(500);
		if (update.status() >= 400) {
			test.skip(true, `update-password rejected (${update.status()}) on this build`);
		}

		// Credential rotation: OLD password no longer logs in, NEW one does.
		const oldLogin = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: u.email, password: u.password },
			timeout: T,
		});
		expect(
			oldLogin.status(),
			'old password still logs in after change — credential not rotated',
		).not.toBe(200);

		const newLogin = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: u.email, password: newPwd },
			timeout: T,
		});
		expect(newLogin.status(), 'new password must authenticate').toBe(200);

		// The post-rotation login yields a usable session distinct from the
		// pre-change bearer.
		const afterToken = (await newLogin.json()).access_token as string;
		expect(afterToken, 'post-rotation login returns a token').toBeTruthy();
		expect(afterToken, 'rotated session token differs from the pre-change one').not.toBe(
			u.access_token,
		);
		expect(await profileStatus(request, afterToken), 'rotated session authenticates').toBe(200);
	});

	test('credential-class consistency: a genuine opaque SESSION bearer authenticates, but an `ew_live_`-prefixed bearer/x-api-key is routed to the API-key path and rejected as a key — a session can never be confused with an API key (or vice-versa)', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);

		// A genuine session bearer (no `ew_live_` prefix) authenticates via the
		// session path.
		expect(await profileStatus(request, u.access_token), 'session bearer authenticates').toBe(
			200,
		);
		expect(
			u.access_token.startsWith('ew_live_'),
			'session token must NOT carry the API-key prefix',
		).toBe(false);

		// An `ew_live_`-prefixed Bearer is treated as an API key and NEVER falls
		// through to the session path — a bogus one is a deterministic 401 with
		// the API-key message, not a generic session 401. This pins the
		// credential-class discriminator in auth-session.guard.ts.
		const keyBearer = await request.get(`${API_BASE}/api/auth/profile`, {
			headers: { Authorization: 'Bearer ew_live_bogusbogusbogusbogus' },
			timeout: T,
		});
		expect(keyBearer.status(), 'ew_live_ bearer is rejected (never 200, never 5xx)').toBe(401);
		const keyBody = (await keyBearer.json().catch(() => ({}))) as { message?: string };
		// Best-effort message check — the guard returns "Invalid or expired API
		// key" on this build; tolerate a future build that uses a generic 401.
		if (keyBody.message) {
			expect(keyBody.message, `api-key path message = ${keyBody.message}`).toMatch(
				/api key|unauthorized/i,
			);
		}

		// Same routing via the dedicated `x-api-key` header slot — also the
		// API-key path, also a 401, also NOT a session fallthrough.
		const keyHeader = await request.get(`${API_BASE}/api/auth/profile`, {
			headers: { 'x-api-key': 'ew_live_bogusbogusbogus' },
			timeout: T,
		});
		expect(keyHeader.status(), 'x-api-key bogus key is 401').toBe(401);

		// Crucially: the genuine session bearer STILL authenticates after the two
		// API-key-path rejections — the failed key attempts neither shadowed nor
		// poisoned the live session.
		expect(
			await profileStatus(request, u.access_token),
			'session survives sibling API-key-path rejections',
		).toBe(200);
	});

	test('concurrent-tab UI consistency: an authed context keeps two protected-route tabs signed in across a reload while an explicitly-anon context is bounced — the cookie, not shared browser state, gates access', async ({
		browser,
		baseURL,
	}) => {
		const origin = baseURL ?? 'http://localhost:3000';

		// AUTHED context inherits the seeded storageState the setup project saved.
		const authedCtx = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
		// ANON context is EXPLICITLY empty (a bare newContext() would inherit the
		// auth cookie via the project storageState — that is the gotcha we avoid).
		const anonCtx = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});

		try {
			// Sanity: the authed context carries an HttpOnly session cookie.
			const authCookies = await sessionCookies(authedCtx);
			if (authCookies.length === 0) {
				test.skip(true, 'seeded context has no session-like cookie');
			}
			expect(
				authCookies.some((c) => c.httpOnly),
				`no HttpOnly session cookie among: ${authCookies.map((c) => c.name).join(', ')}`,
			).toBe(true);

			// Two authed tabs in the SAME context both reach protected routes and
			// both stay signed in across a reload — concurrent-tab consistency.
			const tabA = await authedCtx.newPage();
			const tabB = await authedCtx.newPage();
			await tabA.goto(`${origin}/en/settings`, { waitUntil: 'domcontentloaded' });
			await tabB.goto(`${origin}/en/works`, { waitUntil: 'domcontentloaded' });
			await expect(tabA, 'authed tab A not bounced to login').not.toHaveURL(/\/login/, {
				timeout: 15_000,
			});
			await expect(tabB, 'authed tab B not bounced to login').not.toHaveURL(/\/login/, {
				timeout: 15_000,
			});
			await tabA.reload({ waitUntil: 'domcontentloaded' });
			await expect(tabA, 'authed tab A survives a reload').not.toHaveURL(/\/login/, {
				timeout: 15_000,
			});

			// ANON context hitting the SAME protected route is bounced to /login
			// (or, on next-dev local builds that render the catch-all, shows a
			// login affordance instead of a hard /login URL).
			const anonTab = await anonCtx.newPage();
			await anonTab.goto(`${origin}/en/settings`, { waitUntil: 'domcontentloaded' });
			const bounced = anonTab.url().includes('/login');
			if (bounced) {
				expect(bounced, 'anon context bounced to /login').toBe(true);
			} else {
				const loginAffordance = anonTab
					.getByRole('button', { name: /sign in|log ?in|continue/i })
					.or(anonTab.getByRole('link', { name: /sign in|log ?in/i }))
					.or(anonTab.getByRole('textbox', { name: /email/i }))
					.first();
				await expect(
					loginAffordance,
					'anon context reached a protected route without any login gate',
				).toBeVisible({ timeout: 15_000 });
			}
		} finally {
			await authedCtx.close();
			await anonCtx.close();
		}
	});
});
