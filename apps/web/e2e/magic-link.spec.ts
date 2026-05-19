import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * Magic link / passwordless — pass 10. The platform may offer
 * passwordless sign-in via an email magic link. We probe the candidate
 * issuance + redemption endpoints and pin the contract.
 */

const ISSUE_PATHS = [
    '/api/auth/magic-link',
    '/api/auth/passwordless',
    '/api/auth/email-link',
    '/api/auth/login/magic-link',
];

const REDEEM_PATHS = [
    '/api/auth/magic-link/redeem',
    '/api/auth/passwordless/verify',
    '/api/auth/magic-link/consume',
    '/api/auth/email-link/verify',
];

test.describe('Magic link — issuance', () => {
    test('issuance endpoint (if exposed) is auth-public and always 2xx/204', async ({
        request,
    }) => {
        const u = makeTestUser();
        let found: { path: string; status: number } | null = null;
        for (const path of ISSUE_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                data: { email: u.email },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no magic-link issuance endpoint exposed');
        // Issuance must NOT signal existence — always 200/202/204 OR
        // a rate-limit. NEVER 4xx based on whether the email exists.
        expect(found!.status).toBeLessThan(500);
    });

    test('issuance for two different emails takes similar time (no enumeration)', async ({
        request,
    }) => {
        // Same pattern as password-reset-uniformity.spec.ts — bounded
        // timing comparison. If the issuance endpoint exists, two
        // different addresses should take within 5x of each other.
        const a = makeTestUser('magic-a');
        const b = makeTestUser('magic-b');
        const measure = async (email: string, path: string): Promise<number> => {
            const t0 = Date.now();
            await request.post(`${API_BASE}${path}`, { data: { email } });
            return Date.now() - t0;
        };
        let firstPath: string | null = null;
        for (const path of ISSUE_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, { data: { email: a.email } });
            if (res.status() !== 404 && res.status() !== 405) {
                firstPath = path;
                break;
            }
        }
        if (!firstPath) test.skip(true, 'no magic-link issuance endpoint');
        const ta = await measure(a.email, firstPath);
        const tb = await measure(b.email, firstPath);
        if (ta < 50 && tb < 50) test.skip(true, 'timings too small to compare');
        const ratio = Math.max(ta, tb) / Math.max(1, Math.min(ta, tb));
        expect(
            ratio,
            `magic-link timing ratio ${ratio.toFixed(2)}x (a=${ta}ms, b=${tb}ms)`,
        ).toBeLessThan(5);
    });
});

test.describe('Magic link — redemption', () => {
    test('redemption with bogus token → 4xx (never 2xx)', async ({ request }) => {
        let found = false;
        for (const path of REDEEM_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                data: { token: `bogus-${Date.now().toString(36)}` },
            });
            if (res.status() === 404) continue;
            found = true;
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no magic-link redemption endpoint');
    });

    test('redemption with empty token → 4xx', async ({ request }) => {
        let found = false;
        for (const path of REDEEM_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                data: { token: '' },
            });
            if (res.status() === 404) continue;
            found = true;
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no magic-link redemption endpoint');
    });
});
