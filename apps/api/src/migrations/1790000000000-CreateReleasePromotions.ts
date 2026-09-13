import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the
 * `release_promotions` table plus the one column on `works` that says
 * which branches a promotion is allowed to touch.
 *
 * Entities:
 *   `packages/agent/src/entities/release-promotion.entity.ts`
 *   `packages/agent/src/entities/work.entity.ts` (`releaseLadder`)
 *
 * ## `works.releaseLadder`
 *
 * The `integration → staging → production` triple, as platform state.
 * NULL on every existing row, which is the correct history and the
 * correct default: a Work whose ladder nobody has declared has no release
 * lane, and `POST /works/:id/promotions` refuses rather than guessing
 * `main`. `simple-json` to match the other JSON columns on `works`
 * (`communityPrState`, `worksConfigSnapshot`), and read back only through
 * `sanitizeReleaseLadder` — the branch names end up in a pull request's
 * `head`/`base`.
 *
 * ## `release_promotions.laneKey` — THE load-bearing constraint
 *
 * UNIQUE `(workId, rung, laneKey)` is what stops two merges to `develop`
 * seconds apart opening two competing `develop → stage` pull requests,
 * and what stops a re-run opening a second one.
 *
 * The constraint we actually want is "at most one OPEN promotion per
 * (Work, rung)". Postgres can say that directly (`CREATE UNIQUE INDEX …
 * WHERE state = 'open'`); better-sqlite3 — which CI and the e2e stack run
 * — cannot, and a constraint that behaves differently on the two
 * databases is a race that only ever reproduces in production. So it is
 * carried in a VALUE instead: every live promotion writes the literal
 * `'open'` into `laneKey` and therefore collides, and every terminal one
 * writes `'<state>:<id>'` and therefore does not. One index, identical
 * semantics on both drivers.
 *
 * FKs: `userId` → `users.id` and `workId` → `works.id` CASCADE (a
 * promotion is meaningless without either). `taskId` → `tasks.id` SET
 * NULL rather than CASCADE: deleting the reporting Task must not delete
 * the record that a promotion was opened, and a promotion row with a
 * dangling `taskId` would let the merge guard resolve a promotion for
 * somebody else's Task.
 *
 * Forward-only + idempotent (`hasTable` / `findColumnByName` guards), and
 * portable `Table`/`TableColumn` DDL rather than raw SQL, because
 * production runs Postgres while CI runs better-sqlite3.
 */
export class CreateReleasePromotions1790000000000 implements MigrationInterface {
    name = 'CreateReleasePromotions1790000000000';

    private static readonly WORK_COLUMN = new TableColumn({
        name: 'releaseLadder',
        type: 'text',
        isNullable: true,
    });

    private static readonly LANE_INDEX = new TableIndex({
        name: 'uq_release_promotions_lane',
        columnNames: ['workId', 'rung', 'laneKey'],
        isUnique: true,
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const works = await queryRunner.getTable('works');
        if (works && !works.findColumnByName('releaseLadder')) {
            await queryRunner.addColumn('works', CreateReleasePromotions1790000000000.WORK_COLUMN);
        }

        if (await queryRunner.hasTable('release_promotions')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'release_promotions',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'workId', type: 'uuid' },
                    { name: 'taskId', type: 'uuid', isNullable: true },
                    { name: 'rung', type: 'varchar', length: '32' },
                    { name: 'headBranch', type: 'varchar', length: '128' },
                    { name: 'baseBranch', type: 'varchar', length: '128' },
                    { name: 'headSha', type: 'varchar', length: '64', isNullable: true },
                    { name: 'headRecordedAt', type: 'timestamp', isNullable: true },
                    { name: 'prNumber', type: 'int', isNullable: true },
                    { name: 'prUrl', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'state', type: 'varchar', length: '16', default: "'open'" },
                    { name: 'laneKey', type: 'varchar', length: '64', default: "'open'" },
                    { name: 'gateWorkflow', type: 'varchar', length: '128' },
                    { name: 'gateVerdict', type: 'varchar', length: '16', isNullable: true },
                    { name: 'gateVerdictSha', type: 'varchar', length: '64', isNullable: true },
                    // Was the gate's E2E leg WAIVED rather than green for
                    // `gateVerdictSha`? `promotion-gate.yml` exits 0 on the
                    // `override-e2e-gate` label, and GitHub folds that back
                    // into a plain `success` run conclusion — so without
                    // this the lane cannot tell a human that the leg was
                    // overridden rather than green.
                    { name: 'gateOverridden', type: 'boolean', default: false },
                    { name: 'gateCheckedAt', type: 'timestamp', isNullable: true },
                    { name: 'gateRunUrl', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'refusalCode', type: 'varchar', length: '64', isNullable: true },
                    { name: 'inboxFiledForSha', type: 'varchar', length: '64', isNullable: true },
                    // The (commit, reading) pair the one Inbox notice was
                    // filed for. Both halves, because keying on the commit
                    // alone let a `pending` reading past the grace window
                    // consume the slot and suppress the verdict that
                    // actually decided the promotion.
                    { name: 'inboxFiledVerdict', type: 'varchar', length: '16', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // At most one OPEN promotion per (Work, rung) — see the header.
        await queryRunner.createIndex(
            'release_promotions',
            CreateReleasePromotions1790000000000.LANE_INDEX,
        );

        // "Which promotion does this Task report?" — one row, but a plain
        // index: a Task's promotion is looked up on every PR-status
        // refresh, and history rows keep pointing at their Tasks.
        await queryRunner.createIndex(
            'release_promotions',
            new TableIndex({ name: 'idx_release_promotions_task', columnNames: ['taskId'] }),
        );

        // "Is there an open promotion for this Work?" for the operator list.
        await queryRunner.createIndex(
            'release_promotions',
            new TableIndex({
                name: 'idx_release_promotions_work_state',
                columnNames: ['workId', 'state'],
            }),
        );

        await queryRunner.createForeignKey(
            'release_promotions',
            new TableForeignKey({
                name: 'fk_release_promotions_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createForeignKey(
            'release_promotions',
            new TableForeignKey({
                name: 'fk_release_promotions_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createForeignKey(
            'release_promotions',
            new TableForeignKey({
                name: 'fk_release_promotions_task',
                columnNames: ['taskId'],
                referencedTableName: 'tasks',
                referencedColumnNames: ['id'],
                // SET NULL, not CASCADE: deleting the reporting Task must
                // not erase the record that a promotion happened, and a
                // dangling taskId would let the merge guard resolve this
                // promotion for whatever Task later took that id.
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('release_promotions')) {
            await queryRunner.dropTable('release_promotions', true);
        }

        const works = await queryRunner.getTable('works');
        if (works) {
            // `dropColumn` rather than a raw `ALTER TABLE … DROP COLUMN`:
            // the query runner rebuilds the table on drivers that cannot
            // drop a column in place, which is exactly the driver CI uses.
            const column = works.findColumnByName('releaseLadder');
            if (column) {
                await queryRunner.dropColumn('works', column);
            }
        }
    }
}
