import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Content-negotiation tolerance on public JSON endpoints. The server
 * should never 5xx on unusual Accept headers — it should either honour
 * the requested type, fall back to its default, or return 406.
 */

const PUBLIC_JSON_PATHS = ['/api/health', '/api/version', '/api/info'];

const UNUSUAL_ACCEPTS = [
    'application/xml',
    'text/html',
    'text/plain',
    '*/*',
    'application/json, text/plain; q=0.9',
    'image/png',
    'application/octet-stream',
];

test.describe('Public API: Accept-header negotiation', () => {
    for (const path of PUBLIC_JSON_PATHS) {
        for (const accept of UNUSUAL_ACCEPTS) {
            test(`GET ${path} with Accept: ${accept}`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}`, {
                    headers: { Accept: accept },
                });
                expect(res.status(), `${path} accept=${accept}`).toBeLessThan(500);
            });
        }
    }
});
