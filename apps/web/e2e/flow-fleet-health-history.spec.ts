import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Computer health, second phase (FL-03, T-18, ACC-FL03-06 / -08) — the history
 * read walked through the REAL node protocol: enrol, beat with a snapshot,
 * read the history back.
 *
 *   Node side (public, node-credential):  POST /api/fleet/enroll, /heartbeat
 *   Owner side (platform session):        GET  /api/fleet/nodes/:id/health/history
 *
 * Invariants:
 *   - with `FLEET_HEALTH_HISTORY_ENABLED` off the answer is `{ disabled: true }`
 *     (and nothing was written); with it on the beat's sample is in the 1 h range;
 *   - every range answers at most 500 points;
 *   - an unknown range is `invalid` (400) with the CONTRACTS §8 envelope;
 *   - a stranger gets the 404 of an unknown id.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrolledNode(request: APIRequestContext, ownerToken: string) {
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(ownerToken),
        data: { name: `hist-${uniq()}`, kind: 'node' },
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

test.describe('computer health — history (FR-18 … FR-22)', () => {
    test('answers disabled with the flag off, else the beat’s sample in ≤ 500 points', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, { health: { cpuPercent: 31.2, memPercent: 58, diskPercent: 40 } });

        const res = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health/history?range=1h`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBe(200);
        const history = await res.json();
        expect(history).toMatchObject({ nodeId, range: '1h' });
        if (history.disabled) {
            expect(history).toEqual({ nodeId, range: '1h', disabled: true });
            return;
        }
        expect(history.resolution).toBe('raw');
        expect(history.points.length).toBeGreaterThanOrEqual(1);
        expect(history.points.length).toBeLessThanOrEqual(500);
        expect(history.points.some((point: { cpu: number | null }) => point.cpu === 31.2)).toBe(true);
    });

    test('every range stays within 500 points and picks its resolution', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId } = await enrolledNode(request, owner.access_token);
        for (const [range, resolution] of [
            ['1h', 'raw'],
            ['24h', 'raw'],
            ['7d', 'hourly'],
            ['90d', 'hourly'],
        ] as const) {
            const res = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health/history?range=${range}`, {
                headers: authedHeaders(owner.access_token),
            });
            expect(res.status(), range).toBe(200);
            const history = await res.json();
            if (history.disabled) continue;
            expect(history.resolution, range).toBe(resolution);
            expect(history.points.length, range).toBeLessThanOrEqual(500);
        }
    });

    test('an unknown range is invalid, and a stranger gets the 404', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { nodeId } = await enrolledNode(request, owner.access_token);

        const bad = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health/history?range=1y`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(bad.status()).toBe(400);
        expect((await bad.json()).error).toMatchObject({ code: 'invalid' });

        const hidden = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health/history?range=1h`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(hidden.status()).toBe(404);
    });
});
