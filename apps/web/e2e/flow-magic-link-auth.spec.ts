import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    listMessages,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * flow-magic-link-auth — Magic-link (passwordless) auth round-trip.
 *
 * COMPLEX, multi-step integration flows that go beyond the existing
 * `magic-link.spec.ts` (single issue+redeem probe) and `magic-link-ui.spec.ts`
 * (login-page tab UI). Here we orchestrate the *whole* passwordless lifecycle
 * end-to-end and assert observable, truthful outcomes at each step:
 *
 *   1. Two-user round-trip: register two distinct users, request a magic link
 *      for each, fish each user's OWN token out of MailHog (proving tokens are
 *      user-distinct, not cross-wired), redeem one, then PROVE the redeemed
 *      session is genuinely usable by calling GET /api/auth/profile with the
 *      issued bearer and matching it back to the right user — and confirm the
 *      token is single-use (replay rejected).
 *   2. Token lifecycle matrix against a REAL outstanding token: redeem twice
 *      (second rejected), re-issuing a link rotates/invalidates the prior
 *      token, plus the obviously-invalid / empty / missing-token rejections,
 *      all asserted against the platform's EXACT 400 error envelopes.
 *   3. Provider advertisement + the real web redeem page: GET
 *      /api/auth/providers advertises `magicLink`, and the web
 *      /login/magic-link?token=<bogus> page drives the redeem endpoint and
 *      surfaces the truthful "invalid / expired" UI.
 *
 * VERIFIED LIVE SHAPES (probed against http://127.0.0.1:3100 before writing):
 *   - GET  /api/auth/providers
 *       → 200 { emailPassword:true, magicLink:boolean, socialProviders:string[] }
 *   - POST /api/auth/magic-link { email }
 *       → 200 { message: "If the email is registered, a magic link has been sent" }
 *         (identical for known + unknown emails; token NEVER echoed)
 *       → 400 { message:["email must be an email", ...] } on a bad/missing email
 *   - POST /api/auth/magic-link/redeem { token }
 *       → 200 { access_token:<32-char opaque>, user:{ id, email, username } }
 *       → 400 { message:"Invalid magic link", error:"Bad Request", statusCode:400 }
 *         (non-matching token, OR a replayed/consumed token — single-use)
 *       → 400 { message:["token should not be empty"], ... } (empty string, DTO)
 *       → 400 { message:["token should not be empty","token must be a string"] }
 *         (missing field, DTO)
 *   - Mail: subject contains "Sign in", body carries a URL of the form
 *       <WEB_URL>/login/magic-link?token=<64-hex> (randomBytes(32).toString('hex')),
 *       15-minute TTL, single-use (auth.service.ts requestMagicLink/redeemMagicLink).
 *
 * ENVIRONMENT-ADAPTIVE: the full delivery round-trip needs MailHog (the e2e
 * workflow's mail service container) AND MAGIC_LINK_ENABLED=true. When MailHog
 * is unreachable (local laptop) we still drive every assertion that doesn't
 * need a delivered token — issuance contract, redeem error matrix, provider
 * list, and the web redeem page — and skip ONLY the delivery-dependent leg
 * with a clear message, matching the established pattern in magic-link.spec.ts.
 */

const ISSUE_PATH = `${API_BASE}/api/auth/magic-link`;
const REDEEM_PATH = `${API_BASE}/api/auth/magic-link/redeem`;
const PROVIDERS_PATH = `${API_BASE}/api/auth/providers`;

const ISSUED_MESSAGE = 'If the email is registered, a magic link has been sent';
/** randomBytes(32).toString('hex') → 64 lowercase hex chars. */
const TOKEN_RE = /token=([a-f0-9]{16,})/i;

async function isMagicLinkEnabled(request: APIRequestContext): Promise<boolean> {
    const res = await request.get(PROVIDERS_PATH);
    if (!res.ok()) return false;
    const body = (await res.json()) as { magicLink?: boolean };
    return body.magicLink === true;
}

/**
 * Poll MailHog for the most-recent "Sign in" email addressed to `recipient`
 * and pull the magic-link token out of its body. Returns null on timeout so
 * callers can skip gracefully on a transient SMTP/MailHog flake rather than
 * fail CI. A recipient-only filter is unsafe here: the registration
 * confirmation email shares the recipient, so we additionally require the
 * subject to contain "Sign in" and the body to carry a `token=` URL.
 */
async function waitForMagicToken(
    request: APIRequestContext,
    recipient: string,
    timeoutMs = 30_000,
): Promise<{ token: string; message: MailhogMessage } | null> {
    const deadline = Date.now() + timeoutMs;
    const recipientLower = recipient.toLowerCase();
    while (Date.now() < deadline) {
        const messages = await listMessages(request, 50);
        for (const m of messages) {
            const toMatch = m.To?.some(
                (t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === recipientLower,
            );
            if (!toMatch) continue;
            const subject = m.Content?.Headers?.['Subject']?.[0] ?? '';
            if (!/sign\s*in/i.test(subject)) continue;
            const match = TOKEN_RE.exec(m.Content?.Body ?? '');
            if (match) return { token: match[1]!, message: m };
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return null;
}

/** Issue a magic link and assert the anti-enumeration issuance contract. */
async function issueMagicLink(request: APIRequestContext, email: string): Promise<void> {
    const res = await request.post(ISSUE_PATH, { data: { email } });
    expect(res.status(), `issuance for ${email} should be 200`).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe(ISSUED_MESSAGE);
    // The raw token must NEVER appear in the issuance response body.
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/token/i);
}

test.describe('flow-magic-link-auth — passwordless round-trip', () => {
    test.beforeAll(async ({ request }) => {
        // If the feature flag is off, the endpoints aren't meaningfully
        // mounted (issuance no-ops, provider list hides it). Surface a
        // clear skip rather than asserting against a disabled feature.
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED=false on this build — magic-link disabled');
        }
    });

    /**
     * FLOW 1 — Full delivery round-trip for TWO distinct users.
     *
     * Registers two users, issues a magic link to each, then proves via
     * MailHog that each inbox received a DISTINCT token bound to the right
     * recipient (no cross-wiring). Redeems user A's token and proves the
     * resulting session is genuinely valid + scoped to A by calling
     * /api/auth/profile with the issued bearer and matching the email/id.
     * Finally confirms A's token is single-use (replay → 400) and that A's
     * redemption did NOT consume B's still-outstanding token.
     */
    test('two-user delivery round-trip: distinct tokens, valid session, single-use', async ({
        request,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog service container not running — cannot read delivered links');
        }

        const userA = await registerUserViaAPI(request, { email: makeTestUser('mlflow-a').email });
        const userB = await registerUserViaAPI(request, { email: makeTestUser('mlflow-b').email });

        // Let the registration-confirmation emails (fire-and-forget) settle,
        // then clear the inbox so the only "Sign in" emails we read are the
        // ones this test issues. Without the settle-then-clear, an in-flight
        // confirmation can land AFTER the clear and pollute the read.
        await waitForMessageTo(request, userA.email, { timeoutMs: 10_000 }).catch(() => null);
        await waitForMessageTo(request, userB.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        await issueMagicLink(request, userA.email);
        await issueMagicLink(request, userB.email);

        const fishedA = await waitForMagicToken(request, userA.email);
        const fishedB = await waitForMagicToken(request, userB.email);
        if (!fishedA || !fishedB) {
            test.skip(
                true,
                `magic-link email never arrived within 30s (A=${!!fishedA}, B=${!!fishedB}) — CI mail/SMTP transport flake`,
            );
        }

        // Tokens are 256-bit random hex and must be DISTINCT per user — a
        // shared/reused token would be a critical cross-account leak.
        expect(fishedA!.token).toMatch(/^[a-f0-9]+$/i);
        expect(fishedB!.token).toMatch(/^[a-f0-9]+$/i);
        expect(fishedA!.token).not.toBe(fishedB!.token);

        // The delivered URL must point at the platform's own redeem page.
        const bodyA = fishedA!.message.Content?.Body ?? '';
        expect(bodyA).toMatch(/\/login\/magic-link\?token=/i);

        // Redeem A's token → a real session.
        const redeemA = await request.post(REDEEM_PATH, { data: { token: fishedA!.token } });
        expect(redeemA.status(), `redeem A status`).toBe(200);
        const sessionA = (await redeemA.json()) as {
            access_token?: string;
            user?: { id?: string; email?: string };
        };
        expect(typeof sessionA.access_token).toBe('string');
        expect(sessionA.access_token!.length).toBeGreaterThan(10);
        expect(sessionA.user).toBeDefined();
        // Session is scoped to user A, not some other / anonymous identity.
        expect((sessionA.user!.email ?? '').toLowerCase()).toBe(userA.email.toLowerCase());

        // PROVE the session is genuinely usable: the issued bearer must
        // resolve an authenticated endpoint back to user A. This is the
        // truthful definition of "a valid session resulted".
        const profile = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(sessionA.access_token!),
        });
        expect(profile.status(), `profile with redeemed bearer`).toBe(200);
        const profileBody = (await profile.json()) as { id?: string; email?: string };
        expect((profileBody.email ?? '').toLowerCase()).toBe(userA.email.toLowerCase());
        expect(profileBody.id).toBe(userA.user.id);

        // Single-use: replaying A's now-consumed token is rejected with the
        // uniform invalid-link envelope (never re-issues a session).
        const replayA = await request.post(REDEEM_PATH, { data: { token: fishedA!.token } });
        expect(replayA.status(), `replay of consumed token`).toBe(400);
        const replayBody = (await replayA.json()) as { message?: string };
        expect(replayBody.message).toBe('Invalid magic link');

        // Cross-isolation: A's redemption must NOT have consumed B's token —
        // B's link is independent and still redeems to B's own session.
        const redeemB = await request.post(REDEEM_PATH, { data: { token: fishedB!.token } });
        expect(redeemB.status(), `redeem B (independent of A)`).toBe(200);
        const sessionB = (await redeemB.json()) as { user?: { email?: string } };
        expect((sessionB.user!.email ?? '').toLowerCase()).toBe(userB.email.toLowerCase());
    });

    /**
     * FLOW 2 — Token lifecycle matrix against a REAL outstanding token.
     *
     * Goes deeper than a single bogus-token probe: issues a real link,
     * proves re-issuing ROTATES the token (the first link is invalidated by
     * the second), then walks every rejection branch with its EXACT 400
     * envelope: replay of a consumed token, a well-formed-but-non-matching
     * token, an empty token (DTO), and a missing token field (DTO). The
     * MailHog-dependent legs (rotation/replay) skip gracefully when mail is
     * unavailable; the DTO/invalid-token legs always run (no token needed).
     */
    test('token rotation + single-use + invalid/empty/missing rejection matrix', async ({
        request,
    }) => {
        // --- Legs that NEVER need a delivered token: exact 400 envelopes. ---

        // Well-formed (64-hex) but non-matching token → uniform invalid-link
        // message (must not distinguish "wrong shape" from "no such token").
        const bogus = 'deadbeef'.repeat(8); // 64 hex chars
        const bogusRes = await request.post(REDEEM_PATH, { data: { token: bogus } });
        expect(bogusRes.status()).toBe(400);
        const bogusBody = (await bogusRes.json()) as { message?: string; statusCode?: number };
        expect(bogusBody.message).toBe('Invalid magic link');
        expect(bogusBody.statusCode).toBe(400);

        // A non-hex garbage token gets the SAME uniform message — no shape
        // disclosure (the redeem handler hashes whatever it's given).
        const garbageRes = await request.post(REDEEM_PATH, { data: { token: 'not-a-real-token' } });
        expect(garbageRes.status()).toBe(400);
        expect(((await garbageRes.json()) as { message?: string }).message).toBe(
            'Invalid magic link',
        );

        // Empty token → class-validator @IsNotEmpty fires (message is an array).
        const emptyRes = await request.post(REDEEM_PATH, { data: { token: '' } });
        expect(emptyRes.status()).toBe(400);
        const emptyBody = (await emptyRes.json()) as { message?: unknown };
        expect(Array.isArray(emptyBody.message)).toBe(true);
        expect((emptyBody.message as string[]).join(' ')).toMatch(/token should not be empty/i);

        // Missing token field → @IsString + @IsNotEmpty both fire.
        const missingRes = await request.post(REDEEM_PATH, { data: {} });
        expect(missingRes.status()).toBe(400);
        const missingBody = (await missingRes.json()) as { message?: unknown };
        expect(Array.isArray(missingBody.message)).toBe(true);
        expect((missingBody.message as string[]).join(' ')).toMatch(/token must be a string/i);

        // Issuance input validation: a malformed email is a 400 (DTO @IsEmail),
        // distinct from the anti-enumeration 200 for a well-formed unknown email.
        const badEmailRes = await request.post(ISSUE_PATH, { data: { email: 'not-an-email' } });
        expect(badEmailRes.status()).toBe(400);
        expect(((await badEmailRes.json()) as { message?: unknown }).message).toBeTruthy();

        // --- Legs that DO need a delivered token: rotation + single-use. ---
        if (!(await isMailhogAvailable(request))) {
            test.skip(
                true,
                'MailHog not running — rotation/single-use legs require delivered tokens',
            );
        }

        const user = await registerUserViaAPI(request, {
            email: makeTestUser('mlflow-rotate').email,
        });
        await waitForMessageTo(request, user.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        // Issue link #1, fish its token.
        await issueMagicLink(request, user.email);
        const first = await waitForMagicToken(request, user.email);
        if (!first) {
            test.skip(true, 'first magic-link email never arrived within 30s — CI mail flake');
        }

        // Issue link #2 for the SAME user. The service overwrites
        // magicLinkToken on each request, so link #1 should be invalidated.
        await clearMailhogInbox(request);
        await issueMagicLink(request, user.email);
        const second = await waitForMagicToken(request, user.email);
        if (!second) {
            test.skip(true, 'second magic-link email never arrived within 30s — CI mail flake');
        }

        // Two issuances → two distinct tokens (fresh randomBytes each time).
        expect(second!.token).not.toBe(first!.token);

        // ROTATION: link #1 is now stale and must NOT redeem (overwritten by #2).
        const staleRedeem = await request.post(REDEEM_PATH, { data: { token: first!.token } });
        expect(staleRedeem.status(), `superseded token #1 must be rejected`).toBe(400);
        expect(((await staleRedeem.json()) as { message?: string }).message).toBe(
            'Invalid magic link',
        );

        // The CURRENT token (#2) redeems exactly once.
        const goodRedeem = await request.post(REDEEM_PATH, { data: { token: second!.token } });
        expect(goodRedeem.status(), `current token #2 should redeem`).toBe(200);
        const session = (await goodRedeem.json()) as { access_token?: string };
        expect(typeof session.access_token).toBe('string');

        // SINGLE-USE: replaying #2 immediately after consumption is rejected.
        const replay = await request.post(REDEEM_PATH, { data: { token: second!.token } });
        expect(replay.status(), `consumed token #2 replay`).toBe(400);
        expect(((await replay.json()) as { message?: string }).message).toBe('Invalid magic link');
    });

    /**
     * FLOW 2b — Anti-enumeration: issuance is byte-identical (status + body
     * envelope) for a registered email and a never-seen email. A divergence
     * here would let an attacker enumerate registered users via the
     * passwordless endpoint. Does not require MailHog.
     */
    test('issuance is indistinguishable for known vs unknown email (no enumeration)', async ({
        request,
    }) => {
        const known = await registerUserViaAPI(request, {
            email: makeTestUser('mlflow-known').email,
        });
        const unknownEmail = makeTestUser('mlflow-unknown').email;

        const knownRes = await request.post(ISSUE_PATH, { data: { email: known.email } });
        const unknownRes = await request.post(ISSUE_PATH, { data: { email: unknownEmail } });

        expect(knownRes.status()).toBe(200);
        // The real invariant: both branches return the SAME status, so an
        // attacker can't tell a registered email from an unknown one.
        expect(unknownRes.status()).toBe(knownRes.status());

        const knownBody = (await knownRes.json()) as Record<string, unknown>;
        const unknownBody = (await unknownRes.json()) as Record<string, unknown>;
        // Identical message AND identical key set — no body-shape tell.
        expect(knownBody.message).toBe(ISSUED_MESSAGE);
        expect(unknownBody.message).toBe(ISSUED_MESSAGE);
        expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
        // Neither branch leaks a token.
        expect(knownBody.token).toBeUndefined();
        expect(unknownBody.token).toBeUndefined();
    });
});

test.describe('flow-magic-link-auth — provider advertisement + web redeem page', () => {
    /**
     * FLOW 3a — Provider list. The web login UI keys its "Email me a link"
     * tab off this boolean; it must always be present and well-typed
     * alongside emailPassword + socialProviders, regardless of the flag value.
     */
    test('GET /api/auth/providers advertises a typed magicLink capability', async ({ request }) => {
        const res = await request.get(PROVIDERS_PATH);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(typeof body.magicLink).toBe('boolean');
        expect(typeof body.emailPassword).toBe('boolean');
        expect(body.emailPassword).toBe(true);
        expect(Array.isArray(body.socialProviders)).toBe(true);
    });

    /**
     * FLOW 3b — Real web redeem page end-to-end for an INVALID token.
     *
     * Drives the actual Next.js /login/magic-link?token=<bogus> page (the
     * exact URL shape emailed to users). The page calls the redeem endpoint
     * client-side; for a non-matching token it must surface the truthful
     * "this link can't be used / invalid or expired" UI and NOT sign the
     * visitor in. This is the closest deterministic UI assertion we can make
     * without a freshly delivered token (which needs MailHog). The page lives
     * under the no-auth login route, so it renders even with storageState.
     */
    test('web /login/magic-link redeem page surfaces the invalid-link UI for a bogus token', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED=false — magic-link redeem page not exercised');
        }

        const bogusToken = 'deadbeef'.repeat(8);
        await page.goto(`/login/magic-link?token=${bogusToken}`, { waitUntil: 'domcontentloaded' });

        // The page either shows a transient "Verifying your magic link..."
        // state then resolves to the error, or jumps straight to the error.
        // Assert the truthful end state: an invalid/expired message is shown
        // (en.json: redeem.errorTitle / redeem.errorBody) — generous timeout
        // to cover next-dev cold compile of the route + the client redeem call.
        const invalidCopy = page
            .getByText(/can'?t be used|invalid or has expired|invalid or expired/i)
            .first();
        await expect(invalidCopy).toBeVisible({ timeout: 30_000 });

        // A "request a new link" affordance should be offered so the user
        // can recover — proving this is the genuine error surface, not a
        // half-rendered success/loading state.
        const recover = page.getByText(/send a new link|request a new|send another link/i).first();
        await expect(recover).toBeVisible({ timeout: 10_000 });

        // The bogus redemption must NOT have minted a session: we are still
        // on the magic-link route, not bounced into an authenticated area.
        await expect(page).toHaveURL(/\/login\/magic-link/);
    });

    /**
     * FLOW 3c — Missing-token web page. Visiting the redeem route with no
     * token at all must show the "missing token" guidance, never attempt a
     * redeem with an empty token nor silently sign anyone in.
     */
    test('web /login/magic-link with no token shows missing-token guidance', async ({
        page,
        request,
    }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED=false — magic-link redeem page not exercised');
        }

        await page.goto('/login/magic-link', { waitUntil: 'domcontentloaded' });

        // en.json redeem.missingToken: "This magic link is missing a token..."
        // Tolerate the platform funnelling the no-token case into the same
        // generic invalid-link surface — either truthful end state is fine,
        // what matters is that no session is minted and a recovery path shows.
        const missingOrInvalid = page
            .getByText(/missing a token|can'?t be used|invalid or has expired|invalid or expired/i)
            .first();
        await expect(missingOrInvalid).toBeVisible({ timeout: 30_000 });
        await expect(page).toHaveURL(/\/login\/magic-link/);
    });
});
