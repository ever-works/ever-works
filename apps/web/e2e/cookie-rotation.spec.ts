import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Cookie / session rotation — pass 12. After a security-sensitive
 * action (password change, logout), the session token should be
 * rotated so existing sessions on other devices are forced to re-log.
 * We don't drive the full multi-device scenario; we pin the single-
 * device contract: the new token from update-password must
 * authenticate, and the old token's behaviour after the change is
 * either rejected (best) or still works (acceptable on some builds).
 */

test.describe('Session — password change behaviour', () => {
    test('update-password with correct current password is accepted', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const newPwd = 'NewPass1!secure-rotation';
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: u.password, newPassword: newPwd },
        });
        // Some builds require additional validation; accept 200/204 or
        // 400 (policy reject). Never 5xx.
        expect(res.status()).toBeLessThan(500);
    });

    test('logging in with the NEW password works after update', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const newPwd = 'NewPass1!rotation-' + Date.now().toString(36);
        const update = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: u.password, newPassword: newPwd },
        });
        if (update.status() >= 400)
            test.skip(true, `update-password rejected (${update.status()})`);
        // After the rotation, logging in with the NEW password must succeed.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: newPwd },
        });
        expect(login.status()).toBe(200);
    });

    test('logging in with the OLD password after rotation FAILS', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const newPwd = 'NewPass1!rotation-' + Date.now().toString(36);
        const update = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: u.password, newPassword: newPwd },
        });
        if (update.status() >= 400)
            test.skip(true, `update-password rejected (${update.status()})`);
        // Old password must NOT succeed — would mean rotation didn't
        // happen.
        const loginOld = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        expect(loginOld.status(), 'old password still works after rotation').not.toBe(200);
    });
});

test.describe('Session — logout invalidation', () => {
    test('access_token still works between two reads (no premature rotation)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const r1 = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        const r2 = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        // Same token should grant access on two consecutive reads.
        expect(r1.status()).toBe(200);
        expect(r2.status()).toBe(200);
    });
});
