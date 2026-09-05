import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Issue / incident intake (self-build program note §6, EW-804) —
 * `external_issue_links.regressionCount`.
 *
 * The triage filer keeps ONE Task per `(userId, source,
 * externalIssueId)`; every later revision of the same issue is a comment
 * on it. That is what stops a Sentry issue alerting two thousand times
 * from filing two thousand Tasks. It also, before this column existed,
 * meant an issue that was fixed, closed and then CAME BACK could only
 * ever add a comment to a Task nobody looks at any more.
 *
 * The filer now files a fresh Task for a vendor regression signal that
 * arrives while the linked Task is already closed, re-points the dedup
 * row at it, and increments this counter. The counter is not the dedup
 * key (that is still the unique `(userId, source, externalIssueId)`
 * index, untouched) — it is the audit trail for the one case where dedup
 * deliberately yields, so "why are there three Tasks for this issue?"
 * can be answered from the row instead of from the drain's logs.
 *
 * NOT NULL with a `0` default, so every existing link reads the honest
 * "this issue has never re-opened work" and no writer has to learn about
 * the column. Forward-only with a guard so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres. `down()` goes through
 * the query runner's `dropColumn` rather than a raw
 * `ALTER TABLE … DROP COLUMN`: sqlite only learned that statement in
 * 3.35 and the raw form desynchronises the runner's table metadata.
 */
export class AddExternalIssueLinkRegressionCount1789600000000 implements MigrationInterface {
    name = 'AddExternalIssueLinkRegressionCount1789600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const links = await queryRunner.getTable('external_issue_links');
        if (!links) return;
        if (links.findColumnByName('regressionCount')) return;

        await queryRunner.addColumn(
            'external_issue_links',
            new TableColumn({
                name: 'regressionCount',
                type: 'int',
                isNullable: false,
                default: 0,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const links = await queryRunner.getTable('external_issue_links');
        if (!links) return;
        if (!links.findColumnByName('regressionCount')) return;

        await queryRunner.dropColumn('external_issue_links', 'regressionCount');
    }
}
