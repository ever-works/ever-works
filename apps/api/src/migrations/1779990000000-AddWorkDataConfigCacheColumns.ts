import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds five denormalised cache columns to `works` so the Work Overview
 * tab (and any other dashboard surface that needs counts/config) can
 * render straight from Postgres without cloning the Work's data
 * repository on every request.
 *
 * Background: prior to this migration, every `/works/[id]` page load
 * called `DataGeneratorService.getConfig()` + `count()`, each of which
 * invokes `gitFacade.cloneOrPull()` against the Work's data repo. A
 * single Overview render therefore triggered 2–3 git clones (multi-MB,
 * network-bound) — observed page loads were routinely 10–20 s.
 *
 * Source of truth is unchanged — `.works/works.yml` in the data repo
 * is still authoritative. These columns are a read-side projection
 * populated by:
 *   1. The generator on every successful run
 *      (`DataGeneratorService` final `updateWork` call), and
 *   2. Lazy backfill in `WorkQueryService` — first time a Work is
 *      read after this migration deploys, the service clones once,
 *      populates the columns, and serves from DB on every subsequent
 *      read.
 *
 * All columns are nullable so existing rows survive the deploy and
 * lazy backfill can fill them in over time.
 *
 * Forward-only, additive. EW-Perf-Overview-DB.
 */
export class AddWorkDataConfigCacheColumns1779990000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('works');
        if (!hasTable) return;

        if (!(await queryRunner.hasColumn('works', 'companyWebsite'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'companyWebsite',
                    type: 'varchar',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('works', 'categoriesCount'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'categoriesCount',
                    type: 'int',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('works', 'tagsCount'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'tagsCount',
                    type: 'int',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('works', 'comparisonsCount'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'comparisonsCount',
                    type: 'int',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('works', 'configCache'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'configCache',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('works');
        if (!hasTable) return;

        if (await queryRunner.hasColumn('works', 'configCache')) {
            await queryRunner.dropColumn('works', 'configCache');
        }
        if (await queryRunner.hasColumn('works', 'comparisonsCount')) {
            await queryRunner.dropColumn('works', 'comparisonsCount');
        }
        if (await queryRunner.hasColumn('works', 'tagsCount')) {
            await queryRunner.dropColumn('works', 'tagsCount');
        }
        if (await queryRunner.hasColumn('works', 'categoriesCount')) {
            await queryRunner.dropColumn('works', 'categoriesCount');
        }
        if (await queryRunner.hasColumn('works', 'companyWebsite')) {
            await queryRunner.dropColumn('works', 'companyWebsite');
        }
    }
}
