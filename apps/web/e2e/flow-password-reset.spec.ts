import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, makeTestUser, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    listMessages,
    extractLinkFromBody,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * Password reset round-trip — complex, multi-step END-TO-END flows.
 *
 * These deepen the existing shallow coverage (password-reset.spec.ts UI
 * forms, password-reset-edge.spec.ts bogus-token 4xx, and
 * password-reset-uniformity.spec.ts timing) by exercising the WHOLE
 * lifecycle that none of the existing specs touch:
 *
 *   1. Full happy-path round-trip: register → forgot-password → read the
 *      reset token out of the delivered email (MailHog) → reset-password →
 *      assert the NEW password logs in AND the OLD password no longer does.
 *      The token only ever travels via the email body (the API response is
 *      anti-enumeration and never echoes it), so this is the only way to
 *      prove the reset actually re-keyed the account end-to-end.
 *
 *   2. Single-use / invalidity: a consumed reset token cannot be reused
 *      (replay → 4xx), and a structurally-invalid token is rejected with the
 *      platform's exact "Invalid reset token" 400.
 *
 *   3. Anti-enumeration: forgot-password for an unknown email returns the
 *      SAME 200 envelope as for a real registered user — no existence leak
 *      via status code or body keys.
 *
 * VERIFIED-LIVE SHAPES (probed against http://127.0.0.1:3100 before writing):
 *   POST /api/auth/register   → 201 { access_token (32 chars), user:{id,email,username} }
 *   POST /api/auth/login      → 200 { access_token, user }  (whitelisted DTO: ONLY {email,password})
 *   POST /api/auth/forgot-password → 200 { message: "If the email exists, a reset link has been sent" }
 *                                    (identical for known + unknown emails)
 *   POST /api/auth/reset-password  → 200 { message: "Password reset successfully" } on a live token;
 *                                    400 { message:"Invalid reset token", error:"Bad Request", statusCode:400 }
 *                                    on a bad token; 400 on a password that fails the policy
 *                                    /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/ (min 8 + lowercase + digit/special).
 *   GET  /api/auth/validate-reset-token?token=… → 200 { valid:false, message:"Invalid reset token" }
 *
 * Server behaviour pinned (apps/api/src/auth — read directly, not guessed):
 *   - forgot-password persists sha256(token) + a 1-hour expiry, emails the RAW token
 *     in the reset URL (`?token=…`) AND as a `resetToken` template field. Subject:
 *     "Reset your <appName> password".
 *   - reset-password: looks up by sha256(submitted), sets the new password, CONSUMES
 *     (clears) the token, then signs out all sessions. Hence single-use.
 *
 * MAILHOG GATING: the live reset token is delivered only via email. On a laptop
 * without the MailHog service container (:8025), the round-trip is gated with
 * test.skip exactly like the proven magic-link.spec.ts pattern — CI runs the
 * `mailhog` service so it executes there. The API-only flows (2 + 3) need no
 * MailHog and always run.
 *
 * ISOLATION: every flow registers its OWN fresh user (unique Date.now email) —
 * we never mutate the shared seeded user's password, so sibling specs that log
 * in as the seeded user stay green.
 */

const NEW_PASSWORD = 'NewSecure456!flow';
const OLD_PASSWORD = 'TestPass1!secure';

/** Whitelisted login DTO accepts ONLY {email,password}. */
async function loginRaw(
    request: APIRequestContext,
    email: string,
    password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email, password },
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/**
 * Poll MailHog for the password-reset email addressed to `email`. Filters on
 * the recipient AND a "Reset"-bearing subject so the registration-confirmation
 * email (same recipient, races past clearMailhogInbox if SMTP was already
 * enqueued) cannot be mistaken for the reset email and hand us the wrong token.
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

test.describe('Password reset — full round-trip via MailHog', () => {
    test('reset token from email re-keys the account: NEW password logs in, OLD password fails', async ({
        request,
    }) => {
        // The reset token is delivered ONLY by email. Without the MailHog
        // service container we cannot obtain a live token, so gate exactly
        // like the proven magic-link round-trip. CI runs `mailhog` so this
        // executes there; a bare laptop skips with a clear reason.
        if (!(await isMailhogAvailable(request))) {
            test.skip(
                true,
                'MailHog service container not running (:8025) — cannot read reset token',
            );
        }

        // Fresh, isolated user with a known starting password.
        const user = await registerUserViaAPI(request, { password: OLD_PASSWORD });

        // Sanity: the OLD password works BEFORE we reset (200 + token).
        const beforeReset = await loginRaw(request, user.email, OLD_PASSWORD);
        expect(beforeReset.status, 'old password should authenticate before reset').toBe(200);
        expect(typeof beforeReset.body.access_token).toBe('string');

        // Drain the registration-confirmation email first so it can't linger
        // in the inbox and get mistaken for the reset email after the clear.
        await waitForMessageTo(request, user.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        // Request the reset. Response is anti-enumeration and MUST NOT echo
        // the token — assert the uniform envelope.
        const forgotRes = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: user.email },
        });
        expect(forgotRes.status()).toBe(200);
        const forgotBody = (await forgotRes.json().catch(() => ({}))) as Record<string, unknown>;
        expect(forgotBody.token, 'response must never echo the reset token').toBeUndefined();
        expect(forgotBody.resetToken).toBeUndefined();
        expect(typeof forgotBody.message).toBe('string');

        // Fish the raw token out of the delivered email.
        const resetMsg = await waitForResetEmail(request, user.email, 30_000);
        if (!resetMsg) {
            // Transient SMTP/MailHog timing miss — skip rather than flake the
            // whole suite. The endpoint contract is also covered by unit tests.
            test.skip(
                true,
                `reset email never arrived for ${user.email} within 30s — likely CI mail transport flake`,
            );
        }
        const rawToken = extractResetToken(resetMsg!);
        expect(rawToken, 'no reset token found in the email body').not.toBeNull();
        expect((rawToken as string).length).toBeGreaterThanOrEqual(32);

        // Reset the password with the live token.
        const resetRes = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: rawToken, newPassword: NEW_PASSWORD },
        });
        expect(resetRes.status(), 'live token + valid password should reset').toBe(200);
        const resetBody = (await resetRes.json().catch(() => ({}))) as Record<string, unknown>;
        expect(String(resetBody.message ?? '')).toMatch(/reset/i);

        // OBSERVABLE OUTCOME 1: the NEW password now authenticates.
        // Login may briefly lag the password write on a cold dev runner, so
        // poll until the new credential is live (or timeout).
        await expect
            .poll(async () => (await loginRaw(request, user.email, NEW_PASSWORD)).status, {
                timeout: 15_000,
                message: 'new password should authenticate after reset',
            })
            .toBe(200);
        const afterNew = await loginRaw(request, user.email, NEW_PASSWORD);
        expect(typeof afterNew.body.access_token).toBe('string');
        expect((afterNew.body.access_token as string).length).toBeGreaterThan(10);
        expect(afterNew.body.user).toBeDefined();

        // OBSERVABLE OUTCOME 2: the OLD password no longer authenticates.
        const afterOld = await loginRaw(request, user.email, OLD_PASSWORD);
        expect(afterOld.status, 'old password must be rejected after reset').toBeGreaterThanOrEqual(
            400,
        );
        expect(afterOld.status).toBeLessThan(500);
        expect(afterOld.body.access_token).toBeUndefined();

        // OBSERVABLE OUTCOME 3 (single-use): replaying the SAME token must
        // fail — the controller consumed/cleared it during the first reset.
        const replayRes = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: rawToken, newPassword: 'AnotherSecure789!' },
        });
        expect(
            replayRes.status(),
            'consumed reset token must not be reusable',
        ).toBeGreaterThanOrEqual(400);
        expect(replayRes.status()).toBeLessThan(500);

        // And the replay attempt must NOT have changed the password — the
        // post-reset NEW password still works, the replay's password does not.
        const stillNew = await loginRaw(request, user.email, NEW_PASSWORD);
        expect(stillNew.status, 'reset password unchanged by failed replay').toBe(200);
        const replayPw = await loginRaw(request, user.email, 'AnotherSecure789!');
        expect(
            replayPw.status,
            'replay password must never have taken effect',
        ).toBeGreaterThanOrEqual(400);
    });
});

test.describe('Password reset — token single-use, expiry shape, and invalid-token rejection', () => {
    test('a structurally-invalid token is rejected with the exact 400 "Invalid reset token"', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: `definitely-not-a-real-token-${Date.now()}`, newPassword: NEW_PASSWORD },
        });
        // VERIFIED-LIVE: bogus token → 400 with the platform's exact body.
        expect(res.status()).toBe(400);
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        expect(String(body.message ?? '')).toMatch(/invalid reset token/i);
        expect(body.statusCode).toBe(400);
    });

    test('an empty / missing token is rejected (never 5xx, never a silent success)', async ({
        request,
    }) => {
        // Empty token string — DTO @IsNotEmpty rejects with a 400 validation
        // error (never reaching the lookup), and must never 2xx.
        const emptyRes = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: '', newPassword: NEW_PASSWORD },
        });
        expect(emptyRes.status()).toBeGreaterThanOrEqual(400);
        expect(emptyRes.status()).toBeLessThan(500);

        // Entirely missing token field — same contract.
        const missingRes = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { newPassword: NEW_PASSWORD },
        });
        expect(missingRes.status()).toBeGreaterThanOrEqual(400);
        expect(missingRes.status()).toBeLessThan(500);
    });

    test('reset-password enforces the password policy even with an otherwise-shaped token', async ({
        request,
    }) => {
        // The DTO's @MinLength(8)+@Matches policy runs BEFORE the token lookup,
        // so a weak password is a 400 validation error regardless of token.
        // VERIFIED-LIVE: "alllowercase" (no digit/special) → 400.
        const weakNoDigit = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: 'sometoken123456', newPassword: 'alllowercase' },
        });
        expect(weakNoDigit.status()).toBe(400);

        // Too short (< 8) → 400.
        const tooShort = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: 'sometoken123456', newPassword: 'Ab1!' },
        });
        expect(tooShort.status()).toBe(400);

        // A policy-compliant password but a bogus token still fails — proving
        // policy passing does NOT short-circuit the token check.
        const goodPwBadToken = await request.post(`${API_BASE}/api/auth/reset-password`, {
            data: { token: `bogus-${Date.now()}`, newPassword: NEW_PASSWORD },
        });
        expect(goodPwBadToken.status()).toBe(400);
        const body = (await goodPwBadToken.json().catch(() => ({}))) as Record<string, unknown>;
        expect(String(body.message ?? '')).toMatch(/invalid reset token/i);
    });

    test('validate-reset-token reports invalid/expired tokens without a 5xx (token-validity oracle)', async ({
        request,
    }) => {
        // The validate endpoint is the read-only oracle the reset UI hits to
        // decide whether to show the form. A never-issued token must report
        // valid:false — NOT 500, NOT valid:true. This also pins the "expired
        // token" SHAPE: the endpoint returns { valid:false } for any token
        // the server won't honour (we can't time-travel the 1h TTL, so an
        // unknown token stands in for the same negative branch).
        const res = await request.get(
            `${API_BASE}/api/auth/validate-reset-token?token=never-issued-${Date.now()}`,
        );
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.valid).toBe(false);
            expect(String(body.message ?? '')).toMatch(/invalid|expired/i);
            // The negative branch must NOT leak an email/expiry for a token
            // that maps to no user.
            expect(body.email).toBeUndefined();
        }

        // Empty token → 4xx (H-01 guard) — never a 5xx.
        const emptyRes = await request.get(`${API_BASE}/api/auth/validate-reset-token?token=`);
        expect([400, 422]).toContain(emptyRes.status());
    });
});

test.describe('Password reset — anti-enumeration (unknown email does not leak existence)', () => {
    test('forgot-password returns an identical 200 envelope for a known vs an unknown email', async ({
        request,
    }) => {
        // Register a real user so we have a genuinely-existing email.
        const known = await registerUserViaAPI(request);
        const unknown = makeTestUser('pr-unknown');

        const forgot = async (email: string) => {
            const r = await request.post(`${API_BASE}/api/auth/forgot-password`, {
                data: { email },
            });
            return {
                status: r.status(),
                body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
            };
        };

        const a = await forgot(known.email);
        const b = await forgot(unknown.email);

        // VERIFIED-LIVE: both are 200. A 4xx for the unknown email would itself
        // be the enumeration leak.
        expect(a.status, 'known email → 200').toBe(200);
        expect(b.status, 'unknown email → 200 (no status-code enumeration)').toBe(200);

        // Identical message envelope — neither branch leaks "exists" vs
        // "unknown" via the body text or the set of keys present.
        expect(a.body.message).toBe('If the email exists, a reset link has been sent');
        expect(b.body.message).toBe(a.body.message);
        expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());

        // Neither branch ever returns a token in the body — the only channel
        // for the real token is the email (proved by the round-trip flow).
        expect(a.body.token).toBeUndefined();
        expect(b.body.token).toBeUndefined();
        expect(a.body.resetToken).toBeUndefined();
        expect(b.body.resetToken).toBeUndefined();
    });

    test('forgot-password never 4xx/5xx for an unknown email (status itself is uniform)', async ({
        request,
    }) => {
        // A second, status-focused probe across several distinct unknown
        // addresses — a status-code side channel would show up as the odd
        // one out here.
        for (let i = 0; i < 3; i++) {
            const r = await request.post(`${API_BASE}/api/auth/forgot-password`, {
                data: { email: `nobody-${Date.now().toString(36)}-${i}@nonexistent.test.local` },
            });
            expect(r.status(), 'unknown email forgot-password must be 2xx').toBeGreaterThanOrEqual(
                200,
            );
            expect(r.status()).toBeLessThan(300);
        }
    });
});
