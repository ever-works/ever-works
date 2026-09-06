import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetAgentNodeAffinity } from '../../entities/fleet-agent-node-affinity.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { User } from '../../entities/user.entity';
import { FleetNodeRepository } from '../fleet-node.repository';

/**
 * `FleetNodeRepository.delete` against a REAL (better-sqlite3,
 * synchronize) schema.
 *
 * The defect: `fleet_agent_node_affinities` carries a raw uuid `nodeId`
 * with no foreign key (deliberately — see
 * `1787508800000-CreateFleetAgentNodeAffinity`), so deleting a node left
 * its Agent pins behind. The affinity service kept resolving them,
 * `FleetJobService.enqueue` kept stamping `targetNodeId` with a machine
 * that no longer existed, and the job sat queued forever pinned to a
 * ghost — with the runner pill reporting the fleet as idle, because it
 * was.
 *
 * A service-level mock cannot catch this: the whole question is whether
 * the two statements really run, really scope to the one node, and
 * really share a transaction. So this drives the real repository against
 * a real schema, which is also why the AFFINITY repository has an
 * integration spec of its own.
 */
describe('fleet node repository — delete cascade (better-sqlite3)', () => {
    const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
    const OTHER_AGENT = '44444444-4444-4444-8444-444444444444';

    let dataSource: DataSource;
    let nodes: FleetNodeRepository;
    let nodeRows: Repository<FleetNode>;
    let affinityRows: Repository<FleetAgentNodeAffinity>;
    let ownerId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();

        nodeRows = dataSource.getRepository(FleetNode);
        affinityRows = dataSource.getRepository(FleetAgentNodeAffinity);
        nodes = new FleetNodeRepository(nodeRows);

        const owner = await dataSource.getRepository(User).save(
            dataSource.getRepository(User).create({
                username: 'node-delete-owner',
                email: 'node-delete-owner@example.com',
                password: 'x',
            } as Partial<User>),
        );
        ownerId = owner.id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await affinityRows.clear();
        await nodeRows.clear();
    });

    const createNode = (name: string) =>
        nodes.create({
            userId: ownerId,
            organizationId: ORGANIZATION,
            name,
            kind: 'desktop-node',
            status: 'online',
            enrollmentTokenHash: `hash-${name}`,
            capabilities: [],
        });

    const pin = (agentId: string, nodeId: string) =>
        affinityRows.save(
            affinityRows.create({ userId: ownerId, organizationId: ORGANIZATION, agentId, nodeId }),
        );

    it('deletes the node AND only that node’s Agent pins', async () => {
        const nodeA = await createNode('Office PC');
        const nodeB = await createNode('Studio PC');
        await pin(OTHER_AGENT, nodeA.id);
        await pin('55555555-5555-4555-8555-555555555555', nodeA.id);
        await pin('66666666-6666-4666-8666-666666666666', nodeB.id);

        await nodes.delete(nodeA.id);

        expect(await nodes.findById(nodeA.id)).toBeNull();
        expect(await nodes.findById(nodeB.id)).not.toBeNull();
        const remaining = await affinityRows.find();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].nodeId).toBe(nodeB.id);
    });

    it('is a no-op-safe delete for a node that has no pins at all', async () => {
        const node = await createNode('Bare PC');

        await expect(nodes.delete(node.id)).resolves.toBeUndefined();

        expect(await nodes.findById(node.id)).toBeNull();
    });

    it('rolls the node deletion back when the pin deletion fails', async () => {
        // Half-applied is the one outcome worse than either whole one: the
        // machine gone and its pins still resolving to it. Both statements
        // share a transaction precisely so that cannot happen.
        const node = await createNode('Office PC');
        await pin(OTHER_AGENT, node.id);

        // Spied on the PROTOTYPE, not on `dataSource.manager`: the callback
        // runs against a fresh transactional EntityManager, so an
        // instance-level spy would never be reached — which is itself the
        // proof that a separate manager (and therefore a real transaction)
        // is in play.
        const managerProto = Object.getPrototypeOf(dataSource.manager) as {
            delete: (...args: unknown[]) => unknown;
        };
        const managerDelete = jest.spyOn(managerProto, 'delete');
        managerDelete.mockImplementationOnce(() => {
            throw new Error('affinity delete exploded');
        });

        await expect(nodes.delete(node.id)).rejects.toThrow('affinity delete exploded');
        managerDelete.mockRestore();

        expect(await nodes.findById(node.id)).not.toBeNull();
        expect(await affinityRows.count()).toBe(1);
    });
});
