import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the `kbConfig` simple-json column to the `works` table.
 *
 * Holds per-Work Knowledge Base configuration (storage plugin
 * override, retrieval budget, per-class inheritance modes). Schema is
 * `WorkKbConfig` in `packages/agent/src/entities/kb-types.ts`.
 *
 * Folded into a single JSON column because none of these fields are
 * query-driven — everything that needs querying lives on the
 * dedicated KB entities (`work_knowledge_*`).
 *
 * Forward-only, additive, nullable. Existing rows stay NULL until the
 * platform's KB-init job lazily populates `kbConfig` to defaults on
 * first KB access, or the operator-triggered backfill (Phase 1A
 * follow-up) populates them in bulk.
 *
 * EW-639 / EW-640.
 */
export class AddWorkKbConfigColumn1779976000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'kbConfig'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'kbConfig',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'kbConfig')) {
            await queryRunner.dropColumn('works', 'kbConfig');
        }
    }
}
