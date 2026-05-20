import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Range request tolerance on endpoints that don't serve bytes. Per
 * RFC 9110 §14.2 a server that doesn't support range requests should
 * ignore the Range header and respond as normal. A server that
 * advertises bytes-range support should respond 206 or 416 on
 * out-of-range — but never 5xx.
 */

const TARGETS = ['/api/health', '/.well-known/agent.json'];

const RANGE_HEADERS = [
    'bytes=0-99',
    'bytes=0-',
    'bytes=-100',
    'bytes=1000000000-2000000000',
    'bytes=0-0',
    'malformed-range',
    '',
];

test.describe('Range request tolerance on JSON endpoints', () => {
    for (const path of TARGETS) {
        for (const range of RANGE_HEADERS) {
            test(`GET ${path} with Range="${range}"`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}`, {
                    headers: range ? { Range: range } : {},
                });
                expect(res.status(), `${path} range=${range}`).toBeLessThan(500);
            });
        }
    }
});
