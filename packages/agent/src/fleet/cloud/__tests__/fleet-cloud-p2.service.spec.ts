import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { buildFleetCloudTools } from '../agent-fleet-cloud-tools';
import { cloudIdleItems } from '../cloud-idle.producer';
import { FleetCloudService, usageOf } from '../fleet-cloud.service';
import { fleetCloudViewOf } from '../fleet-cloud.view';

/**
 * Cloud computers (FL-17 P2, T-23 – T-27, plan §14) — the cost job and the
 * idle policy against in-memory doubles: the cost snapshot is written once
 * per window (compare-and-set on `computedAt`) with the provider's own
 * month-to-date figure; the usage block counts machines destroyed this month
 * and never shows another owner's account figure; "tell me" raises exactly
 * one notice per idle window; "power off" powers off, audits with the policy
 * as requester and never destroys; a working session closes the window; a
 * policy change is validated, audited and restarts the window; the Agent tool
 * holds the change for the owner.
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const OTHER = '9e2d1b63-4b9f-4d66-8c8e-3f9d1c2b0f12';
const PLUGIN = 'machines-plugin';
const NODE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-21T12:00:00.000Z');

interface Row {
    id: string;
    userId: string;
    name: string;
    origin: string;
    status: string;
    organizationId?: string | null;
    providerPluginId?: string | null;
    providerMachineRef?: string | null;
    providerMeta?: Record<string, unknown> | null;
    health?: Record<string, unknown> | null;
    [key: string]: unknown;
}

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        providerName: 'Provider',
        regionId: 'fra1',
        regionLabel: 'Frankfurt 1',
        sizeId: 's-4',
        sizeLabel: '4 CPU',
        vcpus: 4,
        memoryMiB: 8192,
        diskGiB: 160,
        hourlyRateCents: 7.1,
        monthlyPriceCents: 4800,
        currency: 'USD',
        billsWhileOff: true,
        createdAt: '2026-10-20T00:00:00.000Z',
        machineCreatedAt: '2026-10-20T00:00:00.000Z',
        phase: 'online',
        phaseAt: '2026-10-20T00:05:00.000Z',
        powerState: 'running',
        powerStateAt: '2026-10-20T00:05:00.000Z',
        pending: null,
        powerTimeline: [{ state: 'running', at: '2026-10-20T00:00:00.000Z' }],
        error: null,
        idlePolicy: { mode: 'tell-me', afterHours: 3 },
        idleSince: null,
        software: [],
        tags: ['ever-works'],
        ...overrides,
    };
}

function cloudRow(overrides: Partial<Row> = {}, metaOverrides: Record<string, unknown> = {}): Row {
    return {
        id: NODE,
        userId: OWNER,
        name: 'fra-nina',
        origin: 'cloud',
        status: 'online',
        organizationId: null,
        providerPluginId: PLUGIN,
        providerMachineRef: '4242',
        providerMeta: meta(metaOverrides),
        health: null,
        ...overrides,
    };
}

function harness(opts: { existing?: Row[]; liveSessions?: Array<{ state: string }>; cpu?: number[]; destroyed?: unknown[] } = {}) {
    const rows = new Map<string, Row>((opts.existing ?? []).map((row) => [row.id, row]));
    const nodes = {
        findByUser: jest.fn(async (userId: string) => [...rows.values()].filter((row) => row.userId === userId)),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        findCloudNodes: jest.fn(async () => [...rows.values()].filter((row) => row.origin === 'cloud')),
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
        power: jest.fn(async () => undefined),
        destroy: jest.fn(async () => undefined),
        usage: jest.fn(async () => ({ providerMonthToDateCents: 1234, source: 'provider' })),
        getMachine: jest.fn(async (_p: string, _u: string, ref: string) => ({ machineRef: ref, state: 'running' as const })),
    };
    const audit = {
        tryRecord: jest.fn(async () => true),
        forOwnerActionSince: jest.fn(async () => opts.destroyed ?? []),
    };
    const sessions = { findLiveForNode: jest.fn(async () => opts.liveSessions ?? []) };
    const jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
    const healthSamples = {
        series: jest.fn(async () => (opts.cpu ?? [1.2]).map((cpuPercent) => ({ cpuPercent }))),
    };
    const inbox = { notice: jest.fn(async () => undefined) };
    const fleet = { viewForRole: jest.fn((node: Row) => ({ id: node.id, name: node.name })) };
    const service = new FleetCloudService(
        nodes as never,
        fleet as never,
        machines as never,
        undefined,
        undefined,
        audit as never,
        jobs as never,
        sessions as never,
        healthSamples as never,
        inbox as never,
    );
    return { service, rows, nodes, machines, audit, inbox, healthSamples };
}

const caller = { kind: 'user' as const, userId: OWNER };

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetMachineError(error);
    }
    throw new Error('expected a refusal');
}

function auditCalls(audit: { tryRecord: jest.Mock }) {
    return (audit.tryRecord.mock.calls as unknown[][]).map(
        ([entry]) => entry as { action: string; actorUserId: string | null; details: Record<string, unknown> },
    );
}

function storedMeta(rows: Map<string, Row>, id = NODE): Record<string, unknown> {
    return rows.get(id)!.providerMeta as Record<string, unknown>;
}

describe('FleetCloudService P2 — cost and idle (FL-17)', () => {
    const env = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_CLOUD_ENABLED = 'true';
    });
    afterEach(() => {
        process.env = { ...env };
    });

    describe('the cost job (T-23, FR-21, FR-23)', () => {
        it('writes the snapshot with the provider’s own month-to-date, once per provider and owner', async () => {
            const second = cloudRow({ id: '1a2b3c4d-0000-4000-8000-000000000002', name: 'nyc-ops', providerMachineRef: '4343' });
            const { service, rows, machines } = harness({ existing: [cloudRow(), second] });
            await expect(service.refreshUsage(T0)).resolves.toEqual({ machines: 2, changed: 2 });
            expect(machines.usage).toHaveBeenCalledTimes(1);
            expect(machines.usage).toHaveBeenCalledWith(PLUGIN, OWNER, ['4242', '4343']);
            const cost = storedMeta(rows).cost as Record<string, unknown>;
            expect(cost.computedAt).toBe(new Date(T0).toISOString());
            expect(cost.providerMonthToDateCents).toBe(1234);
            expect(cost.sinceCreatedCents).toBeCloseTo(36 * 7.1, 1);
        });

        it('leaves a fresh snapshot alone, so two overlapping fires write once (CAS on computedAt)', async () => {
            const { service, nodes } = harness({ existing: [cloudRow()] });
            await service.refreshUsage(T0);
            const writes = nodes.update.mock.calls.length;
            await expect(service.refreshUsage(T0 + 60_000)).resolves.toEqual({ machines: 1, changed: 0 });
            expect(nodes.update.mock.calls.length).toBe(writes);
            await expect(service.refreshUsage(T0 + 10 * 60_000)).resolves.toEqual({ machines: 1, changed: 1 });
        });

        it('does not write over a snapshot another pass wrote after this one read the row', async () => {
            const { service, rows, nodes } = harness({ existing: [cloudRow()] });
            const original = nodes.findById.getMockImplementation()!;
            nodes.findById.mockImplementationOnce(async (id: string) => {
                // Another pass wrote between this pass's list read and its write.
                const row = rows.get(id)!;
                rows.set(id, {
                    ...row,
                    providerMeta: { ...(row.providerMeta as object), cost: { computedAt: new Date(T0 - 1000).toISOString() } },
                });
                return original(id);
            });
            await expect(service.refreshUsage(T0)).resolves.toEqual({ machines: 1, changed: 0 });
        });

        it('is dark while FLEET_CLOUD_ENABLED is off', async () => {
            process.env.FLEET_CLOUD_ENABLED = 'false';
            const { service, machines } = harness({ existing: [cloudRow()] });
            await expect(service.refreshUsage(T0)).resolves.toEqual({ machines: 0, changed: 0 });
            await expect(service.evaluateIdle(T0)).resolves.toEqual({ machines: 0, acted: 0 });
            expect(machines.usage).not.toHaveBeenCalled();
        });
    });

    describe('the usage block (T-25, FR-22, FR-23, FR-24)', () => {
        it('counts machines destroyed this month, and carries the owner’s provider figure', async () => {
            const destroyed = [
                {
                    nodeId: 'gone-1',
                    occurredAt: '2026-10-12T09:00:00.000Z',
                    details: {
                        outcome: 'ok',
                        targetName: 'build-tmp',
                        providerName: 'Provider',
                        regionId: 'nyc3',
                        sizeLabel: '2 CPU',
                        monthToDateCents: 312,
                        finalCostCents: 312,
                    },
                },
                { nodeId: 'refused', occurredAt: '2026-10-12T09:00:00.000Z', details: { outcome: 'refused' } },
            ];
            const row = cloudRow({}, { cost: { providerMonthToDateCents: 5000, computedAt: new Date(T0).toISOString() } });
            const { service } = harness({ existing: [row], destroyed });
            const usage = await service.usageSummary(OWNER, T0);
            expect(usage.estimate).toBe(true);
            expect(usage.machines.map((machine) => machine.name)).toEqual(['fra-nina', 'build-tmp']);
            const live = usage.machines[0].monthToDateCents;
            expect(usage.monthToDateCents).toBeCloseTo(live + 312, 2);
            expect(usage.machines[1]).toMatchObject({ state: 'gone', destroyedAt: '2026-10-12T09:00:00.000Z', hourlyCents: 0 });
            expect(usage.providerMonthToDate).toEqual([
                { providerPluginId: PLUGIN, providerName: 'Provider', monthToDateCents: 5000, computedAt: new Date(T0).toISOString() },
            ]);
        });

        it('never shows another owner’s account-wide figure on a shared machine', () => {
            const shared = cloudRow(
                { userId: OTHER },
                { cost: { providerMonthToDateCents: 9999, computedAt: new Date(T0).toISOString() } },
            );
            expect(usageOf([shared as never], T0, [], OWNER).providerMonthToDate).toEqual([]);
            expect(usageOf([shared as never], T0, [], OTHER).providerMonthToDate).toHaveLength(1);
        });
    });

    describe('the idle job (T-24, FR-25 – FR-28)', () => {
        it('opens a window, then tells the owner exactly once when it reaches the policy’s hours', async () => {
            const { service, rows, inbox, machines } = harness({ existing: [cloudRow()] });
            await expect(service.evaluateIdle(T0)).resolves.toEqual({ machines: 1, acted: 0 });
            expect(storedMeta(rows).idleSince).toBe(new Date(T0).toISOString());

            await expect(service.evaluateIdle(T0 + 3 * HOUR)).resolves.toEqual({ machines: 1, acted: 1 });
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice).toHaveBeenCalledWith(
                OWNER,
                expect.objectContaining({ title: 'fra-nina has been idle for 3 h', organizationId: null }),
            );
            expect(storedMeta(rows).idleNotifiedKey).toBe(`fleet-node:${NODE}:cloud-idle:${new Date(T0).toISOString()}`);

            // The same window never notifies twice (FR-27).
            await expect(service.evaluateIdle(T0 + 3 * HOUR + 10 * 60_000)).resolves.toEqual({ machines: 1, acted: 0 });
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(machines.power).not.toHaveBeenCalled();
            expect(machines.destroy).not.toHaveBeenCalled();
        });

        it('raises the idle item on read once the window is reached, keyed on the window', async () => {
            const { service, rows } = harness({ existing: [cloudRow()] });
            await service.evaluateIdle(T0);
            const view = fleetCloudViewOf(rows.get(NODE) as never, T0 + 4 * HOUR)!;
            const items = cloudIdleItems([{ id: NODE, name: 'fra-nina', status: 'online', cloud: view } as never], {
                now: new Date(T0 + 4 * HOUR),
            });
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                id: `cloud-idle:${NODE}:idle:${new Date(T0).toISOString()}`,
                kind: 'cloud-idle',
                action: { label: 'Power off…' },
            });
            expect(items[0].title).toMatch(/^fra-nina has been idle for 4 h · \$0\.28 while idle$/);
        });

        it('powers off when told, audits with the policy as requester, and never destroys (S7, FR-28)', async () => {
            const since = new Date(T0 - 2 * HOUR).toISOString();
            const row = cloudRow({}, { idlePolicy: { mode: 'power-off', afterHours: 2 }, idleSince: since });
            const { service, rows, machines, audit, inbox } = harness({ existing: [row] });
            await expect(service.evaluateIdle(T0)).resolves.toEqual({ machines: 1, acted: 1 });
            expect(machines.power).toHaveBeenCalledWith(PLUGIN, OWNER, '4242', 'off');
            expect(machines.destroy).not.toHaveBeenCalled();
            const stored = storedMeta(rows);
            expect(stored.pending).toBe('powering-off');
            expect(stored.poweredOffByPolicyAt).toBe(new Date(T0).toISOString());
            const entry = auditCalls(audit).find((call) => call.action === 'node.cloud.power');
            expect(entry).toMatchObject({ actorUserId: null });
            expect(entry?.details).toMatchObject({ requestedBy: 'system:idle-policy', outcome: 'ok', action: 'off', family: 'machines' });
            expect(inbox.notice).toHaveBeenCalledWith(
                OWNER,
                expect.objectContaining({ title: 'fra-nina was powered off after 2 h idle' }),
            );

            // The next pass sees the pending power-off: never a second power-off for this window.
            await service.evaluateIdle(T0 + 10 * 60_000);
            expect(machines.power).toHaveBeenCalledTimes(1);

            // Once off, the item reads "powered off after 2 h idle — it still bills while off".
            rows.set(NODE, { ...rows.get(NODE)!, providerMeta: { ...storedMeta(rows), pending: null, powerState: 'off' } });
            const view = fleetCloudViewOf(rows.get(NODE) as never, T0 + HOUR)!;
            const items = cloudIdleItems([{ id: NODE, name: 'fra-nina', status: 'online', cloud: view } as never], {
                now: new Date(T0 + HOUR),
            });
            expect(items.map((item) => item.title)).toEqual(['fra-nina was powered off after 2 h idle — it still bills while off']);
            expect(items[0].action?.route).toContain('cloud=power-on');
        });

        it('a working session, a running job or a busy CPU sample closes the window', async () => {
            const since = new Date(T0 - 5 * HOUR).toISOString();
            for (const evidence of [
                { liveSessions: [{ state: 'working' }] },
                { liveSessions: [{ state: 'needs_you' }] },
                { cpu: [1, 7.5] },
            ]) {
                const { service, rows, inbox } = harness({ existing: [cloudRow({}, { idleSince: since })], ...evidence });
                await expect(service.evaluateIdle(T0)).resolves.toEqual({ machines: 1, acted: 0 });
                expect(storedMeta(rows).idleSince).toBeNull();
                expect(inbox.notice).not.toHaveBeenCalled();
            }
            // An idle session does not keep the machine busy.
            const quiet = harness({ existing: [cloudRow({}, { idleSince: since })], liveSessions: [{ state: 'idle' }] });
            await expect(quiet.service.evaluateIdle(T0)).resolves.toEqual({ machines: 1, acted: 1 });
        });

        it('never counts a powered-off or still-enrolling machine as idle (FR-26, U11)', async () => {
            const since = new Date(T0 - 5 * HOUR).toISOString();
            const off = harness({ existing: [cloudRow({}, { idleSince: since, powerState: 'off' })] });
            await off.service.evaluateIdle(T0);
            expect(off.inbox.notice).not.toHaveBeenCalled();
            const enrolling = harness({ existing: [cloudRow({ status: 'enrolling' }, { idleSince: since })] });
            await enrolling.service.evaluateIdle(T0);
            expect(enrolling.inbox.notice).not.toHaveBeenCalled();
        });

        it('reads only the samples since the last pass, never before the window opened', async () => {
            const since = new Date(T0 - 5 * HOUR).toISOString();
            const { service, healthSamples } = harness({ existing: [cloudRow({}, { idleSince: since })] });
            await service.evaluateIdle(T0);
            const [, resolution, from] = healthSamples.series.mock.calls[0] as unknown as [string, string, Date];
            expect(resolution).toBe('raw');
            expect(from.toISOString()).toBe(new Date(T0 - 20 * 60_000).toISOString());
        });
    });

    describe('the policy change (T-25, FR-25)', () => {
        it('refuses hours outside 1–72 and an unknown mode, naming the field', async () => {
            const { service } = harness({ existing: [cloudRow()] });
            expect((await refusal(service.setIdlePolicy(caller, NODE, { mode: 'tell-me', afterHours: 0 })))?.details).toMatchObject({
                field: 'afterHours',
            });
            expect((await refusal(service.setIdlePolicy(caller, NODE, { mode: 'tell-me', afterHours: 73 })))?.code).toBe('invalid');
            expect((await refusal(service.setIdlePolicy(caller, NODE, { mode: 'tell-me', afterHours: 2.5 })))?.code).toBe('invalid');
            expect(
                (await refusal(service.setIdlePolicy(caller, NODE, { mode: 'destroy' as never, afterHours: 2 })))?.details,
            ).toMatchObject({ field: 'mode' });
        });

        it('saves, audits node.policy.change with from and to, and restarts the window', async () => {
            const row = cloudRow({}, { idleSince: new Date(T0 - 5 * HOUR).toISOString(), idleNotifiedKey: 'k' });
            const { service, rows, audit } = harness({ existing: [row] });
            await service.setIdlePolicy(caller, NODE, { mode: 'power-off', afterHours: 1 });
            expect(storedMeta(rows)).toMatchObject({
                idlePolicy: { mode: 'power-off', afterHours: 1 },
                idleSince: null,
                idleNotifiedKey: null,
            });
            const entry = auditCalls(audit).find((call) => call.action === 'node.policy.change');
            expect(entry?.details).toMatchObject({
                policy: 'idle',
                from: { mode: 'tell-me', afterHours: 3 },
                to: { mode: 'power-off', afterHours: 1 },
                confirmationClass: 'plain',
                outcome: 'ok',
            });
        });

        it('refuses a caller outside the machine’s audience as not found', async () => {
            const { service } = harness({ existing: [cloudRow({ userId: OTHER })] });
            expect((await refusal(service.setIdlePolicy(caller, NODE, { mode: 'nothing', afterHours: 3 })))?.code).toBe('not_found');
        });

        it('"Keep running" starts the window again now', async () => {
            const row = cloudRow({}, { idleSince: new Date(T0 - 5 * HOUR).toISOString() });
            const { service, rows, audit } = harness({ existing: [row] });
            await service.keepRunning(caller, NODE);
            const restarted = Date.parse(String(storedMeta(rows).idleSince));
            expect(restarted).toBeGreaterThan(T0 - HOUR);
            expect(auditCalls(audit).some((call) => call.details.act === 'keep-running')).toBe(true);
        });
    });

    describe('the Agent tool (T-27)', () => {
        it('holds an idle-policy change for the owner, titled with the change', async () => {
            const { service, rows } = harness({ existing: [cloudRow()] });
            const proposals = { propose: jest.fn(async () => ({ id: 'p-1', status: 'pending' })) };
            const tools = buildFleetCloudTools({
                userId: OWNER,
                agentId: 'agent-1',
                runId: null,
                service: service as never,
                proposals: proposals as never,
            });
            const tool = tools.find((entry) => entry.name === 'fleet_cloud_idle_policy')!;
            expect(tool).toBeDefined();
            const out = (await tool.invoke({ nodeId: NODE, mode: 'power-off', afterHours: 2 })) as Record<string, unknown>;
            expect(out).toMatchObject({ held: true, decisionId: 'p-1' });
            const [, proposal] = proposals.propose.mock.calls[0] as unknown as [string, { title: string; payload: Record<string, unknown> }];
            expect(proposal.title).toBe(
                "Change fra-nina's idle policy from Tell me after 3 h to Power off after 2 h. Ever Works never destroys a cloud computer on its own.",
            );
            expect(proposal.payload).toMatchObject({ verb: 'idle-policy', nodeId: NODE, args: { mode: 'power-off', afterHours: 2 } });
            // Nothing was written by the Agent itself.
            expect(storedMeta(rows).idlePolicy).toEqual({ mode: 'tell-me', afterHours: 3 });

            const bad = (await tool.invoke({ nodeId: NODE, mode: 'tell-me', afterHours: 99 })) as Record<string, unknown>;
            expect((bad.error as { code: string }).code).toBe('invalid');
        });
    });
});
