import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Panic controls (EW-778) — API CONTRACT.
 *
 * ── Routes ──────────────────────────────────────────────────────────
 *   Owner-scoped (platform session):
 *     POST   /api/fleet/drain-all          200 FleetDrainAllResult
 *     POST   /api/fleet/cancel-in-flight   200 FleetCancelInFlightResult
 *     GET    /api/fleet/kill-switch        200 FleetKillSwitchState
 *   Platform admin only:
 *     POST   /api/fleet/kill-switch/stop   200 | 403
 *     POST   /api/fleet/kill-switch/clear  200 | 403
 *     GET    /api/fleet/kill-switch/audit  200 | 403
 *
 * What a silent regression would break without a unit test noticing:
 *   - drain-all touches ONLY the caller's nodes (two users, one fleet
 *     each — the other account's node is exactly as it was);
 *   - a fresh account's stop flag reads NOT stopped and VERIFIED — if
 *     this ever reads `unverified`, every dispatch on the stack is
 *     parked fail-closed and something is wrong with the seed;
 *   - the actor is never leaked on the public read;
 *   - every new route is closed to anonymous callers (401) and the admin
 *     routes are closed to ordinary users (403) — an ordinary user must
 *     never be able to stop the whole platform.
 *
 * The admin set/clear happy path is gated behind
 * `TEST_FLEET_KILL_SWITCH_ADMIN=1`: throwing the switch parks EVERY
 * dispatch on the shared e2e stack for the duration, which would make
 * every parallel agent-run spec flaky. The unit specs cover that path.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrollNode(
    request: APIRequestContext,
    token: string,
): Promise<{ nodeId: string; secret: string }> {
    const mint = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(token),
        data: { name: `node-${uniq()}`, kind: 'node' },
    });
    expect(mint.status(), await mint.text().catch(() => '')).toBe(201);
    const minted = await mint.json();
    const enroll = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: { token: minted.token, platform: 'linux/x64', version: '0.0.0-e2e' },
    });
    expect(enroll.status(), await enroll.text().catch(() => '')).toBe(201);
    const enrolled = await enroll.json();
    return { nodeId: enrolled.nodeId, secret: enrolled.secret };
}

async function nodeStatus(request: APIRequestContext, token: string, nodeId: string) {
    const res = await request.get(`${API_BASE}/api/fleet/nodes`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const nodes = (await res.json()) as Array<{ id: string; status: string }>;
    return nodes.find((node) => node.id === nodeId)?.status;
}

test.describe('GET /api/fleet/kill-switch', () => {
    test('a signed-in user reads a NOT-stopped, VERIFIED flag with no actor in it', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/fleet/kill-switch`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ stopped: false, unverified: false });
        expect(body).toHaveProperty('reason');
        expect(body).toHaveProperty('since');
        expect(body).not.toHaveProperty('setByUserId');
    });

    test('anonymous is 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/fleet/kill-switch`);
        expect(res.status()).toBe(401);
    });
});

test.describe('POST /api/fleet/drain-all', () => {
    test('drains ONLY the caller’s nodes, skips an enrolling one, and never touches another account', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);

        const live = await enrollNode(request, owner.access_token);
        // A minted-but-unused token is an `enrolling` row — nothing to drain.
        const pending = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
            headers: authedHeaders(owner.access_token),
            data: { name: `node-${uniq()}`, kind: 'node' },
        });
        expect(pending.status()).toBe(201);
        const pendingNodeId = (await pending.json()).node.id as string;
        const strangerNode = await enrollNode(request, stranger.access_token);

        const res = await request.post(`${API_BASE}/api/fleet/drain-all`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(res.status(), await res.text().catch(() => '')).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            drainedNodes: 1,
            skippedNodes: 1,
            releasedJobs: 0,
            auditFailed: false,
        });
        expect(Array.isArray(body.nodes)).toBe(true);

        expect(await nodeStatus(request, owner.access_token, live.nodeId)).toBe('disabled');
        expect(await nodeStatus(request, owner.access_token, pendingNodeId)).toBe('enrolling');
        // The stranger's node is exactly as it was.
        expect(await nodeStatus(request, stranger.access_token, strangerNode.nodeId)).not.toBe(
            'disabled',
        );

        // A second drain-all is idempotent: the drained node is now skipped.
        const again = await request.post(`${API_BASE}/api/fleet/drain-all`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(again.status()).toBe(200);
        expect(await again.json()).toMatchObject({ drainedNodes: 0, skippedNodes: 2 });
    });

    test('a fresh account drains nothing, cleanly', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/fleet/drain-all`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({
            drainedNodes: 0,
            skippedNodes: 0,
            releasedJobs: 0,
            nodes: [],
            auditFailed: false,
        });
    });

    test('anonymous is 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/fleet/drain-all`, { data: {} });
        expect(res.status()).toBe(401);
    });
});

test.describe('POST /api/fleet/cancel-in-flight', () => {
    test('is owner-scoped and explicit: a fresh account cancels nothing, includeQueued is honoured', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/fleet/cancel-in-flight`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status(), await res.text().catch(() => '')).toBe(200);
        expect(await res.json()).toMatchObject({
            requested: 0,
            cancelled: 0,
            runsCancelled: 0,
            jobIds: [],
            auditFailed: false,
        });

        const withQueued = await request.post(`${API_BASE}/api/fleet/cancel-in-flight`, {
            headers: authedHeaders(u.access_token),
            data: { includeQueued: true },
        });
        expect(withQueued.status()).toBe(200);
        expect(await withQueued.json()).toMatchObject({ requested: 0 });
    });

    test('rejects a non-boolean includeQueued (400) and anonymous (401)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const bad = await request.post(`${API_BASE}/api/fleet/cancel-in-flight`, {
            headers: authedHeaders(u.access_token),
            data: { includeQueued: 'yes' },
        });
        expect(bad.status()).toBe(400);
        const anon = await request.post(`${API_BASE}/api/fleet/cancel-in-flight`, { data: {} });
        expect(anon.status()).toBe(401);
    });
});

test.describe('admin-only stop / clear / audit', () => {
    test('an ordinary user can NEVER stop the platform: 403 on stop, clear and audit', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const stop = await request.post(`${API_BASE}/api/fleet/kill-switch/stop`, {
            headers,
            data: { reason: 'e2e must not be able to do this' },
        });
        expect(stop.status()).toBe(403);
        const clear = await request.post(`${API_BASE}/api/fleet/kill-switch/clear`, {
            headers,
            data: {},
        });
        expect(clear.status()).toBe(403);
        const audit = await request.get(`${API_BASE}/api/fleet/kill-switch/audit`, { headers });
        expect(audit.status()).toBe(403);

        // And the flag is still clear for everyone.
        const state = await request.get(`${API_BASE}/api/fleet/kill-switch`, { headers });
        expect(await state.json()).toMatchObject({ stopped: false });
    });

    test('anonymous is 401 on every admin route', async ({ request }) => {
        for (const [method, path] of [
            ['post', '/api/fleet/kill-switch/stop'],
            ['post', '/api/fleet/kill-switch/clear'],
            ['get', '/api/fleet/kill-switch/audit'],
        ] as const) {
            const res =
                method === 'post'
                    ? await request.post(`${API_BASE}${path}`, { data: {} })
                    : await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(401);
        }
    });

    test('platform admin: stop parks the platform, every user sees it, clear resumes it, both are audited', async ({
        request,
    }) => {
        test.skip(
            process.env.TEST_FLEET_KILL_SWITCH_ADMIN !== '1',
            'Throwing the switch parks every dispatch on the shared e2e stack; opt in with TEST_FLEET_KILL_SWITCH_ADMIN=1.',
        );
        // The API grants isPlatformAdmin on register for the e2e-admin-* pattern
        // (EVER_WORKS_BOOTSTRAP_PLATFORM_ADMIN_EMAILS on the e2e stack).
        const admin = await registerUserViaAPI(request, {
            email: `e2e-admin-${uniq()}@test.local`,
        });
        const viewer = await registerUserViaAPI(request);
        const adminHeaders = authedHeaders(admin.access_token);

        try {
            const stop = await request.post(`${API_BASE}/api/fleet/kill-switch/stop`, {
                headers: adminHeaders,
                data: { reason: 'e2e drill' },
            });
            expect(stop.status(), await stop.text().catch(() => '')).toBe(200);
            const stopped = await stop.json();
            expect(stopped.state).toMatchObject({
                stopped: true,
                reason: 'e2e drill',
                unverified: false,
                setByUserId: admin.user.id,
            });
            expect(stopped.auditFailed).toBe(false);

            const seen = await request.get(`${API_BASE}/api/fleet/kill-switch`, {
                headers: authedHeaders(viewer.access_token),
            });
            const seenBody = await seen.json();
            expect(seenBody).toMatchObject({ stopped: true, reason: 'e2e drill' });
            expect(seenBody).not.toHaveProperty('setByUserId');
        } finally {
            const clear = await request.post(`${API_BASE}/api/fleet/kill-switch/clear`, {
                headers: adminHeaders,
                data: {},
            });
            expect(clear.status(), await clear.text().catch(() => '')).toBe(200);
            expect((await clear.json()).state).toMatchObject({ stopped: false });
        }

        const audit = await request.get(`${API_BASE}/api/fleet/kill-switch/audit?limit=10`, {
            headers: adminHeaders,
        });
        expect(audit.status()).toBe(200);
        const rows = (await audit.json()) as Array<{ action: string; actorUserId: string | null }>;
        expect(
            rows.some(
                (row) => row.action === 'kill-switch.stop' && row.actorUserId === admin.user.id,
            ),
        ).toBe(true);
        expect(
            rows.some(
                (row) => row.action === 'kill-switch.clear' && row.actorUserId === admin.user.id,
            ),
        ).toBe(true);
    });
});
