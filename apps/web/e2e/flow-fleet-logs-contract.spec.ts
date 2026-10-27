import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Logs on computers (FL-08) — the REST CONTRACT of
 * `apps/api/src/fleet/logs/fleet-logs.controller.ts` (CONTRACTS §11.2).
 *
 * ── Routes ───────────────────────────────────────────────────────────────
 *   GET   /api/fleet/nodes/:id/logs/sources       → 200 { nodeId, platform, sources, roots, truncated, listedAt }
 *   POST  /api/fleet/nodes/:id/logs/attach-token  → 200 { token, wsPath, expiresInSec, sources, lines, follow }
 *   POST  /api/fleet/nodes/:id/logs/read          → 200 { lines, count, matched, truncated, redactions, filter }
 *
 * The routes are dark unless `FLEET_MACHINE_FACTS_ENABLED=true` (default off):
 * then EVERY one answers 404 (ACC-FL08-16). With it on, an unknown computer or
 * one the caller may not see answers the same 404 (no existence leak), and a
 * malformed body 400 before any lookup. No e2e computer runs `--manage`, so
 * the spec asserts the SET of legal answers per stack rather than pretending
 * a machine answers.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test.describe('Fleet logs — API contract (FL-08)', () => {
    test('an unknown computer answers 404 on every route, flag on or off', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const headers = { ...authedHeaders(user.access_token), 'Content-Type': 'application/json' };
        const calls = [
            request.get(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/sources`, { headers }),
            request.post(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/attach-token`, {
                headers,
                data: { source: 'system:journal', follow: true },
            }),
            request.post(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/read`, {
                headers,
                data: { source: 'system:journal', lines: 200 },
            }),
        ];
        for (const response of await Promise.all(calls)) {
            expect(response.status(), response.url()).toBe(404);
        }
    });

    test('a read refuses follow and an out-of-range line count before any lookup (400), or is dark (404)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = { ...authedHeaders(user.access_token), 'Content-Type': 'application/json' };
        const follow = await request.post(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/read`, {
            headers,
            data: { source: 'system:journal', follow: true },
        });
        expect([400, 404]).toContain(follow.status());
        const tooMany = await request.post(
            `${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/read`,
            {
                headers,
                data: { source: 'system:journal', lines: 501 },
            },
        );
        expect([400, 404]).toContain(tooMany.status());
    });

    test('the routes need a signed-in person', async ({ request }) => {
        const response = await request.get(
            `${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/logs/sources`,
        );
        expect([401, 404]).toContain(response.status());
    });
});
