import { DataSource } from 'typeorm';
import { AddFleetNodeHelperTrust1796070000000 } from '../1796070000000-AddFleetNodeHelperTrust';

/**
 * Migration test for FL-07 slot `1796070000000` on the in-memory
 * better-sqlite3 harness of the sibling specs (production runs Postgres with
 * the same portable DDL):
 *
 *  - `helperTrust` lands NOT NULL with `none` for every existing row, plus
 *    `desktopFacts` and the index;
 *  - `up()` twice converges (per-step guards); `down()` reverses it.
 */
describe('AddFleetNodeHelperTrust1796070000000', () => {
    let dataSource: DataSource;

    const table = async () => {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable('fleet_nodes');
        await runner.release();
        return found;
    };

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await new AddFleetNodeHelperTrust1796070000000()[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "fleet_nodes" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "fleet_nodes" ("id") VALUES ('n1')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('adds the trust column with its default, the desktop facts and the index', async () => {
        await run('up');
        const nodes = await table();
        expect(nodes?.findColumnByName('helperTrust')).toBeDefined();
        expect(nodes?.findColumnByName('desktopFacts')?.isNullable).toBe(true);
        expect(nodes?.indices.map((index) => index.name)).toContain('idx_fleet_nodes_helper_trust');
        const rows = await dataSource.query(
            `SELECT "helperTrust", "desktopFacts" FROM "fleet_nodes"`,
        );
        expect(rows).toEqual([{ helperTrust: 'none', desktopFacts: null }]);
    });

    it('converges when run twice and reverses exactly', async () => {
        await run('up');
        await run('up');
        await run('down');
        const nodes = await table();
        expect(nodes?.findColumnByName('helperTrust')).toBeUndefined();
        expect(nodes?.findColumnByName('desktopFacts')).toBeUndefined();
        expect(nodes?.indices.map((index) => index.name)).not.toContain(
            'idx_fleet_nodes_helper_trust',
        );
    });
});
