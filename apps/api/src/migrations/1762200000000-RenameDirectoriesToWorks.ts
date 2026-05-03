import type { MigrationInterface, QueryRunner } from 'typeorm';
import { runRenameDirectoriesToWorks } from '@ever-works/agent/database';

/**
 * Migration wrapper for the Directory→Work DB rename.
 *
 * Implementation lives in
 * `packages/agent/src/database/utils/rename-directories-to-works.ts` so it
 * can also be invoked at app boot from the DatabaseModule's
 * `dataSourceFactory` (see comments inside the util).
 *
 * down() is intentionally no-op — see util doc for why.
 */
export class RenameDirectoriesToWorks1762200000000 implements MigrationInterface {
    name = 'RenameDirectoriesToWorks1762200000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await runRenameDirectoriesToWorks(queryRunner);
    }

    async down(_queryRunner: QueryRunner): Promise<void> {
        // intentionally no-op
    }
}
