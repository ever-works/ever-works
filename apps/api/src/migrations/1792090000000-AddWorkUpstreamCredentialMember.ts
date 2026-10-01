import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-09 T43 (FR-43, XC-18) — adds `work_upstream_states.credentialMemberUserId`,
 * the App Work's **credential of record** once a handover records one.
 *
 * Entity: `packages/agent/src/entities/work-upstream-state.entity.ts`
 * Table: `work_upstream_states`, created by
 * `1792020000000-CreateWorkUpstreamStates.ts` (APW-02 T13)
 * Task: `docs/specs/features/app-works/APW-09-upstream-pull-requests/tasks.md`
 * T43 — "the record is APW-02's upstream state where it already carries one",
 * which until this migration the row did not.
 * Repository: `packages/agent/src/database/repositories/work-upstream-state.repository.ts`
 * (`findCredentialMemberUserId` / `setCredentialMemberUserId`)
 *
 * ## The slot, and the conflict it is stamped inside (D15)
 *
 * Slot **00 of epic 09** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * so the stamp is `1792090000000`. Rule 6 asks for two things that cannot both
 * hold once a higher-numbered epic has landed first: the epic's own reserved
 * stamp, **and** a stamp above the newest migration on `develop` — here
 * `1792110000000-CreateAppLauncherPreferences.ts` (APW-11). The reserved stamp
 * is kept, exactly as `1792070000000-CreateAppEnvAndDependencies.ts:16-25`
 * records for the same conflict (the programme's **D15**): the per-epic block,
 * not the wall clock, is what orders these migrations. TypeORM runs only the
 * migrations a database has not executed, in timestamp order, so this one still
 * applies cleanly to a production database that has already run epic 11's
 * migration — it is an `ALTER TABLE ADD COLUMN` on one table, with no
 * dependency on anything epic 11 did. Re-stamping upward is the spec owner's
 * call (D15), not this file's.
 *
 * ## What `up()` does, and nothing else
 *
 * ONE `ADD COLUMN`. Nothing is renamed, dropped or narrowed (CONTRACTS R-26,
 * the owner's additive-only rule); no index, no foreign key and no second
 * column are added, and no existing table other than `work_upstream_states` is
 * touched.
 *
 * ## Nullable, with no default — that is the whole point
 *
 * The column is `uuid NULL` with **no default**. Two reasons, both load-bearing:
 *
 *   1. **Automigrate on a non-empty table.** `database.config.ts` boots with
 *      `migrationsRun: true`, and a `NOT NULL` column without a default cannot
 *      be added to a table that already has rows on Postgres, nor on SQLite —
 *      the API would fail to start on every installation that has an App Work.
 *   2. **NULL is a fact, not an absence of one.** NULL means "no handover has
 *      been recorded", and the credential of record is then the Work's creator
 *      (`Work.userId`, the member APW-01 FR-15 made the fork with). Writing the
 *      creator's id here would make "nobody handed anything over" and "the
 *      creator handed over to themselves" the same row, and the next background
 *      job could no longer tell `source: 'creator'` from `source: 'handover'`
 *      (`upstream-credential.service.ts:518-528`).
 *
 * ## No backfill
 *
 * There is nothing to write: before this migration no row could carry a
 * handover, so NULL is already the true value of every existing row, and it
 * stays NULL until a member performs a handover. The migration therefore does
 * not read a single row — it cannot mislabel one either.
 *
 * ## Forward-only, idempotent, portable
 *
 * Both directions are guarded (`hasTable` and `hasColumn`), so a re-run is a
 * no-op and `down()` is safe on a database where `up()` never ran. The column
 * type is `uuid`, which both drivers the platform runs understand (Postgres in
 * production, better-sqlite3 as the default `DATABASE_TYPE`, in CI and in the
 * e2e lane); nothing here is Postgres-specific.
 */
export class AddWorkUpstreamCredentialMember1792090000000 implements MigrationInterface {
    name = 'AddWorkUpstreamCredentialMember1792090000000';

    private static readonly TABLE = 'work_upstream_states';
    private static readonly COLUMN = 'credentialMemberUserId';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(AddWorkUpstreamCredentialMember1792090000000.TABLE))) {
            // APW-02's create migration has not run — there is no row to record a
            // handover on, and inventing the table here would duplicate 179202's
            // job. The column arrives with the table in that case, because the
            // entity carries it.
            return;
        }

        if (
            await queryRunner.hasColumn(
                AddWorkUpstreamCredentialMember1792090000000.TABLE,
                AddWorkUpstreamCredentialMember1792090000000.COLUMN,
            )
        ) {
            return;
        }

        await queryRunner.addColumn(
            AddWorkUpstreamCredentialMember1792090000000.TABLE,
            new TableColumn({
                name: AddWorkUpstreamCredentialMember1792090000000.COLUMN,
                type: 'uuid',
                isNullable: true,
            }),
        );
    }

    /**
     * Drops the one column `up()` added — nothing else. A database where `up()`
     * never ran leaves without an error, and the rows themselves survive: a
     * handover is re-derived from the Work's creator after a revert, which is
     * exactly the behaviour that existed before this column.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(AddWorkUpstreamCredentialMember1792090000000.TABLE))) {
            return;
        }

        if (
            !(await queryRunner.hasColumn(
                AddWorkUpstreamCredentialMember1792090000000.TABLE,
                AddWorkUpstreamCredentialMember1792090000000.COLUMN,
            ))
        ) {
            return;
        }

        await queryRunner.dropColumn(
            AddWorkUpstreamCredentialMember1792090000000.TABLE,
            AddWorkUpstreamCredentialMember1792090000000.COLUMN,
        );
    }
}
