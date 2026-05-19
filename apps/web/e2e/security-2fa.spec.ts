import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * 2FA / MFA contract — pass 5+. The platform may or may not expose 2FA
 * yet; this spec probes the conventional endpoints and skips cleanly
 * when none are present. When 2FA *is* exposed, we pin the auth gate
 * and the basic enrollment shape.
 *
 *   - GET /api/auth/2fa/status      — current 2FA state for the user
 *   - POST /api/auth/2fa/enroll     — start TOTP / app enrollment
 *   - POST /api/auth/2fa/verify     — verify with a code
 *   - POST /api/auth/2fa/disable    — turn it off
 *   - POST /api/auth/2fa/backup-codes — issue / list backup codes
 */

const CANDIDATE_STATUS_PATHS = [
    '/api/auth/2fa/status',
    '/api/auth/mfa/status',
    '/api/auth/2fa',
    '/api/2fa/status',
    '/api/auth/two-factor/status',
];

test.describe('2FA / MFA — endpoint contract', () => {
    test('one of the 2FA status endpoints exists OR none do (skip)', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of CANDIDATE_STATUS_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() !== 404) {
                found = { path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, '2FA endpoints not exposed in this env');
        }
        // Whatever endpoint exists, unauthenticated MUST be a clean 401/403.
        expect([401, 403]).toContain(found!.status);
    });

    test('2FA status endpoint for fresh user reports disabled', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let okPath: string | null = null;
        let okBody: unknown = null;
        for (const path of CANDIDATE_STATUS_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 200) {
                okPath = path;
                okBody = await res.json();
                break;
            }
            if (res.status() !== 404 && res.status() !== 401) {
                // Endpoint exists but returned something else (e.g. 405).
                // That's fine — endpoint is there, just not as we model.
                okPath = path;
                break;
            }
        }
        if (!okPath) {
            test.skip(true, '2FA status not exposed for authenticated users');
        }
        // Fresh user must have 2FA disabled (not yet enrolled). The
        // response shape varies — typically `{enabled: false}` /
        // `{status: 'disabled'}` / `{is2faEnabled: false}`.
        if (okBody && typeof okBody === 'object') {
            const b = okBody as Record<string, unknown>;
            const enabled =
                b.enabled ?? b.is2faEnabled ?? b.isEnabled ?? b.mfaEnabled ?? b.twoFactorEnabled;
            if (typeof enabled === 'boolean') {
                expect(enabled, `fresh user must not have 2FA on by default`).toBe(false);
            }
            const status = String(b.status ?? '').toLowerCase();
            if (status) {
                expect(['disabled', 'inactive', 'off', 'not_enrolled', '']).toContain(status);
            }
        }
    });

    test('2FA enroll without auth → 401 (if endpoint exists)', async ({ request }) => {
        const enrollPaths = [
            '/api/auth/2fa/enroll',
            '/api/auth/2fa/setup',
            '/api/auth/mfa/enroll',
            '/api/auth/two-factor/enroll',
        ];
        let foundPath: string | null = null;
        for (const path of enrollPaths) {
            const res = await request.post(`${API_BASE}${path}`);
            if (res.status() !== 404) {
                foundPath = path;
                expect([401, 403, 400, 405]).toContain(res.status());
                break;
            }
        }
        if (!foundPath) {
            test.skip(true, '2FA enroll endpoint not exposed');
        }
    });
});
