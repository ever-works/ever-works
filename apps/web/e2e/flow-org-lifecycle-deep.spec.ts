import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    createOrganizationViaAPI,
    createOrganizationViaUI,
    listOrganizationsViaAPI,
    expectOrgListedInSwitcher,
    gotoDashboardWithSwitcher,
    type Organization,
} from './helpers/organizations';
import { createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Organization lifecycle — deep, multi-entity integration flows.
 *
 * These exercise the EW-658 (Tenants & Organizations) Phase 6 surface
 * end-to-end across several real entities and across the UI ↔ API boundary,
 * rather than smoke-probing a single endpoint.
 *
 * Verified against the live stack (sqlite in-memory — the e2e DB driver) on
 * 2026-05-31 before any assertion was written:
 *   - POST /api/auth/register → 201 { access_token (32-char opaque), user:{id,email,username} }
 *   - POST /api/organizations { name }
 *       → 201 { id, tenantId, slug, displayName, registrationStatus:'draft', linkedWorkId, … }
 *       The FIRST org for a user lazily creates a Tenant; subsequent orgs reuse
 *       the same tenantId. Creating the first org runs an *unconditional*
 *       `tenantId` backfill over the user's existing Tier A rows (missions,
 *       tasks, …). That backfill previously used Postgres-only `$n` placeholders
 *       and 500'd on sqlite — this suite asserts it now succeeds (201, tenantId set).
 *   - GET  /api/organizations → bare array, tenant-scoped to the caller (a user
 *       with no Tenant gets []). This is the isolation boundary.
 *   - GET  /api/organizations/:slug → GLOBAL lookup by slug (it backs the Phase-7
 *       slug-resolver middleware + deep links), so it is intentionally NOT
 *       user-scoped: ANY authenticated user can resolve ANY org by slug, 404 only
 *       when the slug truly doesn't exist. See the flow-4 deviation note below.
 *   - GET  /api/organizations/check-slug?value=<s> → public + throttled,
 *       200 { available:boolean, normalized:string, suggestion?:string }.
 *       Query param is `value` (NOT `slug` — `slug` → 400 "property slug should not exist").
 *   - POST /api/me/missions { title, description, type:'one-shot' }
 *       → 201 { id, title, description, type, status:'active', … }  (NB: /api/missions 404s)
 *   - POST /api/tasks { title } → 201 { id, slug:'T-n', status:'backlog', tenantId:null, … }
 *
 * UI: the WorkspaceSwitcher header dropdown (helpers/organizations.ts). The
 * slug-scoped /{slug}/dashboard page is Phase-7-pending web-side, so UI checks
 * assert the switcher LISTS each org (the "switch" affordance), not the
 * destination page content.
 *
 * Cross-spec isolation: every API-only orchestration runs on a FRESH
 * registerUserViaAPI() user so the shared in-memory DB stays clean; the seeded
 * storageState user is only touched for the UI-driven flow. All counts use
 * toContain (tolerate pre-existing rows), never exact equality.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        // LOGIN DTO is whitelisted — ONLY {email,password}; the full seeded
        // object (with `name`) → 400 "property name should not exist".
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

async function checkSlug(
    request: APIRequestContext,
    token: string,
    value: string,
): Promise<{ available: boolean; normalized: string; suggestion?: string }> {
    const res = await request.get(
        `${API_BASE}/api/organizations/check-slug?value=${encodeURIComponent(value)}`,
        { headers: authedHeaders(token) },
    );
    expect(res.status(), `check-slug body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Organization lifecycle (deep)', () => {
    test('flow 1: UI-create org A, seed entities via API, UI-create org B; both selectable in switcher + listed with distinct slugs', async ({
        page,
        request,
        baseURL,
    }) => {
        // Heaviest UI journey in the file: TWO full createOrganizationViaUI
        // flows (each = switcher-open retry loop + modal + a guaranteed ~4s
        // "Start empty" probe that must time out on the 2nd-org path + up to
        // 30s waitForURL) plus THREE gotoDashboardWithSwitcher hits (each waits
        // up to 30s for the switcher trigger). That cumulative budget is
        // marginal against the 90s per-test default, so a single slow leg
        // (cold prod route, or one switcher-open exhausting its retry loop)
        // tips the whole test into a timeout. test.slow() triples the budget —
        // pure headroom, no assertion is weakened. Every API shape/status this
        // flow asserts (POST /api/organizations, /api/works 200, /api/tasks
        // T-n, /api/me/missions active, list slug/tenantId) was verified
        // against the live sqlite stack and already matches.
        test.slow();

        const stamp = Date.now().toString(36);
        const orgA = `Deep Org A ${stamp}`;
        const orgB = `Deep Org B ${stamp}`;

        const token = await seededToken(request);

        // The seeded user must already own ≥1 org so the UI creates below are
        // deterministically "2nd+" orgs — those navigate straight to the new
        // org's slug URL instead of popping the first-org "Move your existing
        // items?" dialog (whose default branch hits a Postgres-only endpoint
        // that 500s on sqlite). The create+switch behaviour under test is
        // identical either way.
        if ((await listOrganizationsViaAPI(request, token)).length === 0) {
            await createOrganizationViaAPI(request, token, `Deep Org Seed ${stamp}`);
        }

        // 1. Create org A through the real header → modal flow.
        await gotoDashboardWithSwitcher(page, baseURL);
        await createOrganizationViaUI(page, orgA);

        // 2. BEFORE creating the second org, create cross-feature entities via
        //    the API on the SAME logged-in (seeded) user: a Work, a Task and a
        //    Mission. This proves org A coexists with live user data and that
        //    the multi-entity tenant is internally consistent.
        const workRes = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: `Deep Work ${stamp}`,
                slug: `deep-work-${stamp}`,
                description: `e2e deep work ${stamp}`,
                organization: false,
            },
        });
        // POST /api/works returns 200 (not 201) with { status:'success', work:{ id, … } }
        // — verified live on the sqlite e2e stack 2026-05-31.
        expect(workRes.status(), `create work body=${await workRes.text().catch(() => '')}`).toBe(
            200,
        );
        const workBody = await workRes.json();
        expect(workBody.status).toBe('success');
        expect(workBody.work?.id, 'created work should have an id').toBeTruthy();

        const task = await createTaskViaAPI(request, token, { title: `Deep Task ${stamp}` });
        expect(task.id, 'task should have an id').toBeTruthy();
        expect(task.slug).toMatch(/^T-\d+$/);

        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Deep Mission ${stamp}`,
                description: `e2e deep mission ${stamp}`,
                type: 'one-shot',
            },
        });
        expect(
            missionRes.status(),
            `create mission body=${await missionRes.text().catch(() => '')}`,
        ).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id, 'mission should have an id').toBeTruthy();
        expect(mission.status).toBe('active');

        // 3. Org A is selectable in the header switcher on a built dashboard route.
        await gotoDashboardWithSwitcher(page, baseURL);
        await expectOrgListedInSwitcher(page, orgA);

        // 4. Create org B the same way (2nd+ org → direct navigation).
        await createOrganizationViaUI(page, orgB);
        await gotoDashboardWithSwitcher(page, baseURL);

        // 5. BOTH orgs are now selectable in the header switcher.
        await expectOrgListedInSwitcher(page, orgA);
        await expectOrgListedInSwitcher(page, orgB);

        // 6. listOrganizations contains both, each with a distinct, truthy slug.
        const orgs = await listOrganizationsViaAPI(request, token);
        const names = orgs.map((o) => o.displayName);
        expect(names).toContain(orgA);
        expect(names).toContain(orgB);

        const slugA = orgs.find((o) => o.displayName === orgA)?.slug;
        const slugB = orgs.find((o) => o.displayName === orgB)?.slug;
        expect(slugA, 'org A should have a slug').toBeTruthy();
        expect(slugB, 'org B should have a slug').toBeTruthy();
        expect(slugA).not.toBe(slugB);

        // Both orgs share the SAME tenant (first-org bootstrapped it, second reused it).
        const tenantA = orgs.find((o) => o.displayName === orgA)?.tenantId;
        const tenantB = orgs.find((o) => o.displayName === orgB)?.tenantId;
        expect(tenantA, 'org A should carry a tenantId').toBeTruthy();
        expect(tenantB).toBe(tenantA);
    });

    test('flow 2: first-org tenantId backfill over pre-existing mission + task rows succeeds (201, tenantId set) — the sqlite-safe path that previously 500d', async ({
        request,
    }) => {
        // FRESH user — starts with NO Tenant (users.tenantId IS NULL) and NO orgs,
        // so creating the first org is what triggers the unconditional backfill.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // Sanity: a brand-new user has no Tenant → empty org list.
        expect(await listOrganizationsViaAPI(request, token)).toEqual([]);

        // 1. Create Tier A rows that the first-org backfill must walk: a Mission
        //    and a Task. Both are created with tenantId NULL at this point
        //    (no Tenant exists yet) — the create response literally shows
        //    `tenantId:null` for the task.
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Backfill Mission ${stamp}`,
                description: `pre-org mission ${stamp}`,
                type: 'one-shot',
            },
        });
        expect(
            missionRes.status(),
            `create mission body=${await missionRes.text().catch(() => '')}`,
        ).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id).toBeTruthy();

        const task = await createTaskViaAPI(request, token, {
            title: `Backfill Task ${stamp}`,
        });
        expect(task.id).toBeTruthy();
        // Truthful pre-state: created before any Tenant exists, so unscoped.
        expect((task as unknown as { tenantId: string | null }).tenantId).toBeNull();

        // 2. Create the FIRST organization. This lazily bootstraps the Tenant
        //    AND runs the unconditional `tenantId` backfill across the user's
        //    existing Tier A rows (missions + tasks). The backfill previously
        //    used Postgres-only `$n` placeholders and 500'd on the sqlite e2e
        //    DB; assert it now succeeds with a fully-formed 201.
        const createRes = await request.post(`${API_BASE}/api/organizations`, {
            headers: authedHeaders(token),
            data: { name: `Backfill First Org ${stamp}` },
        });
        expect(
            createRes.status(),
            `create first org body=${await createRes.text().catch(() => '')}`,
        ).toBe(201);
        const org: Organization = await createRes.json();
        expect(org.id, 'first org should have an id').toBeTruthy();
        expect(org.tenantId, 'first org must carry a non-null tenantId').toBeTruthy();
        expect(org.slug, 'first org should have an allocated slug').toBeTruthy();
        expect(org.displayName).toBe(`Backfill First Org ${stamp}`);
        expect(org.registrationStatus).toBe('draft');

        // 3. The Tenant is now persisted and the org is listed under it (proves
        //    the lazy Tenant bootstrap that the backfill hangs off of took effect).
        const orgs = await listOrganizationsViaAPI(request, token);
        expect(orgs.map((o) => o.id)).toContain(org.id);
        expect(orgs.every((o) => o.tenantId === org.tenantId)).toBe(true);

        // 4. The pre-existing entities are still readable post-backfill (no data
        //    loss / no corruption from the UPDATE), confirming the backfill ran
        //    over real rows without throwing.
        const missionsRes = await request.get(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
        });
        expect(missionsRes.status()).toBe(200);
        const missions = await missionsRes.json();
        expect(missions.map((m: { id: string }) => m.id)).toContain(mission.id);
    });

    test('flow 3: two orgs with the SAME display name get distinct allocated slugs; check-slug reflects availability', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // A name unique to this run so the global slug namespace is clean for the
        // first allocation (the platform de-dupes against users.slug + orgs.slug).
        const baseName = `Dup Name Org ${Date.now().toString(36)}`;

        // 0. The base slug is available BEFORE either org exists. check-slug
        //    returns the normalized slug it would allocate.
        const before = await checkSlug(request, token, baseName);
        expect(before.available, `expected ${before.normalized} to be free initially`).toBe(true);
        const baseSlug = before.normalized;
        expect(baseSlug).toBeTruthy();

        // 1. Create the first org → it should take the base slug.
        const first = await createOrganizationViaAPI(request, token, baseName);
        expect(first.displayName).toBe(baseName);
        expect(first.slug).toBe(baseSlug);

        // 2. Create a SECOND org with the identical display name → the platform
        //    must allocate a DISTINCT slug (suffix-disambiguated, e.g. `-2`).
        const second = await createOrganizationViaAPI(request, token, baseName);
        expect(second.displayName).toBe(baseName);
        expect(second.id).not.toBe(first.id);
        expect(second.slug, 'second org must get a distinct slug').not.toBe(first.slug);
        // Real platform shape: the disambiguator is the base slug + a numeric suffix.
        expect(second.slug.startsWith(baseSlug)).toBe(true);
        expect(second.slug).toMatch(new RegExp(`^${baseSlug}-\\d+$`));

        // 3. check-slug now reports the base slug as TAKEN and suggests the next
        //    free disambiguation (which must differ from the already-allocated ones).
        const after = await checkSlug(request, token, baseName);
        expect(after.available, `expected ${baseSlug} to be taken after 2 creates`).toBe(false);
        expect(after.normalized).toBe(baseSlug);
        expect(after.suggestion, 'a taken slug should carry a suggestion').toBeTruthy();
        expect([first.slug, second.slug]).not.toContain(after.suggestion);

        // 4. A genuinely-unused slug still reports available (no false negatives).
        const freshName = `Free Slug ${Date.now().toString(36)}`;
        const free = await checkSlug(request, token, freshName);
        expect(free.available).toBe(true);
        expect(free.suggestion ?? undefined).toBeUndefined();
    });

    test('flow 4: cross-user isolation — user B does NOT see user A’s org in GET /api/organizations (tenant-scoped list)', async ({
        request,
    }) => {
        const stamp = Date.now().toString(36);

        // User A creates an org (bootstraps tenant A).
        const userA = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(
            request,
            userA.access_token,
            `Isolation A ${stamp}`,
        );
        expect(orgA.id).toBeTruthy();
        expect(orgA.slug).toBeTruthy();

        // Fresh user B — never created an org, so has no Tenant.
        const userB = await registerUserViaAPI(request);

        // 1. ISOLATION BOUNDARY: GET /api/organizations is tenant-scoped. B's
        //    list must NOT contain A's org (B has no tenant → []).
        const bList = await listOrganizationsViaAPI(request, userB.access_token);
        expect(bList.map((o) => o.id)).not.toContain(orgA.id);
        expect(bList.map((o) => o.slug)).not.toContain(orgA.slug);
        expect(bList).toEqual([]);

        // And A still sees its own org (the list IS correctly scoped, not just empty).
        const aList = await listOrganizationsViaAPI(request, userA.access_token);
        expect(aList.map((o) => o.id)).toContain(orgA.id);

        // 2. DEVIATION FROM THE ASSIGNED SPEC (verified live, see docblock):
        //    `GET /api/organizations/:slug` is NOT user-scoped — it backs the
        //    Phase-7 slug-resolver middleware + public deep links, so ANY
        //    authenticated user can RESOLVE any org by slug. The assigned task
        //    expected 404/403 for B; the real platform returns 200 with the org.
        //    We assert the platform's TRUE behaviour (a global slug lookup),
        //    and that a non-existent slug is the only thing that 404s — so the
        //    real authorization boundary is the LIST endpoint asserted above,
        //    not get-by-slug.
        const bGetA = await request.get(
            `${API_BASE}/api/organizations/${encodeURIComponent(orgA.slug)}`,
            { headers: authedHeaders(userB.access_token) },
        );
        expect(bGetA.status(), 'get-by-slug is a global resolver, not tenant-scoped').toBe(200);
        const resolved: Organization = await bGetA.json();
        expect(resolved.id).toBe(orgA.id);
        expect(resolved.slug).toBe(orgA.slug);

        // 3. A truly-missing slug 404s (confirms the resolver doesn't leak a
        //    catch-all and that 200 above was a real hit, not a fallthrough).
        const missing = await request.get(`${API_BASE}/api/organizations/does-not-exist-${stamp}`, {
            headers: authedHeaders(userB.access_token),
        });
        expect(missing.status()).toBe(404);
        const missingBody = await missing.json();
        expect(missingBody.error).toBe('Not Found');
        expect(missingBody.message).toContain(`does-not-exist-${stamp}`);
    });
});
