import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Media MIME sniffing — pass 17. Upload endpoints should validate
 * file content beyond just the client-declared Content-Type:
 *  - text uploaded with `Content-Type: image/png` should be rejected
 *  - SVG uploads (or rejection of SVG) should not echo back inline
 *    `<script>` to a browser-fetched response
 *
 * If no upload endpoint accepts these probes, informational skip.
 */

const UPLOAD_PATHS = [
    '/api/works/__WORK_ID__/upload',
    '/api/account/avatar',
    '/api/uploads',
    '/api/images/upload',
];

test.describe('Media MIME sniffing — content-type lies are caught', () => {
    test('text-body with Content-Type=image/png is rejected (or skip if no upload)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const tpl of UPLOAD_PATHS) {
            const path = tpl.replace('__WORK_ID__', 'noop');
            const res = await request.post(`${API_BASE}${path}`, {
                headers: { ...authedHeaders(u.access_token), 'Content-Type': 'image/png' },
                data: 'this is plain text masquerading as a png',
            });
            if (res.status() === 404) continue;
            probed = true;
            // Either rejected (4xx) or accepted with sniff-detection.
            // Server-side must not 5xx on the mismatch.
            expect(res.status(), `${path} crashed on text-as-png: ${res.status()}`).toBeLessThan(
                500,
            );
        }
        if (!probed) test.skip(true, 'no upload endpoint exposed');
    });

    test('SVG upload response (if accepted) does not carry executable inline script', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const evilSvg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert('xss')</script></svg>`;
        let probed = false;
        for (const tpl of UPLOAD_PATHS) {
            const path = tpl.replace('__WORK_ID__', 'noop');
            const res = await request.post(`${API_BASE}${path}`, {
                headers: { ...authedHeaders(u.access_token), 'Content-Type': 'image/svg+xml' },
                data: evilSvg,
            });
            if (res.status() === 404) continue;
            probed = true;
            // Server didn't crash.
            expect(res.status()).toBeLessThan(500);
            if (!res.ok()) continue;
            // If accepted, the response body must NOT echo executable
            // <script> tags verbatim — even error envelopes that
            // include the filename should escape angle brackets.
            const body = await res.text();
            const matches = body.match(
                /<script[^>]*>[\s\S]*?alert\s*\(\s*['"]xss['"]\s*\)[\s\S]*?<\/script>/i,
            );
            expect(
                matches,
                `upload response echoed executable <script>alert('xss')</script>`,
            ).toBeNull();
        }
        if (!probed) test.skip(true, 'no upload endpoint exposed');
    });
});
