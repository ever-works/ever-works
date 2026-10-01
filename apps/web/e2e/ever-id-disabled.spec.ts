import { expect, test } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { EVER_ID_FAKE_CONTROL_URL, disableEverId } from './helpers/ever-id';

/**
 * APW-12 (Ever ID) — while Ever ID is OFF (the default), nothing changes and nothing
 * dials out (spec S18, FR-5; ACC-12-01, ACC-12-04).
 *
 * The lane's API IS configured against the fixture provider — exactly the posture of
 * an installation that carries the settings but was never turned on — and yet:
 *  - no "Sign in with Ever ID" / "Sign up with Ever ID" text is rendered;
 *  - every sign-in route answers 404 `ever_id_disabled`;
 *  - no page load reaches an identity provider host, and the fixture provider records
 *    no request at all while these pages load.
 */
const PROVIDER_HOST = /^auth(-[a-z]+)?\.ever\.co$/;

// Signed out: the sign-in and registration pages send a signed-in visitor away.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Ever ID turned off', () => {
    test.beforeAll(async ({ request }) => {
        // Belt and braces: a suite that failed half-way must not leave it on.
        await disableEverId(request);
    });

    test('renders no Ever ID button and requests nothing from a provider on the sign-in pages', async ({
        page,
        request,
    }) => {
        const callsBefore = EVER_ID_FAKE_CONTROL_URL
            ? (
                  (await (
                      await request.get(`${EVER_ID_FAKE_CONTROL_URL}/_control/calls`)
                  ).json()) as { calls: unknown[] }
              ).calls.length
            : 0;
        const hosts = new Set<string>();
        page.on('request', (req) => {
            try {
                hosts.add(new URL(req.url()).hostname);
            } catch {
                // ignore non-URL requests
            }
        });

        for (const path of ['/login', '/register']) {
            await page.goto(path);
            await expect(page.locator('body')).toBeVisible();
            await expect(page.getByText(/Sign (in|up) with Ever ID/i)).toHaveCount(0);
        }

        expect([...hosts].filter((host) => PROVIDER_HOST.test(host))).toEqual([]);
        if (EVER_ID_FAKE_CONTROL_URL) {
            const callsAfter = (
                (await (
                    await request.get(`${EVER_ID_FAKE_CONTROL_URL}/_control/calls`)
                ).json()) as { calls: unknown[] }
            ).calls.length;
            expect(callsAfter).toBe(callsBefore);
        }
    });

    test('answers 404 ever_id_disabled on the sign-in routes and reports everId.enabled = false', async ({
        request,
    }) => {
        const providers = await request.get(`${API_BASE}/api/auth/providers`);
        expect(providers.status()).toBe(200);
        const body = await providers.json();
        expect(body.everId).toEqual({ enabled: false, displayName: 'Ever ID' });
        // Every pre-existing field is still there (ACC-12-05).
        expect(body).toHaveProperty('emailPassword', true);
        expect(Array.isArray(body.socialProviders)).toBe(true);

        // An empty body gets the same answer: nothing is validated while Ever ID is off.
        for (const [method, path] of [
            ['post', '/api/auth/ever-id/authorize'],
            ['post', '/api/auth/ever-id/callback'],
            ['post', '/api/auth/ever-id/sign-up/confirm'],
            ['get', '/api/auth/ever-id/client-config'],
            ['post', '/api/auth/ever-id/session'],
        ] as const) {
            const response =
                method === 'get'
                    ? await request.get(`${API_BASE}${path}`)
                    : await request.post(`${API_BASE}${path}`, { data: {} });
            expect(response.status()).toBe(404);
            expect((await response.json()).code).toBe('ever_id_disabled');
        }
    });
});
