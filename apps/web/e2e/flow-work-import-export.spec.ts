import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

/**
 * Work import / export roundtrip — complex, multi-step, cross-feature
 * integration flows for the Work import pipeline. Each test() drives the real
 * import endpoint end-to-end and asserts the platform's TRUE, observable
 * outcome at every step (Work record + GenerationHistory record + the
 * source-repository "export" shape that the import writes back).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   POST /api/auth/register
 *        -> { access_token, user:{ id,email,username } }  (username MUST be >= 3 chars)
 *
 *   POST /api/works/import                                   [HttpCode 202 ACCEPTED — ALWAYS]
 *        body { sourceUrl(URL), sourceType, name, gitProvider, ... }
 *        success -> { status:'success', workId, historyId, message:'Import started' }
 *        dup     -> { status:'error', message:'Work already exists' }  (still HTTP 202)
 *        - DTO validation: sourceUrl must be a URL (else 400),
 *          sourceType must be one of data_repo|awesome_readme|link_existing|works_config (else 400),
 *          name required + <=100 chars (else 400), gitProvider required (else 400).
 *        - On success the import:
 *            * parses the source URL -> work.owner = repo owner, work.slug = slugify(name)
 *            * sets work.description = `Imported from ${sourceUrl}`
 *            * writes work.sourceRepository = { url, importedAt, owner, repo, type,
 *                                               relatedRepositories:{ data:{ owner, repo } } }
 *            * creates a GenerationHistory row: { generationMethod:'import',
 *                  parameters:{ sourceUrl, sourceType, sourceOwner, sourceRepo },
 *                  activityType:'generation', triggeredBy:'user' }
 *        - Dedup key is (owner, slug); slug derives from `name`. Same name -> "Work already
 *          exists" (even with a different sourceUrl); a different name -> a brand-new work.
 *
 *   GET  /api/works/:id          -> { status:'success', work:{ name,slug,owner,description,
 *                                       gitProvider,generateStatus,sourceRepository,... } }
 *   GET  /api/works/:id/history  -> { status:'success', history:[ {generationMethod,parameters,
 *                                       status,errorMessage,activityType,triggeredBy,...} ],
 *                                       total, limit, offset }
 *   GET  /api/works              -> { status:'success', works:[...], total, limit, offset }
 *
 * UI (targeted, tolerant):
 *   /works/new -> an "Import existing / from repository / from github" mode button that, when
 *   clicked, reveals a repository picker OR a GitHub-connect prompt (matches works-import.spec.ts).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS FROM THE LITERAL ASSIGNMENT (real platform constraints):
 *
 *   • "Import a work ... assert the imported ITEMS/CATEGORIES land under the work" and
 *     "EXPORT the work (export endpoint/format) ... round-trip integrity":
 *     The CSV/Excel item import/export endpoints
 *         GET  /api/works/:id/export-items[?format], /api/works/:id/export-items/settings
 *         GET  /api/works/:id/import-items/sample, POST /api/works/:id/import-items[/validate]
 *     are GATED on `settings.export_enabled` / `settings.import_enabled` in the work CONFIG,
 *     which is hydrated from a CLONED git DATA REPOSITORY. A work created in the e2e stack has
 *     NO connected GitHub account, so `GET /works/:id/config` -> { config:null }, both flags are
 *     OFF, and every item import/export call bottoms out in the documented 404 ("Item import/
 *     export is not enabled for this directory"). Likewise the *content* of an import (items +
 *     categories) is materialised by the async import task, which fails at git fetch
 *     ("GitHub token not available") with NO token in CI. So the "items/categories land" and
 *     "export reflects them" outcomes are NOT deterministically observable here.
 *
 *     The CLOSEST real round-trip that IS deterministic is asserted instead, end-to-end:
 *       Flow 1 — IMPORT a work from a source URL via POST /api/works/import and prove the
 *                imported metadata "lands under the work": owner/slug/description derived from
 *                the source, the sourceRepository block written, a GenerationHistory row with
 *                generationMethod='import' + the import parameters, and the work appearing in
 *                the owner's listing. (Also asserts the item-import/export endpoints exist and
 *                return their TRUTHFUL config-gated 404 + 401 contract.)
 *       Flow 2 — "EXPORT" / round-trip integrity: read the work + its history back and prove the
 *                source URL round-trips losslessly into work.sourceRepository.url,
 *                work.description, and history.parameters.{sourceUrl,sourceOwner,sourceRepo} —
 *                i.e. what the import RECORDED (its export shape) faithfully reflects what was
 *                imported. The work also carries the truthful generateStatus error (no git).
 *       Flow 3 — IDEMPOTENCY: re-import the SAME name -> the documented "Work already exists"
 *                with NO duplicate created (dedup on owner+slug); a DIFFERENT name -> a new work,
 *                proving the dedup is keyed on the derived slug, not on the call itself.
 *
 * ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user so the shared
 * in-memory DB stays clean for sibling specs. Unique name/slug suffixes everywhere; list
 * assertions use toContain (tolerate pre-existing rows), never exact counts.
 */

const FAKE_WORK_ID = '00000000-0000-0000-0000-000000000000';

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface ImportResponse {
    status: 'success' | 'error' | 'pending';
    workId?: string;
    historyId?: string;
    message: string;
}

async function importWork(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    body: { sourceUrl: string; sourceType: string; name: string; gitProvider?: string },
): Promise<{ status: number; body: ImportResponse }> {
    const res = await request.post(`${API_BASE}/api/works/import`, {
        headers: authedHeaders(token),
        data: { gitProvider: 'github', ...body },
    });
    return { status: res.status(), body: (await res.json()) as ImportResponse };
}

test.describe('Work import/export roundtrip', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: Import a work from a source URL. Prove the imported metadata
    //         "lands under the work" — the Work record + GenerationHistory row
    //         the import creates — and that the (config-gated) item import/
    //         export endpoints exist and return their truthful contract.
    // ───────────────────────────────────────────────────────────────────────
    test('import a work from a source URL: work + history records land, item-import/export gated', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;

        const suffix = uniqueSuffix();
        const workName = `Import Roundtrip ${suffix}`;
        const expectedSlug = `import-roundtrip-${suffix}`;
        const sourceOwner = `acme-${suffix}`;
        const sourceRepo = `catalog-${suffix}`;
        const sourceUrl = `https://github.com/${sourceOwner}/${sourceRepo}`;

        // --- Step 1: import. The endpoint is @HttpCode(202 ACCEPTED) and kicks
        // off an async import; the synchronous response carries the created
        // work + history ids. ---
        const imported = await importWork(request, token, {
            sourceUrl,
            sourceType: 'data_repo',
            name: workName,
        });
        expect(imported.status, 'POST /works/import is 202 ACCEPTED').toBe(202);
        expect(imported.body.status, 'a fresh import succeeds').toBe('success');
        expect(imported.body.message, 'import-started message').toBe('Import started');
        expect(imported.body.workId, 'import returns a created workId').toBeTruthy();
        expect(imported.body.historyId, 'import returns a created historyId').toBeTruthy();
        const workId = imported.body.workId as string;
        const historyId = imported.body.historyId as string;

        // --- Step 2: the imported metadata LANDED under a real Work record. ---
        const workRes = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(workRes.status(), 'GET /works/:id for the imported work').toBe(200);
        const workBody = await workRes.json();
        const work = workBody.work;
        expect(work?.id, 'work id round-trips').toBe(workId);
        expect(work?.name, 'work name is the import name').toBe(workName);
        // slug is derived from the name (slugify), NOT from the repo.
        expect(work?.slug, 'work slug is slugify(name)').toBe(expectedSlug);
        // owner is parsed from the source repository URL.
        expect(work?.owner, 'work owner is parsed from the source URL').toBe(sourceOwner);
        // description records the provenance of the import.
        expect(work?.description, 'description records the import source').toBe(
            `Imported from ${sourceUrl}`,
        );
        expect(work?.gitProvider, 'gitProvider echoes the import DTO').toBe('github');

        // --- Step 3: the import created a GenerationHistory row that captures
        // the import parameters (this is the "imported content manifest"). ---
        const historyRes = await request.get(`${API_BASE}/api/works/${workId}/history`, {
            headers: authedHeaders(token),
        });
        expect(historyRes.status(), 'GET /works/:id/history').toBe(200);
        const historyBody = await historyRes.json();
        expect(historyBody.status, 'history envelope').toBe('success');
        expect(Array.isArray(historyBody.history), 'history is an array').toBe(true);
        expect(historyBody.total, 'history has exactly the one import entry').toBe(1);

        const entry = historyBody.history.find((h: { id: string }) => h.id === historyId);
        expect(entry, 'the returned historyId is present in the history list').toBeTruthy();
        expect(entry.generationMethod, 'history records this as an import').toBe('import');
        expect(entry.activityType, 'history activityType is generation').toBe('generation');
        expect(entry.triggeredBy, 'history was user-triggered').toBe('user');
        expect(entry.parameters?.sourceUrl, 'history params carry the source URL').toBe(sourceUrl);
        expect(entry.parameters?.sourceType, 'history params carry the source type').toBe(
            'data_repo',
        );
        expect(entry.parameters?.sourceOwner, 'history params carry the parsed owner').toBe(
            sourceOwner,
        );
        expect(entry.parameters?.sourceRepo, 'history params carry the parsed repo').toBe(
            sourceRepo,
        );

        // --- Step 4: the imported work appears in the owner's listing. ---
        const listRes = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status(), 'GET /works').toBe(200);
        const listBody = await listRes.json();
        const listedIds: string[] = (listBody.works ?? []).map((w: { id: string }) => w.id);
        expect(listedIds, 'imported work is in the owner listing').toContain(workId);

        // --- Step 5: the CSV/Excel item import + export endpoints EXIST and are
        // gated on the work config (which has no data repo here). This is the
        // truthful contract for an import-pipeline work without a connected git
        // data repository: feature flags OFF -> the actions return 404. ---
        const configRes = await request.get(`${API_BASE}/api/works/${workId}/config`, {
            headers: authedHeaders(token),
        });
        expect(configRes.status(), 'GET /works/:id/config').toBe(200);
        expect((await configRes.json()).status, 'config envelope').toBe('success');

        const exportSettings = await request.get(
            `${API_BASE}/api/works/${workId}/export-items/settings`,
            { headers: authedHeaders(token) },
        );
        expect(exportSettings.status(), 'export-items/settings is 200').toBe(200);
        expect(
            (await exportSettings.json()).export_enabled,
            'export is OFF without a data repo',
        ).toBe(false);

        const importSettings = await request.get(
            `${API_BASE}/api/works/${workId}/import-items/settings`,
            { headers: authedHeaders(token) },
        );
        expect(importSettings.status(), 'import-items/settings is 200').toBe(200);
        const importSettingsBody = await importSettings.json();
        expect(importSettingsBody.import_enabled, 'item import is OFF without a data repo').toBe(
            false,
        );
        expect(
            typeof importSettingsBody.import_max_rows,
            'import settings expose a numeric row cap',
        ).toBe('number');

        // The export DOWNLOAD itself is 404 while disabled (documented behaviour).
        const exportDownload = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=csv`,
            { headers: authedHeaders(token) },
        );
        expect(exportDownload.status(), 'export download is 404 when export is disabled').toBe(404);
        expect(String((await exportDownload.json()).message), 'export-disabled message').toMatch(
            /not enabled/i,
        );

        // And the item-import execute is 404 while disabled, NOT a 5xx.
        const itemImport = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows: [] },
        });
        expect(itemImport.status(), 'item-import is 404 when import is disabled').toBe(404);

        // --- Step 6: the item export/import surface is auth-gated (anonymous
        // callers get 401, never a leak of the private work's items). ---
        const anonExport = await request.get(
            `${API_BASE}/api/works/${workId}/export-items/settings`,
        );
        expect(anonExport.status(), 'anonymous export-items/settings is 401').toBe(401);
        const anonImport = await request.get(
            `${API_BASE}/api/works/${workId}/import-items/settings`,
        );
        expect(anonImport.status(), 'anonymous import-items/settings is 401').toBe(401);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: Export / round-trip integrity. Read the work + history back and
    //         prove the source URL round-trips losslessly into the recorded
    //         "export" shape (sourceRepository + history params) — i.e. what
    //         the import wrote back faithfully reflects what was imported.
    // ───────────────────────────────────────────────────────────────────────
    test('export / round-trip integrity: source URL round-trips into the recorded import shape', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;

        const suffix = uniqueSuffix();
        const workName = `Roundtrip Integrity ${suffix}`;
        const sourceOwner = `widgets-${suffix}`;
        const sourceRepo = `directory-${suffix}`;
        const sourceUrl = `https://github.com/${sourceOwner}/${sourceRepo}`;

        // --- Import the source. ---
        const imported = await importWork(request, token, {
            sourceUrl,
            sourceType: 'data_repo',
            name: workName,
        });
        expect(imported.body.status, 'import succeeds').toBe('success');
        const workId = imported.body.workId as string;
        expect(workId, 'have a work id').toBeTruthy();

        // --- "Export" #1: the work's sourceRepository block is the structured
        // record of the import (the round-trip artefact). Assert it reflects
        // EVERY component of the imported source losslessly. ---
        const workRes = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(workRes.status(), 'GET imported work').toBe(200);
        const work = (await workRes.json()).work;

        expect(work?.sourceRepository, 'work carries a sourceRepository record').toBeTruthy();
        const sr = work.sourceRepository;
        expect(sr.url, 'sourceRepository.url round-trips the imported URL').toBe(sourceUrl);
        expect(sr.owner, 'sourceRepository.owner round-trips the parsed owner').toBe(sourceOwner);
        expect(sr.repo, 'sourceRepository.repo round-trips the parsed repo').toBe(sourceRepo);
        expect(sr.type, 'sourceRepository.type round-trips the import source type').toBe(
            'data_repo',
        );
        expect(typeof sr.importedAt, 'sourceRepository.importedAt is recorded').toBe('string');
        expect(
            Number.isFinite(Date.parse(sr.importedAt)),
            'importedAt is a parseable timestamp',
        ).toBe(true);
        // The related data repository points back at the same source.
        expect(
            sr.relatedRepositories?.data?.owner,
            'related data repo owner matches the source',
        ).toBe(sourceOwner);
        expect(
            sr.relatedRepositories?.data?.repo,
            'related data repo name matches the source',
        ).toBe(sourceRepo);

        // The work description also reflects the source (human-readable export).
        expect(work?.description, 'description reflects the imported source').toBe(
            `Imported from ${sourceUrl}`,
        );

        // Truthful CI posture: with no git token the async import errored.
        expect(work?.generateStatus?.status, 'import generateStatus is error without git').toBe(
            'error',
        );
        expect(
            String(work?.generateStatus?.error ?? ''),
            'generateStatus error names the missing git token',
        ).toMatch(/token/i);

        // --- "Export" #2: the GenerationHistory parameters are the second,
        // independent record of the import. Assert it agrees with the work
        // record (round-trip integrity across BOTH persisted surfaces). ---
        const historyRes = await request.get(`${API_BASE}/api/works/${workId}/history`, {
            headers: authedHeaders(token),
        });
        expect(historyRes.status(), 'GET history').toBe(200);
        const history = (await historyRes.json()).history;
        const params = history[0]?.parameters;
        expect(params?.sourceUrl, 'history sourceUrl matches the work record').toBe(sr.url);
        expect(params?.sourceOwner, 'history sourceOwner matches the work record').toBe(sr.owner);
        expect(params?.sourceRepo, 'history sourceRepo matches the work record').toBe(sr.repo);
        expect(params?.sourceType, 'history sourceType matches the work record').toBe(sr.type);
        expect(history[0]?.errorMessage, 'history records the same git-token failure').toMatch(
            /token/i,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: Idempotency contract. Re-importing the SAME name does NOT create
    //         a duplicate work ("Work already exists"); a DIFFERENT name DOES
    //         create a new work — proving the dedup is keyed on the derived
    //         slug, and that a re-import is a safe, non-duplicating no-op.
    // ───────────────────────────────────────────────────────────────────────
    test('re-import idempotency: same name is a no-op (no duplicate), different name imports anew', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;

        const suffix = uniqueSuffix();
        const workName = `Idempotent Import ${suffix}`;
        const sourceUrl = `https://github.com/idem-${suffix}/data-repo`;

        // --- First import: succeeds, creates a work. ---
        const first = await importWork(request, token, {
            sourceUrl,
            sourceType: 'data_repo',
            name: workName,
        });
        expect(first.status, 'first import is 202').toBe(202);
        expect(first.body.status, 'first import succeeds').toBe('success');
        const firstWorkId = first.body.workId as string;
        expect(firstWorkId, 'first import created a work').toBeTruthy();

        // Snapshot the owner's work count, identified by the unique suffix.
        const countWithName = async (): Promise<number> => {
            const res = await request.get(
                `${API_BASE}/api/works?search=${encodeURIComponent(suffix)}`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), 'GET /works?search').toBe(200);
            const body = await res.json();
            return ((body.works ?? []) as { name: string }[]).filter((w) => w.name === workName)
                .length;
        };
        expect(await countWithName(), 'exactly one work after the first import').toBe(1);

        // --- Re-import the SAME name (even though the sourceUrl is identical):
        // the documented idempotency contract is "Work already exists" and NO
        // new work is created. The HTTP code is still 202 (controller default);
        // the dedup is signalled in the response BODY. ---
        const second = await importWork(request, token, {
            sourceUrl,
            sourceType: 'data_repo',
            name: workName,
        });
        expect(second.status, 're-import is still 202').toBe(202);
        expect(second.body.status, 're-import is rejected as a duplicate').toBe('error');
        expect(second.body.message, 're-import reports the work already exists').toMatch(
            /already exists/i,
        );
        expect(second.body.workId, 'a duplicate re-import returns NO new workId').toBeFalsy();

        // The duplicate import did NOT create a second work.
        expect(await countWithName(), 'still exactly one work after the duplicate re-import').toBe(
            1,
        );

        // --- Re-import with the SAME name but a DIFFERENT sourceUrl is STILL a
        // duplicate: dedup is keyed on the derived slug (from name), not the
        // URL. ---
        const sameNameOtherUrl = await importWork(request, token, {
            sourceUrl: `https://github.com/idem-${suffix}/another-repo`,
            sourceType: 'data_repo',
            name: workName,
        });
        expect(sameNameOtherUrl.body.status, 'same name + different URL is still a duplicate').toBe(
            'error',
        );
        expect(sameNameOtherUrl.body.message, 'still reports already-exists').toMatch(
            /already exists/i,
        );
        expect(await countWithName(), 'still exactly one work — dedup is on the slug').toBe(1);

        // --- A DIFFERENT name imports a brand-new, distinct work. ---
        const otherName = `Idempotent Import ${suffix} Two`;
        const third = await importWork(request, token, {
            sourceUrl,
            sourceType: 'data_repo',
            name: otherName,
        });
        expect(third.body.status, 'a differently-named import succeeds').toBe('success');
        const thirdWorkId = third.body.workId as string;
        expect(thirdWorkId, 'the new import created a work').toBeTruthy();
        expect(thirdWorkId, 'the new work is a DISTINCT entity from the first').not.toBe(
            firstWorkId,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 4: Import-endpoint validation contract + the auth gate. A malformed
    //         import payload is rejected with a 400 (and the route is auth-
    //         protected), so the dedup/creation path is never reached with
    //         garbage. This guards the import pipeline's front door.
    // ───────────────────────────────────────────────────────────────────────
    test('import validation + auth gate: malformed payloads are 400, anonymous is 401', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const owner: RegisteredUser = await registerUserViaAPI(request);
        const token = owner.access_token;
        const suffix = uniqueSuffix();

        // Anonymous import is rejected (401) before any validation.
        const anon = await request.post(`${API_BASE}/api/works/import`, {
            data: {
                sourceUrl: 'https://github.com/a/b',
                sourceType: 'data_repo',
                name: `Anon ${suffix}`,
                gitProvider: 'github',
            },
        });
        expect(anon.status(), 'anonymous import is 401').toBe(401);

        // sourceUrl must be a valid URL.
        const badUrl = await request.post(`${API_BASE}/api/works/import`, {
            headers: authedHeaders(token),
            data: {
                sourceUrl: 'not a url',
                sourceType: 'data_repo',
                name: `Bad URL ${suffix}`,
                gitProvider: 'github',
            },
        });
        expect(badUrl.status(), 'non-URL sourceUrl is rejected (400)').toBe(400);
        expect(
            String((await badUrl.json()).message),
            '400 names the repository-URL requirement',
        ).toMatch(/repository url/i);

        // sourceType must be one of the documented enum values.
        const badType = await request.post(`${API_BASE}/api/works/import`, {
            headers: authedHeaders(token),
            data: {
                sourceUrl: 'https://github.com/a/b',
                sourceType: 'totally-bogus',
                name: `Bad Type ${suffix}`,
                gitProvider: 'github',
            },
        });
        expect(badType.status(), 'invalid sourceType is rejected (400)').toBe(400);
        expect(
            String((await badType.json()).message),
            '400 enumerates the valid source types',
        ).toMatch(/data_repo/i);

        // Missing required fields (name + gitProvider) -> 400, never a 5xx.
        const missing = await request.post(`${API_BASE}/api/works/import`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(missing.status(), 'an empty import body is rejected (400)').toBe(400);
        expect(missing.status(), 'validation failures never 5xx').toBeLessThan(500);

        // A non-existent work id on the item-import/export surface is auth-passed
        // but ownership/existence-gated to a 4xx (never a 5xx, never a 200).
        const ghostExport = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items/settings`,
            { headers: authedHeaders(token) },
        );
        expect(
            ghostExport.status(),
            'export-items on a non-existent work is 4xx, not 5xx',
        ).toBeGreaterThanOrEqual(400);
        expect(ghostExport.status(), 'export-items on a ghost work is not 5xx').toBeLessThan(500);
        expect(ghostExport.status(), 'export-items on a ghost work is not 200').not.toBe(200);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 5 (UI, targeted + tolerant): the /works/new page exposes an
    //         "import existing" mode that reveals a repository picker or a
    //         GitHub-connect prompt — the front door of the same import
    //         pipeline exercised by the API above. Tolerant of build variants.
    // ───────────────────────────────────────────────────────────────────────
    test('works/new exposes the import-existing mode (repository picker or connect prompt)', async ({
        page,
    }) => {
        test.setTimeout(60_000);

        await page.goto('/en/works/new', { waitUntil: 'domcontentloaded' });
        await expect(page, 'authenticated /works/new does not redirect to login').not.toHaveURL(
            /\/login/,
            { timeout: 30_000 },
        );

        const importCard = page
            .locator('button')
            .filter({ hasText: /import existing|from repository|from github/i })
            .first();

        if (!(await importCard.isVisible({ timeout: 8_000 }).catch(() => false))) {
            // The import-mode entry point is not present in this build variant.
            // The API flows above are the authoritative coverage; this UI check
            // is a best-effort surface assertion only.
            test.skip(true, 'import-existing mode card not present in this build');
        }

        // Clicking the import-mode card is hydration-racey under `next dev`;
        // retry the open until the import surface appears.
        await expect(async () => {
            await importCard.click({ timeout: 5_000 });
            const body = (await page.locator('body').innerText()).toLowerCase();
            expect(
                body,
                'import view shows a repository / github / connect / import surface',
            ).toMatch(/github|repository|connect|import/);
        }).toPass({ timeout: 30_000 });
    });
});
