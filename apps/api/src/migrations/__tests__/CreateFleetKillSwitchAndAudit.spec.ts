import { DataSource } from 'typeorm';
import { CreateFleetKillSwitchAndAudit1788150000000 } from '../1788150000000-CreateFleetKillSwitchAndAudit';

/**
 * Panic controls (EW-778) — the migration behind the global stop flag.
 *
 * The property that matters most is the SEED: `FleetKillSwitchService`
 * fails closed on a missing row, so a migration that created the table
 * and left it empty would turn every deploy into a dispatch outage until
 * someone inserted the row by hand.
 */
describe('CreateFleetKillSwitchAndAudit1788150000000', () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await new CreateFleetKillSwitchAndAudit1788150000000().up(runner);
        await runner.release();
    }

    async function runDown(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await new CreateFleetKillSwitchAndAudit1788150000000().down(runner);
        await runner.release();
    }

    it('creates the single-row switch table and SEEDS the global row as not stopped', async () => {
        await runUp();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('fleet_kill_switch');
        await runner.release();

        expect(table?.columns.map((column) => column.name).sort()).toEqual(
            ['id', 'stopped', 'reason', 'setByUserId', 'setAt', 'updatedAt'].sort(),
        );
        const rows = await dataSource.query(
            `SELECT id, stopped, reason, "setByUserId" FROM fleet_kill_switch`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('global');
        // sqlite stores booleans as 0/1; either way it must be falsy.
        expect(Boolean(rows[0].stopped)).toBe(false);
        expect(rows[0].reason).toBeNull();
        expect(rows[0].setByUserId).toBeNull();
    });

    it('creates the append-only audit table with both lookup indexes', async () => {
        await runUp();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('fleet_audit');
        await runner.release();

        expect(table?.columns.map((column) => column.name).sort()).toEqual(
            [
                'id',
                'action',
                'actorUserId',
                'ownerUserId',
                'nodeId',
                'details',
                'occurredAt',
            ].sort(),
        );
        expect(table?.indices.map((index) => index.name).sort()).toEqual(
            ['idx_fleet_audit_action_occurred', 'idx_fleet_audit_owner_occurred'].sort(),
        );
    });

    it('is idempotent: a re-run neither throws nor duplicates the seeded row', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();

        const rows = await dataSource.query(`SELECT id FROM fleet_kill_switch`);
        expect(rows).toEqual([{ id: 'global' }]);
    });

    it('does not overwrite a switch an operator has already thrown', async () => {
        await runUp();
        await dataSource.query(
            `UPDATE fleet_kill_switch SET stopped = 1, reason = 'incident' WHERE id = 'global'`,
        );

        await runUp();

        const rows = await dataSource.query(
            `SELECT stopped, reason FROM fleet_kill_switch WHERE id = 'global'`,
        );
        expect(Boolean(rows[0].stopped)).toBe(true);
        expect(rows[0].reason).toBe('incident');
    });

    it('down drops both tables', async () => {
        await runUp();
        await runDown();

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('fleet_kill_switch')).toBe(false);
        expect(await runner.hasTable('fleet_audit')).toBe(false);
        await runner.release();
    });
});
