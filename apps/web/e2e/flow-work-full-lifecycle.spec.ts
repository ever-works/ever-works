import { test, expect } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Work full lifecycle — complex, multi-step, cross-feature integration flows
 * for the core Work domain object. Each test() drives several real endpoints
 * (and, where deterministic, the real authenticated UI) and asserts the
 * platform's TRUE, observable behaviour at every step.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   POST   /api/auth/register                  -> { access_token, user:{ id,email,username } }
 *                                                 (username MUST be >= 3 chars)
 *   POST   /api/works                          -> { status:'success', work:{ id,name,slug,status:'active',description,... } }
 *   GET    /api/works                          -> { status:'success', works:[...], total, limit, offset }
 *   GET    /api/works?search=<term>            -> server-side substring filter on name
 *   GET    /api/works/:id (owner, auth)        -> 200 { status:'success', work:{...} }
 *   GET    /api/works/:id (anonymous, no auth) -> 401 { message:'Unauthorized', statusCode:401 }
 *   GET    /api/works/:id (non-owner, auth)    -> 403 { status:'error', message:'You do not have permission to access this work' }
 *   PUT    /api/works/:id                       -> 200 { status:'success', work:{...updated name/description...} }
 *   POST   /api/works/:id/delete               -> 200 { status:'success', slug, message, deleted_repositories:[] }  (HARD delete)
 *   POST   /api/works/:id/delete (non-owner)   -> 403 { status:'error', message:'You do not have permission to access this work' }
 *   GET    /api/works/:id/items                -> { status:'success', items:[] }
 *   GET    /api/works/:id/categories-tags      -> { status:'success', categories:[], tags:[], collections:[] }
 *   GET    /api/works/:id/config               -> { status:'success', config: null }
 *   GET    /api/works/:id/count                -> { status:'success', items:0, categories:0, tags:0 }
 *   GET    /api/works/stats                     -> { totalWorks, totalItems, activeWebsites, generatingCount, totalMissions, totalIdeas }
 *   POST   /api/works/:id/categories           -> 500 (taxonomy persists to the git DATA repo; a default
 *                                                 work has no connected GitHub account in CI/dev)
 *   POST   /api/works/:id/tags                 -> 500 (same git-repo dependency)
 *   POST   /api/works/:id/submit-item          -> 400 { status:'error', message:'Please reconnect your Git account to continue.' }
 *                                                 (after passing DTO validation: name, source_url(URL), category, categories[])
 *
 * UI selectors verified against real source:
 *   /works list search input -> input[placeholder="Search works..."]
 *   list card                -> <a href=".../works/<id>"> containing <h3>{work.name}</h3>  (WorkCard.tsx)
 *   /works/<id> detail       -> <h1>{work.name}</h1>, <p>{work.description}</p>, <code>{work.slug}</code> (WorkHeader.tsx)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS FROM THE LITERAL ASSIGNMENT (real platform constraints):
 *
 *   • Flow 1 ("add items/categories/tags"): the taxonomy + item-submit MUTATION
 *     endpoints persist to a per-Work GIT DATA REPOSITORY. A plain Work created
 *     via POST /api/works has no connected GitHub provider in the e2e stack, so
 *     these writes are git-gated (categories/tags -> 500; submit-item -> 400
 *     "Please reconnect your Git account to continue."). They are NOT
 *     deterministically writable here. The flow therefore drives the full
 *     READ side of the sub-resource contract (items, categories-tags, config,
 *     count) — which IS feasible and well-formed — asserts the work is counted
 *     in /works/stats, and asserts the TRUTHFUL git-gated outcome of the write
 *     endpoints (a real, observable cross-feature behaviour), then renders the
 *     detail UI.
 *
 *   • Flow 2 ("soft-delete/archive ... excluded from active list but retrievable
 *     in archived; restore"): the platform has NO soft-delete / archive / restore
 *     for Works. POST /api/works/:id/delete is a HARD delete
 *     (WorkLifecycleService.deleteWork -> workRepository.delete()). There is no
 *     `status:'archived'` state, no `?status=archived` / `?archived=1` opt-in
 *     listing, and no restore endpoint. The closest REAL flow is implemented:
 *     update name+description (PUT) and prove it propagates to GET + list + UI,
 *     then HARD-delete and assert the genuine post-delete contract — excluded
 *     from the active list, GET -> 404, and NOT recoverable through any archived
 *     view. Ownership-gating of delete (403 for a non-owner) is also asserted.
 *
 *   • Flow 3 ("public visibility ... a published work is reachable on the public
 *     contract while a private one is not"): Works have NO anonymous public
 *     per-Work read contract on the API — every /api/works/:id read requires a
 *     bearer token, and cross-user reads are 403. So the real "private vs not
 *     publicly reachable" posture is asserted: owner reads 200, anonymous reads
 *     401, a different authenticated user reads 403, and the protected /works
 *     dashboard page redirects an unauthenticated browser to /login.
 *
 * ISOLATION: API-only orchestration runs on FRESH registerUserViaAPI() users so
 * the shared in-memory DB stays clean for sibling specs; the seeded user
 * (storageState) is used only for the authenticated UI assertions. Unique
 * name/slug suffixes everywhere; list assertions use toContain (tolerate
 * pre-existing rows), never exact counts.
 */

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('Work full lifecycle — create, sub-resources, update, delete, visibility', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: create a Work, then exercise its sub-resource surface
    //         (items / categories-tags / config / count / stats) and prove the
    //         git-gated write contract, finishing with the detail UI.
    // ───────────────────────────────────────────────────────────────────────
    test('create work + sub-resource read contract + git-gated writes + detail UI', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);

        // Authenticate as the SAME user the browser is logged in as so the
        // API-created Work lands on the UI's seeded account (used for the UI
        // step at the end). Login DTO is whitelisted — email+password ONLY.
        const seeded = loadSeededTestUser();
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(loginRes.ok(), 'seeded user login should succeed').toBeTruthy();
        const { access_token: token } = await loginRes.json();
        expect(token, 'login returns an access token').toBeTruthy();

        const suffix = uniqueSuffix();
        const workName = `Flow Lifecycle Work ${suffix}`;
        const workSlug = `flow-lifecycle-work-${suffix}`;
        const workDescription = `Full-lifecycle sub-resource integration ${suffix}`;

        // --- Step 1: create the Work via the documented contract. ---
        const created = await createWorkViaAPI(request, token, {
            name: workName,
            slug: workSlug,
            description: workDescription,
        });
        expect(created.id, 'created work has an id').toBeTruthy();
        const workId = created.id;

        const createdWork = (created.raw as { work?: { status?: string; slug?: string } }).work;
        expect(createdWork?.status, 'a brand-new work is active').toBe('active');
        expect(createdWork?.slug, 'created slug echoes back').toBe(workSlug);

        // --- Step 2: the sub-resource READ contract. All return a coherent,
        // well-formed empty shape for a fresh work. ---
        const itemsRes = await request.get(`${API_BASE}/api/works/${workId}/items`, {
            headers: authedHeaders(token),
        });
        expect(itemsRes.status(), 'GET /works/:id/items').toBe(200);
        const itemsBody = await itemsRes.json();
        expect(itemsBody.status, 'items envelope').toBe('success');
        expect(Array.isArray(itemsBody.items), 'items is an array').toBe(true);
        expect(itemsBody.items.length, 'fresh work has no items').toBe(0);

        const ctRes = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
            headers: authedHeaders(token),
        });
        expect(ctRes.status(), 'GET /works/:id/categories-tags').toBe(200);
        const ctBody = await ctRes.json();
        expect(ctBody.status, 'categories-tags envelope').toBe('success');
        expect(Array.isArray(ctBody.categories), 'categories is an array').toBe(true);
        expect(Array.isArray(ctBody.tags), 'tags is an array').toBe(true);
        expect(Array.isArray(ctBody.collections), 'collections is an array').toBe(true);

        const configRes = await request.get(`${API_BASE}/api/works/${workId}/config`, {
            headers: authedHeaders(token),
        });
        expect(configRes.status(), 'GET /works/:id/config').toBe(200);
        const configBody = await configRes.json();
        expect(configBody.status, 'config envelope').toBe('success');

        const countRes = await request.get(`${API_BASE}/api/works/${workId}/count`, {
            headers: authedHeaders(token),
        });
        expect(countRes.status(), 'GET /works/:id/count').toBe(200);
        const countBody = await countRes.json();
        expect(countBody.status, 'count envelope').toBe('success');
        expect(countBody.items, 'count.items is 0 for a fresh work').toBe(0);
        expect(countBody.categories, 'count.categories is 0').toBe(0);
        expect(countBody.tags, 'count.tags is 0').toBe(0);

        // --- Step 3: the new work is counted in the account-level stats. ---
        const statsRes = await request.get(`${API_BASE}/api/works/stats`, {
            headers: authedHeaders(token),
        });
        expect(statsRes.status(), 'GET /works/stats').toBe(200);
        const statsBody = await statsRes.json();
        expect(typeof statsBody.totalWorks, 'stats exposes a numeric totalWorks').toBe('number');
        expect(statsBody.totalWorks, 'stats counts at least our new work').toBeGreaterThanOrEqual(
            1,
        );

        // --- Step 4: the sub-resource WRITE endpoints exist but are git-gated.
        // This is the platform's REAL behaviour for a work without a connected
        // GitHub provider: taxonomy + item writes persist to the data repo, so
        // they fail with a deterministic non-2xx (categories/tags -> 500,
        // submit-item -> 400 "reconnect your Git account"). We assert the
        // truthful gate rather than pretending the write succeeded. ---
        const catWrite = await request.post(`${API_BASE}/api/works/${workId}/categories`, {
            headers: authedHeaders(token),
            data: { name: `Cat ${suffix}` },
        });
        expect(
            catWrite.ok(),
            'creating a category on a non-git-connected work is NOT allowed',
        ).toBeFalsy();
        expect(catWrite.status(), 'category write is git-gated (>= 400)').toBeGreaterThanOrEqual(
            400,
        );

        const tagWrite = await request.post(`${API_BASE}/api/works/${workId}/tags`, {
            headers: authedHeaders(token),
            data: { name: `Tag ${suffix}` },
        });
        expect(tagWrite.ok(), 'creating a tag is likewise git-gated').toBeFalsy();
        expect(tagWrite.status(), 'tag write is git-gated (>= 400)').toBeGreaterThanOrEqual(400);

        const itemWrite = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: `Item ${suffix}`,
                description: 'integration item',
                source_url: 'https://example.com',
                category: 'tools',
                categories: ['tools'],
            },
        });
        expect(itemWrite.ok(), 'submit-item is git-gated for a non-git work').toBeFalsy();
        expect(itemWrite.status(), 'submit-item -> 400 (reconnect git)').toBe(400);
        const itemWriteBody = await itemWrite.json();
        expect(itemWriteBody.status, 'submit-item error envelope').toBe('error');
        expect(
            String(itemWriteBody.message),
            'submit-item surfaces the git-reconnect message',
        ).toMatch(/git account/i);

        // The git-gated writes did NOT mutate the read surface — the work is
        // still empty (no partial state leaked through). Counts are cached
        // briefly, so the categories-tags listing is the authoritative re-check.
        const ctAfter = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
            headers: authedHeaders(token),
        });
        const ctAfterBody = await ctAfter.json();
        expect(ctAfterBody.categories.length, 'no category leaked through the failed write').toBe(
            0,
        );
        expect(ctAfterBody.tags.length, 'no tag leaked through the failed write').toBe(0);

        // --- Step 5: the detail UI renders the real work. ---
        // (request shares the seeded session, so the API work belongs to the
        // browser's logged-in account.) Filter the list by the unique suffix.
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });
        const searchInput = page.locator('input[placeholder="Search works..."]').first();
        await expect(searchInput, 'works list search input is present').toBeVisible({
            timeout: 30_000,
        });
        await searchInput.fill(suffix);

        const workCardLink = page.locator(`a[href*="/works/${workId}"]`).first();
        await expect(workCardLink, 'work card appears in filtered list').toBeVisible({
            timeout: 30_000,
        });
        await expect(workCardLink, 'work card shows the work name').toContainText(workName, {
            timeout: 15_000,
        });

        // Navigate via the list card to the detail route. Under `next dev`
        // the WorkCard <Link> can hydrate a beat after it paints, so the first
        // click is occasionally dropped before the client router is wired up.
        // Retry the click until the URL advances to `/works/<id>` (verified
        // live: the authenticated detail route resolves 200 in place, no
        // redirect). Mirrors the breadcrumbs-deep.spec.ts navigate-then-
        // waitForURL pattern.
        await expect(async () => {
            await workCardLink.click();
            await page.waitForURL(new RegExp(`/works/${workId}`), { timeout: 10_000 });
        }).toPass({ timeout: 60_000 });
        await expect(page).toHaveURL(new RegExp(`/works/${workId}`), { timeout: 30_000 });
        await expect(
            page.getByRole('heading', { level: 1, name: workName }),
            'detail page renders the work name as an <h1>',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.locator('code', { hasText: workSlug }).first(),
            'detail page renders the work slug (detail surface)',
        ).toBeVisible({ timeout: 30_000 });
        await expect(page, 'detail page should not redirect to /login').not.toHaveURL(/\/login/);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: update name + description (PUT), prove propagation to GET +
    //         list + UI, then HARD-delete and assert the genuine post-delete
    //         contract (no soft-delete/archive/restore on this platform).
    //         Runs on a FRESH API user for clean DB isolation.
    // ───────────────────────────────────────────────────────────────────────
    test('update work name/description, then hard-delete (no soft-delete/archive/restore)', async ({
        request,
    }) => {
        test.setTimeout(90_000);

        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;

        const suffix = uniqueSuffix();
        const originalName = `Flow Update Work ${suffix}`;
        const originalSlug = `flow-update-work-${suffix}`;
        const created = await createWorkViaAPI(request, token, {
            name: originalName,
            slug: originalSlug,
            description: `original description ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'work created for update flow').toBeTruthy();

        // --- Step 1: update name + description via PUT. ---
        const updatedName = `Flow Update Work RENAMED ${suffix}`;
        const updatedDescription = `updated description ${suffix}`;
        const putRes = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { name: updatedName, description: updatedDescription },
        });
        expect(putRes.status(), 'PUT /works/:id update').toBe(200);
        const putBody = await putRes.json();
        expect(putBody.status, 'update envelope').toBe('success');
        expect(putBody.work?.name, 'PUT response reflects new name').toBe(updatedName);
        expect(putBody.work?.description, 'PUT response reflects new description').toBe(
            updatedDescription,
        );
        // The slug is stable across a name/description update.
        expect(putBody.work?.slug, 'slug is unchanged by a name update').toBe(originalSlug);

        // --- Step 2: the update propagated to GET /works/:id. ---
        const detailRes = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(detailRes.status(), 'GET /works/:id after update').toBe(200);
        const detailBody = await detailRes.json();
        expect(detailBody.work?.name, 'GET reflects updated name').toBe(updatedName);
        expect(detailBody.work?.description, 'GET reflects updated description').toBe(
            updatedDescription,
        );

        // --- Step 3: the update propagated to the search-filtered listing. ---
        const listRes = await request.get(
            `${API_BASE}/api/works?search=${encodeURIComponent(suffix)}`,
            { headers: authedHeaders(token) },
        );
        expect(listRes.status(), 'GET /works?search after update').toBe(200);
        const listBody = await listRes.json();
        const listedNames: string[] = (listBody.works ?? []).map((w: { name: string }) => w.name);
        expect(listedNames, 'list shows the renamed work').toContain(updatedName);
        expect(listedNames, 'list no longer shows the original name').not.toContain(originalName);

        // --- Step 4: ownership-gating — a DIFFERENT user cannot delete it. ---
        const stranger: RegisteredUser = await registerUserViaAPI(request);
        const strangerDelete = await request.post(`${API_BASE}/api/works/${workId}/delete`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(strangerDelete.status(), 'a non-owner cannot delete the work (403)').toBe(403);
        // ...and the work is still there after the rejected delete.
        const stillThere = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(stillThere.status(), 'work survives a non-owner delete attempt').toBe(200);

        // --- Step 5: the OWNER hard-deletes it. ---
        const delRes = await request.post(`${API_BASE}/api/works/${workId}/delete`, {
            headers: authedHeaders(token),
            data: { reason: 'e2e full-lifecycle cleanup' },
        });
        expect(delRes.status(), 'POST /works/:id/delete by owner').toBe(200);
        const delBody = await delRes.json();
        expect(delBody.status, 'delete envelope').toBe('success');
        expect(delBody.slug, 'delete response echoes the slug').toBe(originalSlug);

        // --- Step 6: the genuine post-delete contract (HARD delete). ---
        // 6a. Excluded from the default active listing.
        const listAfter = await request.get(
            `${API_BASE}/api/works?search=${encodeURIComponent(suffix)}`,
            { headers: authedHeaders(token) },
        );
        expect(listAfter.status(), 'GET /works?search after delete').toBe(200);
        const listAfterBody = await listAfter.json();
        const idsAfter: string[] = (listAfterBody.works ?? []).map((w: { id: string }) => w.id);
        expect(idsAfter, 'deleted work is gone from the active listing').not.toContain(workId);

        // 6b. GET by id is 404 (hard delete — never 5xx).
        const detailAfter = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(detailAfter.status(), 'GET on a deleted work is 404').toBe(404);

        // 6c. NOT recoverable through any "archived" opt-in. The platform does
        // not model soft-delete/archive/restore, so an archived view (if the
        // param were honoured at all) must NOT resurrect the work. We assert
        // the work stays absent across the candidate opt-in shapes.
        for (const qs of [`status=archived`, `archived=1`, `includeArchived=true`]) {
            const archivedRes = await request.get(
                `${API_BASE}/api/works?${qs}&search=${encodeURIComponent(suffix)}`,
                { headers: authedHeaders(token) },
            );
            expect(archivedRes.status(), `GET /works?${qs} should not 5xx`).toBeLessThan(500);
            const archivedBody = await archivedRes.json();
            const archivedIds: string[] = (archivedBody.works ?? []).map(
                (w: { id: string }) => w.id,
            );
            expect(
                archivedIds,
                `deleted work is not recoverable via ?${qs} (hard delete, no archive)`,
            ).not.toContain(workId);
        }
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: visibility — a Work is private. The owner can read it
    //         (authenticated), but it is NOT reachable on any anonymous /
    //         cross-user public contract, and the protected dashboard page
    //         bounces an unauthenticated browser to /login.
    // ───────────────────────────────────────────────────────────────────────
    test('work visibility: owner-readable, private to anonymous + other users, dashboard gated', async ({
        page,
        request,
    }) => {
        test.setTimeout(90_000);

        // Two independent fresh users so we can prove cross-user isolation.
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const other: RegisteredUser = await registerUserViaAPI(request);

        const suffix = uniqueSuffix();
        const created = await createWorkViaAPI(request, owner.access_token, {
            name: `Flow Visibility Work ${suffix}`,
            slug: `flow-visibility-work-${suffix}`,
            description: `visibility integration ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'work created for visibility flow').toBeTruthy();

        // --- Step 1: the OWNER can read it (authenticated → 200). ---
        const ownerRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerRead.status(), 'owner reads its work (200)').toBe(200);
        const ownerBody = await ownerRead.json();
        expect(ownerBody.work?.id, 'owner read returns the right work').toBe(workId);

        // --- Step 2: ANONYMOUS read is rejected (401 — no public per-work
        // contract; the work is private). Pass NO Authorization header. ---
        const anonRead = await request.get(`${API_BASE}/api/works/${workId}`);
        expect(anonRead.status(), 'anonymous read is unauthorized (401)').toBe(401);
        const anonBody = await anonRead.json();
        expect(anonBody.statusCode, 'anon body carries 401').toBe(401);
        expect(String(anonBody.message), 'anon message is Unauthorized').toMatch(/unauthorized/i);

        // --- Step 3: a DIFFERENT authenticated user cannot read it (403 —
        // not 200, not a silent leak). Cross-user isolation. ---
        const otherRead = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(other.access_token),
        });
        expect(otherRead.status(), 'a non-owner authenticated user is forbidden (403)').toBe(403);
        const otherBody = await otherRead.json();
        expect(otherBody.status, 'cross-user read error envelope').toBe('error');
        expect(String(otherBody.message), 'cross-user read surfaces a permission error').toMatch(
            /permission/i,
        );

        // ...and the other user does NOT see the work in their own listing.
        const otherList = await request.get(
            `${API_BASE}/api/works?search=${encodeURIComponent(suffix)}`,
            { headers: authedHeaders(other.access_token) },
        );
        expect(otherList.status(), 'other user list').toBe(200);
        const otherListBody = await otherList.json();
        const otherIds: string[] = (otherListBody.works ?? []).map((w: { id: string }) => w.id);
        expect(otherIds, "another user's listing does not include the private work").not.toContain(
            workId,
        );

        // --- Step 4: the protected per-work dashboard page bounces an
        // UNAUTHENTICATED browser to /login (UI-level privacy gate). We use a
        // fresh, storage-state-free context so no seeded session leaks in. ---
        // Force a TRULY cookie-free context: a bare newContext() inherits the
        // project storageState's everworks_auth_token (so it isn't anonymous and
        // /works/<id> resolves authed → no /login redirect). Explicit empty
        // storageState guarantees no auth cookie.
        const anonContext = await page
            .context()
            .browser()!
            .newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonPage = await anonContext.newPage();
            // The proxy gate (`apps/web/src/proxy.ts`) verified live: an unauth
            // hit on `/en/works/<id>` 307s to `/works/<id>` then 307s to
            // `/login`. Use `domcontentloaded` (NOT `networkidle`): under
            // `next dev` the cold-compiled `/login` route keeps the HMR socket
            // and lazy-chunk fetches busy, so `networkidle` never settles and
            // the goto times out before the redirect lands. The auto-retrying
            // toHaveURL below observes the real `/login` destination.
            // Go straight to the UNPREFIXED /works/<id>: curl (no cookies) shows
            // it 307s directly to /login, whereas /en/works/<id> adds an extra
            // 307 hop (→/works/<id>) that raced the browser navigation. Use
            // waitUntil:'commit' (next dev never reaches networkidle/load on the
            // cold /login route) + waitForURL to follow the redirect to /login.
            await anonPage.goto(`/works/${workId}`, { waitUntil: 'commit' });
            await anonPage.waitForURL(/\/login/, { timeout: 30_000 });
            await expect(
                anonPage,
                'unauthenticated access to a work detail page redirects to /login',
            ).toHaveURL(/\/login/, { timeout: 30_000 });
        } finally {
            await anonContext.close();
        }
    });
});
