import type { QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Phase-2 of the Directory→Work rename: rename the DB-bound identifiers.
 *
 * The first rename PRs (#419, #420, #421, #422, #423) deliberately kept
 * the legacy table/column names so existing prod data kept loading. This
 * routine finishes the job:
 *
 *   tables           directories                       → works
 *                    directory_advanced_prompts        → work_advanced_prompts
 *                    directory_custom_domains          → work_custom_domains
 *                    directory_generation_history      → work_generation_history
 *                    directory_members                 → work_members
 *                    directory_schedules               → work_schedules
 *                    directory_plugins                 → work_plugins
 *
 *   FK columns       directoryId                       → workId
 *                    (across activity_log, usage_ledger_entries, and the
 *                    7 work_* tables above)
 *
 *   JSON keys        works.sourceRepository.relatedRepositories.directory  → .work
 *                    works.repoVisibility.directory                        → .work
 *
 *   enum values      activity_log.actionType
 *                       'directory_created'  → 'work_created'
 *                       'directory_updated'  → 'work_updated'
 *                       'directory_deleted'  → 'work_deleted'
 *
 * Idempotent at every step (checks for the OLD presence before each
 * rename), so it's safe to re-run, partially-apply, or run on a fresh DB
 * created by `synchronize: true` against the new entity names.
 *
 * Runs from two places that share this implementation:
 *   1. apps/api/src/migrations/1762200000000-RenameDirectoriesToWorks.ts
 *      — for environments that use the standard TypeORM migration runner.
 *   2. packages/agent/src/database/database.module.ts dataSourceFactory
 *      — runs at app boot BEFORE synchronize, so production databases
 *        with `DATABASE_AUTOMIGRATE=true` get the rename applied before
 *        synchronize creates empty `works` tables and orphans the legacy
 *        `directories` data.
 */
export async function runRenameDirectoriesToWorks(
    queryRunner: QueryRunner,
    logger: Logger = new Logger('RenameDirectoriesToWorks'),
): Promise<{ renamedTables: string[]; renamedColumns: string[]; updatedRows: number }> {
    const renamedTables: string[] = [];
    const renamedColumns: string[] = [];
    let updatedRows = 0;

    const tableRenames: Array<{ from: string; to: string }> = [
        { from: 'directories', to: 'works' },
        { from: 'directory_advanced_prompts', to: 'work_advanced_prompts' },
        { from: 'directory_custom_domains', to: 'work_custom_domains' },
        { from: 'directory_generation_history', to: 'work_generation_history' },
        { from: 'directory_members', to: 'work_members' },
        { from: 'directory_schedules', to: 'work_schedules' },
        { from: 'directory_plugins', to: 'work_plugins' },
    ];

    // 1. Rename tables.
    for (const { from, to } of tableRenames) {
        const oldExists = await queryRunner.hasTable(from);
        const newExists = await queryRunner.hasTable(to);
        if (oldExists && !newExists) {
            await queryRunner.renameTable(from, to);
            renamedTables.push(`${from} → ${to}`);
        }
    }

    // 2. Rename `directoryId` → `workId` columns.
    const directoryIdHosts = [
        'activity_log',
        'usage_ledger_entries',
        'works',
        'work_advanced_prompts',
        'work_custom_domains',
        'work_generation_history',
        'work_members',
        'work_schedules',
        'work_plugins',
    ];
    for (const table of directoryIdHosts) {
        if (!(await queryRunner.hasTable(table))) continue;
        const hasOld = await queryRunner.hasColumn(table, 'directoryId');
        const hasNew = await queryRunner.hasColumn(table, 'workId');
        if (hasOld && !hasNew) {
            await queryRunner.renameColumn(table, 'directoryId', 'workId');
            renamedColumns.push(`${table}.directoryId → workId`);
        }
    }

    // 3. Migrate persisted JSON keys in `works`.
    //    The columns are TypeORM `simple-json` (text). Both keys are unique
    //    inside their respective objects, so a literal text REPLACE of the
    //    `"directory":` key marker is safe (no other field in those JSONs
    //    is named "directory").
    const escape = (id: string) => queryRunner.connection.driver.escape(id);
    if (await queryRunner.hasTable('works')) {
        if (await queryRunner.hasColumn('works', 'sourceRepository')) {
            const col = escape('sourceRepository');
            const res = await queryRunner.query(
                `UPDATE works SET ${col} = REPLACE(${col}, '"directory":', '"work":') WHERE ${col} LIKE '%"directory":%'`,
            );
            const affected = extractAffected(res);
            updatedRows += affected;
            if (affected > 0) {
                logger.log(`works.sourceRepository: rewrote "directory" key in ${affected} rows`);
            }
        }
        if (await queryRunner.hasColumn('works', 'repoVisibility')) {
            const col = escape('repoVisibility');
            const res = await queryRunner.query(
                `UPDATE works SET ${col} = REPLACE(${col}, '"directory":', '"work":') WHERE ${col} LIKE '%"directory":%'`,
            );
            const affected = extractAffected(res);
            updatedRows += affected;
            if (affected > 0) {
                logger.log(`works.repoVisibility: rewrote "directory" key in ${affected} rows`);
            }
        }
    }

    // 4. Migrate activity_log.actionType enum values.
    if (await queryRunner.hasTable('activity_log')) {
        const col = escape('actionType');
        for (const [from, to] of [
            ['directory_created', 'work_created'],
            ['directory_updated', 'work_updated'],
            ['directory_deleted', 'work_deleted'],
        ] as const) {
            const res = await queryRunner.query(
                `UPDATE activity_log SET ${col} = '${to}' WHERE ${col} = '${from}'`,
            );
            const affected = extractAffected(res);
            updatedRows += affected;
            if (affected > 0) {
                logger.log(`activity_log.actionType: ${from} → ${to} in ${affected} rows`);
            }
        }
    }

    if (renamedTables.length || renamedColumns.length || updatedRows) {
        logger.log(
            `Rename complete: ${renamedTables.length} tables, ${renamedColumns.length} columns, ${updatedRows} rows updated`,
        );
    }

    return { renamedTables, renamedColumns, updatedRows };
}

/**
 * TypeORM's queryRunner.query() returns different shapes per driver.
 *  - postgres : [rows, affected]   (affected is a number or undefined)
 *  - sqlite   : { changes: N, ... }
 *  - mysql    : { affectedRows: N, ... }
 * Best-effort extraction; defaults to 0 when the shape is unrecognized
 * (we only use this for log lines, never for control flow).
 */
function extractAffected(result: unknown): number {
    if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
        return result[1];
    }
    if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (typeof r.changes === 'number') return r.changes;
        if (typeof r.affectedRows === 'number') return r.affectedRows;
    }
    return 0;
}
