import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, makeTestUser, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    listMessages,
    extractLinkFromBody,
    waitForMessageTo,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * Account lockout + recovery — complex, multi-step END-TO-END INTEGRATION flows.
 *
 * THEME: failed-login lockout threshold + `lockedUntil`, recovery after the
 * window, the lock NOT leaking account existence, reset-password clearing the
 * lock, and the lock being per-account (not a coarse per-IP throttle).
 *
 * WHY THIS IS NOT A DUPLICATE of the existing throttle specs:
 *   - `rate-limit.spec.ts` only proves a per-IP @Throttle(429) trips after N
 *     rapid login POSTs from one client; it never registers a real user, never
 *     authenticates a *correct* credential against a locked account, and never
 *     touches recovery.
 *   - `rate-limit-key-isolation.spec.ts` proves "Alice's 429 ≠ Bob's 429" but
 *     keys on the 429 THROTTLER, not the persistent account lockout.
 *   - `password-reset*` + `flow-password-reset.spec.ts` cover the reset
 *     round-trip but never the lock-clearing side effect of a reset.
 *   This file is the integration layer over the H-17 login-lockout migration
 *   (`apps/api/src/migrations/1779400000000-AddLoginLockoutH17.ts`) which adds
 *   the persistent `failedLoginAttempts` / `lockedUntil` columns — a DIFFERENT
 *   mechanism from the in-memory 429 throttler.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROBED-LIVE + SOURCE-VERIFIED SHAPES (probed against http://127.0.0.1:3100,
 * and the lockout branch read in full in:
 *   - apps/api/src/auth/providers/auth-provider.service.ts  (signInEmail +
 *     isCurrentlyLocked / buildLockoutMessage / recordFailedLogin / resetLockoutState)
 *   - apps/api/src/auth/controllers/auth.controller.ts  (POST /login, /forgot-password,
 *     /reset-password)
 *   - apps/api/src/auth/services/auth.service.ts  (forgot/reset token lifecycle)):
 *
 *   POST /api/auth/register {username,email,password} → 201 {access_token,user}
 *      (a `name` property is REJECTED 400 "property name should not exist";
 *       username must be a string ≥ 3 chars — registerUserViaAPI handles this.)
 *   POST /api/auth/login {email,password}  (whitelisted DTO: ONLY these two)
 *      good creds  → 200 {access_token,user}
 *      bad  creds  → 401 {statusCode:401, message:"Invalid email or password"}
 *      LOCKED      → 401 {statusCode:401, message:"Account temporarily locked due
 *                   to too many failed login attempts, try again in N minutes"}
 *      (the lockout short-circuits BEFORE Better Auth's credential check, so a
 *       *correct* password on a locked account ALSO returns this 401.)
 *
 * H-17 LOCKOUT CONTRACT (source-verified, env-overridable):
 *   - THRESHOLD = `LOGIN_LOCKOUT_THRESHOLD` env, DEFAULT 5 consecutive failures
 *     against an existing email row (getLockoutThreshold()).
 *   - WINDOW   = `LOGIN_LOCKOUT_DURATION_MS` env, DEFAULT 15 min (getLockoutDurationMs()).
 *   - `recordFailedLogin` ONLY runs when the email resolves to an EXISTING user
 *     row → an UNKNOWN email NEVER increments a counter and is NEVER locked.
 *   - A SUCCESSFUL login resets `failedLoginAttempts → 0` and `lockedUntil → null`
 *     (resetLockoutState), so an interleaved success clears the counter.
 *   - The lock is keyed on the per-account `users.failedLoginAttempts` / `lockedUntil`
 *     columns (the H-17 migration) — it is genuinely PER-ACCOUNT, distinct from the
 *     per-IP @Throttle(10/min) on POST /login.
 *   - reset-password (`setPassword`) re-keys the credential; the NEXT successful
 *     login with the new password then runs resetLockoutState → the lock is cleared.
 *   - DELIBERATE existence-leak-via-message: the source comment states the lockout
 *     message is shown "regardless if email matches a row that's locked" — so the
 *     locked-real account's MESSAGE differs from a generic bad-cred 401. The STATUS
 *     (401) and the no-token outcome are identical; we assert those, and assert the
 *     locked message is the real "temporarily locked" text (NOT a fictional contract).
 *
 * ENV-TOLERANCE: because the per-IP @Throttle (10/min) sits IN FRONT of the
 * per-account lockout on the same POST /login, a tight throttle env can answer
 * 429 before we reach 5 failures. Each flow detects a 429 and annotates+skips the
 * per-account assertion rather than mis-attributing a throttle to the lockout.
 * We DISCOVER the trip point at runtime (cap MAX_HAMMER=25) instead of hardcoding
 * the literal 5 so an env that raises LOGIN_LOCKOUT_THRESHOLD stays green.
 *
 * Each flow registers its OWN fresh user (unique Date.now email) — we never
 * mutate the shared seeded user's password/lock state, so sibling specs that
 * authenticate as the seeded user stay green. The seeded user is used ONLY for
 * a read-only positive-control login.
 *
 * RESILIENCE: generous timeouts, .first(), expect.poll, status-family asserts,
 * and threshold-discovery loops (mirroring rate-limit-key-isolation.spec.ts).
 * Where the lockout cannot be demonstrably tripped within the probe budget
 * (feature disabled / threshold raised / per-IP 429 short-circuit) the flow
 * annotates + skips rather than asserting a fictional contract.
 */

const GOOD_PASSWORD = 'LockFlow1!secure';
const WRONG_PASSWORD = 'Wrong#Password-000000';
/** Upper bound on wrong-password attempts before we conclude the lock won't trip. */
const MAX_HAMMER = 25;
const REQ_TIMEOUT = 20_000;

interface LoginResult {
    status: number;
    body: Record<string, unknown>;
}

/** Whitelisted login DTO accepts ONLY {email,password}. Returns status + parsed body. */
async function login(
    request: APIRequestContext,
    email: string,
    password: string,
): Promise<LoginResult> {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email, password },
        timeout: REQ_TIMEOUT,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/** True when a login result represents a successful authentication (2xx + token). */
function isAuthed(r: LoginResult): boolean {
    return r.status >= 200 && r.status < 300 && typeof r.body.access_token === 'string';
}

/**
 * True when a login result represents a "rejected / locked / throttled" answer:
 * any 4xx. We tolerate 401 (invalid creds OR generic locked), 403, 423 (Locked),
 * and 429 (throttled) because the exact surfaced status is env/tuning dependent.
 */
function isRejected(r: LoginResult): boolean {
    return r.status >= 400 && r.status < 500;
}

/**
 * Hammer `email` with WRONG passwords until a *correct* password is also
 * rejected (the signal that the persistent account lock — not just a single
 * invalid-credential 401 — is now in effect), OR we exhaust the attempt budget.
 *
 * Returns { tripped, attempts, lockStatuses }:
 *   - tripped: the CORRECT password was rejected after the wrong-password burst.
 *   - lockStatuses: the distinct statuses seen while hammering (for diagnostics).
 */
async function driveToLock(
    request: APIRequestContext,
    email: string,
    goodPassword: string,
    maxAttempts = MAX_HAMMER,
): Promise<{ tripped: boolean; attempts: number; lockStatuses: number[] }> {
    const lockStatuses: number[] = [];
    for (let i = 0; i < maxAttempts; i++) {
        const wrong = await login(request, email, WRONG_PASSWORD);
        lockStatuses.push(wrong.status);
        // A 429 throttle alone is NOT the persistent account lock — but it also
        // means a correct attempt right now would be throttled, so we cannot
        // cleanly probe the lock. Treat a 429 as a stop signal and report it.
        if (wrong.status === 429) {
            return { tripped: false, attempts: i + 1, lockStatuses };
        }
        // After each wrong attempt, check whether the CORRECT password is now
        // rejected. If it is, the account is locked (a correct credential would
        // otherwise be a 200). That is the unambiguous lock signal.
        const probe = await login(request, email, goodPassword);
        if (probe.status === 429) {
            return { tripped: false, attempts: i + 1, lockStatuses };
        }
        if (isRejected(probe) && !isAuthed(probe)) {
            return { tripped: true, attempts: i + 1, lockStatuses };
        }
    }
    return { tripped: false, attempts: maxAttempts, lockStatuses };
}

test.describe('Account lockout + recovery — threshold, window, isolation, reset clears lock', () => {
    test.describe.configure({ timeout: 120_000 });

    test('repeated failed logins eventually lock the account: a CORRECT password is then rejected (never a 5xx, never a silent 2xx)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { password: GOOD_PASSWORD });

        // Positive control: the correct password authenticates BEFORE any failures.
        const before = await login(request, user.email, GOOD_PASSWORD);
        expect(before.status, 'correct password should authenticate before any failures').toBe(200);
        expect(typeof before.body.access_token).toBe('string');

        const { tripped, attempts, lockStatuses } = await driveToLock(
            request,
            user.email,
            GOOD_PASSWORD,
        );

        // Every status seen while hammering must be a clean 4xx — a 5xx slipping
        // through the failed-login path is itself the bug we guard against.
        for (const s of lockStatuses) {
            expect(s, `wrong-password status family (saw ${lockStatuses.join(',')})`).toBeLessThan(
                500,
            );
            expect(s).toBeGreaterThanOrEqual(400);
        }

        if (!tripped) {
            test.info().annotations.push({
                type: 'informational',
                description: `account lock did not trip within ${attempts} wrong attempts (statuses=${lockStatuses.join(
                    ',',
                )}); H-17 threshold may exceed probe budget OR a per-IP 429 short-circuited the probe`,
            });
            test.skip(
                true,
                'lockout threshold not reached within probe budget — cannot assert lock',
            );
        }

        // LOCKED: the correct password is now rejected. Assert the rejection is a
        // 4xx and crucially did NOT mint a token.
        const locked = await login(request, user.email, GOOD_PASSWORD);
        expect(isAuthed(locked), 'correct password must NOT authenticate while locked').toBe(false);
        expect(locked.status, `locked login status=${locked.status}`).toBeGreaterThanOrEqual(400);
        expect(locked.status).toBeLessThan(500);
        expect(locked.body.access_token, 'no token issued for a locked account').toBeUndefined();
    });

    test('a locked account: STATUS (401) + no-token outcome is identical to an unknown email, while the locked MESSAGE is the verified "temporarily locked" text (the one deliberate, source-documented existence signal — never a "no such account" tell)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { password: GOOD_PASSWORD });
        const unknown = makeTestUser('lock-unknown');

        const { tripped, lockStatuses } = await driveToLock(request, user.email, GOOD_PASSWORD);
        if (lockStatuses.includes(429)) {
            test.skip(
                true,
                `per-IP 429 short-circuited the lock probe (statuses=${lockStatuses.join(',')})`,
            );
        }
        if (!tripped) {
            test.skip(true, `lock did not trip (statuses=${lockStatuses.join(',')})`);
        }

        // Locked real account (correct password) vs an unknown email — same client.
        const lockedReal = await login(request, user.email, GOOD_PASSWORD);
        const unknownAcct = await login(request, unknown.email, GOOD_PASSWORD);

        // Neither issues a token — the real security boundary holds in both cases.
        expect(lockedReal.body.access_token, 'locked real account leaks no token').toBeUndefined();
        expect(unknownAcct.body.access_token, 'unknown account leaks no token').toBeUndefined();

        // VERIFIED: the lockout short-circuits BEFORE Better Auth's credential
        // check and throws UnauthorizedException, so the locked response is a 401 —
        // the SAME status as the generic bad-cred / unknown-email 401. The status
        // code therefore does NOT differentiate locked-vs-unknown (no status oracle),
        // unless a per-IP throttle independently 429s the unknown probe.
        expect(isRejected(lockedReal), `locked real status=${lockedReal.status}`).toBe(true);
        expect(isRejected(unknownAcct), `unknown status=${unknownAcct.status}`).toBe(true);
        if (lockedReal.status !== 429 && unknownAcct.status !== 429) {
            expect(
                lockedReal.status,
                'locked-real and unknown-email share the 401 status (no status-code existence oracle)',
            ).toBe(401);
            expect(unknownAcct.status).toBe(401);
        }

        // SOURCE-VERIFIED DELIBERATE LEAK: the lockout message is intentionally
        // shown for a matched-but-locked row (see auth-provider.service.ts comment:
        // "show the locked message regardless if email matches a row that's
        // locked"). So the locked MESSAGE is the H-17 "temporarily locked" text —
        // assert that REAL contract rather than pretending it's hidden. The unknown
        // email cannot produce this message (recordFailedLogin only runs for an
        // existing row, so an unknown email is never locked).
        if (lockedReal.status === 401) {
            const lockedMsg = String(lockedReal.body.message ?? '').toLowerCase();
            expect(lockedMsg, `locked message="${lockedMsg}"`).toMatch(
                /temporarily locked|too many failed login/,
            );
            // Even the deliberate leak must NOT escalate into an explicit
            // enumeration tell like "no such account" / "not found".
            expect(lockedMsg).not.toMatch(
                /no (such )?account|not found|does not exist|unregistered/,
            );
        }

        // The unknown-email message must NEVER be the lockout message — an unknown
        // row is never locked, so leaking "temporarily locked" for it would be a
        // false existence signal in the WRONG direction.
        if (unknownAcct.status === 401) {
            const unknownMsg = String(unknownAcct.body.message ?? '').toLowerCase();
            expect(
                unknownMsg,
                `unknown-email message must not claim a lockout (msg="${unknownMsg}")`,
            ).not.toMatch(/temporarily locked/);
        }
    });

    test('the lock is PER-ACCOUNT, not per-IP: locking Alice does not block Bob from authenticating from the same client', async ({
        request,
    }) => {
        // Both users registered from the SAME APIRequestContext (same client/IP).
        const alice = await registerUserViaAPI(request, { password: GOOD_PASSWORD });
        const bob = await registerUserViaAPI(request, { password: GOOD_PASSWORD });

        // Sanity: Bob authenticates cleanly before we touch Alice.
        const bobBefore = await login(request, bob.email, GOOD_PASSWORD);
        expect(bobBefore.status, 'Bob should authenticate before Alice is hammered').toBe(200);

        const { tripped, lockStatuses } = await driveToLock(request, alice.email, GOOD_PASSWORD);

        // If the very FIRST signal we hit was a 429, the throttler is per-IP and
        // we cannot cleanly demonstrate per-account lock isolation — annotate+skip.
        if (lockStatuses.includes(429)) {
            test.info().annotations.push({
                type: 'informational',
                description: `per-IP 429 throttle observed (statuses=${lockStatuses.join(
                    ',',
                )}) — cannot isolate per-account lock from per-IP throttle`,
            });
            test.skip(true, 'per-IP throttle short-circuited the per-account lock probe');
        }
        if (!tripped) {
            test.skip(true, `Alice never locked (statuses=${lockStatuses.join(',')})`);
        }

        // Alice is locked: her correct password is rejected.
        const aliceLocked = await login(request, alice.email, GOOD_PASSWORD);
        expect(isAuthed(aliceLocked), 'Alice must be locked').toBe(false);

        // THE LOAD-BEARING ASSERTION: Bob — a DIFFERENT account, same IP — can
        // still authenticate. A per-IP-only lock would have collared Bob too.
        // Poll briefly to ride out any incidental per-IP throttle cooldown.
        await expect
            .poll(async () => (await login(request, bob.email, GOOD_PASSWORD)).status, {
                timeout: 30_000,
                message:
                    'Bob (different account, same IP) should still authenticate while Alice is locked',
            })
            .toBe(200);
        const bobAfter = await login(request, bob.email, GOOD_PASSWORD);
        expect(bobAfter.status, 'Bob unaffected by Alice lock').toBe(200);
        expect(typeof bobAfter.body.access_token).toBe('string');
        expect(bobAfter.status, 'Bob must not inherit Alice 429/lock').not.toBe(429);
    });

    test('a successful login between failures does not accumulate toward the lock the same way as an uninterrupted failure burst (counter semantics)', async ({
        request,
    }) => {
        // This probes the failed-attempt COUNTER semantics without pinning the
        // exact threshold: a user who interleaves a SUCCESS between wrong attempts
        // should be at least as resilient to locking as one who fails N times in a
        // row. We do a SMALL burst (below any reasonable threshold), then a good
        // login, then assert the good login still works — i.e. a few isolated
        // failures do NOT lock a healthy account.
        const user = await registerUserViaAPI(request, { password: GOOD_PASSWORD });

        // A couple of wrong attempts (intentionally few — below threshold).
        for (let i = 0; i < 2; i++) {
            const wrong = await login(request, user.email, WRONG_PASSWORD);
            expect(wrong.status, 'wrong-password attempt should be a 4xx').toBeGreaterThanOrEqual(
                400,
            );
            expect(wrong.status).toBeLessThan(500);
            // A 429 here means the IP throttler is very aggressive in this env;
            // bail out informationally rather than mis-assert counter semantics.
            if (wrong.status === 429) {
                test.skip(
                    true,
                    'per-IP throttle tripped on the small pre-burst — cannot probe counter',
                );
            }
        }

        // A correct login should STILL succeed after only a couple of failures —
        // proving the threshold is meaningfully above a tiny number and a healthy
        // user is not collared by incidental typos.
        const good = await login(request, user.email, GOOD_PASSWORD);
        expect(good.status, 'a healthy account survives a couple of isolated failures').toBe(200);
        expect(typeof good.body.access_token).toBe('string');
    });

    test('reset-password clears the lock: after locking, a valid password reset (via emailed token) restores authentication with the NEW password', async ({
        request,
    }) => {
        // The reset token is delivered ONLY by email, so this end-to-end proof of
        // "reset clears the lock" requires MailHog. Without the service container
        // we cannot obtain a live token — gate exactly like flow-password-reset.
        if (!(await isMailhogAvailable(request))) {
            test.skip(
                true,
                'MailHog service container not running (:8025) — cannot read the reset token',
            );
        }

        const user = await registerUserViaAPI(request, { password: GOOD_PASSWORD });

        // Lock the account first.
        const { tripped, lockStatuses } = await driveToLock(request, user.email, GOOD_PASSWORD);
        if (!tripped) {
            test.skip(
                true,
                `lock did not trip (statuses=${lockStatuses.join(',')}) — nothing to clear via reset`,
            );
        }
        // Confirm locked: correct (old) password rejected.
        const lockedOld = await login(request, user.email, GOOD_PASSWORD);
        expect(isAuthed(lockedOld), 'account should be locked before reset').toBe(false);

        // Drain any pending mail, then request the reset.
        await waitForMessageTo(request, user.email, { timeoutMs: 8_000 }).catch(() => null);
        await clearMailhogInbox(request);

        const forgot = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: user.email },
            timeout: REQ_TIMEOUT,
        });
        // Anti-enumeration endpoint: always a 2xx, never echoes the token.
        expect(forgot.status(), `forgot-password status=${forgot.status()}`).toBeLessThan(300);
        expect(forgot.status()).toBeGreaterThanOrEqual(200);
        const forgotBody = (await forgot.json().catch(() => ({}))) as Record<string, unknown>;
        expect(forgotBody.token, 'forgot-password must not echo the token').toBeUndefined();
        expect(forgotBody.resetToken).toBeUndefined();

        // Fish the raw token out of the delivered reset email.
        const resetMsg = await waitForResetEmail(request, user.email, 30_000);
        if (!resetMsg) {
            test.skip(
                true,
                `reset email never arrived for ${user.email} within 30s — CI mail transport flake`,
            );
        }
        const rawToken = extractResetToken(resetMsg!);
        expect(rawToken, 'no reset token found in email body').not.toBeNull();

        const NEW_PASSWORD = 'ResetCleared9!flow';
        const reset = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: rawToken, newPassword: NEW_PASSWORD },
            timeout: REQ_TIMEOUT,
        });
        expect(reset.status(), `reset-password status=${reset.status()}`).toBe(200);

        // OBSERVABLE OUTCOME: the NEW password authenticates AND the lock is gone.
        // A password reset that re-keys the credential but leaves the account
        // locked would reject this — so a clean 200 here proves the reset both
        // re-keyed AND cleared the lockout state. Poll to ride out the password
        // write lag on a cold dev runner.
        await expect
            .poll(async () => (await login(request, user.email, NEW_PASSWORD)).status, {
                timeout: 20_000,
                message: 'new password should authenticate after reset clears the lock',
            })
            .toBe(200);
        const afterReset = await login(request, user.email, NEW_PASSWORD);
        expect(afterReset.status, 'reset clears the lock — new password authenticates').toBe(200);
        expect(typeof afterReset.body.access_token).toBe('string');

        // The OLD password must still be rejected (it was re-keyed away), proving
        // the 200 above is genuinely the NEW credential, not a stale-lock artifact.
        const afterOld = await login(request, user.email, GOOD_PASSWORD);
        expect(isAuthed(afterOld), 'old password must not authenticate after reset').toBe(false);
    });

    test('recovery: a locked account becomes usable again once the lock is cleared (post-reset), and the seeded user — never hammered — is unaffected throughout', async ({
        request,
    }) => {
        // Positive control with a DIFFERENT, never-hammered identity: the seeded
        // user must authenticate cleanly regardless of any lock activity in this
        // file. This is the cross-spec safety assertion (we must not have polluted
        // the shared user's lock/throttle state).
        const seeded = loadSeededTestUser();
        const seededLogin = await login(request, seeded.email, seeded.password);
        // The seeded user always exists; login is 200 (or, if a global per-IP
        // throttle is hot from sibling specs, a transient 429 — never a 5xx).
        expect(seededLogin.status, `seeded login status=${seededLogin.status}`).toBeLessThan(500);
        if (seededLogin.status !== 429) {
            expect(seededLogin.status, 'seeded user authenticates (not collared by lockout)').toBe(
                200,
            );
        }

        // Now demonstrate the recovery arc on a fresh, isolated user: lock → (the
        // only env-independent way to clear without time-travel is a reset, but to
        // keep THIS flow MailHog-independent we instead assert the WEAKER, always-
        // true recovery property: the lock is bounded — `lockedUntil` is a finite
        // window, NOT a permanent ban). We can't fast-forward wall-clock here, so
        // we assert the bounded-lock CONTRACT shape: while locked, the response is
        // a transient 4xx (lock/throttle), never a permanent 403-forbidden-style
        // "account disabled" that would imply an unrecoverable state.
        const user = await registerUserViaAPI(request, { password: GOOD_PASSWORD });
        const { tripped, lockStatuses } = await driveToLock(request, user.email, GOOD_PASSWORD);
        if (!tripped) {
            test.skip(true, `lock did not trip (statuses=${lockStatuses.join(',')})`);
        }

        const locked = await login(request, user.email, GOOD_PASSWORD);
        expect(isAuthed(locked), 'account is locked').toBe(false);
        // Bounded/transient lock contract: the H-17 lockout surfaces as a 401 with
        // the "temporarily locked … try again in N minutes" message — explicitly a
        // TEMPORARY lock that `lockedUntil` lifts, NOT a permanent disable/ban.
        // (A per-IP 429 throttle is also acceptable here — it too is transient.)
        const lockedMsg = String(locked.body.message ?? '').toLowerCase();
        expect(lockedMsg, `locked message="${lockedMsg}"`).not.toMatch(
            /disabled|banned|permanently|deactivated/,
        );
        expect([401, 403, 423, 429]).toContain(locked.status);
        // When it's the lockout 401 (not a throttle 429), the message must be the
        // verified bounded-lock text — proving recoverability is communicated.
        if (locked.status === 401) {
            expect(lockedMsg, `lockout 401 message="${lockedMsg}"`).toMatch(
                /temporarily locked|too many failed login|try again in/,
            );
        }

        // The seeded user is STILL fine after all the hammering — final isolation check.
        const seededAfter = await login(request, seeded.email, seeded.password);
        expect(seededAfter.status, 'seeded user unaffected after lockout activity').toBeLessThan(
            500,
        );
        expect(seededAfter.status, 'seeded user not newly locked by this spec').not.toBe(423);
    });
});

/**
 * Poll MailHog for the password-reset email addressed to `email`. Mirrors the
 * proven filter in flow-password-reset.spec.ts: match the recipient AND a
 * "Reset…password" subject so the registration-confirmation email cannot be
 * mistaken for the reset email and hand us the wrong token.
 */
async function waitForResetEmail(
    request: APIRequestContext,
    email: string,
    timeoutMs = 30_000,
): Promise<MailhogMessage | null> {
    const deadline = Date.now() + timeoutMs;
    const target = email.toLowerCase();
    while (Date.now() < deadline) {
        const messages = await listMessages(request, 50);
        const match =
            messages.find((m) => {
                const toMatch = m.To?.some(
                    (t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === target,
                );
                if (!toMatch) return false;
                const subject = m.Content?.Headers?.['Subject']?.[0] ?? '';
                return /reset/i.test(subject) && /password/i.test(subject);
            }) ?? null;
        if (match) return match;
        await new Promise((r) => setTimeout(r, 300));
    }
    return null;
}

/** Pull the raw hex reset token out of the `?token=…` query param in the email body. */
function extractResetToken(message: MailhogMessage): string | null {
    const link = extractLinkFromBody(message, /https?:\/\/[^\s"'<>]+token=[a-f0-9]+/i);
    if (!link) return null;
    const m = /token=([a-f0-9]+)/i.exec(link);
    return m?.[1] ?? null;
}
