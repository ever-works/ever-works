import { MachineProviderError } from '@ever-works/plugin';
import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { FleetCloudService } from '../fleet-cloud.service';
import { fleetCloudRemovableNode } from '../fleet-cloud.view';

/**
 * Cloud computers (FL-17, T-12, T-14, plan §14) — the service against
 * in-memory doubles: the row exists before the provider is asked; a provider
 * refusal marks it `failed` with the provider's first line; a stale price is
 * `invalid` with the current one; the kill-switch matrix (create / power-on
 * refused, power-off / destroy allowed); the limit; the busy guard; audit rows
 * carry prices, never a token; the R-36 rule.
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const PLUGIN = 'machines-plugin';

const OPTIONS = {
    regions: [{ id: 'nyc3', label: 'New York 3', available: true }],
    sizes: [
        {
            id: 's-2',
            label: '2 CPU · 4 GB · 80 GB',
            vcpus: 2,
            memoryMiB: 4096,
            diskGiB: 80,
            priceHourlyCents: 3.571,
            priceMonthlyCents: 2400,
            regions: ['nyc3'],
            available: true,
        },
    ],
    software: [],
    billsWhileOff: true,
    currency: 'USD',
    account: { label: 'acme' },
};

interface Row {
    id: string;
    userId: string;
    name: string;
    origin: string;
    status: string;
    providerPluginId?: string | null;
    providerMachineRef?: string | null;
    providerMeta?: Record<string, unknown> | null;
    enrollmentTokenHash?: string | null;
    [key: string]: unknown;
}

function harness(opts: { stopped?: boolean; liveSessions?: number; existing?: Row[] } = {}) {
    const rows = new Map<string, Row>((opts.existing ?? []).map((row) => [row.id, row]));
    let seq = 0;
    const order: string[] = [];
    const nodes = {
        findByUser: jest.fn(async (userId: string) => [...rows.values()].filter((row) => row.userId === userId)),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        findCloudNodes: jest.fn(async () => [...rows.values()].filter((row) => row.origin === 'cloud')),
        create: jest.fn(async (data: Partial<Row>) => {
            seq += 1;
            const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
            const row = { ...data, id } as Row;
            rows.set(id, row);
            order.push('row');
            return row;
        }),
        update: jest.fn(async (id: string, patch: Partial<Row>) => {
            const row = rows.get(id);
            if (row) rows.set(id, { ...row, ...patch });
        }),
        delete: jest.fn(async (id: string) => {
            rows.delete(id);
        }),
    };
    const machines = {
        listProviders: jest.fn(async () => []),
        providerName: jest.fn(async () => 'Provider'),
        listOptions: jest.fn(async () => OPTIONS),
        create: jest.fn(async () => {
            order.push('provider');
            return { machineRef: '4242', state: 'provisioning' as const };
        }),
        power: jest.fn(async () => undefined),
        destroy: jest.fn(async () => undefined),
        getMachine: jest.fn(async (_p: string, _u: string, ref: string) => ({ machineRef: ref, state: 'running' as const })),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const killSwitch = { isStopped: jest.fn(async () => Boolean(opts.stopped)) };
    const sessions = { findLiveForNode: jest.fn(async () => Array.from({ length: opts.liveSessions ?? 0 }, () => ({}))) };
    const jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
    const fleet = { viewForRole: jest.fn((node: Row) => ({ id: node.id, name: node.name })) };
    const service = new FleetCloudService(
        nodes as never,
        fleet as never,
        machines as never,
        undefined,
        killSwitch as never,
        audit as never,
        jobs as never,
        sessions as never,
    );
    return { service, rows, nodes, machines, audit, order, killSwitch };
}

const caller = { kind: 'user' as const, userId: OWNER };

const request = {
    providerPluginId: PLUGIN,
    name: 'nyc-ops',
    regionId: 'nyc3',
    sizeId: 's-2',
    acknowledgedPriceCents: 2400,
};

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetMachineError(error);
    }
    throw new Error('expected a refusal');
}

function cloudRow(overrides: Partial<Row> = {}): Row {
    return {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        userId: OWNER,
        name: 'nyc-ops',
        origin: 'cloud',
        status: 'online',
        providerPluginId: PLUGIN,
        providerMachineRef: '4242',
        providerMeta: {
            providerName: 'Provider',
            regionId: 'nyc3',
            regionLabel: 'New York 3',
            sizeId: 's-2',
            sizeLabel: '2 CPU',
            vcpus: 2,
            memoryMiB: 4096,
            diskGiB: 80,
            hourlyRateCents: 3.6,
            monthlyPriceCents: 2400,
            currency: 'USD',
            billsWhileOff: true,
            createdAt: '2026-10-21T00:00:00.000Z',
            machineCreatedAt: '2026-10-21T00:00:00.000Z',
            phase: 'online',
            phaseAt: '2026-10-21T00:05:00.000Z',
            powerState: 'running',
            powerStateAt: '2026-10-21T00:05:00.000Z',
            pending: null,
            powerTimeline: [{ state: 'running', at: '2026-10-21T00:00:00.000Z' }],
            error: null,
            idlePolicy: { mode: 'tell-me', afterHours: 3 },
            software: [],
            tags: ['ever-works'],
        },
        ...overrides,
    };
}

describe('FleetCloudService (FL-17)', () => {
    const env = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_CLOUD_ENABLED = 'true';
        process.env.FLEET_NODE_API_URL = 'https://api.example.com';
    });
    afterEach(() => {
        process.env = { ...env };
    });

    it('answers confirmation_required with the price sentence, and writes nothing', async () => {
        const { service, nodes, machines } = harness();
        const error = await refusal(service.create(caller, { ...request, fields: {} }));
        expect(error?.code).toBe('confirmation_required');
        expect(String(error?.details?.summary)).toContain('$24/month');
        expect(String(error?.details?.decision)).toContain('2 CPU · 4 GB cloud computer at Provider (nyc3)');
        expect(nodes.create).not.toHaveBeenCalled();
        expect(machines.create).not.toHaveBeenCalled();
    });

    it('writes the row first, then asks the provider, and records the machine', async () => {
        const { service, rows, order, machines, audit } = harness();
        const created = await service.create(caller, { ...request, fields: { confirm: true } });
        await settle();
        expect(order).toEqual(['row', 'provider']);
        const row = rows.get(created.nodeId)!;
        expect(row.origin).toBe('cloud');
        expect(row.status).toBe('enrolling');
        expect(row.providerMachineRef).toBe('4242');
        expect((row.providerMeta as { phase: string }).phase).toBe('booting');
        const input = (machines.create.mock.calls[0] as unknown[])[2] as { bootstrapScript: string; tags: string[]; publicKey: string };
        // The two P1 tags, then (P3, FR-30) this deployment's site tag.
        expect(input.tags.slice(0, 2)).toEqual(['ever-works', `ever-works-node:${created.nodeId}`]);
        expect(input.tags[2]).toMatch(/^ever-works-site:[0-9a-f]{16}$/);
        expect(input.tags).toHaveLength(3);
        expect(input.bootstrapScript.startsWith('#cloud-config')).toBe(true);
        expect(input.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
        // The token is only in the bootstrap; neither the row nor any audit row carries it.
        const token = /content: '([A-Za-z0-9_-]{20,})'/.exec(input.bootstrapScript)?.[1];
        expect(token).toBeTruthy();
        expect(JSON.stringify(row)).not.toContain(token);
        expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain(token);
        const createAudit = (audit.tryRecord.mock.calls as unknown[][]).find(
            ([entry]) => (entry as { action: string }).action === 'node.cloud.create',
        );
        expect((createAudit?.[0] as { details: Record<string, unknown> }).details).toMatchObject({
            family: 'machines',
            providerPluginId: PLUGIN,
            regionId: 'nyc3',
            sizeId: 's-2',
            hourlyRateCents: 3.571,
        });
    });

    it('marks the row failed with the provider’s first line when it refuses (U2)', async () => {
        const { service, rows, machines } = harness();
        machines.create.mockRejectedValueOnce(new MachineProviderError('quota', 'droplet limit reached for this account'));
        const created = await service.create(caller, { ...request, fields: { confirm: true } });
        await settle();
        const meta = rows.get(created.nodeId)!.providerMeta as { phase: string; error: string };
        expect(meta.phase).toBe('failed');
        expect(meta.error).toBe('Provider: droplet limit reached for this account');
        // Nothing exists at the provider: Remove is allowed (R-36, U2).
        expect(fleetCloudRemovableNode(rows.get(created.nodeId) as never)).toBe(true);
    });

    it('refuses a stale price with the current one (FR-4, U9)', async () => {
        const { service } = harness();
        const error = await refusal(service.create(caller, { ...request, acknowledgedPriceCents: 2200, fields: { confirm: true } }));
        expect(error?.code).toBe('invalid');
        expect(error?.details).toMatchObject({ field: 'acknowledgedPriceCents', currentPriceCents: 2400 });
    });

    it('refuses the eleventh cloud computer (FR-12)', async () => {
        const existing = Array.from({ length: 10 }, (_, i) =>
            cloudRow({ id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`, name: `box-${i}` }),
        );
        const { service } = harness({ existing });
        expect((await refusal(service.create(caller, { ...request, fields: { confirm: true } })))?.code).toBe('limit_exceeded');
    });

    it('applies the kill-switch matrix: create and power-on refused, power-off and destroy allowed (R-36)', async () => {
        const offRow = cloudRow({ providerMeta: { ...cloudRow().providerMeta!, powerState: 'off' } });
        const { service, machines } = harness({ stopped: true, existing: [offRow] });
        expect((await refusal(service.create(caller, { ...request, fields: { confirm: true } })))?.code).toBe('kill_switch');
        expect((await refusal(service.power(caller, offRow.id, 'on', { confirm: true })))?.code).toBe('kill_switch');

        const running = cloudRow();
        const second = harness({ stopped: true, existing: [running] });
        await expect(second.service.power(caller, running.id, 'off', { confirm: true })).resolves.toEqual({ operationId: running.id });
        expect(second.machines.power).toHaveBeenCalledWith(PLUGIN, OWNER, '4242', 'off');
        await second.service.destroy(caller, running.id, { confirmName: 'nyc-ops' });
        expect(second.machines.destroy).toHaveBeenCalled();
        expect(machines.power).not.toHaveBeenCalled();
    });

    it('says the provider still bills a powered-off machine before power-off (FR-16)', async () => {
        const row = cloudRow();
        const { service } = harness({ existing: [row] });
        const error = await refusal(service.power(caller, row.id, 'off', {}));
        expect(error?.code).toBe('confirmation_required');
        expect(String(error?.details?.summary)).toContain('still bills this size while it is off');
    });

    it('refuses destroy while a session is live, before asking for the name (FR-20)', async () => {
        const row = cloudRow();
        const { service, machines } = harness({ existing: [row], liveSessions: 1 });
        expect((await refusal(service.destroy(caller, row.id, {})))?.code).toBe('busy');
        expect(machines.destroy).not.toHaveBeenCalled();
    });

    it('destroys: states the cost so far, deletes at the provider, removes the row, audits the final cost (FR-18)', async () => {
        const row = cloudRow();
        const { service, rows, machines, audit } = harness({ existing: [row] });
        const ask = await refusal(service.destroy(caller, row.id, {}));
        expect(ask?.code).toBe('confirmation_required');
        expect(String(ask?.details?.summary)).toMatch(/^Destroy nyc-ops\? It has cost \$[0-9.]+ since 2026-10-21\./);
        const done = await service.destroy(caller, row.id, { confirmName: 'nyc-ops' });
        expect(machines.destroy).toHaveBeenCalledWith(PLUGIN, OWNER, '4242');
        expect(rows.has(row.id)).toBe(false);
        expect(typeof done.costSoFarCents).toBe('number');
        const entry = (audit.tryRecord.mock.calls as unknown[][])
            .map(([call]) => call as { action: string; details: Record<string, unknown> })
            .find((call) => call.action === 'node.cloud.destroy' && call.details.outcome === 'ok');
        expect(entry?.details.finalCostCents).toBe(done.costSoFarCents);
    });

    it('marks a machine the provider forgot as gone, which makes Remove available (FR-29, U6)', async () => {
        const row = cloudRow();
        const { service, rows, machines } = harness({ existing: [row] });
        machines.getMachine.mockResolvedValueOnce({ machineRef: '4242', state: 'gone' } as never);
        expect(fleetCloudRemovableNode(row as never)).toBe(false);
        await expect(service.reconcile()).resolves.toEqual({ machines: 1, changed: 1 });
        const updated = rows.get(row.id)!;
        expect((updated.providerMeta as { powerState: string }).powerState).toBe('gone');
        expect(fleetCloudRemovableNode(updated as never)).toBe(true);
    });

    it('is dark while FLEET_CLOUD_ENABLED is off', async () => {
        process.env.FLEET_CLOUD_ENABLED = 'false';
        const { service } = harness();
        expect((await refusal(service.create(caller, { ...request, fields: { confirm: true } })))?.code).toBe('not_found');
        await expect(service.reconcile()).resolves.toEqual({ machines: 0, changed: 0 });
    });
});
