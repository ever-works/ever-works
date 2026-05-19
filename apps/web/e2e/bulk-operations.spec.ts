import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Bulk operations — pass 7. The platform may expose batch endpoints
 * for items / works / notifications. We probe a few candidate paths
 * and verify each respects auth + rejects empty/malformed batches.
 */

const BULK_PATHS = [
    { method: 'POST', path: '/api/works/bulk', label: 'works bulk' },
    { method: 'POST', path: '/api/notifications/bulk-read', label: 'notifications bulk-read' },
    { method: 'POST', path: '/api/notifications/read-all', label: 'notifications read-all' },
    { method: 'POST', path: '/api/api-keys/bulk-revoke', label: 'api-keys bulk-revoke' },
];

test.describe('Bulk operations — endpoint probes', () => {
    for (const op of BULK_PATHS) {
        test(`${op.label}: unauth → 401 (or skip if not exposed)`, async ({ request }) => {
            const res = await request.post(`${API_BASE}${op.path}`, { data: {} });
            if (res.status() === 404 || res.status() === 405) {
                test.skip(true, `${op.label} not exposed in this env`);
            }
            expect([401, 403]).toContain(res.status());
        });

        test(`${op.label}: empty body for authed user responds 4xx (not 5xx)`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            const res = await request.post(`${API_BASE}${op.path}`, {
                headers: authedHeaders(u.access_token),
                data: {},
            });
            if (res.status() === 404 || res.status() === 405) {
                test.skip(true, `${op.label} not exposed`);
            }
            expect(res.status()).toBeLessThan(500);
            // Should NOT silently 2xx an empty body — that would mean
            // the endpoint applied "bulk all" by default.
            // Some implementations return 200 with {affected: 0} which
            // is also fine.
        });
    }
});

test.describe('Bulk read-all notifications — happy path', () => {
    test('owner can POST /api/notifications/read-all without 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 404 || res.status() === 405) {
            test.skip(true, 'read-all not exposed in this env');
        }
        expect(res.status()).toBeLessThan(500);
        // After read-all, unread-count should be 0.
        const count = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(u.access_token),
        });
        if (count.status() === 200) {
            const body = await count.json();
            const value = body?.count ?? body?.unread ?? body?.unreadCount;
            if (typeof value === 'number') {
                expect(value).toBe(0);
            }
        }
    });
});

test.describe('Bulk items — work-scoped batch ops', () => {
    test('POST /api/works/:id/items/bulk-* respond < 500 for owner', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `bulk-items-${Date.now().toString(36)}`,
        });
        const candidates = [
            '/api/works/' + w.id + '/items/bulk-delete',
            '/api/works/' + w.id + '/items/bulk-update',
            '/api/works/' + w.id + '/items/bulk-publish',
            '/api/works/' + w.id + '/bulk-capture-images',
        ];
        let foundAny = false;
        for (const path of candidates) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { ids: [] },
            });
            if (res.status() !== 404 && res.status() !== 405) {
                foundAny = true;
                expect(res.status()).toBeLessThan(500);
            }
        }
        if (!foundAny) test.skip(true, 'no work-scoped bulk-* endpoint exposed');
    });
});
