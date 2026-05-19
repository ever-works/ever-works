import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Notification spam throttle — pass 16. Generating many notifications
 * from a single user shouldn't exceed a per-user / per-minute
 * throttle. We don't have a direct "send notification" black-box
 * endpoint, but we can drive activity by hammering work creation and
 * verifying the notifications listing endpoint stays bounded /
 * < 500 / non-paginated below a reasonable ceiling.
 */

test.describe('Notification throttle — listing stays sane under activity burst', () => {
    test('30 rapid work-creates leave /api/notifications < 500 and bounded', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // 30 quick creates to generate plausible activity-derived
        // notifications.
        for (let i = 0; i < 30; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `notif-${Date.now().toString(36)}-${i}`,
                slug: `notif-${Date.now().toString(36)}-${i}`,
            }).catch(() => null);
        }
        const res = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        if (!res.ok()) {
            test.skip(true, `/api/notifications returned ${res.status()}`);
        }
        const body = await res.json();
        const arr: Array<unknown> = Array.isArray(body)
            ? body
            : (body?.data ?? body?.notifications ?? body?.items ?? []);
        // The fresh user generated up to 30 events. The listing should
        // either page (≤ 100 returned in one call) or aggregate into
        // a small set. Anything > 500 returned at once means no
        // pagination — a perf risk.
        expect(
            arr.length,
            `/api/notifications returned ${arr.length} items in one call — no pagination`,
        ).toBeLessThan(500);
    });

    test('unread-count after burst stays a small integer < 10000', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        for (let i = 0; i < 10; i++) {
            await createWorkViaAPI(request, u.access_token, {
                name: `unread-${Date.now().toString(36)}-${i}`,
                slug: `unread-${Date.now().toString(36)}-${i}`,
            }).catch(() => null);
        }
        const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 404) test.skip(true, '/api/notifications/unread-count not exposed');
        expect(res.status()).toBeLessThan(500);
        if (!res.ok()) test.skip(true, `unread-count ${res.status()}`);
        const body = await res.json();
        const count = typeof body === 'number' ? body : (body?.count ?? body?.unread ?? 0);
        expect(typeof count, 'unread-count is not a number').toBe('number');
        expect(count, `unread-count = ${count} — implausibly large for fresh user`).toBeLessThan(
            10_000,
        );
        expect(count, `unread-count = ${count} — negative`).toBeGreaterThanOrEqual(0);
    });
});
