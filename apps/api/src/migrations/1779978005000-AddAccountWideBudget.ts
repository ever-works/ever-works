import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.6.
 *
 * Adds the account-wide budget knobs to `work_agent_preferences`
 * (spec §5.1 + §6.6, Decision A28). Drives the Dashboard
 * `Month Spend` tile and the `#account-budgets` settings sub-section
 * that ship in Phase 7 PR II.
 *
 * Columns added on `work_agent_preferences`:
 *
 *   - `accountWideMonthlyCapCents` (bigint, NULL)
 *       Spend cap in cents across ALL of the user's Works + Ideas
 *       + Missions for the current billing period. NULL = no
 *       account-wide cap (per-Work and per-Mission caps still
 *       apply independently). `bigint` rather than `int` because
 *       monthly cents can plausibly exceed the int32 ceiling
 *       ($21,474/mo) for power users running many Missions on
 *       auto-build at high cadence.
 *
 *   - `accountWideAllowOverage` (boolean, NOT NULL, default true)
 *       Soft (true, alerts only) vs hard (false, BudgetGuardService
 *       blocks) cap semantics. Default `true` matches the per-Work
 *       `WorkBudget.allowOverage` default for consistency. Ignored
 *       when `accountWideMonthlyCapCents` IS NULL.
 *
 * Behavior at deploy time: existing user rows get NULL cap +
 * `allowOverage=true` — i.e. no account-wide guard kicks in until
 * the user explicitly sets a cap from settings. Safe to roll out
 * ahead of Phase 7 PR II.
 *
 * Idempotent and reversible.
 */
export class AddAccountWideBudget1779978005000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (
            !(await queryRunner.hasColumn('work_agent_preferences', 'accountWideMonthlyCapCents'))
        ) {
            await queryRunner.addColumn(
                'work_agent_preferences',
                new TableColumn({
                    name: 'accountWideMonthlyCapCents',
                    type: 'bigint',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('work_agent_preferences', 'accountWideAllowOverage'))) {
            await queryRunner.addColumn(
                'work_agent_preferences',
                new TableColumn({
                    name: 'accountWideAllowOverage',
                    type: 'boolean',
                    isNullable: false,
                    default: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('work_agent_preferences', 'accountWideAllowOverage')) {
            await queryRunner.dropColumn('work_agent_preferences', 'accountWideAllowOverage');
        }
        if (await queryRunner.hasColumn('work_agent_preferences', 'accountWideMonthlyCapCents')) {
            await queryRunner.dropColumn('work_agent_preferences', 'accountWideMonthlyCapCents');
        }
    }
}
