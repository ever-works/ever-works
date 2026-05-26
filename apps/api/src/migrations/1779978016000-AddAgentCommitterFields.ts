import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * FU-13 (post-PR-1019 follow-up) — per-Agent git committer identity.
 *
 * Adds two nullable columns to `agents`:
 *   - `committerName`  (varchar 120, nullable)
 *   - `committerEmail` (varchar 254, nullable — RFC 5321 mailbox max)
 *
 * The `AGENT_GIT_FACADE` binding in api-side AgentsModule consumes
 * these when an Agent runs `commitToRepo` / `openPullRequest`. When
 * either is null, the binding falls back to: the Agent's `name` for
 * the name column, and `<slug>@agents.ever.works` (or the owning
 * User's primary email — operator choice in the factory) for the
 * email column.
 *
 * The email column will eventually point at an inbox managed by the
 * forthcoming Email Providers surface (see
 * `docs/specs/features/email-providers/spec.md`) so commit emails
 * land in a real mailbox the Agent + its watchers can read.
 *
 * Idempotent: gates the column adds on `hasColumn`.
 */
export class AddAgentCommitterFields1779978016000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('agents');
        if (!hasTable) return;

        const hasName = await queryRunner.hasColumn('agents', 'committerName');
        if (!hasName) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'committerName',
                    type: 'varchar',
                    length: '120',
                    isNullable: true,
                }),
            );
        }

        const hasEmail = await queryRunner.hasColumn('agents', 'committerEmail');
        if (!hasEmail) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'committerEmail',
                    type: 'varchar',
                    length: '254',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('agents');
        if (!hasTable) return;

        const hasEmail = await queryRunner.hasColumn('agents', 'committerEmail');
        if (hasEmail) {
            await queryRunner.dropColumn('agents', 'committerEmail');
        }

        const hasName = await queryRunner.hasColumn('agents', 'committerName');
        if (hasName) {
            await queryRunner.dropColumn('agents', 'committerName');
        }
    }
}
