import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-items-import-export.spec.ts
 *
 * Works long-tail DEEP coverage for the per-directory CSV/Excel ITEM
 * import/export family:
 *   GET  /api/works/:id/export-items/settings
 *   GET  /api/works/:id/export-items?format=csv|xlsx
 *   GET  /api/works/:id/import-items/settings
 *   GET  /api/works/:id/import-items/sample?format=csv|xlsx
 *   POST /api/works/:id/import-items/validate   (multipart file=…)
 *   POST /api/works/:id/import-items            (json { rows: [...] })
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION (surveyed apps/web/e2e/ for export-items|import-items on
 * 2026-06-12). Sibling coverage deliberately NOT repeated here:
 *   - items-import-export.spec.ts ............ EW-533 SMOKE: the bare auth gate
 *       (anon -> 401) + "bad format / non-existent id -> 4xx-not-5xx" on a
 *       SYNTHETIC FAKE_WORK_ID only. Never a REAL work, never a 403, never the
 *       exact 200-settings envelope, never the validation-gradient ordering.
 *   - flow-work-import-export.spec.ts ........ Flow 1 pins, on ONE real imported
 *       work, that export-items/settings is 200 {export_enabled:false} and
 *       import-items/settings is 200 {import_enabled:false,import_max_rows:number},
 *       and that the export download + import execute are 404 "not enabled" for
 *       the OWNER. It does NOT pin the sample/validate routes, the per-route
 *       400-vs-403-vs-404 PRECEDENCE, or any CROSS-USER 403.
 *   - flow-work-export-roundtrip.spec.ts ..... the WHOLE-ACCOUNT /api/account
 *       export/import/preview/apply transfer surface — a different family.
 *   - flow-work-import-deep.spec.ts / flow-work-import-export.spec.ts (import
 *       half) ................................ the POST /api/works/import repo
 *       pipeline (analyze/dedup/GenerationHistory) — NOT the item CSV family.
 *   - upload-import / large-payload / sec-pin-throttle-contracts ... uploads,
 *       size caps, throttles — orthogonal.
 *
 * THE GAP THIS FILE PINS (the long tail the siblings leave open): the EXACT,
 * per-route GATE-PRECEDENCE matrix for the item import/export controller, and a
 * REAL cross-user 403 (siblings only ever probe FAKE_WORK_ID -> 404 + anon ->
 * 401). The precedence is NOT uniform across the family, and that asymmetry is
 * the load-bearing contract:
 *
 *   route                         | param/body shape (400) | ownership/existence
 *   ------------------------------|------------------------|---------------------
 *   export-items[/sample]         | format query checked   | … BEFORE ownership:
 *                                 | FIRST                   |  stranger/ghost w/o
 *                                 |                         |  format -> 400
 *   import-items/validate         | `file` multipart field | … BEFORE ownership:
 *                                 | checked FIRST           |  stranger/ghost w/o
 *                                 |                         |  file -> 400
 *   import-items (execute)        | `rows` body checked     | … AFTER ownership:
 *                                 | only once OWNED+FOUND   |  ghost -> 404,
 *                                 |                         |  stranger -> 403,
 *                                 |                         |  owner-no-rows -> 400
 *   {export,import}-items/settings| (no param gate)         | ownership 403 /
 *                                 |                         |  not-found 404
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live API http://127.0.0.1:3100, fresh registered users,
 * a real data_repo-imported work, 2026-06-12):
 *
 *   POST /api/auth/register -> { access_token, user{ id,email,username } }.
 *
 *   POST /api/works/import { sourceUrl, sourceType:'data_repo', name, gitProvider }
 *        -> 202 { status:'success', workId, historyId, message:'Import started' }.
 *        Gives a REAL work whose item import/export settings resolve to 200
 *        (the item routes need a real work row; FAKE_WORK_ID 404s before the
 *        settings handler). The work has NO connected data repo in CI, so both
 *        feature flags are OFF.
 *
 *   GET  /api/works/:id/export-items/settings  [OWNER]  -> 200 { export_enabled:false }.
 *   GET  /api/works/:id/import-items/settings  [OWNER]  -> 200
 *        { import_enabled:false, import_max_rows:500 }   // import_max_rows is a number.
 *
 *   GET  /api/works/:id/export-items?format=csv [OWNER, export OFF]
 *        -> 404 { status:'error', message:'Item export is not enabled for this directory' }.
 *   GET  /api/works/:id/export-items            (NO ?format) [OWNER or stranger or ghost]
 *        -> 400 { message:"Query parameter 'format' must be 'csv' or 'xlsx'" }  // format gate FIRST.
 *   GET  /api/works/:id/export-items?format=json [OWNER]   -> 400 (same format-gate message).
 *
 *   GET  /api/works/:id/import-items/sample?format=csv [OWNER, import OFF]
 *        -> 404 { message:'Item import is not enabled for this directory' }.
 *   GET  /api/works/:id/import-items/sample            (NO ?format)
 *        -> 400 { message:"Query parameter 'format' must be 'csv' or 'xlsx'" }.
 *
 *   POST /api/works/:id/import-items/validate  (no multipart `file`)
 *        -> 400 { message:"Multipart field 'file' is required" }   // file gate FIRST.
 *   POST /api/works/:id/import-items/validate  (real csv multipart file, import OFF)
 *        -> 404 { message:'Item import is not enabled for this directory' }.
 *
 *   POST /api/works/:id/import-items  { rows:[…] }  [OWNER, import OFF]
 *        -> 404 { message:'Item import is not enabled for this directory' }.
 *   POST /api/works/:id/import-items  {}            [OWNER]
 *        -> 400 { message:'Body must include a `rows` array' }.     // body gate AFTER owned+found.
 *
 *   CROSS-USER (stranger owns nothing of this work):
 *        GET export-items/settings  -> 403 'You do not have permission to access this work'
 *        GET export-items?format=csv -> 403 (ownership beats the not-enabled 404)
 *        GET import-items/settings  -> 403
 *        POST import-items {rows}    -> 403
 *        BUT a stranger with a SHAPE-INVALID request hits the param gate FIRST:
 *        GET export-items (no format) -> 400, POST validate (no file) -> 400.
 *
 *   ANON (empty storageState / raw request) on every route -> 401.
 *
 *   GHOST (well-formed but non-existent uuid) for the OWNER:
 *        export-items/settings -> 404 "Work with id '…' not found"
 *        export-items?format=csv -> 404; import-items {rows} -> 404
 *        (but export-items w/o format -> 400, validate w/o file -> 400 — param gate first).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT-ADAPTIVE: keyless CI, no connected git data repo -> both feature
 * flags are OFF and the git-gated WRITES (real export download / real import
 * execute / sample template materialisation) are NOT reachable. We therefore
 * pin the REACHABLE read/validate CONTRACTS and the GATE behaviour, never a
 * successful git-backed mutation. Every assertion tolerates an
 * alternatively-provisioned build (a CI that DID connect a repo would flip a
 * flag) by asserting the gate STATUS for the off-path and never demanding a 200
 * download. ISOLATION: every test registers a FRESH user + imports a FRESH work;
 * unique suffixes from a per-test counter (NOT a module-scope clock); TS strict.
 */

const FAKE_WORK_ID = '00000000-0000-0000-0000-000000000000';

let seq = 0;
function uniqueSuffix(): string {
    seq += 1;
    return `${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface ImportBody {
    status?: string;
    workId?: string;
    historyId?: string;
    message?: string;
}

/**
 * Register a fresh user and import a fresh data_repo work, returning a token +
 * a REAL work id. A real work row is what makes the item-import/export settings
 * routes resolve to 200 (a synthetic id 404s before the settings handler runs),
 * so this is the precondition for every gate test below.
 */
async function freshUserWithWork(
    request: APIRequestContext,
): Promise<{ token: string; workId: string; suffix: string }> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const suffix = uniqueSuffix();
    const res = await request.post(`${API_BASE}/api/works/import`, {
        headers: authedHeaders(token),
        data: {
            sourceUrl: `https://github.com/items-owner-${suffix}/items-repo-${suffix}`,
            sourceType: 'data_repo',
            name: `Items IE ${suffix}`,
            gitProvider: 'github',
        },
    });
    expect(res.status(), 'import a data_repo work -> 202').toBe(202);
    const body = (await res.json()) as ImportBody;
    expect(body.status, 'import succeeds').toBe('success');
    const workId = body.workId as string;
    expect(workId, 'import returns a work id').toBeTruthy();
    return { token, workId, suffix };
}

async function bodyMessage(res: { json: () => Promise<unknown> }): Promise<string> {
    const json = (await res.json().catch(() => ({}))) as { message?: unknown };
    return Array.isArray(json.message) ? json.message.join(' ') : String(json.message ?? '');
}

test.describe('Works item import/export — settings/sample/validate/execute contract', () => {
    // ────────────────────────────────────────────────────────────────────────
    // 1) export-items/settings: the OWNER gets the exact 200 envelope with the
    //    export_enabled boolean OFF (no connected data repo in CI). This is the
    //    reachable read contract; the download itself is gated below.
    // ────────────────────────────────────────────────────────────────────────
    test('export-items/settings: owner gets 200 { export_enabled:false }', async ({ request }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        const res = await request.get(`${API_BASE}/api/works/${workId}/export-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'export-items/settings is 200 for the owner').toBe(200);
        const body = (await res.json()) as { export_enabled?: unknown };
        expect('export_enabled' in body, 'envelope carries export_enabled').toBe(true);
        expect(typeof body.export_enabled, 'export_enabled is a boolean').toBe('boolean');
        // No data repo connected in CI -> export is OFF.
        expect(body.export_enabled, 'export is OFF without a connected data repo').toBe(false);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 2) import-items/settings: the OWNER gets the exact 200 envelope with the
    //    import_enabled boolean OFF AND a numeric import_max_rows cap. The cap
    //    is the contract the wizard reads to bound a paste/upload.
    // ────────────────────────────────────────────────────────────────────────
    test('import-items/settings: owner gets 200 { import_enabled:false, import_max_rows:number }', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        const res = await request.get(`${API_BASE}/api/works/${workId}/import-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'import-items/settings is 200 for the owner').toBe(200);
        const body = (await res.json()) as { import_enabled?: unknown; import_max_rows?: unknown };
        expect(typeof body.import_enabled, 'import_enabled is a boolean').toBe('boolean');
        expect(body.import_enabled, 'item import is OFF without a connected data repo').toBe(false);
        expect(typeof body.import_max_rows, 'import_max_rows is a numeric row cap').toBe('number');
        expect(body.import_max_rows as number, 'import_max_rows is a positive cap').toBeGreaterThan(
            0,
        );
    });

    // ────────────────────────────────────────────────────────────────────────
    // 3) export-items DOWNLOAD: format gate FIRST, then the not-enabled gate.
    //    No ?format -> 400 (format query validated before anything); a valid
    //    format on a real-but-unprovisioned work -> 404 "not enabled". This is
    //    the export half of the validation gradient.
    // ────────────────────────────────────────────────────────────────────────
    test('export-items download: no/invalid format -> 400, valid format on disabled work -> 404 not-enabled', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        // No ?format — the param gate fires FIRST (before ownership/enablement).
        const noFormat = await request.get(`${API_BASE}/api/works/${workId}/export-items`, {
            headers: authedHeaders(token),
        });
        expect(noFormat.status(), 'export download without ?format -> 400').toBe(400);
        expect(await bodyMessage(noFormat), 'names the csv/xlsx requirement').toMatch(
            /must be 'csv' or 'xlsx'/i,
        );

        // An invalid format value -> the same 400 format gate.
        const badFormat = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=json`,
            { headers: authedHeaders(token) },
        );
        expect(badFormat.status(), 'export download with bad format -> 400').toBe(400);
        expect(await bodyMessage(badFormat), 'bad format hits the same gate').toMatch(
            /must be 'csv' or 'xlsx'/i,
        );

        // A VALID format passes the param gate and bottoms out in the truthful
        // not-enabled 404 (no data repo). NEVER a 200 download, never a 5xx.
        const validFormat = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=csv`,
            { headers: authedHeaders(token) },
        );
        expect(validFormat.status(), 'valid-format export on a disabled work -> 404').toBe(404);
        expect(await bodyMessage(validFormat), 'export-disabled message').toMatch(/not enabled/i);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 4) import-items/sample TEMPLATE: identical format-first gradient — no
    //    ?format -> 400, a valid format on the disabled work -> 404 not-enabled.
    //    (The template itself only materialises once import is enabled.)
    // ────────────────────────────────────────────────────────────────────────
    test('import-items/sample: no/invalid format -> 400, valid format on disabled work -> 404 not-enabled', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        const noFormat = await request.get(`${API_BASE}/api/works/${workId}/import-items/sample`, {
            headers: authedHeaders(token),
        });
        expect(noFormat.status(), 'sample without ?format -> 400').toBe(400);
        expect(await bodyMessage(noFormat), 'names the csv/xlsx requirement').toMatch(
            /must be 'csv' or 'xlsx'/i,
        );

        for (const fmt of ['csv', 'xlsx'] as const) {
            const sample = await request.get(
                `${API_BASE}/api/works/${workId}/import-items/sample?format=${fmt}`,
                { headers: authedHeaders(token) },
            );
            expect(sample.status(), `sample ?format=${fmt} on a disabled work -> 404`).toBe(404);
            expect(await bodyMessage(sample), `${fmt} sample not-enabled message`).toMatch(
                /not enabled/i,
            );
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // 5) import-items/validate: `file` multipart gate FIRST. A request with NO
    //    multipart `file` -> 400 "Multipart field 'file' is required" (validated
    //    before ownership/enablement). A WELL-FORMED multipart csv file passes
    //    the file gate and bottoms out in the not-enabled 404 — the validate ->
    //    import contract's front door. (A successful validate needs a connected
    //    data repo, which CI doesn't have, so we pin the reachable gate.)
    // ────────────────────────────────────────────────────────────────────────
    test('import-items/validate: missing file -> 400, well-formed csv on disabled work -> 404 not-enabled', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        // No multipart `file` part at all -> the file gate fires FIRST.
        const noFile = await request.post(`${API_BASE}/api/works/${workId}/import-items/validate`, {
            headers: authedHeaders(token),
            data: { rows: [{ name: 'x' }] },
        });
        expect(noFile.status(), 'validate without a multipart file -> 400').toBe(400);
        expect(await bodyMessage(noFile), 'names the required file field').toMatch(
            /multipart field 'file' is required/i,
        );

        // A well-formed CSV multipart file passes the file gate; with import OFF
        // it bottoms out in the truthful not-enabled 404 (never a 5xx, never a
        // silent 200 "validated 0 rows").
        const wellFormed = await request.post(
            `${API_BASE}/api/works/${workId}/import-items/validate`,
            {
                headers: authedHeaders(token),
                multipart: {
                    file: {
                        name: 'items.csv',
                        mimeType: 'text/csv',
                        buffer: Buffer.from('name,description\nFoo,a foo\nBar,a bar\n'),
                    },
                },
            },
        );
        expect(
            wellFormed.status(),
            'well-formed validate on a disabled work -> 404 not-enabled',
        ).toBe(404);
        expect(await bodyMessage(wellFormed), 'validate not-enabled message').toMatch(
            /not enabled/i,
        );
    });

    // ────────────────────────────────────────────────────────────────────────
    // 6) import-items EXECUTE: the body-shape gate is checked only AFTER the
    //    work is owned + found. Owner + missing `rows` -> 400 "Body must include
    //    a `rows` array"; owner + a well-formed `rows` array on a disabled work
    //    -> 404 not-enabled. This is the validate->import contract's execute end:
    //    a structurally-valid payload is accepted by the body gate but refused by
    //    the enablement gate (never a successful git-backed write in CI).
    // ────────────────────────────────────────────────────────────────────────
    test('import-items execute: missing rows -> 400, well-formed rows on disabled work -> 404 not-enabled', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        // Owner + no `rows` -> the body-shape 400 (reached because the work is
        // owned + found; a stranger/ghost would short-circuit before this — see
        // tests 8 & 9).
        const noRows = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(noRows.status(), 'import execute without rows -> 400').toBe(400);
        expect(await bodyMessage(noRows), 'names the required rows array').toMatch(
            /must include a .?rows.? array/i,
        );

        // Owner + a structurally-valid rows array -> passes the body gate, then
        // the enablement gate refuses it (404). NEVER a 200 created-N, never 5xx.
        const withRows = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows: [{ name: 'Imported Item', description: 'from e2e' }] },
        });
        expect(withRows.status(), 'well-formed import on a disabled work -> 404').toBe(404);
        expect(await bodyMessage(withRows), 'import not-enabled message').toMatch(/not enabled/i);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 7) validate -> import CONTRACT consistency: BOTH steps refuse the same
    //    disabled work with the SAME 404 not-enabled verdict (a well-formed file
    //    validates to the same gate the execute hits). The two-step wizard never
    //    lets a payload that validate-rejected through to execute, and vice
    //    versa: the enablement gate is the single source of truth for both.
    // ────────────────────────────────────────────────────────────────────────
    test('validate->import contract: both steps refuse a disabled work with the same not-enabled 404', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        const validate = await request.post(
            `${API_BASE}/api/works/${workId}/import-items/validate`,
            {
                headers: authedHeaders(token),
                multipart: {
                    file: {
                        name: 'roundtrip.csv',
                        mimeType: 'text/csv',
                        buffer: Buffer.from('name,description\nWidget,a widget\n'),
                    },
                },
            },
        );
        const execute = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows: [{ name: 'Widget', description: 'a widget' }] },
        });

        expect(validate.status(), 'validate step refuses the disabled work').toBe(404);
        expect(execute.status(), 'execute step refuses the disabled work').toBe(404);
        const vMsg = await bodyMessage(validate);
        const eMsg = await bodyMessage(execute);
        expect(vMsg, 'validate not-enabled message').toMatch(/not enabled/i);
        expect(eMsg, 'execute not-enabled message').toMatch(/not enabled/i);
        // The contract is the SAME gate for both halves of the wizard.
        expect(eMsg, 'validate and execute report the same enablement verdict').toBe(vMsg);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 8) CROSS-USER export isolation: a logged-in STRANGER may NOT read another
    //    owner's export settings, may NOT download their items, and may NOT
    //    import into their work — every shape-VALID request -> 403 (the work
    //    exists; they just don't own it). This is the real ownership gate the
    //    FAKE_WORK_ID siblings can't reach. Never a leak (no 200), never a 5xx.
    // ────────────────────────────────────────────────────────────────────────
    test('cross-user isolation: a stranger gets 403 on owner export settings, download, and import', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { workId } = await freshUserWithWork(request);
        const stranger = await registerUserViaAPI(request);
        const strangerToken = stranger.access_token;

        // Settings read — 403 (no param gate to short-circuit).
        const exSettings = await request.get(
            `${API_BASE}/api/works/${workId}/export-items/settings`,
            { headers: authedHeaders(strangerToken) },
        );
        expect(exSettings.status(), 'stranger export-items/settings -> 403').toBe(403);
        expect(await bodyMessage(exSettings), 'forbidden message').toMatch(/permission/i);

        const imSettings = await request.get(
            `${API_BASE}/api/works/${workId}/import-items/settings`,
            { headers: authedHeaders(strangerToken) },
        );
        expect(imSettings.status(), 'stranger import-items/settings -> 403').toBe(403);

        // Download with a VALID format -> ownership 403 beats the not-enabled 404
        // (the export NEVER leaks even one row to a non-owner).
        const download = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=csv`,
            { headers: authedHeaders(strangerToken) },
        );
        expect(download.status(), 'stranger export download (valid format) -> 403').toBe(403);
        expect(download.status(), 'cross-user export is never a 200 leak').not.toBe(200);

        // Import execute with a well-formed body -> ownership 403.
        const importExec = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(strangerToken),
            data: { rows: [{ name: 'evil', description: 'should never land' }] },
        });
        expect(importExec.status(), 'stranger import execute -> 403').toBe(403);
        expect(importExec.status(), 'cross-user import never succeeds').not.toBe(200);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 9) GATE-PRECEDENCE asymmetry — the load-bearing long-tail contract. The
    //    PARAM/BODY-shape gate fires BEFORE ownership on export-items[/sample]
    //    (format query) and on validate (file field), but the ownership gate
    //    fires BEFORE the body gate on import-items (execute). We prove this by
    //    sending SHAPE-INVALID requests as a STRANGER and a GHOST and asserting
    //    which gate wins:
    //      stranger export-items (no format)     -> 400 (format gate wins over 403)
    //      stranger validate     (no file)       -> 400 (file gate wins over 403)
    //      stranger import-items (no rows)        -> 403 (ownership wins over body gate)
    //      owner    import-items (no rows) on GHOST-> 404 (not-found wins over body gate)
    //      owner    export-items (no format) on GHOST -> 400 (format gate wins over 404)
    // ────────────────────────────────────────────────────────────────────────
    test('gate precedence: param/file shape gate precedes ownership; rows body gate follows ownership', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);
        const stranger = await registerUserViaAPI(request);
        const strangerToken = stranger.access_token;

        // export-items: the FORMAT gate precedes ownership — a stranger without
        // ?format gets the 400, not a 403.
        const strangerNoFormat = await request.get(`${API_BASE}/api/works/${workId}/export-items`, {
            headers: authedHeaders(strangerToken),
        });
        expect(
            strangerNoFormat.status(),
            'stranger export w/o format -> 400 (format gate first)',
        ).toBe(400);
        expect(await bodyMessage(strangerNoFormat), 'format-gate message').toMatch(
            /must be 'csv' or 'xlsx'/i,
        );

        // import-items/validate: the FILE gate precedes ownership — a stranger
        // without a multipart file gets the 400, not a 403.
        const strangerNoFile = await request.post(
            `${API_BASE}/api/works/${workId}/import-items/validate`,
            { headers: authedHeaders(strangerToken), data: {} },
        );
        expect(strangerNoFile.status(), 'stranger validate w/o file -> 400 (file gate first)').toBe(
            400,
        );
        expect(await bodyMessage(strangerNoFile), 'file-gate message').toMatch(
            /multipart field 'file' is required/i,
        );

        // import-items (execute): OWNERSHIP precedes the body gate — a stranger
        // with NO rows still gets 403 (not the owner's 400 body message).
        const strangerNoRows = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(strangerToken),
            data: {},
        });
        expect(strangerNoRows.status(), 'stranger import w/o rows -> 403 (ownership first)').toBe(
            403,
        );
        expect(await bodyMessage(strangerNoRows), 'forbidden, not the body-gate message').toMatch(
            /permission/i,
        );

        // GHOST work for the OWNER: not-found precedes the body gate on execute…
        const ghostNoRows = await request.post(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items`,
            {
                headers: authedHeaders(token),
                data: {},
            },
        );
        expect(ghostNoRows.status(), 'ghost import w/o rows -> 404 (not-found first)').toBe(404);
        expect(await bodyMessage(ghostNoRows), 'not-found message').toMatch(/not found/i);

        // …but the FORMAT gate STILL precedes not-found on export (a ghost w/o
        // format is a 400, proving the param gate is the very first check).
        const ghostNoFormat = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items`,
            { headers: authedHeaders(token) },
        );
        expect(ghostNoFormat.status(), 'ghost export w/o format -> 400 (format gate first)').toBe(
            400,
        );
        expect(await bodyMessage(ghostNoFormat), 'format-gate message on a ghost').toMatch(
            /must be 'csv' or 'xlsx'/i,
        );
    });

    // ────────────────────────────────────────────────────────────────────────
    // 10) GHOST not-found: for the OWNER, a well-formed-but-non-existent work id
    //     (and a syntactically-invalid id) bottoms out in a clean 404 on the
    //     settings + valid-format download routes — never a 5xx, never a 200.
    // ────────────────────────────────────────────────────────────────────────
    test('ghost/non-existent work: owner gets a clean 404 (not 5xx) on settings + valid-format routes', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;

        const exSettings = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items/settings`,
            { headers: authedHeaders(token) },
        );
        expect(exSettings.status(), 'ghost export-items/settings -> 404').toBe(404);
        expect(await bodyMessage(exSettings), 'not-found names the id').toMatch(/not found/i);

        const imSettings = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/import-items/settings`,
            { headers: authedHeaders(token) },
        );
        expect(imSettings.status(), 'ghost import-items/settings -> 404').toBe(404);

        // A valid format on a ghost work -> 404 (passes the format gate, fails the lookup).
        const ghostDownload = await request.get(
            `${API_BASE}/api/works/${FAKE_WORK_ID}/export-items?format=csv`,
            { headers: authedHeaders(token) },
        );
        expect(ghostDownload.status(), 'ghost valid-format download -> 404').toBe(404);
        expect(ghostDownload.status(), 'ghost is not a 5xx').toBeLessThan(500);

        // A syntactically-invalid id is also a clean 404, not a 5xx.
        const badId = await request.get(`${API_BASE}/api/works/not-a-uuid/export-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(badId.status(), 'non-uuid id -> 404, not a 5xx').toBe(404);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 11) ANON lockout across the WHOLE item import/export family. The `request`
    //     fixture is unauthenticated (no storageState cookie), so these are
    //     genuine anonymous calls. Every route -> 401, even with shape-invalid
    //     input — auth precedes every other gate.
    // ────────────────────────────────────────────────────────────────────────
    test('anonymous lockout: every item import/export route is 401 (auth precedes all gates)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        // A real work id (so a leak would be possible if auth did not fire first).
        const { workId } = await freshUserWithWork(request);

        const anonCalls: Array<{ label: string; res: { status(): number } }> = [
            {
                label: 'export-items/settings',
                res: await request.get(`${API_BASE}/api/works/${workId}/export-items/settings`),
            },
            {
                label: 'export-items?format=csv',
                res: await request.get(`${API_BASE}/api/works/${workId}/export-items?format=csv`),
            },
            {
                label: 'export-items (no format)',
                res: await request.get(`${API_BASE}/api/works/${workId}/export-items`),
            },
            {
                label: 'import-items/settings',
                res: await request.get(`${API_BASE}/api/works/${workId}/import-items/settings`),
            },
            {
                label: 'import-items/sample?format=csv',
                res: await request.get(
                    `${API_BASE}/api/works/${workId}/import-items/sample?format=csv`,
                ),
            },
            {
                label: 'import-items/validate (no file)',
                res: await request.post(`${API_BASE}/api/works/${workId}/import-items/validate`, {
                    data: {},
                }),
            },
            {
                label: 'import-items (rows)',
                res: await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
                    data: { rows: [{ name: 'x' }] },
                }),
            },
        ];

        for (const { label, res } of anonCalls) {
            expect(res.status(), `anonymous ${label} -> 401`).toBe(401);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // 12) settings are READ-ONLY & STABLE: re-reading export/import settings is
    //     idempotent (same envelope), and a fresh SECOND work for the same owner
    //     reports the same disabled posture — proving the settings are derived
    //     from the work's (absent) data-repo config, not per-call randomness.
    // ────────────────────────────────────────────────────────────────────────
    test('settings are read-only and stable across re-reads and across a second work', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, suffix } = await freshUserWithWork(request);

        const read = async (id: string) => {
            const ex = await request.get(`${API_BASE}/api/works/${id}/export-items/settings`, {
                headers: authedHeaders(token),
            });
            const im = await request.get(`${API_BASE}/api/works/${id}/import-items/settings`, {
                headers: authedHeaders(token),
            });
            expect(ex.status(), 'export settings 200').toBe(200);
            expect(im.status(), 'import settings 200').toBe(200);
            return {
                exportEnabled: (await ex.json()).export_enabled,
                importEnabled: (await im.json()).import_enabled,
                maxRows: (await im.json()).import_max_rows,
            };
        };

        const first = await read(workId);
        const second = await read(workId);
        expect(second, 're-reading settings is idempotent').toEqual(first);

        // A second work for the same owner reports the same disabled posture.
        const importRes = await request.post(`${API_BASE}/api/works/import`, {
            headers: authedHeaders(token),
            data: {
                sourceUrl: `https://github.com/second-owner-${suffix}/second-repo-${suffix}`,
                sourceType: 'data_repo',
                name: `Items IE Second ${suffix}`,
                gitProvider: 'github',
            },
        });
        expect(importRes.status(), 'second import -> 202').toBe(202);
        const secondWorkId = (await importRes.json()).workId as string;
        expect(secondWorkId, 'second work id').toBeTruthy();
        expect(secondWorkId, 'second work is distinct').not.toBe(workId);

        const secondWork = await read(secondWorkId);
        expect(secondWork.exportEnabled, 'second work export also OFF').toBe(false);
        expect(secondWork.importEnabled, 'second work import also OFF').toBe(false);
        expect(typeof secondWork.maxRows, 'second work also exposes a numeric cap').toBe('number');
    });

    // ────────────────────────────────────────────────────────────────────────
    // 13) export-items/settings does NOT enable export as a side-effect, and the
    //     download stays gated: read settings (OFF), attempt the download (404
    //     not-enabled), re-read settings (STILL OFF). A read of settings is pure;
    //     it never flips the feature flag.
    // ────────────────────────────────────────────────────────────────────────
    test('reading export settings never enables export; the download stays gated', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        const before = await request.get(`${API_BASE}/api/works/${workId}/export-items/settings`, {
            headers: authedHeaders(token),
        });
        expect((await before.json()).export_enabled, 'export OFF before').toBe(false);

        const download = await request.get(
            `${API_BASE}/api/works/${workId}/export-items?format=csv`,
            { headers: authedHeaders(token) },
        );
        expect(download.status(), 'download still 404 not-enabled').toBe(404);

        const after = await request.get(`${API_BASE}/api/works/${workId}/export-items/settings`, {
            headers: authedHeaders(token),
        });
        expect(
            (await after.json()).export_enabled,
            'export STILL OFF after a download attempt',
        ).toBe(false);
    });

    // ────────────────────────────────────────────────────────────────────────
    // 14) import-items body-gate gradient: distinct malformed bodies all bottom
    //     out at the body-shape 400 for the OWNER (the validation gradient ->
    //     400), and only a structurally-valid `rows` array advances to the
    //     enablement gate (404). The body gate rejects garbage BEFORE the
    //     git-gated write is ever attempted.
    // ────────────────────────────────────────────────────────────────────────
    test('import-items body gradient: malformed bodies -> 400, only a valid rows array reaches the 404 gate', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshUserWithWork(request);

        // (a) empty object — no rows key.
        const empty = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(empty.status(), 'empty body -> 400').toBe(400);
        expect(await bodyMessage(empty), 'rows-required message').toMatch(
            /must include a .?rows.? array/i,
        );

        // (b) rows present but NOT an array (a string) — still a body-shape 400.
        const notArray = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: { rows: 'not-an-array' },
        });
        expect(notArray.status(), 'rows:string -> 400 (must be an array)').toBe(400);
        expect(notArray.status(), 'malformed body never 5xx').toBeLessThan(500);

        // (c) a structurally-VALID rows array advances past the body gate to the
        // enablement gate -> 404 not-enabled (the only thing stopping the write).
        const valid = await request.post(`${API_BASE}/api/works/${workId}/import-items`, {
            headers: authedHeaders(token),
            data: {
                rows: [
                    { name: 'A', description: 'a' },
                    { name: 'B', description: 'b' },
                ],
            },
        });
        expect(valid.status(), 'valid rows array -> 404 not-enabled (past the body gate)').toBe(
            404,
        );
        expect(await bodyMessage(valid), 'not-enabled, not a body error').toMatch(/not enabled/i);
    });
});
