import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Trailing-slash handling on API routes. The platform should pick
 * one canonical form and stick to it — but neither variant should
 * 5xx. Acceptable outcomes:
 *  - same 2xx response on both forms
 *  - one form returns 3xx redirect to the other
 *  - both return 404 (route not registered with trailing slash)
 *  - the trailing-slash form returns 4xx, never 5xx.
 */

const PATHS = ['/api/health', '/api/version', '/api/info', '/api/works', '/.well-known/agent.json'];

test.describe('API: trailing-slash tolerance', () => {
    for (const path of PATHS) {
        test(`GET ${path}/ does not 5xx (vs canonical ${path})`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}/`, { maxRedirects: 0 });
            expect(res.status(), `${path}/ status`).toBeLessThan(500);
        });
    }

    for (const path of PATHS) {
        test(`GET ${path} (canonical, no trailing slash) returns 2xx or known status`, async ({
            request,
        }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} canonical`).toBeLessThan(500);
        });
    }
});
