import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Tasks — real pagination + filter semantics. Existing pagination/sort-filter
 * specs only assert "no 5xx"; this pins actual behaviour: limit/offset
 * windows (no overlap), priority/label/search filters, and garbage-param
 * tolerance. Verified against live shapes.
 */

// Seeds a fresh user with 5 tasks:
//   index 0..4, priority p3/p1 alternating (2 are p1), label `alpha` on #0 else `beta`.
async function seedTasks(request: import('@playwright/test').APIRequestContext) {
    const u = await registerUserViaAPI(request);
    const headers = authedHeaders(u.access_token);
    for (let i = 0; i < 5; i++) {
        await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: {
                title: `Task ${i}`,
                priority: i % 2 ? 'p1' : 'p3',
                labels: i === 0 ? ['alpha'] : ['beta'],
            },
        });
    }
    return headers;
}

test.describe('Tasks — pagination', () => {
    test('limit/offset return non-overlapping windows with correct meta', async ({ request }) => {
        const headers = await seedTasks(request);

        const page1 = await (
            await request.get(`${API_BASE}/api/tasks?limit=2&offset=0`, { headers })
        ).json();
        expect(page1.data.length).toBe(2);
        expect(page1.meta).toMatchObject({ total: 5, limit: 2, offset: 0 });

        const page2 = await (
            await request.get(`${API_BASE}/api/tasks?limit=2&offset=2`, { headers })
        ).json();
        expect(page2.data.length).toBe(2);
        expect(page2.meta).toMatchObject({ total: 5, limit: 2, offset: 2 });

        // The two pages must be disjoint — offset genuinely shifts the window.
        const p1 = page1.data.map((t: { id: string }) => t.id);
        const p2 = page2.data.map((t: { id: string }) => t.id);
        expect(p1.some((id: string) => p2.includes(id))).toBe(false);
    });

    test('a garbage limit is tolerated (200, not 5xx)', async ({ request }) => {
        const headers = await seedTasks(request);
        const res = await request.get(`${API_BASE}/api/tasks?limit=abc`, { headers });
        expect(res.status()).toBe(200);
        expect(Array.isArray((await res.json()).data)).toBe(true);
    });
});

test.describe('Tasks — filters', () => {
    test('?priority returns only matching tasks', async ({ request }) => {
        const headers = await seedTasks(request);
        const res = await (
            await request.get(`${API_BASE}/api/tasks?priority=p1`, { headers })
        ).json();
        expect(res.data.length).toBe(2);
        expect(res.data.every((t: { priority: string }) => t.priority === 'p1')).toBe(true);
    });

    test('?label filters by tag', async ({ request }) => {
        const headers = await seedTasks(request);
        const res = await (
            await request.get(`${API_BASE}/api/tasks?label=alpha`, { headers })
        ).json();
        expect(res.data.length).toBe(1);
        expect(res.data[0].labels).toContain('alpha');
    });

    test('?search matches on title', async ({ request }) => {
        const headers = await seedTasks(request);
        const res = await (
            await request.get(`${API_BASE}/api/tasks?search=${encodeURIComponent('Task 3')}`, {
                headers,
            })
        ).json();
        expect(res.data.length).toBeGreaterThanOrEqual(1);
        expect(res.data.some((t: { title: string }) => t.title === 'Task 3')).toBe(true);
    });
});
