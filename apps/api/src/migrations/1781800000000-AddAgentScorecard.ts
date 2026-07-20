import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agent Scorecards increment 1 — adds the nullable `agents.scorecard`
 * column backing `Agent.scorecard` (`simple-json` array of
 * `AgentScorecardMetric`: quantified per-Agent goals so an AI worker's
 * output is measurable). TypeORM stores `simple-json` as `text` on
 * both Postgres and sqlite, so the column type is `text` here.
 *
 * Forward-only and idempotent (`hasColumn` guard on both directions).
 * Nullable with no backfill — null = no scorecard configured.
 *
 * Follow-ups (not in this increment): auto-updating `current` from run
 * output, and the org-dashboard at-risk roll-up.
 */
export class AddAgentScorecard1781800000000 implements MigrationInterface {
    name = 'AddAgentScorecard1781800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('agents', 'scorecard'))) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'scorecard', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('agents', 'scorecard')) {
            await queryRunner.dropColumn('agents', 'scorecard');
        }
    }
}
