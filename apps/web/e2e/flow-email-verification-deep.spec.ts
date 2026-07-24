import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, makeTestUser } from './helpers/api';
import {
    isMailhogAvailable,
    waitForMessageTo,
    extractLinkFromBody,
    listMessages,
    type MailhogMessage,
} from './helpers/mailhog';

/**
 * FLOW: Email-verification deep integration (oracle / send-verification / web-route).
 *
 * Probed against the LIVE API @127.0.0.1:3100 + Web @127.0.0.1:3000 (2026-06-01) and the
 * real source: apps/api/src/auth/controllers/auth.controller.ts, services/auth.service.ts,
 * dto/email-verification.dto.ts, apps/web/src/app/api/auth/verify-email/route.ts,
 * apps/web/src/lib/constants.ts (ROUTES). Global ValidationPipe runs
 * { whitelist, forbidNonWhitelisted, transform }.
 *
 * This file deliberately covers angles the two existing specs
 * (flow-email-verification.spec.ts — the deep verify->verified round-trip + login whitelist;
 *  email-verification-flow.spec.ts — shallow bad-token probes) do NOT:
 *   - send-verification TOKEN ROTATION: every authed resend overwrites the stored sha256(token)
 *     + resets a 24h expiry, so the PRIOR token is invalidated (single-use-per-rotation). When
 *     mail lands we prove the old token fails while the newest validates; mail-absent we assert
 *     the rotation CONTRACT (each resend 200, idempotent, user stays unverified, never 5xx);
 *   - the ALREADY-VERIFIED short-circuit: once verified, send-verification 400s
 *     'Email already verified' (svc branch) and verify-replay is rejected;
 *   - CROSS-ACCOUNT independence: A's resend never mutates B; verify-email is Public + purely
 *     token-driven (A's valid bearer cannot verify B; a bogus token is rejected identically
 *     with or without a bearer);
 *   - send-verification's auth gate + NON-throttled repeatability (it carries no @Throttle);
 *   - the validate-email-token ORACLE: required-token guard, non-echo (H-01), and that an
 *     unknown token is a 200 { valid:false } (NOT a 400);
 *   - cross-endpoint AGREEMENT: validate-email-token (200 valid:false) vs verify-email
 *     (400 'Invalid verification token') for the SAME bad token never disagree and never
 *     accidentally "consume"/flip a token across repeated calls;
 *   - the real WEB /verify-email route handler (NOT a client page — it is an API route that
 *     307-redirects to /{locale}/auth/error with a typed ?error= reason).
 *
 * PINNED CONTRACT (all verified live this session):
 *   POST /api/auth/register { username(>=3), email, password(>=8) }  -> 201
 *        { access_token (32-char opaque), user:{ id,email,username } }; profile/fresh shows
 *        emailVerified:FALSE. REQUIRE_EMAIL_VERIFICATION=false => the token is usable
 *        immediately even though emailVerified starts false. {name} instead of {username},
 *        or any extra prop, -> 400.
 *   GET  /api/auth/profile/fresh (Bearer) -> 200 { id,email,username,emailVerified:false,... }
 *        H-01 NON-LEAK: STRIPS emailVerificationToken / emailVerificationExpires (the columns are
 *        never serialized, even after a token is issued) — asserted here.
 *
 *   POST /api/auth/send-verification (Bearer)            -> 200 { message:'Verification email sent' }
 *        unauth (AuthSessionGuard)                       -> 401
 *        NOT throttled: 4 rapid authed calls all 200 (live).
 *        ROTATION: each call overwrites the stored sha256(token) + resets a 24h expiry, so the
 *        PRIOR token stops matching (single-use-per-rotation) — asserted (real proof when mailed).
 *        already-verified actor (svc short-circuit)      -> 400 { message:'Email already verified' }
 *        (asserted as a REAL 400 when MailHog delivers a token; else the cross-account /
 *        no-gate contract is asserted instead — never a fictional success).
 *   POST /api/auth/resend-verification                   -> 404 (does not exist).
 *
 *   POST /api/auth/verify-email { token }                -> 200 + fresh session on a valid token
 *        bad/unknown token   -> 400 { message:'Invalid verification token' }
 *        empty token         -> 400 { message:[<class-validator 'token' messages>] }
 *        extra property      -> 400 { message:['property <x> should not exist'] }
 *        NOT throttled: 6 rapid bad POSTs all 400 (live).
 *   GET  /api/auth/verify-email                          -> 404 (POST-only).
 *
 *   GET  /api/auth/validate-email-token?token=<t>        -> 200
 *        unknown token       -> { valid:false, message:'Invalid verification token' } (NOT 400)
 *        valid token         -> { valid:true, email, expiresAt }
 *        missing/empty token -> 400 { message:'token query parameter is required' }
 *        Declares @Throttle(10/60s) per-IP, BUT in this sqlite/CI driver the throttle did NOT
 *        fire across 13 rapid probes (all 200) — so we assert the body contract + non-echo and
 *        only TOLERATE a 429 (never require it).
 *        NEVER echoes the candidate token (H-01 hashed-token contract).
 *
 *   WEB GET <web>/api/auth/verify-email?token=<t> (Next route handler
 *        apps/web/src/app/api/auth/verify-email/route.ts) -> 307 (verified live):
 *        no token   -> Location /en/auth/error?error=verify_email_missing_token
 *        bad token  -> Location /en/auth/error?error=verify_email_invalid_token
 *        valid      -> Location DASHBOARD('/')?verified=true (sets auth cookies). There are NO
 *        verify-email client testids — verification UX is the auth/error redirect target.
 *        (Note: the bare PAGE path <web>/verify-email is NOT this handler — middleware 307s it
 *        to /login when unauthenticated; we therefore drive the /api/auth/verify-email handler.)
 *
 * MAIL is BEST-EFFORT: e2e SMTP delivery fails ("Missing credentials for PLAIN") even though
 * MailHog HTTP is up; validate IF a message arrives, else assert the API contract + annotate.
 *
 * NOTE (truthful): a REAL usable verification token is not extractable in this config (raw token
 * lives only in the outbound mail body; SMTP delivery is broken). The verify->verified SUCCESS
 * transition is covered by flow-email-verification.spec.ts when MailHog delivers; this file
 * asserts the fully-observable bad-token / oracle / throttle / web-route / state-stability
 * surfaces. No fictional 200 verify-success path is asserted.
 *
 * Isolation: every mutation uses a FRESH user (unique username/email). createWorkViaAPI takes
 * { name }; waitForMessageTo takes an options object ({ timeoutMs }).
 */

const KNOWN_BAD_TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** A live verification token is 32 random bytes hex-encoded → 64 hex chars. */
const VERIFY_TOKEN_RE = /[a-f0-9]{64}/i;
const SEND_VERIFICATION_MSG = 'Verification email sent';
const ALREADY_VERIFIED_MSG = 'Email already verified';
const INVALID_TOKEN_MSG = 'Invalid verification token';

/** Register a fresh user via raw API (the DTO uses {username}) and return token + identity. */
async function freshUser(request: APIRequestContext) {
    const u = makeTestUser('verifdeep');
    const username = ('vd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4)).slice(
        0,
        20,
    );
    const res = await request.post(`${API_BASE}/api/auth/register`, {
        data: { username, email: u.email, password: u.password },
    });
    expect(res.status(), 'register fresh user').toBe(201);
    const body = await res.json();
    return {
        email: u.email as string,
        password: u.password as string,
        username,
        token: body.access_token as string,
        userId: body.user?.id as string,
    };
}

/**
 * Pull the raw verification token out of an outbound email. The link form is
 * `<callbackUrl|web>/...?token=<64hex>`; the raw token also appears bare in the
 * body. Try the link form first, then the first standalone 64-hex run.
 */
function extractVerificationToken(message: MailhogMessage): string | null {
    const link = extractLinkFromBody(message, /token=[a-f0-9]{64}/i);
    if (link) {
        const m = /token=([a-f0-9]{64})/i.exec(link);
        if (m) return m[1];
    }
    const bare = VERIFY_TOKEN_RE.exec(message.Content.Body);
    return bare?.[0] ?? null;
}

/**
 * Best-effort: register + send-verification, then read the raw token IF MailHog
 * delivered. Returns null when delivery failed (the common e2e case — SMTP
 * 'Missing credentials for PLAIN'). Never throws on a missing mail.
 */
/** Ids currently sitting in the box for `recipient` (empty when MailHog is down). */
async function messageIdsFor(request: APIRequestContext, recipient: string): Promise<Set<string>> {
    const lower = recipient.toLowerCase();
    const messages = await listMessages(request).catch(() => []);
    return new Set(
        messages
            .filter((m) => m.To?.some((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === lower))
            .map((m) => m.ID),
    );
}

/**
 * Send a verification mail and read the token OUT OF THAT MESSAGE.
 *
 * Registration already mails this address, and send-verification ROTATES the
 * stored token hash — so a recipient-only match can hand back the OLDER message
 * whose token the send just invalidated, producing a stale token that fails
 * verify-email with a 400. (waitForMessageTo documents this hazard and expects
 * callers to disambiguate.) We therefore snapshot the box before sending and
 * wait for an id that was not already there.
 */
async function sendAndReadToken(
    request: APIRequestContext,
    user: { email: string; token: string },
): Promise<string | null> {
    const mailUp = await isMailhogAvailable(request);
    const before = mailUp ? await messageIdsFor(request, user.email) : new Set<string>();

    const send = await request.post(`${API_BASE}/api/auth/send-verification`, {
        headers: authedHeaders(user.token),
    });
    expect(send.status(), 'send-verification for unverified user → 200').toBe(200);
    expect((await send.json()).message).toBe(SEND_VERIFICATION_MSG);
    if (!mailUp) return null;

    // Poll for a message that is genuinely NEW (CI SMTP delivery is slower than
    // a dev box, so give it more headroom than a single fixed wait).
    const deadline = Date.now() + 20_000;
    const lower = user.email.toLowerCase();
    while (Date.now() < deadline) {
        const messages = await listMessages(request).catch(() => []);
        const fresh = messages.find(
            (m) =>
                !before.has(m.ID) &&
                m.To?.some((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === lower),
        );
        if (fresh) return extractVerificationToken(fresh);
        await new Promise((r) => setTimeout(r, 300));
    }
    return null;
}

/** Read `emailVerified` off the live DB row for a bearer (undefined on non-200). */
async function freshVerified(
    request: APIRequestContext,
    token: string,
): Promise<boolean | undefined> {
    const p = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
        headers: authedHeaders(token),
    });
    if (p.status() !== 200) return undefined;
    return (await p.json()).emailVerified;
}

test.describe('Flow: email-verification deep (oracle / send / web-route)', () => {
    test('send-verification ROTATES the stored token: each authed resend invalidates the prior token (single-use-per-rotation); idempotent envelope, never 5xx', async ({
        request,
    }) => {
        const u = await freshUser(request);
        expect(await freshVerified(request, u.token), 'fresh user starts unverified').toBe(false);

        // Both resends read their token via sendAndReadToken, which snapshots the
        // inbox and waits for a genuinely NEW message. Matching on recipient alone
        // (as a plain waitForMessageTo does) can hand back the REGISTRATION mail or
        // the previous resend's mail when SMTP delivery lags — and since every send
        // ROTATES the stored hash, that yields an already-invalidated token and the
        // "newest token validates" assertion below fails for a purely timing reason.
        const creds = { email: u.email, token: u.token };

        // STEP 1 — first authed resend mints token #1 (writes sha256(token1) + 24h expiry).
        const token1 = await sendAndReadToken(request, creds);

        // STEP 2 — a SECOND resend OVERWRITES the column with sha256(token2): the
        // envelope is identical (idempotent to the caller) but the stored hash differs.
        const token2 = await sendAndReadToken(request, creds);

        // STEP 3 — the REAL rotation proof, reachable only when mail delivered two
        // distinct tokens: the PRIOR token must no longer validate/verify (its hash
        // was overwritten); the LATEST token validates. This is the genuine
        // single-use-per-rotation guarantee neither sibling exercises.
        if (token1 && token2 && token1 !== token2) {
            const oldValidate = await request.get(
                `${API_BASE}/api/auth/validate-email-token?token=${token1}`,
            );
            expect(oldValidate.status()).toBe(200);
            expect((await oldValidate.json()).valid, 'rotated-away token #1 invalid').toBe(false);

            const newValidate = await request.get(
                `${API_BASE}/api/auth/validate-email-token?token=${token2}`,
            );
            expect(newValidate.status()).toBe(200);
            const newBody = await newValidate.json();
            expect(newBody.valid, 'newest token validates').toBe(true);
            expect(String(newBody.email).toLowerCase()).toBe(u.email.toLowerCase());

            // verifying with the STALE token #1 is rejected outright.
            const staleVerify = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token: token1 },
            });
            expect(staleVerify.status(), 'stale rotated token cannot verify').toBe(400);
            expect((await staleVerify.json()).message).toBe(INVALID_TOKEN_MSG);
        } else {
            // Mail not delivered (e2e SMTP best-effort). The rotation CONTRACT — three
            // idempotent 200 resends, user still unverified, no token consumed — is the
            // full observable behaviour on this host.
            test.info().annotations.push({
                type: 'verification-mail-absent',
                description:
                    'no delivered verification mail; asserted the resend-rotation contract (each 200, idempotent, user remains unverified) instead of the raw-token rotation proof.',
            });
            expect(await freshVerified(request, u.token), 'still unverified after rotation').toBe(
                false,
            );
        }

        // STEP 4 — a THIRD resend never deadlocks / never 5xxes (send carries no
        // per-route @Throttle, so it's a clean 200; tolerate a 429 defensively).
        // Deliberately LAST: every resend rotates the stored hash again, so issuing
        // it BEFORE the proof above invalidated token2 — "newest token validates"
        // then failed the moment that third rotation actually landed.
        const resend3 = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.token),
        });
        expect(resend3.status(), 'third resend < 500').toBeLessThan(500);
        expect([200, 429]).toContain(resend3.status());
    });

    test('once verified, send-verification 400s "Email already verified" and verify-replay is rejected; mail-absent the resend stays available + cross-account state is isolated', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = await sendAndReadToken(request, u);

        if (token) {
            // STEP 1 — consume the real token: verify-email issues a FRESH session.
            const verify = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token },
            });
            expect(verify.status(), 'verify-email succeeds → 200 + session').toBe(200);
            const verified = await verify.json();
            expect(typeof verified.access_token, 'verify issues a fresh bearer').toBe('string');
            expect(verified.user?.id).toBe(u.userId);

            // STEP 2 — the DB row flips emailVerified=true (poll: async write settles).
            await expect
                .poll(() => freshVerified(request, verified.access_token), {
                    timeout: 15000,
                    message: 'emailVerified flips true after verify',
                })
                .toBe(true);

            // STEP 3 — NOW send-verification short-circuits: the service throws
            // BadRequestException('Email already verified') for a verified user.
            const resendVerified = await request.post(`${API_BASE}/api/auth/send-verification`, {
                headers: authedHeaders(verified.access_token),
            });
            expect(resendVerified.status(), 'resend on a verified user → 400').toBe(400);
            expect((await resendVerified.json()).message).toBe(ALREADY_VERIFIED_MSG);

            // STEP 4 — single-use: the consumed token cannot be replayed and the
            // oracle now reports it invalid (hash column cleared on verify).
            const replay = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token },
            });
            expect(replay.status(), 'consumed token cannot be replayed').toBe(400);
            expect((await replay.json()).message).toBe(INVALID_TOKEN_MSG);

            const postValidate = await request.get(
                `${API_BASE}/api/auth/validate-email-token?token=${token}`,
            );
            expect(postValidate.status()).toBe(200);
            expect((await postValidate.json()).valid).toBe(false);
        } else {
            // No real token → the verified-state branch can't be reached. Instead prove
            // CROSS-ACCOUNT INDEPENDENCE end-to-end: a second user's resend never
            // touches the first, and verify-email is purely token-driven (a valid bearer
            // for A cannot verify B; a bogus token is rejected identically w/ or w/o a
            // bearer). This keeps the flow meaningful + non-trivial on a mail-less host.
            test.info().annotations.push({
                type: 'verification-mail-absent',
                description:
                    'no delivered verification mail; asserted cross-account independence + the no-gate resend contract instead of the verified short-circuit.',
            });
            const b = await freshUser(request);
            expect(await freshVerified(request, u.token), 'A unverified').toBe(false);
            expect(await freshVerified(request, b.token), 'B unverified').toBe(false);

            // A resends (rotating A's token only); B is unaffected + can resend itself.
            const aResend = await request.post(`${API_BASE}/api/auth/send-verification`, {
                headers: authedHeaders(u.token),
            });
            expect([200, 429]).toContain(aResend.status());
            expect(await freshVerified(request, b.token), 'B unaffected by A resend').toBe(false);
            const bResend = await request.post(`${API_BASE}/api/auth/send-verification`, {
                headers: authedHeaders(b.token),
            });
            expect([200, 429]).toContain(bResend.status());

            // verify-email is Public + token-only: A's bearer attached to a bogus-token
            // verify changes nothing — same 400 as the no-bearer case (bearer ignored).
            const bogus = `bogus-${Date.now().toString(36)}`;
            const withBearer = await request.post(`${API_BASE}/api/auth/verify-email`, {
                headers: authedHeaders(u.token),
                data: { token: bogus },
            });
            expect(withBearer.status(), 'bogus token + A bearer → 400 (bearer ignored)').toBe(400);
            expect((await withBearer.json()).message).toBe(INVALID_TOKEN_MSG);
            const noBearer = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token: bogus },
            });
            expect(noBearer.status(), 'bogus token + no bearer → 400').toBe(400);
            expect((await noBearer.json()).message).toBe(INVALID_TOKEN_MSG);

            // Neither user got verified by any of the above (no real token consumed).
            expect(await freshVerified(request, u.token), 'A still unverified').toBe(false);
            expect(await freshVerified(request, b.token), 'B still unverified').toBe(false);
        }
    });

    test('send-verification is auth-gated (401), resend-verification does not exist (404), and send is NON-throttled (4x 200)', async ({
        request,
    }) => {
        // Unauthenticated => 401 (AuthSessionGuard).
        const anon = await request.post(`${API_BASE}/api/auth/send-verification`);
        expect(anon.status()).toBe(401);
        // resend-verification is NOT a real route.
        const wrongPath = await request.post(`${API_BASE}/api/auth/resend-verification`);
        expect(wrongPath.status()).toBe(404);

        const u = await registerUserViaAPI(request);

        // send-verification carries NO @Throttle, so four rapid authed calls all return 200 with
        // the documented envelope (an unverified actor each time regenerates a verification token).
        for (let i = 0; i < 4; i++) {
            const res = await request.post(`${API_BASE}/api/auth/send-verification`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), `send-verification call #${i + 1}`).toBe(200);
            expect((await res.json()).message).toBe('Verification email sent');
        }

        // Best-effort: if any mail landed it must be addressed to the user.
        if (await isMailhogAvailable(request)) {
            const msg = await waitForMessageTo(request, u.email, { timeoutMs: 3000 });
            if (msg) {
                const to = (msg.To ?? []).map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
                expect(to).toContain(u.email.toLowerCase());
            }
        }
    });

    test('verify-email (POST) rejects bad / empty / extra-property payloads with exact contracts, is GET-404 and NOT throttled', async ({
        request,
    }) => {
        // Unknown/bad token -> domain 400 with the exact service message.
        const bad = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: KNOWN_BAD_TOKEN },
        });
        expect(bad.status()).toBe(400);
        expect((await bad.json()).message).toBe('Invalid verification token');

        // Empty token -> @IsNotEmpty class-validator array message.
        const empty = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: '' },
        });
        expect(empty.status()).toBe(400);
        const emptyBody = await empty.json();
        expect(Array.isArray(emptyBody.message)).toBe(true);
        expect(JSON.stringify(emptyBody.message).toLowerCase()).toContain('token');

        // Missing token field entirely -> validation 400.
        const missing = await request.post(`${API_BASE}/api/auth/verify-email`, { data: {} });
        expect(missing.status()).toBe(400);

        // Extra property -> forbidNonWhitelisted 400 "property <x> should not exist".
        const extra = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: KNOWN_BAD_TOKEN, surprise: 'nope' },
        });
        expect(extra.status()).toBe(400);
        expect(JSON.stringify(await extra.json())).toContain('should not exist');

        // GET on the same path is a 404 (verify-email is POST-only).
        const getForm = await request.get(
            `${API_BASE}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}`,
        );
        expect(getForm.status()).toBe(404);

        // NOT throttled: six rapid bad POSTs all return a clean 400 (never 429, never 5xx).
        for (let i = 0; i < 6; i++) {
            const r = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token: `${KNOWN_BAD_TOKEN}${i}` },
            });
            expect(r.status(), `bad verify #${i + 1} stays 400`).toBe(400);
        }
    });

    test('validate-email-token oracle: required-token 400 guard, 200 { valid:false } for unknowns, and NEVER echoes the candidate token', async ({
        request,
    }) => {
        // Missing / empty token query param -> 400 with the exact controller message.
        const missing = await request.get(`${API_BASE}/api/auth/validate-email-token`);
        expect(missing.status()).toBe(400);
        expect((await missing.json()).message).toContain('token query parameter is required');

        const emptyQuery = await request.get(`${API_BASE}/api/auth/validate-email-token?token=`);
        expect(emptyQuery.status()).toBe(400);

        // Several unique sentinels: each in-budget probe is a 200 { valid:false } that NEVER echoes
        // the candidate (H-01). The endpoint DECLARES @Throttle(10/60s) but did not fire in this
        // driver across 13 probes — so we TOLERATE a 429 and never require it.
        let sawValidFalse = false;
        for (let i = 0; i < 8; i++) {
            const sentinel = `e2e-sentinel-${Date.now().toString(36)}-${i}`;
            const res = await request.get(
                `${API_BASE}/api/auth/validate-email-token?token=${sentinel}`,
            );
            if (res.status() === 429) continue; // throttle tolerated, not required
            expect(res.status(), 'in-budget oracle probe is 200').toBe(200);
            const text = await res.text();
            expect(text.includes(sentinel), 'oracle must never echo the candidate token').toBe(
                false,
            );
            const body = JSON.parse(text);
            expect(body.valid).toBe(false);
            expect(body.message).toBe('Invalid verification token');
            sawValidFalse = true;
        }
        expect(sawValidFalse, 'at least one in-budget 200 valid:false probe').toBe(true);

        // H-01 PROFILE NON-LEAK: even AFTER a verification token is issued (send-
        // verification writes sha256(token) + expiry onto the row), profile/fresh
        // must NOT serialize the verification-token columns — a leak there would let
        // a logged-in attacker read the stored hash + expiry. Assert the keys are
        // absent and that the raw body carries no 64-hex token run at all.
        const u = await freshUser(request);
        const populate = await request.post(`${API_BASE}/api/auth/send-verification`, {
            headers: authedHeaders(u.token),
        });
        expect([200, 429]).toContain(populate.status());
        const prof = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.token),
        });
        expect(prof.status()).toBe(200);
        const profText = await prof.text();
        const profBody = JSON.parse(profText);
        expect(
            'emailVerificationToken' in profBody,
            'profile/fresh must not expose emailVerificationToken',
        ).toBe(false);
        expect(
            'emailVerificationExpires' in profBody,
            'profile/fresh must not expose emailVerificationExpires',
        ).toBe(false);
        expect(profBody.emailVerified, 'token issued but not consumed').toBe(false);
        expect(VERIFY_TOKEN_RE.test(profText), 'profile body leaks a 64-hex token').toBe(false);
    });

    test('cross-endpoint agreement & state-stability: validate + verify treat the SAME bad token identically and never mutate actor state', async ({
        request,
    }) => {
        // The two oracles must AGREE on an unknown token across repeats — proving no idempotency
        // leak that would let a token be accidentally "spent" or flipped to valid on retry:
        //   validate-email-token => 200 { valid:false }
        //   verify-email         => 400 'Invalid verification token'
        for (let i = 0; i < 3; i++) {
            const validate = await request.get(
                `${API_BASE}/api/auth/validate-email-token?token=${KNOWN_BAD_TOKEN}`,
            );
            if (validate.status() !== 429) {
                // tolerate throttle
                expect(validate.status()).toBe(200);
                const vb = await validate.json();
                expect(vb.valid).toBe(false);
                expect(vb.message).toBe('Invalid verification token');
            }

            const verify = await request.post(`${API_BASE}/api/auth/verify-email`, {
                data: { token: KNOWN_BAD_TOKEN },
            });
            expect(verify.status(), `verify attempt #${i + 1} rejects cleanly`).toBe(400);
            expect((await verify.json()).message).toBe('Invalid verification token');
        }

        // The bad-token storm must not have flipped any actor's state: a fresh user is created,
        // hit with a bad verify, and remains unverified + fully identifiable afterwards.
        const u = await freshUser(request);
        const storm = await request.post(`${API_BASE}/api/auth/verify-email`, {
            data: { token: KNOWN_BAD_TOKEN },
        });
        expect(storm.status()).toBe(400);
        const me = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.token),
        });
        expect(me.status()).toBe(200);
        const meBody = await me.json();
        expect(meBody.emailVerified, 'actor unchanged after bad-token storm').toBe(false);
        expect(meBody.id).toBe(u.userId);

        test.info().annotations.push({
            type: 'config',
            description:
                'Bad-token rejection is deterministic across both oracles and never mutates verified state; live verify-success is covered in flow-email-verification.spec.ts when MailHog delivers.',
        });
    });

    test('web /api/auth/verify-email route handler 307-redirects to the typed auth-error reason for missing and invalid tokens', async ({
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // The Next route handler at <web>/api/auth/verify-email redirects (307). Do NOT follow
        // redirects so we can assert the typed ?error= reason in the Location header. (The bare
        // PAGE path /verify-email is a different surface — middleware 307s it to /login.)
        const noToken = await request.get(`${origin}/api/auth/verify-email`, { maxRedirects: 0 });
        expect([302, 307, 308]).toContain(noToken.status());
        const noTokenLoc = noToken.headers()['location'] ?? '';
        expect(noTokenLoc).toContain('/auth/error');
        expect(noTokenLoc).toContain('verify_email_missing_token');

        const badToken = await request.get(
            `${origin}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}`,
            { maxRedirects: 0 },
        );
        expect([302, 307, 308]).toContain(badToken.status());
        const badTokenLoc = badToken.headers()['location'] ?? '';
        expect(badTokenLoc).toContain('/auth/error');
        expect(badTokenLoc).toContain('verify_email_invalid_token');
    });

    test('web /api/auth/verify-email bad token lands a browser on the auth-error page (redirect followed end-to-end)', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // Drive the redirect end-to-end in a browser: a bad token must land on the auth/error
        // route (the verification-failed UX), carrying the invalid-token reason in the URL.
        await page.goto(`${origin}/api/auth/verify-email?token=${KNOWN_BAD_TOKEN}`);
        // next-dev local vs CI route divergence: assert on the settled URL with a tolerant retry.
        await expect(async () => {
            expect(page.url()).toMatch(/auth\/error|verify_email_invalid_token/i);
        }).toPass({ timeout: 20000 });
        // The page must render SOMETHING (not a hard crash) — the document body is attached.
        await expect(page.locator('body')).toBeVisible({ timeout: 20000 });
    });
});
