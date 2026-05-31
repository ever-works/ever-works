import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Claim + zero-friction — cross-feature integration flows (EW-617).
 *
 * The platform ships TWO distinct "claim" surfaces and this suite drives both
 * end-to-end, from zero-friction creation through ownership binding to the
 * isolation guarantees that keep stale/forged tokens from doing anything:
 *
 *   A) ZERO-FRICTION ACCOUNT CLAIM (anonymous → registered)
 *      POST /api/auth/anonymous       → mints a throwaway is_anonymous user.
 *      POST /api/works                → that anon user owns a real Work
 *                                       (work.userId === anon.id) — the
 *                                       "claimable" resource.
 *      POST /api/auth/claim           → binds the SAME user row to a real
 *                                       email+password without changing its
 *                                       id, so every Work it owns carries over.
 *      POST /api/auth/login           → the freshly-claimed credentials sign in
 *                                       and still see the pre-claim Work.
 *
 *   B) WORK-INVITATION CLAIM (tokenised /claim/<token>)
 *      POST /api/works/:id/invitations  → 201 InvitationResponseDto with the raw
 *                                         single-use token embedded ONCE in
 *                                         `claimUrl` (http://…/claim/<64-hex>).
 *      GET  /api/claim/preview?token=…  → PUBLIC, throttled, read-only metadata.
 *      POST /api/claim/accept           → authed, single-use; member roles bind a
 *                                         WorkMember row; owner-claim transfers
 *                                         ownership after a provider-identity check.
 *
 * Every shape, status code, and error message below was confirmed against the
 * LIVE stack (sqlite in-memory — the same driver CI uses) before assertions
 * were written:
 *
 *   POST /api/auth/anonymous → 201 { access_token, user:{ id, email:null,
 *        username:/^anon-[0-9a-f]{8}$/, isAnonymous:true, anonymousExpiresAt } }.
 *   GET  /api/auth/profile/fresh → { id, username, slug, email, isAnonymous,
 *        registrationProvider, anonymousExpiresAt, … }.
 *   POST /api/auth/claim (anon)   → 200 { id, email, username, emailVerified:false }
 *        — id is UNCHANGED; registrationProvider flips to 'local'; <3-char
 *        username override → 400; reused email by a DIFFERENT anon → 409;
 *        called by a non-anon user → 403 'claim is only valid for anonymous …'.
 *   POST /api/works/:id/invitations → 201 { …, role, status:'pending',
 *        claimUrl }. owner-claim needs expectedProviderUsername (else 400).
 *   GET  /api/claim/preview → 200 { workName, role, expiresAt,
 *        expectedProviderUsername, sourceUrl }; unknown → 404
 *        'invitation_not_found'; revoked → 403 'invitation_revoked';
 *        consumed → 400 'invitation_already_accepted'; missing/blank token →
 *        400 'invalid_token'.
 *   POST /api/claim/accept (member) → 200 { invitationId, workId, role,
 *        transferStatus:'not_required' } + a WorkMember row visible in the
 *        owner's GET /api/works/:id/members. No auth → 401. owner-claim with a
 *        non-matching provider login → 403 'claimant_provider_identity_mismatch'.
 *
 * Gotchas baked in (verified live):
 *   - POST /api/works REQUIRES a non-empty description (else 400); the
 *     createWorkViaAPI helper always supplies one, so we use it.
 *   - quick-create (/api/works/quick-create) needs a configured search
 *     provider; in CI it deterministically 400s with
 *     providerErrors.search — so flow 1 creates the claimable Work via the
 *     standard POST /api/works path, which an anon user CAN drive. We assert
 *     the quick-create gate is the provider error, not a crash.
 *   - The anonymous token is a ~43-char opaque session token (NOT the 32-char
 *     register token) — never assert a fixed length on it.
 *   - LOGIN DTO is whitelisted to { email, password } only.
 *
 * Isolation: every flow uses FRESH anon/registered users + fresh Works — never
 * the shared seeded storageState user — so the in-memory DB stays clean for
 * sibling specs. Assertions tolerate pre-existing rows (toContain, never exact
 * counts). The one UI assertion (flow 3) reads the public /claim/<token>
 * landing page, which needs no auth.
 *
 * Relationship to siblings: claim-flow.spec.ts and zero-friction-flow.spec.ts
 * pin individual endpoints with bogus tokens; flow-org-members-rbac.spec.ts
 * pins the member-invitation path against the work resource. THIS suite is the
 * multi-step orchestration that threads zero-friction creation → account-claim
 * binding → tokenised work-claim → and the negative isolation matrix across
 * BOTH claim systems, including the rendered claim landing page.
 */

const ANON_USERNAME_RE = /^anon-[0-9a-f]{8}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

function uniqueSuffix(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Mint a fresh zero-friction (anonymous) session. */
async function createAnonymousSession(request: APIRequestContext): Promise<{
    access_token: string;
    user: { id: string; username: string; isAnonymous: boolean; anonymousExpiresAt: string };
}> {
    const res = await request.post(`${API_BASE}/api/auth/anonymous`);
    if (res.status() !== 201) {
        throw new Error(`anonymous session failed (${res.status()}): ${await res.text()}`);
    }
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

test.describe('Claim + zero-friction', () => {
    test('zero-friction: anonymous session creates a claimable, anon-owned Work', async ({
        request,
    }) => {
        // 1. Mint a throwaway anonymous identity — the zero-friction entrypoint.
        const anon = await createAnonymousSession(request);
        expect(anon.access_token, 'anon session has a token').toBeTruthy();
        expect(anon.user.id, 'anon user has an id').toBeTruthy();
        expect(anon.user.username).toMatch(ANON_USERNAME_RE);
        expect(anon.user.isAnonymous).toBe(true);
        // anonymousExpiresAt is a real future timestamp — the session self-expires.
        expect(new Date(anon.user.anonymousExpiresAt).getTime()).toBeGreaterThan(Date.now());

        // 2. The profile reflects the zero-friction (anonymous) account state.
        const beforeProfile = await profileFresh(request, anon.access_token);
        expect(beforeProfile.id).toBe(anon.user.id);
        expect(beforeProfile.isAnonymous).toBe(true);
        expect(beforeProfile.email).toBeNull();
        expect(beforeProfile.registrationProvider).toBe('anonymous');

        // 3. The anon user creates a real Work — the "claimable resource". We use
        //    the standard POST /api/works path (createWorkViaAPI always supplies a
        //    description, which the DTO requires) rather than quick-create, which
        //    is gated on a configured search provider in CI (asserted separately
        //    in the next step).
        const slug = `zf-claim-${uniqueSuffix()}`;
        const { id: workId, raw } = await createWorkViaAPI(request, anon.access_token, {
            name: 'Zero-Friction Claimable Work',
            slug,
            description: 'A work created in the zero-friction (anonymous) flow.',
        });
        expect(workId, 'work was created').toBeTruthy();

        // The work is owned BY THE ANON USER — that is the claimable state: a real
        // resource bound to a throwaway identity, awaiting an account claim.
        const work = (raw as { work?: Record<string, unknown> }).work ?? {};
        expect(work.userId).toBe(anon.user.id);
        expect(work.slug).toBe(slug);
        expect(work.status).toBe('active');

        // 4. The work is visible in the anon user's own works list (observable
        //    ownership), and the owner column is the anon username.
        const listRes = await request.get(`${API_BASE}/api/works?limit=50`, {
            headers: authedHeaders(anon.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const list = await listRes.json();
        const slugs = (list.works ?? []).map((w: { slug: string }) => w.slug);
        expect(slugs, 'anon-owned work appears in its owner list').toContain(slug);
        const mine = (list.works ?? []).find((w: { slug: string }) => w.slug === slug);
        expect(mine.userId).toBe(anon.user.id);
        expect(String(mine.owner)).toMatch(ANON_USERNAME_RE);

        // 5. quick-create is the OTHER zero-friction entrypoint. In CI (no search
        //    provider) it is a deterministic provider gate, NOT a 202 and NOT a
        //    crash. Assert the truthful state so the flow stays environment
        //    adaptive: either it succeeds (202, provider configured) or it returns
        //    the provider-unavailable contract (400 + providerErrors). Never 5xx.
        const qcRes = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authedHeaders(anon.access_token),
            data: {
                slug: `zf-qc-${uniqueSuffix()}`,
                name: 'Zero-Friction QuickCreate',
                description: 'quick-create probe in the zero-friction flow',
                prompt: 'AI tooling directory',
                organization: false,
            },
        });
        expect(qcRes.status(), 'quick-create never 5xx').toBeLessThan(500);
        if (qcRes.status() === 202) {
            const qc = await qcRes.json();
            expect(qc.work?.id, 'quick-create returns a work id when providers ready').toBeTruthy();
            expect(qc.generation?.historyId).toBeTruthy();
        } else {
            // The documented CI gate: a configured-provider error, not a bug.
            expect(qcRes.status()).toBe(400);
            const qc = await qcRes.json();
            expect(
                qc.providerErrors ?? qc.message,
                'quick-create gate is a provider error',
            ).toBeTruthy();
        }
    });

    test('claim with token: account-claim binds the anon-owned Work to a real identity', async ({
        request,
    }) => {
        // 1. Zero-friction: anon session owns a real Work.
        const anon = await createAnonymousSession(request);
        const slug = `zf-bind-${uniqueSuffix()}`;
        const { id: workId } = await createWorkViaAPI(request, anon.access_token, {
            name: 'Work To Be Claimed',
            slug,
            description: 'Owned by an anon user, about to be claimed into a real account.',
        });
        expect(workId).toBeTruthy();

        // 2. Claim the account: bind email+password to the SAME user row. The
        //    optional username override (>= 3 chars) renames the account; the id
        //    never changes, so all Works carry over.
        const email = `claimed-${uniqueSuffix()}@test.local`;
        const password = 'SecurePass1!claim';
        const newUsername = `claimed${uniqueSuffix().slice(0, 8)}`;
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anon.access_token),
            data: { email, password, username: newUsername },
        });
        expect(claimRes.status(), `claim should be 200 (${await claimRes.text()})`).toBe(200);
        const claimed = await claimRes.json();
        // Ownership binds: same id, real email, not-yet-verified, new username.
        expect(claimed.id, 'claim preserves the user id (ownership binds)').toBe(anon.user.id);
        expect(claimed.email).toBe(email);
        expect(claimed.username).toBe(newUsername);
        expect(claimed.emailVerified).toBe(false);

        // 3. The profile flips out of anonymous mode on the SAME token.
        const after = await profileFresh(request, anon.access_token);
        expect(after.id).toBe(anon.user.id);
        expect(after.isAnonymous).toBe(false);
        expect(after.email).toBe(email);
        expect(after.registrationProvider).toBe('local');
        expect(after.anonymousExpiresAt, 'anon expiry is cleared on claim').toBeNull();

        // 4. The freshly-claimed credentials sign in (LOGIN DTO is { email,
        //    password } only) and resolve to the SAME user id — proof the
        //    identity, not just the session, transferred.
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });
        expect(loginRes.status(), `login with claimed creds (${await loginRes.text()})`).toBe(200);
        const login = await loginRes.json();
        expect(login.user.id).toBe(anon.user.id);
        expect(login.access_token).toBeTruthy();

        // 5. The pre-claim Work is still owned by the now-credentialed user under
        //    the brand-new login token — the claim moved the resource with it.
        const listRes = await request.get(`${API_BASE}/api/works?limit=50`, {
            headers: authedHeaders(login.access_token),
        });
        expect(listRes.ok()).toBeTruthy();
        const list = await listRes.json();
        const found = (list.works ?? []).find((w: { slug: string }) => w.slug === slug);
        expect(found, 'claimed work survives the account claim').toBeTruthy();
        expect(found.userId).toBe(anon.user.id);
    });

    test('claim with token: tokenised work-invitation binds membership to the claimant', async ({
        request,
    }) => {
        // 1. A real owner with a real Work issues a single-use member-claim link.
        const owner = await registerUserViaAPI(request);
        const { id: workId, raw } = await createWorkViaAPI(request, owner.access_token, {
            name: 'Invitation Claim Work',
            slug: `inv-claim-${uniqueSuffix()}`,
            description: 'Work whose membership is claimed via a tokenised link.',
        });
        const workName = (raw as { work?: { name?: string } }).work?.name ?? '';
        expect(workId).toBeTruthy();

        const inviteEmail = `invitee-${uniqueSuffix()}@test.local`;
        const { token, body } = await issueInvitation(request, owner.access_token, workId, {
            role: 'editor',
            email: inviteEmail,
            expiresInDays: 7,
        });
        // The raw token is a 64-char hex string returned ONCE inside claimUrl.
        expect(token).toMatch(HEX_64_RE);
        expect(body.status).toBe('pending');
        expect(body.role).toBe('editor');

        // 2. PUBLIC preview (no auth) — the claim landing page's data source —
        //    surfaces exactly enough metadata to render the offer, without
        //    consuming the token.
        const previewRes = await request.get(`${API_BASE}/api/claim/preview?token=${token}`);
        expect(previewRes.status()).toBe(200);
        const preview = await previewRes.json();
        expect(preview.workName).toBe(workName);
        expect(preview.role).toBe('editor');
        expect(preview.expectedProviderUsername).toBeNull();
        expect(new Date(preview.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // 3. A DIFFERENT, freshly-registered user claims the invitation. Accept is
        //    authed + single-use; an editor role binds a WorkMember row.
        const claimant = await registerUserViaAPI(request);
        const acceptRes = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token },
        });
        expect(acceptRes.status(), `accept should be 200 (${await acceptRes.text()})`).toBe(200);
        const accept = await acceptRes.json();
        expect(accept.workId).toBe(workId);
        expect(accept.role).toBe('editor');
        // Member roles need no repo transfer.
        expect(accept.transferStatus).toBe('not_required');

        // 4. Ownership of the membership BINDS to the claimant: the owner's member
        //    list now contains a row keyed to the claimant's user id with the
        //    granted role.
        const membersRes = await request.get(`${API_BASE}/api/works/${workId}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(membersRes.ok()).toBeTruthy();
        const members = await membersRes.json();
        const row = (members.members ?? []).find(
            (m: { userId: string }) => m.userId === claimant.user.id,
        );
        expect(row, 'claimant is now a member').toBeTruthy();
        expect(String(row.role).toLowerCase()).toBe('editor');

        // 5. The token is single-use: a second accept is rejected, and the public
        //    preview now reports the consumed state — the link is spent.
        const reAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(claimant.access_token),
            data: { token },
        });
        expect(reAccept.status()).toBe(400);
        expect((await reAccept.json()).message).toBe('invitation_already_accepted');

        const consumedPreview = await request.get(`${API_BASE}/api/claim/preview?token=${token}`);
        expect(consumedPreview.status()).toBe(400);
        expect((await consumedPreview.json()).message).toBe('invitation_already_accepted');
    });

    test('claim isolation: invalid, revoked, and identity-mismatched tokens are rejected', async ({
        request,
    }) => {
        // --- Account-claim isolation ---------------------------------------
        // A) A non-anonymous (regular) account cannot run the zero-friction claim.
        const regular = await registerUserViaAPI(request);
        const nonAnonClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(regular.access_token),
            data: { email: `dup-${uniqueSuffix()}@test.local`, password: 'SecurePass1!x' },
        });
        expect(nonAnonClaim.status()).toBe(403);
        expect((await nonAnonClaim.json()).message).toMatch(/anonymous/i);

        // B) An anon claiming an email already owned by ANOTHER user → 409 (no
        //    silent account merge), and a <3-char username override → 400.
        const anonA = await createAnonymousSession(request);
        const sharedEmail = `taken-${uniqueSuffix()}@test.local`;
        const firstClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anonA.access_token),
            data: { email: sharedEmail, password: 'SecurePass1!a' },
        });
        expect(firstClaim.status()).toBe(200);

        const anonB = await createAnonymousSession(request);
        const dupEmailClaim = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anonB.access_token),
            data: { email: sharedEmail, password: 'SecurePass1!b' },
        });
        expect(dupEmailClaim.status(), 'reused email by another anon → 409').toBe(409);

        const anonC = await createAnonymousSession(request);
        const shortName = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anonC.access_token),
            data: {
                email: `short-${uniqueSuffix()}@test.local`,
                password: 'SecurePass1!c',
                username: 'ab',
            },
        });
        expect(shortName.status(), 'too-short username → 400').toBe(400);

        // --- Work-invitation claim isolation -------------------------------
        const owner = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: 'Isolation Probe Work',
            slug: `iso-claim-${uniqueSuffix()}`,
            description: 'Work used to probe invitation-claim isolation.',
        });

        // C) Unknown 64-hex token (well-formed but never issued) → 404.
        const unknownToken = 'a'.repeat(64);
        const unknownPreview = await request.get(
            `${API_BASE}/api/claim/preview?token=${unknownToken}`,
        );
        expect(unknownPreview.status()).toBe(404);
        expect((await unknownPreview.json()).message).toBe('invitation_not_found');

        // D) Malformed / missing token → 400 invalid_token (preview) and 400 DTO
        //    validation (accept requires MinLength(32)).
        const blankPreview = await request.get(`${API_BASE}/api/claim/preview`);
        expect(blankPreview.status()).toBe(400);
        expect((await blankPreview.json()).message).toBe('invalid_token');

        const shortAcceptUser = await registerUserViaAPI(request);
        const shortAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(shortAcceptUser.access_token),
            data: { token: 'short' },
        });
        expect(shortAccept.status()).toBe(400);

        // E) Accept WITHOUT auth → 401 (the accept route is guarded).
        const goodInvite = await issueInvitation(request, owner.access_token, workId, {
            role: 'viewer',
            email: `noauth-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const noAuthAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            data: { token: goodInvite.token },
        });
        expect(noAuthAccept.status()).toBe(401);

        // F) Revoked token → both preview and accept return 403 invitation_revoked.
        const toRevoke = await issueInvitation(request, owner.access_token, workId, {
            role: 'viewer',
            email: `revoke-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const revokeRes = await request.delete(
            `${API_BASE}/api/works/${workId}/invitations/${toRevoke.body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(revokeRes.status()).toBe(200);

        const revokedPreview = await request.get(
            `${API_BASE}/api/claim/preview?token=${toRevoke.token}`,
        );
        expect(revokedPreview.status()).toBe(403);
        expect((await revokedPreview.json()).message).toBe('invitation_revoked');

        const revClaimant = await registerUserViaAPI(request);
        const revokedAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(revClaimant.access_token),
            data: { token: toRevoke.token },
        });
        expect(revokedAccept.status()).toBe(403);
        expect((await revokedAccept.json()).message).toBe('invitation_revoked');

        // G) owner-claim identity gate: an owner-claim token requires the
        //    claimant's linked provider login to match expectedProviderUsername.
        //    A claimant with no matching git account → 403 identity mismatch.
        const ownerClaim = await issueInvitation(request, owner.access_token, workId, {
            role: 'owner-claim',
            expectedProviderUsername: `gh-${uniqueSuffix()}`,
            expiresInDays: 7,
        });
        const ownerClaimPreview = await request.get(
            `${API_BASE}/api/claim/preview?token=${ownerClaim.token}`,
        );
        expect(ownerClaimPreview.status()).toBe(200);
        const ocp = await ownerClaimPreview.json();
        expect(ocp.role).toBe('owner-claim');
        expect(ocp.expectedProviderUsername).toBeTruthy();

        const mismatchUser = await registerUserViaAPI(request);
        const mismatchAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(mismatchUser.access_token),
            data: { token: ownerClaim.token },
        });
        expect(mismatchAccept.status()).toBe(403);
        expect((await mismatchAccept.json()).message).toBe('claimant_provider_identity_mismatch');

        // H) owner-claim without expectedProviderUsername is refused at issue time.
        const badOwnerClaim = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'owner-claim', expiresInDays: 7 },
        });
        expect(badOwnerClaim.status()).toBe(400);
        expect(String((await badOwnerClaim.json()).message)).toMatch(/expectedProviderUsername/i);
    });

    test('claim landing (UI): the /claim/<token> page renders the offer and the humanized error', async ({
        request,
        page,
        baseURL,
    }) => {
        // Navigate via the Playwright `baseURL` fixture — the SAME host global-setup
        // logged into — so the seeded storageState auth cookie (scoped to that
        // host) is actually sent. A hardcoded `localhost` URL would not receive a
        // `127.0.0.1`-scoped cookie, so the auth middleware would bounce the browser
        // to /login and the offer heading would never render.
        const appUrl = baseURL || 'http://localhost:3000';
        // The claim landing page (`[locale]/claim/[token]`) is a server component
        // that loads from the PUBLIC GET /api/claim/preview. It IS behind the auth
        // middleware (an unauthenticated browser is bounced to /login); this spec
        // runs in the authenticated `chromium` project (seeded storageState), so
        // the page renders the actual offer. `/en/claim/<token>` 307s to the
        // unprefixed `/claim/<token>` (localePrefix:'never') — page.goto follows
        // it, so the final status is 200. We assert the observable card UI, never
        // a 5xx. Confirmed live against the seeded auth cookie before writing:
        //   valid   → H1 "You're invited to <workName>" + "Role on accept: <role>".
        //   unknown → H1 "Invitation unavailable" + "This invitation link is invalid."
        const owner = await registerUserViaAPI(request);
        // Unique, human-unlikely work name so the heading match is unambiguous.
        const workName = `Claim Landing ${uniqueSuffix()}`;
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: workName,
            slug: `ui-claim-${uniqueSuffix()}`,
            description: 'Work whose claim landing page is rendered in the browser.',
        });
        const { token } = await issueInvitation(request, owner.access_token, workId, {
            role: 'manager',
            email: `ui-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });

        // Valid token → the offer card renders, naming the work in the heading and
        // the granted role in the card body.
        const validRes = await page.goto(`${appUrl}/en/claim/${token}`, {
            waitUntil: 'domcontentloaded',
        });
        expect(validRes, 'claim page responded').not.toBeNull();
        expect(validRes!.status(), 'valid claim page is not a 5xx').toBeLessThan(500);
        // The heading carries the work name; anchor on it (the work name is unique
        // so this can't collide with chrome/nav text).
        await expect(
            page.getByRole('heading', { name: new RegExp(workName, 'i') }),
            'landing heading names the work',
        ).toBeVisible({ timeout: 20_000 });
        // The card body states the role on accept (member-role branch of the page).
        await expect(
            page.getByText(/Role on accept/i).first(),
            'landing card states the role on accept',
        ).toBeVisible({ timeout: 20_000 });

        // Unknown token → the humanized "invalid" error card, never a crash.
        const unknownRes = await page.goto(`${appUrl}/en/claim/${'b'.repeat(64)}`, {
            waitUntil: 'domcontentloaded',
        });
        expect(unknownRes, 'unknown-token page responded').not.toBeNull();
        expect(unknownRes!.status(), 'unknown-token page is not a 5xx').toBeLessThan(500);
        await expect(
            page.getByRole('heading', { name: /Invitation unavailable/i }),
            'unknown token shows the "Invitation unavailable" card',
        ).toBeVisible({ timeout: 20_000 });
        await expect(
            page.getByText(/this invitation link is invalid/i).first(),
            'unknown token shows the humanized invalid-invitation message',
        ).toBeVisible({ timeout: 20_000 });
    });
});
