import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Quality gates — schema for Task acceptance checks (Wave 3 M1).
 *
 * An acceptance check is a named command whose exit code decides whether an
 * agent run is green or red. Tasks declare checks, Works carry defaults, and
 * agent runs snapshot the resolved list plus per-check results. This
 * migration is schema only — the runner ships in a later milestone.
 *
 * Entities:
 *   - `packages/agent/src/entities/task.entity.ts`
 *   - `packages/agent/src/entities/agent-run.entity.ts`
 *   - `packages/agent/src/entities/work.entity.ts`
 *
 * **Schema notes:**
 *   - `simple-json` entity columns are plain `text` at the DB level, matching
 *     the convention used by `tasks.labels` / `works.configCache`.
 *   - `tasks.maxGateAttempts` is NULLABLE (null = inherit the Work) while
 *     `works.maxGateAttempts` is NOT NULL DEFAULT 2 — the Work is the end of
 *     the inheritance chain, so it must always hold a concrete value.
 *   - `works.checksPolicy` NOT NULL DEFAULT 'off': existing Works keep
 *     exactly today's behaviour; checks only run for Works that opt in.
 *   - `agent_runs.gateStatus` varchar(12) fits every `GateStatus` member and
 *     is nullable because pre-gate runs have no gate outcome to report.
 *   - `agent_runs.gateAttempts` NOT NULL DEFAULT 0 so existing rows read as
 *     "never attempted" rather than unknown.
 *
 * Forward-only and idempotent (getTable + findColumnByName guards) so a
 * partially-applied run is safe to repeat.
 */
export class AddQualityGateColumns1782800000000 implements MigrationInterface {
    name = 'AddQualityGateColumns1782800000000';

    private static readonly COLUMNS: ReadonlyArray<{ table: string; column: TableColumn }> = [
        {
            table: 'tasks',
            column: new TableColumn({ name: 'acceptanceChecks', type: 'text', isNullable: true }),
        },
        {
            table: 'tasks',
            column: new TableColumn({ name: 'maxGateAttempts', type: 'int', isNullable: true }),
        },
        {
            table: 'agent_runs',
            column: new TableColumn({ name: 'resolvedChecks', type: 'text', isNullable: true }),
        },
        {
            table: 'agent_runs',
            column: new TableColumn({ name: 'checkResults', type: 'text', isNullable: true }),
        },
        {
            table: 'agent_runs',
            column: new TableColumn({
                name: 'gateStatus',
                type: 'varchar',
                length: '12',
                isNullable: true,
            }),
        },
        {
            table: 'agent_runs',
            column: new TableColumn({
                name: 'gateAttempts',
                type: 'int',
                isNullable: false,
                default: 0,
            }),
        },
        {
            table: 'works',
            column: new TableColumn({ name: 'checkDefaults', type: 'text', isNullable: true }),
        },
        {
            table: 'works',
            column: new TableColumn({
                name: 'checksPolicy',
                type: 'varchar',
                length: '12',
                isNullable: false,
                default: "'off'",
            }),
        },
        {
            table: 'works',
            column: new TableColumn({
                name: 'maxGateAttempts',
                type: 'int',
                isNullable: false,
                default: 2,
            }),
        },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const { table, column } of AddQualityGateColumns1782800000000.COLUMNS) {
            // Guarded per column, not per table: a partially-applied previous
            // attempt must be completable on re-run, never permanent.
            if (!(await queryRunner.hasTable(table))) {
                continue;
            }
            const existing = await queryRunner.getTable(table);
            if (existing?.findColumnByName(column.name)) {
                continue;
            }
            // clone() so the shared static definition is never mutated by a
            // driver that normalizes the TableColumn it receives.
            await queryRunner.addColumn(table, column.clone());
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const { table, column } of [...AddQualityGateColumns1782800000000.COLUMNS].reverse()) {
            if (!(await queryRunner.hasTable(table))) {
                continue;
            }
            const existing = await queryRunner.getTable(table);
            if (!existing?.findColumnByName(column.name)) {
                continue;
            }
            await queryRunner.dropColumn(table, column.name);
        }
    }
}
