import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Activity log — audit/observability surface. Pins the real shapes:
 * the signup audit entry every account gets, the status-bucket summary,
 * and the running-count. (Note: mission/agent creation does NOT emit
 * activity entries — only work/generation + auth events do — so this
 * asserts what's actually recorded, not an aspirational audit trail.)
 *
 * API: GET /api/activity-log, /summary, /running-count.
 */

test.describe('Activity log — audit surface', () => {
    test('GET /api/activity-log without auth → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/activity-log`)).status()).toBe(401);
    });

    test('a new account has a completed "user_signup" audit entry', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.activities)).toBe(true);
        expect(typeof body.total).toBe('number');

        const signup = body.activities.find(
            (a: { actionType: string }) => a.actionType === 'user_signup',
        );
        expect(signup, 'signup audit entry').toBeTruthy();
        expect(signup.action).toBe('user.signup');
        expect(signup.status).toBe('completed');
        expect(signup.userId).toBe(u.user.id);
        expect(typeof signup.createdAt).toBe('string');
    });

    test('GET /summary returns a status-bucket count map', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/summary`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const { counts } = await res.json();
        // All lifecycle buckets are present; the signup already counts as completed.
        for (const k of ['pending', 'in_progress', 'completed', 'failed', 'cancelled']) {
            expect(typeof counts[k]).toBe('number');
        }
        expect(counts.completed).toBeGreaterThanOrEqual(1);
    });

    test('GET /running-count is a non-negative integer (0 for an idle account)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/running-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const { count } = await res.json();
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBe(0);
    });

    test('?limit caps the returned activities', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log?limit=1`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).activities.length).toBeLessThanOrEqual(1);
    });
});
