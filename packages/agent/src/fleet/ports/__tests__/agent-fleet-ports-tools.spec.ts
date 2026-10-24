import { buildFleetPortsTools } from '../agent-fleet-ports-tools';
import { fleetPortsError } from '../fleet-ports.errors';

/**
 * Servers and ports (FL-10, FR-20) — the Agent's tools: the list is a read
 * (the service writes no audit row for it), open goes through the service as
 * `agent:<id>` for its owner, and the address is never an argument.
 */
describe('buildFleetPortsTools', () => {
    const list = jest.fn();
    const open = jest.fn();
    const tools = buildFleetPortsTools({
        agent: { id: 'agent-1', userId: 'owner-1', name: 'Nina' },
        service: { list, open },
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

    beforeEach(() => {
        list.mockReset();
        open.mockReset();
    });

    it('offers exactly the two P1 tools, neither taking an address', () => {
        expect(tools.map((candidate) => candidate.name)).toEqual(['fleet_ports_list', 'fleet_ports_open']);
        expect(Object.keys(tool('fleet_ports_open').parameters.properties)).not.toContain('url');
    });

    it('lists as the Agent for its owner, web servers first', async () => {
        list.mockResolvedValue({
            nodeName: 'build-01',
            sampledAt: '2026-10-21T09:41:00.000Z',
            ports: [
                {
                    port: 5432,
                    kind: 'other',
                    bind: '127.0.0.1',
                    proto: 'tcp',
                    localOnly: true,
                    wellKnown: 'postgres',
                },
                { port: 3000, kind: 'web', bind: '0.0.0.0', proto: 'tcp', localOnly: false },
            ],
            canOpen: true,
            defaultTarget: 'preview-profile',
        });
        const result = (await tool('fleet_ports_list').invoke({ nodeId: 'n1' })) as Record<string, unknown>;
        expect(list).toHaveBeenCalledWith(
            'n1',
            { kind: 'agent', agentId: 'agent-1', ownerUserId: 'owner-1', agentName: 'Nina' },
            { watch: undefined },
        );
        expect((result.webServers as Array<{ port: number }>).map((port) => port.port)).toEqual([3000]);
    });

    it('opens by port number only and never hands back a viewer token', async () => {
        open.mockResolvedValue({
            target: 'preview-profile',
            url: 'http://127.0.0.1:3000/',
            attach: { token: 'x' },
        });
        const result = await tool('fleet_ports_open').invoke({ nodeId: 'n1', port: 3000 });
        expect(open).toHaveBeenCalledWith(
            'n1',
            3000,
            expect.objectContaining({ kind: 'agent', agentId: 'agent-1' }),
            {},
        );
        expect(result).toEqual({
            opened: true,
            target: 'preview-profile',
            url: 'http://127.0.0.1:3000/',
            endsAt: null,
        });
        expect(await tool('fleet_ports_open').invoke({ nodeId: 'n1', port: 70000 })).toEqual({
            error: 'port must be a number from 1 to 65535',
        });
    });

    it('returns a refusal as { error, code }', async () => {
        open.mockRejectedValue(fleetPortsError('busy', 'Ops is previewing :5173 on build-01'));
        expect(await tool('fleet_ports_open').invoke({ nodeId: 'n1', port: 3000 })).toEqual({
            error: 'Ops is previewing :5173 on build-01',
            code: 'busy',
        });
    });
});
