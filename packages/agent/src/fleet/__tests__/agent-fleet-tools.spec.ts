import { buildFleetTools } from '../agent-fleet-tools';
import type { FleetNodeView } from '../fleet.service';

const view = (overrides: Partial<FleetNodeView> = {}): FleetNodeView => ({
    id: 'node-1',
    name: 'my laptop',
    kind: 'desktop-node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.0.0',
    capabilities: ['terminal'],
    lastHeartbeatAt: new Date('2026-07-25T00:00:00Z').toISOString(),
    createdAt: new Date('2026-07-24T00:00:00Z').toISOString(),
    persisted: true,
    ...overrides,
});

describe('buildFleetTools', () => {
    it('exposes exactly the list_fleet_nodes tool', () => {
        const tools = buildFleetTools({
            userId: 'user-1',
            service: { listForUser: jest.fn(async () => []) },
        });
        expect(tools.map((tool) => tool.name)).toEqual(['list_fleet_nodes']);
    });

    it('lists nodes owner-scoped (the tool can only ever ask for its own user)', async () => {
        const listForUser = jest.fn(async () => [view()]);
        const [tool] = buildFleetTools({ userId: 'user-1', service: { listForUser } });

        const result = (await tool.invoke({})) as { nodes: FleetNodeView[] };

        expect(listForUser).toHaveBeenCalledWith('user-1');
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0].id).toBe('node-1');
    });

    it('applies kind/status filters and the limit cap', async () => {
        const listForUser = jest.fn(async () => [
            view({ id: 'a', kind: 'desktop-node', status: 'online' }),
            view({ id: 'b', kind: 'node', status: 'offline' }),
            view({ id: 'c', kind: 'k8s', status: 'online', persisted: false }),
        ]);
        const [tool] = buildFleetTools({ userId: 'user-1', service: { listForUser } });

        const online = (await tool.invoke({ status: 'online' })) as { nodes: FleetNodeView[] };
        expect(online.nodes.map((node) => node.id)).toEqual(['a', 'c']);

        const clusters = (await tool.invoke({ kind: 'k8s' })) as { nodes: FleetNodeView[] };
        expect(clusters.nodes.map((node) => node.id)).toEqual(['c']);

        const capped = (await tool.invoke({ limit: 1 })) as { nodes: FleetNodeView[] };
        expect(capped.nodes).toHaveLength(1);
    });

    it('returns a structured error instead of throwing', async () => {
        const listForUser = jest.fn(async () => {
            throw new Error('db down');
        });
        const [tool] = buildFleetTools({ userId: 'user-1', service: { listForUser } });

        const result = (await tool.invoke({})) as { error: string };

        expect(result.error).toBe('db down');
    });
});
