import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * TLS version + transport headers — pass 12. In production behind
 * HTTPS, responses should carry Strict-Transport-Security (HSTS) and
 * the Server header should not leak version info. Dev/local runs over
 * http aren't subject to this — we skip with reason.
 */

test.describe('Transport security — production HSTS posture', () => {
    test('GET /api/health over https sets Strict-Transport-Security', async ({ request }) => {
        if (!API_BASE.startsWith('https://')) {
            test.skip(true, 'API_BASE is http — HSTS only applies on https');
        }
        const res = await request.get(`${API_BASE}/api/health`);
        const hsts = res.headers()['strict-transport-security'];
        expect(hsts, 'production API missing Strict-Transport-Security').toBeTruthy();
        // HSTS max-age should be at least 6 months (15552000 seconds)
        // per OWASP. Anything below 1 month is a soft warning.
        const maxAge = /max-age\s*=\s*(\d+)/i.exec(hsts!);
        if (maxAge) {
            const seconds = parseInt(maxAge[1], 10);
            expect(
                seconds,
                `HSTS max-age=${seconds}s is below the recommended 6-month minimum`,
            ).toBeGreaterThanOrEqual(2_592_000); // 30 days as a soft floor
        }
    });

    test('Server header does not leak detailed version info', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const server = res.headers()['server'] || '';
        // The dangerous shape is `nginx/1.18.0` or `Apache/2.4.41 (Ubuntu)`
        // — version-specific identifiers that aid attackers in
        // matching CVEs to your stack. Anonymous "nginx" / "cloudflare"
        // is fine.
        const versionLeak = /\/\d+\.\d+\.\d+/.test(server);
        expect(versionLeak, `Server header leaks version: "${server}"`).toBe(false);
    });

    test('X-Powered-By is stripped (helmet defense)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const poweredBy = res.headers()['x-powered-by'];
        expect(poweredBy, `X-Powered-By leaked: "${poweredBy}"`).toBeUndefined();
    });
});

test.describe('Transport security — web tier', () => {
    test('GET /en/login carries HSTS in production', async ({ page, baseURL }) => {
        const base = baseURL || 'http://localhost:3000';
        if (!base.startsWith('https://')) {
            test.skip(true, 'baseURL is http — HSTS only applies on https');
        }
        const res = await page.request.get(`${base}/en/login`);
        const hsts = res.headers()['strict-transport-security'];
        expect(hsts, 'web tier missing HSTS').toBeTruthy();
    });
});
