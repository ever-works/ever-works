import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { FleetAgentNodeAffinity } from '../../entities/fleet-agent-node-affinity.entity';
import { FleetJob } from '../../entities/fleet-job.entity';
import { User } from '../../entities/user.entity';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';
import { FleetJobRepository } from '../fleet-job.repository';

/**
 * The REAL predicates behind Agent-to-node affinity, against a real
 * (better-sqlite3, synchronize) schema. The service specs drive these
 * through in-memory mocks that re-implement the filter, so they cannot
 * notice a `where` array that silently drops its `IsNull()` branch, an
 * upsert whose conflict target stops matching the unique index, or a
 * binding lookup that stops going through the Agent's own Organization.
 */
describe('fleet agent node affinity — repository integration (better-sqlite3)', () => {
    const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
    const OTHER_ORGANIZATION = '66666666-6666-4666-8666-666666666666';
    const NODE_A = '11111111-1111-4111-8111-111111111111';
    const NODE_B = '22222222-2222-4222-8222-222222222222';

    let dataSource: DataSource;
    let affinities: FleetAgentNodeAffinityRepository;
    let jobs: FleetJobRepository;
    let agentRows: Repository<Agent>;
    let ownerId: string;
    let strangerId: string;
    let agentId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();

        const users = dataSource.getRepository(User);
        agentRows = dataSource.getRepository(Agent);
        affinities = new FleetAgentNodeAffinityRepository(
            dataSource.getRepository(FleetAgentNodeAffinity),
            agentRows,
        );
        jobs = new FleetJobRepository(dataSource.getRepository(FleetJob));

        const owner = await users.save(
            users.create({
                username: 'affinity-owner',
                email: 'affinity-owner@example.com',
                password: 'x',
            } as Partial<User>),
        );
        ownerId = owner.id;
        const stranger = await users.save(
            users.create({
                username: 'affinity-stranger',
                email: 'affinity-stranger@example.com',
                password: 'x',
            } as Partial<User>),
        );
        strangerId = stranger.id;

        const agent = await agentRows.save(
            agentRows.create({
                userId: ownerId,
                organizationId: ORGANIZATION,
                scope: AgentScope.TENANT,
                name: 'Pinned Agent',
                slug: 'pinned-agent',
                title: 'Runs on one PC',
                status: AgentStatus.ACTIVE,
                permissions: {},
            } as Partial<Agent>),
        );
        agentId = agent.id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await dataSource.getRepository(FleetAgentNodeAffinity).clear();
        await dataSource.getRepository(FleetJob).clear();
    });

    it('upserts one row per (owner, Organization, Agent), re-binds in place and refreshes updatedAt', async () => {
        const first = await affinities.upsert({
            userId: ownerId,
            organizationId: ORGANIZATION,
            agentId,
            nodeId: NODE_A,
        });
        // Make the clock observably move on drivers with 1 ms resolution.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await affinities.upsert({
            userId: ownerId,
            organizationId: ORGANIZATION,
            agentId,
            nodeId: NODE_B,
        });

        expect(second.id).toBe(first.id);
        expect(second.nodeId).toBe(NODE_B);
        expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
        expect(await dataSource.getRepository(FleetAgentNodeAffinity).count()).toBe(1);

        // The same Agent under another Organization is a different binding.
        await affinities.upsert({
            userId: ownerId,
            organizationId: OTHER_ORGANIZATION,
            agentId,
            nodeId: NODE_A,
        });
        expect(await dataSource.getRepository(FleetAgentNodeAffinity).count()).toBe(2);
    });

    it("resolves the scheduling target through the Agent's own Organization and only for its owner", async () => {
        await affinities.upsert({
            userId: ownerId,
            organizationId: ORGANIZATION,
            agentId,
            nodeId: NODE_A,
        });

        const owned = await affinities.findForOwnedAgent(ownerId, agentId);
        expect(owned?.nodeId).toBe(NODE_A);

        // A binding row under a stale/other Organization must not win:
        // the Agent's CURRENT Organization decides.
        await affinities.upsert({
            userId: ownerId,
            organizationId: OTHER_ORGANIZATION,
            agentId,
            nodeId: NODE_B,
        });
        expect((await affinities.findForOwnedAgent(ownerId, agentId))?.nodeId).toBe(NODE_A);

        // Another user asking about this Agent gets nothing — never a
        // foreign node id.
        await expect(affinities.findForOwnedAgent(strangerId, agentId)).resolves.toBeNull();
        // An unknown Agent id is simply unbound.
        await expect(
            affinities.findForOwnedAgent(ownerId, '99999999-9999-4999-8999-999999999999'),
        ).resolves.toBeNull();
    });

    it('returns null for an Agent that has no Organization (personal scope is never bound)', async () => {
        const personal = await agentRows.save(
            agentRows.create({
                userId: ownerId,
                organizationId: null,
                scope: AgentScope.TENANT,
                name: 'Personal Agent',
                slug: 'personal-agent',
                title: 'No Organization yet',
                status: AgentStatus.ACTIVE,
                permissions: {},
            } as Partial<Agent>),
        );
        await expect(affinities.findForOwnedAgent(ownerId, personal.id)).resolves.toBeNull();
    });

    it('removes exactly the scoped binding and reports whether anything was there', async () => {
        await affinities.upsert({
            userId: ownerId,
            organizationId: ORGANIZATION,
            agentId,
            nodeId: NODE_A,
        });
        await affinities.upsert({
            userId: ownerId,
            organizationId: OTHER_ORGANIZATION,
            agentId,
            nodeId: NODE_B,
        });

        await expect(affinities.remove(ownerId, ORGANIZATION, agentId)).resolves.toBe(true);
        await expect(affinities.remove(ownerId, ORGANIZATION, agentId)).resolves.toBe(false);
        await expect(affinities.findForAgent(ownerId, ORGANIZATION, agentId)).resolves.toBeNull();
        // The other Organization's binding is untouched.
        expect((await affinities.findForAgent(ownerId, OTHER_ORGANIZATION, agentId))?.nodeId).toBe(
            NODE_B,
        );
    });

    it('lease scan: a node sees unbound work and its own targeted work, never another node’s — and the limit is applied AFTER the exclusion', async () => {
        // Six jobs pinned to NODE_A, created first, then one unbound job.
        for (let index = 0; index < 6; index += 1) {
            await jobs.create({ userId: ownerId, kind: 'acceptance-checks', targetNodeId: NODE_A });
        }
        const unbound = await jobs.create({ userId: ownerId, kind: 'acceptance-checks' });
        const strangers = await jobs.create({ userId: strangerId, kind: 'acceptance-checks' });

        // NODE_B with a window of 5: without the SQL-side exclusion the six
        // NODE_A rows would fill the window and hide the unbound job.
        const forB = await jobs.findQueuedForNode(ownerId, NODE_B, 5);
        expect(forB.map((job) => job.id)).toEqual([unbound.id]);

        const forA = await jobs.findQueuedForNode(ownerId, NODE_A, 10);
        expect(forA).toHaveLength(7);
        expect(forA.every((job) => job.targetNodeId === NODE_A || job.targetNodeId === null)).toBe(true);
        expect(forA.some((job) => job.id === strangers.id)).toBe(false);
    });
});
