import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Run secrets (self-build slice Y, EW-781) — `repo_connections.envGrants`.
 *
 * The env var NAMES a repository's runs may read from the RUNNER's own
 * environment, through the runner's platform-owned refusal. Until now the
 * only knob was the instance-global `FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH`,
 * which cannot open `DATABASE_`, `GH_`, `AWS_` and the rest at all — so the
 * platform's own test suite could not be made to run on a fleet node by
 * configuration.
 *
 * NAMES, not values, and deliberately NOT encrypted (unlike the `envFiles`
 * column added by `1786850000000-CreateRepoConnections`): a grant is not a
 * secret, and an operator and an auditor must be able to read, grep and
 * diff exactly which variables a repository was allowed to see.
 *
 * Additive, nullable JSON, no index: read by connection primary key only,
 * exactly like `envFiles` and `tasks.extraRepos`. Every existing row reads
 * NULL — "no grants", which is the correct history and the default-empty
 * posture the feature requires. Forward-only with a guard so a partially
 * applied database converges; portable `TableColumn` DDL because the e2e
 * stack and CI run better-sqlite3 while production runs Postgres (TypeORM
 * maps `simple-json` to `text` on both).
 */
export class AddRepoConnectionEnvGrants1789200000000 implements MigrationInterface {
    name = 'AddRepoConnectionEnvGrants1789200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('repo_connections');
        if (table && !table.findColumnByName('envGrants')) {
            await queryRunner.addColumn(
                'repo_connections',
                new TableColumn({ name: 'envGrants', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('repo_connections');
        if (table?.findColumnByName('envGrants')) {
            await queryRunner.dropColumn('repo_connections', 'envGrants');
        }
    }
}
