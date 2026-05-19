import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * GitHub-App webhook HMAC signature validation — pass 6. The platform's
 * github-app webhook endpoint (`POST /api/github-app/webhook`) MUST
 * reject events whose `X-Hub-Signature-256` doesn't match the body. A
 * silent 200 on a forged event would let any attacker impersonate
 * GitHub.
 */

const WEBHOOK_PATHS = [
    '/api/github-app/webhook',
    '/api/integrations/github-app/webhook',
    '/api/github-app/webhooks',
];

const fakePush = JSON.stringify({
    ref: 'refs/heads/main',
    after: '0000000000000000000000000000000000000000',
    repository: { full_name: 'attacker/forged' },
});

test.describe('GitHub webhook — signature validation', () => {
    test('POST without X-Hub-Signature-256 is rejected (4xx)', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: { 'X-GitHub-Event': 'push', 'Content-Type': 'application/json' },
                data: fakePush,
            });
            if (res.status() !== 404) {
                found = { path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, 'no github-app webhook endpoint exposed in this env');
        }
        // Missing signature MUST be a 4xx (401 / 403 / 422). Never 2xx,
        // never 5xx.
        expect(found!.status).toBeGreaterThanOrEqual(400);
        expect(found!.status).toBeLessThan(500);
    });

    test('POST with a bogus X-Hub-Signature-256 is rejected (4xx)', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: {
                    'X-GitHub-Event': 'push',
                    'X-Hub-Signature-256': 'sha256=deadbeef'.padEnd(71, '0'),
                    'Content-Type': 'application/json',
                },
                data: fakePush,
            });
            if (res.status() !== 404) {
                found = { path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, 'no github-app webhook endpoint exposed');
        }
        expect(found!.status).toBeGreaterThanOrEqual(400);
        expect(found!.status).toBeLessThan(500);
    });

    test('webhook never echoes the signature back in error responses', async ({ request }) => {
        const sentinel = 'sha256=' + 'a'.repeat(64);
        for (const path of WEBHOOK_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: {
                    'X-GitHub-Event': 'push',
                    'X-Hub-Signature-256': sentinel,
                    'Content-Type': 'application/json',
                },
                data: fakePush,
            });
            if (res.status() === 404) continue;
            const text = (await res.text()).toLowerCase();
            // Signature must NOT appear in the response body — leaking it
            // would help an attacker probe the validator.
            expect(text.includes(sentinel.toLowerCase()), 'webhook echoed signature back').toBe(
                false,
            );
            return;
        }
        test.skip(true, 'no webhook endpoint exposed');
    });
});
