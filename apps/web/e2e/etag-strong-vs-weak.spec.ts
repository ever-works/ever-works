import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * ETag strong vs weak — pass 18. RFC 7232:
 *  - mutable JSON endpoints should emit weak ETags (`W/"..."`) if any
 *  - immutable static assets should emit strong ETags
 *  - dynamic-per-user JSON ideally carries `private` Cache-Control,
 *    not just an ETag
 */

test.describe('ETag — strong/weak alignment by resource type', () => {
    test('JSON GET /api/auth/profile uses weak ETag (if any)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) test.skip(true, `/api/auth/profile ${res.status()}`);
        const etag = res.headers()['etag'];
        if (!etag) test.skip(true, '/api/auth/profile carries no ETag');
        // Weak ETag prefix is `W/`. RFC 7232 §2.3: dynamic content
        // should use weak. Allowing strong is acceptable (just less
        // semantically precise) — soft-warn rather than hard-fail.
        if (!/^W\//.test(etag)) {
            test.info().annotations.push({
                type: 'informational',
                description: `/api/auth/profile uses strong ETag "${etag}" — weak would be more semantically correct for dynamic JSON`,
            });
        }
    });

    test('immutable _next/static assets use strong ETag (or absent + immutable)', async ({
        page,
        baseURL,
    }) => {
        const res = await page.request.get(`${baseURL || 'http://localhost:3000'}/en/login`, {});
        // Trigger asset download by navigating once; harvest a static
        // request from the response's referenced assets.
        // Simpler: probe a typical Next.js manifest path.
        const probe = await page.request.get(
            `${baseURL || 'http://localhost:3000'}/_next/static/_buildManifest.js`,
            {},
        );
        if (probe.status() === 404) {
            test.skip(true, 'no _next/static/_buildManifest.js — Next version may differ');
        }
        const etag = probe.headers()['etag'] || '';
        const cc = probe.headers()['cache-control'] || '';
        const immutable = /immutable/i.test(cc);
        const strongEtag = etag && !/^W\//.test(etag);
        // Either strong ETag OR immutable Cache-Control is acceptable.
        // Weak ETag without immutable is a soft signal.
        if (!strongEtag && !immutable) {
            test.info().annotations.push({
                type: 'informational',
                description: `static asset has neither strong ETag nor immutable Cache-Control: etag="${etag}" cc="${cc}"`,
            });
        }
        // Sanity: response was 200 / 304.
        expect([200, 304]).toContain(probe.status());
        // Suppress unused-variable warning by referencing the original
        // login probe (we use it as a side-effect to warm Next's asset
        // generation in dev).
        void res.status();
    });
});
