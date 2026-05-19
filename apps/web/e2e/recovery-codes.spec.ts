import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * 2FA recovery codes — pass 10. Once 2FA is enrolled, the platform
 * should expose backup recovery codes for account recovery. We probe
 * the candidate endpoints; if 2FA isn't enrolled (or codes aren't
 * exposed) skip cleanly.
 */

const CODES_PATHS = [
    '/api/auth/2fa/recovery-codes',
    '/api/auth/2fa/backup-codes',
    '/api/auth/mfa/recovery-codes',
    '/api/auth/recovery-codes',
];

test.describe('2FA recovery codes — endpoint probe', () => {
    test('recovery-codes endpoint requires auth (or skip if not exposed)', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of CODES_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no recovery-codes endpoint exposed');
        expect([401, 403]).toContain(found!.status);
    });

    test('GET recovery-codes without 2FA enrolled responds 4xx (not silent 200)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of CODES_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            found = true;
            // Without 2FA enrolled, returning recovery codes would be
            // a leak. Expect 4xx (typically 403 / 412 Precondition Failed).
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no recovery-codes endpoint accessible');
    });

    test('POST recovery-codes (regenerate) without 2FA → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of CODES_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no POST recovery-codes endpoint');
    });
});
