import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * W3C Trace Context propagation — pass 18. `traceparent` header
 * (https://www.w3.org/TR/trace-context/) format is:
 *   00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>
 *
 * When a client supplies one, the server should:
 *  - accept it without 5xx
 *  - either echo it on the response (rare for inbound) OR generate a
 *    fresh one in its own outbound observability pipeline
 * When no client supplies one, the server SHOULD generate its own
 * for downstream correlation (best-effort — many platforms don't
 * surface this on the response).
 */

const VALID_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const INVALID_TRACEPARENT = 'not-a-valid-traceparent';

test.describe('W3C Trace Context — traceparent propagation', () => {
    test('valid traceparent header accepted without 5xx', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`, {
            headers: { traceparent: VALID_TRACEPARENT },
        });
        expect(res.status(), `valid traceparent crashed: ${res.status()}`).toBeLessThan(500);
        expect(res.status()).toBeGreaterThanOrEqual(200);
    });

    test('malformed traceparent header does not crash (still < 500)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`, {
            headers: { traceparent: INVALID_TRACEPARENT },
        });
        expect(res.status(), `malformed traceparent crashed: ${res.status()}`).toBeLessThan(500);
    });

    test('traceparent response header (if generated) is valid W3C format', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const tp = res.headers()['traceparent'];
        if (!tp) {
            test.info().annotations.push({
                type: 'informational',
                description:
                    'no traceparent response header — distributed-trace propagation not surfaced',
            });
            test.skip(true, 'no traceparent on response');
        }
        // W3C format: 00-<32 hex>-<16 hex>-<2 hex>
        const valid = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(tp);
        expect(valid, `traceparent on response is non-W3C: "${tp}"`).toBe(true);
    });
});
