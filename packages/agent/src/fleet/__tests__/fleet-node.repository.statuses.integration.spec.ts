import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetNode } from '../../entities/fleet-node.entity';
import { User } from '../../entities/user.entity';
import { FleetNodeRepository } from '../fleet-node.repository';

/**
 * `FleetNodeRepository.findStatusesByIds` (Fleet node link, FL-02) against a
 * REAL (better-sqlite3, synchronize) schema: the link gateway re-reads the
 * rows of every connected node with it, and closes the link of any node
 * whose row is gone or back to `enrolling`. So the answer must carry exactly
 * the rows that exist, with their status, across the chunk boundary, and
 * nothing for an id with no row.
 */
describe('fleet node repository — statuses by id (better-sqlite3)', () => {
    let dataSource: DataSource;
    let nodes: FleetNodeRepository;
    let nodeRows: Repository<FleetNode>;
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
        nodes = new FleetNodeRepository(nodeRows);
        const owner = await dataSource.getRepository(User).save(
            dataSource.getRepository(User).create({
                username: 'node-status-owner',
                email: 'node-status-owner@example.com',
                password: 'x',
            } as Partial<User>),
        );
        ownerId = owner.id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const createNode = (name: string, status: FleetNode['status']) =>
        nodes.create({
            userId: ownerId,
            name,
            kind: 'node',
            status,
            enrollmentTokenHash: `hash-${name}`,
            capabilities: [],
        });

    it('answers the id and status of each existing row and nothing for a missing one', async () => {
        const online = await createNode('build-01', 'online');
        const rekeyed = await createNode('build-02', 'enrolling');
        const missing = '99999999-9999-4999-8999-999999999999';
        const rows = await nodes.findStatusesByIds([online.id, rekeyed.id, missing]);
        expect(
            rows.map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)),
        ).toEqual(
            [
                { id: online.id, status: 'online' },
                { id: rekeyed.id, status: 'enrolling' },
            ].sort((a, b) => a.id.localeCompare(b.id)),
        );
        expect(await nodes.findStatusesByIds([])).toEqual([]);
    });

    it('reads past the 500-id chunk', async () => {
        const last = await createNode('build-03', 'disabled');
        const filler = Array.from(
            { length: 600 },
            (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        );
        const rows = await nodes.findStatusesByIds([...filler, last.id]);
        expect(rows).toEqual([expect.objectContaining({ id: last.id, status: 'disabled' })]);
    });
});
