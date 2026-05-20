import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Sort and filter query params with invalid values should never 5xx.
 * The server should either ignore the param, return a default order,
 * or 4xx with a clear shape.
 */

const PATH = '/api/works';

const SORT_EDGE_VALUES = [
    'nonExistentField',
    '../etc/passwd',
    "1' OR '1'='1",
    '<script>',
    'createdAt:reverse',
    'createdAt,createdAt,createdAt',
    'id;DROP TABLE',
    '',
];

const FILTER_KEYS = ['status', 'category', 'q'];
const FILTER_EDGE_VALUES = [
    '',
    'null',
    'undefined',
    'NaN',
    '0',
    '<img onerror=1>',
    'a'.repeat(2048),
];

test.describe('API sort param tolerance', () => {
    for (const sort of SORT_EDGE_VALUES) {
        test(`GET ${PATH}?sort=${JSON.stringify(sort)} tolerated`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${PATH}?sort=${encodeURIComponent(sort)}`);
            expect(res.status(), `sort=${sort}`).toBeLessThan(500);
        });
    }
});

test.describe('API filter param tolerance', () => {
    for (const key of FILTER_KEYS) {
        for (const value of FILTER_EDGE_VALUES) {
            test(`GET ${PATH}?${key}=${JSON.stringify(value)} tolerated`, async ({ request }) => {
                const res = await request.get(
                    `${API_BASE}${PATH}?${key}=${encodeURIComponent(value)}`,
                );
                expect(res.status(), `${key}=${value}`).toBeLessThan(500);
            });
        }
    }
});
