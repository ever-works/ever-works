import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `workId` routing for ingested events — one additive, nullable
 * `externalRefs` column on `works`.
 *
 * Stores the external containers a Work claims (chat channel ids,
 * tracker team keys, doc database ids, meeting ids) as `simple-json`,
 * i.e. a TEXT column at the DB level, matching the existing
 * `works.mergePolicy` / `works.checkDefaults` storage pattern.
 *
 * NULL means "this Work claims nothing", which is what every existing
 * row keeps meaning: an ingested event whose `workHint` matches no
 * Work stays user-scoped exactly as it does today. Repo hints are NOT
 * stored here — they resolve against the repositories a Work already
 * declares (`matchWorkByRepo`).
 *
 * Forward-only, idempotent per-step guards (house pattern) so a
 * partially-applied run and a fresh DB converge on the same shape.
 */
export class AddWorkExternalRefs1784200000000 implements MigrationInterface {
    name = 'AddWorkExternalRefs1784200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (!table) return;
        if (table.findColumnByName('externalRefs')) return;
        await queryRunner.query(`ALTER TABLE "works" ADD COLUMN "externalRefs" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (!table) return;
        if (!table.findColumnByName('externalRefs')) return;
        await queryRunner.query(`ALTER TABLE "works" DROP COLUMN "externalRefs"`);
    }
}
