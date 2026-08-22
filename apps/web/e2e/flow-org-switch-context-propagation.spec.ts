import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';
import {
    createOrganizationViaAPI,
    gotoDashboardWithSwitcher,
    listOrganizationsViaAPI,
    selectOrganizationInSwitcher,
} from './helpers/organizations';

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
 * THE REAL SWITCH MECHANISM:
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
 *   - The switcher POSTs the chosen slug to `/api/users/me/scope`; the API
 *     validates ownership and persists `users.lastScopeOrganizationId`.
 *   - The active scope is resolved SERVER-SIDE by ScopeResolverMiddleware
 *     plus SessionScopeGuard:
 *       1. `X-Scope-Slug: <orgSlug>` request header for explicit API clients.
 *       2. else the first `/{slug}/...` URL path segment.
 *       3. else SessionScopeGuard seeds the persisted Organization scope.
 *     An UNKNOWN slug in X-Scope-Slug -> middleware throws NotFoundException
 *     -> 404. A slug belonging to ANOTHER tenant -> resolves, but the
 *     ScopeOwnershipGuard rejects it for this user -> 403.
 *
 *   - Explicit `X-Scope-Slug` remains supported for API clients, but the real
 *     browser switch no longer relies on synthetic localStorage plumbing.
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
 * UI flow; unique Date.now suffixes; assert toContain/membership,
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

interface ActiveScope {
    tenantId: string | null;
    organizationId: string | null;
    organizationSlug: string | null;
}

async function setActiveScope(
    request: APIRequestContext,
    token: string,
    organizationSlug: string | null,
): Promise<ActiveScope> {
    const response = await request.post(`${API_BASE}/api/users/me/scope`, {
        headers: authedHeaders(token),
        data: { organizationSlug },
    });
    expect(response.status(), `set scope body=${await response.text().catch(() => '')}`).toBe(200);
    return response.json();
}

async function getActiveScope(request: APIRequestContext, token: string): Promise<ActiveScope> {
    const response = await request.get(`${API_BASE}/api/users/me/scope`, {
        headers: authedHeaders(token),
    });
    expect(response.status(), `get scope body=${await response.text().catch(() => '')}`).toBe(200);
    return response.json();
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

    test('selected Organization persists across a fresh login and stamps headerless writes', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
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

        const selected = await setActiveScope(request, user.access_token, orgB.slug);
        expect(selected).toEqual({
            tenantId: orgB.tenantId,
            organizationId: orgB.id,
            organizationSlug: orgB.slug,
        });

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

        expect(await getActiveScope(request, freshToken)).toEqual(selected);

        // No X-Scope-Slug: SessionScopeGuard must seed the persisted scope.
        const wB = await createWorkUnderScope(request, freshToken, null, 'persist-B-headerless');
        expect(wB.organizationId).toBe(orgB.id);
        expect(wB.tenantId).toBe(orgB.tenantId);
    });

    test('unknown and foreign scope selection fail closed without changing the persisted Organization', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const owned = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `Owned ${Date.now()}`,
        );
        await setActiveScope(request, owner.access_token, owned.slug);

        const unknown = await request.post(`${API_BASE}/api/users/me/scope`, {
            headers: authedHeaders(owner.access_token),
            data: { organizationSlug: `unknown-${Date.now().toString(36)}` },
        });
        expect(unknown.status()).toBe(404);
        expect(await getActiveScope(request, owner.access_token)).toMatchObject({
            organizationId: owned.id,
            organizationSlug: owned.slug,
        });

        const stranger = await registerUserViaAPI(request);
        const foreign = await createOrganizationViaAPI(
            request,
            stranger.access_token,
            `Foreign ${Date.now()}`,
        );
        const rejected = await request.post(`${API_BASE}/api/users/me/scope`, {
            headers: authedHeaders(owner.access_token),
            data: { organizationSlug: foreign.slug },
        });
        expect(rejected.status()).toBe(404);
        expect(await getActiveScope(request, owner.access_token)).toMatchObject({
            organizationId: owned.id,
            organizationSlug: owned.slug,
        });
    });

    test('real WorkspaceSwitcher click persists, safely resolves the slug URL, and governs a headerless write', async ({
        browser,
        request,
        baseURL,
    }) => {
        test.setTimeout(120_000);
        const fresh = await registerUserViaAPI(request);
        const token = fresh.access_token;
        await request
            .post(`${API_BASE}/api/onboarding/dismiss`, { headers: authedHeaders(token) })
            .catch(() => {});
        const orgA = await createOrganizationViaAPI(request, token, `UI A ${Date.now()}`);
        const orgB = await createOrganizationViaAPI(request, token, `UI B ${Date.now()}`);
        await setActiveScope(request, token, orgA.slug);

        const context: BrowserContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: fresh.email, password: fresh.password });
            await gotoDashboardWithSwitcher(page, baseURL);

            const persistedRequest = page.waitForRequest(
                (candidate) =>
                    candidate.method() === 'POST' &&
                    new URL(candidate.url()).pathname === '/api/users/me/scope',
            );
            const compatibilityNavigation = page.waitForRequest(
                (candidate) =>
                    candidate.method() === 'GET' &&
                    new URL(candidate.url()).pathname === `/${orgB.slug}/dashboard`,
            );
            await selectOrganizationInSwitcher(page, orgB.displayName);

            expect((await persistedRequest).postDataJSON()).toEqual({
                organizationSlug: orgB.slug,
            });
            await compatibilityNavigation;
            await expect(page).toHaveURL(/\/$/, { timeout: 90_000 });
            await expect(
                page
                    .getByRole('button', { name: 'Switch Organization' })
                    .getByText(orgB.displayName),
            ).toBeVisible();

            expect(await getActiveScope(request, token)).toMatchObject({
                organizationId: orgB.id,
                organizationSlug: orgB.slug,
            });
            const scoped = await createWorkUnderScope(request, token, null, 'ui-real-switch');
            expect(scoped.organizationId).toBe(orgB.id);
            expect(scoped.organizationId).not.toBe(orgA.id);
        } finally {
            await context.close();
        }
    });
});
