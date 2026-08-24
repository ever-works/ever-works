import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FleetAgentNodeAffinityService } from '../fleet-agent-node-affinity.service';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';
import { Agent } from '../../entities/agent.entity';
import { FleetAgentNodeAffinity } from '../../entities/fleet-agent-node-affinity.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetNodeRepository } from '../fleet-node.repository';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
const OTHER_ORGANIZATION = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const NODE = '66666666-6666-4666-8666-666666666666';

interface Stores {
    agents: Agent[];
    nodes: FleetNode[];
    affinities: FleetAgentNodeAffinity[];
}

function makeService(stores: Stores): FleetAgentNodeAffinityService {
    const agents = {
        findOne: jest.fn(async ({ where }: { where: Partial<Agent> }) =>
            stores.agents.find((agent) =>
                Object.entries(where).every(
                    ([key, value]) => (agent as unknown as Record<string, unknown>)[key] === value,
                ),
            ),
        ),
    };
    const nodes = {
        findById: jest.fn(
            async (id: string) => stores.nodes.find((node) => node.id === id) ?? null,
        ),
    } as unknown as FleetNodeRepository;
    const affinities = {
        findForAgent: jest.fn(
            async (userId: string, organizationId: string, agentId: string) =>
                stores.affinities.find(
                    (row) =>
                        row.userId === userId &&
                        row.organizationId === organizationId &&
                        row.agentId === agentId,
                ) ?? null,
        ),
        upsert: jest.fn(
            async (data: {
                userId: string;
                organizationId: string;
                agentId: string;
                nodeId: string;
            }) => {
                const existing = stores.affinities.find(
                    (row) =>
                        row.userId === data.userId &&
                        row.organizationId === data.organizationId &&
                        row.agentId === data.agentId,
                );
                if (existing) {
                    existing.nodeId = data.nodeId;
                    existing.updatedAt = new Date();
                    return existing;
                }
                const created = {
                    id: '77777777-7777-4777-8777-777777777777',
                    ...data,
                    createdAt: new Date('2026-08-22T00:00:00.000Z'),
                    updatedAt: new Date('2026-08-22T00:00:00.000Z'),
                } as FleetAgentNodeAffinity;
                stores.affinities.push(created);
                return created;
            },
        ),
        remove: jest.fn(async (userId: string, organizationId: string, agentId: string) => {
            const before = stores.affinities.length;
            stores.affinities = stores.affinities.filter(
                (row) =>
                    !(
                        row.userId === userId &&
                        row.organizationId === organizationId &&
                        row.agentId === agentId
                    ),
            );
            return stores.affinities.length < before;
        }),
    } as unknown as FleetAgentNodeAffinityRepository;

    return new FleetAgentNodeAffinityService(affinities, agents as never, nodes);
}

function ownedAgent(overrides: Partial<Agent> = {}): Agent {
    return { id: AGENT, userId: OWNER, organizationId: ORGANIZATION, ...overrides } as Agent;
}

function ownedNode(overrides: Partial<FleetNode> = {}): FleetNode {
    return { id: NODE, userId: OWNER, ...overrides } as FleetNode;
}

describe('FleetAgentNodeAffinityService', () => {
    let stores: Stores;
    let service: FleetAgentNodeAffinityService;

    beforeEach(() => {
        stores = { agents: [ownedAgent()], nodes: [ownedNode()], affinities: [] };
        service = makeService(stores);
    });

    it('persists one active-Organization binding to a user-owned node', async () => {
        const result = await service.setAffinity({
            userId: OWNER,
            organizationId: ORGANIZATION,
            agentId: AGENT,
            nodeId: NODE,
        });

        expect(result).toMatchObject({
            agentId: AGENT,
            nodeId: NODE,
            organizationId: ORGANIZATION,
        });
        expect(stores.affinities).toHaveLength(1);
    });

    it.each([
        ['an unknown Agent', () => stores.agents.splice(0)],
        ["another owner's Agent", () => (stores.agents[0].userId = OTHER_OWNER)],
        [
            'an Agent outside the active Organization',
            () => (stores.agents[0].organizationId = OTHER_ORGANIZATION),
        ],
        ["another owner's node", () => (stores.nodes[0].userId = OTHER_OWNER)],
    ])('rejects %s without creating or changing a binding', async (_label, arrange) => {
        arrange();

        await expect(
            service.setAffinity({
                userId: OWNER,
                organizationId: ORGANIZATION,
                agentId: AGENT,
                nodeId: NODE,
            }),
        ).rejects.toMatchObject({
            constructor: NotFoundException,
            message: 'Fleet Agent or node not found',
        });
        expect(stores.affinities).toEqual([]);
    });

    it('refuses personal scope before any binding can be written', async () => {
        await expect(
            service.setAffinity({
                userId: OWNER,
                organizationId: null,
                agentId: AGENT,
                nodeId: NODE,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(stores.affinities).toEqual([]);
    });

    describe('clearAffinity', () => {
        const scope = { userId: OWNER, organizationId: ORGANIZATION, agentId: AGENT };

        it('returns the Agent to "any of my PCs" and is idempotent', async () => {
            await service.setAffinity({ ...scope, nodeId: NODE });
            expect(stores.affinities).toHaveLength(1);

            await expect(service.clearAffinity(scope)).resolves.toEqual({ cleared: true });
            expect(stores.affinities).toEqual([]);
            await expect(service.getAffinity(scope)).resolves.toBeNull();

            // Clearing an already-unbound Agent is a no-op, not an error.
            await expect(service.clearAffinity(scope)).resolves.toEqual({ cleared: false });
        });

        it.each([
            ['an unknown Agent', () => stores.agents.splice(0)],
            ["another owner's Agent", () => (stores.agents[0].userId = OTHER_OWNER)],
            [
                'an Agent outside the active Organization',
                () => (stores.agents[0].organizationId = OTHER_ORGANIZATION),
            ],
        ])('refuses to clear %s and leaves every binding in place', async (_label, arrange) => {
            stores.affinities.push({
                id: '88888888-8888-4888-8888-888888888888',
                userId: OWNER,
                organizationId: ORGANIZATION,
                agentId: AGENT,
                nodeId: NODE,
            } as FleetAgentNodeAffinity);
            arrange();

            await expect(service.clearAffinity(scope)).rejects.toMatchObject({
                constructor: NotFoundException,
                message: 'Fleet Agent or node not found',
            });
            expect(stores.affinities).toHaveLength(1);
        });

        it('fails closed in personal scope before touching any row', async () => {
            await expect(
                service.clearAffinity({ ...scope, organizationId: null }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    it('returns null for an unbound owned Agent without weakening Agent validation', async () => {
        await expect(
            service.getAffinity({
                userId: OWNER,
                organizationId: ORGANIZATION,
                agentId: AGENT,
            }),
        ).resolves.toBeNull();

        stores.agents[0].userId = OTHER_OWNER;
        await expect(
            service.getAffinity({
                userId: OWNER,
                organizationId: ORGANIZATION,
                agentId: AGENT,
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
