import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';

/**
 * Account merge conflict — pass 19. When User A registers
 * `bob@example.com` and User B later tries to register the same
 * email, the API must return 409 / 422 / 400 — never a silent
 * second account, never a 5xx, never overwriting A's account.
 */

test.describe('Account merge — duplicate email registration is rejected', () => {
    test('registering with an already-taken email returns 4xx', async ({ request }) => {
        const first = await registerUserViaAPI(request);
        const second = makeTestUser('dup');
        const res = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: second.name, email: first.email, password: second.password },
        });
        expect(res.status(), `duplicate-email register: ${res.status()}`).toBeGreaterThanOrEqual(
            400,
        );
        expect(res.status()).toBeLessThan(500);
        // Common: 409 Conflict, 422 Unprocessable. Anything 4xx is fine.
    });

    test('first user can still login after duplicate-email rejection (no overwrite)', async ({
        request,
    }) => {
        const first = await registerUserViaAPI(request);
        const second = makeTestUser('dup-2');
        await request
            .post(`${API_BASE}/api/auth/register`, {
                data: {
                    username: second.name,
                    email: first.email,
                    password: second.password,
                },
            })
            .catch(() => null);
        // First user must still log in successfully.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: first.email, password: first.password },
        });
        expect(
            login.status(),
            `original user can no longer log in: ${login.status()} — duplicate-email registration may have overwritten`,
        ).toBeLessThan(400);
    });

    test('GET /api/auth/profile with original tokens still returns 200 after dup attempt', async ({
        request,
    }) => {
        const first = await registerUserViaAPI(request);
        const second = makeTestUser('dup-3');
        await request
            .post(`${API_BASE}/api/auth/register`, {
                data: {
                    username: second.name,
                    email: first.email,
                    password: second.password,
                },
            })
            .catch(() => null);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(first.access_token),
        });
        expect(
            res.status(),
            `original token invalidated by dup-email attempt: ${res.status()}`,
        ).toBeLessThan(400);
    });
});
