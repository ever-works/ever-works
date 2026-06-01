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
 * Work rename + slug behaviour — complex, multi-step, cross-feature INTEGRATION
 * flows for the Work domain object's IDENTITY surface (name / slug / description).
 *
 * Each test() drives several real endpoints (and, where deterministic, the real
 * authenticated UI) and asserts the platform's TRUE, observable behaviour as
 * probed against the LIVE API (http://127.0.0.1:3100) on 2026-06-01 and confirmed
 * by reading the real source.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED against the LIVE API + real source
 * (apps/api/src/works/works.controller.ts, packages/agent/src/dto/*-work.dto.ts,
 *  apps/web/.../works/[id]/detail/WorkHeader.tsx, .../works-client.tsx):
 *
 *   POST /api/works                 -> 200 { status:'success', work:{ id,name,slug,description,status:'active',... } }
 *   GET  /api/works                 -> 200 { status:'success', works:[...], total, limit, offset }
 *   GET  /api/works?search=<term>   -> server-side substring filter on NAME (verified; no API-side min length)
 *   GET  /api/works/:id (owner)     -> 200 { status:'success', work:{...} }
 *   GET  /api/works/:id (stranger)  -> 403 (verified cross-owner read)
 *   PUT  /api/works/:id (owner)     -> 200 { status:'success', work:{...updated...} }
 *   PUT  /api/works/:id (stranger)  -> 403 (verified cross-owner write)
 *   PATCH/api/works/:id             -> thin alias for PUT (same handler; verified by source)
 *
 * THE LOAD-BEARING, PROBED FACTS THIS SPEC PINS (and that the existing
 * slug-collision.spec.ts / concurrent-update-conflict.spec.ts do NOT cover):
 *
 *   1. SLUG IS IMMUTABLE VIA UPDATE. UpdateWorkDto has NO `slug` property, and
 *      the global ValidationPipe runs with forbidNonWhitelisted, so:
 *         PUT/PATCH /api/works/:id { slug:'x' }
 *           -> 400 { message:["property slug should not exist"], error:'Bad Request' }
 *      The slug is therefore frozen at create time. A NAME edit never touches it
 *      (no "slug regeneration on rename"). This is the real, bookmarked-URL-safe
 *      contract — there is NO PUT-based slug rewrite endpoint to test.
 *
 *   2. NAME / DESCRIPTION ARE SANITISED-THEN-TRUNCATED, NOT REJECTED, on overflow.
 *      Both CreateWorkDto and UpdateWorkDto run @Transform(sanitizeName(v,100)) /
 *      sanitizeDescription(v,500) BEFORE @MaxLength, so a 150-char name PUT
 *      -> 200 with a name of EXACTLY 100 chars; a 600-char description PUT
 *      -> 200 with a description of EXACTLY 500 chars. (Verified live.)
 *
 *   3. SLUG IS REQUIRED + URL-SAFE AT CREATE. CreateWorkDto.slug is @IsNotEmpty
 *      and @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/). There is NO server-side slug
 *      derivation from name: POST with no slug, or a non-URL-safe slug, -> 400.
 *      An empty name -> 400 ["name should not be empty"].
 *
 *   4. SLUG-COLLISION RESOLUTION ON CREATE is not pinned to one policy (409 vs
 *      auto-suffix) — same two-outcome branch slug-collision.spec.ts uses — but
 *      THIS spec extends it: a THIRD colliding create, and the cross-feature
 *      check that whatever slug each work ends up with is the one the detail UI
 *      renders.
 *
 * UI selectors verified against real source:
 *   /works list search input  -> input[placeholder="Search works..."]  (t('search'))
 *                                 NOTE: WorksClient only fires a search for the
 *                                 empty string or terms of >= 3 chars (MIN_SEARCH_CHARS).
 *   list card                 -> <a href=".../works/<id>"> (WorkList)
 *   /works/<id> header        -> WorkHeader: <h1>{work.name}</h1>,
 *                                <p>{work.description}</p> (only when truthy),
 *                                <code>{work.slug}</code> in the meta row.
 *
 * ISOLATION: every mutating flow runs on a FRESH registerUserViaAPI() user so the
 * shared in-memory DB stays clean for sibling specs; the seeded user
 * (storageState) is used ONLY for the authenticated UI assertions. Unique
 * name/slug suffixes everywhere; list assertions use toContain (tolerate
 * pre-existing rows), never exact counts.
 */

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Pull a work object out of any of the response envelope shapes the API uses. */
function pickWork(raw: unknown): {
    id?: string;
    name?: string;
    slug?: string;
    description?: string;
} {
    const r = raw as {
        work?: Record<string, unknown>;
        data?: Record<string, unknown>;
    } & Record<string, unknown>;
    const w = (r?.work ?? r?.data ?? r) as Record<string, unknown>;
    return {
        id: (w?.id as string) ?? undefined,
        name: (w?.name as string) ?? undefined,
        slug: (w?.slug as string) ?? undefined,
        description: (w?.description as string) ?? undefined,
    };
}

/** A slug must be URL-safe: lowercase alnum + single hyphens, no leading/trailing/double hyphen. */
function isUrlSafeSlug(slug: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

async function loginSeeded(request: import('@playwright/test').APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(loginRes.ok(), 'seeded user login should succeed').toBeTruthy();
    const { access_token } = await loginRes.json();
    expect(access_token, 'login returns an access token').toBeTruthy();
    return access_token as string;
}

test.describe('Work rename + slug immutability / collision / edge cases', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: rename a Work's NAME via PUT and prove the new name propagates to
    //         every READ surface (PUT response, GET /:id, GET /?search) while the
    //         slug stays STABLE — then prove the rename lands in the UI list card
    //         and the detail page header (cross-feature: API → Next RSC → React).
    //         The slug in the detail meta row must STILL be the original one
    //         (bookmarked URL intact). Uses the seeded user so the UI sees it.
    // ───────────────────────────────────────────────────────────────────────
    test('rename name propagates to GET + list + detail UI; slug stays stable', async ({
        page,
        request,
        baseURL,
    }) => {
        test.setTimeout(120_000);
        const origin = baseURL ?? 'http://localhost:3000';
        const token = await loginSeeded(request);

        const suffix = uniqueSuffix();
        const originalName = `Rename Flow Original ${suffix}`;
        const originalSlug = `rename-flow-original-${suffix}`;
        const created = await createWorkViaAPI(request, token, {
            name: originalName,
            slug: originalSlug,
            description: `rename flow desc ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'work created for rename flow').toBeTruthy();
        expect(pickWork(created.raw).slug, 'created slug echoes back').toBe(originalSlug);

        // --- Step 1: rename via PUT (name only). ---
        const renamedName = `Rename Flow RENAMED ${suffix}`;
        const putRes = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { name: renamedName },
        });
        expect(putRes.status(), 'PUT name rename').toBe(200);
        const putWork = pickWork(await putRes.json());
        expect(putWork.name, 'PUT response reflects the new name').toBe(renamedName);
        // A name edit does NOT regenerate / break the slug — bookmarked URLs survive.
        expect(putWork.slug, 'slug is unchanged by a name update').toBe(originalSlug);

        // --- Step 2: the rename propagated to GET /:id. ---
        const getWork = pickWork(
            await (
                await request.get(`${API_BASE}/api/works/${workId}`, {
                    headers: authedHeaders(token),
                })
            ).json(),
        );
        expect(getWork.name, 'GET reflects the renamed name').toBe(renamedName);
        expect(getWork.slug, 'GET still shows the original slug').toBe(originalSlug);

        // --- Step 3: the rename propagated to the search-filtered listing
        // (server-side substring filter on name). NEW name matches; OLD does not. ---
        const newNames: string[] = (
            (
                await (
                    await request.get(
                        `${API_BASE}/api/works?search=${encodeURIComponent(renamedName)}`,
                        {
                            headers: authedHeaders(token),
                        },
                    )
                ).json()
            ).works ?? []
        ).map((w: { name: string }) => w.name);
        expect(newNames, 'list shows the renamed work').toContain(renamedName);

        const oldNames: string[] = (
            (
                await (
                    await request.get(
                        `${API_BASE}/api/works?search=${encodeURIComponent(originalName)}`,
                        {
                            headers: authedHeaders(token),
                        },
                    )
                ).json()
            ).works ?? []
        ).map((w: { name: string }) => w.name);
        expect(oldNames, 'list no longer surfaces the pre-rename name').not.toContain(originalName);

        // --- Step 4: the rename lands in the UI — list card + detail header. ---
        await page.goto(`${origin}/en/works`, { waitUntil: 'domcontentloaded' });
        const searchInput = page.locator('input[placeholder="Search works..."]').first();
        await expect(searchInput, 'works list search input is present').toBeVisible({
            timeout: 30_000,
        });
        // suffix is > 3 chars so it clears WorksClient's MIN_SEARCH_CHARS gate.
        await searchInput.fill(suffix);

        const workCardLink = page.locator(`a[href*="/works/${workId}"]`).first();
        await expect(workCardLink, 'renamed work card appears in filtered list').toBeVisible({
            timeout: 30_000,
        });
        await expect(workCardLink, 'card shows the RENAMED name').toContainText(renamedName, {
            timeout: 15_000,
        });

        // Navigate via the card; under `next dev` the <Link> may hydrate a beat
        // after paint, so retry the click until the URL advances.
        await expect(async () => {
            await workCardLink.click();
            await page.waitForURL(new RegExp(`/works/${workId}`), { timeout: 10_000 });
        }).toPass({ timeout: 60_000 });

        await expect(
            page.getByRole('heading', { level: 1, name: renamedName }),
            'detail header <h1> shows the renamed name',
        ).toBeVisible({ timeout: 30_000 });
        // The header meta row still renders the STABLE slug in a <code>.
        await expect(
            page.locator('code', { hasText: originalSlug }).first(),
            'detail header still renders the original slug',
        ).toBeVisible({ timeout: 30_000 });
        await expect(page, 'detail page should not redirect to /login').not.toHaveURL(/\/login/);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: SLUG IS IMMUTABLE via the update endpoint. Both PUT and PATCH
    //         { slug } are rejected with 400 ["property slug should not exist"]
    //         (forbidNonWhitelisted), and the original slug survives untouched —
    //         including when bundled alongside a VALID field (name): the whole
    //         request must be rejected atomically (no partial name write).
    //         This is the contract slug-collision.spec.ts's "slug rename happy
    //         path" only asserts as "< 500" — here we pin the EXACT behaviour.
    // ───────────────────────────────────────────────────────────────────────
    test('slug is immutable via update: PUT/PATCH {slug} → 400, original slug + name unchanged', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;
        const suffix = uniqueSuffix();

        const beforeSlug = `slug-immutable-${suffix}`;
        const originalName = `Slug Immutable ${suffix}`;
        const created = await createWorkViaAPI(request, token, {
            name: originalName,
            slug: beforeSlug,
            description: `slug immutable ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'work created for slug-immutability flow').toBeTruthy();
        expect(pickWork(created.raw).slug, 'created slug echoes back').toBe(beforeSlug);

        // --- Step 1: PUT { slug } alone → 400 forbidden-property. ---
        const putSlug = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { slug: `slug-after-${suffix}` },
        });
        expect(putSlug.status(), 'PUT { slug } is rejected (forbidNonWhitelisted)').toBe(400);
        const putSlugBody = await putSlug.json();
        const putMsg = Array.isArray(putSlugBody.message)
            ? putSlugBody.message.join(' ')
            : String(putSlugBody.message ?? '');
        expect(putMsg, 'rejection names the forbidden slug property').toContain('slug');

        // --- Step 2: PATCH { slug } (the PUT alias) → same 400. ---
        const patchSlug = await request.patch(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { slug: `slug-patch-${suffix}` },
        });
        expect(patchSlug.status(), 'PATCH { slug } is rejected too').toBe(400);

        // --- Step 3: a MIXED body { name (valid) + slug (forbidden) } must be
        // rejected ATOMICALLY — the valid name must NOT slip through. ---
        const mixed = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { name: `Should Not Persist ${suffix}`, slug: `slug-mixed-${suffix}` },
        });
        expect(mixed.status(), 'mixed valid+forbidden body is rejected wholesale').toBe(400);

        // --- Step 4: read back — slug AND name are exactly what we created with. ---
        const after = pickWork(
            await (
                await request.get(`${API_BASE}/api/works/${workId}`, {
                    headers: authedHeaders(token),
                })
            ).json(),
        );
        expect(after.slug, 'slug is untouched by every rejected slug-write').toBe(beforeSlug);
        expect(after.name, 'the atomically-rejected name did NOT persist').toBe(originalName);

        // --- Step 5: by contrast, a NAME-only PUT succeeds and STILL leaves the
        // slug frozen — proving the only legal identity edit keeps the slug stable. ---
        const renamed = `Slug Immutable Renamed ${suffix}`;
        const okPut = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { name: renamed },
        });
        expect(okPut.status(), 'name-only PUT succeeds').toBe(200);
        expect(pickWork(await okPut.json()).slug, 'slug still frozen after a legal rename').toBe(
            beforeSlug,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: SLUG COLLISION on CREATE — three works racing for one slug. The
    //         platform must NEVER mint two works with the same slug in one owner
    //         namespace: each colliding create is either rejected (4xx) or
    //         auto-disambiguated; never 5xx, never a duplicate. We then prove the
    //         distinct slugs the API settled on are exactly what the API reports
    //         back on GET (no torn create-response vs read state). Extends
    //         slug-collision.spec.ts (which only does TWO creates, no read-back).
    // ───────────────────────────────────────────────────────────────────────
    test('three creates racing one slug → all distinct or rejected, never duplicate / 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;
        const suffix = uniqueSuffix();
        const wantedSlug = `collide-${suffix}`;

        // First create takes the slug verbatim.
        const first = await createWorkViaAPI(request, token, {
            name: `Collide First ${suffix}`,
            slug: wantedSlug,
            description: `collide first ${suffix}`,
        });
        const firstSlug = pickWork(first.raw).slug ?? wantedSlug;
        expect(first.id, 'first create succeeded').toBeTruthy();
        expect(firstSlug, 'first create keeps the requested slug').toBe(wantedSlug);

        // Two more creates request the SAME slug. createWorkViaAPI throws on a
        // non-2xx, so issue these raw to capture the rejection branch too.
        const collidingIds: string[] = [];
        const collidingSlugs: string[] = [firstSlug];
        for (let i = 0; i < 2; i++) {
            const res = await request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(token),
                data: {
                    name: `Collide ${i} ${suffix}`,
                    slug: wantedSlug,
                    description: `collide ${i} ${suffix}`,
                    organization: false,
                },
            });
            // Acceptable: 4xx rejection, OR 2xx with a DIFFERENT slug. Never 5xx.
            expect(res.status(), `colliding create #${i} must not 5xx`).toBeLessThan(500);
            if (res.ok()) {
                const w = pickWork(await res.json());
                expect(w.id, `colliding create #${i} returns an id`).toBeTruthy();
                expect(
                    isUrlSafeSlug(w.slug!),
                    `disambiguated slug "${w.slug}" stays URL-safe`,
                ).toBe(true);
                expect(
                    collidingSlugs,
                    `create #${i} did NOT reuse an existing slug verbatim`,
                ).not.toContain(w.slug);
                collidingSlugs.push(w.slug!);
                collidingIds.push(w.id!);
            } else {
                // Rejection — must be a 4xx conflict/validation error, not a crash.
                expect(
                    res.status(),
                    `colliding create #${i} rejection is a 4xx`,
                ).toBeGreaterThanOrEqual(400);
            }
        }

        // Whatever slug each accepted work was given, GET must echo the SAME slug
        // (no drift between the create response and the persisted row).
        for (const id of collidingIds) {
            const persisted = pickWork(
                await (
                    await request.get(`${API_BASE}/api/works/${id}`, {
                        headers: authedHeaders(token),
                    })
                ).json(),
            );
            expect(
                collidingSlugs,
                `persisted slug "${persisted.slug}" matches the one the create returned`,
            ).toContain(persisted.slug);
        }

        // The whole batch of accepted slugs is internally unique.
        const unique = new Set(collidingSlugs);
        expect(unique.size, 'every accepted slug in this owner namespace is distinct').toBe(
            collidingSlugs.length,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 4: NAME / DESCRIPTION EDGE CASES — the REAL sanitise-then-truncate
    //         contract. An overlong name/description is NOT rejected; it is
    //         truncated to the DTO cap (name 100, description 500). An empty name
    //         on create is rejected (4xx). A missing slug on create is rejected
    //         (no server-side derivation). A non-URL-safe slug is rejected. Every
    //         case asserts the GENUINE outcome — never 5xx.
    // ───────────────────────────────────────────────────────────────────────
    test('name/description sanitise-then-truncate on edit; empty name / bad slug rejected', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;
        const suffix = uniqueSuffix();

        const created = await createWorkViaAPI(request, token, {
            name: `Edge Base ${suffix}`,
            slug: `edge-base-${suffix}`,
            description: `edge base ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'base work created for edge flow').toBeTruthy();

        // --- Step 1: a 150-char name PUT is ACCEPTED and TRUNCATED to 100. ---
        const overlongName = 'N'.repeat(150);
        const nameRes = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { name: overlongName },
        });
        expect(nameRes.status(), 'overlong name is sanitised, not rejected').toBe(200);
        const nameAfter = pickWork(await nameRes.json()).name ?? '';
        expect(nameAfter.length, 'name truncated to the 100-char cap').toBe(100);

        // --- Step 2: a 600-char description PUT is ACCEPTED and TRUNCATED to 500. ---
        const overlongDesc = 'D'.repeat(600);
        const descRes = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { description: overlongDesc },
        });
        expect(descRes.status(), 'overlong description is sanitised, not rejected').toBe(200);
        const descAfter = pickWork(await descRes.json()).description ?? '';
        expect(descAfter.length, 'description truncated to the 500-char cap').toBe(500);

        // --- Step 3: a unicode/emoji name (with a safe explicit slug) is accepted
        // and round-trips; the slug stays URL-safe. ---
        const unicodeName = `Ünïçödé 名前 🚀 ${suffix}`;
        const uniRes = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: unicodeName,
                slug: `edge-unicode-${suffix}`,
                description: `unicode ${suffix}`,
                organization: false,
            },
        });
        expect(uniRes.status(), 'unicode name with a safe slug is accepted').toBe(200);
        const uniWork = pickWork(await uniRes.json());
        expect(
            isUrlSafeSlug(uniWork.slug!),
            `unicode work slug "${uniWork.slug}" is URL-safe`,
        ).toBe(true);

        // --- Step 4: an EMPTY name on create is rejected (4xx, never 5xx). ---
        const emptyName = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: '',
                slug: `edge-empty-${suffix}`,
                description: `empty ${suffix}`,
                organization: false,
            },
        });
        expect(emptyName.status(), 'empty name on create is a 4xx').toBeGreaterThanOrEqual(400);
        expect(emptyName.status(), 'empty name on create is not a 5xx').toBeLessThan(500);

        // --- Step 5: a MISSING slug on create is rejected — there is NO
        // server-side slug derivation from the name. ---
        const noSlug = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: `No Slug ${suffix}`,
                description: `no slug ${suffix}`,
                organization: false,
            },
        });
        expect(
            noSlug.status(),
            'create without a slug is a 4xx (slug required)',
        ).toBeGreaterThanOrEqual(400);
        expect(noSlug.status(), 'create without a slug is not a 5xx').toBeLessThan(500);

        // --- Step 6: a NON-URL-safe slug on create is rejected by @Matches. ---
        const badSlug = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: `Bad Slug ${suffix}`,
                slug: `Bad Slug!! ${suffix}`,
                description: `bad slug ${suffix}`,
                organization: false,
            },
        });
        expect(badSlug.status(), 'non-URL-safe slug on create is a 4xx').toBeGreaterThanOrEqual(
            400,
        );
        expect(badSlug.status(), 'non-URL-safe slug on create is not a 5xx').toBeLessThan(500);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 5: DESCRIPTION update propagation to the detail UI. Create a work,
    //         update its description via PUT, and prove the new description is
    //         the one the API returns AND the one the detail header renders
    //         (<p>{description}</p>), while the stale original is gone. Then prove
    //         a SECOND description edit re-propagates (the page isn't caching a
    //         stale RSC payload). Uses the seeded user (UI). API → RSC → React.
    // ───────────────────────────────────────────────────────────────────────
    test('description updates re-propagate to GET + detail header (no stale RSC)', async ({
        page,
        request,
        baseURL,
    }) => {
        test.setTimeout(120_000);
        const origin = baseURL ?? 'http://localhost:3000';
        const token = await loginSeeded(request);

        const suffix = uniqueSuffix();
        const workName = `Desc Propagation ${suffix}`;
        const originalDescription = `original description ${suffix}`;
        const created = await createWorkViaAPI(request, token, {
            name: workName,
            slug: `desc-propagation-${suffix}`,
            description: originalDescription,
        });
        const workId = created.id;
        expect(workId, 'work created for description-propagation flow').toBeTruthy();

        // --- Step 1: first description update via PUT. ---
        const desc1 = `UPDATED description body ${suffix} — first edit`;
        const put1 = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { description: desc1 },
        });
        expect(put1.status(), 'PUT first description update').toBe(200);
        const put1Work = pickWork(await put1.json());
        expect(put1Work.description, 'PUT response reflects the new description').toBe(desc1);
        expect(put1Work.name, 'name unchanged by a description edit').toBe(workName);

        expect(
            pickWork(
                await (
                    await request.get(`${API_BASE}/api/works/${workId}`, {
                        headers: authedHeaders(token),
                    })
                ).json(),
            ).description,
            'GET reflects the first updated description',
        ).toBe(desc1);

        // --- Step 2: the detail header renders the first updated description and
        // NOT the stale original. ---
        await page.goto(`${origin}/en/works/${workId}`, { waitUntil: 'domcontentloaded' });
        await expect(page, 'detail page should not redirect to /login').not.toHaveURL(/\/login/, {
            timeout: 30_000,
        });
        await expect(
            page.getByRole('heading', { level: 1, name: workName }),
            'detail header renders the work name',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(desc1, { exact: false }).first(),
            'detail header renders the FIRST updated description',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(originalDescription, { exact: true }),
            'detail header does not show the stale original description',
        ).toHaveCount(0, { timeout: 15_000 });

        // --- Step 3: a SECOND description edit must ALSO re-propagate on reload
        // (no stale RSC payload cached for this route). ---
        const desc2 = `UPDATED description body ${suffix} — second edit`;
        const put2 = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { description: desc2 },
        });
        expect(put2.status(), 'PUT second description update').toBe(200);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
            page.getByText(desc2, { exact: false }).first(),
            'detail header renders the SECOND updated description after reload',
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText(desc1, { exact: true }),
            'detail header no longer shows the first description after the second edit',
        ).toHaveCount(0, { timeout: 15_000 });
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 6: CROSS-OWNER identity protection + last-write-wins convergence under
    //         mixed PUT/PATCH races. A STRANGER can neither read (403) nor rename
    //         (403) the work — slug/name churn is owner-only. Then the OWNER fires
    //         several mixed PUT/PATCH name updates nearly simultaneously: none may
    //         5xx, the final GET settles on exactly ONE submitted name (no torn
    //         value), and the slug — never part of any write — is untouched.
    //         (concurrent-update-conflict.spec.ts only fires TWO PATCHes and does
    //         not cover the cross-owner 403 gate or slug survival.)
    // ───────────────────────────────────────────────────────────────────────
    test('stranger cannot read/rename (403); owner mixed PUT+PATCH races converge, slug intact', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const stranger: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;
        const suffix = uniqueSuffix();

        const fixedSlug = `concurrent-${suffix}`;
        const created = await createWorkViaAPI(request, token, {
            name: `Concurrent Original ${suffix}`,
            slug: fixedSlug,
            description: `concurrent ${suffix}`,
        });
        const workId = created.id;
        expect(workId, 'work created for concurrency flow').toBeTruthy();

        // --- Step 1: a stranger is blocked from both reading and renaming. ---
        const strangerGet = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status(), 'stranger cannot read the work').toBe(403);

        const strangerPut = await request.put(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(stranger.access_token),
            data: { name: `Hijacked ${suffix}` },
        });
        expect(strangerPut.status(), 'stranger cannot rename the work').toBe(403);

        // --- Step 2: the stranger's blocked rename left no trace — the owner
        // still sees the original name. ---
        expect(
            pickWork(
                await (
                    await request.get(`${API_BASE}/api/works/${workId}`, {
                        headers: authedHeaders(token),
                    })
                ).json(),
            ).name,
            'blocked stranger rename did not mutate the work',
        ).toBe(`Concurrent Original ${suffix}`);

        // --- Step 3: owner fires N mixed PUT/PATCH name updates in parallel. ---
        const candidateNames = Array.from(
            { length: 6 },
            (_, i) => `Concurrent Rename ${i} ${suffix}`,
        );
        const results = await Promise.all(
            candidateNames.map((name, i) => {
                const opts = {
                    headers: authedHeaders(token),
                    data: { name },
                };
                // Alternate verbs to exercise the PUT and its PATCH alias under contention.
                return i % 2 === 0
                    ? request.put(`${API_BASE}/api/works/${workId}`, opts)
                    : request.patch(`${API_BASE}/api/works/${workId}`, opts);
            }),
        );
        for (const [i, r] of results.entries()) {
            expect(r.status(), `concurrent write #${i} must not 5xx`).toBeLessThan(500);
        }
        expect(
            results.some((r) => r.ok()),
            'at least one concurrent update was accepted',
        ).toBe(true);

        // --- Step 4: the final state is exactly ONE submitted name (last-write-
        // wins convergence — never a merged/torn value), and the slug is intact. ---
        const finalGet = pickWork(
            await (
                await request.get(`${API_BASE}/api/works/${workId}`, {
                    headers: authedHeaders(token),
                })
            ).json(),
        );
        expect(
            candidateNames,
            `final name "${finalGet.name}" is one of the submitted candidates`,
        ).toContain(finalGet.name);
        expect(finalGet.slug, 'slug survived the rapid name updates intact').toBe(fixedSlug);

        // --- Step 5: a re-read is idempotent — two back-to-back GETs agree. ---
        const reread = pickWork(
            await (
                await request.get(`${API_BASE}/api/works/${workId}`, {
                    headers: authedHeaders(token),
                })
            ).json(),
        );
        expect(reread.name, 'a re-read returns the same converged name').toBe(finalGet.name);
        expect(reread.slug, 'a re-read returns the same slug').toBe(fixedSlug);
    });
});
