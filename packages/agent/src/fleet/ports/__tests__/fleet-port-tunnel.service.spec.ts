import { FleetPortTunnelService } from '../fleet-port-tunnel.service';

/**
 * Servers and ports, phase 2 (FL-10, T-18) — the tunnel service: the
 * four-per-person limit, owner-only requests, a close that happens exactly
 * once (CAS) with exactly one close audit row, and the sweeper's reasons.
 */
describe('FleetPortTunnelService', () => {
    const env = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_MACHINE_FACTS_ENABLED = 'true';
        process.env.FLEET_PORT_TUNNEL_ENABLED = 'true';
        process.env.FLEET_PREVIEW_HOST = 'preview.example.test';
    });
    afterEach(() => {
        process.env = { ...env };
    });

    const node = {
        id: 'node-1',
        userId: 'owner-1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
    };

    function make(options: { open?: Array<Record<string, unknown>>; stopped?: boolean } = {}) {
        const rows = new Map<string, Record<string, unknown>>();
        for (const row of options.open ?? []) rows.set(row.id as string, { state: 'open', ...row });
        const repo = {
            insert: jest.fn(async (input: Record<string, unknown>) => {
                const row = { ...input, state: 'open', requestCount: 0, bytesIn: 0, bytesOut: 0 };
                rows.set(input.id as string, row);
                return row;
            }),
            findById: jest.fn(async (id: string) => rows.get(id) ?? null),
            findOpenForPort: jest.fn(
                async (owner: string, nodeId: string, port: number) =>
                    [...rows.values()].find(
                        (row) =>
                            row.ownerUserId === owner &&
                            row.nodeId === nodeId &&
                            row.port === port &&
                            row.state === 'open',
                    ) ?? null,
            ),
            listOpenForOwner: jest.fn(async (owner: string) =>
                [...rows.values()].filter(
                    (row) => row.ownerUserId === owner && row.state === 'open',
                ),
            ),
            listOpen: jest.fn(async () => [...rows.values()].filter((row) => row.state === 'open')),
            close: jest.fn(async (id: string, reason: string) => {
                const row = rows.get(id);
                if (!row || row.state !== 'open') return false;
                row.state = 'closed';
                row.closedReason = reason;
                return true;
            }),
            touch: jest.fn(),
            stampAudit: jest.fn(),
        };
        const access = { resolveForFamily: jest.fn(async () => ({ node, role: 'owner' })) };
        const killSwitch = { isStopped: jest.fn(async () => options.stopped === true) };
        const nodes = { findById: jest.fn(async () => node) };
        const audit = {
            record: jest.fn(async (input: { action: string }) => ({ id: `audit-${input.action}` })),
        };
        const link = {
            open: jest.fn(async () => undefined),
            close: jest.fn(),
            isConnected: jest.fn(() => true),
        };
        const service = new FleetPortTunnelService(
            repo as never,
            access as never,
            killSwitch as never,
            nodes as never,
            audit as never,
            link as never,
        );
        return { service, repo, audit, link, rows };
    }

    const owner = { kind: 'user' as const, userId: 'owner-1' };

    it('opens a tunnel with one open audit row, asking the machine first', async () => {
        const { service, audit, link } = make();
        const { tunnel, created } = await service.open('node-1', 3000, owner);
        expect(created).toBe(true);
        expect(tunnel.url).toBe(`https://preview.example.test/p/${tunnel.id}/`);
        expect(link.open).toHaveBeenCalledWith(
            expect.objectContaining({ tunnelId: tunnel.id, port: 3000 }),
        );
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record.mock.calls[0][0].action).toBe('node.port.preview.open');
    });

    it('refuses a fifth tunnel with limit_exceeded listing the four (U11)', async () => {
        const open = [1, 2, 3, 4].map((n) => ({
            id: `t${n}`,
            ownerUserId: 'owner-1',
            nodeId: 'node-1',
            port: 3000 + n,
            previewHost: 'preview.example.test',
            openedAt: new Date(),
        }));
        const { service } = make({ open });
        await expect(service.open('node-1', 4000, owner)).rejects.toMatchObject({
            portsError: { code: 'limit_exceeded' },
        });
    });

    it('serves only its owner (FR-24)', async () => {
        const { service } = make({
            open: [
                {
                    id: 't1',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 3000,
                    openedAt: new Date(),
                },
            ],
        });
        expect(await service.authorizeRequest('t1', 'someone-else')).toEqual({
            ok: false,
            why: 'not-yours',
        });
        expect((await service.authorizeRequest('t1', 'owner-1')).ok).toBe(true);
    });

    it('closes exactly once, with exactly one close audit row (ACC-FL10-18)', async () => {
        const { service, audit } = make({
            open: [
                {
                    id: 't1',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 3000,
                    openedAt: new Date(),
                },
            ],
        });
        expect(await service.close('t1', 'user', 'user')).toBe(true);
        expect(await service.close('t1', 'idle', 'idle')).toBe(false);
        const closes = audit.record.mock.calls.filter(
            (call) => call[0].action === 'node.port.preview.close',
        );
        expect(closes).toHaveLength(1);
    });

    it('sweeps idle, hard and kill-switch closes', async () => {
        const now = Date.now();
        const { service, rows } = make({
            open: [
                {
                    id: 'idle',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 1,
                    openedAt: new Date(now - 11 * 60_000),
                },
                {
                    id: 'hard',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 2,
                    openedAt: new Date(now - 61 * 60_000),
                    lastRequestAt: new Date(now),
                },
                {
                    id: 'fresh',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 3,
                    openedAt: new Date(now),
                },
            ],
        });
        expect((await service.sweep(new Date(now))).closed).toBe(2);
        expect(rows.get('idle')?.closedReason).toBe('idle');
        expect(rows.get('hard')?.closedReason).toBe('hard');
        expect(rows.get('fresh')?.state).toBe('open');

        const stopped = make({
            stopped: true,
            open: [
                {
                    id: 's',
                    ownerUserId: 'owner-1',
                    nodeId: 'node-1',
                    port: 4,
                    openedAt: new Date(now),
                },
            ],
        });
        await stopped.service.sweep(new Date(now));
        expect(stopped.rows.get('s')?.closedReason).toBe('kill-switch');
    });

    it('answers 404 with the flag off (FR-31)', async () => {
        process.env.FLEET_PORT_TUNNEL_ENABLED = 'false';
        const { service } = make();
        await expect(service.open('node-1', 3000, owner)).rejects.toMatchObject({
            portsError: { code: 'not_found' },
        });
        expect(await service.authorizeRequest('x', 'owner-1')).toEqual({ ok: false, why: 'off' });
    });
});
