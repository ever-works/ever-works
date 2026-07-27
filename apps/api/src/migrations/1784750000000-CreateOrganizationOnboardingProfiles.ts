import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Audit item A53 — organization-scoped onboarding profile.
 *
 * `organization_onboarding_profiles` mirrors the onboarding wizard's
 * "What do you do" answers (roles multi-select + team size) at the
 * organization level. Until now they only ever landed on
 * `users.onboarding_state`, which is per-user and therefore invisible to
 * every other member of the same organization.
 *
 * Single row per organization (`organizationId` is the PK), cascading
 * delete from `organizations` — same shape as
 * `organization_notification_defaults` (see
 * [`1780000000000-AddNotificationsV2Tables`](./1780000000000-AddNotificationsV2Tables.ts)).
 *
 * `roles` is the entity's `simple-json` column, which maps to `text` on
 * Postgres and on the better-sqlite3 test/CLI driver alike — so a plain
 * nullable `text` column is the portable spelling.
 *
 * Entity: `packages/agent/src/entities/organization-onboarding-profile.entity.ts`.
 *
 * Purely additive: no backfill, and every column is nullable, so
 * existing organizations are unaffected until someone answers the step.
 * Forward-only and idempotent (`hasTable` guarded), matching the house
 * migration pattern.
 */
export class CreateOrganizationOnboardingProfiles1784750000000 implements MigrationInterface {
    name = 'CreateOrganizationOnboardingProfiles1784750000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('organization_onboarding_profiles')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'organization_onboarding_profiles',
                columns: [
                    { name: 'organizationId', type: 'uuid', isPrimary: true, isNullable: false },
                    { name: 'roles', type: 'text', isNullable: true },
                    { name: 'teamSize', type: 'varchar', length: '64', isNullable: true },
                    { name: 'updatedByUserId', type: 'uuid', isNullable: true },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        name: 'fk_organization_onboarding_profiles_organization',
                        columnNames: ['organizationId'],
                        referencedTableName: 'organizations',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
            }),
            true,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('organization_onboarding_profiles')) {
            await queryRunner.dropTable('organization_onboarding_profiles', true);
        }
    }
}
