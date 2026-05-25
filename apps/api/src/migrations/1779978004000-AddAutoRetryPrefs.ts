import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.5.
 *
 * Adds the user-configurable Auto-retry policy fields to
 * `work_agent_preferences` (spec §3.9, §6.6 / Decision A23).
 *
 * Unlike PR 0.4 (which added 4 nullable "promoted constant"
 * columns that the read path treats as "use platform default
 * when NULL"), these 3 columns are NOT NULL with explicit
 * defaults. Reason: the auto-retry policy is **behavior-affecting
 * from day one** — once PR FF (Phase 1) wires the retry handler,
 * every existing user should immediately benefit from the policy
 * without having to visit settings first. Defaults are conservative
 * (2 retries, 60s backoff, doubling factor) and match the values
 * the Decision Log calls out.
 *
 * Columns added on `work_agent_preferences`:
 *
 *   - `maxAutoRetries` (int, NOT NULL, default 2)
 *       How many times the Goal-completion handler re-queues a
 *       transiently-failed Idea build before giving up. Range
 *       0–5 (enforced in settings UI / DTO validation, not at the
 *       DB level — keeping migration portable across dialects).
 *
 *   - `backoffSeconds` (int, NOT NULL, default 60)
 *       Initial wait between retry attempts. Range 10–3600.
 *
 *   - `exponentialBackoffFactor` (float, NOT NULL, default 2.0)
 *       Multiplier applied per attempt — wait_n = backoffSeconds
 *       * factor ^ n. Range 1.0–4.0. Stored as `float` for
 *       SQLite/Postgres portability.
 *
 * On apply: existing user rows get the defaults; no separate
 * backfill needed (the DEFAULT clause covers it).
 *
 * Idempotent and reversible.
 */
export class AddAutoRetryPrefs1779978004000 implements MigrationInterface {
    private static readonly COLUMNS = [
        { name: 'maxAutoRetries', type: 'int', default: 2 },
        { name: 'backoffSeconds', type: 'int', default: 60 },
        { name: 'exponentialBackoffFactor', type: 'float', default: 2.0 },
    ] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const col of AddAutoRetryPrefs1779978004000.COLUMNS) {
            if (!(await queryRunner.hasColumn('work_agent_preferences', col.name))) {
                await queryRunner.addColumn(
                    'work_agent_preferences',
                    new TableColumn({
                        name: col.name,
                        type: col.type,
                        isNullable: false,
                        default: col.default,
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const col of [...AddAutoRetryPrefs1779978004000.COLUMNS].reverse()) {
            if (await queryRunner.hasColumn('work_agent_preferences', col.name)) {
                await queryRunner.dropColumn('work_agent_preferences', col.name);
            }
        }
    }
}
