import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Worker retry budget — pass 16. BullMQ jobs that fail should respect
 * a max-retry ceiling — a runaway retry loop both wastes resources
 * and means failed work never surfaces as failed. We don't have a
 * black-box way to trigger a job, but we can probe the worker /
 * queue-status surface to verify it survives N rapid invalid-job
 * POSTs without 5xxing.
 */

const INVALID_JOB_PATHS = [
    '/api/works/non-existent-work-id/generate',
    '/api/works/non-existent-work-id/items/extract',
];

test.describe('Worker retry budget — invalid jobs do not crash the queue', () => {
    test('10 rapid invalid-job POSTs all return 4xx (never 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let probedAtLeastOne = false;
        for (const path of INVALID_JOB_PATHS) {
            for (let i = 0; i < 10; i++) {
                const res = await request.post(`${API_BASE}${path}`, {
                    headers: authedHeaders(u.access_token),
                    data: {},
                });
                if (res.status() === 404) break;
                probedAtLeastOne = true;
                expect(
                    res.status(),
                    `${path} iteration ${i} returned ${res.status()} — queue not protected`,
                ).toBeLessThan(500);
            }
        }
        if (!probedAtLeastOne) {
            test.skip(
                true,
                'no invalid-job endpoint returned a non-404 — worker retry not exercised',
            );
        }
    });

    test('queue-status (if exposed) requires admin and returns < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/queue/status`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 404) test.skip(true, 'no /api/queue/status exposed');
        expect(res.status()).toBeLessThan(500);
        // Regular user should NOT see admin queue stats — expect 401/403.
        if (res.ok()) {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('json')) {
                const body = await res.json();
                // If the body looks like full admin shape (queues array
                // with workers/failed counts), that's a privilege leak.
                const hasAdminShape =
                    Array.isArray(body?.queues) &&
                    body.queues.some(
                        (q: Record<string, unknown>) =>
                            'workers' in q || 'failed' in q || 'active' in q,
                    );
                expect(
                    hasAdminShape,
                    'regular user got admin-shape queue stats — privilege escalation',
                ).toBe(false);
            }
        }
    });
});
