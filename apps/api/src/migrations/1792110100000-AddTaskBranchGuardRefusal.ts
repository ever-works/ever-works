import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 (change guard, ACC-NEG-04 follow-up) — adds `tasks.branchGuardRefusal`,
 * the reason an App Work's change rules refused a change that reached the
 * Task's PRIMARY branch.
 *
 * Entity: `packages/agent/src/entities/task.entity.ts` (`branchGuardRefusal`)
 * Writer: `packages/agent/src/tasks-domain/task-workspace.service.ts` —
 * `refuseChange` records it for a refusal of a change that reached the remote,
 * `guardAppChange` clears it when a later judgement allows the whole branch, and
 * `discardBranch` clears it with the branch.
 * Reader: `apps/web/src/components/tasks/TaskBranchSection.tsx` (the refusal
 * banner).
 *
 * ## Why a column
 *
 * A refusal deliberately leaves `branchState` alone — after the push the branch
 * really is pushed — and only posted a thread message and blocked the Task. So
 * the branch panel showed a pull request that now carries a refused change as an
 * ordinary open one, and nothing on the row told a guard refusal apart from any
 * other reason a Task is blocked. The non-primary repositories already carry the
 * same fact per entry (`linkedPullRequests[].refusedByGuard`), inside their JSON
 * column; the primary branch has no such home, hence one column.
 *
 * ## The stamp
 *
 * The next free stamp after the newest App Works migration in this directory,
 * `1792110000000-CreateAppLauncherPreferences.ts`, as the build coordinator
 * directed for this change. The work belongs to APW-08, whose reserved slots
 * `1792080000000`–`1792080300000` are all still planned for other migrations
 * (APW-08 plan §3.5), so none of them could be taken. TypeORM runs every
 * migration a database has not executed, in timestamp order, and this one is an
 * `ADD COLUMN` on one table with no dependency on anything APW-11 did.
 *
 * ## What `up()` does, and nothing else
 *
 * ONE nullable `text` column with no default and no index: it is read with the
 * Task by primary key only. Nothing is renamed, dropped or narrowed.
 *
 * ## No backfill
 *
 * Before this column no refusal was recorded anywhere but the thread, so NULL
 * ("nothing refused") is the value every existing row gets. A Task blocked by an
 * earlier refusal gets the marker on its next judged push.
 *
 * ## Forward-only, idempotent, portable
 *
 * Both directions are guarded (`hasTable` and `hasColumn`), so a re-run is a
 * no-op and `down()` is safe on a database where `up()` never ran. Portable
 * `TableColumn` DDL, because the e2e stack and CI run better-sqlite3 while
 * production runs Postgres.
 */
export class AddTaskBranchGuardRefusal1792110100000 implements MigrationInterface {
    name = 'AddTaskBranchGuardRefusal1792110100000';

    private static readonly TABLE = 'tasks';
    private static readonly COLUMN = 'branchGuardRefusal';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddTaskBranchGuardRefusal1792110100000;
        if (!(await queryRunner.hasTable(TABLE))) return;
        if (await queryRunner.hasColumn(TABLE, COLUMN)) return;

        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'text', isNullable: true }),
        );
    }

    /** Drops the one column `up()` added — nothing else. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddTaskBranchGuardRefusal1792110100000;
        if (!(await queryRunner.hasTable(TABLE))) return;
        if (!(await queryRunner.hasColumn(TABLE, COLUMN))) return;

        await queryRunner.dropColumn(TABLE, COLUMN);
    }
}
