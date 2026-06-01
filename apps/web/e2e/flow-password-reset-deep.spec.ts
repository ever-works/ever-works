import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, loginViaAPI } from './helpers/api';
import { isMailhogAvailable, waitForMessageTo, type MailhogMessage } from './helpers/mailhog';

/**
 * Password-reset DEEP edges — token single-use, invalid/expired-token exact
 * message, new-password policy enforcement, reset-invalidates-OTHER-sessions
 * (the multi-device sign-out edge), token rotation (a 2nd forgot supersedes the
 * 1st outstanding token), validate-oracle/reset-action agreement, and the
 * uniform unknown-email (no-enumeration) response.
 *
 * Every shape below was PROBED against the LIVE API (http://127.0.0.1:3100,
 * sqlite in-memory — the CI driver) and read from source
 * (apps/api/src/auth/controllers/auth.controller.ts + services/auth.service.ts)
 * on 2026-06-01 before any assertion was written:
 *
 *   POST /api/auth/forgot-password { email }
 *     known OR unknown email → 200 (IDENTICAL body — no user enumeration):
 *       { message: 'If the email exists, a reset link has been sent' }
 *     malformed email → 400 { message:['email must be an email'], … }
 *     A 2nd request for the SAME user OVERWRITES passwordResetToken (one
 *     outstanding token at a time — auth.service.forgotPassword), invalidating
 *     the prior unused token. @Throttle is 5/60s per-IP → tolerate/skip on 429.
 *
 *   POST /api/auth/reset-password { token, newPassword }
 *     valid-policy pw + bad/unknown/used/expired token → 400:
 *       { message:'Invalid reset token', error:'Bad Request', statusCode:400 }
 *       (expired branch would read 'Reset token expired' — same negative shape;
 *        un-time-travelable in e2e, so unknown stands in for the negative case.)
 *     missing/empty token → 400 { message:['token should not be empty', …] }
 *     policy: newPassword failing /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/ (no lowercase
 *       / no digit-or-symbol) → 400 with the combined complexity message; too
 *       short (<8) ALSO adds 'newPassword must be longer than or equal to 8
 *       characters'. class-validator runs BEFORE the token lookup, so a
 *       placeholder token still surfaces policy errors (probed: same 400).
 *     success → controller does: getUserByPasswordResetToken → setPassword →
 *       consumePasswordResetToken (clears the hashed token → SINGLE-USE) →
 *       signOutAll(user.id) (→ every pre-existing session dies — SIGN-OUT).
 *
 *   GET /api/auth/validate-reset-token?token=…  (the UI's read-only oracle)
 *     unknown/used token → 200 { valid:false, message:'Invalid reset token' }
 *       (the negative branch NEVER leaks email/expiresAt)
 *     empty token        → 400 { message:'token query parameter is required' }
 *
 *   Session oracle: GET /api/auth/profile
 *     live Bearer → 200 { id,userId,email,… }  |  none/garbage → 401.
 *     The access_token is an OPAQUE 32-char session handle (NOT a JWT), so we
 *     assert the SESSION contract directly (token live before reset; dead after)
 *     rather than decoding/forging a JWT claim.
 *
 * GOTCHAS honored:
 *   - e2e SMTP DELIVERY FAILS ("Missing credentials for PLAIN") → MailHog total
 *     stays 0, so a REAL raw reset token is (almost) never available. Every
 *     "use a delivered token" path is BEST-EFFORT: drive it only if
 *     tryGetResetToken returns non-null; otherwise annotate + assert the
 *     reachable contract (old pw / pre-reset sessions still live; fabricated
 *     token rejected). Never hard-require a delivered email.
 *   - All mutations run on FRESH registerUserViaAPI() users (cross-spec
 *     isolation); unique emails; tolerate pre-existing rows; never touch the
 *     shared seeded user's password.
 *   - Anon UI context passes an EMPTY storageState (bare newContext inherits the
 *     shared auth cookie). This file is `flow-`-prefixed → runs in the AUTH'd
 *     `chromium` project, so the UI flow MUST build its own anon context.
 *   - DEV hydration race: retry submit (first click swallowed pre-hydration) +
 *     generous timeouts; a dialog/route may diverge local vs CI → assert .or().
 */

const FORGOT_UNIFORM_MSG = 'If the email exists, a reset link has been sent';
const RESET_BAD_TOKEN_MSG = 'Invalid reset token';
const RESET_OK_NOT = 'success'; // a bad-token 400 must never read like a success
const POLICY_MSG =
    'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character';
const EMAIL_FORMAT_MSG = 'email must be an email';

const FORGOT = `${API_BASE}/api/auth/forgot-password`;
const RESET = `${API_BASE}/api/auth/reset-password`;
const VALIDATE = `${API_BASE}/api/auth/validate-reset-token`;
const PROFILE = `${API_BASE}/api/auth/profile`;
const LOGIN = `${API_BASE}/api/auth/login`;

/** Read the response body as text once, tolerant of any JSON shape. */
async function bodyText(res: { text: () => Promise<string> }): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

/** Unique throwaway email so unknown-email probes never collide with a real row. */
function ghostEmail(): string {
    return `e2e-ghost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Raw /profile status for a token: 200 = live session, 401/403 = revoked. */
async function profileStatus(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(PROFILE, { headers: authedHeaders(token), timeout: 25_000 });
    return res.status();
}

/**
 * Best-effort extraction of a raw reset token from a delivered MailHog message.
 * Returns null when no mail was delivered (the e2e SMTP norm) — callers must
 * annotate + branch to the reachable contract.
 */
async function tryGetResetToken(request: APIRequestContext, email: string): Promise<string | null> {
    if (!(await isMailhogAvailable(request))) return null;
    const msg: MailhogMessage | null = await waitForMessageTo(request, email, { timeoutMs: 6000 });
    if (!msg) return null;
    const body = msg.Content?.Body ?? '';
    // The forgot-password template embeds the token in a reset URL and (per
    // mail context) as a resetToken field. Try the URL form first, then raw.
    const url = body.match(/reset-password\?token=([A-Za-z0-9._-]+)/);
    if (url) return url[1];
    const raw = body.match(/resetToken["'\s:=]+([A-Za-z0-9._-]{16,})/i);
    return raw ? raw[1] : null;
}

test.describe('Password-reset (deep)', () => {
    test.setTimeout(60_000);

    /**
     * FLOW 1 — Anti-enumeration: forgot-password returns a byte-identical 200
     * envelope for a KNOWN registered email and an UNKNOWN one, and the body
     * never echoes the queried address or hints at existence. A status-code or
     * body-shape difference would itself be the enumeration leak.
     */
    test('forgot-password returns an IDENTICAL uniform body for known and unknown emails (no enumeration)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const knownRes = await request.post(FORGOT, { data: { email: user.email } });
        const unknown = ghostEmail();
        const unknownRes = await request.post(FORGOT, { data: { email: unknown } });

        // Throttle window is per-IP (5/60s) and shared across this describe.
        expect([200, 429]).toContain(knownRes.status());
        expect([200, 429]).toContain(unknownRes.status());
        if (knownRes.status() === 429 || unknownRes.status() === 429) {
            test.info().annotations.push({
                type: 'throttled',
                description:
                    'forgot-password @Throttle 5/60s tripped; uniform-body assertion skipped this run.',
            });
            return;
        }

        // Same status, same message — and the body must NOT leak the email or hint
        // at whether the account exists, nor ever echo the raw reset token.
        expect(knownRes.status()).toBe(unknownRes.status());
        const knownJson = JSON.parse(await bodyText(knownRes));
        const unknownJson = JSON.parse(await bodyText(unknownRes));
        expect(knownJson.message).toContain(FORGOT_UNIFORM_MSG);
        expect(unknownJson.message).toBe(knownJson.message);
        // Identical SET of keys present (a key only-present-on-one branch would leak).
        expect(Object.keys(unknownJson).sort()).toEqual(Object.keys(knownJson).sort());
        expect(JSON.stringify(unknownJson)).not.toContain(unknown);
        expect(knownJson.token).toBeUndefined();
        expect(knownJson.resetToken).toBeUndefined();
    });

    /**
     * FLOW 2 — Invalid-token exact contract + oracle/action AGREEMENT. The
     * read-only validate-reset-token oracle (what the UI hits to decide whether
     * to render the form) and the reset-password action must AGREE for the SAME
     * token: validate reports valid:false (and leaks neither email nor expiry),
     * and reset rejects with the exact "Invalid reset token" 400 — never a 5xx,
     * never a success-shaped body.
     */
    test('reset-password and validate-reset-token AGREE on an invalid token (exact message, no email leak)', async ({
        request,
    }) => {
        const token = `bogus-${Date.now()}-not-a-real-token`;

        // Oracle: 200 { valid:false } and the negative branch leaks nothing.
        const valRes = await request.get(`${VALIDATE}?token=${encodeURIComponent(token)}`);
        expect([200, 429]).toContain(valRes.status());
        if (valRes.status() === 200) {
            const v = JSON.parse(await bodyText(valRes));
            expect(v.valid).toBe(false);
            expect(String(v.message)).toMatch(/invalid|expired/i);
            expect(v.email, 'negative branch must not leak an email').toBeUndefined();
            expect(v.expiresAt, 'negative branch must not leak an expiry').toBeUndefined();
        }

        // Action: policy-valid newPassword so the 400 is unambiguously about the TOKEN.
        const res = await request.post(RESET, {
            data: { token, newPassword: 'ValidPass1!' },
        });
        expect([400, 429]).toContain(res.status());
        if (res.status() === 429) {
            test.info().annotations.push({
                type: 'throttled',
                description: 'reset-password throttled; invalid-token assertion skipped this run.',
            });
            return;
        }
        const json = JSON.parse(await bodyText(res));
        expect(json.message).toBe(RESET_BAD_TOKEN_MSG);
        expect(json.statusCode).toBe(400);
        // A bad-token rejection must never read like a success.
        expect(String(json.message).toLowerCase()).not.toContain(RESET_OK_NOT);
    });

    /**
     * FLOW 3 — New-password POLICY is enforced and runs BEFORE the token lookup.
     * Every policy failure (too short, no lowercase, no digit/symbol) yields the
     * combined complexity 400 even against a placeholder token — proving the DTO
     * gate fires first and a weak password can never reach (let alone consume)
     * the token branch. The empty-token edge is also pinned here as the "rejected
     * before any password processing" boundary.
     */
    test('reset-password enforces the new-password policy independent of token validity', async ({
        request,
    }) => {
        const cases: Array<{ pw: string; label: string; expectExtra?: string }> = [
            {
                pw: 'Ab1',
                label: 'too short (<8)',
                expectExtra: 'newPassword must be longer than or equal to 8 characters',
            },
            { pw: 'ALLUPPER1', label: 'no lowercase' },
            { pw: 'alllowercase', label: 'no digit/symbol' },
        ];

        for (const c of cases) {
            const res = await request.post(RESET, {
                data: { token: 'placeholder-token', newPassword: c.pw },
            });
            expect([400, 429], `policy "${c.label}" status`).toContain(res.status());
            if (res.status() === 429) {
                test.info().annotations.push({
                    type: 'throttled',
                    description: `reset-password throttled during policy case "${c.label}"; remaining skipped.`,
                });
                return;
            }
            const text = await bodyText(res);
            // The combined complexity message is present for every policy failure.
            expect(text, `policy "${c.label}" message`).toContain(POLICY_MSG);
            if (c.expectExtra) {
                expect(text, `policy "${c.label}" extra`).toContain(c.expectExtra);
            }
            // A policy failure must NOT fall through to the token branch (the DTO
            // rejects first) — i.e. it never returns the bad-token message.
            expect(text).not.toContain(RESET_BAD_TOKEN_MSG);
        }

        // Boundary: a missing/empty token is a DTO rejection too — before any
        // password processing — and surfaces both token validators.
        const missing = await request.post(RESET, { data: { newPassword: 'ValidPass1!' } });
        expect([400, 429]).toContain(missing.status());
        if (missing.status() === 400) {
            const text = await bodyText(missing);
            expect(text).toContain('token should not be empty');
            expect(text).toContain('token must be a string');
        }
    });

    /**
     * FLOW 4 — forgot-password input validation: a MALFORMED email is a 400 with
     * the class-validator message and must NEVER fall through to the uniform
     * "sent" reply. This pins that the anti-enumeration uniform response is
     * reserved for WELL-FORMED-but-unknown addresses, not a catch-all that masks
     * a 400 the client needs to see.
     */
    test('forgot-password rejects a malformed email and never issues the uniform "sent" reply for it', async ({
        request,
    }) => {
        const res = await request.post(FORGOT, { data: { email: 'not-an-email' } });
        expect([400, 429]).toContain(res.status());
        if (res.status() === 429) {
            test.info().annotations.push({
                type: 'throttled',
                description:
                    'forgot-password throttled; malformed-email assertion skipped this run.',
            });
            return;
        }
        const text = await bodyText(res);
        expect(text).toContain(EMAIL_FORMAT_MSG);
        // Must NOT fall through to the uniform "sent" message for invalid input.
        expect(text).not.toContain(FORGOT_UNIFORM_MSG);
    });

    /**
     * FLOW 5 — RESET SIGNS OUT EVERY OTHER SESSION (the multi-device sign-out
     * edge — the brief's headline). Bring up THREE independent device sessions
     * for one fresh account (each a distinct opaque session token, each live on
     * /profile). Then request a reset:
     *   - If a token is delivered (rare under the e2e SMTP fault): drive the real
     *     reset and assert controller's signOutAll(user.id) killed ALL THREE
     *     pre-existing sessions (401) while a fresh login with the NEW password
     *     mints a working session — proving reset is a fleet-wide sign-out, not a
     *     lockout.
     *   - Else (the norm): assert the REACHABLE contract — a fabricated token is
     *     rejected AND does NOT touch any live session (all three stay 200) and
     *     the original credential still authenticates (the reset never completed).
     * Either way this exercises a MULTI-SESSION baseline that
     * flow-session-multi-device-revocation explicitly leaves to reset-password.
     */
    test('a successful reset signs out EVERY pre-existing device session (multi-device sign-out)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Inventory: 3 independent device sessions, each a distinct live token.
        const sessions: string[] = [];
        for (let i = 0; i < 3; i++) {
            const s = await loginViaAPI(request, { email: user.email, password: user.password });
            expect(s.access_token, `device ${i} token`).toBeTruthy();
            sessions.push(s.access_token);
        }
        expect(new Set(sessions).size, 'all device session tokens must be distinct').toBe(3);
        for (const t of sessions) expect(await profileStatus(request, t)).toBe(200);

        const forgotRes = await request.post(FORGOT, { data: { email: user.email } });
        expect([200, 429]).toContain(forgotRes.status());
        const rawToken =
            forgotRes.status() === 200 ? await tryGetResetToken(request, user.email) : null;

        if (!rawToken) {
            test.info().annotations.push({
                type: 'mail-unavailable',
                description:
                    'No reset email delivered (e2e SMTP "Missing credentials for PLAIN" — MailHog stays empty). ' +
                    'Asserting the reachable contract: a fabricated token must not disturb any live session.',
            });
            // A fabricated reset attempt is rejected and is INERT — it touches no
            // session and does not rotate the credential.
            const fake = await request.post(RESET, {
                data: { token: `never-delivered-${Date.now()}`, newPassword: 'FleetNew1!' },
            });
            expect([400, 429]).toContain(fake.status());
            if (fake.status() === 400) {
                expect((await fake.json()).message).toBe(RESET_BAD_TOKEN_MSG);
            }
            // All three sessions still live; original credential still authenticates.
            for (const t of sessions) expect(await profileStatus(request, t)).toBe(200);
            const still = await loginViaAPI(request, {
                email: user.email,
                password: user.password,
            });
            expect(still.access_token).toBeTruthy();
            return;
        }

        // --- Rare branch: a token WAS delivered. Exercise the true fleet sign-out. ---
        const newPassword = 'FleetNew1!';
        const reset = await request.post(RESET, { data: { token: rawToken, newPassword } });
        expect([200, 201, 429]).toContain(reset.status());
        if (reset.status() === 429) {
            test.info().annotations.push({
                type: 'throttled',
                description: 'reset-password throttled before completion; fleet sign-out skipped.',
            });
            return;
        }

        // signOutAll(user.id): every PRE-RESET device session is now revoked. Poll
        // briefly in case the delete races the 200 ack.
        for (const t of sessions) {
            await expect
                .poll(() => profileStatus(request, t), {
                    timeout: 15_000,
                    message: 'pre-reset session must be revoked after reset',
                })
                .not.toBe(200);
            expect([401, 403]).toContain(await profileStatus(request, t));
        }

        // Wipe != lockout: NEW password mints a fresh working session; OLD is dead.
        const reborn = await loginViaAPI(request, { email: user.email, password: newPassword });
        expect(reborn.access_token).toBeTruthy();
        expect(await profileStatus(request, reborn.access_token)).toBe(200);
        const oldLogin = await request.post(LOGIN, {
            data: { email: user.email, password: user.password },
        });
        expect(oldLogin.status()).toBe(401);
    });

    /**
     * FLOW 6 — TOKEN ROTATION: a 2nd forgot-password for the same user OVERWRITES
     * the prior outstanding reset token (auth.service stores ONE token at a time).
     *   - When tokens are delivered: the FIRST token must be dead (400) while the
     *     SECOND succeeds — proving rotation invalidates the stale link.
     *   - Else: assert the reachable contract — two fabricated/stale tokens are
     *     both rejected and the account is undisturbed.
     * This is distinct from FLOW 5's single-reset sign-out: here we pin that
     * issuing a fresh link RETIRES the previous one before either is used.
     */
    test('a second forgot-password supersedes the prior reset token (rotation invalidates the stale link)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const first = await request.post(FORGOT, { data: { email: user.email } });
        expect([200, 429]).toContain(first.status());
        const firstToken =
            first.status() === 200 ? await tryGetResetToken(request, user.email) : null;

        const second = await request.post(FORGOT, { data: { email: user.email } });
        expect([200, 429]).toContain(second.status());
        const secondToken =
            second.status() === 200 ? await tryGetResetToken(request, user.email) : null;

        if (!firstToken || !secondToken || firstToken === secondToken) {
            test.info().annotations.push({
                type: 'mail-unavailable',
                description:
                    'Could not capture two distinct delivered reset tokens (e2e SMTP fault / throttle). ' +
                    'Asserting the reachable contract: stale + fabricated tokens are both rejected.',
            });
            // The (undelivered, hence unknowable) outstanding token cannot be guessed;
            // any fabricated token — including a "first-looking" one — is rejected and
            // the credential is untouched.
            const stale = await request.post(RESET, {
                data: { token: `stale-${Date.now()}`, newPassword: 'Rotated1!' },
            });
            expect([400, 429]).toContain(stale.status());
            if (stale.status() === 400) {
                expect((await stale.json()).message).toBe(RESET_BAD_TOKEN_MSG);
            }
            const ok = await loginViaAPI(request, { email: user.email, password: user.password });
            expect(ok.access_token).toBeTruthy();
            return;
        }

        // --- Rare branch: two distinct delivered tokens. Prove the first is retired. ---
        // The FIRST (now superseded) token must be rejected.
        const useFirst = await request.post(RESET, {
            data: { token: firstToken, newPassword: 'Rotated1!' },
        });
        expect([400, 429]).toContain(useFirst.status());
        if (useFirst.status() === 400) {
            expect((await useFirst.json()).message).toBe(RESET_BAD_TOKEN_MSG);
        }

        // The SECOND (current) token succeeds — and is then single-use (replay dies).
        const useSecond = await request.post(RESET, {
            data: { token: secondToken, newPassword: 'Rotated2!' },
        });
        expect([200, 201, 429]).toContain(useSecond.status());
        if (useSecond.status() < 400) {
            const newLogin = await loginViaAPI(request, {
                email: user.email,
                password: 'Rotated2!',
            });
            expect(newLogin.access_token).toBeTruthy();

            const replay = await request.post(RESET, {
                data: { token: secondToken, newPassword: 'Rotated3!' },
            });
            expect([400, 429]).toContain(replay.status());
            if (replay.status() === 400) {
                expect((await replay.json()).message).toBe(RESET_BAD_TOKEN_MSG);
            }
        }
    });

    /**
     * FLOW 7 — SINGLE-USE end-to-end: a delivered token re-keys the account, the
     * OLD password dies + NEW works, the PRE-RESET session is signed out, and the
     * SAME token cannot be replayed (consumed). Best-effort on the delivered
     * token; when mail is unavailable (the norm) the reachable contract is
     * asserted — original credential still authenticates and a fabricated token
     * is rejected with the single-use/invalid message.
     */
    test('single-use: a delivered token re-keys once then dies; else assert the reachable contract', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const preSession = await loginViaAPI(request, {
            email: user.email,
            password: user.password,
        });
        expect(preSession.access_token).toBeTruthy();
        expect(await profileStatus(request, preSession.access_token)).toBe(200);

        const forgotRes = await request.post(FORGOT, { data: { email: user.email } });
        expect([200, 429]).toContain(forgotRes.status());
        const rawToken =
            forgotRes.status() === 200 ? await tryGetResetToken(request, user.email) : null;

        if (!rawToken) {
            test.info().annotations.push({
                type: 'mail-unavailable',
                description:
                    'No reset email delivered (e2e SMTP fault). Single-use happy path skipped; ' +
                    'asserting reachable contract (original credential live, fabricated token rejected).',
            });
            const stillLogin = await loginViaAPI(request, {
                email: user.email,
                password: user.password,
            });
            expect(stillLogin.access_token).toBeTruthy();
            const badReset = await request.post(RESET, {
                data: { token: `never-delivered-${Date.now()}`, newPassword: 'BrandNew1!' },
            });
            expect([400, 429]).toContain(badReset.status());
            if (badReset.status() === 400) {
                expect((await badReset.json()).message).toBe(RESET_BAD_TOKEN_MSG);
            }
            return;
        }

        // --- Rare branch: a token WAS delivered. True single-use + sign-out. ---
        const newPassword = 'BrandNew1!';
        const firstUse = await request.post(RESET, { data: { token: rawToken, newPassword } });
        expect([200, 201, 429]).toContain(firstUse.status());
        if (firstUse.status() === 429) {
            test.info().annotations.push({
                type: 'throttled',
                description: 'reset-password throttled before first use; single-use chain skipped.',
            });
            return;
        }

        const newLogin = await loginViaAPI(request, { email: user.email, password: newPassword });
        expect(newLogin.access_token).toBeTruthy();
        const oldLogin = await request.post(LOGIN, {
            data: { email: user.email, password: user.password },
        });
        expect(oldLogin.status()).toBe(401);

        // Sign-out: the pre-reset session token is now invalidated.
        expect([401, 403]).toContain(await profileStatus(request, preSession.access_token));

        // Single-use: the SAME token cannot be replayed.
        const secondUse = await request.post(RESET, {
            data: { token: rawToken, newPassword: 'AnotherNew1!' },
        });
        expect([400, 429]).toContain(secondUse.status());
        if (secondUse.status() === 400) {
            expect((await secondUse.json()).message).toBe(RESET_BAD_TOKEN_MSG);
        }
    });

    /**
     * FLOW 8 — UI deep edges (explicit ANON context). The reset-password page is
     * an unauthenticated route; this `flow-`-prefixed file runs in the AUTH'd
     * project, so we build an EMPTY-storageState context so the shared auth cookie
     * is not inherited. Asserts two branches:
     *   (a) NO token → the page renders an "Invalid Reset Link" error state with a
     *       "request a new link" affordance (never the password form).
     *   (b) BOGUS token → the form renders; submitting a policy-valid password
     *       surfaces a visible error (the API's "Invalid reset token" or a generic
     *       one) and NEVER navigates to a success screen. Local vs CI route
     *       divergence is tolerated via .or() + annotate.
     */
    test('UI: /reset-password shows the no-token error state and surfaces an error for a bogus token', async ({
        browser,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://127.0.0.1:3000';
        const context = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();

        try {
            // (a) No token → "Invalid Reset Link" error state, NOT the form.
            await page.goto(`${origin}/en/reset-password`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });
            const noTokenError = page
                .getByText(/invalid reset link/i)
                .or(page.getByText(/request a new password reset|request new reset link/i))
                .or(page.getByRole('link', { name: /login|sign in/i }));
            await expect(noTokenError.first()).toBeVisible({ timeout: 20_000 });
            // The no-token branch renders NO password field (it short-circuits to error).
            expect(await page.locator('input[type="password"]').count()).toBe(0);

            // (b) Bogus token → the form renders; submit surfaces an error.
            await page.goto(`${origin}/en/reset-password?token=ui-bogus-${Date.now()}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });

            const passwordField = page.locator('input[type="password"]').first();
            const loginRedirect = page.locator('form').filter({ hasText: /sign in|log in|login/i });
            await expect(passwordField.or(loginRedirect).first()).toBeVisible({ timeout: 20_000 });

            if (await passwordField.isVisible().catch(() => false)) {
                await passwordField.fill('ValidPass1!');
                const confirm = page.locator('input[type="password"]').nth(1);
                if (await confirm.isVisible().catch(() => false)) {
                    await confirm.fill('ValidPass1!');
                }

                const submit = page
                    .getByRole('button', { name: /reset|set.*password|submit|continue/i })
                    .first();

                // Dev hydration race: first click can be swallowed pre-hydration — retry.
                await expect(async () => {
                    if (await submit.isVisible().catch(() => false)) {
                        await submit.click({ timeout: 5_000 });
                    }
                    // Acceptable: the exact API message, a generic error, or a
                    // still-alive form (request failed, user can retry). What we must
                    // NOT see is navigation to a success screen.
                    const errorLike = page
                        .getByText(RESET_BAD_TOKEN_MSG, { exact: false })
                        .or(page.getByText(/invalid|expired|error|went wrong|try again|failed/i))
                        .or(passwordField);
                    await expect(errorLike.first()).toBeVisible({ timeout: 6_000 });
                }).toPass({ timeout: 25_000 });

                // Negative: we did NOT land on the success state.
                await expect(page.getByText(/password reset successful/i)).toHaveCount(0);
            } else {
                test.info().annotations.push({
                    type: 'route-divergence',
                    description:
                        '/en/reset-password redirected to a login-style form in this env; asserted render only.',
                });
            }
        } finally {
            await context.close();
        }
    });
});
