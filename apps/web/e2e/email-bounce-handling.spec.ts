import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * Email bounce handling — pass 20. Domains that bounce
 * (`@invalid-tld.this-tld-does-not-exist`, deliberate bounce hosts)
 * shouldn't crash the verification flow. The API should accept the
 * registration without 5xx and the `send-verification` endpoint
 * should also stay < 500.
 */

const BOUNCE_DOMAINS = [
    'bounce-test-12345.invalid', // .invalid is RFC-2606 reserved-as-bounce
    'unreachable.example.com', // .example is RFC-2606 reserved
    'no-mx-record.test', // .test is RFC-2606 reserved
];

test.describe('Email — registration with bounce-shaped domains never crashes', () => {
    for (const domain of BOUNCE_DOMAINS) {
        test(`register with @${domain} stays < 500`, async ({ request }) => {
            const u = makeTestUser('bounce');
            const email = `bounce-${Date.now().toString(36)}@${domain}`;
            const res = await request.post(`${API_BASE}/api/auth/register`, {
                data: { username: u.name, email, password: u.password },
            });
            // Acceptable: 200/201 (registered, verification later
            // bounces), 4xx (email-shape validator rejected the
            // reserved TLD). NEVER 5xx.
            expect(res.status(), `register with @${domain} crashed: ${res.status()}`).toBeLessThan(
                500,
            );
        });
    }

    test("send-verification on a bounce-domain user doesn't crash", async ({ request }) => {
        const u = makeTestUser('bounce-verify');
        const email = `bounce-verify-${Date.now().toString(36)}@bounce-test.invalid`;
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: u.name, email, password: u.password },
        });
        if (!reg.ok()) {
            test.skip(
                true,
                `register with bounce domain rejected (${reg.status()}) — can't test verify`,
            );
        }
        const send = await request.post(`${API_BASE}/api/auth/send-verification`, {
            data: { email },
        });
        // Even if the email delivery would bounce, the API must not
        // 5xx — the bounce happens async after the response.
        expect(send.status()).toBeLessThan(500);
    });
});
