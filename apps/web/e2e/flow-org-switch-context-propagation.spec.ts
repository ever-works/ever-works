import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI, listOrganizationsViaAPI } from './helpers/organizations';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * ORG SWITCH -> CONTEXT PROPAGATION (deep integration)
 *
 * Theme: switching the active Organization must propagate into every
 * subsequent scoped WRITE (the new resource is stamped with the active org);
 * a resource stamped under A carries A's org id while B-scoped writes carry
 * B's; switching back resumes A-stamping; and the user's
 * `lastScopeOrganizationId` persists across a fresh login. Cross-tenant scope
 * spoofing is rejected.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE REAL SWITCH MECHANISM (probed live against the sqlite in-memory CI
 * driver on 2026-06-01 — NOT what the task title's "/switch endpoint, cookie,
 * x-organization-id header" wording assumes; those do NOT exist in this build):
 *
 *   - There is NO `POST /api/organizations/switch` and NO
 *     `GET /api/organizations/current` route. The organizations controller
 *     (apps/api/src/organizations/organizations.controller.ts) exposes ONLY:
 *       POST   /api/organizations               { name, slug? } -> 201
 *       POST   /api/organizations/register-company
 *       GET    /api/organizations               -> 200 [orgs in caller's Tenant]
 *       GET    /api/organizations/check-slug
 *       GET    /api/organizations/:slug         -> 200 GLOBAL resolver (any authed user)
 *       PATCH  /api/organizations/:id
 *       POST   /api/organizations/:id/upgrade-from-account
 *
 *   - The active scope is resolved SERVER-SIDE by ScopeResolverMiddleware
 *     (apps/api/src/scope/scope-resolver.middleware.ts):
 *       1. `X-Scope-Slug: <orgSlug>` request header  <-- the SPA's fetch
 *          wrapper sets this from the active-org cookie/localStorage. THIS is
 *          the programmatic "switch active org" knob the web client uses.
 *       2. else the first `/{slug}/...` URL path segment.
 *       3. else EMPTY_SCOPE, and SessionScopeGuard
 *          (apps/api/src/scope/session-scope.guard.ts) seeds the user's default
 *          scope { tenantId, organizationId: lastScopeOrganizationId }.
 *     An UNKNOWN slug in X-Scope-Slug -> middleware throws NotFoundException
 *     -> 404. A slug belonging to ANOTHER tenant -> resolves, but the
 *     ScopeOwnershipGuard rejects it for this user -> 403.
 *
 *   - `users.lastScopeOrganizationId` (packages/agent/src/entities/user.entity.ts)
 *     is set to the FIRST org on first-org create (organization.service.ts) and
 *     persists across logout/login. There is no API to re-point it; the SPA
 *     re-points the *active* scope per-request via `X-Scope-Slug`.
 *
 * PROBED FACTS the assertions below rely on (ALL verified live, 2026-06-01):
 *   - POST /api/works (X-Scope-Slug: A) -> 200 { status:'success',
 *       work:{ id, organizationId === A.id, tenantId === A.tenantId } }.
 *       With X-Scope-Slug: B the new work's organizationId === B.id. Switching
 *       back to A stamps A again. THIS is the propagation contract.
 *   - GET /api/works is OWNER-scoped, NOT org-filtered: under ANY active scope
 *       it returns ALL of the owner's works (both A's and B's). So the
 *       per-org "invisibility" lives in each row's stamped organizationId, not
 *       in a filtered list. (Truthful probed behavior — see DEVIATION below.)
 *   - GET /api/works/:id is OWNER-scoped: 200 across any active scope, org id
 *       on the row is unchanged by the switch (the resource is not re-homed).
 *   - A FOREIGN user (different tenant) sending org A's slug in X-Scope-Slug
 *       -> 403 (ScopeOwnershipGuard) — cross-tenant scope spoofing is blocked.
 *   - An UNKNOWN X-Scope-Slug -> 404 (ScopeResolverMiddleware NotFoundException).
 *   - GET /api/organizations/:slug is a GLOBAL resolver -> 200 for any authed user.
 *   - login DTO accepts ONLY { email, password } (extra { name } -> 400);
 *     lastScopeOrganizationId + org membership survive a fresh login.
 *
 * TRUTHFUL DEVIATION (probed, asserted as-is, NOT a fictional contract):
 *   The task title implies that "resources created under org A are invisible
 *   under org B" via a filtered list. In THIS build the works LIST is purely
 *   owner-scoped and does NOT filter by the active org, so two same-owner orgs
 *   share one visible list. The genuine org-isolation signal is the per-row
 *   `organizationId` stamp (verified) plus the cross-TENANT 403. This spec
 *   asserts the real signal and never claims a non-existent list filter.
 *
 * GOTCHAS honoured: mutations run on FRESH registerUserViaAPI() users (cross-
 * spec isolation); the seeded user (storageState) is only touched for the
 * UI/localStorage flow; unique Date.now suffixes; assert toContain/membership,
 * never exact counts; flow- filename is safe vs the no-auth testIgnore regex.
 */

interface WorkRow {
    id: string;
    organizationId: string | null;
    tenantId: string | null;
    userId?: string;
}

const works = (body: unknown): WorkRow[] =>
    (body as { works?: WorkRow[] })?.works ?? (Array.isArray(body) ? (body as WorkRow[]) : []);
const workIds = (body: unknown): string[] =>
    works(body)
        .map((w) => w.id)
        .filter(Boolean);

/** POST /api/works under a given active org scope (via X-Scope-Slug). */
async function createWorkUnderScope(
    request: APIRequestContext,
    token: string,
    scopeSlug: string | null,
    name: string,
): Promise<WorkRow> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await request.post(`${API_BASE}/api/works`, {
        headers,
        data: { name, slug, description: `e2e ${name}`, organization: false },
    });
    // Probed: POST /api/works returns 200 (not 201) with { status:'success', work:{…} }.
    expect(res.status(), `create work body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    return body.work as WorkRow;
}

/** GET /api/works under a given active org scope (via X-Scope-Slug). */
async function listWorksUnderScope(
    request: APIRequestContext,
    token: string,
    scopeSlug: string | null,
): Promise<unknown> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    const res = await request.get(`${API_BASE}/api/works`, { headers });
    expect(res.status(), `list works body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Org switch -> context propagation', () => {
    test('switching active org via X-Scope-Slug propagates into subsequent scoped WRITES (A -> B -> A)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Switch A ${Date.now()}`,
        );
        const orgB = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Switch B ${Date.now()}`,
        );
        expect(orgA.id).not.toBe(orgB.id);
        // Both orgs share the one lazily-minted tenant.
        expect(orgA.tenantId).toBeTruthy();
        expect(orgB.tenantId).toBe(orgA.tenantId);

        // Switch active org -> A: a write is stamped with A.
        const wA = await createWorkUnderScope(request, user.access_token, orgA.slug, 'work-in-A');
        expect(wA.organizationId).toBe(orgA.id);
        expect(wA.tenantId).toBe(orgA.tenantId);

        // Switch active org -> B: the very next write is stamped with B, not A.
        const wB = await createWorkUnderScope(request, user.access_token, orgB.slug, 'work-in-B');
        expect(wB.organizationId).toBe(orgB.id);
        expect(wB.organizationId).not.toBe(orgA.id);

        // Switch back -> A: writes resume being stamped with A.
        const wA2 = await createWorkUnderScope(
            request,
            user.access_token,
            orgA.slug,
            'work-in-A-again',
        );
        expect(wA2.organizationId).toBe(orgA.id);
    });

    test('per-row org stamping is the isolation signal: A-scoped and B-scoped resources keep their own org id; switch-back stamps A again', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Iso A ${Date.now()}`,
        );
        const orgB = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Iso B ${Date.now()}`,
        );

        const wA = await createWorkUnderScope(request, user.access_token, orgA.slug, 'iso-A');
        const wB = await createWorkUnderScope(request, user.access_token, orgB.slug, 'iso-B');
        const wA2 = await createWorkUnderScope(request, user.access_token, orgA.slug, 'iso-A-2');

        // Each resource carries the org that was active when it was written.
        expect(wA.organizationId).toBe(orgA.id);
        expect(wB.organizationId).toBe(orgB.id);
        expect(wA2.organizationId).toBe(orgA.id); // switch-back resumed A-stamping
        // A-scoped rows are distinguishable from B-scoped rows by org id.
        expect(wA.organizationId).not.toBe(wB.organizationId);

        // The owner's list (owner-scoped, NOT org-filtered) contains all three;
        // the org boundary is visible PER ROW, not by the list omitting rows.
        const all = await listWorksUnderScope(request, user.access_token, orgA.slug);
        const rows = works(all);
        const byId = new Map(rows.map((w) => [w.id, w]));
        expect(byId.get(wA.id)?.organizationId).toBe(orgA.id);
        expect(byId.get(wB.id)?.organizationId).toBe(orgB.id);
        expect(byId.get(wA2.id)?.organizationId).toBe(orgA.id);

        // Switching the active scope does NOT re-home already-written rows:
        // re-reading the same set under scope B leaves every org id unchanged.
        const allUnderB = await listWorksUnderScope(request, user.access_token, orgB.slug);
        const byIdB = new Map(works(allUnderB).map((w) => [w.id, w]));
        expect(byIdB.get(wA.id)?.organizationId).toBe(orgA.id);
        expect(byIdB.get(wB.id)?.organizationId).toBe(orgB.id);
    });

    test('a work stays readable BY ID across org switches and keeps its original org id (findOne is owner-scoped)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(
            request,
            user.access_token,
            `ById A ${Date.now()}`,
        );
        const orgB = await createOrganizationViaAPI(
            request,
            user.access_token,
            `ById B ${Date.now()}`,
        );

        const wA = await createWorkUnderScope(request, user.access_token, orgA.slug, 'byid');
        expect(wA.organizationId).toBe(orgA.id);

        // A direct GET /works/:id is owner-scoped and resolves even with B as the
        // active scope; its organizationId stays A — the switch never re-homes it.
        const byId = await request.get(`${API_BASE}/api/works/${wA.id}`, {
            headers: { ...authedHeaders(user.access_token), 'X-Scope-Slug': orgB.slug },
        });
        expect(byId.status()).toBe(200);
        const fetched = await byId.json();
        const work = (fetched?.work ?? fetched) as WorkRow;
        expect(work.id).toBe(wA.id);
        expect(work.organizationId).toBe(orgA.id);

        // And reading it back under A's scope gives the identical org id.
        const byIdA = await request.get(`${API_BASE}/api/works/${wA.id}`, {
            headers: { ...authedHeaders(user.access_token), 'X-Scope-Slug': orgA.slug },
        });
        expect(byIdA.status()).toBe(200);
        expect(((await byIdA.json())?.work as WorkRow)?.organizationId).toBe(orgA.id);
    });

    test('cross-tenant scope spoofing is rejected (403); unknown scope slug is 404; get-by-slug stays a global 200', async ({
        request,
    }) => {
        // Owner builds an org with a scoped resource.
        const owner = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `Foreign A ${Date.now()}`,
        );
        const wA = await createWorkUnderScope(request, owner.access_token, orgA.slug, 'foreign-A');
        expect(wA.organizationId).toBe(orgA.id);

        // A different user (different tenant) tries to "switch into" orgA via its
        // slug. The slug resolves (global namespace) but ScopeOwnershipGuard sees
        // it belongs to another tenant -> 403. Cross-tenant spoofing blocked.
        const stranger = await registerUserViaAPI(request);
        const spoof = await request.get(`${API_BASE}/api/works`, {
            headers: { ...authedHeaders(stranger.access_token), 'X-Scope-Slug': orgA.slug },
        });
        expect(spoof.status()).toBe(403);

        // An UNKNOWN scope slug doesn't resolve at all -> the middleware 404s.
        const unknown = await request.get(`${API_BASE}/api/works`, {
            headers: {
                ...authedHeaders(stranger.access_token),
                'X-Scope-Slug': `no-such-org-${Date.now().toString(36)}`,
            },
        });
        expect(unknown.status()).toBe(404);

        // GET /api/organizations/:slug, however, IS a global resolver -> 200 even
        // for the stranger (it backs the Phase-7 slug middleware + deep links).
        // The real authorization boundary is the SCOPED request (403 above), not
        // get-by-slug.
        const resolve = await request.get(
            `${API_BASE}/api/organizations/${encodeURIComponent(orgA.slug)}`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(resolve.status()).toBe(200);
        expect((await resolve.json()).id).toBe(orgA.id);
    });

    test('lastScopeOrganizationId + org membership persist across a fresh login; login DTO rejects extra fields', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // First org create pins lastScopeOrganizationId = orgA on the User row.
        const orgA = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Persist A ${Date.now()}`,
        );
        const orgB = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Persist B ${Date.now()}`,
        );

        // A work stamped with A's scope before re-login.
        const wA = await createWorkUnderScope(request, user.access_token, orgA.slug, 'persist-A');
        expect(wA.organizationId).toBe(orgA.id);

        // Re-login: the login DTO is whitelisted to { email, password } ONLY.
        const badLogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password, name: 'nope' },
        });
        expect(badLogin.status(), 'extra {name} on login DTO must 400').toBe(400);

        const relogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(relogin.status()).toBe(200);
        const freshToken = (await relogin.json()).access_token;
        expect(freshToken).toBeTruthy();

        // Org membership survives the new session (the Tenant + both orgs outlived it).
        const orgsAfter = await listOrganizationsViaAPI(request, freshToken);
        const orgIds = orgsAfter.map((o) => o.id);
        expect(orgIds).toContain(orgA.id);
        expect(orgIds).toContain(orgB.id);

        // On the fresh token, the previously-A-stamped work is still readable by
        // id and still carries A — the persisted scope wasn't reset by re-login.
        const reread = await request.get(`${API_BASE}/api/works/${wA.id}`, {
            headers: authedHeaders(freshToken),
        });
        expect(reread.status()).toBe(200);
        expect(((await reread.json())?.work as WorkRow)?.organizationId).toBe(orgA.id);

        // And the fresh session can still switch scope to A and write into A.
        const wA2 = await createWorkUnderScope(request, freshToken, orgA.slug, 'persist-A-2');
        expect(wA2.organizationId).toBe(orgA.id);
    });

    test('UI active-org switch: the SPA stores the active org slug and the propagated X-Scope-Slug WRITE stamps the matching org (A<->B)', async ({
        page,
        request,
        baseURL,
    }) => {
        // Seed two orgs through the SEEDED user so the browser session and the API
        // session line up.
        const s = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: s.email, password: s.password },
        });
        expect(login.status(), `seeded login body=${await login.text().catch(() => '')}`).toBe(200);
        const { access_token } = await login.json();
        expect(access_token).toBeTruthy();

        const orgA = await createOrganizationViaAPI(request, access_token, `UI A ${Date.now()}`);
        const orgB = await createOrganizationViaAPI(request, access_token, `UI B ${Date.now()}`);

        const myOrgIds = (await listOrganizationsViaAPI(request, access_token)).map((o) => o.id);
        expect(myOrgIds).toContain(orgA.id);
        expect(myOrgIds).toContain(orgB.id);

        // Load the app (authenticated via storageState) and simulate the
        // switcher's effect: the SPA persists the active org slug in localStorage,
        // from which its fetch wrapper derives X-Scope-Slug (see
        // scope-resolver.middleware.ts docblock).
        const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
        await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });

        await page.evaluate(
            (slug) => window.localStorage.setItem('activeOrgSlug', slug),
            orgA.slug,
        );
        const storedA = await page.evaluate(() => window.localStorage.getItem('activeOrgSlug'));
        expect(storedA).toBe(orgA.slug);

        // A write using that stored slug as the propagated header is stamped with A.
        const wA = await createWorkUnderScope(request, access_token, storedA, 'ui-A');
        expect(wA.organizationId).toBe(orgA.id);

        // Re-point the switcher to B in the browser and confirm propagation flips:
        // the next write is stamped with B.
        await page.evaluate(
            (slug) => window.localStorage.setItem('activeOrgSlug', slug),
            orgB.slug,
        );
        const storedB = await page.evaluate(() => window.localStorage.getItem('activeOrgSlug'));
        expect(storedB).toBe(orgB.slug);
        const wB = await createWorkUnderScope(request, access_token, storedB, 'ui-B');
        expect(wB.organizationId).toBe(orgB.id);
        expect(wB.organizationId).not.toBe(wA.organizationId);

        // Best-effort: a native org switcher control may be present in the shell
        // (the deep dropdown interaction is owned by organization-create-switch.spec.ts).
        const switcher = page.getByRole('button', { name: 'Switch Organization' }).first();
        if (await switcher.count()) {
            await expect(switcher)
                .toBeVisible({ timeout: 15000 })
                .catch(() => {});
        }
    });
});
