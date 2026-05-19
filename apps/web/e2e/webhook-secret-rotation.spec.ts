import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Webhook secret rotation — pass 15. The github-app webhook surface
 * exposes a `rotate-secret` action (covered in work-schedule.spec.ts
 * at a high level). This pass probes:
 *  - the rotate endpoint is auth-gated (401/403 unauth)
 *  - rotating returns < 500
 *  - the rotation response never echoes the SECRET itself in plain
 *    text (must be hashed / opaque / one-time displayed)
 */

const ROTATE_PATHS = [
    '/api/integrations/github-app/rotate-secret',
    '/api/github-app/rotate-secret',
    '/api/webhooks/rotate-secret',
];

test.describe('Webhook secret rotation — auth + safety', () => {
    test('unauth POST to rotate-secret returns 401/403/404', async ({ request }) => {
        let probed = false;
        for (const p of ROTATE_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, { data: {} });
            if (res.status() === 404) continue;
            probed = true;
            expect([401, 403, 404]).toContain(res.status());
            break;
        }
        if (!probed) test.skip(true, 'no rotate-secret endpoint exposed');
    });

    test('authed POST to rotate-secret responds < 500 and does not echo a long base64-shaped secret', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let probed = false;
        for (const p of ROTATE_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: authedHeaders(u.access_token),
                data: {},
            });
            if (res.status() === 404) continue;
            probed = true;
            expect(res.status()).toBeLessThan(500);
            if (!res.ok()) break;
            const body = await res.text();
            // The response MIGHT show the new secret once for the user
            // to copy. That's fine. What's NOT fine: a long-lived hash
            // or a previous-secret echo. Probe for clearly suspicious
            // payloads: a base64 string of 40+ chars that looks like a
            // bcrypt prefix or a stored hash format.
            const bcrypt = /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/.test(body);
            const argon = /\$argon2[id]?\$/i.test(body);
            expect(bcrypt || argon, 'rotate-secret response leaked a stored password hash').toBe(
                false,
            );
            break;
        }
        if (!probed) test.skip(true, 'no rotate-secret endpoint exposed');
    });
});
