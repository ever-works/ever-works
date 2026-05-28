import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

/**
 * EW-656 (Tenants & Organizations Phase 4) — upgrades the existing
 * free-form `works.organizationId` column to a real FK constraint
 * referencing `organizations(id)`.
 *
 * Background: `works.organizationId` was added by EW-641's
 * [`1779977000000-AddWorkOrganizationId.ts`](./1779977000000-AddWorkOrganizationId.ts)
 * as a forward-looking nullable UUID with NO FK, because the
 * `organizations` table didn't exist yet. Now that Phase 1 (EW-653)
 * has created it, we can promote this column to a proper FK.
 *
 * Sequence:
 *   1. Pre-check for orphan UUIDs: rows where `organizationId IS NOT NULL`
 *      AND `organizationId NOT IN (SELECT id FROM organizations)`. The
 *      `organizations` table is empty today (Phase 6 is when the first
 *      row gets created), so any non-NULL `organizationId` is an orphan
 *      by definition. We NULL them out with a logged warning.
 *   2. Add FK constraint `fk_works_organization` on
 *      `works.organizationId` → `organizations(id)` ON DELETE SET NULL.
 *
 * **No entity changes accompany this migration.** The `Work` entity
 * already declares `@Column({ type: 'uuid', nullable: true }) organizationId`.
 * We deliberately do NOT add a `@ManyToOne(() => Organization, ...)`
 * relation — Phase 2's import-cycle bug showed that any Tier-A→Tenant/Org
 * `@ManyToOne` from `Work` would re-introduce the User → ... → Work
 * cycle. The FK at DB level is enough for v1; service-layer code that
 * needs the parent Organization does explicit
 * `organizationRepository.findById(work.organizationId)` lookups.
 *
 * The index on `works.organizationId` (`idx_works_organization_id`)
 * already exists from the EW-641 migration; this PR doesn't touch it.
 *
 * Forward-only, additive, idempotent (gates on FK existence).
 */
export class UpgradeWorkOrganizationIdToFk1779991007000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Null out any orphan organizationId values. Defensive — in
        //    production today the `organizations` table is empty so every
        //    non-NULL `works.organizationId` is by definition an orphan.
        //    We log the count via a SELECT before the UPDATE so the
        //    operator can see the cleanup activity in the migration log.
        const orphans = (await queryRunner.query(
            `SELECT COUNT(*) AS cnt FROM "works" WHERE "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
        )) as Array<{ cnt: number | string }>;
        const orphanCount = Number(orphans[0]?.cnt ?? 0);
        if (orphanCount > 0) {
            // eslint-disable-next-line no-console
            console.warn(
                `[UpgradeWorkOrganizationIdToFk] Nulling out ${orphanCount} orphan works.organizationId value(s) — no matching row in organizations. These were forward-looking UUIDs from before the FK existed.`,
            );
            await queryRunner.query(
                `UPDATE "works" SET "organizationId" = NULL WHERE "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
            );
        }

        // 2. Add the FK constraint.
        const works = await queryRunner.getTable('works');
        const hasFk = works?.foreignKeys.some((fk) => fk.name === 'fk_works_organization');
        if (!hasFk) {
            await queryRunner.createForeignKey(
                'works',
                new TableForeignKey({
                    name: 'fk_works_organization',
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const works = await queryRunner.getTable('works');
        const fk = works?.foreignKeys.find((f) => f.name === 'fk_works_organization');
        if (fk) {
            await queryRunner.dropForeignKey('works', fk);
        }
        // We intentionally do NOT restore previously-NULLed orphan values —
        // that data was already invalid (no matching organizations row),
        // so re-introducing it would just put the DB back into an
        // inconsistent state. The down migration only undoes the FK.
    }
}
