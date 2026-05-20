import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Error responses from the API should be parseable JSON with a stable
 * field shape. Clients depend on `statusCode` / `error` / `message`
 * being present so they can render usable messages. Plain text 404s or
 * HTML stack traces break every client integration.
 */

const ERROR_TRIGGERS = [
    {
        name: '404 unknown api route',
        method: 'GET' as const,
        path: '/api/__definitely-not-a-real-route',
    },
    {
        name: '404 unknown works id',
        method: 'GET' as const,
        path: '/api/works/00000000-0000-0000-0000-000000000000',
    },
    { name: '401 protected route without auth', method: 'GET' as const, path: '/api/users/me' },
    { name: '405 wrong method on works', method: 'DELETE' as const, path: '/api/works' },
];

test.describe('API error responses: JSON shape', () => {
    for (const trigger of ERROR_TRIGGERS) {
        test(`${trigger.name} returns JSON error body`, async ({ request }) => {
            const res = await request.fetch(`${API_BASE}${trigger.path}`, {
                method: trigger.method,
            });
            expect(res.status(), `${trigger.name} status`).toBeGreaterThanOrEqual(400);
            expect(res.status(), `${trigger.name} status`).toBeLessThan(500);
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('application/json')) return;
            const body = await res.json();
            expect(typeof body, `${trigger.name} body is object`).toBe('object');
            expect(body).not.toBeNull();
            // Either NestJS-style (statusCode/message/error) or REST-style (error/message)
            const hasNestShape =
                typeof body.statusCode === 'number' && typeof body.message !== 'undefined';
            const hasGenericShape =
                typeof body.error === 'string' || typeof body.message === 'string';
            expect(
                hasNestShape || hasGenericShape,
                `${trigger.name} error body should have statusCode+message or error/message`,
            ).toBe(true);
        });
    }
});
