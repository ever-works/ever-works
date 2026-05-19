import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Download resume / Range — pass 20. Large file downloads should
 * honour `Range: bytes=` requests so clients can resume interrupted
 * downloads. We probe with `Range: bytes=0-99` and check for either:
 *  - 206 Partial Content + Content-Range header (Range honoured)
 *  - 200 OK with the full body (Range ignored — informational)
 *  - 4xx (the endpoint refuses partial requests, also acceptable)
 *
 * NEVER 5xx on a Range header.
 */

const DOWNLOAD_PATHS = [
    '/api/account/export',
    '/api/activity-log/export',
    '/api/account/usage/export',
];

test.describe('Downloads — Range requests handled without 5xx', () => {
    test('Range: bytes=0-99 on download endpoints returns 206 / 200 / 4xx — never 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const p of DOWNLOAD_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: {
                    ...authedHeaders(u.access_token),
                    Range: 'bytes=0-99',
                },
            });
            if (res.status() === 404) continue;
            probed = true;
            expect(res.status(), `${p}: Range request crashed: ${res.status()}`).toBeLessThan(500);
            // If 206, must carry Content-Range header.
            if (res.status() === 206) {
                const cr = res.headers()['content-range'];
                expect(cr, `${p}: 206 Partial Content missing Content-Range`).toBeTruthy();
                expect(cr).toMatch(/bytes \d+-\d+\/(\d+|\*)/);
            }
        }
        if (!probed) test.skip(true, 'no download endpoint exposed');
    });

    test('malformed Range header still stays < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const malformedRanges = [
            'bytes=abc-def',
            'bytes=-100', // suffix range — actually valid but unusual
            'bytes=100-50', // inverted
            'badformat',
        ];
        for (const range of malformedRanges) {
            const res = await request.get(`${API_BASE}/api/account/export`, {
                headers: {
                    ...authedHeaders(u.access_token),
                    Range: range,
                },
            });
            if (res.status() === 404) continue;
            // 416 Range Not Satisfiable is the canonical rejection.
            // 4xx generally OK. 5xx is the bug.
            expect(res.status(), `Range="${range}" crashed: ${res.status()}`).toBeLessThan(500);
        }
    });
});
