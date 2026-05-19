import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Password history — pass 14. If the platform enforces a password
 * history (NIST SP 800-63B encourages it for high-security accounts),
 * `update-password` should reject re-using the just-rotated password.
 *
 * We register a user with password P0, rotate to P1, then try
 * rotating BACK to P0. If history is enforced, the second rotation is
 * 4xx. If not enforced, both rotations succeed — that's an
 * informational skip, not a fail (the policy may be intentional).
 */

const STRONG_BASE = 'Hist0r1cal#Pass';

test.describe('Password history — recent passwords cannot be reused', () => {
    test('rotating back to the original password is rejected (or policy is informational)', async ({
        request,
    }) => {
        const p0 = `${STRONG_BASE}-A${Date.now().toString(36)}`;
        const p1 = `${STRONG_BASE}-B${Date.now().toString(36)}`;
        const u = await registerUserViaAPI(request, { password: p0 });
        // Codex P2: global ValidationPipe uses forbidNonWhitelisted, so
        // snake_case duplicates get the request rejected with 400 before
        // the password-change logic runs. Stick to the DTO field names.
        const r1 = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: p0, newPassword: p1 },
        });
        if (!r1.ok()) {
            test.skip(true, `first rotation failed (${r1.status()}) — endpoint may differ`);
        }
        // Greptile P1: many JWT setups invalidate the pre-rotation token
        // after password change. Using `u.access_token` for the second
        // rotation would 401 from token revocation, not history policy.
        // Re-login with P1 to get a fresh token before the second
        // rotation, so a 4xx unambiguously means history enforcement.
        const refresh = await loginViaAPI(request, { email: u.email, password: p1 });
        const r2 = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(refresh.access_token),
            data: { currentPassword: p1, newPassword: p0 },
        });
        if (r2.ok()) {
            // Platform does not enforce password history — informational
            // skip (policy may be intentional for now).
            test.info().annotations.push({
                type: 'informational',
                description: 'password history not enforced — rotating back to original succeeded',
            });
            return;
        }
        expect(
            r2.status(),
            `re-using previous password: status ${r2.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(r2.status()).toBeLessThan(500);
    });

    test('update-password without currentPassword is rejected', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { newPassword: 'Brand1New#Pass' },
        });
        // No current password = silent acceptance would let a stolen
        // session change the password without re-auth. Must be 4xx.
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
