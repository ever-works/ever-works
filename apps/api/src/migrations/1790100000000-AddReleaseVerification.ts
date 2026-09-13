import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809) — the
 * `verify*` / `revert*` columns on `release_promotions`, plus the one
 * column on `works` that says WHERE a deployed environment can be observed.
 *
 * Entities:
 *   `packages/agent/src/entities/release-promotion.entity.ts`
 *   `packages/agent/src/entities/work.entity.ts` (`releaseVerification`)
 *
 * ## `works.releaseVerification`
 *
 * The per-environment `{ versionUrl, appUrl, appExpectText }` map, as
 * platform state, beside the `releaseLadder` slice AI added. NULL on every
 * existing row, which is both the correct history and the correct default:
 * a merged promotion for a Work with no target is recorded `unsupported`
 * and reported to its owner as NOT VERIFIED. It is never read as a pass —
 * "nobody configured a URL" and "the deployment is healthy" must not be
 * the same reading.
 *
 * `text` here and `simple-json` on the entity, matching exactly how
 * `releaseLadder` shipped in `1790000000000`, and read back only through
 * `sanitizeReleaseVerificationTargets` — these URLs are loaded by a real
 * browser on somebody's PC.
 *
 * ## Why the verification lives on the promotion row
 *
 * One promotion has exactly one deployment to verify, for ever. A separate
 * table would buy nothing and cost a join on every operator read, and "the
 * verdict is visible ON the promotion" is the requirement.
 *
 * ## The two columns that make the lane bounded
 *
 * `verifyAttempts` and `verifyDeadlineAt`. Whichever is reached first ends
 * the verification as `inconclusive`. Two independent stops rather than
 * one, because a cap counted in attempts survives a clock that jumps and a
 * deadline survives a sweep that runs far more often than intended.
 *
 * ## `verifyJobId` is the mutual exclusion
 *
 * The sweep claims an attempt with `WHERE verifyJobId IS NULL`, so at most
 * one browser is ever pointed at one environment for one promotion however
 * many API replicas are running. Deliberately NOT indexed on its own: the
 * completion listener's lookup by job id is a single-row hit on a table
 * with two rows a week, and the sweep's index below already covers the one
 * query that runs on a schedule.
 *
 * ## `revertTaskId` records an OFFER, not an act
 *
 * There is deliberately no `revertedAt`, no `revertPrNumber` and no
 * `revertMergedAt` on this table, and there never should be. The platform
 * does not revert production: it files a Task holding the coordinates and
 * stops, and landing whatever pull request that Task eventually produces
 * goes through the same `merge_pull_request` Inbox approval as every other
 * merge. A column that could record "we reverted" would be the first sign
 * somebody had built the thing this slice refuses to build.
 *
 * FK: `revertTaskId` → `tasks.id` SET NULL, the same choice
 * `1790000000000` made for `taskId` and for the same reason — deleting the
 * Task must not erase the record that a revert was offered, and CASCADE
 * would delete the promotion's whole history with it.
 *
 * Forward-only + idempotent (`findColumnByName` guards), and portable
 * `TableColumn` DDL rather than raw SQL, because production runs Postgres
 * while CI runs better-sqlite3.
 */
export class AddReleaseVerification1790100000000 implements MigrationInterface {
    name = 'AddReleaseVerification1790100000000';

    private static readonly PROMOTION_COLUMNS = [
        // `awaiting-rollout` | `checking-app` | `confirming-failure` |
        // `passed` | `failed` | `inconclusive` | `unsupported`.
        // NULL = never started, which is NOT a pass.
        new TableColumn({ name: 'verifyState', type: 'varchar', length: '24', isNullable: true }),
        // THE artefact identity: the base branch's tip read immediately
        // after the merge, which is what the environment must be SERVING
        // before this lane says anything. Not `headSha` — the merge makes a
        // new commit and the pull-request status carries no merge sha.
        new TableColumn({
            name: 'verifyExpectedSha',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
        new TableColumn({
            name: 'verifyTargetUrl',
            type: 'varchar',
            length: '512',
            isNullable: true,
        }),
        new TableColumn({ name: 'verifyStartedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'verifyDeadlineAt', type: 'timestamp', isNullable: true }),
        // Bound #1. Not nullable, defaulted, so an existing row backfills
        // to 0 and an unstarted verification cannot look part-way through.
        new TableColumn({ name: 'verifyAttempts', type: 'int', default: 0 }),
        // Consecutive same-direction results in the current state.
        new TableColumn({ name: 'verifyStreak', type: 'int', default: 0 }),
        new TableColumn({ name: 'verifyJobId', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({ name: 'verifyRetryAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'verifyCheckedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'verifyDetail', type: 'varchar', length: '512', isNullable: true }),
        // The Task that OFFERS a revert. Never a Task that performed one.
        new TableColumn({ name: 'revertTaskId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'revertOfferedAt', type: 'timestamp', isNullable: true }),
    ];

    private static readonly WORK_COLUMN = new TableColumn({
        name: 'releaseVerification',
        type: 'text',
        isNullable: true,
    });

    /**
     * The verification sweep's ONLY query: live rows whose next probe is
     * due. Without it a cron running every few minutes table-scans
     * `release_promotions` for ever.
     */
    private static readonly SWEEP_INDEX = new TableIndex({
        name: 'idx_release_promotions_verify',
        columnNames: ['verifyState', 'verifyRetryAt'],
    });

    private static readonly REVERT_TASK_FK = new TableForeignKey({
        name: 'fk_release_promotions_revert_task',
        columnNames: ['revertTaskId'],
        referencedTableName: 'tasks',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const works = await queryRunner.getTable('works');
        if (works && !works.findColumnByName('releaseVerification')) {
            await queryRunner.addColumn('works', AddReleaseVerification1790100000000.WORK_COLUMN);
        }

        const promotions = await queryRunner.getTable('release_promotions');
        if (!promotions) {
            // `1790000000000-CreateReleasePromotions` has not run. TypeORM
            // runs migrations in timestamp order, so this cannot happen in
            // a normal boot; returning beats throwing on a hand-rolled
            // database that is missing the table entirely.
            return;
        }

        for (const column of AddReleaseVerification1790100000000.PROMOTION_COLUMNS) {
            if (!promotions.findColumnByName(column.name)) {
                await queryRunner.addColumn('release_promotions', column);
            }
        }

        const withColumns = await queryRunner.getTable('release_promotions');
        if (
            withColumns &&
            !withColumns.indices.some((index) => index.name === 'idx_release_promotions_verify')
        ) {
            await queryRunner.createIndex(
                'release_promotions',
                AddReleaseVerification1790100000000.SWEEP_INDEX,
            );
        }
        if (
            withColumns &&
            !withColumns.foreignKeys.some((fk) => fk.name === 'fk_release_promotions_revert_task')
        ) {
            await queryRunner.createForeignKey(
                'release_promotions',
                AddReleaseVerification1790100000000.REVERT_TASK_FK,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const promotions = await queryRunner.getTable('release_promotions');
        if (promotions) {
            const fk = promotions.foreignKeys.find(
                (candidate) => candidate.name === 'fk_release_promotions_revert_task',
            );
            if (fk) {
                await queryRunner.dropForeignKey('release_promotions', fk);
            }
            const index = promotions.indices.find(
                (candidate) => candidate.name === 'idx_release_promotions_verify',
            );
            if (index) {
                await queryRunner.dropIndex('release_promotions', index);
            }
            // `dropColumn` rather than a raw `ALTER TABLE … DROP COLUMN`:
            // the query runner rebuilds the table on drivers that cannot
            // drop a column in place, which is exactly the driver CI uses.
            // Re-read the table between drops for the same reason — each
            // rebuild produces a NEW Table object and the stale one's
            // columns no longer describe what exists.
            for (const column of AddReleaseVerification1790100000000.PROMOTION_COLUMNS) {
                const table = await queryRunner.getTable('release_promotions');
                const existing = table?.findColumnByName(column.name);
                if (existing) {
                    await queryRunner.dropColumn('release_promotions', existing);
                }
            }
        }

        const works = await queryRunner.getTable('works');
        if (works) {
            const column = works.findColumnByName('releaseVerification');
            if (column) {
                await queryRunner.dropColumn('works', column);
            }
        }
    }
}
