import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableForeignKey,
    TableIndex,
    TableUnique,
} from 'typeorm';

/**
 * APW-12 (Ever ID) — the `external_identities` table: one connected identity,
 * the pair (issuer, subject), per row (spec FR-21, FR-31; plan §3.1, §3.6).
 *
 * Entity: `packages/agent/src/entities/external-identity.entity.ts`.
 *
 * Slot **00 of epic 12** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * stamped above `1792110100000-AddTaskBranchGuardRefusal.ts`, the newest
 * migration on `develop` when it was written.
 *
 * ## Shape
 *
 * - `uq_external_identities_issuer_subject` UNIQUE `(issuer, subject)` — a pair
 *   belongs to at most one account; it decides the S24 race (a sign-up and a
 *   connect of the same identity at once leave exactly one row).
 * - `uq_external_identities_user_issuer` UNIQUE `(userId, issuer)` — an account
 *   has at most one pair per issuer.
 * - `idx_external_identities_user` on `(userId)` — the Settings card's read.
 * - FK `userId` → `users.id` ON DELETE CASCADE: deleting an account deletes its
 *   connected identities (FR-30, ACC-12-41); removing an identity never deletes
 *   an account.
 *
 * Both uniques are named table constraints rather than unique indexes so the
 * same statement and the same constraint name exist on Postgres and on the
 * better-sqlite3 driver CI and the e2e lane run. No column stores a token:
 * FR-31 lists everything a row holds.
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable` / existing names), so a re-run is a no-op and
 * `down()` is safe where `up()` never ran. Timestamps default to
 * `CURRENT_TIMESTAMP`, not `now()` (a Postgres function the test driver lacks).
 * `down()` drops exactly the table `up()` created — its constraints, index and
 * foreign key go with it — and nothing pre-existing is touched in either
 * direction.
 */
export class CreateExternalIdentities1792120000000 implements MigrationInterface {
    name = 'CreateExternalIdentities1792120000000';

    private static readonly TABLE = 'external_identities';
    private static readonly UNIQUE_PAIR = 'uq_external_identities_issuer_subject';
    private static readonly UNIQUE_USER_ISSUER = 'uq_external_identities_user_issuer';
    private static readonly INDEX_USER = 'idx_external_identities_user';
    private static readonly FOREIGN_KEY = 'fk_external_identities_user';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const self = CreateExternalIdentities1792120000000;

        if (!(await queryRunner.hasTable(self.TABLE))) {
            await queryRunner.createTable(
                new Table({
                    name: self.TABLE,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        // The exact `iss` string of the provider (FR-11).
                        { name: 'issuer', type: 'varchar', length: '512' },
                        // The exact `sub` claim, 1–255 characters (FR-11).
                        { name: 'subject', type: 'varchar', length: '255' },
                        // Display only — never used to resolve an account (FR-22).
                        { name: 'emailAtLink', type: 'varchar', length: '320' },
                        { name: 'emailVerifiedAtLink', type: 'boolean' },
                        // 'sign-up' | 'settings' | 'provisioning'.
                        { name: 'linkedVia', type: 'varchar', length: '16' },
                        { name: 'linkedAt', type: 'timestamp' },
                        { name: 'lastLoginAt', type: 'timestamp', isNullable: true },
                        // ≤ 10 `{ clientId, lastSeenAt }` entries (FR-31, FR-48).
                        { name: 'delegatedClients', type: 'text', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                    uniques: [
                        new TableUnique({
                            name: self.UNIQUE_PAIR,
                            columnNames: ['issuer', 'subject'],
                        }),
                        new TableUnique({
                            name: self.UNIQUE_USER_ISSUER,
                            columnNames: ['userId', 'issuer'],
                        }),
                    ],
                }),
                true,
            );
        }

        const table = await queryRunner.getTable(self.TABLE);
        if (table && !table.indices.some((index) => index.name === self.INDEX_USER)) {
            await queryRunner.createIndex(
                self.TABLE,
                new TableIndex({ name: self.INDEX_USER, columnNames: ['userId'] }),
            );
        }

        const current = await queryRunner.getTable(self.TABLE);
        if (
            current &&
            (await queryRunner.hasTable('users')) &&
            !current.foreignKeys.some((fk) => fk.name === self.FOREIGN_KEY)
        ) {
            await queryRunner.createForeignKey(
                self.TABLE,
                new TableForeignKey({
                    name: self.FOREIGN_KEY,
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /** Drops exactly the table `up()` created (with its constraints, index and foreign key). */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const self = CreateExternalIdentities1792120000000;
        if (await queryRunner.hasTable(self.TABLE)) {
            // `dropTable(name, ifExists, dropForeignKeys, dropIndices)`.
            await queryRunner.dropTable(self.TABLE, true, true, true);
        }
    }
}
