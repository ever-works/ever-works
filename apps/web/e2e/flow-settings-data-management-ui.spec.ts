import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-settings-data-management-ui — the /settings/data "Data Management"
 * surface: the import DoS-bound matrix, the import HTTP-method matrix, the
 * apply body-defaulting edges, and the import-CARD UI reveal. These are the
 * GAPS the dense neighbourhood of account-data specs leaves bare.
 *
 * ─── NON-DUPLICATION (surveyed sibling specs; we do NOT restate them) ─────
 *   - flow-account-data-export.spec.ts / flow-account-data-deletion.spec.ts
 *       → export envelope/headers/secrets-masking/v2-tail/idempotency/auth +
 *         the import preview/apply round-trip, conflict resolution, the
 *         deletion-endpoint-404 contract, and the danger-zone double-gate UI.
 *   - flow-account-export-import-roundtrip.spec.ts (10 flows)
 *       → cross-user apply, masked-secret warning, missing-plugin skip,
 *         conflict determinism, path-traversal rename, malformed apply
 *         (no-payload / bad-version), the auth gate, AND the ONE DoS cap it
 *         covers: data.works > MAX_IMPORT_WORKS (5000).
 *   - flow-settings-data-privacy.spec.ts (7 flows)
 *       → account-level sync prefs, privacy-toggle↔export interaction, the
 *         danger no-op, AND the /settings/data UI render of the EXPORT button +
 *         the GitHubSync widget (OAuth-gated). It does NOT touch the IMPORT card.
 *   - settings.spec.ts / settings-extra.spec.ts → shallow nav smoke.
 *
 * What NONE of them pin (this file's reason to exist):
 *   (A) The THREE other import DoS caps. The roundtrip spec only trips
 *       data.works > 5000. The controller (apps/api/src/account/account.controller.ts,
 *       assertImportPayloadBounds) ALSO bounds — each with a DISTINCT message —
 *       a work's items (> 100000), a work's nested arrays (categories/tags/…
 *       > 50000), and data.userPlugins (> 5000). And these caps guard BOTH
 *       /import/preview AND /import/apply (apply bounds body.payload too).
 *   (B) The import HTTP-method matrix: /import/preview + /import/apply are
 *       POST-only (GET/DELETE → 404), mirroring the export GET-only contract
 *       (POST/PUT export → 404). No sibling asserts the import verbs.
 *   (C) Apply body-DEFAULTING: a body with NO `resolutions` key still applies
 *       (the controller defaults it to []); a null/empty payload yields a
 *       GRACEFUL ImportResult { success:false, errors:["Invalid payload: …"] }
 *       — a clean 200 envelope, never a 5xx.
 *   (D) The IMPORT-card UI: clicking "Import Data" reveals the ImportFlow
 *       upload step (dropzone + hidden .json file <input> + "Select File" +
 *       Cancel), and Cancel collapses it back to the import button. The
 *       existing UI spec only drove the export button + sync widget.
 *
 * ─── PROBED LIVE CONTRACT (127.0.0.1:3100/3000, throwaway users) ──────────
 *   POST /api/account/import/preview  (auth)
 *     work.items length 100001  → 400 "Import payload too large: a work's items exceeds 100000"
 *     work.categories len 50001  → 400 "Import payload too large: a work's nested array exceeds 50000"
 *     data.userPlugins len 5001  → 400 "Import payload too large: userPlugins exceeds 5000"
 *     empty {}                    → 400 "Request body is empty"
 *   POST /api/account/import/apply    (auth)
 *     same three over-cap shapes  → 400 (bounds applied to body.payload)
 *     { payload } (no resolutions) → 200 { success:true, …all-zero, errors:[] }
 *     { payload:null, resolutions:[] } → 200 { success:false, errors:["Invalid payload: expected a JSON object"] }
 *     {}                           → 200 { success:false, errors:["Invalid payload: expected a JSON object"] }
 *   Method matrix (auth):
 *     GET /import/preview, GET /import/apply, DELETE /import/preview → 404
 *     POST /export, PUT /export                                      → 404 (export is GET-only)
 *   Auth gate: POST /import/preview, POST /import/apply (anon) → 401.
 *   UI: GET /en/settings/data (anon) → 307 redirect away from the data form.
 *       The seeded /settings/data page renders Export + Import cards; clicking
 *       "Import Data" mounts the dropzone (input[type=file][accept=".json"]).
 *
 * Isolation: every API mutation runs on a FRESH registerUserViaAPI() user so
 * the shared in-memory DB stays clean for sibling specs. Unique suffixes come
 * from a per-test counter (NOT a module-scope clock). The seeded storageState
 * user is used ONLY for read-only UI assertions; anon uses an explicit empty
 * storageState context. Assertions tolerate pre-existing rows.
 */

const PREVIEW = `${API_BASE}/api/account/import/preview`;
const APPLY = `${API_BASE}/api/account/import/apply`;
const EXPORT = `${API_BASE}/api/account/export`;
const TIMEOUT = 25_000;

// Probed caps (apps/api/src/account/account.controller.ts).
const MAX_IMPORT_WORKS = 5000;
const MAX_IMPORT_USER_PLUGINS = 5000;
const MAX_IMPORT_ITEMS_PER_WORK = 100000;
const MAX_IMPORT_NESTED_PER_WORK = 50000;

/** Per-test unique-suffix counter — never a module-scope Date.now(). */
let seq = 0;
function nextStamp(): string {
    seq += 1;
    return `${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A minimal, structurally-valid v1 export envelope. */
function envelope(works: unknown[], userPlugins: unknown[] = []) {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        includesSecrets: false,
        data: {
            profile: { username: 'x', email: 'x@x.x' },
            works,
            userPlugins,
        },
    };
}

async function postJson(
    request: APIRequestContext,
    url: string,
    token: string | null,
    data: unknown,
): Promise<{ status: number; json: any; text: string }> {
    const res = await request.post(url, {
        headers: token ? authedHeaders(token) : undefined,
        data: data as Record<string, unknown>,
        timeout: TIMEOUT,
    });
    const text = await res.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* status asserted by caller */
    }
    return { status: res.status(), json, text };
}

test.describe('flow: import DoS-bound matrix — the three caps the roundtrip spec leaves bare', () => {
    // ── Flow 1 ────────────────────────────────────────────────────
    // A single work carrying an over-cap `items` array is rejected at the
    // controller bound BEFORE the unguarded service iterates it — with the
    // exact per-work-items message — on BOTH preview and apply. (roundtrip
    // Flow 9 only trips the top-level works>5000 cap; the per-work item cap
    // is a distinct guard with a distinct message.)
    test('Flow 1: a work with items > 100000 is bounded on preview AND apply (exact message)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const overItems = {
            slug: `cap-items-${nextStamp()}`,
            name: 'n',
            items: Array.from({ length: MAX_IMPORT_ITEMS_PER_WORK + 1 }, () => ({})),
        };
        const payload = envelope([overItems]);

        const prev = await postJson(request, PREVIEW, u.access_token, payload);
        expect(prev.status, `preview status ${prev.status}`).toBe(400);
        expect(prev.json?.message, 'exact per-work items-cap message').toBe(
            "Import payload too large: a work's items exceeds 100000",
        );

        // The same bound guards apply (it validates body.payload before the
        // service touches it) — never a 5xx, never silently iterated.
        const app = await postJson(request, APPLY, u.access_token, { payload, resolutions: [] });
        expect(app.status, `apply status ${app.status}`).toBe(400);
        expect(app.json?.message, 'apply enforces the same per-work items cap').toBe(
            "Import payload too large: a work's items exceeds 100000",
        );
    });

    // ── Flow 2 ────────────────────────────────────────────────────
    // A work whose NESTED arrays (categories/tags/collections/…) blow the
    // per-nested cap is rejected with the nested-array message. We assert it
    // per-collection so the guard is proven to cover the whole nested set,
    // not just one field.
    test('Flow 2: a work with a nested array > 50000 is bounded (categories/tags/collections)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const oversized = Array.from({ length: MAX_IMPORT_NESTED_PER_WORK + 1 }, () => ({}));

        for (const field of ['categories', 'tags', 'collections'] as const) {
            const work = {
                slug: `cap-${field}-${nextStamp()}`,
                name: 'n',
                [field]: oversized,
            };
            const res = await postJson(request, PREVIEW, u.access_token, envelope([work]));
            expect(res.status, `preview(${field}) status ${res.status}`).toBe(400);
            expect(res.json?.message, `nested-array cap message for ${field}`).toBe(
                "Import payload too large: a work's nested array exceeds 50000",
            );
        }
    });

    // ── Flow 3 ────────────────────────────────────────────────────
    // The top-level userPlugins array has its OWN cap (distinct from the
    // works cap that roundtrip Flow 9 already covers), enforced on preview
    // and apply with the userPlugins-specific message.
    test('Flow 3: userPlugins > 5000 is bounded on preview AND apply (distinct from works cap)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const plugins = Array.from({ length: MAX_IMPORT_USER_PLUGINS + 1 }, (_, i) => ({
            pluginId: `p${i}`,
        }));
        const payload = envelope([], plugins);

        const prev = await postJson(request, PREVIEW, u.access_token, payload);
        expect(prev.status, `preview status ${prev.status}`).toBe(400);
        expect(prev.json?.message, 'exact userPlugins-cap message').toBe(
            'Import payload too large: userPlugins exceeds 5000',
        );

        const app = await postJson(request, APPLY, u.access_token, { payload, resolutions: [] });
        expect(app.status, `apply status ${app.status}`).toBe(400);
        expect(app.json?.message, 'apply enforces the userPlugins cap too').toBe(
            'Import payload too large: userPlugins exceeds 5000',
        );
    });

    // ── Flow 4 ────────────────────────────────────────────────────
    // The bounds are a CEILING, not a floor: a payload sitting JUST under
    // each cap is accepted (preview answers 200 with a verdict). Proves the
    // guard rejects only abusively-large bodies and never clamps a large-
    // but-legitimate export. We probe the cheapest under-cap shape — a
    // userPlugins array one element below its cap — to keep the body sane.
    test('Flow 4: a payload just UNDER the caps is accepted (the bound is a ceiling, not a clamp)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // MAX-1 userPlugins: under the cap, so the controller bound passes and
        // the service previews it. (We assert it is NOT a 400 bound-rejection.)
        const plugins = Array.from({ length: MAX_IMPORT_USER_PLUGINS - 1 }, (_, i) => ({
            pluginId: `under-cap-${i}`,
            enabled: true,
            settings: {},
        }));
        const res = await postJson(request, PREVIEW, u.access_token, envelope([], plugins));
        expect(res.status, `under-cap preview status ${res.status}`).toBe(200);
        // It is a real preview verdict, not the bound error. A 200 preview
        // carries NO error `message` field — the bound-rejection 400 would.
        expect(
            /Import payload too large/.test(String(res.json?.message ?? '')),
            'under-cap body is NOT bound-rejected',
        ).toBe(false);
        expect(typeof res.json?.valid, 'preview returns a validity verdict').toBe('boolean');
        expect(res.json?.userPluginCount, 'preview counts the under-cap plugins').toBe(
            MAX_IMPORT_USER_PLUGINS - 1,
        );
    });
});

test.describe('flow: import method matrix + apply body-defaulting (uncovered controller edges)', () => {
    // ── Flow 5 ────────────────────────────────────────────────────
    // The import endpoints are POST-only and the export is GET-only. Wrong
    // verbs 404 (NestJS doesn't route them) rather than reaching a handler.
    // Mirrors the export GET-only contract for the import side, which no
    // sibling asserts.
    test('Flow 5: import is POST-only, export is GET-only — wrong verbs 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const H = authedHeaders(u.access_token);

        // Import endpoints reject non-POST verbs.
        const getPreview = await request.get(PREVIEW, { headers: H, timeout: TIMEOUT });
        expect(getPreview.status(), 'GET /import/preview not routed').toBe(404);
        const getApply = await request.get(APPLY, { headers: H, timeout: TIMEOUT });
        expect(getApply.status(), 'GET /import/apply not routed').toBe(404);
        const delPreview = await request.delete(PREVIEW, { headers: H, timeout: TIMEOUT });
        expect(delPreview.status(), 'DELETE /import/preview not routed').toBe(404);

        // Export rejects mutating verbs (it is a pure GET download).
        const postExport = await request.post(EXPORT, { headers: H, timeout: TIMEOUT });
        expect(postExport.status(), 'POST /export not routed').toBe(404);
        const putExport = await request.put(EXPORT, { headers: H, timeout: TIMEOUT });
        expect(putExport.status(), 'PUT /export not routed').toBe(404);
    });

    // ── Flow 6 ────────────────────────────────────────────────────
    // apply DEFAULTS a missing `resolutions` key to [] (controller:
    // `body.resolutions || []`). An empty-account export applied with NO
    // resolutions key still returns a clean all-zero success envelope. Pins
    // the defaulting branch the roundtrip spec never exercises (it always
    // passes `resolutions`).
    test('Flow 6: apply with NO resolutions key defaults to [] and returns a clean envelope', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // A real, empty export of the fresh account is the cleanest payload.
        const exp = await request.get(EXPORT, {
            headers: authedHeaders(u.access_token),
            timeout: TIMEOUT,
        });
        expect(exp.status()).toBe(200);
        const payload = await exp.json();

        // Body intentionally OMITS `resolutions`.
        const res = await postJson(request, APPLY, u.access_token, { payload });
        expect(res.status, `apply(no-resolutions) status ${res.status}`).toBe(200);
        expect(res.json?.success, 'empty-account apply succeeds').toBe(true);
        expect(res.json?.errors, 'no errors on the defaulted-resolutions path').toEqual([]);
        for (const k of [
            'worksCreated',
            'worksUpdated',
            'worksSkipped',
            'userPluginsImported',
        ] as const) {
            expect(typeof res.json?.[k], `ImportResult.${k} is numeric`).toBe('number');
        }
        // Fresh empty account → nothing imported.
        expect(res.json?.worksCreated, 'empty export creates no works').toBe(0);
    });

    // ── Flow 7 ────────────────────────────────────────────────────
    // apply tolerates a structurally-bad payload GRACEFULLY: a null payload
    // (and an empty {} body) yield a 200 ImportResult with success:false and
    // the precise "Invalid payload" error — NEVER a 5xx. (preview's empty-{}
    // path 400s with "Request body is empty"; apply's path is a different
    // contract — a soft-fail envelope — and is uncovered.)
    test('Flow 7: apply with a null / empty payload soft-fails (200 success:false), never 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const nullPayload = await postJson(request, APPLY, u.access_token, {
            payload: null,
            resolutions: [],
        });
        expect(nullPayload.status, `null-payload apply status ${nullPayload.status}`).toBe(200);
        expect(nullPayload.json?.success, 'null payload reports failure, not a throw').toBe(false);
        expect(
            (nullPayload.json?.errors as string[]).some((e) =>
                /Invalid payload: expected a JSON object/i.test(e),
            ),
            `expected the invalid-payload error; got ${JSON.stringify(nullPayload.json?.errors)}`,
        ).toBe(true);

        // An empty {} body (no payload key) takes the same soft-fail path on apply.
        const emptyBody = await postJson(request, APPLY, u.access_token, {});
        expect(emptyBody.status, `empty-body apply status ${emptyBody.status}`).toBe(200);
        expect(emptyBody.json?.success, 'empty apply body soft-fails too').toBe(false);
        expect(
            (emptyBody.json?.errors as string[]).some((e) =>
                /Invalid payload: expected a JSON object/i.test(e),
            ),
            'empty apply body surfaces the same invalid-payload error',
        ).toBe(true);

        // Contrast: preview's empty-{} guard is a HARD 400 with a different
        // message — proving the two endpoints have distinct empty-body contracts.
        const emptyPreview = await postJson(request, PREVIEW, u.access_token, {});
        expect(emptyPreview.status, 'preview empty {} is a hard 400').toBe(400);
        expect(emptyPreview.json?.message, 'preview empty-body message').toBe(
            'Request body is empty',
        );
    });

    // ── Flow 8 ────────────────────────────────────────────────────
    // The import write endpoints are auth-gated: anonymous preview + apply
    // both 401 (the bound/soft-fail logic only runs AFTER the auth guard, so
    // an anon caller never even reaches it).
    test('Flow 8: import preview + apply are auth-gated — anon → 401 before any bound runs', async ({
        request,
    }) => {
        // An over-cap anon body still 401s (auth fires before the bound) —
        // proving the DoS guard is not a pre-auth amplification surface.
        const overCap = envelope(
            Array.from({ length: MAX_IMPORT_WORKS + 1 }, (_, i) => ({ slug: `w${i}`, name: 'n' })),
        );
        const anonPreview = await postJson(request, PREVIEW, null, overCap);
        expect(anonPreview.status, 'anon preview → 401').toBe(401);
        const anonApply = await postJson(request, APPLY, null, {
            payload: overCap,
            resolutions: [],
        });
        expect(anonApply.status, 'anon apply → 401').toBe(401);
    });
});

test.describe('flow: data-management UI — the import card + auth gate (export side already covered)', () => {
    // ── Flow 9 ────────────────────────────────────────────────────
    // The /settings/data page renders BOTH the Export and Import cards. The
    // sibling UI spec drove the export button + sync widget; here we pin the
    // IMPORT card's entry affordance ("Import Data" button) alongside the
    // import description copy. Read-only, seeded storageState.
    test('Flow 9: settings/data renders the Import card with its action + description', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });

        const body = page.locator('body');
        await expect(body, 'import section present').toContainText(/import data/i, {
            timeout: 20_000,
        });
        // The import description (probed i18n) frames the JSON-file restore flow.
        await expect(body, 'import description copy').toContainText(
            /import data from a previously exported json file/i,
            { timeout: 10_000 },
        );

        // The import entry button is a live, enabled affordance (variant
        // secondary). There are two "Import Data" strings (heading + button), so
        // target the button role specifically and take the first match.
        const importBtn = page
            .getByRole('button', { name: /import data/i })
            .or(page.locator('button').filter({ hasText: /import data/i }))
            .first();
        await expect(importBtn, 'import button is visible').toBeVisible({ timeout: 15_000 });
        await expect(importBtn, 'import button is enabled').toBeEnabled({ timeout: 10_000 });
    });

    // ── Flow 10 ───────────────────────────────────────────────────
    // Clicking "Import Data" REVEALS the ImportFlow upload step: the dropzone
    // copy, the hidden `.json` file <input>, and the "Select File" / Cancel
    // controls. Cancel collapses the flow back to the import button. This is
    // the import-side UI nobody else drives.
    test('Flow 10: clicking Import reveals the dropzone + file input, Cancel collapses it', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });

        const importBtn = page
            .getByRole('button', { name: /import data/i })
            .or(page.locator('button').filter({ hasText: /import data/i }))
            .first();
        await expect(importBtn).toBeVisible({ timeout: 20_000 });

        // Retry-to-open: the first click can be dropped during hydration.
        const dropzone = page.getByText(/drag and drop a json export file/i);
        await expect(async () => {
            if (!(await dropzone.isVisible().catch(() => false))) {
                await importBtn.click();
            }
            await expect(dropzone).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // The hidden file input only accepts .json (the restore contract).
        const fileInput = page.locator('input[type="file"]');
        await expect(fileInput, 'a file input is mounted').toHaveCount(1);
        await expect(fileInput, 'file input is .json-scoped').toHaveAttribute('accept', '.json');

        // The "Select File" affordance + a Cancel control are both present.
        await expect(
            page.getByText(/select file/i).first(),
            'select-file affordance visible',
        ).toBeVisible({ timeout: 10_000 });

        // Cancel collapses the flow back to the import entry button.
        const cancel = page.getByRole('button', { name: /^cancel$/i }).first();
        await expect(cancel).toBeVisible({ timeout: 10_000 });
        await cancel.click();
        await expect(dropzone, 'Cancel collapses the import flow').toBeHidden({ timeout: 10_000 });
        await expect(importBtn, 'the import entry button is back').toBeVisible({ timeout: 10_000 });
    });

    // ── Flow 11 ───────────────────────────────────────────────────
    // Feeding a real account export back through the import dropzone (via the
    // hidden file input) drives the client previewImport server action and
    // advances to the PREVIEW step — proving the upload→preview UI wiring on
    // a payload that is valid by construction (an actual export of a fresh
    // user with one Work). Seeded UI page, but the payload is a fresh API user
    // so we never mutate the seeded account.
    test('Flow 11: uploading a real export advances the import flow to the preview summary', async ({
        page,
        baseURL,
        request,
    }) => {
        // Build a real, valid export from a throwaway user (one Work) via API.
        const apiUser = await registerUserViaAPI(request);
        const stamp = nextStamp();
        await createWorkViaAPI(request, apiUser.access_token, {
            name: `Import UI Work ${stamp}`,
            slug: `import-ui-work-${stamp}`,
        });
        const exp = await request.get(EXPORT, {
            headers: authedHeaders(apiUser.access_token),
            timeout: TIMEOUT,
        });
        expect(exp.status()).toBe(200);
        const exportJson = await exp.json();

        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });

        const importBtn = page
            .getByRole('button', { name: /import data/i })
            .or(page.locator('button').filter({ hasText: /import data/i }))
            .first();
        await expect(importBtn).toBeVisible({ timeout: 20_000 });

        const dropzone = page.getByText(/drag and drop a json export file/i);
        await expect(async () => {
            if (!(await dropzone.isVisible().catch(() => false))) {
                await importBtn.click();
            }
            await expect(dropzone).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // Set the hidden file input to the export bytes (named .json so the
        // client's extension guard passes).
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
            name: `account-export-${stamp}.json`,
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(exportJson), 'utf8'),
        });

        // The client runs previewImport and advances to the preview SUMMARY.
        // The summary header copy ("Summary") + the per-section labels render.
        // Best-effort across LOCAL/CI render: accept the summary OR the apply
        // affordance the valid preview unlocks; either proves we left "upload".
        const advanced = page
            .getByText(/summary/i)
            .or(page.getByRole('button', { name: /apply import/i }))
            .or(page.getByText(/works/i))
            .first();
        await expect(advanced, 'upload advanced past the dropzone into preview').toBeVisible({
            timeout: 20_000,
        });
        // The dropzone is gone once we are on the preview step.
        await expect(dropzone, 'dropzone replaced by the preview step').toBeHidden({
            timeout: 10_000,
        });
    });

    // ── Flow 12 ───────────────────────────────────────────────────
    // The whole /settings/data surface is auth-gated: an ANONYMOUS visitor
    // does not get the data-management form — they are redirected to the
    // auth surface and the export/import controls never render. Explicit
    // empty-storageState context (never the seeded cookie).
    test('Flow 12: anonymous /settings/data is auth-gated — redirected, no data controls render', async ({
        browser,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        // Empty storageState → a genuinely anonymous context (no seeded cookie).
        const ctx = await (browser as Browser).newContext({
            storageState: { cookies: [], origins: [] },
        });
        const anon = await ctx.newPage();
        try {
            await anon.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });
            // We must NOT remain on the settings/data form. The middleware bounces
            // anon callers to the auth surface (probed: 307 away from the page).
            await expect
                .poll(() => anon.url(), { timeout: 20_000 })
                .not.toMatch(/\/settings\/data/);
            // Whatever we landed on, the export/import action buttons are absent —
            // the data-management controls never render for an anon visitor.
            await expect(
                anon.getByRole('button', { name: /export data/i }),
                'no export control for anon',
            ).toHaveCount(0);
            await expect(
                anon.getByText(/drag and drop a json export file/i),
                'no import dropzone for anon',
            ).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    });
});
