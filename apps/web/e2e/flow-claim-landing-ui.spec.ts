import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Claim landing page (/claim/<token>) — DEEP browser-driven integration flows.
 *
 * The single UI assertion in `flow-claim-zero-friction.spec.ts` only pins TWO
 * states of the rendered landing card (valid member heading + role; unknown →
 * "Invitation unavailable"). Every OTHER branch of the page — the
 * accept-from-landing server-action round-trip, the owner-claim ownership copy,
 * the full humanized error matrix, the cookie-host / baseURL nav contract, the
 * `[locale]`-prefix → unprefixed equivalence, and the conditional offer-card
 * sub-blocks — is unexercised in the browser. THIS suite drives all of those
 * end-to-end against the live page.
 *
 * The landing page is a SERVER COMPONENT at `app/[locale]/claim/[token]/page.tsx`
 * that loads from the PUBLIC `GET /api/claim/preview`, then renders a client
 * `<ClaimForm>` whose Accept button calls the `acceptClaim` SERVER ACTION
 * (POST /api/claim/accept). The route IS behind the web auth middleware: an
 * unauthenticated browser is 307'd to /login. This spec runs in the
 * authenticated `chromium` project (seeded storageState whose
 * `everworks_auth_token` cookie is scoped to the 127.0.0.1 host), so navigating
 * via the Playwright `baseURL` fixture (the SAME host global-setup logged into)
 * is what actually sends that cookie and lets the offer render.
 *
 * Every status/shape/string below was confirmed against the LIVE stack
 * (sqlite in-memory — the same driver CI uses) before assertions were written:
 *
 *   POST /api/works/:id/invitations → 201 { id, workId, role, email, status:
 *        'pending', tokenExpiresAt, claimUrl } — raw 64-hex token embedded ONCE
 *        inside `claimUrl` (host is http://127.0.0.1:3000/claim/<64hex>). member
 *        roles REQUIRE email; owner-claim REQUIRES expectedProviderUsername
 *        (stored under metadata.expectedProviderUsername).
 *   GET  /api/claim/preview?token= → 200 { workName, role, expiresAt,
 *        expectedProviderUsername (null unless owner-claim), sourceUrl (null) };
 *        unknown 64-hex → 404 invitation_not_found; revoked → 403
 *        invitation_revoked; consumed → 400 invitation_already_accepted.
 *   POST /api/claim/accept (authed) → 200 { invitationId, workId, role,
 *        transferStatus:'not_required' } for member roles.
 *   GET  /en/claim/<token> → 307 → /claim/<token> (next-intl localePrefix:'never');
 *        page.goto follows it, final status 200. Unauth → 307 → /login.
 *
 * Observable landing-card contract (read off the real DOM, confirmed live):
 *   member valid  → H1 "You're invited to <workName>"; "Role on accept: <role>";
 *                   Button "Accept invitation"; "Expires <localeString>"; NO
 *                   "Upstream:" line (sourceUrl null), NO "@<provider>" line.
 *   owner-claim   → H1 "Claim ownership of <workName>"; "Sign in with the account
 *                   linked to @<provider> to accept."; Button "Accept and start
 *                   transfer"; transfer disclaimer; NO "Role on accept" line.
 *   accept OK     → the form swaps to an "Invitation accepted" card; member
 *                   (not_required) branch → "You now have access to <workName>."
 *                   + a "Go to <workName> →" link to /works/<id>.
 *   unknown       → H1 "Invitation unavailable" + "This invitation link is invalid."
 *   revoked       → H1 "Invitation unavailable" + "This invitation has been revoked."
 *   consumed      → H1 "Invitation unavailable" + "This invitation has already
 *                   been accepted."
 *
 * Isolation: every flow mints a FRESH registerUserViaAPI() owner + a fresh Work +
 * fresh invitations — never the shared seeded user as the OWNER — so the
 * in-memory DB stays clean for sibling specs. The seeded storageState identity
 * (the browser's signed-in user) is used ONLY to render the page and, in the
 * accept-from-landing flow, to consume a throwaway member invite (it joins a
 * disposable work as a member, which no other spec observes). All page nav uses
 * the baseURL fixture host so the host-scoped auth cookie is sent. Assertions
 * use generous timeouts + .first() + toPass retry loops for the dev-mode
 * cold-compile / hydration race, and never assert a 5xx.
 */

const HEX_64_RE = /^[0-9a-f]{64}$/;

function uniqueSuffix(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Pull the single-use claim token out of an invitation create response. */
function tokenFromInvitation(body: unknown): string {
    const claimUrl = (body as { claimUrl?: string })?.claimUrl ?? '';
    const match = String(claimUrl).match(/\/claim\/([^/?#]+)/);
    return match?.[1] ?? '';
}

interface IssuedInvitation {
    token: string;
    id: string;
    body: Record<string, unknown>;
}

/** Owner issues an invitation and returns the raw single-use token + id + body. */
async function issueInvitation(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    payload: Record<string, unknown>,
): Promise<IssuedInvitation> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/invitations`, {
        headers: authedHeaders(ownerToken),
        data: payload,
    });
    expect(res.status(), `issue invitation should be 201 (${await res.text()})`).toBe(201);
    const body = await res.json();
    return { token: tokenFromInvitation(body), id: String(body.id), body };
}

/** Set up a fresh owner + work; return owner token, work id and the unique name. */
async function freshOwnerWork(
    request: APIRequestContext,
    label: string,
): Promise<{ ownerToken: string; ownerId: string; workId: string; workName: string }> {
    const owner = await registerUserViaAPI(request);
    const workName = `${label} ${uniqueSuffix()}`;
    const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
        name: workName,
        slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uniqueSuffix()}`,
        description: `Work whose claim landing page is rendered in the browser (${label}).`,
    });
    expect(workId, 'work was created').toBeTruthy();
    return { ownerToken: owner.access_token, ownerId: owner.user.id, workId, workName };
}

/** The app origin to navigate to — the SAME host global-setup logged into, so
 * the host-scoped storageState auth cookie is actually sent. */
function appOrigin(baseURL: string | undefined): string {
    return baseURL || 'http://localhost:3000';
}

/** Navigate to a claim landing URL, tolerating the dev cold-compile cliff, and
 * assert it is never a 5xx. */
async function gotoClaim(page: Page, url: string): Promise<void> {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(res, `claim page responded for ${url}`).not.toBeNull();
    expect(res!.status(), `claim page is not a 5xx (${url})`).toBeLessThan(500);
}

test.describe('Claim landing page (UI)', () => {
    test('valid member offer renders, then Accept-from-landing succeeds via the server action', async ({
        request,
        page,
        baseURL,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId, workName } = await freshOwnerWork(
            request,
            'Claim Landing Accept',
        );

        // A member-role (editor) invite — the seeded browser identity will accept it
        // straight from the landing card. The token's host is the web origin.
        const { token, body } = await issueInvitation(request, ownerToken, workId, {
            role: 'editor',
            email: `landing-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        expect(token, 'raw 64-hex token is embedded in claimUrl').toMatch(HEX_64_RE);
        expect(String(body.claimUrl)).toContain('/claim/');
        expect(body.status).toBe('pending');

        // 1. The offer card renders. The work name (unique) anchors the heading; the
        //    member branch states the role and offers an "Accept invitation" button.
        await gotoClaim(page, `${origin}/en/claim/${token}`);
        await expect(
            page.getByRole('heading', {
                name: new RegExp(`You're invited to ${escapeRe(workName)}`, 'i'),
            }),
            'member offer heading names the work',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(/Role on accept:/i).first(),
            'member card states the role on accept',
        ).toBeVisible({ timeout: 20_000 });
        await expect(
            page.getByText(/\beditor\b/i).first(),
            'the granted role appears in the card',
        ).toBeVisible({ timeout: 20_000 });
        // The member card carries an expiry line, and (sourceUrl null) NO upstream link.
        await expect(page.getByText(/^Expires /i).first(), 'card shows an expiry').toBeVisible({
            timeout: 20_000,
        });
        await expect(
            page.getByText(/Upstream:/i),
            'no upstream link for a non-sourced work',
        ).toHaveCount(0);

        // 2. Accept-from-landing: clicking the button drives the `acceptClaim` server
        //    action (POST /api/claim/accept) and swaps the form for the success card.
        //    Retry the click to absorb the dev hydration race (a pre-hydration first
        //    click is swallowed).
        const acceptBtn = page.getByRole('button', { name: /Accept invitation/i });
        await expect(acceptBtn, 'accept button is present').toBeVisible({ timeout: 20_000 });
        await expect
            .poll(
                async () => {
                    if (await acceptBtn.isVisible().catch(() => false)) {
                        await acceptBtn.click({ timeout: 5_000 }).catch(() => {});
                    }
                    return page
                        .getByText(/Invitation accepted/i)
                        .first()
                        .isVisible()
                        .catch(() => false);
                },
                { timeout: 40_000, message: 'accept-from-landing should reach the success card' },
            )
            .toBe(true);

        // 3. The success card (member / not_required branch) grants access and links
        //    to the work — naming it again so the binding is observable in the UI.
        await expect(
            page.getByText(/You now have access to/i).first(),
            'member accept grants access',
        ).toBeVisible({ timeout: 20_000 });
        const goLink = page.getByRole('link', {
            name: new RegExp(`Go to ${escapeRe(workName)}`, 'i'),
        });
        await expect(goLink, 'success card links to the claimed work').toBeVisible({
            timeout: 20_000,
        });
        await expect(goLink).toHaveAttribute('href', new RegExp(`/works/${workId}`));

        // 4. The accept really bound a membership server-side: the owner's member list
        //    now carries the seeded (browser) identity with the editor role. We assert
        //    the row exists (tolerating any pre-existing rows), keyed by the granted
        //    role, without pinning the claimant id (the seeded user is shared).
        const membersRes = await request.get(`${API_BASE}/api/works/${workId}/members`, {
            headers: authedHeaders(ownerToken),
        });
        expect(membersRes.ok(), 'owner can read members').toBeTruthy();
        const members = await membersRes.json();
        const editorRow = (members.members ?? []).find(
            (m: { role: string }) => String(m.role).toLowerCase() === 'editor',
        );
        expect(editorRow, 'a new editor member was bound by the landing accept').toBeTruthy();
    });

    test('owner-claim offer renders the ownership-specific copy (provider gate + transfer button)', async ({
        request,
        page,
        baseURL,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId, workName } = await freshOwnerWork(
            request,
            'Claim Landing Owner',
        );

        // An owner-claim token surfaces the expected provider identity — the page
        // renders an ownership-transfer offer instead of a member offer.
        const expectedProvider = `gh-landing-${uniqueSuffix()}`;
        const { token } = await issueInvitation(request, ownerToken, workId, {
            role: 'owner-claim',
            expectedProviderUsername: expectedProvider,
            expiresInDays: 7,
        });
        expect(token).toMatch(HEX_64_RE);

        await gotoClaim(page, `${origin}/en/claim/${token}`);

        // Owner-claim heading is "Claim ownership of <workName>" (NOT "You're invited").
        await expect(
            page.getByRole('heading', {
                name: new RegExp(`Claim ownership of ${escapeRe(workName)}`, 'i'),
            }),
            'owner-claim heading offers ownership transfer',
        ).toBeVisible({ timeout: 30_000 });
        // The provider-identity gate copy names the expected linked account.
        await expect(
            page.getByText(/Sign in with the account linked to/i).first(),
            'owner-claim card explains the provider-identity gate',
        ).toBeVisible({ timeout: 20_000 });
        await expect(
            page.getByText(new RegExp(`@${escapeRe(expectedProvider)}`, 'i')).first(),
            'owner-claim card names the expected provider handle',
        ).toBeVisible({ timeout: 20_000 });
        // The action button is the transfer-initiating variant, with its disclaimer.
        await expect(
            page.getByRole('button', { name: /Accept and start transfer/i }),
            'owner-claim button initiates the transfer',
        ).toBeVisible({ timeout: 20_000 });
        await expect(
            page.getByText(/initiate the repository transfer/i).first(),
            'owner-claim shows the transfer disclaimer',
        ).toBeVisible({ timeout: 20_000 });
        // The member-only "Role on accept" line must NOT appear for owner-claim.
        await expect(
            page.getByText(/Role on accept:/i),
            'no member role line on an owner-claim offer',
        ).toHaveCount(0);
    });

    test('humanized error matrix: unknown, revoked, and already-accepted all render distinct copy', async ({
        request,
        page,
        baseURL,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId } = await freshOwnerWork(request, 'Claim Landing Errors');

        // --- A) Unknown (well-formed 64-hex, never issued) → "invalid" copy. ---
        await gotoClaim(page, `${origin}/en/claim/${'b'.repeat(64)}`);
        await expect(
            page.getByRole('heading', { name: /Invitation unavailable/i }),
            'unknown token → unavailable card',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(/this invitation link is invalid/i).first(),
            'unknown token → humanized invalid message',
        ).toBeVisible({ timeout: 20_000 });

        // --- B) Revoked → distinct "has been revoked" copy. ---
        const revoked = await issueInvitation(request, ownerToken, workId, {
            role: 'viewer',
            email: `revoke-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const revokeRes = await request.delete(
            `${API_BASE}/api/works/${workId}/invitations/${revoked.id}`,
            { headers: authedHeaders(ownerToken) },
        );
        expect(revokeRes.status(), 'revoke succeeds').toBe(200);
        await gotoClaim(page, `${origin}/en/claim/${revoked.token}`);
        await expect(
            page.getByRole('heading', { name: /Invitation unavailable/i }),
            'revoked token → unavailable card',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(/this invitation has been revoked/i).first(),
            'revoked token → humanized revoked message',
        ).toBeVisible({ timeout: 20_000 });
        // The revoked copy is DISTINCT from the unknown copy (no "invalid" wording).
        await expect(
            page.getByText(/this invitation link is invalid/i),
            'revoked card does not show the invalid-token copy',
        ).toHaveCount(0);

        // --- C) Already-accepted → distinct "already been accepted" copy. We consume
        //        a fresh viewer invite via a throwaway API claimant, then render. ---
        const consumed = await issueInvitation(request, ownerToken, workId, {
            role: 'viewer',
            email: `consume-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const apiClaimant = await registerUserViaAPI(request);
        const acceptRes = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(apiClaimant.access_token),
            data: { token: consumed.token },
        });
        expect(
            acceptRes.status(),
            `API accept consumes the token (${await acceptRes.text()})`,
        ).toBe(200);
        await gotoClaim(page, `${origin}/en/claim/${consumed.token}`);
        await expect(
            page.getByRole('heading', { name: /Invitation unavailable/i }),
            'consumed token → unavailable card',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(/this invitation has already been accepted/i).first(),
            'consumed token → humanized already-accepted message',
        ).toBeVisible({ timeout: 20_000 });
    });

    test('baseURL cookie host: the offer renders for the host-scoped session, but an anon context is bounced to /login', async ({
        request,
        page,
        baseURL,
        browser,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId, workName } = await freshOwnerWork(
            request,
            'Claim Landing Host',
        );
        const { token } = await issueInvitation(request, ownerToken, workId, {
            role: 'manager',
            email: `host-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });

        // 1. AUTHED (this project carries the seeded storageState cookie scoped to the
        //    baseURL host): navigating via the baseURL origin SENDS that cookie, so the
        //    auth middleware lets the page through and the offer heading renders.
        await gotoClaim(page, `${origin}/en/claim/${token}`);
        await expect(
            page.getByRole('heading', {
                name: new RegExp(`You're invited to ${escapeRe(workName)}`, 'i'),
            }),
            'host-scoped cookie reaches the page → offer renders',
        ).toBeVisible({ timeout: 30_000 });
        // We are NOT on /login — the middleware did not bounce us.
        expect(page.url(), 'authed nav stays on the claim route').toContain('/claim/');
        expect(page.url(), 'authed nav is not bounced to login').not.toContain('/login');

        // 2. ANON: a bare context inherits the storageState cookie, so we MUST pass an
        //    empty storageState to be genuinely signed out. The same valid token is now
        //    bounced by the auth middleware to /login (the route is NOT public).
        const anonContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const anonPage = await anonContext.newPage();
            const anonRes = await anonPage.goto(`${origin}/en/claim/${token}`, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
            });
            expect(anonRes, 'anon claim nav responded').not.toBeNull();
            expect(anonRes!.status(), 'anon claim nav is not a 5xx').toBeLessThan(500);
            // Landed on /login (the middleware redirect), and the offer heading is gone.
            await expect
                .poll(() => anonPage.url(), {
                    timeout: 30_000,
                    message: 'anonymous visitor is bounced to /login',
                })
                .toContain('/login');
            await expect(
                anonPage.getByRole('heading', {
                    name: new RegExp(`You're invited to ${escapeRe(workName)}`, 'i'),
                }),
                'the offer is not rendered to an anonymous visitor',
            ).toHaveCount(0);
        } finally {
            await anonContext.close();
        }

        // 3. Crucially, the failed anon visit did NOT consume the token: the PUBLIC
        //    preview API still reports it pending — the redirect is a gate, not a spend.
        const stillPending = await request.get(`${API_BASE}/api/claim/preview?token=${token}`);
        expect(stillPending.status(), 'token survives the anon bounce (still pending)').toBe(200);
        expect((await stillPending.json()).role).toBe('manager');
    });

    test('locale-prefix equivalence: /en/claim/<token> and /claim/<token> render the same offer', async ({
        request,
        page,
        baseURL,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId, workName } = await freshOwnerWork(
            request,
            'Claim Landing Locale',
        );
        const { token } = await issueInvitation(request, ownerToken, workId, {
            role: 'viewer',
            email: `locale-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const headingRe = new RegExp(`You're invited to ${escapeRe(workName)}`, 'i');

        // next-intl localePrefix:'never' → /en/claim/<token> 307s to /claim/<token>.
        // page.goto follows the redirect; the final landing URL is the unprefixed one
        // and the offer renders identically.
        await gotoClaim(page, `${origin}/en/claim/${token}`);
        await expect(
            page.getByRole('heading', { name: headingRe }),
            '/en-prefixed claim renders the offer',
        ).toBeVisible({ timeout: 30_000 });
        expect(page.url(), 'the /en prefix is stripped to the unprefixed route').not.toMatch(
            /\/en\/claim\//,
        );

        // The unprefixed route renders the SAME offer for the SAME token.
        await gotoClaim(page, `${origin}/claim/${token}`);
        await expect(
            page.getByRole('heading', { name: headingRe }),
            'unprefixed claim renders the same offer',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(/Role on accept:/i).first(),
            'unprefixed route also shows the member role line',
        ).toBeVisible({ timeout: 20_000 });

        // The token is read-only across both renders — preview is still pending.
        const preview = await request.get(`${API_BASE}/api/claim/preview?token=${token}`);
        expect(preview.status(), 'rendering the landing page never consumes the token').toBe(200);
        expect((await preview.json()).role).toBe('viewer');
    });

    test('member offer card pins the conditional sub-blocks: expiry shown, provider+upstream absent', async ({
        request,
        page,
        baseURL,
    }) => {
        const origin = appOrigin(baseURL);
        const { ownerToken, workId, workName } = await freshOwnerWork(
            request,
            'Claim Landing Conditional',
        );
        // Read the real preview so the rendered expiry/role match the API truth.
        const { token } = await issueInvitation(request, ownerToken, workId, {
            role: 'manager',
            email: `cond-${uniqueSuffix()}@test.local`,
            expiresInDays: 7,
        });
        const previewRes = await request.get(`${API_BASE}/api/claim/preview?token=${token}`);
        expect(previewRes.status()).toBe(200);
        const preview = await previewRes.json();
        expect(preview.role).toBe('manager');
        expect(preview.expectedProviderUsername, 'member invite has no provider gate').toBeNull();
        expect(preview.sourceUrl, 'non-sourced work has no upstream url').toBeNull();
        expect(
            new Date(preview.expiresAt).getTime(),
            'expiry is a real future time',
        ).toBeGreaterThan(Date.now());

        await gotoClaim(page, `${origin}/en/claim/${token}`);
        await expect(
            page.getByRole('heading', {
                name: new RegExp(`You're invited to ${escapeRe(workName)}`, 'i'),
            }),
            'member offer heading',
        ).toBeVisible({ timeout: 30_000 });

        // PRESENT for a member offer: the role line + an "Expires <localeString>" line.
        await expect(page.getByText(/Role on accept:/i).first(), 'role line present').toBeVisible({
            timeout: 20_000,
        });
        const expiry = page.getByText(/^Expires /i).first();
        await expect(expiry, 'expiry line present').toBeVisible({ timeout: 20_000 });
        // The rendered expiry reflects a real localized date string (digits + year).
        await expect(expiry).toContainText(/\d/);

        // ABSENT for a non-sourced member offer: the owner-claim provider-gate copy,
        // the transfer button, and the upstream link — all conditional sub-blocks the
        // page only renders for owner-claim / sourced works.
        await expect(
            page.getByText(/Sign in with the account linked to/i),
            'no provider-gate copy on a member offer',
        ).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: /Accept and start transfer/i }),
            'no transfer button on a member offer',
        ).toHaveCount(0);
        await expect(
            page.getByText(/Upstream:/i),
            'no upstream link when sourceUrl is null',
        ).toHaveCount(0);
        // The actionable button for a member offer is the plain "Accept invitation".
        await expect(
            page.getByRole('button', { name: /Accept invitation/i }),
            'member offer exposes the plain accept button',
        ).toBeVisible({ timeout: 20_000 });
    });
});

/** Escape a dynamic string for safe embedding inside a RegExp. */
function escapeRe(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
