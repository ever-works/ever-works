import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

/**
 * Environments (Settings → Environments) — `agents.environmentId`.
 *
 * Nullable FK to `environments.id`: which runtime Environment this Agent
 * executes in. NULL = platform default runtime (exactly the
 * pre-Environments behavior), so nothing is backfilled — every existing
 * Agent keeps NULL and behaves identically.
 *
 * FK is ON DELETE SET NULL as a belt-and-braces guard: the service
 * already refuses to delete an Environment while any Agent references it
 * (409), so the DB-level SET NULL only ever fires on paths that bypass
 * the service — where silently falling back to the default runtime is
 * the safe outcome (vs. blocking user deletion or a dangling id).
 *
 * No index: the column is only ever read off an already-loaded Agent row
 * (per-run resolution) and counted by the delete guard, which is rare
 * and bounded per-user.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784800000000-AddTaskDelegationDepth).
 */
export class AddAgentEnvironmentId1786810001000 implements MigrationInterface {
    name = 'AddAgentEnvironmentId1786810001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agents');
        if (!table) return;

        if (!table.findColumnByName('environmentId')) {
            await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN "environmentId" uuid`);
        }

        // FK only when both tables exist (fresh sqlite e2e databases
        // build the whole schema through migrations in order, so
        // `environments` exists by now; the guard is for partial schemas).
        const hasFk = (await queryRunner.getTable('agents'))?.foreignKeys.some(
            (fk) => fk.name === 'fk_agents_environment',
        );
        if (!hasFk && (await queryRunner.hasTable('environments'))) {
            await queryRunner.createForeignKey(
                'agents',
                new TableForeignKey({
                    name: 'fk_agents_environment',
                    columnNames: ['environmentId'],
                    referencedTableName: 'environments',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agents');
        if (!table) return;

        const fk = table.foreignKeys.find((f) => f.name === 'fk_agents_environment');
        if (fk) {
            await queryRunner.dropForeignKey('agents', fk);
        }

        // Safe to drop: the column carries an assignment pointer, not
        // content — reverting returns every Agent to the default runtime.
        if (table.findColumnByName('environmentId')) {
            await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "environmentId"`);
        }
    }
}
