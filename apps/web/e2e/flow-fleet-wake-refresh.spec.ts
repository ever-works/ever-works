import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Computer health, second phase (FL-03, T-23, ACC-FL03-09 … 11) — wake and
 * Refresh now at the API edge, through the REAL node protocol:
 *
 *   Node side:   POST /api/fleet/enroll, /heartbeat (with `macAddress`, `lanId` under --manage)
 *   Owner side:  GET  /api/fleet/nodes/:id/health (wake / refresh availability)
 *                POST /api/fleet/nodes/:id/health (Refresh now)
 *                POST /api/fleet/nodes/:id/wake, GET /api/fleet/nodes/:id/wake
 *
 * The harness has no live node link, so the round trips themselves are
 * covered by the unit specs; here: the new heartbeat fields are accepted
 * (never a 400 — a 400 is a node swept offline), the hardware address is
 * never served in full, an online computer is not woken, an enrol-only or
 * unlinked computer cannot be refreshed, and a stranger reads nothing.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrolledNode(request: APIRequestContext, ownerToken: string) {
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(ownerToken),
        data: { name: `wake-${uniq()}`, kind: 'node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: { token, platform: 'linux/x64', version: '0.4.0', capabilities: ['terminal'] },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    return (await enrolled.json()) as { nodeId: string; secret: string };
}

async function beat(request: APIRequestContext, nodeId: string, secret: string, extra: Record<string, unknown>) {
    const res = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
        data: { nodeId, secret, platform: 'linux/x64', version: '0.4.0', capabilities: ['terminal'], ...extra },
    });
    expect(res.status(), `heartbeat body=${await res.text().catch(() => '')}`).toBe(200);
}

test.describe('computer health — wake and Refresh now (FR-23 … FR-28)', () => {
    test('a --manage beat with a hardware address and network identity is accepted, and the address is masked', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, {
            capabilities: ['terminal', 'managed', 'wake'],
            consents: { work: false, attend: false, manage: true, usageScan: false },
            macAddress: 'aa:bb:cc:dd:3f:9a',
            lanId: 'a1b2c3d4e5f60718',
        });
        // A malformed address is dropped by the service — never a failed beat.
        await beat(request, nodeId, secret, { macAddress: 'not-a-mac', lanId: 'nope' });

        const res = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const node = body.node ?? body;
        expect(node.macAddress).toBe('••:••:••:••:3f:9a');
        expect(JSON.stringify(body)).not.toContain('aa:bb:cc:dd');
        // The stored identity is re-hashed with the owner: never the reported value.
        expect(node.lanId).not.toBe('a1b2c3d4e5f60718');
    });

    test('an online computer is not woken, and its health read says why', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, { macAddress: 'aa:bb:cc:dd:3f:9a', lanId: 'a1b2c3d4e5f60718' });

        const wake = await request.post(`${API_BASE}/api/fleet/nodes/${nodeId}/wake`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect([400, 503]).toContain(wake.status());
        expect(['invalid', 'unreachable']).toContain((await wake.json()).error?.code);

        const health = await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json();
        if (health.wake) expect(health.wake).toMatchObject({ available: false, reason: 'not-offline' });

        const status = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/wake`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(status.status()).toBe(200);
        expect(await status.json()).toMatchObject({ nodeId, lastWakeAttemptAt: null, answered: false });
    });

    test('Refresh now on a computer with no open link is refused with its reason', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        // Enrol-only: no consent able to open a link.
        await beat(request, nodeId, secret, {
            consents: { work: false, attend: false, manage: false, usageScan: false },
            health: { cpuPercent: 5 },
        });
        const res = await request.post(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect([409, 503]).toContain(res.status());
        expect(['consent_missing', 'unreachable']).toContain((await res.json()).error?.code);

        const health = await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json();
        if (health.refresh) {
            expect(health.refresh.available).toBe(false);
            expect(['no-link', 'link-disabled']).toContain(health.refresh.reason);
        }
    });

    test('a stranger can neither refresh nor wake, nor read the wake status', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { nodeId } = await enrolledNode(request, owner.access_token);
        for (const [method, path] of [
            ['post', `/api/fleet/nodes/${nodeId}/health`],
            ['post', `/api/fleet/nodes/${nodeId}/wake`],
            ['get', `/api/fleet/nodes/${nodeId}/wake`],
        ] as const) {
            const res =
                method === 'post'
                    ? await request.post(`${API_BASE}${path}`, { headers: authedHeaders(stranger.access_token), data: {} })
                    : await request.get(`${API_BASE}${path}`, { headers: authedHeaders(stranger.access_token) });
            expect(res.status(), `${method} ${path}`).toBe(404);
        }
    });
});
