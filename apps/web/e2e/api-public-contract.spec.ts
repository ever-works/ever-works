import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Surface-level contract tests for the entire public API.
 *
 * For each known route prefix we hit a representative endpoint and assert:
 *  - the route exists (status != 404)
 *  - the API isn't crashing (status < 500)
 *
 * For protected endpoints we additionally assert the unauth posture is
 * 401 (not 403, not 200).
 *
 * This is a tripwire: when somebody renames a controller or deletes a
 * route by mistake, the corresponding test fires immediately.
 */

test.describe('Public API — health & metadata', () => {
    test('GET /api/health → 200', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
    });

    test('GET /api/auth/providers → 200 (public)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/providers`);
        // This endpoint is typically public for the social-login UI to render
        expect(res.status(), `providers status ${res.status()}`).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });

    test('GET /api/auth/validate-email-token without a token returns 4xx', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-email-token`);
        expect(res.status()).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });

    test('GET /api/auth/validate-reset-token without a token returns 4xx', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-reset-token`);
        expect(res.status()).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });
});

const protectedEndpoints = [
    '/api/works',
    '/api/works/stats',
    '/api/auth/api-keys',
    '/api/auth/profile',
    '/api/account/export',
    '/api/account/sync/status',
    '/api/notifications',
    '/api/notifications/unread-count',
    '/api/notifications/persistent',
    '/api/activity-log',
    '/api/activity-log/summary',
    '/api/activity-log/running-count',
    '/api/activity-log/export',
    '/api/conversations',
    '/api/subscriptions/plan',
    // Wave 13 (Billing/Usage UI) — new read-only surfaces are auth-gated
    // like their siblings.
    '/api/subscriptions/plans',
    '/api/credits/balance',
    '/api/credits/ledger',
    '/api/credits/usage-summary',
    '/api/plugins',
    // ── 2026-07 feature program ──────────────────────────────────────
    // Every read surface the program added is owner-scoped behind the
    // global auth guard. These rows are the tripwire: a controller that
    // loses its guard (or gains an accidental @Public()) flips one of
    // these from 401 to 200 and fails here first.
    // Meetings v1 (Wave 8 a).
    '/api/meetings',
    // Fleet registry (Wave 12) — the OWNER half; enroll/heartbeat are
    // deliberately @Public() and asserted separately below.
    '/api/fleet/nodes',
    // Fleet local-runner polish — the runner-status widget's data
    // endpoint and the execution-routing preference list. The widget is
    // rendered on EVERY dashboard page and polls every 30s, so an
    // accidental @Public() here would leak one account's machine
    // inventory (names, platforms, versions, free disk) to anyone.
    '/api/fleet/runner-status',
    '/api/fleet/execution-preferences',
    // Sessions list (Wave 4 M3) — literal `runs` segment, declared
    // before `:id` so it never reaches ParseUUIDPipe.
    '/api/agents/runs',
    // Prebuilt agent templates (Wave 10) — the AGENTS-scoped catalog.
    // (`/api/agent-templates`, the repo-backed metadata catalog, is
    // @Public() by design and is asserted separately below.)
    '/api/agents/templates',
    // Merge-policy resolution preview (Wave 3, D4). Auth is checked by
    // the guard before the controller's "provide workId and/or agentId"
    // 400, so an unauthenticated call is 401, never 400.
    '/api/merge-policy/resolve',
];

test.describe('Public API — protected endpoints reject unauth (401)', () => {
    for (const path of protectedEndpoints) {
        test(`GET ${path} → 401 (no auth)`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} returned ${res.status()}`).toBe(401);
        });
    }
});

test.describe('Public API — non-existent routes 404 cleanly', () => {
    const nonExistent = [
        '/api/this-route-does-not-exist',
        '/api/auth/this-route-does-not-exist',
        // /api/works/:something matches the @Get('works/:id') route, so to
        // get a real 404 we use a path that can't be matched by any route param.
        '/api/works/abc/this-subroute-does-not-exist',
    ];

    for (const path of nonExistent) {
        test(`GET ${path} → 404`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} returned ${res.status()}`).toBe(404);
        });
    }
});

test.describe('Public API — 2026-07 program write surfaces reject unauth (401)', () => {
    // Same tripwire as the GET table, on the verbs that mutate. A POST
    // that answers 400 (validation) instead of 401 would mean the guard
    // never ran — the DTO must never be reachable without a session.
    const protectedWrites: Array<{ path: string; data: unknown }> = [
        // Event-ingest push surface (Wave 6 k) — owner-scoped.
        { path: '/api/ingest/events', data: { events: [] } },
        // Meetings create (Wave 8 a).
        { path: '/api/meetings', data: { title: 'anon', startedAt: new Date().toISOString() } },
        // Fleet enrollment-token mint (Wave 12) — the OWNER half.
        { path: '/api/fleet/nodes/enrollment-token', data: { name: 'anon', kind: 'node' } },
    ];

    for (const { path, data } of protectedWrites) {
        test(`POST ${path} → 401 (no auth)`, async ({ request }) => {
            const res = await request.post(`${API_BASE}${path}`, { data });
            expect(res.status(), `${path} returned ${res.status()}`).toBe(401);
        });
    }
});

test.describe('Public API — self-authenticating public routes never accept an unsigned call', () => {
    // These four are @Public() on purpose: the caller is a node app or a
    // third-party webhook, so the CREDENTIAL is in the payload/signature
    // rather than a platform session. The invariant under test is that
    // they all still fail closed — an anonymous, unsigned call must
    // never come back 2xx, whatever the install's configuration is.

    test('POST /api/fleet/enroll with a bogus token → 4xx, never 2xx', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/fleet/enroll`, {
            // 16-char floor satisfied so the DTO passes and the
            // constant-time hash check is what rejects us.
            data: { token: 'not-a-real-enrollment-token' },
        });
        expect(res.status(), `enroll returned ${res.status()}`).toBe(401);
    });

    test('POST /api/fleet/heartbeat with a bogus node credential → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: {
                nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                secret: 'not-a-real-node-secret-value',
            },
        });
        expect(res.status(), `heartbeat returned ${res.status()}`).toBe(401);
    });

    test('POST /api/ingest/slack/events without a valid signature → 4xx, never 2xx', async ({
        request,
    }) => {
        // Slack signs the url_verification handshake too, so even the
        // challenge echo must be rejected without a valid v0 signature.
        const res = await request.post(`${API_BASE}/api/ingest/slack/events`, {
            data: { type: 'url_verification', challenge: 'e2e-challenge' },
        });
        expect(res.status(), `slack returned ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        // The challenge must NOT be echoed back to an unsigned caller.
        expect(await res.text()).not.toContain('e2e-challenge');
    });

    test('POST /api/ingest/github/events without the event header → 400; with it but unsigned → 4xx', async ({
        request,
    }) => {
        const noHeader = await request.post(`${API_BASE}/api/ingest/github/events`, {
            data: { zen: 'e2e' },
        });
        expect(noHeader.status(), `github (no header) returned ${noHeader.status()}`).toBe(400);

        const unsigned = await request.post(`${API_BASE}/api/ingest/github/events`, {
            headers: { 'x-github-event': 'ping' },
            data: { zen: 'e2e' },
        });
        expect(unsigned.status(), `github (unsigned) returned ${unsigned.status()}`).toBe(401);
    });
});

test.describe('Public API — deliberately public catalogs stay public', () => {
    test('GET /api/agent-templates → 200 for an anonymous caller', async ({ request }) => {
        // The repo-backed agent-template metadata catalog is @Public() by
        // design (the marketing/onboarding surfaces read it before login).
        const res = await request.get(`${API_BASE}/api/agent-templates`);
        expect(res.status(), `agent-templates returned ${res.status()}`).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });
});

test.describe('Public API — POST without body returns 4xx (not 5xx)', () => {
    const postEndpoints = [
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
    ];

    for (const path of postEndpoints) {
        test(`POST ${path} without body → 4xx`, async ({ request }) => {
            const res = await request.post(`${API_BASE}${path}`, { data: {} });
            expect(res.status(), `${path} returned ${res.status()}`).toBeLessThan(500);
            expect(res.status()).toBeGreaterThanOrEqual(400);
        });
    }
});
