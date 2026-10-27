import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Sessions on computers (FL-04) — the REST CONTRACT of
 * `apps/api/src/fleet/sessions/fleet-sessions.controller.ts` (CONTRACTS §11.2).
 *
 * ── Routes ───────────────────────────────────────────────────────────────
 *   GET   /api/fleet/nodes/:id/sessions          → 200 { sessions, nextCursor, recentFolders }
 *   POST  /api/fleet/nodes/:id/sessions          → 201 FleetSessionView | CONTRACTS §8 refusal
 *   GET   /api/fleet/sessions                    → 200 { sessions, nextCursor }
 *   GET   /api/fleet/sessions/:id                → 200 FleetSessionView (+ lastScreen, presence)
 *   PATCH /api/fleet/sessions/:id                → 200
 *   POST  /api/fleet/sessions/:id/end            → 202 (confirm: true) | confirmation_required
 *   POST  /api/fleet/sessions/:id/restart        → 201
 *   POST  /api/fleet/sessions/:id/attach-token   → 200 { token, role, expiresInSec, wsPath }
 *
 * The routes are dark unless `FLEET_SESSIONS_ENABLED=true` (default off): then
 * EVERY one answers 404, which is what this file asserts on a stack with the
 * flag off. With it on, an unknown id or a computer the caller may not see
 * answers the same 404 (no existence leak), and malformed bodies 400. The
 * spec asserts the SET of legal answers per stack rather than pretending a
 * machine is enrolled — no e2e computer runs a session daemon.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test.describe('Fleet sessions — API contract (FL-04)', () => {
    test('an unknown session answers 404 on every route, flag on or off', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const headers = { ...authedHeaders(user.access_token), 'Content-Type': 'application/json' };
        const calls = [
            request.get(`${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}`, { headers }),
            request.patch(`${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}`, {
                headers,
                data: { title: 'x' },
            }),
            request.post(`${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}/end`, {
                headers,
                data: { confirm: true },
            }),
            request.post(`${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}/restart`, {
                headers,
                data: {},
            }),
            request.post(`${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}/attach-token`, {
                headers,
                data: { role: 'viewer' },
            }),
        ];
        for (const response of await Promise.all(calls)) {
            expect(response.status(), response.url()).toBe(404);
        }
    });

    test('an unknown computer answers 404 for its sessions; a stranger reads the same', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = { ...authedHeaders(user.access_token), 'Content-Type': 'application/json' };
        const list = await request.get(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/sessions`, {
            headers,
        });
        expect(list.status()).toBe(404);
        const start = await request.post(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/sessions`, {
            headers,
            data: { kind: 'owner', provider: 'shell', cwd: '~' },
        });
        expect(start.status()).toBe(404);
    });

    test('the cross-computer list answers a page (or 404 while the flag is off)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const response = await request.get(`${API_BASE}/api/fleet/sessions`, {
            headers: authedHeaders(user.access_token),
        });
        expect([200, 404]).toContain(response.status());
        if (response.status() !== 200) return;
        const body = await response.json();
        expect(Array.isArray(body.sessions)).toBe(true);
        expect(body.sessions).toHaveLength(0);
        expect(body.nextCursor).toBeNull();
    });

    test('an attach token needs a known role (400) — never minted without one', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const response = await request.post(
            `${API_BASE}/api/fleet/sessions/${UNKNOWN_UUID}/attach-token`,
            {
                headers: {
                    ...authedHeaders(user.access_token),
                    'Content-Type': 'application/json',
                },
                data: { role: 'owner' },
            },
        );
        // Flag off: 404 (dark). Flag on: the DTO refuses the role before any lookup.
        expect([400, 404]).toContain(response.status());
    });

    test('an Agent session on an unknown computer answers 404 — never a queued job (FL-04 P2)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const response = await request.post(
            `${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}/sessions`,
            {
                headers: {
                    ...authedHeaders(user.access_token),
                    'Content-Type': 'application/json',
                },
                data: {
                    kind: 'agent',
                    provider: 'claude-code',
                    cwd: '~/code/app',
                    agentId: UNKNOWN_UUID,
                    firstMessage: 'Fix the failing build',
                },
            },
        );
        expect(response.status()).toBe(404);
    });

    test('the routes need a signed-in person', async ({ request }) => {
        const response = await request.get(`${API_BASE}/api/fleet/sessions`);
        expect([401, 404]).toContain(response.status());
    });
});
