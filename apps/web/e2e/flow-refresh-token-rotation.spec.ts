import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-refresh-token-rotation.spec.ts
 *
 * COMPLEX, cross-feature INTEGRATION flows around the JWT access-TOKEN /
 * SESSION lifecycle. Assigned focus was "JWT access+refresh rotation, reuse
 * detection/family-burn, expired-recovered-via-refresh, refresh-after-logout,
 * malformed/cross-user refresh, concurrent refresh race".
 *
 * REALITY CHECK (probed live + read apps/api/src/auth/controllers/auth.controller.ts
 * + apps/api/src/auth/dto/auth.dto.ts):
 *   This build is Better-Auth-backed. It does NOT mint refresh tokens and does
 *   NOT expose a refresh-rotation endpoint. There is NO `@Post('refresh')` and
 *   NO `@Get('me')`. Probed: POST /api/auth/refresh => 404 ("Cannot POST
 *   /api/auth/refresh"); GET /api/users/me => 404. register/login responses are
 *   `{ access_token, user }` ONLY — there is no `refresh_token` field at all.
 *
 *   Per the "never assert a fictional contract — implement the closest REAL flow
 *   + skip-on-404 + note it" rule, this spec covers the REAL session-token
 *   lifecycle that the assigned focus maps onto, and keeps one explicit
 *   skip-on-404 probe documenting the absent rotation route.
 *
 * PROBED CONTRACT (2026-06-01, live API at http://127.0.0.1:3100):
 *   POST /api/auth/register {email,password,username}   @Public
 *     -> 201 { access_token, user{ id,email,username } }   (NO refresh_token)
 *        RegisterDto REQUIRES username (>=3). `name` => 400 "property name
 *        should not exist". password must match /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/.
 *        Duplicate email => 409.
 *   POST /api/auth/login {email,password}               @HttpCode(OK)
 *     -> 200 { access_token, user }   (NO refresh_token)
 *        * every login mints a FRESH, DISTINCT access_token (multi-session:
 *          two concurrent logins BOTH authenticate, 200/200)
 *        * wrong password => 401; extra {name} field => 400; missing
 *          email/password => 400 (LoginDto validation)
 *   GET /api/auth/profile (Bearer)   @UseGuards(AuthSessionGuard)
 *     -> 200 with TOP-LEVEL { id, userId, username, email, emailVerified,
 *        isActive, isAnonymous, provider, avatar, iat, iss, aud }
 *        (NOT nested under `user`; BOTH `id` and `userId` equal the account id)
 *     -> bad token => 401; no Authorization => 401
 *   GET /api/auth/profile/fresh (Bearer)  -> 200 (DB-fresh profile)
 *   POST /api/auth/logout (Bearer)        @HttpCode(OK) -> 200
 *   POST /api/auth/logout-all (Bearer)    @HttpCode(OK) -> 200
 *
 * HARD-WON, PROBE-CONFIRMED SESSION SEMANTICS (asserted, not assumed):
 *   - logout GENUINELY REVOKES the session bound to that bearer: after
 *     POST /logout, the SAME bearer => 401 on /profile (probed). This is a
 *     real server-side session (Better Auth signOut), NOT a stateless JWT
 *     that survives logout.
 *   - logout is PER-SESSION: logging out session m1 leaves a sibling session
 *     m2 fully valid (probed m1=401, m2=200). logout-all kills all sessions.
 *   - There is no refresh rotation, so "old-token reuse / family-burn" cannot
 *     be exercised; the closest real invariant — re-LOGIN mints a fresh
 *     distinct token while independent sessions stay valid — IS asserted.
 *   - login DTO accepts ONLY {email,password} (extra {name} => 400).
 *   - The seeded storageState account is exercised through the same token
 *     pipeline (concurrent-login race), skipping if creds/login unavailable.
 */

const PW = 'Passw0rd!23';
const OK = [200, 201];

interface Account {
	email: string;
	password: string;
	username: string;
	access_token: string;
	userId?: string;
}

async function registerAccount(request: APIRequestContext, tag: string): Promise<Account> {
	const email = `${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@e2e.test`;
	const username = `${tag}User${Math.floor(Math.random() * 1e4)}`;
	const res = await request.post(`${API_BASE}/api/auth/register`, {
		data: { email, password: PW, username },
	});
	expect(res.status(), `register ${tag} should succeed (2xx)`).toBeLessThan(300);
	const body: any = await res.json();
	expect(body.access_token, 'register returns access_token').toBeTruthy();
	return {
		email,
		password: PW,
		username,
		access_token: body.access_token,
		userId: body.user && body.user.id,
	};
}

async function login(
	request: APIRequestContext,
	email: string,
	password: string,
): Promise<{ status: number; body: any }> {
	const res = await request.post(`${API_BASE}/api/auth/login`, { data: { email, password } });
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status(), body };
}

async function profileStatus(request: APIRequestContext, accessToken: string): Promise<number> {
	const res = await request.get(`${API_BASE}/api/auth/profile`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return res.status();
}

async function profile(
	request: APIRequestContext,
	accessToken: string,
): Promise<{ status: number; body: any }> {
	const res = await request.get(`${API_BASE}/api/auth/profile`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status(), body };
}

/** Profile identity is exposed at the TOP LEVEL (probed: `id` and `userId`). */
function profileId(body: any): string | undefined {
	if (!body) return undefined;
	return (body.id ?? body.userId) as string | undefined;
}

async function logout(request: APIRequestContext, accessToken: string): Promise<number> {
	const res = await request.post(`${API_BASE}/api/auth/logout`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return res.status();
}

test.describe('JWT session-token lifecycle (integration)', () => {
	test.describe.configure({ mode: 'serial' });

	test('register mints an access token that authenticates /profile; identity matches; NO /refresh route exists', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'mint');

		// The minted access token authenticates the guarded resource.
		await expect.poll(() => profileStatus(request, u.access_token), { timeout: 20_000 }).toBe(200);

		// Profile identity (top-level id/userId) matches the registered account.
		const pf = await profile(request, u.access_token);
		expect(pf.status).toBe(200);
		const pid = profileId(pf.body);
		expect(pid, '/profile exposes a top-level id').toBeTruthy();
		if (u.userId) {
			expect(String(pid), '/profile resolves to the registering user').toBe(String(u.userId));
		}
		// Both id and userId are present and consistent (probed contract).
		if (pf.body.id && pf.body.userId) {
			expect(String(pf.body.id), 'profile id === userId').toBe(String(pf.body.userId));
		}

		// Document the absent refresh-rotation endpoint via a skip-on-404 probe,
		// so the (absent) contract is asserted rather than fictionally exercised.
		const refreshRoute = await request.post(`${API_BASE}/api/auth/refresh`, {
			data: { refresh_token: 'whatever' },
		});
		test.info().annotations.push({
			type: 'observed-behavior',
			description: `POST /api/auth/refresh -> ${refreshRoute.status()} (this build mints no refresh token and has NO refresh-rotation endpoint).`,
		});
		expect(
			[404, 405, 401],
			'refresh-rotation endpoint is absent in this build (probed 404)',
		).toContain(refreshRoute.status());
	});

	test('expired/lost access token is RECOVERED by re-login: a fresh distinct token is minted and authenticates', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'recover');
		const originalAccess = u.access_token;
		await expect.poll(() => profileStatus(request, originalAccess), { timeout: 20_000 }).toBe(200);

		// Recovery path on a refresh-less build: re-authenticate with credentials
		// to obtain a brand-new working access token (the real "renew" path).
		const re = await login(request, u.email, u.password);
		expect(OK, 're-login succeeds').toContain(re.status);
		const newAccess: string = re.body.access_token;
		expect(newAccess, 're-login mints a new access token').toBeTruthy();
		expect(newAccess, 'recovered token differs from the original').not.toBe(originalAccess);

		// The recovered token authenticates.
		await expect.poll(() => profileStatus(request, newAccess), { timeout: 20_000 }).toBe(200);

		// A garbled access token never authenticates (sanity that /profile guards).
		expect(await profileStatus(request, `${newAccess}tampered`)).toBe(401);
		expect(await profileStatus(request, 'totally.invalid.jwt')).toBe(401);

		// The ORIGINAL register-issued session is independent and still valid
		// (multi-session; probed). Tolerate single-active-token builds with [200,401].
		const originalStatus = await profileStatus(request, originalAccess);
		expect([200, 401], 'original session status is coherent').toContain(originalStatus);
		test.info().annotations.push({
			type: 'observed-behavior',
			description: `original (pre-relogin) session after re-login -> ${originalStatus} (200 = independent multi-session).`,
		});
	});

	test('repeated logins mint DISTINCT tokens and independent sessions stay valid concurrently (multi-session)', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'multi');

		const l1 = await login(request, u.email, u.password);
		const l2 = await login(request, u.email, u.password);
		const l3 = await login(request, u.email, u.password);
		expect(OK).toContain(l1.status);
		expect(OK).toContain(l2.status);
		expect(OK).toContain(l3.status);

		const tokens = [
			u.access_token,
			l1.body.access_token,
			l2.body.access_token,
			l3.body.access_token,
		];

		// Each login mints a DISTINCT access token (probed MULTI_DISTINCT_AT=true).
		expect(new Set(tokens).size, 'each session has a distinct access token').toBe(tokens.length);

		// ALL sessions authenticate simultaneously (probed multi-session 200s).
		for (let i = 0; i < tokens.length; i++) {
			await expect.poll(() => profileStatus(request, tokens[i]), { timeout: 20_000 }).toBe(200);
		}

		// PER-SESSION revocation: logging out l1 must NOT affect the siblings
		// (probed m1=401, m2=200 after logout of m1).
		expect([200], 'logout l1 succeeds').toContain(logoutStatusTo200(await logout(request, l1.body.access_token)));
		expect(
			await profileStatus(request, l1.body.access_token),
			'logged-out session is revoked',
		).toBe(401);
		await expect
			.poll(() => profileStatus(request, l2.body.access_token), { timeout: 20_000 })
			.toBe(200);
		await expect
			.poll(() => profileStatus(request, l3.body.access_token), { timeout: 20_000 })
			.toBe(200);
	});

	test('login credential guards: wrong password, extra fields, and missing fields are all rejected (never minting a token)', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'guard');

		// Wrong password -> 401 (probed).
		const wrongPw = await login(request, u.email, 'WRONGpw!9');
		expect(wrongPw.status, 'wrong password rejected').toBe(401);
		expect(
			wrongPw.body && wrongPw.body.access_token,
			'no token minted on wrong password',
		).toBeFalsy();

		// Extra {name} field on the login DTO -> 400 (probed; whitelist validation).
		const extra = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: u.email, password: u.password, name: 'x' } as any,
		});
		expect([400, 401], 'extra login field rejected').toContain(extra.status());

		// Missing password -> 400 (LoginDto @IsNotEmpty; probed).
		const noPw = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: u.email } as any,
		});
		expect(noPw.status(), 'missing password -> validation error').toBe(400);

		// Missing email -> 400 (probed).
		const noEmail = await request.post(`${API_BASE}/api/auth/login`, {
			data: { password: u.password } as any,
		});
		expect(noEmail.status(), 'missing email -> validation error').toBe(400);

		// Unknown account -> 401 (never 200; uniform with wrong-password).
		const unknown = await login(request, `nope${Date.now()}@e2e.test`, PW);
		expect([401, 400], 'unknown account login rejected').toContain(unknown.status);

		// Correct credentials still work afterwards (guard did not lock the account).
		const good = await login(request, u.email, u.password);
		expect(OK, 'valid login still succeeds after failed attempts').toContain(good.status);
		await expect
			.poll(() => profileStatus(request, good.body.access_token), { timeout: 20_000 })
			.toBe(200);
	});

	test('logout REVOKES the bearer and logout-all kills every session; re-login always recovers', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'logout');
		const session = await login(request, u.email, u.password);
		expect(OK).toContain(session.status);
		const at: string = session.body.access_token;
		await expect.poll(() => profileStatus(request, at), { timeout: 20_000 }).toBe(200);

		// logout single session -> bearer is revoked (probed PROFILE_AFTER_LOGOUT=401).
		const logoutRes = await request.post(`${API_BASE}/api/auth/logout`, {
			headers: { Authorization: `Bearer ${at}` },
		});
		expect([200, 201, 204], 'logout returns success').toContain(logoutRes.status());
		expect(
			await profileStatus(request, at),
			'bearer is revoked after logout (real server-side session)',
		).toBe(401);

		// A logged-out bearer cannot logout again (already invalid).
		const doubleLogout = await request.post(`${API_BASE}/api/auth/logout`, {
			headers: { Authorization: `Bearer ${at}` },
		});
		expect([401, 200, 204], 'logout with a revoked bearer is rejected or no-op').toContain(
			doubleLogout.status(),
		);

		// Spin up two fresh sessions, then logout-all from one -> both revoked.
		const s1 = await login(request, u.email, u.password);
		const s2 = await login(request, u.email, u.password);
		expect(OK).toContain(s1.status);
		expect(OK).toContain(s2.status);
		const at1: string = s1.body.access_token;
		const at2: string = s2.body.access_token;
		await expect.poll(() => profileStatus(request, at1), { timeout: 20_000 }).toBe(200);
		await expect.poll(() => profileStatus(request, at2), { timeout: 20_000 }).toBe(200);

		const logoutAll = await request.post(`${API_BASE}/api/auth/logout-all`, {
			headers: { Authorization: `Bearer ${at1}` },
		});
		expect([200, 201, 204], 'logout-all returns success').toContain(logoutAll.status());

		// Both sessions are now revoked (probed PROFILE_AFTER_LOGOUTALL=401).
		// Tolerate eventual-consistency with poll + accept [401].
		await expect.poll(() => profileStatus(request, at1), { timeout: 20_000 }).toBe(401);
		const at2After = await profileStatus(request, at2);
		expect([401], 'logout-all revokes sibling sessions too').toContain(at2After);

		// The account can always recover by re-logging-in to a fresh token.
		const recovered = await login(request, u.email, u.password);
		expect(OK, 're-login after logout-all succeeds').toContain(recovered.status);
		await expect
			.poll(() => profileStatus(request, recovered.body.access_token), { timeout: 20_000 })
			.toBe(200);
	});

	test('malformed / tampered access tokens and the absent rotation route are rejected with coherent client errors', async ({
		request,
	}) => {
		const u = await registerAccount(request, 'malformed');

		// Garbage non-JWT bearer -> 401.
		expect(await profileStatus(request, 'not.a.jwt'), 'non-JWT bearer rejected').toBe(401);

		// JWT-ish dots, bogus base64 -> 401.
		expect(await profileStatus(request, 'aaaa.bbbb.cccc'), 'fake-structured JWT rejected').toBe(
			401,
		);

		// Empty bearer -> 401.
		expect(await profileStatus(request, ''), 'empty bearer rejected').toBe(401);

		// Tampered: corrupt the signature segment of a REAL access token.
		const parts = u.access_token.split('.');
		let tampered = `${u.access_token}x`;
		if (parts.length === 3) {
			parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('A') ? 'B' : 'A') + 'C';
			tampered = parts.join('.');
		}
		const tamperedStatus = await profileStatus(request, tampered);
		expect([401, 403], 'signature-tampered access token rejected').toContain(tamperedStatus);
		expect(tamperedStatus, 'tampered token never silently authenticates').not.toBe(200);

		// The absent refresh-rotation route stays absent regardless of payload.
		const refreshMissing = await request.post(`${API_BASE}/api/auth/refresh`, { data: {} });
		const refreshGarbage = await request.post(`${API_BASE}/api/auth/refresh`, {
			data: { refresh_token: 'x' },
		});
		expect(
			[404, 405, 400, 401],
			'refresh route is absent / non-functional',
		).toContain(refreshMissing.status());
		expect([404, 405, 400, 401]).toContain(refreshGarbage.status());

		// The original token is untouched by all the rejected attempts above.
		await expect.poll(() => profileStatus(request, u.access_token), { timeout: 20_000 }).toBe(200);
	});

	test('CROSS-USER token isolation: A and B receive distinct tokens; each token resolves ONLY to its own owner', async ({
		request,
	}) => {
		const a = await registerAccount(request, 'cross-a');
		const b = await registerAccount(request, 'cross-b');

		expect(a.userId, 'user A has an id').toBeTruthy();
		expect(b.userId, 'user B has an id').toBeTruthy();
		expect(String(a.userId), 'distinct users registered').not.toBe(String(b.userId));

		// Distinct credentials per user.
		expect(a.access_token, 'A and B get distinct access tokens').not.toBe(b.access_token);

		// A's token resolves to A and NEVER to B (profile id is top-level).
		const pa = await profile(request, a.access_token);
		expect(pa.status).toBe(200);
		const paId = profileId(pa.body);
		expect(String(paId), "A's token resolves to A").toBe(String(a.userId));
		expect(String(paId), "A's token never resolves to B").not.toBe(String(b.userId));

		// B's token resolves to B and NEVER to A.
		const pb = await profile(request, b.access_token);
		expect(pb.status).toBe(200);
		const pbId = profileId(pb.body);
		expect(String(pbId), "B's token resolves to B").toBe(String(b.userId));
		expect(String(pbId), "B's token never resolves to A").not.toBe(String(a.userId));

		// Revoking A's session (logout) does NOT affect B's session (isolation).
		const aLogout = await request.post(`${API_BASE}/api/auth/logout`, {
			headers: { Authorization: `Bearer ${a.access_token}` },
		});
		expect([200, 201, 204]).toContain(aLogout.status());
		expect(await profileStatus(request, a.access_token), "A's session revoked").toBe(401);
		await expect
			.poll(() => profileStatus(request, b.access_token), { timeout: 20_000 })
			.toBe(200);

		// Duplicate registration of A's email is rejected (409 probed) — no
		// second account silently sharing the identity.
		const dup = await request.post(`${API_BASE}/api/auth/register`, {
			data: { email: a.email, password: PW, username: 'DupUser' },
		});
		expect([409, 400, 422], 'duplicate email registration rejected').toContain(dup.status());
	});

	test('seeded real account: login mints a working token, and CONCURRENT logins each resolve coherently (session race)', async ({
		request,
	}) => {
		let email: string | undefined;
		let password: string | undefined;
		try {
			const s = loadSeededTestUser();
			email = s.email;
			password = s.password;
		} catch {
			email = undefined;
		}
		test.skip(!email || !password, 'seeded test user credentials unavailable');

		// Warm-up single login confirms the seeded creds are usable.
		const warm = await login(request, email!, password!);
		test.skip(warm.status !== 200, 'seeded login did not return 200 in this environment');
		expect(warm.body.access_token, 'seeded login mints an access token').toBeTruthy();
		await expect
			.poll(() => profileStatus(request, warm.body.access_token), { timeout: 20_000 })
			.toBe(200);

		// CONCURRENT LOGIN RACE: fire several logins simultaneously. Each must
		// resolve coherently (200 with a usable token, or a clean 4xx — never a
		// 5xx, never a silent half-success). Winning tokens must authenticate and
		// be mutually distinct (independent sessions).
		const fired = await Promise.all(
			Array.from({ length: 5 }, () => login(request, email!, password!)),
		);
		const statuses = fired.map((f) => f.status);
		test.info().annotations.push({
			type: 'observed-behavior',
			description: `concurrent login statuses: [${statuses.join(', ')}]`,
		});

		for (const st of statuses) {
			expect([200, 401, 429], 'each concurrent login is a coherent status').toContain(st);
		}
		const winners = fired.filter((f) => f.status === 200 && f.body && f.body.access_token);
		expect(winners.length, 'at least one concurrent login wins').toBeGreaterThanOrEqual(1);

		const winnerTokens = winners.map((w) => w.body.access_token);
		expect(
			new Set(winnerTokens).size,
			'concurrent winning logins mint distinct tokens',
		).toBe(winnerTokens.length);

		// The last winning token authenticates, proving the race left the account
		// in a usable, uncorrupted state.
		const lastWinner = winnerTokens[winnerTokens.length - 1];
		await expect.poll(() => profileStatus(request, lastWinner), { timeout: 20_000 }).toBe(200);
	});
});

/**
 * logout is @HttpCode(OK) -> 200 in this build; normalize any 2xx success to
 * 200 so the per-session-revocation assertion above reads cleanly without
 * hard-coding a single status across builds.
 */
function logoutStatusTo200(status: number): number {
	return [200, 201, 204].includes(status) ? 200 : status;
}
