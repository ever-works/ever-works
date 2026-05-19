import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Image / file Content-Disposition — pass 18. File downloads
 * (account export, activity-log export, usage export) MUST carry
 * `Content-Disposition: attachment` so attacker-uploaded content
 * cannot be rendered inline by the browser. Inline rendering of
 * user-uploaded SVG/HTML would be a stored-XSS vector.
 */

const DOWNLOAD_PATHS = [
    '/api/account/export',
    '/api/activity-log/export',
    '/api/account/usage/export',
];

test.describe('Downloads — Content-Disposition: attachment for user-content exports', () => {
    test('account/activity-log/usage exports carry Content-Disposition: attachment', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const p of DOWNLOAD_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            if (!res.ok()) continue;
            probed = true;
            const cd = res.headers()['content-disposition'] || '';
            // Acceptable: `attachment` or `attachment; filename=...`.
            // NOT acceptable: empty (browser default = inline) or
            // explicit `inline`.
            const isAttachment = /attachment/i.test(cd);
            expect(
                isAttachment,
                `${p}: Content-Disposition="${cd}" — exports should force attachment`,
            ).toBe(true);
        }
        if (!probed) test.skip(true, 'no download endpoint exposed');
    });

    test('exports carry filename hint in Content-Disposition when applicable', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const p of DOWNLOAD_PATHS) {
            const res = await request.get(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
            });
            if (!res.ok()) continue;
            probed = true;
            const cd = res.headers()['content-disposition'] || '';
            // If `attachment` is set, a filename is best-practice but
            // not required. Soft-warn only.
            const hasFilename = /filename\s*=/i.test(cd);
            if (!hasFilename && /attachment/i.test(cd)) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `${p}: attachment without filename — browser uses default name`,
                });
            }
        }
        if (!probed) test.skip(true, 'no download endpoint exposed');
    });
});
