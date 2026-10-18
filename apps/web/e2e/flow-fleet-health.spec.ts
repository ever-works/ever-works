import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Computer health (FL-03 P1) — the health snapshot walked end to end through
 * the REAL node protocol: enrol a node, beat with a health snapshot, read it
 * back as the owner, and see the "needs a look" producers react to it.
 *
 *   Node side (public, node-credential):  POST /api/fleet/enroll, /heartbeat
 *   Owner side (platform session):        GET  /api/fleet/nodes/:id/health
 *                                         GET  /api/fleet/needs-a-look
 *                                         GET  /api/fleet/nodes/:id/needs-a-look
 *
 * Invariants a silent regression would break without a unit test noticing:
 *   - the beat that carries `health` is accepted (never a 400 — a 400 is a node
 *     swept offline), and a nonsense value in it is DROPPED, not stored;
 *   - the stored snapshot is stamped with the PLATFORM's receipt time;
 *   - an older daemon's beat (no `health`) leaves the stored snapshot alone;
 *   - a stranger reads neither the snapshot nor the items (404).
 *
 * The computer page that renders these lands with FL-01; this spec drives the
 * contract the page reads.
 */

const GIB = 1024 ** 3;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrolledNode(request: APIRequestContext, ownerToken: string) {
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(ownerToken),
        data: { name: `build-${uniq()}`, kind: 'node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token, node } = (await minted.json()) as { token: string; node: { id: string } };
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: {
            token,
            platform: 'linux/x64',
            version: '0.3.0',
            capabilities: ['terminal', 'workspace'],
        },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    const { nodeId, secret } = (await enrolled.json()) as { nodeId: string; secret: string };
    expect(nodeId).toBe(node.id);
    return { nodeId, secret };
}

async function beat(
    request: APIRequestContext,
    nodeId: string,
    secret: string,
    extra: Record<string, unknown>,
) {
    const res = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
        data: {
            nodeId,
            secret,
            platform: 'linux/x64',
            version: '0.3.0',
            capabilities: ['terminal'],
            ...extra,
        },
    });
    expect(res.status(), `heartbeat body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('computer health — the snapshot on the heartbeat (FR-1 … FR-5)', () => {
    test('a beat with a snapshot is stored with the platform’s receipt time and read back by the owner', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        const before = Date.now();
        await beat(request, nodeId, secret, {
            health: {
                cpuPercent: 31.2,
                memPercent: 58,
                memTotalMiB: 16384,
                memUsedMiB: 9523,
                diskPercent: 40,
                diskFreeMiB: 120832,
                diskTotalMiB: 201390,
                loadAvg1: 1.93,
                cpuCores: 4,
                uptimeSec: 273600,
                gpu: null,
                pendingReboot: false,
                failedServices: 1,
            },
        });

        const res = await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBe(200);
        const view = await res.json();
        expect(view).toMatchObject({
            nodeId,
            stale: false,
            snapshot: { cpuPercent: 31.2, cpuCores: 4, gpu: null, failedServices: 1 },
            state: { state: 'online' },
        });
        expect(Date.parse(view.snapshot.at)).toBeGreaterThanOrEqual(before - 5_000);
        expect(typeof view.historyEnabled).toBe('boolean');
    });

    test('a nonsense value is dropped, never stored — and never fails the beat', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, {
            health: { cpuPercent: 250, memPercent: 40, hostname: 'x' },
        });
        const view = await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json();
        expect(view.snapshot.memPercent).toBe(40);
        expect(view.snapshot).not.toHaveProperty('cpuPercent');
        expect(view.snapshot).not.toHaveProperty('hostname');
    });

    test('an older daemon’s beat (no snapshot) leaves the stored one alone', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, { health: { cpuPercent: 12 } });
        await beat(request, nodeId, secret, {});
        const view = await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json();
        expect(view.snapshot.cpuPercent).toBe(12);
    });

    test('a node that never reported a snapshot reads as none', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId } = await enrolledNode(request, owner.access_token);
        const view = await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/health`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json();
        expect(view.snapshot).toBeNull();
    });
});

test.describe('needs a look — the FL-03 producers (FR-12 … FR-17)', () => {
    test('a disk within 1 GiB of the node’s own floor is critical, with a stable id and an Open action', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, {
            diskFreeBytes: 6 * GIB,
            minFreeDiskBytes: 5 * GIB,
            health: { diskPercent: 94, diskFreeMiB: 6 * 1024, diskTotalMiB: 100 * 1024 },
        });
        const first = (await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/needs-a-look`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as Array<Record<string, unknown>>;
        const item = first.find((entry) => entry.kind === 'disk-low');
        expect(item).toMatchObject({
            id: `disk-low:${nodeId}`,
            severity: 'critical',
            title: 'Disk is 94% full · 6 GiB left, the node stops at 5 GiB',
            action: { route: `/fleet/computers/${nodeId}?tab=overview` },
        });

        // A second low beat keeps the same `since`: the item is stable.
        await beat(request, nodeId, secret, {
            diskFreeBytes: 6 * GIB,
            minFreeDiskBytes: 5 * GIB,
            health: { diskPercent: 94, diskFreeMiB: 6 * 1024, diskTotalMiB: 100 * 1024 },
        });
        const fleetWide = (await (
            await request.get(`${API_BASE}/api/fleet/needs-a-look`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as Array<Record<string, unknown>>;
        expect(fleetWide.find((entry) => entry.id === `disk-low:${nodeId}`)?.since).toBe(
            item?.since,
        );
    });

    test('a quarantined node is critical with the exact machine command — never a button that pretends to clear it', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { nodeId, secret } = await enrolledNode(request, owner.access_token);
        await beat(request, nodeId, secret, {
            workerState: 'quarantined',
            workerStateReason: 'process tree unproven',
        });
        const items = (await (
            await request.get(`${API_BASE}/api/fleet/nodes/${nodeId}/needs-a-look`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as Array<Record<string, unknown>>;
        const quarantined = items.find((entry) => entry.kind === 'node-quarantined');
        // Quarantine is cleared only at the machine's keyboard: the command is
        // in the sentence, and the action opens the computer page (where it
        // has a copy button) — it never runs anything.
        expect(quarantined).toMatchObject({
            severity: 'critical',
            action: { route: `/fleet/computers/${nodeId}?tab=overview` },
        });
        expect(quarantined?.detail).toContain(
            'ever-works-node clear-quarantine --confirm-process-tree-stopped',
        );
        expect(quarantined?.action).not.toHaveProperty('command');
    });

    test('a stranger reads neither the snapshot nor the items', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { nodeId } = await enrolledNode(request, owner.access_token);
        for (const path of [
            `/api/fleet/nodes/${nodeId}/health`,
            `/api/fleet/nodes/${nodeId}/needs-a-look`,
        ]) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(stranger.access_token),
            });
            expect(res.status(), path).toBe(404);
        }
    });
});
