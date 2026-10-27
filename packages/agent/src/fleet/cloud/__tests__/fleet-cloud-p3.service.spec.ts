import { createHash } from 'crypto';
import { MachineProviderFacadeService } from '../../../facades/machine-provider.facade';
import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { cloudIdleItems } from '../cloud-idle.producer';
import { FleetCloudService, unclaimedName } from '../fleet-cloud.service';
import { fleetCloudViewOf } from '../fleet-cloud.view';

/**
 * Cloud computers (FL-17 P3, T-28 – T-30, plan §14) against in-memory doubles:
 *
 *  - the overlay-VPN key (FR-32) reaches the first-boot script once, through a
 *    0600 file — never the row, an audit row or a refusal — and only when the
 *    preset is ticked and the operator configured the client;
 *  - every new machine carries this deployment's site tag;
 *  - reconciliation (FR-30, U7) repairs a row whose machine reference was
 *    never recorded, adopts an unclaimed machine of THIS deployment as a row
 *    (with the unclaimed item and Destroy), and never touches a machine
 *    without this deployment's site tag;
 *  - the facade hands a completed sign-in's token to the plugin as
 *    `oauthAccessToken`, and reads "Sign in" off the live plugin (FR-31).
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const PLUGIN = 'machines-plugin';
const API = 'https://api.example.com';
const SITE = createHash('sha256').update(API).digest('hex').slice(0, 16);
const VPN_KEY = 'tskey-auth-ABCDEFGH12345678';

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
    [key: string]: unknown;
}

function harness(opts: { existing?: Row[]; tagged?: unknown[]; audit?: unknown[] } = {}) {
    const rows = new Map<string, Row>((opts.existing ?? []).map((row) => [row.id, row]));
    let seq = 0;
    const nodes = {
        findByUser: jest.fn(async (userId: string) =>
            [...rows.values()].filter((row) => row.userId === userId),
        ),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        findCloudNodes: jest.fn(async () =>
            [...rows.values()].filter((row) => row.origin === 'cloud'),
        ),
        findByProviderMachine: jest.fn(
            async (pluginId: string, ref: string) =>
                [...rows.values()].find(
                    (row) => row.providerPluginId === pluginId && row.providerMachineRef === ref,
                ) ?? null,
        ),
        create: jest.fn(async (data: Partial<Row>) => {
            seq += 1;
            const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
            const row = { ...data, id } as Row;
            rows.set(id, row);
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
        create: jest.fn(async () => ({ machineRef: '4242', state: 'provisioning' as const })),
        power: jest.fn(async () => undefined),
        destroy: jest.fn(async () => undefined),
        getMachine: jest.fn(async (_p: string, _u: string, ref: string) => ({
            machineRef: ref,
            state: 'running' as const,
        })),
        listTagged: jest.fn(async () => opts.tagged ?? []),
    };
    const audit = {
        tryRecord: jest.fn(async () => true),
        forActionSince: jest.fn(async () => opts.audit ?? []),
    };
    const fleet = { viewForRole: jest.fn((node: Row) => ({ id: node.id, name: node.name })) };
    const service = new FleetCloudService(
        nodes as never,
        fleet as never,
        machines as never,
        undefined,
        undefined,
        audit as never,
    );
    return { service, rows, nodes, machines, audit };
}

const caller = { kind: 'user' as const, userId: OWNER };

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

const request = {
    providerPluginId: PLUGIN,
    name: 'nyc-ops',
    regionId: 'nyc3',
    sizeId: 's-2',
    acknowledgedPriceCents: 2400,
};

function rowWithoutMachine(overrides: Record<string, unknown> = {}): Row {
    return {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        userId: OWNER,
        name: 'nyc-ops',
        origin: 'cloud',
        status: 'enrolling',
        providerPluginId: PLUGIN,
        providerMachineRef: null,
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
            createdAt: '2026-10-26T00:00:00.000Z',
            machineCreatedAt: null,
            phase: 'failed',
            phaseAt: '2026-10-26T00:10:00.000Z',
            powerState: 'unknown',
            powerStateAt: '2026-10-26T00:00:00.000Z',
            pending: null,
            powerTimeline: [],
            error: 'Provider did not answer the create; no machine is known to exist',
            idlePolicy: { mode: 'tell-me', afterHours: 3 },
            software: [],
            tags: ['ever-works'],
            ...overrides,
        },
    };
}

describe('FleetCloudService P3 (FL-17)', () => {
    const env = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_CLOUD_ENABLED = 'true';
        process.env.FLEET_NODE_API_URL = API;
        delete process.env.FLEET_CLOUD_OVERLAY_VPN_INSTALL_URL;
        delete process.env.FLEET_CLOUD_OVERLAY_VPN_JOIN_COMMAND;
    });
    afterEach(() => {
        process.env = { ...env };
    });

    describe('the overlay-VPN key (T-29, FR-32)', () => {
        beforeEach(() => {
            process.env.FLEET_CLOUD_OVERLAY_VPN_INSTALL_URL = 'https://vpn.example.com/install.sh';
            process.env.FLEET_CLOUD_OVERLAY_VPN_JOIN_COMMAND =
                '/usr/bin/vpn up --auth-key-file={keyFile}';
        });

        it('goes into the first-boot script once, through the 0600 file, and nowhere else', async () => {
            const { service, rows, machines, audit } = harness();
            const created = await service.create(caller, {
                ...request,
                software: ['docker', 'overlay-vpn'],
                vpnAuthKey: VPN_KEY,
                fields: { confirm: true },
            });
            await settle();
            const input = (machines.create.mock.calls[0] as unknown[])[2] as {
                bootstrapScript: string;
            };
            expect(input.bootstrapScript.split(VPN_KEY)).toHaveLength(2);
            expect(input.bootstrapScript).toContain(
                '/usr/bin/vpn up --auth-key-file=/run/ever-works/overlay-vpn-key',
            );
            expect(JSON.stringify(rows.get(created.nodeId))).not.toContain(VPN_KEY);
            expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain(VPN_KEY);
            expect(JSON.stringify(created)).not.toContain(VPN_KEY);
        });

        it('installs the client without a key when none is given', async () => {
            const { service, machines } = harness();
            await service.create(caller, {
                ...request,
                software: ['overlay-vpn'],
                fields: { confirm: true },
            });
            await settle();
            const input = (machines.create.mock.calls[0] as unknown[])[2] as {
                bootstrapScript: string;
            };
            expect(input.bootstrapScript).toContain('https://vpn.example.com/install.sh');
            expect(input.bootstrapScript).not.toContain('overlay-vpn-key\n    permissions');
        });

        it('refuses a key without the preset, without a join command, or of the wrong shape — never quoting it', async () => {
            const { service, machines } = harness();
            const noPreset = await refusal(
                service.create(caller, {
                    ...request,
                    software: ['docker'],
                    vpnAuthKey: VPN_KEY,
                    fields: { confirm: true },
                }),
            );
            expect(noPreset?.code).toBe('invalid');
            expect(noPreset?.details).toMatchObject({ field: 'vpnAuthKey' });
            const badShape = await refusal(
                service.create(caller, {
                    ...request,
                    software: ['overlay-vpn'],
                    vpnAuthKey: 'has spaces; rm -rf /',
                    fields: { confirm: true },
                }),
            );
            expect(badShape?.code).toBe('invalid');
            expect(JSON.stringify(badShape)).not.toContain('rm -rf');
            delete process.env.FLEET_CLOUD_OVERLAY_VPN_JOIN_COMMAND;
            const noJoin = await refusal(
                service.create(caller, {
                    ...request,
                    software: ['overlay-vpn'],
                    vpnAuthKey: VPN_KEY,
                    fields: { confirm: true },
                }),
            );
            expect(noJoin?.code).toBe('invalid');
            expect(machines.create).not.toHaveBeenCalled();
        });
    });

    it('tags every new machine with this deployment’s site', async () => {
        const { service, machines } = harness();
        const created = await service.create(caller, { ...request, fields: { confirm: true } });
        await settle();
        const input = (machines.create.mock.calls[0] as unknown[])[2] as { tags: string[] };
        expect(input.tags).toEqual([
            'ever-works',
            `ever-works-node:${created.nodeId}`,
            `ever-works-site:${SITE}`,
        ]);
    });

    describe('reconciliation P3 (T-30, FR-30, U7)', () => {
        it('repairs a row whose machine reference was never recorded', async () => {
            const row = rowWithoutMachine();
            const { service, rows, audit } = harness({
                existing: [row],
                tagged: [
                    {
                        machineRef: '9001',
                        state: 'running',
                        tags: [
                            'ever-works',
                            `ever-works-node:${row.id}`,
                            `ever-works-site:${SITE}`,
                        ],
                        createdAt: '2026-10-26T00:02:00.000Z',
                    },
                ],
            });
            await expect(service.reconcile()).resolves.toMatchObject({ changed: 1 });
            const repaired = rows.get(row.id)!;
            expect(repaired.providerMachineRef).toBe('9001');
            expect(repaired.providerMeta).toMatchObject({
                phase: 'installing',
                error: null,
                powerState: 'running',
                machineCreatedAt: '2026-10-26T00:02:00.000Z',
            });
            const entry = (audit.tryRecord.mock.calls as unknown[][])
                .map(([call]) => call as { action: string; details: Record<string, unknown> })
                .find((call) => call.details.act === 'repaired');
            expect(entry).toMatchObject({
                action: 'node.cloud.create',
                details: { requestedBy: 'system:cloud-reconcile' },
            });
        });

        it('adopts an unclaimed machine of this deployment, priced from the options, with the unclaimed item', async () => {
            const { service, rows, machines } = harness({
                audit: [{ ownerUserId: OWNER, details: { providerPluginId: PLUGIN } }],
                tagged: [
                    {
                        machineRef: '7777',
                        state: 'running',
                        name: 'old-box',
                        regionId: 'nyc3',
                        sizeId: 's-2',
                        tags: [
                            'ever-works',
                            'ever-works-node:5d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e09',
                            `ever-works-site:${SITE}`,
                        ],
                        createdAt: '2026-10-20T00:00:00.000Z',
                    },
                ],
            });
            // The owner has no cloud row: found through the recent create audit row.
            await expect(service.reconcile()).resolves.toMatchObject({ changed: 1 });
            expect(machines.listTagged).toHaveBeenCalledWith(PLUGIN, OWNER, 'ever-works');
            const adopted = [...rows.values()][0];
            expect(adopted).toMatchObject({
                userId: OWNER,
                name: 'old-box',
                origin: 'cloud',
                status: 'offline',
                providerPluginId: PLUGIN,
                providerMachineRef: '7777',
            });
            expect(adopted.providerMeta).toMatchObject({
                hourlyRateCents: 3.571,
                monthlyPriceCents: 2400,
                idlePolicy: { mode: 'nothing' },
            });
            expect(typeof (adopted.providerMeta as { unclaimedAt?: unknown }).unclaimedAt).toBe(
                'string',
            );

            const view = fleetCloudViewOf(adopted as never)!;
            const items = cloudIdleItems(
                [{ id: adopted.id, name: adopted.name, status: 'offline', cloud: view } as never],
                {
                    now: new Date(),
                },
            );
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                kind: 'cloud-idle',
                title: 'Unclaimed machine at Provider — tagged ever-works',
                action: { label: 'Destroy…' },
            });

            // A second pass knows it now: nothing is adopted twice.
            await service.reconcile();
            expect([...rows.values()]).toHaveLength(1);
        });

        it('never touches a machine without this deployment’s site tag (another Ever Works on the same account)', async () => {
            const { service, rows, audit } = harness({
                audit: [{ ownerUserId: OWNER, details: { providerPluginId: PLUGIN } }],
                tagged: [
                    {
                        machineRef: '1',
                        state: 'running',
                        tags: ['ever-works', 'ever-works-site:0123456789abcdef'],
                    },
                    { machineRef: '2', state: 'running', tags: ['ever-works'] },
                    {
                        machineRef: '3',
                        state: 'gone',
                        tags: ['ever-works', `ever-works-site:${SITE}`],
                    },
                ],
            });
            await expect(service.reconcile()).resolves.toMatchObject({ changed: 0 });
            expect(rows.size).toBe(0);
            expect(audit.tryRecord).not.toHaveBeenCalled();
        });

        it('names an adopted machine uniquely and validly', () => {
            expect(unclaimedName('old-box', '7777', new Set())).toBe('old-box');
            expect(unclaimedName('old-box', '7777', new Set(['old-box']))).toBe('old-box-2');
            expect(unclaimedName('Not A Valid Name!', '7777', new Set())).toBe('unclaimed-7777');
            expect(unclaimedName(undefined, 'ab/cd', new Set())).toBe('unclaimed-abcd');
        });
    });

    describe('sign in with the provider (T-28, FR-31)', () => {
        function facade(account: { accessToken: string } | null) {
            const authAccounts = { findConnectedProviderAccount: jest.fn(async () => account) };
            const service = new MachineProviderFacadeService(
                {} as never,
                {} as never,
                authAccounts as never,
            );
            const plugin = {
                id: PLUGIN,
                providerName: 'Provider',
                capabilities: ['machine-provider', 'oauth'],
                isConfigured: (settings: Record<string, unknown>) =>
                    Boolean(settings.apiToken || settings.oauthAccessToken),
                listOptions: jest.fn(async () => OPTIONS),
            };
            jest.spyOn(service as never, 'resolveProvider' as never).mockResolvedValue(
                plugin as never,
            );
            jest.spyOn(service as never, 'getResolvedSettings' as never).mockResolvedValue({
                defaultRegion: 'nyc3',
            } as never);
            return { service, plugin, authAccounts };
        }

        it('hands the stored sign-in token to the plugin as oauthAccessToken', async () => {
            const { service, plugin, authAccounts } = facade({ accessToken: 'signed-in-token' });
            await service.listOptions(PLUGIN, OWNER);
            expect(authAccounts.findConnectedProviderAccount).toHaveBeenCalledWith(OWNER, PLUGIN, {
                usePluginProviderId: true,
            });
            expect(plugin.listOptions).toHaveBeenCalledWith({
                defaultRegion: 'nyc3',
                oauthAccessToken: 'signed-in-token',
            });
        });

        it('passes the plain settings when there is no sign-in', async () => {
            const { service, plugin } = facade(null);
            await service.listOptions(PLUGIN, OWNER);
            expect(plugin.listOptions).toHaveBeenCalledWith({ defaultRegion: 'nyc3' });
        });

        it('reads "Sign in" and "configured" off the live plugin', async () => {
            const { service } = facade({ accessToken: 'signed-in-token' });
            const live = {
                id: PLUGIN,
                providerName: 'Provider',
                capabilities: ['machine-provider'],
                isConfigured: () => true,
            };
            const lazy = {
                ...live,
                capabilities: ['machine-provider', 'oauth'],
                __materialize: async () => live,
            };
            jest.spyOn(service as never, 'getEnabledPlugins' as never).mockResolvedValue([
                { plugin: lazy, manifest: { name: 'Machines' } },
            ] as never);
            const [summary] = await service.listProviders(OWNER);
            // The cold manifest lists oauth; the live instance (no operator application) does not.
            expect(summary).toMatchObject({
                pluginId: PLUGIN,
                configured: true,
                oauthAvailable: false,
            });
        });
    });
});
