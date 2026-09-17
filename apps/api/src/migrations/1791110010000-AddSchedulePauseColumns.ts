import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Schedules — a reversible pause for recurring Tasks and Agent heartbeats.
 *
 * Entities:
 *   `packages/agent/src/entities/task.entity.ts`  (`recurrencePausedAt`)
 *   `packages/agent/src/entities/agent.entity.ts` (`heartbeatPausedAt`)
 *
 * ## Why
 *
 * Until now the only way to stop a recurring Task was
 * `DELETE /api/tasks/:id/recurring`, which wipes the cadence, and the only
 * way to stop a heartbeat was to pause the whole Agent, which also stops its
 * assigned Task work. Both columns are a pause that keeps everything else.
 *
 * ## Two nullable timestamp columns
 *
 *  1. `tasks.recurrencePausedAt` — non-null = the recurrence due-scan skips
 *     the template. The cadence, `nextOccurrenceAt` and every bound are left
 *     exactly as they are.
 *  2. `agents.heartbeatPausedAt` — non-null = the heartbeat due-scan skips
 *     the Agent. Orthogonal to `agents.status`.
 *
 * **No backfill.** `NULL` on every existing row means "not paused", which is
 * precisely today's behaviour — nothing fires differently on deploy.
 *
 * ## Two composite indexes, added BESIDE the existing ones
 *
 * `idx_tasks_recurrence_due_active (isRecurring, recurrencePausedAt,
 * nextOccurrenceAt)` and `idx_agents_heartbeat_due (status,
 * heartbeatPausedAt, nextHeartbeatAt)` serve the new due-scan predicates.
 * `idx_tasks_recurrence_due` and `idx_agents_next_heartbeat` are untouched,
 * so an application rollback without a schema rollback still finds a usable
 * index.
 *
 * Forward-only with existence guards so a partially applied database
 * converges; portable `TableColumn` DDL because CI and the e2e stack run
 * better-sqlite3 while production runs Postgres. `down()` drops exactly what
 * `up()` added, in reverse, re-reading the table between steps because
 * sqlite rebuilds the table on every column change.
 */
export class AddSchedulePauseColumns1791110010000 implements MigrationInterface {
    name = 'AddSchedulePauseColumns1791110010000';

    private static readonly TARGETS = [
        {
            table: 'tasks',
            column: 'recurrencePausedAt',
            indexName: 'idx_tasks_recurrence_due_active',
            index: new TableIndex({
                name: 'idx_tasks_recurrence_due_active',
                columnNames: ['isRecurring', 'recurrencePausedAt', 'nextOccurrenceAt'],
            }),
        },
        {
            table: 'agents',
            column: 'heartbeatPausedAt',
            indexName: 'idx_agents_heartbeat_due',
            index: new TableIndex({
                name: 'idx_agents_heartbeat_due',
                columnNames: ['status', 'heartbeatPausedAt', 'nextHeartbeatAt'],
            }),
        },
    ] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const target of AddSchedulePauseColumns1791110010000.TARGETS) {
            const table = await queryRunner.getTable(target.table);
            // Ordering safety: a database that has not created the owning
            // table yet has nothing to pause.
            if (!table) continue;
            if (!table.findColumnByName(target.column)) {
                await queryRunner.addColumn(
                    target.table,
                    new TableColumn({ name: target.column, type: 'timestamp', isNullable: true }),
                );
            }
            // Re-read: on sqlite the addColumn above rebuilt the table.
            const afterAdd = await queryRunner.getTable(target.table);
            const hasEveryIndexColumn = target.index.columnNames.every((name) =>
                afterAdd?.findColumnByName(name),
            );
            if (
                afterAdd &&
                hasEveryIndexColumn &&
                !afterAdd.indices.some((existing) => existing.name === target.indexName)
            ) {
                await queryRunner.createIndex(target.table, target.index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const target of [...AddSchedulePauseColumns1791110010000.TARGETS].reverse()) {
            const table = await queryRunner.getTable(target.table);
            if (!table) continue;
            if (table.indices.some((existing) => existing.name === target.indexName)) {
                await queryRunner.dropIndex(target.table, target.indexName);
            }
            const afterIndex = await queryRunner.getTable(target.table);
            const existing = afterIndex?.findColumnByName(target.column);
            if (existing) {
                await queryRunner.dropColumn(target.table, existing);
            }
        }
    }
}
