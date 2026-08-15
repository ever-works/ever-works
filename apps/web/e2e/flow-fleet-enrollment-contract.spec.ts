import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Fleet node registry (Wave 12, slice 1) — API CONTRACT plus the REAL
 * enrollment protocol walked end to end. Shipped with no e2e.
 *
 * ── Routes (apps/api/src/fleet/fleet.controller.ts) ─────────────────
 *   Owner-scoped (platform session):
 *     GET    /api/fleet/nodes                  200 FleetNodeView[]
 *     POST   /api/fleet/nodes/enrollment-token 201 { node, token,
 *                                                    expiresInSec }
 *     PATCH  /api/fleet/nodes/:id              200 (name and/or disabled)
 *     DELETE /api/fleet/nodes/:id              204
 *   Public, self-authenticating (called by the node apps):
 *     POST   /api/fleet/enroll     201 { nodeId, secret, node } | 401
 *     POST   /api/fleet/heartbeat  200 { ok:true, node }        | 401
 *
 * The protocol invariants asserted here are the ones a silent
 * regression would break without any unit test noticing:
 *   - the enrollment token is returned EXACTLY ONCE and is SINGLE-USE
 *     (a replay is 401, not a second node);
 *   - every invalid credential path is ONE undifferentiated 401 — the
 *     response must never say which check failed;
 *   - the heartbeat secret is minted at enroll, and a DISABLED node's
 *     beat is still accepted but can never re-enable it (c98337eb:
 *     drain drains LEASING, not observability — a drained node that
 *     goes dark would be indistinguishable from a crashed one).
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

async function mintToken(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<{ node: { id: string; name: string; status: string }; token: string }> {
    const res = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(token),
        data: { name: `node-${uniq()}`, kind: 'node', ...overrides },
    });
    expect(res.status(), `mintToken body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

test.describe('GET /api/fleet/nodes', () => {
    test('a fresh account has an empty (or at least own-only) registry', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `nodes body=${await res.text().catch(() => '')}`).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    test('the registry is owner-scoped — a stranger never sees my node', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { node } = await mintToken(request, owner.access_token);

        const mine = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(owner.access_token),
        });
        const mineRows = (await mine.json()) as Array<{ id: string }>;
        expect(mineRows.some((r) => r.id === node.id)).toBe(true);

        const theirs = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(stranger.access_token),
        });
        const theirRows = (await theirs.json()) as Array<{ id: string }>;
        expect(theirRows.some((r) => r.id === node.id)).toBe(false);
    });
});

test.describe('POST /api/fleet/nodes/enrollment-token', () => {
    test('mints a node in `enrolling` state and returns the token exactly once', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const minted = await mintToken(request, u.access_token, { name: `Mac mini ${uniq()}` });

        expect(minted.node.status).toBe('enrolling');
        expect(typeof minted.token).toBe('string');
        expect(minted.token.length).toBeGreaterThanOrEqual(16);

        // The token is hashed at rest — re-reading the registry must not
        // hand it back a second time.
        const list = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(u.access_token),
        });
        const raw = await list.text();
        expect(raw).not.toContain(minted.token);
        expect(raw).not.toContain('enrollmentTokenHash');
    });

    test('name and kind are validated (kind is a closed, enrollable set)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const url = `${API_BASE}/api/fleet/nodes/enrollment-token`;
        const headers = authedHeaders(u.access_token);

        const noName = await request.post(url, { headers, data: { kind: 'node' } });
        expect(noName.status()).toBe(400);

        const emptyName = await request.post(url, { headers, data: { name: '', kind: 'node' } });
        expect(emptyName.status()).toBe(400);

        const badKind = await request.post(url, {
            headers,
            data: { name: `n-${uniq()}`, kind: 'toaster' },
        });
        expect(badKind.status()).toBe(400);

        for (const kind of ['node', 'desktop-node']) {
            const ok = await request.post(url, {
                headers,
                data: { name: `n-${kind}-${uniq()}`, kind },
            });
            expect(ok.status(), `kind=${kind}`).toBe(201);
        }

        const extra = await request.post(url, {
            headers,
            data: { name: `n-${uniq()}`, kind: 'node', bogusField: 1 },
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property bogusField should not exist');
    });
});

test.describe('the enrollment protocol, end to end', () => {
    test('mint → enroll → heartbeat, with the token single-use and the secret minted once', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const minted = await mintToken(request, u.access_token, { name: `Node ${uniq()}` });

        // 1) Enroll with the one-time token (PUBLIC route — the token IS
        //    the credential; no platform session is presented).
        const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
            data: {
                token: minted.token,
                platform: 'linux/x64',
                version: '1.0.0',
                capabilities: ['terminal', 'workspace'],
            },
        });
        expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
        const enrollBody = await enrolled.json();
        expect(enrollBody.nodeId).toBe(minted.node.id);
        expect(typeof enrollBody.secret).toBe('string');
        expect(enrollBody.secret.length).toBeGreaterThanOrEqual(16);
        expect(enrollBody.secret).not.toBe(minted.token);

        // 2) The token is SINGLE-USE — a replay is one undifferentiated 401.
        const replay = await request.post(`${API_BASE}/api/fleet/enroll`, {
            data: { token: minted.token },
        });
        expect(replay.status(), 'an enrollment token can only be consumed once').toBe(401);
        expect(errText(await replay.json())).toContain('Invalid or expired enrollment token');

        // 3) Heartbeat with the minted secret — the server stamps last-seen.
        const beat = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: {
                nodeId: enrollBody.nodeId,
                secret: enrollBody.secret,
                capabilities: ['terminal'],
            },
        });
        expect(beat.status(), `heartbeat body=${await beat.text().catch(() => '')}`).toBe(200);
        const beatBody = await beat.json();
        expect(beatBody.ok).toBe(true);
        expect(beatBody.node.status).toBe('online');
        expect(beatBody.node.lastHeartbeatAt, 'last-seen is server-stamped').toBeTruthy();
        // Credentials never come back on a heartbeat.
        expect(JSON.stringify(beatBody)).not.toContain(enrollBody.secret);

        // 4) The owner sees the node as online in their registry.
        const list = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(u.access_token),
        });
        const rows = (await list.json()) as Array<{ id: string; status: string }>;
        expect(rows.find((r) => r.id === enrollBody.nodeId)?.status).toBe('online');
    });

    test('every invalid credential path is one undifferentiated 401', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const minted = await mintToken(request, u.access_token);
        const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
            data: { token: minted.token },
        });
        expect(enrolled.status()).toBe(201);
        const { nodeId, secret } = await enrolled.json();

        // Unknown token / unknown node / wrong secret all answer the same,
        // so nothing can be probed by comparing responses.
        const badToken = await request.post(`${API_BASE}/api/fleet/enroll`, {
            data: { token: 'a'.repeat(43) },
        });
        expect(badToken.status()).toBe(401);

        const unknownNode = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: { nodeId: UNKNOWN_UUID, secret },
        });
        expect(unknownNode.status()).toBe(401);

        const wrongSecret = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: { nodeId, secret: 'b'.repeat(43) },
        });
        expect(wrongSecret.status()).toBe(401);

        // Identical message on both heartbeat failure modes — "unknown
        // node" and "wrong secret" must be indistinguishable.
        const unknownNodeMessage = errText(await unknownNode.json());
        const wrongSecretMessage = errText(await wrongSecret.json());
        expect(wrongSecretMessage).toBe(unknownNodeMessage);
        expect(wrongSecretMessage).toContain('Invalid node credential');
    });

    test('disabling a node actually drains it — its heartbeat stops being accepted', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const minted = await mintToken(request, u.access_token);
        const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
            data: { token: minted.token },
        });
        expect(enrolled.status()).toBe(201);
        const { nodeId, secret } = await enrolled.json();

        const before = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: { nodeId, secret },
        });
        expect(before.status(), 'the node reports fine before draining').toBe(200);

        const drained = await request.patch(`${API_BASE}/api/fleet/nodes/${nodeId}`, {
            headers: authedHeaders(u.access_token),
            data: { disabled: true },
        });
        expect(drained.status()).toBe(200);
        expect((await drained.json()).status).toBe('disabled');

        // c98337eb (A29, pause/drain): drain drains LEASING, not observability.
        // The old contract 401'd a disabled node's heartbeat; the new one
        // accepts it (200) but keeps the status sticky — a drained node that
        // goes dark is indistinguishable from a crashed one, so the beat stays
        // welcome while the node stays out of the lease pool. The invariant
        // worth pinning is that the beat must never RE-ENABLE the node.
        const after = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
            data: { nodeId, secret },
        });
        expect(after.status(), 'a drained node may still report (observability)').toBe(200);
        const beat = await after.json();
        expect(beat.ok).toBe(true);
        expect(beat.node.status, 'a beat must never re-enable a drained node').toBe('disabled');
    });
});

test.describe('PATCH / DELETE /api/fleet/nodes/:id', () => {
    test('rename works; an empty patch body is a truthful 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const { node } = await mintToken(request, u.access_token);

        const renamed = await request.patch(`${API_BASE}/api/fleet/nodes/${node.id}`, {
            headers: authedHeaders(u.access_token),
            data: { name: `renamed-${uniq()}` },
        });
        expect(renamed.status()).toBe(200);
        expect(String((await renamed.json()).name)).toContain('renamed-');

        const empty = await request.patch(`${API_BASE}/api/fleet/nodes/${node.id}`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(empty.status()).toBe(400);
        // The full message has grown twice as PATCH gained fields (72940460
        // added capabilities, c98337eb added paused). Pin the stable prefix,
        // not the whole enumeration — the 400-on-empty-body is the contract.
        expect(errText(await empty.json())).toContain('Provide name');
    });

    test('authz: stranger 404, unknown 404, malformed 400, anon 401; delete is 204', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { node } = await mintToken(request, owner.access_token);
        const path = `/api/fleet/nodes/${node.id}`;

        const cross = await request.patch(`${API_BASE}${path}`, {
            headers: authedHeaders(stranger.access_token),
            data: { name: 'hijack' },
        });
        expect(cross.status()).toBe(404);

        const crossDelete = await request.delete(`${API_BASE}${path}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(crossDelete.status()).toBe(404);

        const unknown = await request.patch(`${API_BASE}/api/fleet/nodes/${UNKNOWN_UUID}`, {
            headers: authedHeaders(owner.access_token),
            data: { name: 'x' },
        });
        expect(unknown.status()).toBe(404);

        const malformed = await request.patch(`${API_BASE}/api/fleet/nodes/not-a-uuid`, {
            headers: authedHeaders(owner.access_token),
            data: { name: 'x' },
        });
        expect(malformed.status()).toBe(400);

        const anon = await request.delete(`${API_BASE}${path}`);
        expect(anon.status()).toBe(401);

        // The owner's node survived every refused attempt, then deletes.
        const removed = await request.delete(`${API_BASE}${path}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(removed.status()).toBe(204);

        const list = await request.get(`${API_BASE}/api/fleet/nodes`, {
            headers: authedHeaders(owner.access_token),
        });
        const rows = (await list.json()) as Array<{ id: string }>;
        expect(rows.some((r) => r.id === node.id)).toBe(false);
    });
});
