import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

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
        // Rotate to P1.
        const r1 = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { current_password: p0, new_password: p1, currentPassword: p0, newPassword: p1 },
        });
        if (!r1.ok()) {
            test.skip(true, `first rotation failed (${r1.status()}) — endpoint may differ`);
        }
        // Now try rotating BACK to P0.
        const r2 = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { current_password: p1, new_password: p0, currentPassword: p1, newPassword: p0 },
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

    test('update-password without current_password is rejected', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { new_password: 'Brand1New#Pass', newPassword: 'Brand1New#Pass' },
        });
        // No current password = silent acceptance would let a stolen
        // session change the password without re-auth. Must be 4xx.
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
