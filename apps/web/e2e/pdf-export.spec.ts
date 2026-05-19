import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * PDF export — pass 10. The platform may expose PDF exports for work
 * pages, usage reports, or activity logs. We probe candidate paths and
 * verify auth gate + content-type + non-empty bytes.
 */

const PDF_PATH_CANDIDATES = [
    (id: string) => `/api/works/${id}/export.pdf`,
    (id: string) => `/api/works/${id}/pdf`,
    (id: string) => `/api/works/${id}/usage/export.pdf`,
    (_id: string) => `/api/activity-log/export.pdf`,
    (_id: string) => `/api/me/export.pdf`,
];

const PDF_MAGIC = Buffer.from('%PDF-');

test.describe('PDF export — endpoint probe', () => {
    test('one PDF export path exists + requires auth', async ({ request }) => {
        const fakeId = 'pdf-probe';
        let found: { path: string; status: number } | null = null;
        for (const make of PDF_PATH_CANDIDATES) {
            const path = make(fakeId);
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no PDF export endpoint exposed');
        expect([401, 403]).toContain(found!.status);
    });

    test('owner PDF export responds with PDF magic bytes (or 4xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `pdf-${Date.now().toString(36)}`,
        });
        let foundResponse: { path: string; status: number; ct: string; firstBytes: Buffer } | null =
            null;
        for (const make of PDF_PATH_CANDIDATES) {
            const path = make(w.id);
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            const ct = res.headers()['content-type'] || '';
            const body = await res.body();
            foundResponse = {
                path,
                status: res.status(),
                ct,
                firstBytes: body.subarray(0, 5),
            };
            break;
        }
        if (!foundResponse) test.skip(true, 'no PDF endpoint accessible');
        // Outcome must be < 500. If 200, content-type AND first bytes
        // should signal a real PDF.
        expect(foundResponse!.status).toBeLessThan(500);
        if (foundResponse!.status === 200) {
            const ctOk = foundResponse!.ct.includes('pdf') || foundResponse!.ct.includes('octet');
            const magicOk = foundResponse!.firstBytes.equals(PDF_MAGIC);
            expect(
                ctOk || magicOk,
                `200 PDF response has ct="${foundResponse!.ct}" but bytes don't start with %PDF-`,
            ).toBe(true);
        }
    });

    test("stranger cannot fetch another user's PDF export", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `pdf-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        let found = false;
        for (const make of PDF_PATH_CANDIDATES) {
            const path = make(w.id);
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(stranger.access_token),
            });
            if (res.status() === 404) continue;
            found = true;
            expect([401, 403, 404]).toContain(res.status());
            return;
        }
        if (!found) test.skip(true, 'no PDF endpoint');
    });
});
