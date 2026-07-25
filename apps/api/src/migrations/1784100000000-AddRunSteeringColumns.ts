import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Run steering (Wave 4 M5) — the two `agent_runs` columns the
 * steer / interrupt loop needs.
 *
 *  - `pendingInput`       — persisted FIFO queue of steering messages
 *                           waiting to be injected into the LIVE run.
 *                           `simple-json` on the entity, which is plain
 *                           `text` at the DB level on every supported
 *                           driver (Postgres in prod, sqlite in e2e).
 *  - `interruptRequested` — boolean NOT NULL DEFAULT false; cooperative
 *                           stop request the tool loop honours between
 *                           iterations.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1783100000000-AddRunOrchestrationColumns). No index: both columns are
 * only ever read by primary key (the executing run reads its own row).
 */
export class AddRunSteeringColumns1784100000000 implements MigrationInterface {
    name = 'AddRunSteeringColumns1784100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('pendingInput', `"pendingInput" text`);
        await addColumn(
            'interruptRequested',
            `"interruptRequested" boolean NOT NULL DEFAULT false`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        for (const col of ['interruptRequested', 'pendingInput']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "${col}"`);
            }
        }
    }
}
