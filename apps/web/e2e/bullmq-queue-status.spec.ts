import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * BullMQ queue status — pass 9 (revisited 2026-05-20).
 *
 * Status: the platform does NOT ship BullMQ — background work is
 * managed by Trigger.dev (`packages/tasks/`). Grep confirms no
 * package.json declares `bullmq` or `@nestjs/bullmq` as a dependency.
 * Trigger.dev exposes its own dashboard and does not surface a
 * generic `/api/queues` endpoint, so all probes below correctly miss
 * and the spec skips. Keeping the file in place as a contract: if
 * someone wires up BullMQ in the future, these tests will start
 * exercising the real auth gate without further work.
 *
 * If a queue-status / job-state endpoint is exposed (admin dashboard
 * / health probe), pin its auth gate + shape.
 */

const QUEUE_PATHS = [
    '/api/queues',
    '/api/admin/queues',
    '/api/bullmq/status',
    '/api/health/queues',
    '/api/internal/queues',
];

test.describe('BullMQ — queue status endpoint', () => {
    test('queue status (if exposed) requires admin auth', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of QUEUE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no queue status endpoint exposed');
        // 401/403 (unauth/forbidden) acceptable; 200 from unauth would
        // be a leak (queue names can fingerprint internal architecture).
        expect(found!.status).toBeLessThan(500);
        expect([200].includes(found!.status), 'unauth got 200 on queue status').toBe(false);
    });

    test('authed regular user does not get queue admin data (or skip if not exposed)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of QUEUE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            found = true;
            // Regular user should get 403, NOT 200 — queue status is an
            // admin surface. If platform exposes it to regular users,
            // that's a finding worth surfacing.
            if (res.status() === 200) {
                const body = await res.json().catch(() => null);
                // If the response is empty / scoped to the user's own
                // jobs, 200 is fine. If it lists queue NAMES (which
                // reveal internal architecture), that's a leak.
                const flat = JSON.stringify(body || {}).toLowerCase();
                const looksAdminish =
                    flat.includes('waiting') ||
                    flat.includes('active') ||
                    flat.includes('failed') ||
                    flat.includes('queue');
                expect(
                    looksAdminish,
                    `200 OK from regular user includes admin-shape queue data`,
                ).toBe(false);
            } else {
                expect([401, 403]).toContain(res.status());
            }
            return;
        }
        if (!found) test.skip(true, 'no queue status endpoint exposed');
    });
});

test.describe('BullMQ — health probe', () => {
    test('/api/health includes a queue / Redis check (or treat as missing)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        // We don't require the queue check to be wired; we just verify
        // that if it IS there, it reports a sane status (up/healthy).
        const flat = JSON.stringify(body).toLowerCase();
        if (/redis|bullmq|queue/.test(flat)) {
            const queueDown = /redis.{0,40}down|bullmq.{0,40}down|queue.{0,40}down/.test(flat);
            expect(queueDown, 'health endpoint reports a queue/Redis subsystem as down').toBe(
                false,
            );
        }
    });
});
