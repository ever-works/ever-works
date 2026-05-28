import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-665 (Tenants & Organizations Phase 13) — adds the Work-level
 * `kind` + `status` lifecycle columns to the `works` table.
 *
 * See [spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)
 * for the Work-of-type-Company → Organization flow these columns drive.
 *
 * **`kind`** — `varchar(32)`, default `'default'`, NOT NULL. Mirrors
 * the `TemplateKind` convention (a TS string union backed by a plain
 * varchar rather than a Postgres enum type, so new members never need a
 * type-altering migration). Values today: `'default' | 'company'`. Every
 * pre-Phase-13 row is a plain Work → backfilled to `'default'`.
 *
 * **`status`** — `varchar(32)`, default `'active'`, NOT NULL. The
 * platform had NO Work-level lifecycle status before this phase
 * (generation / deployment / schedule status columns are independent and
 * don't represent the Work as a whole), so `'active'` is the
 * behavior-preserving default: a Work that exists is "live". Values:
 * `'draft' | 'active' | 'registered' | 'archived'`. The
 * `draft → registered` transition on a `kind = 'company'` Work is what
 * fires the `work.status.changed` event → `WorkRegisteredListener` →
 * `OrganizationService.createOrganizationFromCompanyWork`.
 *
 * Both columns are added with a non-NULL DB default so Postgres
 * backfills every existing row in the same `ALTER TABLE` — no separate
 * `UPDATE` pass is needed. We make the columns nullable-false at the
 * SQL level by relying on the default; `addColumn` with `default` set
 * and `isNullable: false` is the same shape the column-add migrations on
 * this table use elsewhere.
 *
 * Forward-only, additive, idempotent (gates on `hasColumn`). The
 * `down()` drops both columns.
 */
export class AddWorkKindAndStatus1779991010000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'kind'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'kind',
                    type: 'varchar',
                    length: '32',
                    isNullable: false,
                    default: "'default'",
                }),
            );
        }

        if (!(await queryRunner.hasColumn('works', 'status'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'status',
                    type: 'varchar',
                    length: '32',
                    isNullable: false,
                    default: "'active'",
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'status')) {
            await queryRunner.dropColumn('works', 'status');
        }
        if (await queryRunner.hasColumn('works', 'kind')) {
            await queryRunner.dropColumn('works', 'kind');
        }
    }
}
