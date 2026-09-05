import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetCostPolicy } from '../../entities/fleet-cost-policy.entity';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { utcDayStart } from '../fleet-cost-ceiling.shared';
import { FleetCostPolicyRepository } from '../fleet-cost-policy.repository';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetNodeRepository } from '../fleet-node.repository';

/**
 * Fleet cost accounting (EW-777) — the REAL predicates behind the daily
 * ceilings, against a real (better-sqlite3, synchronize) schema.
 *
 * `FleetCostCeilingService`'s spec drives these through mocks that
 * re-implement the sums and the CAS, so it cannot notice a `SUM` that
 * counts a NULL cost as something, a Date bound the driver binds wrongly,
 * a two-step compare-and-set whose second UPDATE matches a NULL, or an
 * upsert that forgets to re-arm the one-notice marker. This can.
 */
describe('fleet cost accounting — repository integration (better-sqlite3)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const STRANGER = '22222222-2222-4222-8222-222222222222';

    let dataSource: DataSource;
    let jobs: FleetJobRepository;
    let nodes: FleetNodeRepository;
    let policies: FleetCostPolicyRepository;
    let jobRows: Repository<FleetJob>;
    let nodeRows: Repository<FleetNode>;
    let policyRows: Repository<FleetCostPolicy>;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        jobRows = dataSource.getRepository(FleetJob);
        nodeRows = dataSource.getRepository(FleetNode);
        policyRows = dataSource.getRepository(FleetCostPolicy);
        jobs = new FleetJobRepository(jobRows);
        nodes = new FleetNodeRepository(nodeRows);
        policies = new FleetCostPolicyRepository(policyRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await jobRows.clear();
        await nodeRows.clear();
        await policyRows.clear();
    });

    const seedNode = (overrides: Partial<FleetNode> = {}): Promise<FleetNode> =>
        nodeRows.save(
            nodeRows.create({
                userId: OWNER,
                name: 'pc',
                kind: 'desktop-node',
                status: 'online',
                capabilities: [],
                capabilitiesPinned: false,
                ...overrides,
            }),
        );

    const seedJob = (overrides: Partial<FleetJob> = {}): Promise<FleetJob> =>
        jobRows.save(
            jobRows.create({
                userId: OWNER,
                kind: 'agent-task',
                status: 'done',
                requiredCapabilities: [],
                ...overrides,
            }),
        );

    describe('daily spend sums', () => {
        it('sum costCents per node and per owner from midnight UTC, inclusive, and count a NULL cost as nothing', async () => {
            const nodeA = await seedNode({ name: 'a' });
            const nodeB = await seedNode({ name: 'b' });
            const strangerNode = await seedNode({ name: 'c', userId: STRANGER });
            const now = new Date('2026-09-05T15:30:00.000Z');
            const dayStart = utcDayStart(now);

            await seedJob({
                nodeId: nodeA.id,
                costCents: 300,
                completedAt: new Date('2026-09-05T10:00:00.000Z'),
            });
            // Exactly midnight belongs to today (`>=`).
            await seedJob({ nodeId: nodeA.id, costCents: 250, completedAt: dayStart });
            // A Codex run: tokens, no price. Unknown, never 0 — and never
            // something either; the service fails closed on it separately.
            await seedJob({
                nodeId: nodeA.id,
                costCents: null,
                completedAt: new Date('2026-09-05T11:00:00.000Z'),
            });
            // Yesterday, one millisecond before midnight.
            await seedJob({
                nodeId: nodeA.id,
                costCents: 1000,
                completedAt: new Date('2026-09-04T23:59:59.999Z'),
            });
            // Still running: no completedAt, no spend yet.
            await seedJob({
                nodeId: nodeA.id,
                status: 'running',
                costCents: 5000,
                completedAt: null,
            });
            await seedJob({
                nodeId: nodeB.id,
                costCents: 100,
                completedAt: new Date('2026-09-05T12:00:00.000Z'),
            });
            await seedJob({
                userId: STRANGER,
                nodeId: strangerNode.id,
                costCents: 999,
                completedAt: new Date('2026-09-05T12:00:00.000Z'),
            });

            expect(await jobs.sumCostCentsForNodeSince(nodeA.id, dayStart)).toBe(550);
            expect(await jobs.sumCostCentsForNodeSince(nodeB.id, dayStart)).toBe(100);
            expect(await jobs.sumCostCentsForUserSince(OWNER, dayStart)).toBe(650);
            expect(await jobs.sumCostCentsForUserSince(STRANGER, dayStart)).toBe(999);
            // Nothing at all is a number, not NULL — the ceiling compares it.
            expect(
                await jobs.sumCostCentsForNodeSince(
                    '99999999-9999-4999-8999-999999999999',
                    dayStart,
                ),
            ).toBe(0);
            // The day before, from ITS midnight, sees yesterday's job too.
            expect(
                await jobs.sumCostCentsForNodeSince(
                    nodeA.id,
                    utcDayStart(new Date('2026-09-04T00:00:00Z')),
                ),
            ).toBe(1550);
        });

        it('stampCostCents writes the cents the reconciler hands over, in place', async () => {
            const node = await seedNode();
            const job = await seedJob({
                nodeId: node.id,
                completedAt: new Date('2026-09-05T10:00:00.000Z'),
            });
            expect((await jobRows.findOneByOrFail({ id: job.id })).costCents).toBeNull();

            await jobs.stampCostCents(job.id, 42);
            expect((await jobRows.findOneByOrFail({ id: job.id })).costCents).toBe(42);
            expect(
                await jobs.sumCostCentsForNodeSince(
                    node.id,
                    utcDayStart(new Date('2026-09-05T23:00:00Z')),
                ),
            ).toBe(42);
        });
    });

    describe('one-notice compare-and-set', () => {
        it('casTripDailyCeiling claims the trip exactly once per (node, UTC day)', async () => {
            const node = await seedNode();

            expect(await nodes.casTripDailyCeiling(node.id, '2026-09-05')).toBe(true);
            expect(await nodes.casTripDailyCeiling(node.id, '2026-09-05')).toBe(false);
            expect(await nodes.casTripDailyCeiling(node.id, '2026-09-05')).toBe(false);
            expect((await nodeRows.findOneByOrFail({ id: node.id })).dailyCostTrippedOn).toBe(
                '2026-09-05',
            );

            // A new day is a new trip — once.
            expect(await nodes.casTripDailyCeiling(node.id, '2026-09-06')).toBe(true);
            expect(await nodes.casTripDailyCeiling(node.id, '2026-09-06')).toBe(false);
            expect((await nodeRows.findOneByOrFail({ id: node.id })).dailyCostTrippedOn).toBe(
                '2026-09-06',
            );

            // An unknown node claims nothing.
            expect(
                await nodes.casTripDailyCeiling(
                    '99999999-9999-4999-8999-999999999999',
                    '2026-09-06',
                ),
            ).toBe(false);
        });

        it('casTrip creates the policy row on first use, claims once per day, and a changed ceiling re-arms it', async () => {
            expect(await policyRows.count()).toBe(0);

            expect(await policies.casTrip(OWNER, '2026-09-05')).toBe(true);
            expect(await policyRows.count()).toBe(1);
            expect(await policies.casTrip(OWNER, '2026-09-05')).toBe(false);
            expect(await policies.casTrip(OWNER, '2026-09-06')).toBe(true);
            expect(await policies.casTrip(OWNER, '2026-09-06')).toBe(false);

            // The owner raises the ceiling after the trip: the NEXT crossing
            // of the new ceiling must file a fresh notice, so the marker is
            // cleared with the change.
            const raised = await policies.upsertCeiling(OWNER, 5_000);
            expect(raised.dailyCeilingCents).toBe(5_000);
            expect(raised.trippedOn).toBeNull();
            expect(raised.trippedAt).toBeNull();
            expect(await policies.casTrip(OWNER, '2026-09-06')).toBe(true);
            expect(await policies.casTrip(OWNER, '2026-09-06')).toBe(false);

            // Clearing re-arms too, and keeps ONE row per owner.
            const cleared = await policies.upsertCeiling(OWNER, null);
            expect(cleared.dailyCeilingCents).toBeNull();
            expect(cleared.trippedOn).toBeNull();
            expect(await policyRows.count()).toBe(1);

            // Another owner's policy is neither created nor touched.
            expect(await policies.findByUser(STRANGER)).toBeNull();
        });
    });
});
