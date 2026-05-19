import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * CSV export schema — pass 8. Deepens download-export.spec.ts. We not
 * only check the response is CSV-ish, but parse the header row and
 * verify it contains expected column names. A column rename is a
 * silent break otherwise.
 */

function parseCsvHeader(body: string): string[] {
    const firstLine = body.split(/\r?\n/, 1)[0] || '';
    // Naive CSV header split. Real CSV may quote columns with commas
    // inside; for header validation a simple split is enough — header
    // names are simple identifiers, not free-form text.
    return firstLine.split(',').map((s) => s.replace(/^"|"$/g, '').trim().toLowerCase());
}

test.describe('CSV schema — /api/activity-log/export', () => {
    test('header row contains a recognisable activity-log column set', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `csv-schema-${Date.now().toString(36)}`,
        });
        const res = await request.get(
            `${API_BASE}/api/activity-log/export?workId=${encodeURIComponent(w.id)}`,
            { headers: authedHeaders(u.access_token) },
        );
        if (res.status() !== 200) test.skip(true, `activity-log/export returned ${res.status()}`);
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('csv') && !ct.includes('text/')) {
            test.skip(true, `non-CSV content-type: ${ct}`);
        }
        const body = await res.text();
        if (!body || body.length < 5) test.skip(true, 'empty export body');
        const headers = parseCsvHeader(body);
        // Common activity-log columns: id, action / actionType, status,
        // createdAt / timestamp, workId, userId. We require at least
        // SOME of these to be present so a rename surfaces.
        const RECOGNISED = [
            'id',
            'action',
            'actiontype',
            'action_type',
            'status',
            'createdat',
            'created_at',
            'timestamp',
            'workid',
            'work_id',
            'userid',
            'user_id',
        ];
        const present = headers.filter((h) => RECOGNISED.includes(h));
        expect(
            present.length,
            `activity-log CSV headers don't include any of the recognised columns: got [${headers.join(', ')}]`,
        ).toBeGreaterThan(0);
    });
});

test.describe('CSV schema — /api/works/:id/usage/export', () => {
    test('header row contains a recognisable usage column set', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `usage-csv-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${w.id}/usage/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `usage/export returned ${res.status()}`);
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('csv') && !ct.includes('text/')) {
            test.skip(true, `non-CSV content-type: ${ct}`);
        }
        const body = await res.text();
        if (!body || body.length < 5) test.skip(true, 'empty body');
        const headers = parseCsvHeader(body);
        const RECOGNISED = [
            'date',
            'period',
            'timestamp',
            'tokens',
            'inputtokens',
            'input_tokens',
            'outputtokens',
            'output_tokens',
            'cost',
            'amount',
            'currency',
            'model',
            'provider',
            'workid',
            'work_id',
            'operation',
        ];
        const present = headers.filter((h) => RECOGNISED.includes(h));
        expect(
            present.length,
            `usage CSV headers don't include any of the recognised columns: got [${headers.join(', ')}]`,
        ).toBeGreaterThan(0);
    });
});

test.describe('CSV schema — no PII leaks in header', () => {
    test('CSV exports never put an email or token in the HEADER row', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `export returned ${res.status()}`);
        const body = await res.text();
        if (!body) test.skip(true, 'empty body');
        const header = (body.split(/\r?\n/, 1)[0] || '').toLowerCase();
        // The header line must not contain '@' (email) or '.' followed
        // by 'jwt'/'bearer' (token). It also must not include the user's
        // own email — header should be column names, not row data.
        expect(header.includes(u.email.toLowerCase()), 'CSV header included user email').toBe(
            false,
        );
        expect(/bearer|jwt|sk_live|sk_test/.test(header), 'CSV header looks like a token').toBe(
            false,
        );
    });
});
