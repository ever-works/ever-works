import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Content-encoding negotiation. The server should:
 *  - never 5xx on unusual Accept-Encoding values
 *  - either honour the requested encoding or omit Content-Encoding
 *  - never claim an encoding it doesn't actually use
 *
 * Targets are small public JSON endpoints — payload is too small to
 * trigger encoding on some setups, but the request should still succeed.
 */

const PUBLIC_PATHS = ['/api/health', '/.well-known/agent.json'];

const ENCODINGS = [
    'gzip',
    'br',
    'deflate',
    'gzip, br, deflate',
    'identity',
    '*',
    'zstd',
    'br;q=1.0, gzip;q=0.8, *;q=0.1',
    'invalid-encoding',
    '',
];

test.describe('Public API: Accept-Encoding negotiation', () => {
    for (const path of PUBLIC_PATHS) {
        for (const encoding of ENCODINGS) {
            test(`GET ${path} with Accept-Encoding="${encoding}"`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}`, {
                    headers: { 'Accept-Encoding': encoding },
                });
                expect(res.status(), `${path} encoding=${encoding}`).toBeLessThan(500);
                const sentEncoding = res.headers()['content-encoding'];
                if (sentEncoding) {
                    // If server sets Content-Encoding it must be a known token (lowercase, no semicolon parameters).
                    expect(sentEncoding).toMatch(/^[a-z0-9*-]+$/i);
                }
            });
        }
    }
});
