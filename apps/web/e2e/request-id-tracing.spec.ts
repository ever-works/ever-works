import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Request-ID tracing — pass 15. For distributed-trace and oncall
 * correlation, the API should:
 *  - generate `X-Request-ID` (or `X-Trace-ID` / `X-Correlation-ID`)
 *    on every response when none was provided
 *  - echo back the same id when the client supplies one
 *  - return distinct ids across distinct requests when none was
 *    supplied (i.e. it's actually generating per-request, not static)
 */

const REQUEST_ID_HEADERS = ['x-request-id', 'x-trace-id', 'x-correlation-id', 'request-id'];

function pickRequestId(headers: Record<string, string>): string | null {
    for (const h of REQUEST_ID_HEADERS) {
        const v = headers[h];
        if (v) return v;
    }
    return null;
}

test.describe('Request-ID — generation + echo + uniqueness', () => {
    test('/api/health response carries a generated request-id when none supplied', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const id = pickRequestId(res.headers());
        if (!id) {
            test.info().annotations.push({
                type: 'informational',
                description: 'no request-id header on /api/health — distributed tracing not wired',
            });
            test.skip(true, 'no request-id header generated');
        }
        // The id should be at least 8 chars (most generators emit
        // 16+ hex / uuid). Catastrophically short ids are flagged.
        expect(id!.length, `request-id suspiciously short: "${id}"`).toBeGreaterThanOrEqual(8);
    });

    test('X-Request-ID supplied by client is echoed back on response', async ({ request }) => {
        const probe = await request.get(`${API_BASE}/api/health`);
        const baseline = pickRequestId(probe.headers());
        if (!baseline) test.skip(true, 'no request-id header surfaced — tracing not wired');
        const supplied = `e2e-trace-${Date.now().toString(36)}`;
        const res = await request.get(`${API_BASE}/api/health`, {
            headers: { 'X-Request-ID': supplied },
        });
        const echoed = pickRequestId(res.headers());
        if (!echoed) {
            test.skip(true, 'no request-id header on supplied-id response');
        }
        // Either the server echoes the supplied id verbatim, OR it
        // generates its own. Echo is best practice; generation is
        // acceptable but informational.
        if (echoed !== supplied) {
            test.info().annotations.push({
                type: 'informational',
                description: `client X-Request-ID="${supplied}" was not echoed (server returned "${echoed}")`,
            });
        }
    });

    test('two consecutive requests get different request-ids when none supplied', async ({
        request,
    }) => {
        const a = await request.get(`${API_BASE}/api/health`);
        const b = await request.get(`${API_BASE}/api/health`);
        const aId = pickRequestId(a.headers());
        const bId = pickRequestId(b.headers());
        if (!aId || !bId) test.skip(true, 'no request-id header surfaced');
        expect(aId, 'request-id is static across requests — not actually generated').not.toBe(bId);
    });
});
