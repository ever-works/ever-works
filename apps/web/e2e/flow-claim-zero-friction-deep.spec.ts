import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Claim + zero-friction — DEEP cross-feature integration flows.
 *
 * The platform ships TWO independent "claim" surfaces (the zero-friction
 * account-claim and the tokenised work-invitation claim). `claim-flow.spec.ts`,
 * `zero-friction-flow.spec.ts`, and the breadth-first `flow-claim-zero-friction.spec.ts`
 * already pin the happy paths and the basic isolation matrix. THIS suite goes
 * deeper on the *state-machine* edges those leave uncovered:
 *
 *   - the anon SESSION TOKEN'S lifecycle ACROSS the claim (it stays valid, but
 *     the claim becomes a one-shot — a re-claim on the same token is forbidden),
 *   - the claim-account INPUT-VALIDATION gate firing BEFORE any binding (no
 *     partial mutation of the anon row),
 *   - the anonymous DTO contract + TTL window + distinct-identity guarantee,
 *   - zero-friction work survival AND third-party isolation through the claim,
 *   - the work-invitation NEGATIVE matrix (owner-claims-own-work, double
 *     membership, member-invite-missing-email, expiresInDays DTO bounds, bad
 *     role),
 *   - the owner-claim identity gate + transfer-state machine.
 *
 * Every shape/status/message below was confirmed against the LIVE stack
 * (sqlite in-memory — the same driver CI uses) before assertions were written:
 *
 *   POST /api/auth/anonymous → 201 { access_token, user:{ id, email:null,
 *        username:/^anon-[0-9a-f]{8}$/, isAnonymous:true, anonymousExpiresAt } };
 *        ANONYMOUS_USER_TTL_DAYS default 3 (expiry is ~3 days out, never past).
 *        CreateAnonymousDto: correlationId must be a UUID v4 (non-UUID → 400
 *        'correlationId must be a UUID'); unknown keys → 400
 *        'property <x> should not exist' (forbidNonWhitelisted). @Throttle 5/hr/IP.
 *   POST /api/auth/claim (anon bearer) → 200 { id (UNCHANGED), email, username,
 *        emailVerified:false }; registrationProvider flips to 'local',
 *        anonymousExpiresAt cleared. The SAME anon bearer keeps working after the
 *        claim (profile/fresh shows isAnonymous:false). A SECOND claim on that now
 *        non-anon token → 403 'claim is only valid for anonymous (zero-friction)
 *        accounts'. ClaimAccountDto gate (all 400 BEFORE binding):
 *          - password failing /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/ → 400,
 *          - malformed email → 400, username < 3 chars → 400.
 *        Reused email by ANOTHER anon → 409.
 *   POST /api/auth/login DTO is { email, password } ONLY; claimed creds → 200
 *        (login.user.id === anon.id); wrong password → 401.
 *   POST /api/works (anon bearer) → owns a real Work (work.userId === anon.id),
 *        INVISIBLE to other users (their /api/works list omits it; GET by id → 403).
 *   POST /api/works/:id/invitations → 201 InvitationResponseDto, raw 64-hex token
 *        ONCE inside claimUrl. CreateInvitationDto: member roles REQUIRE email
 *        (400 'email is required for member-role invitations'); expiresInDays is
 *        @Min(1)@Max(90) (0/91 → 400 array message); role @IsIn(manager|editor|
 *        viewer|owner-claim) (else 400); owner-claim w/o expectedProviderUsername
 *        → 400 'owner-claim invitations require expectedProviderUsername'.
 *   POST /api/claim/accept → owner accepting own work → 400 'claimant_is_already_owner';
 *        re-accept by an existing member of the same work → 400 'already_a_member';
 *        member accept → 200 { transferStatus:'not_required' }; owner-claim accept
 *        by a non-matching provider login → 403 'claimant_provider_identity_mismatch'.
 *   GET /api/claim/preview?token= → 200 { workName, role, expiresAt,
 *        expectedProviderUsername (set for owner-claim), sourceUrl }.
 *   GET /api/works/:id/members → { status:'success', members:[…{userId,role}],
 *        owner:{ id, username, email } }.
 *
 * Isolation: every flow uses FRESH anon/registered users + fresh Works — never
 * the shared seeded storageState user — so the in-memory DB stays clean for
 * sibling specs. Assertions tolerate pre-existing rows (toContain / not-toContain
 * by unique slug, never exact counts). All assertions are API-driven (no UI),
 * so no auth-cookie/route divergence applies here.
 */

const ANON_USERNAME_RE = /^anon-[0-9a-f]{8}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

function uniqueSuffix(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface AnonSession {
    access_token: string;
    user: { id: string; username: string; isAnonymous: boolean; anonymousExpiresAt: string };
}

/** Mint a fresh zero-friction (anonymous) session. Tolerates the 5/hr throttle. */
async function createAnonymousSession(request: APIRequestContext): Promise<AnonSession> {
    const res = await request.post(`${API_BASE}/api/auth/anonymous`);
    if (res.status() === 429) {
        test.skip(true, 'anonymous create throttled (5/hr/IP) — skipping this run');
    }
    expect(res.status(), `anonymous session should be 201 (${await res.text()})`).toBe(201);
    return res.json();
}

/** Read the fresh server-side profile for a bearer token. */
async function profileFresh(
    request: APIRequestContext,
    token: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
        headers: authedHeaders(token),
    });
    expect(res.ok(), `profile/fresh should be readable (${res.status()})`).toBeTruthy();
    return res.json();
}

/** Pull the single-use claim token out of an invitation create response. */
function tokenFromInvitation(body: unknown): string {
    const claimUrl = (body as { claimUrl?: string })?.claimUrl ?? '';
    const match = String(claimUrl).match(/\/claim\/([^/?#]+)/);
    return match?.[1] ?? '';
}

/** Owner issues an invitation and returns the raw single-use token + body. */
async function issueInvitation(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    payload: Record<string, unknown>,
): Promise<{ token: string; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(ownerToken),
        data: payload,
    });
    expect(res.status(), `issue invitation should be 201 (${await res.text()})`).toBe(201);
    const body = await res.json();
    return { token: tokenFromInvitation(body), body };
}

test.describe('Claim + zero-friction (deep)', () => {
    test('anon SESSION TOKEN survives the claim, but the claim itself is one-shot', async ({
        request,
    }) => {
        // 1. Zero-friction: a throwaway anon session owns a real Work.
        const anon = await createAnonymousSession(request);
        expect(anon.user.username).toMatch(ANON_USERNAME_RE);
        expect(anon.user.isAnonymous).toBe(true);
        const slug = `zf-survive-${uniqueSuffix()}`;
        const { id: workId } = await createWorkViaAPI(request, anon.access_token, {
            name: 'Token-Survival Work',
            slug,
            description: 'Owned by an anon session whose token must survive the claim.',
        });
        expect(workId).toBeTruthy();

        // 2. Claim the account on that same bearer (no username override → keeps
        //    the anon username). 200, id unchanged.
        const email = `survive-${uniqueSuffix()}@test.local`;
        const password = 'SurvivePass1!';
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email, password },
        });
        expect(claimRes.status(), `claim should be 200 (${await claimRes.text()})`).toBe(200);
        const claimed = await claimRes.json();
        expect(claimed.id).toBe(anon.user.id);
        expect(claimed.email).toBe(email);
        // No override → username stays the anon username (default-to-current).
        expect(claimed.username).toBe(anon.user.username);
        expect(claimed.emailVerified).toBe(false);

        // 3. The ORIGINAL anon bearer is STILL VALID — the user stays signed in —
        //    but the profile has flipped out of anonymous mode on that same token.
        const after = await profileFresh(request, anon.access_token);
        expect(after.id).toBe(anon.user.id);
        expect(after.isAnonymous).toBe(false);
        expect(after.email).toBe(email);
        expect(after.registrationProvider).toBe('local');
        expect(after.anonymousExpiresAt, 'TTL cleared on claim').toBeNull();

        // 4. The Work is still reachable under the SAME (now-credentialed) token —
        //    ownership never moved (binds by userId, which is unchanged).
        const listRes = await request.get(`${API_BASE}/api/works?limit=100`, {
            headers: authedHeaders(anon.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const list = await listRes.json();
        expect((list.works ?? []).map((w: { slug: string }) => w.slug)).toContain(slug);

        // 5. The claim is ONE-SHOT: a SECOND claim on that now non-anon token is
        //    forbidden by the controller-level anonymous-only guard.
        const reClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email: `again-${uniqueSuffix()}@test.local`, password: 'AnotherPass1!' },
        });
        expect(reClaim.status(), 're-claim on a claimed token → 403').toBe(403);
        expect(String((await reClaim.json()).message)).toMatch(/anonymous/i);

        // 6. The credentials really transferred: login with them resolves to the
        //    SAME user id, and a WRONG password is rejected with 401.
        const loginOk = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });
        expect(loginOk.status(), `login with claimed creds (${await loginOk.text()})`).toBe(200);
        expect((await loginOk.json()).user.id).toBe(anon.user.id);

        const loginBad = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password: 'TotallyWrong9!' },
        });
        expect(loginBad.status(), 'wrong password → 401').toBe(401);
    });

    test('claim-account INPUT GATE rejects bad input BEFORE binding (no partial mutation)', async ({
        request,
    }) => {
        // A fresh anon session — we will hammer it with invalid claim payloads and
        // then prove it is STILL anonymous + still claimable. The DTO/validation
        // gate must fire before any row mutation.
        const anon = await createAnonymousSession(request);
        const baseEmail = `gate-${uniqueSuffix()}@test.local`;

        // A) Password failing the policy /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/ — here a
        //    pure-lowercase string with no number/special — is rejected at the DTO.
        const weakPw = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email: baseEmail, password: 'alllowercaseonly' },
        });
        expect(weakPw.status(), 'weak password → 400').toBe(400);

        // B) Malformed email is rejected by @IsEmail at the DTO.
        const badEmail = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email: 'definitely-not-an-email', password: 'GoodPass1!' },
        });
        expect(badEmail.status(), 'malformed email → 400').toBe(400);

        // C) Username override under 3 chars is rejected.
        const shortName = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email: baseEmail, password: 'GoodPass1!', username: 'ab' },
        });
        expect(shortName.status(), 'too-short username → 400').toBe(400);

        // D) After all three rejections the account is UNTOUCHED: still anonymous,
        //    still email-less — proof nothing was partially written.
        const stillAnon = await profileFresh(request, anon.access_token);
        expect(stillAnon.id).toBe(anon.user.id);
        expect(stillAnon.isAnonymous, 'rejected claims leave the account anonymous').toBe(true);
        expect(stillAnon.email).toBeNull();
        expect(stillAnon.registrationProvider).toBe('anonymous');

        // E) ...and a VALID payload still succeeds — the gate only blocked bad input,
        //    it did not consume the one-shot claim.
        const validUsername = `gateok${uniqueSuffix().slice(0, 8)}`;
        const good = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email: baseEmail, password: 'GoodPass1!', username: validUsername },
        });
        expect(good.status(), `valid claim after rejections → 200 (${await good.text()})`).toBe(
            200,
        );
        const claimed = await good.json();
        expect(claimed.id).toBe(anon.user.id);
        expect(claimed.email).toBe(baseEmail);
        expect(claimed.username).toBe(validUsername);
    });

    test('anonymous DTO contract + TTL window + distinct-identity guarantee', async ({
        request,
    }) => {
        // A) Non-UUID correlationId is rejected by CreateAnonymousDto (@IsUUID('4')).
        const badCorr = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { correlationId: 'not-a-real-uuid' },
        });
        // Tolerate the throttle; otherwise it MUST be the DTO rejection.
        if (badCorr.status() !== 429) {
            expect(badCorr.status(), 'non-UUID correlationId → 400').toBe(400);
            expect(String((await badCorr.json()).message)).toMatch(/correlationId must be a UUID/i);
        }

        // B) Unknown keys are rejected (global ValidationPipe forbidNonWhitelisted).
        const extraKey = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { bogusField: 'x' },
        });
        if (extraKey.status() !== 429) {
            expect(extraKey.status(), 'unknown key → 400').toBe(400);
            expect(String((await extraKey.json()).message)).toMatch(/should not exist/i);
        }

        // C) A clean create succeeds and the TTL window is a real FUTURE timestamp
        //    inside a sane bound (default ANONYMOUS_USER_TTL_DAYS=3; allow slack up
        //    to 8 days in case an operator widened it). Never in the past.
        const anon = await createAnonymousSession(request);
        expect(anon.access_token, 'token is opaque (never assert a fixed length)').toBeTruthy();
        expect(anon.user.isAnonymous).toBe(true);
        expect(anon.user.username).toMatch(ANON_USERNAME_RE);
        const ttlMs = new Date(anon.user.anonymousExpiresAt).getTime() - Date.now();
        expect(ttlMs, 'anonymous TTL is in the future').toBeGreaterThan(0);
        expect(ttlMs, 'anonymous TTL is within a sane upper bound').toBeLessThan(
            8 * 24 * 60 * 60 * 1000,
        );

        // D) A SECOND anon create mints a DISTINCT identity (id + username differ) —
        //    there is no shared/recycled anonymous singleton.
        const anon2 = await createAnonymousSession(request);
        expect(anon2.user.id).not.toBe(anon.user.id);
        expect(anon2.user.username).not.toBe(anon.user.username);
        expect(anon2.access_token).not.toBe(anon.access_token);

        // E) The two anon sessions resolve to their OWN profiles under their OWN
        //    bearers — no cross-talk.
        const p1 = await profileFresh(request, anon.access_token);
        const p2 = await profileFresh(request, anon2.access_token);
        expect(p1.id).toBe(anon.user.id);
        expect(p2.id).toBe(anon2.user.id);
    });

    test('zero-friction Work is isolated from third parties, then survives the claim', async ({
        request,
    }) => {
        // 1. Anon owns a Work.
        const anon = await createAnonymousSession(request);
        const slug = `zf-iso-${uniqueSuffix()}`;
        const { id: workId } = await createWorkViaAPI(request, anon.access_token, {
            name: 'Isolated Zero-Friction Work',
            slug,
            description: 'Created anonymously; must stay invisible to other users.',
        });
        expect(workId).toBeTruthy();

        // 2. A DIFFERENT, fully-registered user CANNOT see the anon work in their
        //    own list, and a direct GET by id is forbidden — ownership-scoped.
        const stranger = await registerUserViaAPI(request);
        const strangerList = await request.get(`${API_BASE}/api/works?limit=100`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerList.ok()).toBeTruthy();
        const strangerSlugs = ((await strangerList.json()).works ?? []).map(
            (w: { slug: string }) => w.slug,
        );
        expect(strangerSlugs, 'stranger never sees the anon-owned work').not.toContain(slug);

        const strangerGet = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status(), 'stranger GET by id is forbidden').toBe(403);

        // 3. The anon owner claims the account — the Work carries over by userId.
        const email = `zf-iso-${uniqueSuffix()}@test.local`;
        const password = 'IsoClaim1!';
        const claim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email, password },
        });
        expect(claim.status(), `claim → 200 (${await claim.text()})`).toBe(200);

        // 4. Post-claim, the now-credentialed owner (fresh login token) still owns
        //    the Work — and the stranger is STILL locked out.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });
        expect(login.status()).toBe(200);
        const ownerToken = (await login.json()).access_token;
        const ownerList = await request.get(`${API_BASE}/api/works?limit=100`, {
            headers: authedHeaders(ownerToken),
        });
        const found = ((await ownerList.json()).works ?? []).find(
            (w: { slug: string }) => w.slug === slug,
        );
        expect(found, 'claimed owner still owns the zero-friction work').toBeTruthy();
        expect(found.userId).toBe(anon.user.id);

        const strangerGetAfter = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGetAfter.status(), 'stranger still blocked after the claim').toBe(403);
    });

    test('work-invitation NEGATIVE matrix: self-owner, double-member, bad DTO inputs', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: 'Invitation Negatives Work',
            slug: `inv-neg-${uniqueSuffix()}`,
            description: 'Work used to exercise the invitation-claim negative matrix.',
        });
        expect(workId).toBeTruthy();

        // A) Member-role invitation WITHOUT an email is refused at the controller.
        const noEmail = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'viewer', expiresInDays: 7 },
        });
        expect(noEmail.status(), 'member invite missing email → 400').toBe(400);
        expect(String((await noEmail.json()).message)).toMatch(
            /email is required for member-role invitations/i,
        );

        // B) expiresInDays is bounded @Min(1)@Max(90) at the DTO — 0 and 91 both 400.
        for (const bad of [0, 91]) {
            const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
                headers: authedHeaders(owner.access_token),
                data: {
                    role: 'viewer',
                    email: `b-${uniqueSuffix()}@test.local`,
                    expiresInDays: bad,
                },
            });
            expect(res.status(), `expiresInDays=${bad} → 400`).toBe(400);
        }

        // C) An unrecognised role is rejected by @IsIn.
        const badRole = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'superadmin', email: `r-${uniqueSuffix()}@test.local`, expiresInDays: 7 },
        });
        expect(badRole.status(), 'invalid role → 400').toBe(400);

        // D) The OWNER cannot claim a member invitation to their OWN work.
        const selfInvite = await issueInvitation(request, owner.access_token, workId, {
            role: 'viewer',
            email: `self-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        expect(selfInvite.token).toMatch(HEX_64_RE);
        const selfAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(owner.access_token),
            data: { token: selfInvite.token },
        });
        expect(selfAccept.status(), 'owner accepting own work → 400').toBe(400);
        expect((await selfAccept.json()).message).toBe('claimant_is_already_owner');

        // E) A fresh claimant accepts a viewer invite (200), becoming a member...
        const claimant = await registerUserViaAPI(request);
        const firstInvite = await issueInvitation(request, owner.access_token, workId, {
            role: 'viewer',
            email: `first-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const firstAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token: firstInvite.token },
        });
        expect(firstAccept.status(), `first accept → 200 (${await firstAccept.text()})`).toBe(200);
        expect((await firstAccept.json()).transferStatus).toBe('not_required');

        // The owner's member list now carries the claimant with the granted role.
        const membersRes = await request.get(`${API_BASE}/api/works/${workId}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(membersRes.ok()).toBeTruthy();
        const members = await membersRes.json();
        expect(members.status).toBe('success');
        expect(members.owner.id).toBe(owner.user.id);
        const memberRow = (members.members ?? []).find(
            (m: { userId: string }) => m.userId === claimant.user.id,
        );
        expect(memberRow, 'claimant is now a member').toBeTruthy();
        expect(String(memberRow.role).toLowerCase()).toBe('viewer');

        // F) ...and a SECOND, DISTINCT invitation accepted by the SAME (already-member)
        //    claimant is refused — one membership per (work, user).
        const secondInvite = await issueInvitation(request, owner.access_token, workId, {
            role: 'editor',
            email: `second-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const secondAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token: secondInvite.token },
        });
        expect(secondAccept.status(), 'double-membership → 400').toBe(400);
        expect((await secondAccept.json()).message).toBe('already_a_member');
    });

    test('owner-claim identity gate + transfer-state machine', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: 'Owner-Claim Transfer Work',
            slug: `oc-${uniqueSuffix()}`,
            description: 'Work whose ownership is transferred via an owner-claim token.',
        });
        expect(workId).toBeTruthy();

        // A) An owner-claim WITHOUT expectedProviderUsername is refused at issue time —
        //    the identity gate has nothing to match against.
        const missingUser = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'owner-claim', expiresInDays: 7 },
        });
        expect(missingUser.status(), 'owner-claim w/o expected username → 400').toBe(400);
        expect(String((await missingUser.json()).message)).toMatch(/expectedProviderUsername/i);

        // B) A proper owner-claim issues; its PUBLIC preview surfaces the expected
        //    provider identity (the field that distinguishes owner-claim previews).
        const expectedLogin = `gh-${uniqueSuffix()}`;
        const ownerClaim = await issueInvitation(request, owner.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: expectedLogin,
            expiresInDays: 7,
        });
        expect(ownerClaim.token).toMatch(HEX_64_RE);

        const preview = await request.get(
            `${API_BASE}/api/claim/preview?token=${ownerClaim.token}`,
        );
        expect(preview.status(), `owner-claim preview → 200 (${await preview.text()})`).toBe(200);
        const p = await preview.json();
        expect(p.role).toBe('owner-claim');
        expect(String(p.expectedProviderUsername).toLowerCase()).toBe(expectedLogin.toLowerCase());
        expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // C) A claimant whose linked provider login does NOT match the expected one
        //    (a vanilla email/password user has no provider accounts at all) is
        //    rejected by the identity gate — and the token is NOT consumed.
        const mismatch = await registerUserViaAPI(request);
        const mismatchAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(mismatch.access_token),
            data: { token: ownerClaim.token },
        });
        expect(mismatchAccept.status(), 'identity mismatch → 403').toBe(403);
        expect((await mismatchAccept.json()).message).toBe('claimant_provider_identity_mismatch');

        // D) Because the failed accept did NOT consume the token, the preview is
        //    STILL 200 (pending) — the offer survives a rejected identity check.
        const previewAgain = await request.get(
            `${API_BASE}/api/claim/preview?token=${ownerClaim.token}`,
        );
        expect(previewAgain.status(), 'token still pending after a rejected accept').toBe(200);
        expect((await previewAgain.json()).role).toBe('owner-claim');

        // E) Contrast the transfer-state machine: a MEMBER-role accept reports
        //    transferStatus 'not_required' (no repo hand-off), while owner-claim
        //    is the only role that drives a real transfer. Prove the member branch
        //    here so the two transfer semantics are pinned in one place.
        const memberInvite = await issueInvitation(request, owner.access_token, workId, {
            role: 'manager',
            email: `mgr-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const manager = await registerUserViaAPI(request);
        const managerAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(manager.access_token),
            data: { token: memberInvite.token },
        });
        expect(managerAccept.status(), `manager accept → 200 (${await managerAccept.text()})`).toBe(
            200,
        );
        const ma = await managerAccept.json();
        expect(ma.role).toBe('manager');
        expect(ma.transferStatus, 'member roles never trigger a repo transfer').toBe(
            'not_required',
        );
        expect(ma.workId).toBe(workId);
    });
});
