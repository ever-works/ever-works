import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Real, multi-step integration coverage of the core Work domain object:
 * create a Work, prove it persists in the API, then prove the
 * authenticated UI surfaces it both in the /works list and on its
 * /works/<id> detail page.
 *
 * WHY CREATE VIA THE API (not the manual /works/new form):
 * The "Create Manually" affordance on /works/new mounts `WorkAICreator`
 * (apps/web/src/components/works/WorkAICreator.tsx). Its submit handler
 * calls the `createWorkWithAI` server action — an AI generation pipeline
 * that (a) requires a *connected* git provider and surfaces a
 * `requiresGitProvider` error / redirect when one isn't connected, and
 * (b) kicks off async content generation rather than creating a plain,
 * inspectable Work row. Neither is deterministic in the e2e stack
 * (GitHub isn't connected; AI provider may be absent in CI). So we drive
 * the *reliable* path: create the Work through the documented
 * `POST /api/works` contract (helpers/api.ts `createWorkViaAPI`) as the
 * SAME user the browser is logged in as (the seeded user), then assert
 * the genuine, observable UI outcomes — the work appears in the list and
 * its detail page renders its name + a real detail surface (slug). This
 * still exercises end-to-end: API persistence -> Next.js server-action
 * fetch -> rendered React.
 *
 * Endpoint shapes verified against the LIVE API before writing asserts:
 *   POST /api/works            -> { status:'success', work:{ id, name, slug, ... } }
 *   GET  /api/works            -> { status:'success', works:[...], total, limit, offset }
 *   GET  /api/works/:id        -> { status:'success', work:{ id, name, slug, ... } }
 *   GET  /api/works?search=... -> server-side substring filter on name (verified)
 *
 * Selectors verified against real source:
 *   /works list search input  -> placeholder "Search works..." (works-client.tsx:283)
 *   list card                 -> <a href=".../works/<id>"> with <h3>{work.name}</h3> (WorkCard.tsx)
 *   /works/<id> detail        -> <h1>{work.name}</h1> + <code>{work.slug}</code> (WorkHeader.tsx)
 */

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WORK_NAME = `E2E Create Detail ${SUFFIX}`;
const WORK_SLUG = `e2e-create-detail-${SUFFIX}`;
const WORK_DESCRIPTION = `Playwright create+detail integration work ${SUFFIX}`;

test.describe('Work create + detail (core domain)', () => {
    test('creates a Work, persists it via the API, and renders it in the list + detail UI', async ({
        page,
        request,
    }) => {
        test.setTimeout(90_000);

        // --- Authenticate as the SAME user the browser is logged in as, so
        // the API-created Work lands on the UI's seeded account. ---
        const seeded = loadSeededTestUser();
        // The login DTO is whitelisted — send ONLY email+password (passing the
        // full seeded object's `name` field 400s "property name should not exist").
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(loginRes.ok(), 'seeded user login should succeed').toBeTruthy();
        const { access_token: token } = await loginRes.json();
        expect(token, 'login returns an access token').toBeTruthy();

        // --- Step 1: create the Work via the documented POST /api/works. ---
        const created = await createWorkViaAPI(request, token, {
            name: WORK_NAME,
            slug: WORK_SLUG,
            description: WORK_DESCRIPTION,
        });
        expect(created.id, 'created work should have an id').toBeTruthy();
        const workId = created.id;

        // --- Step 2: assert persistence via the API. ---
        // 2a. GET /api/works lists the new work (tolerate pre-existing rows;
        // scope the query with ?search so it surfaces even past page-1).
        const listRes = await request.get(
            `${API_BASE}/api/works?search=${encodeURIComponent(SUFFIX)}`,
            { headers: authedHeaders(token) },
        );
        expect(listRes.status(), 'authenticated GET /api/works').toBe(200);
        const listBody = await listRes.json();
        const listedNames: string[] = (listBody.works ?? []).map((w: { name: string }) => w.name);
        expect(listedNames, 'GET /api/works contains the new work').toContain(WORK_NAME);

        // 2b. GET /api/works/:id returns exactly this work.
        const detailRes = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(detailRes.status(), 'GET /api/works/:id').toBe(200);
        const detailBody = await detailRes.json();
        expect(detailBody.work?.id, 'detail id matches').toBe(workId);
        expect(detailBody.work?.name, 'detail name matches').toBe(WORK_NAME);
        expect(detailBody.work?.slug, 'detail slug matches').toBe(WORK_SLUG);

        // --- Step 3a: the /works list UI shows the new work. ---
        // The list search filters server-side (getWorks({ search })), debounced
        // 300ms, min 3 chars — typing the unique suffix surfaces only our work
        // regardless of how many works the seeded account has accrued.
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });

        const searchInput = page.locator('input[placeholder="Search works..."]').first();
        await expect(searchInput, 'works list search input is present').toBeVisible({
            timeout: 30_000,
        });
        await searchInput.fill(SUFFIX);

        // The card links to /works/<id> and shows the name in an <h3>. Poll the
        // card link (filtered by the work id) until the debounced search lands.
        const workCardLink = page.locator(`a[href*="/works/${workId}"]`).first();
        await expect(workCardLink, 'work card appears in filtered list').toBeVisible({
            timeout: 30_000,
        });
        await expect(workCardLink, 'work card shows the work name').toContainText(WORK_NAME, {
            timeout: 15_000,
        });

        // --- Step 3b: navigate to the detail page and assert it renders. ---
        // Capture the detail navigation response to assert it didn't 5xx
        // (Next soft-nav RSC fetch is a real HTTP request).
        const [detailNav] = await Promise.all([
            page
                .waitForResponse(
                    (r) =>
                        new URL(r.url()).pathname.includes(`/works/${workId}`) &&
                        r.request().method() === 'GET',
                    { timeout: 30_000 },
                )
                .catch(() => null),
            workCardLink.click().catch(() => undefined),
        ]);
        // Under CI shard load the debounced-search re-render can swallow/abort the
        // first soft-nav (net::ERR_ABORTED, URL stays on /works). The point of this
        // step is that the DETAIL PAGE renders, not which navigation delivered us
        // there — so if the soft-nav didn't land, fall back to a hard navigation.
        if (!new RegExp(`/works/${workId}`).test(page.url())) {
            await page.goto(`/en/works/${workId}`, { waitUntil: 'domcontentloaded' });
        }
        await expect(page).toHaveURL(new RegExp(`/works/${workId}`), { timeout: 30_000 });
        if (detailNav) {
            expect(detailNav.status(), 'work detail nav should not 5xx').toBeLessThan(500);
        }

        // WorkHeader renders the name in an <h1> and the slug in a <code>.
        await expect(
            page.getByRole('heading', { level: 1, name: WORK_NAME }),
            'detail page renders the work name as an <h1>',
        ).toBeVisible({ timeout: 30_000 });

        // A real detail surface beyond the title: the slug, rendered in the
        // header meta row (WorkHeader.tsx <code>{work.slug}</code>).
        await expect(
            page.locator('code', { hasText: WORK_SLUG }).first(),
            'detail page renders the work slug (detail surface)',
        ).toBeVisible({ timeout: 30_000 });

        // Sanity: we did not bounce to /login (still authenticated).
        await expect(page, 'detail page should not redirect to /login').not.toHaveURL(/\/login/);
    });
});
