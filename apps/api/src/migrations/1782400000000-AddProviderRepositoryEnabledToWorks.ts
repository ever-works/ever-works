import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Works — opt out of generating the provider ("{provider} Repository") repo.
 *
 * That repository is the browsable, AI-generated view of a Work published to
 * its git provider (`RepositoryRole` `work`). Not every Work wants one: an
 * internal landing page gains nothing from a repository that only ever holds
 * a generated README.
 *
 * Entity: `packages/agent/src/entities/work.entity.ts`
 *
 * **Schema notes:**
 *   - `DEFAULT true` and `NOT NULL`, so every existing row keeps generating
 *     exactly as it does today. This flag can only ever remove behaviour a
 *     user explicitly turned off — it can never silently disable generation
 *     for a Work that was relying on it.
 *   - The flag is a user override layered on top of the per-kind capability
 *     (`getWorkCapabilities(kind).repos.work`); the two are resolved
 *     together by `Work.shouldGenerateProviderRepository()`. Kind wins, so
 *     no backfill is needed for kinds that never provisioned the repo.
 *
 * Forward-only and idempotent (`hasColumn` guard).
 */
export class AddProviderRepositoryEnabledToWorks1782400000000 implements MigrationInterface {
    name = 'AddProviderRepositoryEnabledToWorks1782400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('works'))) {
            return;
        }
        if (await queryRunner.hasColumn('works', 'providerRepositoryEnabled')) {
            return;
        }

        await queryRunner.addColumn(
            'works',
            new TableColumn({
                name: 'providerRepositoryEnabled',
                type: 'boolean',
                isNullable: false,
                default: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('works'))) {
            return;
        }
        if (!(await queryRunner.hasColumn('works', 'providerRepositoryEnabled'))) {
            return;
        }
        await queryRunner.dropColumn('works', 'providerRepositoryEnabled');
    }
}
