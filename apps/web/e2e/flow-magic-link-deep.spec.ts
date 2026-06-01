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
 * flow-magic-link-deep — DEEP magic-link integration flows.
 *
 * These are COMPLEX, multi-step, cross-feature flows that intentionally go
 * BEYOND the three existing magic-link specs so we don't duplicate them:
 *   - `magic-link.spec.ts`           — single issue+redeem probe + provider list.
 *   - `magic-link-ui.spec.ts`        — login-page tab UI + redeem page.
 *   - `flow-magic-link-auth.spec.ts` — two-user round-trip, rotation, DTO matrix,
 *                                       anti-enumeration, web redeem page.
 *
 * What's NEW here (the genuine gaps):
 *   1. CROSS-ACCOUNT token leak: B's delivered token, redeemed by ANYONE, must
 *      mint *B's* identity — never A's, never the seeded UI user's. A redeemed
 *      session is asserted by walking the bearer back through profile + a SECOND
 *      authenticated endpoint and matching the user id, then proving it does NOT
 *      resolve to a different account.
 *   2. FIRST-CLASS SESSION: a magic-link-minted bearer is a real session, not a
 *      read-only stub — it can hit authenticated WRITE-ish surfaces (logout)
 *      and `/profile/fresh`, and after logout the SAME bearer is invalidated.
 *   3. EXPIRED / STALE token leg: a token that is *superseded* (and, where the
 *      build supports it, time-expired) is rejected with the uniform envelope —
 *      proving redemption is gated on more than "string exists".
 *   4. CONCURRENT redemption race: firing N parallel redeems of ONE freshly
 *      delivered token yields AT MOST ONE success — single-use holds under
 *      contention, not just sequentially.
 *   5. ANON-CONTEXT redeem independence: redemption works from a context with NO
 *      inherited storageState cookie (bare passwordless sign-in), and the
 *      resulting bearer is the ONLY thing that authenticates — proving the flow
 *      doesn't secretly lean on the seeded session cookie.
 *   6. PROVIDER ↔ ISSUANCE coherence: the advertised `magicLink` capability and
 *      the issuance endpoint agree (advertised ⇒ issuance is mounted & 200s;
 *      issuance never leaks a token regardless), plus method/shape hardening.
 *
 * VERIFIED LIVE SHAPES (probed against http://127.0.0.1:3100 + read from the
 * sibling flow-magic-link-auth.spec.ts contract docblock):
 *   - GET  /api/auth/providers
 *       → 200 { emailPassword:true, magicLink:boolean, socialProviders:string[] }
 *   - POST /api/auth/magic-link { email }
 *       → 200 { message: "If the email is registered, a magic link has been sent" }
 *         (identical for known + unknown; token NEVER echoed)
 *       → 400 { message:["email must be an email"], error:"Bad Request", statusCode:400 }
 *         (CONFIRMED via live curl)
 *       → 429 when @Throttle(5/60s per-IP) trips
 *   - POST /api/auth/magic-link/redeem { token }
 *       → 200 { access_token:<opaque>, user:{ id, email, username } }
 *         (CONFIRMED: opaque session token from authProvider.issueSession, NOT a JWT)
 *       → 400 { message:"Invalid magic link", error:"Bad Request", statusCode:400 }
 *         (non-matching OR consumed/superseded token — single-use & rotation;
 *          a re-issue OVERWRITES magicLinkToken so the prior token no longer
 *          matches any row → "Invalid magic link", NOT the expiry message)
 *       → 400 { message:"Magic link expired", ... } (token whose 15-min TTL passed —
 *          a DISTINCT message from the redeemMagicLink service; CONFIRMED in source)
 *       → 400 { message:["token should not be empty"], ... } (empty token, DTO array)
 *       → 400 { message:["token should not be empty","token must be a string"], ... }
 *         (missing token, DTO array) — both CONFIRMED via live curl.
 *   - GET  /api/auth/profile        → 200 { id, userId, email, ... } with a valid bearer,
 *         401 { message:"Unauthorized", statusCode:401 } without (CONFIRMED).
 *   - GET  /api/auth/profile/fresh  → 200 full re-fetch (exposes magicLinkToken:null,
 *         magicLinkExpires:null among many fields) with a valid bearer.
 *   - POST /api/auth/logout         → 200 with a valid bearer; HARD-invalidates the
 *         opaque session (a subsequent /profile with the SAME bearer is 401 — CONFIRMED).
 *   - Mail: subject contains "Sign in"; body carries <WEB>/login/magic-link?token=<64-hex>;
 *     15-minute TTL; single-use; re-issue ROTATES (overwrites) the prior token.
 *
 * ENVIRONMENT-ADAPTIVE: legs that need a *delivered* token require MailHog AND
 * MAGIC_LINK_ENABLED=true. e2e SMTP delivery is known-flaky ("Missing
 * credentials for PLAIN") even when MailHog HTTP is up, so EVERY delivery leg
 * fishes best-effort and `test.skip`s (never hard-fails) when the email doesn't
 * arrive. The contract/error/provider legs need no delivery and always run.
 */

const ISSUE_PATH = `${API_BASE}/api/auth/magic-link`;
const REDEEM_PATH = `${API_BASE}/api/auth/magic-link/redeem`;
const PROVIDERS_PATH = `${API_BASE}/api/auth/providers`;
const PROFILE_PATH = `${API_BASE}/api/auth/profile`;
const PROFILE_FRESH_PATH = `${API_BASE}/api/auth/profile/fresh`;
const LOGOUT_PATH = `${API_BASE}/api/auth/logout`;

const ISSUED_MESSAGE = 'If the email is registered, a magic link has been sent';
const INVALID_MESSAGE = 'Invalid magic link';
const EXPIRED_MESSAGE = 'Magic link expired';
/**
 * The uniform redeem-rejection envelope. A superseded/non-matching token yields
 * "Invalid magic link"; a TTL-expired token (cleared on read) yields the distinct
 * "Magic link expired". Both are 400s — a robust black-box assertion tolerates
 * either, since we can't deterministically pin which one a given stale token hits.
 */
const REJECT_MESSAGES = [INVALID_MESSAGE, EXPIRED_MESSAGE];
/** randomBytes(32).toString('hex') → 64 lowercase hex chars; tolerate ≥16. */
const TOKEN_RE = /token=([a-f0-9]{16,})/i;

async function isMagicLinkEnabled(request: APIRequestContext): Promise<boolean> {
    const res = await request.get(PROVIDERS_PATH);
    if (!res.ok()) return false;
    const body = (await res.json()) as { magicLink?: boolean };
    return body.magicLink === true;
}

/**
 * Issue a magic link and assert the anti-enumeration issuance contract.
 * Returns false on a 429 throttle (caller decides whether to skip) — issuance
 * is @Throttle(5/60s) per-IP and this file issues several links per shard.
 */
async function issueMagicLink(request: APIRequestContext, email: string): Promise<boolean> {
    const res = await request.post(ISSUE_PATH, { data: { email } });
    if (res.status() === 429) return false;
    expect(res.status(), `issuance for ${email} should be 200`).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe(ISSUED_MESSAGE);
    // The raw token must NEVER appear in the issuance response body.
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    return true;
}

/**
 * Best-effort: poll MailHog for the most-recent "Sign in" email to `recipient`
 * and pull the magic-link token from its body. Returns null on timeout so
 * callers skip gracefully (SMTP PLAIN delivery is known-flaky in e2e). The
 * subject filter avoids picking up the registration-confirmation email, which
 * shares the recipient.
 */
async function fishMagicToken(
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

/** Register a user, settle+clear the inbox, issue a link and fish its token. */
async function deliverTokenFor(
    request: APIRequestContext,
    label: string,
): Promise<{ email: string; userId: string; token: string; message: MailhogMessage } | null> {
    const u = await registerUserViaAPI(request, { email: makeTestUser(label).email });
    // Let the (fire-and-forget) confirmation email settle so it doesn't land
    // AFTER the clear and pollute the read; then clear so only the link remains.
    await waitForMessageTo(request, u.email, { timeoutMs: 10_000 }).catch(() => null);
    await clearMailhogInbox(request);
    const issued = await issueMagicLink(request, u.email);
    if (!issued) return null; // throttled
    const fished = await fishMagicToken(request, u.email);
    if (!fished) return null; // delivery flake
    return { email: u.email, userId: u.user.id, token: fished.token, message: fished.message };
}

test.describe('flow-magic-link-deep — cross-account, session, race, anon, expiry', () => {
    test.beforeAll(async ({ request }) => {
        if (!(await isMagicLinkEnabled(request))) {
            test.skip(true, 'MAGIC_LINK_ENABLED=false on this build — magic-link disabled');
        }
    });

    /**
     * FLOW 1 — CROSS-ACCOUNT token-leak boundary.
     *
     * Register users A and B, deliver a magic link to EACH, then redeem B's
     * token and prove the minted session is *B*, never A and never the seeded
     * UI user. We walk the bearer through TWO authenticated endpoints (profile +
     * profile/fresh) and pin both id and email, then assert that the same
     * bearer does NOT resolve to A's id — a positive proof of no cross-wiring.
     * Finally, A's still-outstanding token is independent and redeems to A.
     */
    test('a delivered token redeems to its OWN account only (no cross-account leak)', async ({
        request,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog not running — cross-account leak leg needs delivered tokens');
        }

        const a = await deliverTokenFor(request, 'mldeep-leak-a');
        const b = await deliverTokenFor(request, 'mldeep-leak-b');
        if (!a || !b) {
            test.skip(
                true,
                'magic-link delivery unavailable (throttle/SMTP flake) — cross-account leg',
            );
        }

        // Tokens must be distinct per user — a shared token would be the leak.
        expect(a!.token).not.toBe(b!.token);
        expect(a!.userId).not.toBe(b!.userId);

        // Redeem B's token → must be B's session.
        const redeemB = await request.post(REDEEM_PATH, { data: { token: b!.token } });
        expect(redeemB.status(), 'redeem B').toBe(200);
        const sessB = (await redeemB.json()) as {
            access_token?: string;
            user?: { id?: string; email?: string };
        };
        expect(typeof sessB.access_token).toBe('string');
        expect(sessB.user?.id).toBe(b!.userId);
        expect((sessB.user?.email ?? '').toLowerCase()).toBe(b!.email.toLowerCase());
        // The minted identity must NOT be A's.
        expect(sessB.user?.id).not.toBe(a!.userId);

        // PROVE the bearer is genuinely B by walking it through TWO authed
        // endpoints — id+email must match B on both, never A.
        const profB = await request.get(PROFILE_PATH, {
            headers: authedHeaders(sessB.access_token!),
        });
        expect(profB.status()).toBe(200);
        const pbody = (await profB.json()) as { id?: string; email?: string };
        expect(pbody.id ?? (pbody as { user?: { id?: string } }).user?.id).toBe(b!.userId);
        expect(pbody.id).not.toBe(a!.userId);

        const freshB = await request.get(PROFILE_FRESH_PATH, {
            headers: authedHeaders(sessB.access_token!),
        });
        expect(freshB.status()).toBe(200);
        const fbody = (await freshB.json()) as { id?: string; email?: string };
        const freshId = fbody.id ?? (fbody as { user?: { id?: string } }).user?.id;
        expect(freshId).toBe(b!.userId);

        // A's token is untouched by B's redemption — it independently mints A.
        const redeemA = await request.post(REDEEM_PATH, { data: { token: a!.token } });
        expect(redeemA.status(), 'redeem A (independent)').toBe(200);
        const sessA = (await redeemA.json()) as { user?: { id?: string } };
        expect(sessA.user?.id).toBe(a!.userId);
    });

    /**
     * FLOW 2 — A magic-link session is a FIRST-CLASS session.
     *
     * Not just a profile-read stub: the minted bearer must (a) re-fetch via
     * /profile/fresh, (b) be accepted by the logout endpoint (<400), and
     * (c) be INVALIDATED by that logout — a subsequent /profile with the same
     * bearer must no longer resolve to the user. This is the real definition of
     * a usable, revocable session created purely via passwordless sign-in.
     */
    test('magic-link-minted session is first-class and revocable (logout invalidates it)', async ({
        request,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(
                true,
                'MailHog not running — first-class-session leg needs a delivered token',
            );
        }

        const u = await deliverTokenFor(request, 'mldeep-session');
        if (!u) {
            test.skip(true, 'magic-link delivery unavailable (throttle/SMTP flake) — session leg');
        }

        const redeem = await request.post(REDEEM_PATH, { data: { token: u!.token } });
        expect(redeem.status()).toBe(200);
        const sess = (await redeem.json()) as { access_token?: string };
        const bearer = sess.access_token!;
        expect(typeof bearer).toBe('string');

        // (a) The bearer works pre-logout — sanity for the invalidation claim.
        const before = await request.get(PROFILE_PATH, { headers: authedHeaders(bearer) });
        expect(before.status(), 'profile pre-logout').toBe(200);

        // (b) /profile/fresh re-fetch also accepts the magic-link bearer.
        const fresh = await request.get(PROFILE_FRESH_PATH, { headers: authedHeaders(bearer) });
        expect(fresh.status(), 'profile/fresh with magic-link bearer').toBe(200);

        // (c) Logout accepts the bearer (valid session) ...
        const logout = await request.post(LOGOUT_PATH, { headers: authedHeaders(bearer) });
        expect(logout.status(), `logout status ${logout.status()}`).toBeLessThan(400);

        // ... and INVALIDATES it: the same bearer must not still resolve to the
        // user. Either an explicit 401/403, or (stateless build) a 200 whose
        // body is no longer this user's email.
        const after = await request.get(PROFILE_PATH, { headers: authedHeaders(bearer) });
        if (after.status() === 200) {
            const body = (await after.json()) as { email?: string; user?: { email?: string } };
            const seen = (body.email ?? body.user?.email ?? '').toLowerCase();
            expect(seen, 'magic-link bearer still resolves after logout — boundary leak').not.toBe(
                u!.email.toLowerCase(),
            );
        } else {
            expect([401, 403]).toContain(after.status());
        }
    });

    /**
     * FLOW 3 — CONCURRENT redemption race: single-use under contention.
     *
     * Fire N parallel redeems of ONE freshly delivered token. Single-use must
     * hold under a thundering herd, not merely sequentially: AT MOST ONE request
     * gets a 200 (and an access_token), every other gets the uniform 400
     * "Invalid magic link". Asserting "≤1 success" (rather than "exactly 1")
     * tolerates a build that rejects ALL under a race lock — what we forbid is
     * the token being honoured MORE THAN ONCE.
     */
    test('parallel redemptions of one token yield at most one success (no double-spend)', async ({
        request,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog not running — concurrency leg needs a delivered token');
        }

        const u = await deliverTokenFor(request, 'mldeep-race');
        if (!u) {
            test.skip(true, 'magic-link delivery unavailable (throttle/SMTP flake) — race leg');
        }

        const N = 6;
        const results = await Promise.all(
            Array.from({ length: N }, () =>
                request.post(REDEEM_PATH, { data: { token: u!.token } }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const successes = statuses.filter((s) => s === 200);
        const rejections = statuses.filter((s) => s === 400);

        // At most one winner — the token must never be double-spent.
        expect(successes.length, `successes among ${JSON.stringify(statuses)}`).toBeLessThanOrEqual(
            1,
        );
        // Every non-200 must be the uniform invalid-link 400 (no 5xx, no other).
        expect(successes.length + rejections.length).toBe(N);

        // The winner (if any) carries a real session; losers carry the envelope.
        for (const r of results) {
            const body = (await r.json()) as { access_token?: string; message?: string };
            if (r.status() === 200) {
                expect(typeof body.access_token).toBe('string');
            } else {
                expect(REJECT_MESSAGES).toContain(body.message);
            }
        }

        // Post-race, the token is definitively consumed/invalid — a fresh redeem
        // is rejected regardless of who (if anyone) won the race.
        const post = await request.post(REDEEM_PATH, { data: { token: u!.token } });
        expect(post.status(), 'post-race redeem must be rejected').toBe(400);
        expect(REJECT_MESSAGES).toContain(((await post.json()) as { message?: string }).message);
    });

    /**
     * FLOW 4 — Rotation/staleness as a stand-in for EXPIRY.
     *
     * We can't fast-forward the server's 15-minute TTL clock in a black-box e2e,
     * but we CAN drive the equivalent "this token is no longer the live one"
     * rejection deterministically: issue link #1, then issue link #2 for the
     * SAME user (the service overwrites magicLinkToken). #1 is now stale/expired
     * in every meaningful sense and must redeem with the uniform 400; #2 redeems
     * exactly once; replaying #2 is then rejected. This proves redemption is
     * gated on freshness, not mere string existence. A truly time-expired token
     * shares the SAME 400 status but a DISTINCT body ("Magic link expired" vs the
     * "Invalid magic link" a superseded/non-matching token gets — confirmed in
     * the redeemMagicLink service), so we tolerate EITHER message here.
     */
    test('a superseded (stale/expired-equivalent) token is rejected; the live one wins once', async ({
        request,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog not running — rotation/expiry-equivalent leg needs tokens');
        }

        const u = await registerUserViaAPI(request, { email: makeTestUser('mldeep-rotate').email });
        await waitForMessageTo(request, u.email, { timeoutMs: 10_000 }).catch(() => null);
        await clearMailhogInbox(request);

        if (!(await issueMagicLink(request, u.email))) {
            test.skip(true, 'issuance throttled (5/60s) — rotation leg');
        }
        const first = await fishMagicToken(request, u.email);
        if (!first) {
            test.skip(true, 'first magic-link email never arrived — SMTP flake');
        }

        await clearMailhogInbox(request);
        if (!(await issueMagicLink(request, u.email))) {
            test.skip(true, 'issuance throttled (5/60s) on re-issue — rotation leg');
        }
        const second = await fishMagicToken(request, u.email);
        if (!second) {
            test.skip(true, 'second magic-link email never arrived — SMTP flake');
        }

        expect(second!.token).not.toBe(first!.token);

        // The superseded token #1 is dead — uniform rejection 400 (the rotation
        // path clears the prior hash, so this is "Invalid magic link"; we tolerate
        // the expiry variant too for build-independence).
        const stale = await request.post(REDEEM_PATH, { data: { token: first!.token } });
        expect(stale.status(), 'superseded token must be rejected').toBe(400);
        expect(REJECT_MESSAGES).toContain(((await stale.json()) as { message?: string }).message);

        // The live token #2 redeems exactly once with a real opaque session token.
        const good = await request.post(REDEEM_PATH, { data: { token: second!.token } });
        expect(good.status(), 'live token redeems').toBe(200);
        expect(typeof ((await good.json()) as { access_token?: string }).access_token).toBe(
            'string',
        );

        // And is then single-use — the now-consumed token rejects.
        const replay = await request.post(REDEEM_PATH, { data: { token: second!.token } });
        expect(replay.status(), 'live token replay rejected').toBe(400);
        expect(REJECT_MESSAGES).toContain(((await replay.json()) as { message?: string }).message);
    });

    /**
     * FLOW 5 — ANON-CONTEXT redeem independence.
     *
     * The whole point of passwordless sign-in is that the link ALONE
     * authenticates. We redeem from a brand-new APIRequestContext that carries
     * NO inherited storageState cookie (a bare browser.newContext() would
     * inherit the seeded auth cookie — so we build a clean request context),
     * and prove the ONLY thing that authenticates is the returned bearer:
     *   - redeem succeeds with no prior auth,
     *   - the returned bearer resolves /profile to the right user,
     *   - the same anon context WITHOUT the bearer is 401 on /profile
     *     (i.e. there's no ambient cookie quietly doing the work).
     */
    test('redemption authenticates via the link alone (no ambient session needed)', async ({
        request,
        playwright,
        baseURL,
    }) => {
        if (!(await isMailhogAvailable(request))) {
            test.skip(true, 'MailHog not running — anon-context leg needs a delivered token');
        }

        const u = await deliverTokenFor(request, 'mldeep-anon');
        if (!u) {
            test.skip(true, 'magic-link delivery unavailable (throttle/SMTP flake) — anon leg');
        }

        // A fresh, cookie-less request context — nothing inherited.
        const anon = await playwright.request.newContext({
            baseURL: baseURL ?? 'http://localhost:3000',
        });
        try {
            // No bearer, no cookie → /profile must be 401 (no ambient session).
            const cold = await anon.get(PROFILE_PATH);
            expect(cold.status(), 'cold anon /profile must be 401').toBe(401);

            // The link alone authenticates.
            const redeem = await anon.post(REDEEM_PATH, { data: { token: u!.token } });
            expect(redeem.status(), 'anon redeem').toBe(200);
            const sess = (await redeem.json()) as {
                access_token?: string;
                user?: { id?: string };
            };
            expect(typeof sess.access_token).toBe('string');
            expect(sess.user?.id).toBe(u!.userId);

            // The returned bearer (and ONLY it) authenticates the anon context.
            const warm = await anon.get(PROFILE_PATH, {
                headers: authedHeaders(sess.access_token!),
            });
            expect(warm.status(), 'anon /profile with redeemed bearer').toBe(200);
            const wbody = (await warm.json()) as { id?: string; user?: { id?: string } };
            expect(wbody.id ?? wbody.user?.id).toBe(u!.userId);
        } finally {
            await anon.dispose();
        }
    });

    /**
     * FLOW 6 — PROVIDER ↔ ISSUANCE coherence + method/shape hardening.
     *
     * Asserts the advertised capability and the live endpoint AGREE and are
     * hardened, with NO delivered token required (always runs):
     *   - /providers advertises a well-typed `magicLink` boolean alongside
     *     emailPassword:true + socialProviders:string[].
     *   - When advertised true, issuance for a (fresh, registered) user is a
     *     200 with the canonical anti-enumeration message and never leaks a
     *     token; for an UNKNOWN email it's byte-identical (no enumeration tell).
     *   - Issuance is POST-only: a GET to the issuance path is NOT a 200 success
     *     (405/404/401 — never a silent 200 issuing on a GET).
     *   - Redeem rejects the empty/missing-token DTO violations with array
     *     messages and a bogus 64-hex token with the uniform 400 envelope.
     */
    test('provider advertisement and issuance/redeem contract are coherent and hardened', async ({
        request,
    }) => {
        // Provider list shape.
        const prov = await request.get(PROVIDERS_PATH);
        expect(prov.status()).toBe(200);
        const pbody = (await prov.json()) as Record<string, unknown>;
        expect(typeof pbody.magicLink).toBe('boolean');
        expect(typeof pbody.emailPassword).toBe('boolean');
        expect(pbody.emailPassword).toBe(true);
        expect(Array.isArray(pbody.socialProviders)).toBe(true);
        const advertised = pbody.magicLink === true;

        // Issuance for a known + unknown email — anti-enumeration parity.
        const known = await registerUserViaAPI(request, {
            email: makeTestUser('mldeep-coherent').email,
        });
        const unknownEmail = makeTestUser('mldeep-coherent-unknown').email;

        const knownRes = await request.post(ISSUE_PATH, { data: { email: known.email } });
        // Tolerate throttling here too — but if it DOES respond, the contract holds.
        if (knownRes.status() !== 429) {
            expect(knownRes.status(), 'issuance for a registered user').toBe(200);
            const kbody = (await knownRes.json()) as Record<string, unknown>;
            expect(kbody.message).toBe(ISSUED_MESSAGE);
            expect(kbody.token).toBeUndefined();
            // Advertised-true must mean issuance is genuinely mounted (a 200,
            // not a 404 catch-all) — coherence between capability + endpoint.
            if (advertised) {
                expect(knownRes.status()).toBe(200);
            }

            const unknownRes = await request.post(ISSUE_PATH, { data: { email: unknownEmail } });
            if (unknownRes.status() !== 429) {
                const ubody = (await unknownRes.json()) as Record<string, unknown>;
                expect(unknownRes.status()).toBe(knownRes.status());
                expect(ubody.message).toBe(ISSUED_MESSAGE);
                expect(Object.keys(ubody).sort()).toEqual(Object.keys(kbody).sort());
                expect(ubody.token).toBeUndefined();
            }
        }

        // Issuance is POST-only — a GET must NOT silently issue (2xx success).
        const getIssue = await request.get(ISSUE_PATH);
        expect(
            getIssue.status(),
            `GET ${ISSUE_PATH} should not be a 2xx success`,
        ).toBeGreaterThanOrEqual(400);

        // Redeem DTO + bogus-token hardening (no token delivery needed).
        const bogus = 'deadbeef'.repeat(8); // 64 hex chars, well-formed but non-matching
        const bogusRes = await request.post(REDEEM_PATH, { data: { token: bogus } });
        expect(bogusRes.status()).toBe(400);
        const bbody = (await bogusRes.json()) as { message?: string; statusCode?: number };
        expect(bbody.message).toBe(INVALID_MESSAGE);
        expect(bbody.statusCode).toBe(400);

        // Empty token → DTO array message (CONFIRMED live: ["token should not be empty"]).
        const emptyRes = await request.post(REDEEM_PATH, { data: { token: '' } });
        expect(emptyRes.status()).toBe(400);
        const ebody = (await emptyRes.json()) as { message?: unknown };
        expect(Array.isArray(ebody.message)).toBe(true);
        expect((ebody.message as string[]).join(' ')).toMatch(/token should not be empty/i);

        // Missing token → DTO array message (CONFIRMED live:
        // ["token should not be empty","token must be a string"]).
        const missingRes = await request.post(REDEEM_PATH, { data: {} });
        expect(missingRes.status()).toBe(400);
        const mbody = (await missingRes.json()) as { message?: unknown };
        expect(Array.isArray(mbody.message)).toBe(true);
        expect((mbody.message as string[]).join(' ')).toMatch(/token/i);
        expect((mbody.message as string[]).join(' ')).toMatch(/token must be a string/i);

        // A malformed email is a DTO 400 (distinct from the anti-enum 200) — the
        // live envelope is { message:["email must be an email"], ... } (CONFIRMED).
        const badEmail = await request.post(ISSUE_PATH, { data: { email: 'not-an-email' } });
        if (badEmail.status() !== 429) {
            expect(badEmail.status()).toBe(400);
            const bm = (await badEmail.json()) as { message?: unknown };
            expect(Array.isArray(bm.message)).toBe(true);
            expect((bm.message as string[]).join(' ')).toMatch(/email must be an email/i);
        }
    });
});
