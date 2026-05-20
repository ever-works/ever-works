import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * HEAD method parity with GET. Per RFC 9110 §9.3.2 a HEAD response
 * MUST contain the same headers as the corresponding GET response,
 * and MUST NOT contain a body. The server should never 5xx on HEAD
 * of a public endpoint, even when its handler only declared @Get.
 */

const TARGETS = ['/api/health', '/api/version', '/api/info', '/.well-known/agent.json'];

test.describe('HEAD-GET parity on public endpoints', () => {
    for (const path of TARGETS) {
        test(`HEAD ${path} does not 5xx`, async ({ request }) => {
            const res = await request.fetch(`${API_BASE}${path}`, { method: 'HEAD' });
            expect(res.status(), `HEAD ${path}`).toBeLessThan(500);
        });

        test(`HEAD ${path} returns empty body on 200`, async ({ request }) => {
            const res = await request.fetch(`${API_BASE}${path}`, { method: 'HEAD' });
            if (res.status() === 200) {
                const body = await res.body();
                expect(body.length, `HEAD ${path} body bytes`).toBe(0);
            }
        });

        test(`HEAD ${path} shares Content-Type with GET when both 200`, async ({ request }) => {
            const headRes = await request.fetch(`${API_BASE}${path}`, { method: 'HEAD' });
            const getRes = await request.get(`${API_BASE}${path}`);
            if (headRes.status() === 200 && getRes.status() === 200) {
                const headCt = (headRes.headers()['content-type'] || '').split(';')[0].trim();
                const getCt = (getRes.headers()['content-type'] || '').split(';')[0].trim();
                expect(headCt, `HEAD vs GET content-type ${path}`).toBe(getCt);
            }
        });
    }
});
