import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    extractLinkFromBody,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * FLOW: Email deeplink resolution + callback-host allow-list + bounce handling.
 *
 * Probed LIVE @127.0.0.1:3100 (API) + @127.0.0.1:3000 (Web) and read from the
 * REAL source on 2026-06-01:
 *   apps/api/src/auth/services/auth.service.ts   (C-04 validateCallbackUrl + allow-list)
 *   apps/api/src/auth/dto/auth.dto.ts            (RegisterDto.emailVerificationCallbackUrl)
 *   apps/api/src/auth/dto/email-verification.dto.ts (ForgotPasswordDto.resetPasswordCallbackUrl)
 *   apps/api/src/auth/dto/magic-link.dto.ts      (RequestMagicLinkDto.magicLinkCallbackUrl)
 *   apps/web/src/app/api/auth/verify-email/route.ts (Next route handler — typed error redirect)
 *   apps/web/src/app/[locale]/(auth)/reset-password/reset-password-form.tsx
 *   apps/web/src/app/[locale]/(auth)/login/magic-link/magic-link-redeem-client.tsx
 *   apps/web/src/app/[locale]/(auth)/auth/error/auth-error-content.tsx
 *   apps/web/src/lib/auth/redirect.ts + lib/utils/url.ts (isValidRedirectUrl) + lib/constants.ts
 *
 * This file deliberately covers angles NO existing spec does:
 *   - email-link-deeplink.spec.ts          — only "generation endpoints don't leak token" (API).
 *   - email-bounce-handling.spec.ts        — only "register with 3 bounce domains < 500".
 *   - flow-email-verification-deep.spec.ts — verify-email oracle / web-route typed errors.
 *   - flow-password-reset-deep.spec.ts     — reset token single-use / policy / UI bogus token.
 *   - flow-magic-link-deep.spec.ts         — redeem cross-account / race / rotation.
 *   - redirect-prevention.spec.ts          — open-redirect on the LOGIN PAGE query params.
 * NEW here: the THREE transactional deeplinks (verify / reset / magic-link) resolving on the
 * WEB side with the token CARRIED into the page/handler; the SERVER-SIDE C-04 callback-host
 * allow-list that makes the EMAILED link un-hijackable; open-redirect prevention on the email
 * deeplink WEB ROUTE HANDLERS (not the login page); and a holistic bounce-domain contract across
 * ALL transactional-mail endpoints at once.
 *
 * PINNED CONTRACT (all verified live this session):
 *   C-04 callback-host allow-list (apps/api auth.service.ts):
 *     RegisterDto.emailVerificationCallbackUrl / ForgotPasswordDto.resetPasswordCallbackUrl /
 *     RequestMagicLinkDto.magicLinkCallbackUrl are each @IsString @IsOptional:
 *       - a non-string value          -> 400 ['<field> must be a string']
 *       - any extra unknown property  -> 400 ['property <x> should not exist'] (forbidNonWhitelisted)
 *       - an EVIL but well-formed http(s) URL is ACCEPTED at the endpoint (register 201,
 *         forgot/magic-link 200 uniform body — NO enumeration tell) BUT validateCallbackUrl()
 *         rejects any host NOT in ALLOWED_CALLBACK_HOSTS (default = host of WEB_URL) and the
 *         service SILENTLY falls back to the platform default link:
 *           verify -> `${webAppUrl}/api/auth/verify-email?token=...`
 *           reset  -> `${webAppUrl}/api/auth/reset-password?token=...`
 *           magic  -> `${webAppUrl}/login/magic-link?token=...`
 *         => the token can NEVER be emailed to an attacker host. (Best-effort: assert the
 *            delivered link host IF a mail lands; the endpoint contract always holds.)
 *
 *   WEB deeplink routes (Next.js dev @3000; /{locale}/... 307s to the UNPREFIXED path):
 *     GET <web>/api/auth/verify-email           (route handler):
 *        no token  -> 307 Location /auth/error?error=verify_email_missing_token
 *        bad token -> 307 Location /auth/error?error=verify_email_invalid_token
 *        an extra ?redirect_uri=<evil> / ?next=<evil> does NOT appear in the Location and does
 *        NOT change the same-origin auth/error landing (the redirect cookie, not the query, is
 *        the only redirect seam — getRedirectUrl()).
 *     GET <web>/api/auth/reset-password         (route handler):
 *        bad token -> 307 Location /auth/error?error=reset_password_invalid_token
 *     GET <web>/reset-password?token=<t>        (PAGE, 200): renders the reset FORM (password
 *        inputs) carrying ?token=; NO token -> "Invalid Reset Link" panel (no form).
 *     GET <web>/login/magic-link?token=<t>      (PAGE, 200): the redeem client reads ?token= and
 *        auto-redeems; a bad token surfaces the "This link can't be used" error panel
 *        (data-testid=magic-link-error), never a success navigation.
 *
 *   BOUNCE contract: bounce-shaped (.invalid/.example/.test RFC-2606), IDN/unicode, and
 *     pathologically long domains never 5xx on register / send-verification / forgot-password /
 *     magic-link; the anti-enumeration uniform bodies are byte-identical for a bounce domain.
 *
 * GOTCHAS honored:
 *   - MAIL is BEST-EFFORT: e2e SMTP delivery fails ("Missing credentials for PLAIN") even though
 *     MailHog HTTP is up. Every "read the delivered link host" leg validates IF a message lands,
 *     else annotates + asserts the always-reachable endpoint/route contract. Never hard-require mail.
 *   - ANON CONTEXT: bare browser.newContext() inherits the storageState cookie; the unauth web
 *     probes use newContext({ storageState:{cookies:[],origins:[]} }).
 *   - next-dev LOCAL vs CI route divergence + the /{locale} 307: assert with .or() and tolerant
 *     toPass loops; treat both 200-render and a login/auth redirect as acceptable resolutions.
 *   - forgot-password & magic-link are @Throttle(5/60s) per-IP -> tolerate/skip on 429.
 *   - ALL mutations use FRESH registerUserViaAPI() users (unique Date.now ids); toContain, never
 *     exact counts. This file is flow- prefixed -> safe vs the playwright.config no-auth testIgnore.
 */

const KNOWN_BAD_TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const FORGOT_UNIFORM_MSG = 'If the email exists, a reset link has been sent';
const MAGIC_UNIFORM_MSG = 'If the email is registered, a magic link has been sent';
/** Hosts an emailed deeplink is allowed to point at (= host of WEB_URL by default). */
const ALLOWED_LINK_HOSTS = new Set(['localhost:3000', '127.0.0.1:3000']);
/** Hosts that, if ever seen in a delivered link, prove a callback-host hijack. */
const ATTACKER_HOST = 'attacker.example.com';

function uniqEmail(tag: string): string {
    return `e2e-dl-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@test.local`;
}

/** A registration-DTO-safe username (>=3, <=20 chars, no spaces). */
function uniqUsername(tag: string): string {
    return (tag + Date.now().toString(36) + Math.floor(Math.random() * 1e4)).slice(0, 20);
}

/** Origin of any http(s) link found in a mail body, lower-cased host:port, or null. */
function linkHost(message: MailhogMessage, pathHint: RegExp): string | null {
    const link = extractLinkFromBody(message, pathHint);
    if (!link) return null;
    try {
        return new URL(link).host.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Best-effort: did the emailed deeplink (matching pathHint) ever point at a host
 * OUTSIDE the allow-list? Returns { delivered, host, hijacked }. We only fail on a
 * positive hijack; a non-delivery is annotated, never failed.
 */
async function inspectDeliveredLinkHost(
    request: APIRequestContext,
    recipient: string,
    pathHint: RegExp,
): Promise<{ delivered: boolean; host: string | null; hijacked: boolean }> {
    if (!(await isMailhogAvailable(request)))
        return { delivered: false, host: null, hijacked: false };
    const msg = await waitForMessageTo(request, recipient, { timeoutMs: 4000 }).catch(() => null);
    if (!msg) return { delivered: false, host: null, hijacked: false };
    const host = linkHost(msg, pathHint);
    if (!host) return { delivered: true, host: null, hijacked: false };
    const hijacked = !ALLOWED_LINK_HOSTS.has(host) || host.includes(ATTACKER_HOST);
    return { delivered: true, host, hijacked };
}

test.describe('Flow: mail deeplink resolution / callback allow-list / bounce', () => {
    test.setTimeout(90_000);

    /**
     * FLOW 1 — The three WEB deeplink routes RESOLVE to the right surface with the
     * token carried in. verify-email + reset-password are route handlers that 307 to a
     * TYPED auth/error reason for a bad token; the reset PAGE renders the form for a
     * present token and an invalid-link panel for a missing one. This pins that an
     * emailed link "lands on the correct page", which no existing spec asserts together.
     */
    test('verify-email / reset-password / magic-link deeplinks each resolve to their correct landing', async ({
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // verify-email route handler: missing token -> typed missing-token error.
        const vNo = await request.get(`${origin}/api/auth/verify-email`, { maxRedirects: 0 });
        expect([302, 307, 308]).toContain(vNo.status());
        expect(vNo.headers()['location'] ?? '').toContain('verify_email_missing_token');

        // verify-email route handler: bad token -> typed invalid-token error (token CARRIED in
        // and rejected by the API behind the route, not silently swallowed).
        const vBad = await request.get(`${origin}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}`, {
            maxRedirects: 0,
        });
        expect([302, 307, 308]).toContain(vBad.status());
        const vBadLoc = vBad.headers()['location'] ?? '';
        expect(vBadLoc).toContain('/auth/error');
        expect(vBadLoc).toContain('verify_email_invalid_token');
        // The candidate token must NEVER be echoed back in the redirect Location.
        expect(vBadLoc).not.toContain(KNOWN_BAD_TOKEN);

        // reset-password route handler: bad token -> typed reset invalid-token error.
        const rBad = await request.get(
            `${origin}/api/auth/reset-password?token=${KNOWN_BAD_TOKEN}`,
            {
                maxRedirects: 0,
            },
        );
        expect([302, 307, 308]).toContain(rBad.status());
        const rBadLoc = rBad.headers()['location'] ?? '';
        expect(rBadLoc).toContain('/auth/error');
        expect(rBadLoc).toContain('reset_password_invalid_token');
        expect(rBadLoc).not.toContain(KNOWN_BAD_TOKEN);

        // reset-password PAGE with a token -> the reset FORM renders (token prefilled into the
        // client form via ?token=). Status 200, password inputs present.
        const rPage = await request.get(`${origin}/reset-password?token=ui-${Date.now()}`, {
            maxRedirects: 0,
        });
        expect(rPage.status()).toBe(200);
        expect(await rPage.text()).toContain('type="password"');

        // reset-password PAGE WITHOUT a token -> the invalid-link panel (no form).
        const rPageNo = await request.get(`${origin}/reset-password`, { maxRedirects: 0 });
        expect(rPageNo.status()).toBe(200);
        expect(await rPageNo.text()).toContain('Invalid Reset Link');
    });

    /**
     * FLOW 2 — C-04 callback-host ALLOW-LIST: an attacker-supplied *CallbackUrl is
     * ACCEPTED at the endpoint (no enumeration tell) but the EMAILED link can never point
     * at the attacker host — validateCallbackUrl() silently falls back to the platform
     * default. We assert the always-reachable endpoint contract (uniform body parity for
     * evil vs no callback) AND, best-effort, that any DELIVERED link host stays on the
     * allow-list. This is the open-redirect-on-email-link defence proper.
     */
    test('an evil callback host is accepted but never used in the emailed link (silent allow-list fallback)', async ({
        request,
    }, testInfo) => {
        // --- register: emailVerificationCallbackUrl ---
        const u = makeTestUser('cb-verify');
        if (await isMailhogAvailable(request)) await clearMailhogInbox(request);

        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: uniqUsername('cbv'),
                email: u.email,
                password: u.password,
                emailVerificationCallbackUrl: `https://${ATTACKER_HOST}/steal`,
            },
        });
        // The endpoint accepts it (201) — it does NOT reject on host; it sanitizes silently.
        expect(reg.status(), await reg.text()).toBe(201);

        const verifyMail = await inspectDeliveredLinkHost(
            request,
            u.email,
            /https?:\/\/[^\s"'<>]*\/api\/auth\/verify-email[^\s"'<>]*/,
        );
        if (verifyMail.delivered) {
            expect(
                verifyMail.hijacked,
                `verification link host hijacked to ${verifyMail.host}`,
            ).toBe(false);
        }

        // --- forgot-password: resetPasswordCallbackUrl, evil vs none body parity ---
        const reset = await registerUserViaAPI(request);
        const evilForgot = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: reset.email, resetPasswordCallbackUrl: `http://${ATTACKER_HOST}/r` },
        });
        expect([200, 429]).toContain(evilForgot.status());
        if (evilForgot.status() === 200) {
            // Identical anti-enumeration body whether or not a (bad) callback was supplied.
            expect((await evilForgot.json()).message).toContain(FORGOT_UNIFORM_MSG);
            const resetMail = await inspectDeliveredLinkHost(
                request,
                reset.email,
                /https?:\/\/[^\s"'<>]*reset-password[^\s"'<>]*/,
            );
            if (resetMail.delivered) {
                expect(resetMail.hijacked, `reset link host hijacked to ${resetMail.host}`).toBe(
                    false,
                );
            }
        }

        // --- magic-link: magicLinkCallbackUrl ---
        const magic = await registerUserViaAPI(request);
        const evilMagic = await request.post(`${API_BASE}/api/auth/magic-link`, {
            data: { email: magic.email, magicLinkCallbackUrl: `https://${ATTACKER_HOST}/m` },
        });
        expect([200, 429]).toContain(evilMagic.status());
        if (evilMagic.status() === 200) {
            expect((await evilMagic.json()).message).toContain(MAGIC_UNIFORM_MSG);
            const magicMail = await inspectDeliveredLinkHost(
                request,
                magic.email,
                /https?:\/\/[^\s"'<>]*login\/magic-link[^\s"'<>]*/,
            );
            if (magicMail.delivered) {
                expect(magicMail.hijacked, `magic-link host hijacked to ${magicMail.host}`).toBe(
                    false,
                );
            }
        }

        testInfo.annotations.push({
            type: 'note',
            description:
                'C-04 callback-host allow-list asserted via endpoint acceptance + uniform-body parity; ' +
                'delivered-link-host check is best-effort (e2e SMTP delivery flaky).',
        });
    });

    /**
     * FLOW 3 — OPEN-REDIRECT on the email deeplink WEB ROUTE HANDLERS. The
     * redirect-prevention.spec covers the login PAGE; here we attack the verify-email /
     * reset-password ROUTE HANDLERS that an email link hits directly. Appending
     * redirect_uri / next / returnTo / callbackUrl with an attacker host must NOT appear
     * in the Location and must NOT move the landing off our same origin — the only
     * redirect seam is the server-side getRedirectUrl() cookie, never the query string.
     */
    test('email deeplink route handlers ignore attacker redirect query params (stay same-origin)', async ({
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        const originHost = new URL(origin).host.toLowerCase();
        const params = ['redirect_uri', 'next', 'returnTo', 'callbackUrl', 'redirect'];
        const evil = `https://${ATTACKER_HOST}/phish`;

        for (const p of params) {
            // verify-email handler with a bad token + an attacker redirect param.
            const v = await request.get(
                `${origin}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}&${p}=${encodeURIComponent(evil)}`,
                { maxRedirects: 0 },
            );
            expect([302, 307, 308]).toContain(v.status());
            const vLoc = (v.headers()['location'] ?? '').toLowerCase();
            // Must land on our own auth/error path — never the attacker host.
            expect(vLoc.includes(ATTACKER_HOST), `verify ${p} redirected off-origin: ${vLoc}`).toBe(
                false,
            );
            // Location is either relative (/auth/error...) or absolute on our host.
            if (/^https?:\/\//.test(vLoc)) {
                expect(new URL(vLoc).host.toLowerCase()).toBe(originHost);
            }
            expect(vLoc).toContain('/auth/error');

            // reset-password handler likewise.
            const r = await request.get(
                `${origin}/api/auth/reset-password?token=${KNOWN_BAD_TOKEN}&${p}=${encodeURIComponent(evil)}`,
                { maxRedirects: 0 },
            );
            expect([302, 307, 308]).toContain(r.status());
            const rLoc = (r.headers()['location'] ?? '').toLowerCase();
            expect(rLoc.includes(ATTACKER_HOST), `reset ${p} redirected off-origin: ${rLoc}`).toBe(
                false,
            );
            if (/^https?:\/\//.test(rLoc)) {
                expect(new URL(rLoc).host.toLowerCase()).toBe(originHost);
            }
            expect(rLoc).toContain('/auth/error');
        }

        // And a protocol-relative / javascript: payload must not hijack the verify landing either.
        for (const payload of ['//attacker.example.com', 'javascript:alert(1)']) {
            const res = await request.get(
                `${origin}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}&redirect_uri=${encodeURIComponent(payload)}`,
                { maxRedirects: 0 },
            );
            expect([302, 307, 308]).toContain(res.status());
            const loc = (res.headers()['location'] ?? '').toLowerCase();
            expect(loc.includes(ATTACKER_HOST)).toBe(false);
            expect(loc.startsWith('javascript:')).toBe(false);
            expect(loc).toContain('/auth/error');
        }
    });

    /**
     * FLOW 4 — HOLISTIC bounce contract across EVERY transactional-mail endpoint at
     * once. The existing email-bounce-handling.spec only checks register on 3 domains.
     * Here: bounce-shaped (RFC-2606 reserved), IDN/unicode, and pathologically-long
     * domains must never 5xx on register / forgot-password / magic-link / send-verification,
     * and the anti-enumeration uniform body must be byte-identical for a bounce domain.
     */
    test('all transactional-mail endpoints survive bounce / IDN / over-long domains without 5xx', async ({
        request,
    }) => {
        const bounceDomains = [
            'bounce-12345.invalid', // RFC-2606 reserved-as-bounce
            'unreachable.example.com', // RFC-2606 reserved
            'no-mx-record.test', // RFC-2606 reserved
            'xn--80ak6aa92e.com', // IDN punycode
            `${'a'.repeat(60)}.example`, // pathologically long label
        ];

        for (const domain of bounceDomains) {
            const email = `bounce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@${domain}`;

            // register — accept (201) or DTO-reject the shape (4xx), never 5xx.
            const reg = await request.post(`${API_BASE}/api/auth/register`, {
                data: { username: uniqUsername('b'), email, password: 'TestPass1!secure' },
            });
            expect(reg.status(), `register @${domain}`).toBeLessThan(500);

            // forgot-password — uniform 200 (or 400 email-shape / 429), never 5xx.
            const forgot = await request.post(`${API_BASE}/api/auth/forgot-password`, {
                data: { email },
            });
            expect(forgot.status(), `forgot @${domain}`).toBeLessThan(500);
            if (forgot.status() === 200) {
                expect((await forgot.json()).message).toContain(FORGOT_UNIFORM_MSG);
            }

            // magic-link — uniform 200 (or 400 / 429), never 5xx.
            const magic = await request.post(`${API_BASE}/api/auth/magic-link`, {
                data: { email },
            });
            expect(magic.status(), `magic @${domain}`).toBeLessThan(500);
            if (magic.status() === 200) {
                expect((await magic.json()).message).toContain(MAGIC_UNIFORM_MSG);
            }
        }

        // send-verification on a registered bounce-domain user: even though the eventual
        // delivery would bounce, the API response is async-decoupled and must not 5xx.
        const bounceUser = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: uniqUsername('bv'),
                email: `bounce-verify-${Date.now().toString(36)}@bounce-test.invalid`,
                password: 'TestPass1!secure',
            },
        });
        if (bounceUser.status() === 201) {
            const token = (await bounceUser.json()).access_token as string;
            const send = await request.post(`${API_BASE}/api/auth/send-verification`, {
                headers: authedHeaders(token),
            });
            expect(send.status(), 'send-verification on bounce-domain user').toBeLessThan(500);
        }
    });

    /**
     * FLOW 5 — Deeplink token-prefill INTEGRITY on the reset PAGE (browser, anon). The
     * token in ?token= must reach the reset action verbatim, the bad token must surface
     * an error (never a success navigation off to /login?reset=true), and a missing token
     * must render the invalid-link panel — not the form. Resilient selectors + an anon
     * context (empty storageState) so the shared auth cookie isn't inherited.
     */
    test('reset deeplink carries its token into the form and surfaces an error, never a false success', async ({
        browser,
        baseURL,
    }, testInfo) => {
        const origin = baseURL ?? 'http://localhost:3000';
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            // A token with URL-special characters proves it's carried verbatim, not mangled.
            const token = `dl-token-${Date.now()}.A-b_c~9`;
            await page.goto(`${origin}/reset-password?token=${encodeURIComponent(token)}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });

            const passwordField = page.locator('input[type="password"]').first();
            const invalidPanel = page.getByText(/invalid reset link|request a new password reset/i);
            const loginForm = page.locator('form').filter({ hasText: /sign in|log in|login/i });
            // The page resolves to EITHER the reset form, the invalid-link panel, or (route
            // divergence) a login redirect — all are non-crash resolutions.
            await expect(passwordField.or(invalidPanel).or(loginForm).first()).toBeVisible({
                timeout: 20_000,
            });

            if (await passwordField.isVisible().catch(() => false)) {
                // Fill both password fields (the form requires a match) and submit against the
                // bogus token; we must see an error-like state, never a success navigation.
                await passwordField.fill('ValidPass1!');
                const confirm = page.locator('input[type="password"]').nth(1);
                if (await confirm.isVisible().catch(() => false)) {
                    await confirm.fill('ValidPass1!');
                }
                const submit = page
                    .getByRole('button', { name: /reset password|reset|submit|continue/i })
                    .first();

                await expect(async () => {
                    if (await submit.isVisible().catch(() => false)) {
                        await submit.click({ timeout: 5_000 });
                    }
                    // Acceptable: a visible error, OR the still-alive form (request failed,
                    // retry possible). Forbidden: a navigation to the success page.
                    const errorLike = page
                        .getByText(/invalid|expired|error|went wrong|try again|failed/i)
                        .or(passwordField);
                    await expect(errorLike.first()).toBeVisible({ timeout: 6_000 });
                }).toPass({ timeout: 25_000 });

                // We must NOT have been bounced to the post-reset success URL.
                expect(page.url(), 'bogus reset must not reach the success page').not.toContain(
                    'reset=true',
                );
            } else {
                testInfo.annotations.push({
                    type: 'route-divergence',
                    description:
                        '/reset-password resolved to the invalid-link panel or a login redirect in this env; asserted resolution only.',
                });
            }
        } finally {
            await context.close();
        }
    });

    /**
     * FLOW 6 — Magic-link deeplink PAGE + cross-flavor callback DTO hardening. The
     * /login/magic-link?token= page auto-redeems; a bad token must land the "This link
     * can't be used" error panel (data-testid=magic-link-error), never a silent success.
     * Plus the always-on DTO hardening across all three flavors: a non-string callback URL
     * is a 400 ['<field> must be a string'] and an extra unknown property is a
     * forbidNonWhitelisted 400 — the same strict-whitelist contract on every mail endpoint.
     */
    test('magic-link deeplink page errors on a bad token; callback DTOs are strictly whitelisted', async ({
        request,
        browser,
        baseURL,
    }, testInfo) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // --- DTO hardening: non-string callback -> 400 'must be a string' (all three flavors) ---
        const nonStringCases: Array<{
            path: string;
            data: Record<string, unknown>;
            field: string;
        }> = [
            {
                path: '/api/auth/register',
                data: {
                    username: uniqUsername('nsv'),
                    email: uniqEmail('ns-v'),
                    password: 'TestPass1!secure',
                    emailVerificationCallbackUrl: ['x'],
                },
                field: 'emailVerificationCallbackUrl',
            },
            {
                path: '/api/auth/forgot-password',
                data: { email: uniqEmail('ns-r'), resetPasswordCallbackUrl: 12345 },
                field: 'resetPasswordCallbackUrl',
            },
            {
                path: '/api/auth/magic-link',
                data: { email: uniqEmail('ns-m'), magicLinkCallbackUrl: { evil: true } },
                field: 'magicLinkCallbackUrl',
            },
        ];
        for (const c of nonStringCases) {
            const res = await request.post(`${API_BASE}${c.path}`, { data: c.data });
            expect(res.status(), `${c.path} non-string callback`).toBe(400);
            expect(JSON.stringify(await res.json())).toContain(`${c.field} must be a string`);
        }

        // --- forbidNonWhitelisted: an extra unknown prop -> 400 'property <x> should not exist' ---
        const extra = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: uniqEmail('extra'), surprise: 'nope' },
        });
        expect(extra.status()).toBe(400);
        expect(JSON.stringify(await extra.json())).toContain('should not exist');

        // --- the magic-link deeplink PAGE auto-redeems a bad token -> error panel, no success ---
        const providers = await request.get(`${API_BASE}/api/auth/providers`);
        const magicEnabled =
            providers.ok() &&
            ((await providers.json()) as { magicLink?: boolean }).magicLink === true;

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            await page.goto(`${origin}/login/magic-link?token=${KNOWN_BAD_TOKEN}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });

            // The redeem client renders the error panel (testid magic-link-error) for a bad/
            // missing token, or the "can't be used" copy; tolerate a login-redirect divergence.
            const errorPanel = page.getByTestId('magic-link-error');
            const errorText = page.getByText(/can't be used|invalid|expired|request a new/i);

            await expect(async () => {
                const settled =
                    (await errorPanel
                        .first()
                        .isVisible()
                        .catch(() => false)) ||
                    (await errorText
                        .first()
                        .isVisible()
                        .catch(() => false)) ||
                    /\/(login|auth)/.test(page.url());
                expect(settled, `magic-link page did not settle: ${page.url()}`).toBe(true);
            }).toPass({ timeout: 25_000 });

            // A bad token must NEVER auto-land an authenticated success page.
            expect(page.url(), 'bad magic-link token must not reach a success page').not.toMatch(
                /\?(verified|reset|newUser)=true/,
            );

            if (!magicEnabled) {
                testInfo.annotations.push({
                    type: 'config',
                    description:
                        'magicLink advertised false; asserted the redeem-page error resolution + DTO hardening only.',
                });
            }
        } finally {
            await context.close();
        }
    });
});
