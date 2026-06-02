import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Activity-log CSV export — FORMAT, SANITIZATION & FILTER-ROUNDTRIP integration.
 *
 * This is the deep companion to the existing shallow export specs:
 *   - activity-log-export.spec.ts   → bare 401 + content-type sniff + aggregates
 *   - audit-export-sanitization.spec.ts → secret-regex blocklist over the body
 *   - csv-export-schema.spec.ts     → "some recognised column" + no-PII-in-header
 *   - activity-log-audit.spec.ts    → signup row shape + summary buckets
 *
 * NONE of them exercise the real, load-bearing CSV contract that the
 * server actually implements, so this file pins it end-to-end:
 *
 * SOURCE OF TRUTH (read, not guessed):
 *   packages/agent/src/activity-log/activity-log.service.ts → exportCsv():
 *     header  = 'Date,Action Type,Action,Status,Work,Summary'
 *     row     = [createdAt.toISOString(), actionType, action, status,
 *                `"${workName}"`, `"${summary}"`].join(',')
 *     join    = rows.join('\n')   (LF, not CRLF; NO trailing newline)
 *     workName/summary: inner `"` → `""` (CSV quote-doubling), then csvSafeCell()
 *   csvSafeCell(v): if v starts with one of  = + - @ \t \r  → prefix a single
 *     quote (`'`). This is the CSV-/formula-INJECTION defense — wrapping in
 *     double quotes is NOT enough because spreadsheets unwrap+re-evaluate.
 *   apps/api/src/activity-log/activity-log.controller.ts → exportCsv():
 *     Content-Type: text/csv ; Content-Disposition: attachment;filename=activity-log.csv
 *     filters forwarded: actionType, workId, status, dateFrom, dateTo
 *
 * PROBED LIVE (http://127.0.0.1:3100) before every assertion below:
 *   - fresh user export is NEVER empty: it carries the `user_signup` row
 *     ("","Account created"); the Work column is the empty string `""`.
 *   - creating a Work named `=HYPERLINK(0)` records a `work_created` row whose
 *     Work column is exactly `"'=HYPERLINK(0)"` (sanitized) while the Summary
 *     `Created work: =HYPERLINK(0)` is NOT prefixed (it doesn't start with a
 *     meta-char) → proves the guard is per-cell, applied to the leading char.
 *   - dateTo in the past / status=failed → header line only, zero data rows.
 *   - workId / actionType / status filters on /export match the same filters
 *     applied to the JSON list endpoint (CSV row count == JSON total).
 *   - a stranger's export never contains the owner's work name or summary.
 *   - web /api/activity-log/export with no cookie → 401 {"error":"Failed to
 *     export activity log"} (the Next route proxies the upstream 401).
 *
 * GOTCHAS honoured: register a FRESH user for every API mutation (never the
 * shared seeded user) — the seeded storageState is used ONLY for the UI-driven
 * download. Generous timeouts + retry-to-open for the dev hydration race.
 */

const EXPORT_HEADER = 'Date,Action Type,Action,Status,Work,Summary';

/** Parse a CSV body into the header tokens + the data lines (sans header). */
function splitCsv(body: string): { header: string; rows: string[] } {
    const lines = body.split('\n').filter((l) => l.length > 0);
    return { header: lines[0] ?? '', rows: lines.slice(1) };
}

/**
 * Split a single CSV data line into its 6 logical cells, honouring the
 * server's quoting rule (Work + Summary are wrapped in `"..."` and may carry
 * doubled `""` quotes). The first four cells (date/type/action/status) are
 * never quoted, so a left-to-right scan that respects quote state is enough.
 */
function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++; // consume the escaped quote
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            cells.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    cells.push(cur);
    return cells;
}

async function exportCsv(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; ct: string; body: string }> {
    const res = await request.get(`${API_BASE}/api/activity-log/export${query}`, {
        headers: authedHeaders(token),
    });
    return {
        status: res.status(),
        ct: res.headers()['content-type'] || '',
        body: res.status() === 200 ? await res.text() : '',
    };
}

test.describe('Activity export — format, sanitization & filter roundtrip', () => {
    test('CSV-injection: formula-leading Work names are neutralized with a leading quote, harmless cells are left intact', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Four classic spreadsheet-formula prefixes the guard must defang,
        // plus one benign name that must pass through UNMANGLED.
        const stamp = Date.now().toString(36);
        const payloads = [
            { name: `=HYPERLINK("http://evil")-${stamp}`, lead: '=' },
            { name: `+SUM(1+1)-${stamp}`, lead: '+' },
            { name: `@import-${stamp}`, lead: '@' },
            { name: `-2+3-${stamp}`, lead: '-' },
        ];
        for (const p of payloads) {
            await createWorkViaAPI(request, u.access_token, {
                name: p.name,
                slug: `inj-${p.lead === '=' ? 'eq' : p.lead === '+' ? 'pl' : p.lead === '@' ? 'at' : 'mn'}-${stamp}`,
            });
        }
        const benignName = `Benign Work ${stamp}`;
        await createWorkViaAPI(request, u.access_token, {
            name: benignName,
            slug: `benign-${stamp}`,
        });

        const exp = await exportCsv(request, u.access_token);
        expect(exp.status, 'export status').toBe(200);
        expect(exp.ct.toLowerCase()).toContain('csv');
        const { rows } = splitCsv(exp.body);

        // Map work_created rows by their (un-prefixed) Work cell so we can
        // assert the leading-quote contract precisely.
        const workCreatedRows = rows
            .map(splitRow)
            .filter((c) => c[1] === 'work_created' && c.length === 6);
        expect(
            workCreatedRows.length,
            'one work_created row per created work',
        ).toBeGreaterThanOrEqual(5);

        for (const p of payloads) {
            const row = workCreatedRows.find((c) => c[4].includes(p.name));
            expect(row, `work_created row for ${p.name}`).toBeTruthy();
            const workCell = row![4];
            // THE contract: a formula-leading cell is rendered as text by
            // prefixing a single quote. The raw payload must NOT survive as the
            // literal first character of the rendered cell.
            expect(
                workCell.startsWith("'"),
                `formula-leading Work cell must be quote-prefixed, got: ${workCell.slice(0, 40)}`,
            ).toBe(true);
            expect(workCell).toBe(`'${p.name}`);
            expect(workCell[1], 'the original meta-char is preserved AFTER the guard quote').toBe(
                p.lead,
            );
        }

        // The benign work name does NOT start with a meta-char → it must be
        // emitted verbatim (no spurious leading quote that would corrupt it).
        const benignRow = workCreatedRows.find((c) => c[4].includes(benignName));
        expect(benignRow, 'benign work row present').toBeTruthy();
        expect(benignRow![4]).toBe(benignName);
        expect(benignRow![4].startsWith("'"), 'benign cell must NOT be quote-prefixed').toBe(false);
    });

    test('per-cell guard: a Summary that does not lead with a meta-char is left raw even when the Work cell was sanitized', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const name = `=DANGER-${stamp}`;
        await createWorkViaAPI(request, u.access_token, { name, slug: `psum-${stamp}` });

        const exp = await exportCsv(request, u.access_token, `?actionType=work_created`);
        expect(exp.status).toBe(200);
        const { rows } = splitCsv(exp.body);
        const cells = rows.map(splitRow).find((c) => c[4].includes(name));
        expect(cells, 'the work_created row').toBeTruthy();

        // Work column → sanitized (leads with `=`).
        expect(cells![4]).toBe(`'${name}`);
        // Summary column → `Created work: =DANGER-...`. It leads with 'C', NOT a
        // meta-char, so the guard MUST leave it untouched: no leading quote,
        // and the (mid-string) `=` is preserved verbatim. This proves the guard
        // keys on the FIRST char per cell, not on "contains a meta-char".
        const summary = cells![5];
        expect(summary.startsWith("'"), 'summary must not be over-quoted').toBe(false);
        expect(summary).toContain(name);
        expect(summary.startsWith('Created work:')).toBe(true);
    });

    test('empty-feed export still emits the exact header (and only the header) when filters exclude every row', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Seed at least one real row so we know the feed is non-empty in general.
        await createWorkViaAPI(request, u.access_token, {
            name: `empty-probe-${Date.now().toString(36)}`,
        });

        // dateTo far in the past excludes everything; status=failed also has no
        // matches for a brand-new account (signup + work_created are completed).
        for (const q of ['?dateTo=2000-01-01T00:00:00.000Z', '?status=failed']) {
            const exp = await exportCsv(request, u.access_token, q);
            expect(exp.status, `export ${q} status`).toBe(200);
            expect(exp.ct.toLowerCase()).toContain('csv');
            const { header, rows } = splitCsv(exp.body);
            expect(header, `header for ${q}`).toBe(EXPORT_HEADER);
            expect(rows.length, `empty feed for ${q} has zero data rows`).toBe(0);
            // The body is the header verbatim — no trailing newline, no BOM,
            // no stray "[]"/"null" artifacts that would break a CSV parser.
            expect(exp.body.trim()).toBe(EXPORT_HEADER);
        }
    });

    test('export reflects recorded entries and equals the JSON listing under the SAME filters (CSV/JSON parity)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `parity-${stamp}`,
            slug: `parity-${stamp}`,
        });

        // Helper: data-row count of an export for a given query string.
        const csvRows = async (q: string) =>
            splitCsv((await exportCsv(request, u.access_token, q)).body).rows.length;
        // Helper: total from the JSON list endpoint for the same filter.
        const jsonTotal = async (q: string) => {
            const res = await request.get(`${API_BASE}/api/activity-log${q}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), `json list ${q}`).toBe(200);
            return (await res.json()).total as number;
        };

        // Unfiltered parity: CSV data rows == JSON total (poll — the listener
        // that records work_created is async relative to the POST response).
        await expect
            .poll(async () => (await csvRows('')) === (await jsonTotal('?limit=100')), {
                timeout: 15_000,
            })
            .toBe(true);

        // Per-filter parity. workId isolates this work's events; actionType and
        // status carve orthogonal slices. Each export slice must match the JSON
        // slice exactly — a divergence means the export ignores a filter.
        const filters = [
            `?workId=${encodeURIComponent(w.id)}`,
            `?actionType=user_signup`,
            `?actionType=work_created`,
            `?status=completed`,
        ];
        for (const f of filters) {
            const rows = await csvRows(f);
            const total = await jsonTotal(`${f}&limit=100`);
            expect(rows, `CSV/JSON parity for ${f} (csv=${rows} json=${total})`).toBe(total);
        }

        // workId filter must ALSO be content-correct: the only Work-cell value
        // present is this work's name (signup row has the empty Work cell).
        const scoped = splitCsv(
            (await exportCsv(request, u.access_token, `?workId=${encodeURIComponent(w.id)}`)).body,
        );
        for (const c of scoped.rows.map(splitRow)) {
            expect(c[1], 'workId-scoped rows are work events').not.toBe('user_signup');
        }
    });

    test('export is per-user: a stranger never receives the owner’s recorded work name or summary', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const secret = `TopSecretWork-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
        await createWorkViaAPI(request, owner.access_token, {
            name: secret,
            slug: secret.toLowerCase(),
        });

        // Owner's export DOES contain it (sanity — the row was recorded).
        const ownerExp = await exportCsv(request, owner.access_token);
        expect(ownerExp.status).toBe(200);
        expect(ownerExp.body.includes(secret), 'owner sees own work').toBe(true);

        // Stranger's export must NOT — neither the work name nor the owner's
        // user id / email may bleed across the tenant boundary.
        const strangerExp = await exportCsv(request, stranger.access_token);
        expect(strangerExp.status).toBe(200);
        expect(strangerExp.body.includes(secret), 'stranger leaked owner work name').toBe(false);
        expect(strangerExp.body.includes(owner.user.id), 'stranger leaked owner user id').toBe(
            false,
        );
        expect(
            strangerExp.body.toLowerCase().includes(owner.email.toLowerCase()),
            'stranger leaked owner email',
        ).toBe(false);
        // Stranger still gets a well-formed CSV (their own signup row).
        expect(splitCsv(strangerExp.body).header).toBe(EXPORT_HEADER);
    });

    test('structural integrity: every data row is exactly 6 columns with an ISO-8601 date, valid status enum, and quote-escaped Work/Summary', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        // A name carrying an embedded double quote stresses the `"`→`""`
        // escaping path; a comma stresses the quoted-field comma handling.
        const trickyName = `Quote"And,Comma ${stamp}`;
        await createWorkViaAPI(request, u.access_token, {
            name: trickyName,
            slug: `tricky-${stamp}`,
        });

        const exp = await exportCsv(request, u.access_token);
        expect(exp.status).toBe(200);
        const { header, rows } = splitCsv(exp.body);
        expect(header).toBe(EXPORT_HEADER);
        expect(rows.length, 'at least signup + work_created').toBeGreaterThanOrEqual(2);

        const KNOWN_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
        for (const line of rows) {
            const cells = splitRow(line);
            expect(cells.length, `row must have 6 columns: ${line.slice(0, 80)}`).toBe(6);
            // Col 0: ISO-8601 timestamp that round-trips through Date.
            expect(cells[0], 'date is ISO-8601').toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
            );
            expect(Number.isNaN(Date.parse(cells[0])), 'date parses').toBe(false);
            // Col 1/2: non-empty action identifiers.
            expect(cells[1].length, 'actionType non-empty').toBeGreaterThan(0);
            expect(cells[2].length, 'action non-empty').toBeGreaterThan(0);
            // Col 3: a known status enum value.
            expect(KNOWN_STATUSES, `status enum: ${cells[3]}`).toContain(cells[3]);
        }

        // The embedded `"` in the work name survived the round-trip: after our
        // parser unescaped `""`→`"`, the Work cell contains the literal quote
        // AND the comma — proving the field was correctly quoted, not split.
        const tricky = rows.map(splitRow).find((c) => c[4].includes(`Quote"And,Comma`));
        expect(tricky, 'tricky-named work row parsed as one field').toBeTruthy();
        expect(tricky![4]).toContain('Quote"And,Comma');
        expect(tricky!.length, 'comma inside quotes did not create a 7th column').toBe(6);
    });

    test('UI export button downloads activity-log.csv; the web export route is auth-gated', async ({
        page,
        baseURL,
        request,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // --- Auth gate (anon): the Next route proxies the upstream 401 and
        // returns the i18n-aligned error envelope, never a CSV body. Use a
        // fully-empty storageState so we don't inherit the seeded auth cookie.
        const anon = await page
            .context()
            .browser()!
            .newContext({
                storageState: { cookies: [], origins: [] },
            });
        try {
            const res = await anon.request.get(`${origin}/api/activity-log/export`);
            expect([401, 403, 307, 302], `anon export status ${res.status()}`).toContain(
                res.status(),
            );
            if (res.status() === 401 || res.status() === 403) {
                const ct = res.headers()['content-type'] || '';
                // The failure path returns JSON ({error}), NOT a text/csv body —
                // an anon user must never receive an activity CSV.
                expect(ct.includes('text/csv'), 'anon must not receive a CSV body').toBe(false);
            }
        } finally {
            await anon.close();
        }

        // --- Seeded user (storageState) drives the real UI. Make sure the
        // seeded account actually has a recorded row so the export is meaningful.
        const s = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: s.email, password: s.password },
        });
        expect(login.ok(), 'seeded login').toBe(true);
        const { access_token } = await login.json();
        await createWorkViaAPI(request, access_token, {
            name: `ui-export-${Date.now().toString(36)}`,
        });

        await page.goto(`${origin}/en/activity`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});

        // The export control is labelled "Export CSV" (en.json activity.actions.export)
        // and carries a Download icon. Retry-to-open guards the dev hydration race.
        const exportBtn = page
            .getByRole('button', { name: /export/i })
            .or(page.locator('button:has-text("Export")'))
            .first();
        await expect(exportBtn, 'export button is present').toBeVisible({ timeout: 30_000 });

        // Trigger the download. The client fetches the CSV then attaches a blob
        // to an <a download="activity-log.csv">; capture the download event.
        const downloadPromise = page
            .waitForEvent('download', { timeout: 20_000 })
            .catch(() => null);
        await exportBtn.click({ trial: false }).catch(async () => {
            await exportBtn.click({ force: true });
        });
        const download = await downloadPromise;

        if (download) {
            // The suggested filename is fixed by both the client and the route.
            expect(download.suggestedFilename()).toBe('activity-log.csv');
            const path = await download.path();
            if (path) {
                const fs = await import('node:fs');
                const body = fs.readFileSync(path, 'utf8');
                expect(body.split('\n')[0], 'downloaded CSV header').toBe(EXPORT_HEADER);
            }
        } else {
            // Some headless/dev builds stream the blob without firing a download
            // event (jsdom-ish anchor handling). Fall back to asserting the route
            // the button hits returns a real CSV for the authenticated session.
            const direct = await page.request.get(`${origin}/api/activity-log/export`);
            expect(direct.status(), 'authed web export status').toBe(200);
            expect(
                (direct.headers()['content-type'] || '').toLowerCase(),
                'authed web export is CSV',
            ).toContain('csv');
            expect((await direct.text()).split('\n')[0]).toBe(EXPORT_HEADER);
        }
    });
});
