import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Pagination params at the edges of validity should not 5xx. They
 * should either coerce to a default, return 4xx with a clear shape,
 * or return an empty page — never an unhandled exception.
 */

const PUBLIC_PAGINATED_PATHS = ['/api/works'];

const PAGE_EDGE_VALUES = ['0', '-1', '1.5', 'abc', '999999999', ''];
const LIMIT_EDGE_VALUES = ['0', '-1', '1.5', 'abc', '10000', ''];

test.describe('API pagination: edge param values', () => {
    for (const path of PUBLIC_PAGINATED_PATHS) {
        for (const page of PAGE_EDGE_VALUES) {
            test(`${path}?page=${JSON.stringify(page)} tolerated`, async ({ request }) => {
                const res = await request.get(
                    `${API_BASE}${path}?page=${encodeURIComponent(page)}`,
                );
                expect(res.status(), `${path} page=${page}`).toBeLessThan(500);
            });
        }
        for (const limit of LIMIT_EDGE_VALUES) {
            test(`${path}?limit=${JSON.stringify(limit)} tolerated`, async ({ request }) => {
                const res = await request.get(
                    `${API_BASE}${path}?limit=${encodeURIComponent(limit)}`,
                );
                expect(res.status(), `${path} limit=${limit}`).toBeLessThan(500);
            });
        }
    }
});
