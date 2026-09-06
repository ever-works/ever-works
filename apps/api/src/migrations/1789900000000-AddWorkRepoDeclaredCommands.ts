import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Acceptance checks that mean something (EW-807) — `works.repoDeclaredCommands`.
 *
 * The Work owner's decision about the commands their own repository
 * declares in `.works/works.yml` (`spec.tasks.setup` / `spec.tasks.checks`):
 * whether those declarations are read at all, and — if they are — the exact
 * list of commands that may be admitted.
 *
 * WHY A COLUMN. `spec.tasks.checks` has existed in the schema since the
 * Repository Work kind landed and has been read by NOBODY, because a
 * command in a repository is authored by anyone who can land a commit
 * there, and running it means running it on one of the owner's enrolled
 * machines. There was no place for an owner to say "yes, and only these".
 * This is that place.
 *
 * Every existing row reads NULL, which
 * `normalizeWorkRepoDeclaredCommandPolicy` resolves to `{ mode: 'off' }` —
 * the repository's file is not consulted for commands and the run is
 * graded by the Work's own `checkDefaults` exactly as before. That is the
 * correct history and the only safe default: a migration that turned this
 * on for existing Works would be a migration that started executing
 * repository content on people's desktops.
 *
 * Additive, nullable JSON, no index — read by Work primary key only, like
 * `checkDefaults` beside it. Forward-only with a guard so a partially
 * applied database converges; portable `TableColumn` DDL because the e2e
 * stack and CI run better-sqlite3 while production runs Postgres (TypeORM
 * maps `simple-json` to `text` on both).
 */
export class AddWorkRepoDeclaredCommands1789900000000 implements MigrationInterface {
    name = 'AddWorkRepoDeclaredCommands1789900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (table && !table.findColumnByName('repoDeclaredCommands')) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({ name: 'repoDeclaredCommands', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (table?.findColumnByName('repoDeclaredCommands')) {
            await queryRunner.dropColumn('works', 'repoDeclaredCommands');
        }
    }
}
