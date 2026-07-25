import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — one additive,
 * nullable `mergePolicy` column on each of the four policy scopes:
 * `tenants`, `organizations`, `works`, `agents`.
 *
 * The column stores a PARTIAL policy (`MergePolicyOverride`) as
 * `simple-json`, i.e. a TEXT column at the DB level, matching the
 * existing `agents.permissions` / `agents.guardrails` /
 * `works.checkDefaults` storage pattern.
 *
 * NULL means INHERIT — never "deny". Every existing row therefore keeps
 * resolving to the platform default
 * (`PLATFORM_DEFAULT_MERGE_POLICY`: agents do not merge, green gate and
 * human approval required, squash only, main/master/develop/stage
 * protected) until someone deliberately sets a policy at some scope.
 *
 * Forward-only, idempotent per-step guards (house pattern) so a
 * partially-applied run and a fresh DB converge on the same shape.
 */
export class AddMergePolicyColumns1784000000000 implements MigrationInterface {
    name = 'AddMergePolicyColumns1784000000000';

    private static readonly TABLES = ['tenants', 'organizations', 'works', 'agents'] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of AddMergePolicyColumns1784000000000.TABLES) {
            const table = await queryRunner.getTable(tableName);
            if (!table) continue;
            if (table.findColumnByName('mergePolicy')) continue;
            await queryRunner.query(`ALTER TABLE "${tableName}" ADD COLUMN "mergePolicy" text`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of [...AddMergePolicyColumns1784000000000.TABLES].reverse()) {
            const table = await queryRunner.getTable(tableName);
            if (!table) continue;
            if (!table.findColumnByName('mergePolicy')) continue;
            await queryRunner.query(`ALTER TABLE "${tableName}" DROP COLUMN "mergePolicy"`);
        }
    }
}
