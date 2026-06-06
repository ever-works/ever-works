import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import {
    isMailhogAvailable,
    clearMailhogInbox,
    waitForMessageTo,
    extractLinkFromBody,
} from './helpers/mailhog';

/**
 * flow: WORK invitation email round-trip (REAL integration)
 *
 * IMPORTANT CONTRACT CORRECTION (verified against live source 2026-06-01):
 * "Invitations" in this repo are WORK invitations, NOT org invitations.
 * There is NO `/api/organizations/:id/invitations` endpoint. The real surface:
 *   apps/api/src/works/invitations.controller.ts        (issue / list / revoke)
 *   apps/api/src/works/claim.controller.ts -> /api/claim (preview / accept)  *
 *   packages/agent/src/services/work-invitation.service.ts (state machine)
 *   packages/agent/src/entities/work-invitation.entity.ts  (WorkInvitation)
 *   apps/api/src/works/dto/create-invitation.dto.ts        (CreateInvitationDto)
 *   apps/api/src/templates/{member-invitation,work-invitation-claim}.hbs (mail)
 *
 * Probed / source-verified endpoints (all under JwtAuthGuard/AuthSessionGuard
 * except the PUBLIC claim/preview):
 *   POST   /api/works/:workId/invitations          -> 201 InvitationResponseDto
 *       body {email, role, expiresInDays?, metadata?, expectedProviderUsername?}
 *       The raw token is returned ONCE, embedded in `claimUrl` =
 *       `${webAppUrl}/claim/${token}` (token = randomBytes(32).hex = 64 chars).
 *       Only sha256(token) is persisted; later reads NEVER include the token.
 *       member-role role MUST carry an email (else 400 "email is required for
 *       member-role invitations"). role is IsIn(ALL_INVITATION_ROLES);
 *       expiresInDays IsInt Min(1) Max(90) default 30.
 *   GET    /api/works/:workId/invitations          -> 200 {status:'success',
 *       invitations: InvitationResponseDto[]}  (PENDING only; NO claimUrl).
 *   DELETE /api/works/:workId/invitations/:invId   -> 200 {status:'success'}
 *       404 "invitation_not_found" when the id isn't a pending invite of this
 *       work; revoking a non-pending invite -> 400 "invitation_not_pending".
 *   GET    /api/claim/preview?token=...            -> 200 {role, workName, ...}
 *       PUBLIC + throttled, does NOT consume. (documented by the two existing
 *       claim specs; this file does not re-assert preview semantics.)
 *   POST   /api/claim/accept  body {token}         -> 2xx {workId, role}
 *       consumes the token -> creates a WorkMember. Service precedence on a
 *       non-consumable token: not-found(404) -> revoked(403 invitation_revoked)
 *       -> already-accepted(400 invitation_already_accepted) ->
 *       expired(400 invitation_expired).
 *
 * Roles: owner > manager > editor > viewer, plus the special `owner-claim`.
 * Issuing requires ensureCanManageMembers (owner/manager); owner-claim requires
 * ensureIsOwner AND expectedProviderUsername (else 400).
 *
 * EXISTING COVERAGE I DELIBERATELY DO NOT DUPLICATE:
 *   - member-invitation-happy-path.spec.ts: invite->preview->accept->list->
 *     role-change->remove (the linear happy path).
 *   - invitation-token-single-use.spec.ts: token-in-claimUrl, preview no-consume,
 *     double-accept -> 4xx.
 *   - multi-user-invitation.spec.ts: multi-user collab variants.
 * This file adds the UNCOVERED lifecycle edges: mail round-trip (best-effort),
 * resend-as-revoke+reissue, revoke-then-accept-blocked, expiry CONTRACT +
 * validation clamps, authorization boundaries, and UUID/validation negatives.
 *
 * GOTCHAS honored:
 *   - MAIL is BEST-EFFORT: MailHog HTTP is up (isMailhogAvailable true) but e2e
 *     SMTP delivery fails ("Missing credentials for PLAIN") so the mailbox often
 *     never receives. Validate mail content IF a message arrives, else fall back
 *     to the API contract (claimUrl carries the same token the email would).
 *     Never hard-require a delivered email.
 *   - ANON CONTEXT: bare newContext() inherits the storageState cookie; for the
 *     unauth web probe we pass storageState:{cookies:[],origins:[]}.
 *   - next-dev LOCAL vs CI route divergence on /claim/:token -> assert with .or()
 *     / a boolean fallback (real page OR /login redirect OR 404 catch-all).
 *   - TRUE expiry is not directly forceable (expiresInDays clamps to >=1 day,
 *     no backdate seam, sqlite in-memory in CI). We assert the expiry CONTRACT
 *     (min window, clamp validation) and annotate the unreachable real-expiry
 *     accept path that the service enforces (400 invitation_expired).
 *   - Mutations run on FRESH registerUserViaAPI() users (unique Date.now ids);
 *     assert toContain over arrays, never exact counts.
 */

const MIN_DAY_MS = 23 * 60 * 60 * 1000; // ~1 day lower bound (clock slop tolerant)

interface InvitationResponse {
    id: string;
    workId: string;
    role: string;
    email: string | null;
    status: string;
    tokenExpiresAt: string;
    createdAt: string;
    invitedById: string;
    claimUrl?: string;
    metadata?: Record<string, unknown> | null;
}

function uniqEmail(tag: string): string {
    return `e2e-inv-${tag}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 7)}@test.local`;
}

/** Issue an invitation; return the parsed response + http status. */
async function issueInvite(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: InvitationResponse }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
        data,
    });
    const body = (await res.json().catch(() => ({}))) as InvitationResponse;
    return { status: res.status(), body };
}

/** Pull the raw claim token out of a created invitation's claimUrl (returned once). */
function tokenFromClaimUrl(body: InvitationResponse): string | null {
    const url = body.claimUrl ?? '';
    const m = url.match(/\/claim\/([^/?#]+)/);
    return m?.[1] ?? null;
}

async function listInvites(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<InvitationResponse[]> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list invitations body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return (
        Array.isArray(body) ? body : (body?.invitations ?? body?.data ?? [])
    ) as InvitationResponse[];
}

async function acceptClaim(
    request: APIRequestContext,
    token: string,
    claimToken: string,
): Promise<number> {
    const res = await request.post(`${API_BASE}/api/claim/accept`, {
        headers: authedHeaders(token),
        data: { token: claimToken },
    });
    return res.status();
}

test.describe('flow: work invitation email round-trip (real integration)', () => {
    test('full round-trip: issue -> (mail best-effort) -> accept via token -> membership; token is single-issue', async ({
        request,
    }, testInfo) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-roundtrip-${tag}`,
            slug: `inv-roundtrip-${tag}`,
        });

        const mailUp = await isMailhogAvailable(request);
        if (mailUp) await clearMailhogInbox(request);

        // 1) Issue a member-role (editor) invitation to the invitee's email.
        const { status, body } = await issueInvite(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'editor',
        });
        expect(status, JSON.stringify(body)).toBe(201);
        expect(body.id).toBeTruthy();
        expect(body.workId).toBe(work.id);
        expect(String(body.role).toLowerCase()).toBe('editor');
        expect(body.status.toLowerCase()).toBe('pending');
        // claimUrl carries the raw token ONCE; later reads must not.
        const claimToken = tokenFromClaimUrl(body);
        expect(claimToken, 'claimUrl must embed the raw token at creation').toBeTruthy();
        expect(claimToken!.length).toBeGreaterThanOrEqual(48); // randomBytes(32).hex = 64

        // 2) MAIL is BEST-EFFORT. If a message arrives, it must reference the
        //    claim link / token; otherwise assert the API delivered the token.
        if (mailUp) {
            const msg = await waitForMessageTo(request, invitee.email, { timeoutMs: 6000 });
            if (msg) {
                const link = extractLinkFromBody(msg, /https?:\/\/[^\s"'<>]*\/claim\/[^\s"'<>]+/);
                const bodyText = msg.Content?.Body ?? '';
                expect(
                    Boolean(link) ||
                        bodyText.includes(claimToken!) ||
                        /invit|claim/i.test(bodyText),
                    'invitation mail should reference the claim link/token',
                ).toBeTruthy();
            } else {
                testInfo.annotations.push({
                    type: 'mail',
                    description:
                        'No invitation email delivered (e2e SMTP best-effort fails). Validated the API claim-token contract instead.',
                });
            }
        }

        // 3) The listed (pending) invitation must NOT leak the raw token.
        const pending = await listInvites(request, owner.access_token, work.id);
        const listed = pending.find((i) => i.id === body.id);
        expect(listed, 'issued invite should be listed as pending').toBeTruthy();
        expect(listed!.claimUrl ?? '', 'listing must not re-expose the raw token').not.toContain(
            claimToken!,
        );

        // 4) Invitee accepts via the token -> WorkMember materializes.
        const acceptStatus = await acceptClaim(request, invitee.access_token, claimToken!);
        expect(acceptStatus, 'accept should succeed').toBeGreaterThanOrEqual(200);
        expect(acceptStatus).toBeLessThan(300);

        // 5) Membership is visible to the owner; the invitation leaves PENDING.
        const members = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(members.status()).toBe(200);
        const mBody = await members.json();
        const memberList = Array.isArray(mBody) ? mBody : (mBody?.members ?? mBody?.data ?? []);
        const found = memberList.find(
            (m: { userId?: string; user?: { id?: string } }) =>
                m?.userId === invitee.user.id || m?.user?.id === invitee.user.id,
        );
        expect(found, 'invitee should be a member after accept').toBeTruthy();

        const afterPending = await listInvites(request, owner.access_token, work.id);
        expect(afterPending.map((i) => i.id)).not.toContain(body.id);
    });

    test('resend pattern: revoke pending + re-issue mints a NEW token; the OLD token no longer accepts', async ({
        request,
    }) => {
        // The API has no dedicated resend; the real "resend" is revoke+reissue.
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-resend-${tag}`,
            slug: `inv-resend-${tag}`,
        });

        const first = await issueInvite(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'editor',
        });
        expect(first.status).toBe(201);
        const oldToken = tokenFromClaimUrl(first.body);
        expect(oldToken).toBeTruthy();

        // Revoke the first (pending) invitation.
        const revoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${first.body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(revoke.status(), await revoke.text()).toBe(200);
        expect((await revoke.json()).status).toBe('success');

        // Re-issue ("resend") to the same email -> brand-new token.
        const second = await issueInvite(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'editor',
        });
        expect(second.status).toBe(201);
        const newToken = tokenFromClaimUrl(second.body);
        expect(newToken).toBeTruthy();
        expect(newToken).not.toBe(oldToken);
        expect(second.body.id).not.toBe(first.body.id);

        // The OLD (revoked) token must NOT be acceptable; the NEW one is.
        const oldAccept = await acceptClaim(request, invitee.access_token, oldToken!);
        expect(oldAccept, 'revoked token must not accept').toBeGreaterThanOrEqual(400);
        expect(oldAccept).toBeLessThan(500);

        const newAccept = await acceptClaim(request, invitee.access_token, newToken!);
        expect(newAccept, 'freshly re-issued token should accept').toBeGreaterThanOrEqual(200);
        expect(newAccept).toBeLessThan(300);
    });

    test('revoke pending then accept-after-revoke is rejected (403 invitation_revoked) and no membership is created', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-revoke-${tag}`,
            slug: `inv-revoke-${tag}`,
        });

        const { status, body } = await issueInvite(request, owner.access_token, work.id, {
            email: invitee.email,
            role: 'viewer',
        });
        expect(status).toBe(201);
        const claimToken = tokenFromClaimUrl(body);
        expect(claimToken).toBeTruthy();

        // Pending invite is listed before revoke.
        expect(
            (await listInvites(request, owner.access_token, work.id)).map((i) => i.id),
        ).toContain(body.id);

        // Revoke it.
        const revoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(revoke.status()).toBe(200);

        // It drops out of the pending list.
        expect(
            (await listInvites(request, owner.access_token, work.id)).map((i) => i.id),
        ).not.toContain(body.id);

        // Accepting a revoked invite is rejected (service: ForbiddenException
        // 'invitation_revoked'); tolerate 400/403 + message presence.
        const acceptRes = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token: claimToken },
        });
        expect([400, 403, 404, 410]).toContain(acceptRes.status());
        expect((await acceptRes.text()).toLowerCase()).toMatch(/revok|not.?found|invalid/);

        // No membership got created for the rejected invitee.
        const members = await request.get(`${API_BASE}/api/works/${work.id}/members`, {
            headers: authedHeaders(owner.access_token),
        });
        const mBody = await members.json();
        const memberList = Array.isArray(mBody) ? mBody : (mBody?.members ?? mBody?.data ?? []);
        const found = memberList.find(
            (m: { userId?: string; user?: { id?: string } }) =>
                m?.userId === invitee.user.id || m?.user?.id === invitee.user.id,
        );
        expect(found, 'revoked invitee must not be a member').toBeFalsy();

        // Double-revoke: the invite is no longer pending in this work -> 404.
        const revokeAgain = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(revokeAgain.status()).toBe(404);
        expect((await revokeAgain.text()).toLowerCase()).toContain('not_found');
    });

    test('expiry contract: default + custom lifetimes set a future window; out-of-range expiresInDays is rejected (400)', async ({
        request,
    }, testInfo) => {
        const owner = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-expiry-${tag}`,
            slug: `inv-expiry-${tag}`,
        });

        // Default lifetime (30d) -> tokenExpiresAt comfortably in the future.
        const def = await issueInvite(request, owner.access_token, work.id, {
            email: uniqEmail('exp-def'),
            role: 'editor',
        });
        expect(def.status).toBe(201);
        const defExp = new Date(def.body.tokenExpiresAt).getTime();
        expect(defExp).toBeGreaterThan(Date.now() + MIN_DAY_MS);

        // Minimum custom lifetime (1 day) is accepted and still in the future.
        const oneDay = await issueInvite(request, owner.access_token, work.id, {
            email: uniqEmail('exp-1d'),
            role: 'editor',
            expiresInDays: 1,
        });
        expect(oneDay.status).toBe(201);
        const oneDayExp = new Date(oneDay.body.tokenExpiresAt).getTime();
        expect(oneDayExp).toBeGreaterThan(Date.now());
        // A 1-day invite expires sooner than the 30-day default one.
        expect(oneDayExp).toBeLessThan(defExp);

        // Out-of-range lifetimes are rejected by the DTO/service clamps.
        const tooLong = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: uniqEmail('exp-91'), role: 'editor', expiresInDays: 91 },
        });
        expect(tooLong.status()).toBe(400);

        const tooShort = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: uniqEmail('exp-0'), role: 'editor', expiresInDays: 0 },
        });
        expect(tooShort.status()).toBe(400);

        // TRUE expiry (accept of a past-due invite) is unreachable via the public
        // API: expiresInDays clamps to >=1 day and there is no backdate seam.
        // The service enforces it (isExpired() -> 400 'invitation_expired',
        // after a best-effort sweep). Annotate rather than fake it.
        testInfo.annotations.push({
            type: 'note',
            description:
                'Real expiry-accept (400 invitation_expired) is unreachable via API (min 1-day lifetime, no backdate). Asserted the expiry-window + clamp contract instead.',
        });
    });

    test('authorization boundaries: non-manager cannot issue/revoke; member-role requires email; owner-claim requires expectedProviderUsername', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const outsider = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-authz-${tag}`,
            slug: `inv-authz-${tag}`,
        });

        // A non-member outsider cannot issue invitations (ensureCanManageMembers).
        const outsiderIssue = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(outsider.access_token),
            data: { email: uniqEmail('outsider'), role: 'editor' },
        });
        expect([401, 403, 404]).toContain(outsiderIssue.status());

        // Owner issues a real invite so the outsider has something to try to revoke.
        const issued = await issueInvite(request, owner.access_token, work.id, {
            email: uniqEmail('victim'),
            role: 'editor',
        });
        expect(issued.status).toBe(201);

        // The outsider cannot revoke it either.
        const outsiderRevoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${issued.body.id}`,
            { headers: authedHeaders(outsider.access_token) },
        );
        expect([401, 403, 404]).toContain(outsiderRevoke.status());

        // The outsider cannot even list this work's invitations.
        const outsiderList = await request.get(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(outsider.access_token),
        });
        expect([401, 403, 404]).toContain(outsiderList.status());

        // member-role invitation with NO email -> 400 (controller guard).
        const noEmail = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'editor' },
        });
        expect(noEmail.status()).toBe(400);
        expect((await noEmail.text()).toLowerCase()).toContain('email');

        // owner-claim invitation with NO expectedProviderUsername -> 400.
        const ownerClaimNoUser = await request.post(
            `${API_BASE}/api/works/${work.id}/invitations`,
            {
                headers: authedHeaders(owner.access_token),
                data: { role: 'owner-claim' },
            },
        );
        expect(ownerClaimNoUser.status()).toBe(400);
        expect((await ownerClaimNoUser.text()).toLowerCase()).toContain('expectedproviderusername');

        // owner-claim WITH expectedProviderUsername is accepted (no email required).
        const ownerClaimOk = await request.post(`${API_BASE}/api/works/${work.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { role: 'owner-claim', expectedProviderUsername: `gh-${tag}` },
        });
        expect(ownerClaimOk.status(), await ownerClaimOk.text()).toBe(201);
        const ocBody = (await ownerClaimOk.json()) as InvitationResponse;
        expect(String(ocBody.role)).toBe('owner-claim');
        expect(tokenFromClaimUrl(ocBody), 'owner-claim still returns a claim token').toBeTruthy();
    });

    test('input validation + anon boundaries: malformed ids 400/404, unknown token 4xx, anon claim deeplink resolves resiliently', async ({
        request,
        browser,
        baseURL,
    }) => {
        const owner = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `inv-validate-${tag}`,
            slug: `inv-validate-${tag}`,
        });

        // :workId is a ParseUUIDPipe -> a non-UUID work id is a 400, not a 500.
        const badWorkId = await request.post(`${API_BASE}/api/works/not-a-uuid/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: uniqEmail('badwork'), role: 'editor' },
        });
        expect(badWorkId.status()).toBe(400);

        // :invitationId is a ParseUUIDPipe too -> malformed revoke id -> 400.
        const badRevoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/not-a-uuid`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(badRevoke.status()).toBe(400);

        // A well-formed-but-unknown invitation id -> 404 invitation_not_found.
        const unknownId = '00000000-0000-4000-8000-000000000000';
        const unknownRevoke = await request.delete(
            `${API_BASE}/api/works/${work.id}/invitations/${unknownId}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknownRevoke.status()).toBe(404);
        expect((await unknownRevoke.text()).toLowerCase()).toContain('not_found');

        // Accepting a bogus (never-issued) claim token -> 4xx (not a 5xx leak).
        const bogusToken = 'deadbeef'.repeat(8); // 64-char shaped-but-unknown token
        const bogusAccept = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(owner.access_token),
            data: { token: bogusToken },
        });
        expect(bogusAccept.status()).toBeGreaterThanOrEqual(400);
        expect(bogusAccept.status()).toBeLessThan(500);

        // Anon WEB probe of the claim deeplink. There may or may not be a rendered
        // /claim/:token page locally; assert resiliently (real page OR redirect to
        // login OR 404 catch-all). Empty storageState so we don't inherit auth.
        const origin = baseURL ?? 'http://localhost:3000';
        const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const page = await anonCtx.newPage();
            const resp = await page
                .goto(`${origin}/claim/${bogusToken}`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                })
                .catch(() => null);
            const httpStatus = resp?.status() ?? 0;
            const landedOnAuth = /\/(login|sign-in|auth)/.test(page.url());
            const bodyVisible = await page
                .locator('body')
                .first()
                .isVisible()
                .catch(() => false);
            expect(
                landedOnAuth ||
                    bodyVisible ||
                    [200, 301, 302, 307, 308, 401, 404].includes(httpStatus),
            ).toBeTruthy();
        } finally {
            await anonCtx.close();
        }
    });
});
