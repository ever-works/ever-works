import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * First-hour onboarding (AW-20, slot 01) — `onboarding_checklists`.
 *
 * Entity: `packages/agent/src/entities/onboarding-checklist.entity.ts`
 *
 * One row per (person, workspace scope), holding how far someone got
 * through their first hour: the five milestone states, the outcome of
 * their last roster provisioning run, and the three decisions that have
 * no other source — a milestone marked "not for me", a hidden card, and
 * an acknowledged roster introduction.
 *
 * ## Why this is not the wizard's own state blob
 *
 * `users.onboarding_state` is a step index plus four provider choices;
 * its timestamps mean "the dialog closed". Four of the five milestones
 * here are satisfied by facts in four other subsystems, which that blob's
 * contract cannot express, and folding them in would put every wizard
 * write and every milestone write in contention on one row.
 *
 * ## Shape
 *
 * - UNIQUE `(userId, scopeKey)` where `scopeKey` is the normalised
 *   `organizationId ?? 'personal'`. SQL treats NULLs as DISTINCT, so a
 *   unique index over `(userId, organizationId)` would happily admit a
 *   second personal row — the same dodge `Agent.scopeTargetId` uses.
 * - `idx_onboarding_checklist_user` — every read is keyed by the person.
 * - `milestones` / `provisioning` are `simple-json`, spelled `text` here:
 *   that is what `simple-json` maps to on Postgres and on the
 *   better-sqlite3 CLI driver alike (the portability note
 *   `1784750000000-CreateOrganizationOnboardingProfiles` already makes).
 * - FK `userId` → `users.id` ON DELETE CASCADE, so deleting an account
 *   takes its checklist with it rather than leaving an orphan keyed to a
 *   user id nothing can resolve. `organizationId` stays a raw uuid.
 *
 * No backfill: a row is created lazily on the first read, so an account
 * that never opens the checklist never gets one, and an account that
 * already has agents, tasks and schedules simply evaluates to complete.
 *
 * Forward-only + idempotent (`hasTable` guard). `down()` drops only the
 * table `up()` created.
 */
export class CreateOnboardingChecklists1791200100000 implements MigrationInterface {
    name = 'CreateOnboardingChecklists1791200100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('onboarding_checklists')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'onboarding_checklists',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'scopeKey', type: 'varchar', length: '64' },
                    { name: 'milestones', type: 'text', default: "'{}'" },
                    { name: 'provisioning', type: 'text', isNullable: true },
                    { name: 'rosterAcknowledgedAt', type: 'timestamp', isNullable: true },
                    { name: 'hiddenAt', type: 'timestamp', isNullable: true },
                    { name: 'dismissedAt', type: 'timestamp', isNullable: true },
                    { name: 'completedAt', type: 'timestamp', isNullable: true },
                    { name: 'evaluatedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'onboarding_checklists',
            new TableIndex({
                name: 'uq_onboarding_checklist_user_scope',
                columnNames: ['userId', 'scopeKey'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'onboarding_checklists',
            new TableIndex({
                name: 'idx_onboarding_checklist_user',
                columnNames: ['userId'],
            }),
        );

        await queryRunner.createForeignKey(
            'onboarding_checklists',
            new TableForeignKey({
                name: 'fk_onboarding_checklist_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('onboarding_checklists')) {
            await queryRunner.dropTable('onboarding_checklists', true);
        }
    }
}
