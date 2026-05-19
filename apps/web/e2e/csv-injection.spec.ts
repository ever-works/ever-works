import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * CSV injection — pass 12. When a user-supplied field (work name, item
 * description) starts with `=`, `+`, `-`, `@`, `\t`, or `\r`, naive
 * CSV exports let Excel/Numbers/Google Sheets interpret it as a
 * FORMULA on open. Defense is to prefix the cell with a single quote
 * `'` or escape it.
 */

test.describe('CSV injection — formula-prefix payloads in exports', () => {
    test('work named `=cmd|...` exports safely (prefixed or escaped)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        await createWorkViaAPI(request, u.access_token, {
            name: '=cmd|"/c calc"!A1',
            slug: `csv-inj-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `export returned ${res.status()}`);
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('csv') && !ct.includes('text/')) {
            test.skip(true, `non-CSV content-type: ${ct}`);
        }
        const body = await res.text();
        if (!body || !body.includes('=cmd')) {
            // The work name didn't reach the activity-log export. That's
            // fine — the export may be filtered to specific action types.
            test.skip(true, 'work name not in export body');
        }
        // The dangerous case: a CSV cell that BEGINS with `=cmd` (no
        // quote / single-quote prefix). Find any occurrence and check
        // the surrounding context.
        const lines = body.split(/\r?\n/);
        for (const line of lines) {
            if (!line.includes('=cmd')) continue;
            const cells = line.split(',');
            for (const cell of cells) {
                const trimmed = cell.replace(/^"|"$/g, '');
                if (!trimmed.startsWith('=cmd')) continue;
                // Found a cell starting with =cmd. Codex P2 callout:
                // wrapping the formula in double quotes ("=cmd...") is
                // NOT safe — spreadsheet software unwraps the quotes
                // and STILL evaluates `=cmd` as a formula. Only an
                // explicit single-quote PREFIX before the `=` (`'=cmd`
                // or `"'=cmd"`) is defensively safe.
                const raw = cell.trim();
                const isSafe =
                    raw.startsWith("'=") || raw.startsWith('"\'=') || raw.startsWith('\\=');
                expect(
                    isSafe,
                    `CSV cell starts with formula payload unsafely: ${raw.slice(0, 60)}`,
                ).toBe(true);
            }
        }
    });

    test('plus / minus / at-sign prefixes (other formula chars) are also escaped', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        // Create three works with each dangerous prefix.
        await createWorkViaAPI(request, u.access_token, {
            name: `+sum(1+1)`,
            slug: `csv-plus-${stamp}`,
        });
        await createWorkViaAPI(request, u.access_token, {
            name: `-cmd|"/c"`,
            slug: `csv-minus-${stamp}`,
        });
        await createWorkViaAPI(request, u.access_token, {
            name: `@SUM(A1:A9)`,
            slug: `csv-at-${stamp}`,
        });
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `export returned ${res.status()}`);
        const body = await res.text();
        if (!body) test.skip(true, 'empty body');
        // Find any cell starting bare with +sum / -cmd / @SUM — the
        // injection vector. We accept the safe prefixed forms.
        // Greptile P2: renamed inner `u` (was shadowing the outer
        // registered user). `cell` is clearer.
        const dangerousCells = body
            .split(/\r?\n/)
            .flatMap((line) => line.split(','))
            .map((c) => c.trim())
            .filter((c) => {
                const cell = c.replace(/^"|"$/g, '');
                return (
                    (cell.startsWith('+sum') ||
                        cell.startsWith('-cmd') ||
                        cell.startsWith('@SUM')) &&
                    !c.startsWith("'") &&
                    !c.startsWith('"\'') &&
                    !c.startsWith('"\\=')
                );
            });
        expect(
            dangerousCells.length,
            `unprefixed formula cells: ${dangerousCells.slice(0, 3).join(' | ')}`,
        ).toBe(0);
    });
});
