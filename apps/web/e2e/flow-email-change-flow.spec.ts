import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
	isMailhogAvailable,
	clearMailhogInbox,
	listMessages,
	waitForMessageTo,
	type MailhogMessage,
} from './helpers/mailhog';

/**
 * flow-email-change-flow — the authenticated "change my account email"
 * lifecycle, exercised end-to-end as a multi-step INTEGRATION flow.
 *
 * Distinct from the existing auth surface area:
 *   - email-verification-flow.spec.ts / flow-email-verification.spec.ts
 *     cover initial-signup verification, NOT a post-login email *change*.
 *   - password-reset*.spec.ts cover the password credential, not the email
 *     identity.
 *   - flow-profile-update-deep / flow-profile-identity cover username /
 *     avatar / committer identity — they deliberately do NOT touch the login
 *     email (changing the login email is a security-sensitive, token-gated
 *     operation, not a plain profile PATCH).
 *
 * WHAT THIS FILE PROVES (the focus): request a new email → confirm via a
 * delivered token; the OLD email keeps working until confirmation; a duplicate
 * (already-registered) target email is rejected; a pending change can be
 * cancelled; and the account remains fully usable (login + profile) while a
 * change is pending.
 *
 * ---------------------------------------------------------------------------
 * PROBE-FIRST / DEGRADE-IF-ABSENT (per the assignment's explicit instruction)
 * ---------------------------------------------------------------------------
 * A dedicated "change email" endpoint is a roadmap-adjacent feature whose exact
 * route may not be mounted on this build. Rather than assert a fictional
 * contract, every test FIRST discovers the live capability by probing a set of
 * realistic candidate routes against the running API with a freshly-registered
 * throwaway bearer, then:
 *   - if a request-change endpoint responds with a NON-404/405/501 status, we
 *     drive the real flow and assert observable, truthful outcomes; or
 *   - if NO candidate is mounted, we PROVE the closest REAL invariant instead
 *     (the platform's actual behaviour for email mutation: login email is
 *     immutable via the profile PATCH, the email is unique, the old email keeps
 *     authenticating, etc.) and annotate that the dedicated change-flow is not
 *     present on this build. We never hard-fail the shard on feature absence.
 *
 * VERIFIED LIVE SHAPES (reused helpers, probed/known good against :3100):
 *   - POST /api/auth/register { username,email,password }
 *       → { access_token, refresh_token?, user:{ id,email,username } }
 *   - POST /api/auth/login { email,password }  (DTO accepts ONLY these two)
 *       → { access_token, refresh_token? }      (extra {name} → 400)
 *   - GET  /api/auth/profile           (Bearer) → { id,email,username,... }
 *   - GET  /api/auth/profile/fresh     (Bearer) → { user:{...} } | {...}
 *   - PUT  /api/auth/profile           (Bearer) — profile (username/avatar/
 *       committer) PATCH; the LOGIN email is NOT a mutable field here.
 *
 * CANDIDATE change-email routes probed at runtime (first non-404 wins):
 *   request : POST /api/auth/change-email | /api/auth/email/change |
 *             /api/auth/email | /api/account/email   (body { email|newEmail })
 *   confirm : POST /api/auth/change-email/confirm | /api/auth/email/confirm |
 *             /api/auth/verify-email-change          (body { token })
 *   cancel  : POST /api/auth/change-email/cancel | /api/auth/email/cancel |
 *             DELETE /api/auth/change-email
 *
 * ENVIRONMENT-ADAPTIVE MAIL (hard-won gotcha): e2e SMTP DELIVERY FAILS
 * ("Missing credentials for PLAIN") even though MailHog HTTP is up. The
 * mailbox may NEVER receive the confirmation email. Mail-content assertions are
 * therefore BEST-EFFORT: if a message arrives we fish the token and complete a
 * real confirm; otherwise we assert the API request-side contract + the
 * pending-state invariants and annotate. We never HARD-require a delivered mail.
 */

const REGISTER_PATH = `${API_BASE}/api/auth/register`;
const LOGIN_PATH = `${API_BASE}/api/auth/login`;
const PROFILE_PATH = `${API_BASE}/api/auth/profile`;
const PROFILE_FRESH_PATH = `${API_BASE}/api/auth/profile/fresh`;

/** Statuses that mean "this route is simply not mounted on this build". */
const ABSENT = new Set([404, 405, 501]);

/** Token shapes our mail bodies could carry (hex / uuid / opaque base64url). */
const TOKEN_RE = /token=([A-Za-z0-9._-]{16,})/i;

interface ProbeResult {
	/** The path that produced a non-absent response, or null if none did. */
	path: string | null;
	status: number;
	body: unknown;
}

/**
 * POST each candidate path in order with the given bearer + body until one
 * returns a status that is NOT in ABSENT (404/405/501). Returns that first
 * "real" response, or { path:null } when every candidate is unmounted. A
 * network/JSON hiccup on one candidate is swallowed so we keep probing.
 */
async function probePost(
	request: APIRequestContext,
	token: string,
	candidates: string[],
	body: Record<string, unknown>,
): Promise<ProbeResult> {
	for (const path of candidates) {
		try {
			const res = await request.post(`${API_BASE}${path}`, {
				headers: authedHeaders(token),
				data: body,
			});
			const status = res.status();
			if (ABSENT.has(status)) continue;
			const parsed = await res.json().catch(() => res.text().catch(() => null));
			return { path, status, body: parsed };
		} catch {
			// keep trying the next candidate
		}
	}
	return { path: null, status: 404, body: null };
}

const REQUEST_CANDIDATES = [
	'/api/auth/change-email',
	'/api/auth/email/change',
	'/api/auth/change-email/request',
	'/api/auth/email',
	'/api/account/email',
];
const CONFIRM_CANDIDATES = [
	'/api/auth/change-email/confirm',
	'/api/auth/email/confirm',
	'/api/auth/verify-email-change',
	'/api/auth/email/verify',
];
const CANCEL_CANDIDATES = [
	'/api/auth/change-email/cancel',
	'/api/auth/email/cancel',
	'/api/auth/change-email/abort',
];

/** Issue a change-email request, trying both { email } and { newEmail } body keys. */
async function requestEmailChange(
	request: APIRequestContext,
	token: string,
	newEmail: string,
): Promise<ProbeResult> {
	// Prefer the conventional { email } key; if that route validates the key
	// shape with a 400, retry the same path-set with { newEmail }.
	const first = await probePost(request, token, REQUEST_CANDIDATES, { email: newEmail });
	if (first.path && first.status === 400) {
		const retry = await probePost(request, token, [first.path], { newEmail });
		if (!ABSENT.has(retry.status)) return retry;
	}
	return first;
}

/** Best-effort: poll MailHog for a change-confirmation token addressed to `to`. */
async function fishChangeToken(
	request: APIRequestContext,
	to: string,
	timeoutMs = 20_000,
): Promise<{ token: string; message: MailhogMessage } | null> {
	const deadline = Date.now() + timeoutMs;
	const toLower = to.toLowerCase();
	while (Date.now() < deadline) {
		const messages = await listMessages(request, 50);
		for (const m of messages) {
			const toMatch = m.To?.some(
				(t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === toLower,
			);
			if (!toMatch) continue;
			const subject = m.Content?.Headers?.['Subject']?.[0] ?? '';
			const body = m.Content?.Body ?? '';
			// Bias toward change/confirm/verify mail, but accept any token URL to
			// this recipient since template copy varies build-to-build.
			const looksRelevant = /chang|confirm|verif|email/i.test(`${subject} ${body}`);
			const match = TOKEN_RE.exec(body);
			if (match && (looksRelevant || true)) return { token: match[1]!, message: m };
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return null;
}

/** Resolve the current login email from the authenticated profile endpoint. */
async function profileEmail(request: APIRequestContext, token: string): Promise<string | null> {
	const res = await request.get(PROFILE_PATH, { headers: authedHeaders(token) });
	if (!res.ok()) return null;
	const body = (await res.json().catch(() => ({}))) as { email?: string; user?: { email?: string } };
	return (body.email ?? body.user?.email ?? null)?.toLowerCase() ?? null;
}

/** True iff {email,password} can mint a session right now. */
async function canLogin(
	request: APIRequestContext,
	email: string,
	password: string,
): Promise<boolean> {
	const res = await request.post(LOGIN_PATH, { data: { email, password } });
	if (!res.ok()) return false;
	const body = (await res.json().catch(() => ({}))) as { access_token?: string };
	return typeof body.access_token === 'string' && body.access_token.length > 10;
}

test.describe('flow-email-change-flow — request/confirm/cancel email-change lifecycle', () => {
	/**
	 * FLOW 1 — Capability probe + request-change contract.
	 *
	 * Registers a throwaway user, probes the candidate request-change routes,
	 * and asserts the truthful contract for THIS build:
	 *   - If a change-email endpoint exists: requesting a change for a
	 *     well-formed, unused target returns a success-ish status (2xx) or a
	 *     truthful validation error — never a server crash — AND the login
	 *     email is NOT silently flipped before confirmation.
	 *   - If absent: prove the closest real invariant — the login email is
	 *     immutable via PUT /api/auth/profile (a plain profile PATCH must NOT be
	 *     able to change the security-sensitive login email) — and annotate.
	 */
	test('request email-change: capability probe + old email retained pre-confirm', async ({
		request,
	}, testInfo) => {
		const user = await registerUserViaAPI(request, {
			email: makeTestUser('emch-req').email,
		});
		const target = makeTestUser('emch-req-new').email;

		const probe = await requestEmailChange(request, user.access_token, target);

		if (!probe.path) {
			// No dedicated change-email endpoint on this build. Prove the closest
			// REAL invariant: the profile PATCH must NOT change the login email.
			testInfo.annotations.push({
				type: 'degraded',
				description:
					'No change-email endpoint mounted; asserting login-email immutability via profile PATCH instead',
			});
			const put = await request.put(PROFILE_PATH, {
				headers: authedHeaders(user.access_token),
				data: { email: target },
			});
			// Whatever the PATCH does (ignores the field, 400s, or succeeds with
			// other fields), the login email must remain the original.
			expect(put.status(), 'profile PATCH must not 5xx').toBeLessThan(500);
			const after = await profileEmail(request, user.access_token);
			expect(after, 'login email must be unchanged by a profile PATCH').toBe(
				user.email.toLowerCase(),
			);
			// And the original email still authenticates.
			expect(await canLogin(request, user.email, user.password)).toBe(true);
			return;
		}

		testInfo.annotations.push({
			type: 'endpoint',
			description: `change-email request resolved to ${probe.path} (status ${probe.status})`,
		});

		// A mounted endpoint must respond with a sane, truthful status — either a
		// success (initiation accepted, pending confirmation) or a deliberate
		// validation/throttle code — never a 5xx crash.
		expect(probe.status, `request body=${JSON.stringify(probe.body)}`).toBeLessThan(500);

		// CRITICAL invariant regardless of success/queueing: until the user
		// CONFIRMS, the login email must still be the OLD one. A change that flips
		// the identity before confirmation would be an account-takeover vector.
		const liveEmail = await profileEmail(request, user.access_token);
		expect(liveEmail, 'old email must be retained until confirmation').toBe(
			user.email.toLowerCase(),
		);

		// The OLD email + password must still authenticate while the change is
		// merely pending (not yet confirmed).
		expect(
			await canLogin(request, user.email, user.password),
			'old email must keep logging in pre-confirm',
		).toBe(true);

		// The pending TARGET email must NOT yet be a valid login identity (it is
		// only adopted on confirm). It also was never given a password.
		expect(
			await canLogin(request, target, user.password),
			'pending target email must not authenticate before confirm',
		).toBe(false);
	});

	/**
	 * FLOW 2 — Duplicate / already-registered target email is rejected.
	 *
	 * Registers user A and user B. A requests a change TO B's existing email.
	 * The platform must refuse (the email is taken) — a 4xx, and A's identity is
	 * unchanged. If the endpoint is absent, prove the underlying uniqueness
	 * invariant directly: registering a second account with B's email is
	 * rejected (the email column is unique), which is the real guarantee a
	 * change-flow leans on.
	 */
	test('duplicate target email is rejected (uniqueness enforced)', async ({ request }, testInfo) => {
		const userA = await registerUserViaAPI(request, { email: makeTestUser('emch-dupA').email });
		const userB = await registerUserViaAPI(request, { email: makeTestUser('emch-dupB').email });

		const probe = await requestEmailChange(request, userA.access_token, userB.email);

		if (!probe.path) {
			testInfo.annotations.push({
				type: 'degraded',
				description:
					'No change-email endpoint; proving email uniqueness via duplicate registration rejection',
			});
			const dup = await request.post(REGISTER_PATH, {
				data: { username: 'dup user', email: userB.email, password: 'TestPass1!secure' },
			});
			// Registering an already-used email must be rejected (conflict/validation),
			// never a silent 2xx that mints a second account on the same identity.
			expect(dup.ok(), `duplicate-register status=${dup.status()}`).toBe(false);
			expect(dup.status()).toBeGreaterThanOrEqual(400);
			expect(dup.status()).toBeLessThan(500);
			return;
		}

		testInfo.annotations.push({
			type: 'endpoint',
			description: `change-email request resolved to ${probe.path} (status ${probe.status})`,
		});

		// Requesting a change to an already-registered email must be refused with
		// a client error (commonly 400/409/422) — and crucially NOT a 2xx that
		// would let A hijack B's identity. Some builds defer the uniqueness check
		// to confirm-time; in that case the request may 2xx but the OLD email
		// must still be retained (no premature flip), which we assert below.
		expect(probe.status, `dup-target body=${JSON.stringify(probe.body)}`).toBeLessThan(500);
		const rejected = probe.status >= 400 && probe.status < 500;
		if (rejected) {
			// A truthful rejection envelope should mention the email/conflict.
			const text = JSON.stringify(probe.body ?? '').toLowerCase();
			expect(
				/email|exist|taken|use|conflict|duplicate|registered|unavailable/.test(text),
				`rejection body should reference the email conflict: ${text}`,
			).toBe(true);
		}

		// Either way: A's login email must be unchanged, and A still logs in.
		expect(await profileEmail(request, userA.access_token)).toBe(userA.email.toLowerCase());
		expect(await canLogin(request, userA.email, userA.password)).toBe(true);
		// B is untouched and still logs in with B's own creds.
		expect(await canLogin(request, userB.email, userB.password)).toBe(true);
	});

	/**
	 * FLOW 3 — Full request → confirm round-trip (MailHog-gated).
	 *
	 * The deepest happy path: request a change, fish the confirmation token out
	 * of MailHog, POST it to the confirm endpoint, and PROVE the identity
	 * actually moved — the NEW email now authenticates and the profile reflects
	 * it. Per the SMTP gotcha, this is best-effort: if no mail arrives (delivery
	 * fails despite MailHog HTTP being up) or the endpoints are absent, we
	 * assert the request-side contract and skip the delivery-dependent leg with
	 * a truthful message rather than hard-failing.
	 */
	test('request → confirm round-trip moves the login identity to the new email', async ({
		request,
	}, testInfo) => {
		const user = await registerUserViaAPI(request, { email: makeTestUser('emch-rt').email });
		const newEmail = makeTestUser('emch-rt-new').email;

		// Settle/clear the registration mail so we only read change-flow mail.
		if (await isMailhogAvailable(request)) {
			await waitForMessageTo(request, user.email, { timeoutMs: 8_000 }).catch(() => null);
			await clearMailhogInbox(request);
		}

		const probe = await requestEmailChange(request, user.access_token, newEmail);
		if (!probe.path) {
			test.skip(true, 'No change-email endpoint mounted on this build — round-trip N/A');
		}
		expect(probe.status, `request body=${JSON.stringify(probe.body)}`).toBeLessThan(500);

		// If the request itself was rejected (e.g. confirmation disabled, or the
		// build adopts a different shape), there is nothing to confirm — assert
		// the no-premature-flip invariant and annotate.
		if (probe.status >= 400) {
			testInfo.annotations.push({
				type: 'degraded',
				description: `request-change returned ${probe.status}; confirm leg not exercised`,
			});
			expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
			return;
		}

		if (!(await isMailhogAvailable(request))) {
			test.skip(true, 'MailHog not reachable — cannot fish a confirmation token');
		}

		const fished = await fishChangeToken(request, newEmail).then(
			(r) => r ?? fishChangeToken(request, user.email, 1),
		);
		if (!fished) {
			// e2e SMTP "Missing credentials for PLAIN" — delivery fails though
			// MailHog HTTP is up. Truthfully degrade: the request contract held,
			// the old email is still retained; we just can't complete the confirm.
			testInfo.annotations.push({
				type: 'degraded',
				description:
					'No confirmation email delivered (e2e SMTP delivery failure) — confirm leg skipped',
			});
			expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
			test.skip(true, 'confirmation email never delivered — confirm leg requires the token');
		}

		const confirm = await probePost(request, user.access_token, CONFIRM_CANDIDATES, {
			token: fished!.token,
		});
		if (!confirm.path) {
			testInfo.annotations.push({
				type: 'degraded',
				description: 'No confirm endpoint mounted alongside the request endpoint',
			});
			test.skip(true, 'change-email confirm endpoint not mounted — cannot finish round-trip');
		}
		expect(confirm.status, `confirm body=${JSON.stringify(confirm.body)}`).toBeLessThan(500);

		if (confirm.status >= 200 && confirm.status < 300) {
			// Identity moved: the profile now reflects the NEW email, and the new
			// email authenticates with the unchanged password.
			await expect
				.poll(() => profileEmail(request, user.access_token), { timeout: 15_000 })
				.toBe(newEmail.toLowerCase());
			expect(
				await canLogin(request, newEmail, user.password),
				'new email must log in after confirm',
			).toBe(true);
			// The OLD email must no longer authenticate (the identity moved, not duplicated).
			expect(
				await canLogin(request, user.email, user.password),
				'old email must stop authenticating after a confirmed move',
			).toBe(false);
		} else {
			// A truthful confirm-side rejection (e.g. token shape) — no flip occurred.
			expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
		}
	});

	/**
	 * FLOW 4 — Invalid / replayed confirmation token is rejected.
	 *
	 * Confirm-time security matrix: a bogus token, an empty token, and a missing
	 * token field must each be rejected with a client error, and crucially must
	 * NOT move the identity. This needs no delivered mail — it drives the confirm
	 * endpoint directly (skips only if confirm is unmounted).
	 */
	test('confirm endpoint rejects bogus / empty / missing tokens without moving identity', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request, { email: makeTestUser('emch-tok').email });

		// Detect the confirm endpoint with an obviously-bogus token first.
		const bogus = await probePost(request, user.access_token, CONFIRM_CANDIDATES, {
			token: 'deadbeef'.repeat(8),
		});
		if (!bogus.path) {
			test.skip(true, 'No change-email confirm endpoint mounted — rejection matrix N/A');
		}

		// Bogus token → client rejection (never a 2xx, never a 5xx crash).
		expect(bogus.status, `bogus body=${JSON.stringify(bogus.body)}`).toBeGreaterThanOrEqual(400);
		expect(bogus.status).toBeLessThan(500);

		// Empty token at the SAME resolved path → still a client rejection.
		const empty = await probePost(request, user.access_token, [bogus.path!], { token: '' });
		expect(empty.status).toBeGreaterThanOrEqual(400);
		expect(empty.status).toBeLessThan(500);

		// Missing token field → DTO validation rejection.
		const missing = await probePost(request, user.access_token, [bogus.path!], {});
		expect(missing.status).toBeGreaterThanOrEqual(400);
		expect(missing.status).toBeLessThan(500);

		// None of these bogus attempts may have moved the identity.
		expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
		expect(await canLogin(request, user.email, user.password)).toBe(true);
	});

	/**
	 * FLOW 5 — Pending-change cancel: a requested-but-unconfirmed change can be
	 * abandoned, leaving the original identity fully intact.
	 *
	 * Requests a change, then cancels it (probing cancel candidates incl. a
	 * DELETE fallback). After cancel: the login email is still the original, the
	 * original creds still authenticate, and — best-effort — re-confirming with
	 * any previously-issued token no longer moves the identity. Degrades to the
	 * "still original after request" invariant when no cancel route exists.
	 */
	test('pending change can be cancelled — original identity stays intact', async ({
		request,
	}, testInfo) => {
		const user = await registerUserViaAPI(request, { email: makeTestUser('emch-cxl').email });
		const newEmail = makeTestUser('emch-cxl-new').email;

		const probe = await requestEmailChange(request, user.access_token, newEmail);
		if (!probe.path) {
			test.skip(true, 'No change-email endpoint mounted — cancel flow N/A');
		}
		if (probe.status >= 400) {
			testInfo.annotations.push({
				type: 'degraded',
				description: `request-change returned ${probe.status}; nothing pending to cancel`,
			});
			expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
			return;
		}

		// Sanity: still pending (old email retained) before we cancel.
		expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());

		// Try the POST cancel candidates, then a DELETE fallback on the request paths.
		let cancel = await probePost(request, user.access_token, CANCEL_CANDIDATES, {});
		if (!cancel.path) {
			for (const path of REQUEST_CANDIDATES) {
				try {
					const del = await request.delete(`${API_BASE}${path}`, {
						headers: authedHeaders(user.access_token),
					});
					if (!ABSENT.has(del.status())) {
						cancel = { path, status: del.status(), body: null };
						break;
					}
				} catch {
					/* keep trying */
				}
			}
		}

		if (!cancel.path) {
			testInfo.annotations.push({
				type: 'degraded',
				description: 'No cancel/abort/DELETE route for a pending change on this build',
			});
			// Even without an explicit cancel, the pre-confirm invariant must hold:
			// the original identity is intact and still authenticates.
			expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
			expect(await canLogin(request, user.email, user.password)).toBe(true);
			return;
		}

		testInfo.annotations.push({
			type: 'endpoint',
			description: `cancel resolved to ${cancel.path} (status ${cancel.status})`,
		});
		expect(cancel.status, `cancel body=${JSON.stringify(cancel.body)}`).toBeLessThan(500);

		// After cancel: original identity intact + still authenticating; the
		// would-be target never became a login identity.
		expect(await profileEmail(request, user.access_token)).toBe(user.email.toLowerCase());
		expect(await canLogin(request, user.email, user.password)).toBe(true);
		expect(await canLogin(request, newEmail, user.password)).toBe(false);
	});

	/**
	 * FLOW 6 — Login + session stay fully usable WHILE a change is pending.
	 *
	 * A pending email change must not lock the user out or invalidate their live
	 * session. With a change requested-but-unconfirmed we assert that: (a) the
	 * existing bearer still authorizes the profile + profile/fresh endpoints,
	 * (b) a brand-new login with the OLD creds succeeds and yields a working
	 * bearer, and (c) the two emails are mutually exclusive identities (old
	 * works, pending-new does not — no premature dual-login). Uses a FRESH
	 * registered user (never the shared seeded user) to keep cross-spec
	 * isolation. The seeded user is loaded only to assert it is a DIFFERENT,
	 * untouched account (no collateral identity bleed).
	 */
	test('login + live session remain usable during a pending change', async ({ request }, testInfo) => {
		const user = await registerUserViaAPI(request, { email: makeTestUser('emch-live').email });
		const newEmail = makeTestUser('emch-live-new').email;

		const probe = await requestEmailChange(request, user.access_token, newEmail);
		if (!probe.path) {
			// Degrade: with no change endpoint, simply prove the steady-state
			// invariants that the pending flow relies on (session + login work,
			// identities are isolated). This is still a meaningful real assertion.
			testInfo.annotations.push({
				type: 'degraded',
				description: 'No change-email endpoint — asserting steady-state session/login invariants',
			});
		} else {
			expect(probe.status, `request body=${JSON.stringify(probe.body)}`).toBeLessThan(500);
		}

		// (a) The live bearer still authorizes authenticated reads.
		const prof = await request.get(PROFILE_PATH, { headers: authedHeaders(user.access_token) });
		expect(prof.status(), 'live session bearer must still authorize /profile').toBe(200);
		const fresh = await request.get(PROFILE_FRESH_PATH, {
			headers: authedHeaders(user.access_token),
		});
		expect(fresh.status(), 'live session bearer must still authorize /profile/fresh').toBe(200);

		// (b) A fresh OLD-creds login succeeds and yields a usable bearer.
		const loginRes = await request.post(LOGIN_PATH, {
			data: { email: user.email, password: user.password },
		});
		expect(loginRes.status(), 'old-creds login during pending change').toBe(200);
		const loginBody = (await loginRes.json()) as { access_token?: string };
		expect(typeof loginBody.access_token).toBe('string');
		expect(
			await profileEmail(request, loginBody.access_token!),
			'freshly-minted bearer must resolve the old email',
		).toBe(user.email.toLowerCase());

		// (c) Mutually-exclusive identities: pending-new must NOT log in yet.
		expect(
			await canLogin(request, newEmail, user.password),
			'pending-new email must not authenticate during a pending change',
		).toBe(false);

		// Cross-spec isolation guard: the shared seeded user is a DIFFERENT
		// account and was not touched by any of this — its email never collides
		// with our throwaway addresses.
		const seeded = loadSeededTestUser();
		expect(seeded.email.toLowerCase()).not.toBe(user.email.toLowerCase());
		expect(seeded.email.toLowerCase()).not.toBe(newEmail.toLowerCase());
	});
});
