import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * APW-12 (Ever ID) — two additive, nullable columns on `session` recording which
 * connected identity opened a session and the provider's session id (spec FR-32,
 * FR-34; plan §3.2, §3.6).
 *
 * Entity: `packages/agent/src/entities/auth-session.entity.ts`
 * (`externalIdentityId`, `externalSid`).
 *
 * Slot **01 of epic 12** in the reserved `1792` block, directly after
 * `1792120000000-CreateExternalIdentities`.
 *
 * ## Why nullable, with no default, no backfill and no foreign key
 *
 * Every existing session was correctly "not opened by Ever ID", which is exactly
 * what `NULL` says; a backfill would have nothing true to write. Every other
 * sign-in method keeps writing rows that leave both columns `NULL` (FR-35), so a
 * sign-out notice can never end a session another method opened. There is
 * deliberately no foreign key to `external_identities`: a session row must never
 * block deleting an identity — the disconnect path deletes the sessions first.
 *
 * - `idx_session_external_identity` on `(externalIdentityId)` — disconnect and
 *   `sub`-only notices.
 * - `idx_session_external_sid` on `(externalSid)` — notices carrying a `sid`.
 *
 * Guarded (`hasTable` / `hasColumn` / existing index names), so a re-run is a
 * no-op; `down()` drops exactly the two indexes and two columns `up()` added and
 * touches nothing else.
 */
export class AddExternalIdentityToSessions1792120100000 implements MigrationInterface {
    name = 'AddExternalIdentityToSessions1792120100000';

    private static readonly TABLE = 'session';
    private static readonly IDENTITY_COLUMN = 'externalIdentityId';
    private static readonly SID_COLUMN = 'externalSid';
    private static readonly IDENTITY_INDEX = 'idx_session_external_identity';
    private static readonly SID_INDEX = 'idx_session_external_sid';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const self = AddExternalIdentityToSessions1792120100000;
        if (!(await queryRunner.hasTable(self.TABLE))) return;

        if (!(await queryRunner.hasColumn(self.TABLE, self.IDENTITY_COLUMN))) {
            await queryRunner.addColumn(
                self.TABLE,
                new TableColumn({ name: self.IDENTITY_COLUMN, type: 'uuid', isNullable: true }),
            );
        }
        if (!(await queryRunner.hasColumn(self.TABLE, self.SID_COLUMN))) {
            await queryRunner.addColumn(
                self.TABLE,
                new TableColumn({
                    name: self.SID_COLUMN,
                    type: 'varchar',
                    length: '255',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable(self.TABLE);
        const indexNames = new Set((table?.indices ?? []).map((index) => index.name));
        if (!indexNames.has(self.IDENTITY_INDEX)) {
            await queryRunner.createIndex(
                self.TABLE,
                new TableIndex({ name: self.IDENTITY_INDEX, columnNames: [self.IDENTITY_COLUMN] }),
            );
        }
        if (!indexNames.has(self.SID_INDEX)) {
            await queryRunner.createIndex(
                self.TABLE,
                new TableIndex({ name: self.SID_INDEX, columnNames: [self.SID_COLUMN] }),
            );
        }
    }

    /** Drops exactly the two indexes and the two columns `up()` added. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const self = AddExternalIdentityToSessions1792120100000;
        if (!(await queryRunner.hasTable(self.TABLE))) return;

        const table = await queryRunner.getTable(self.TABLE);
        const indexNames = new Set((table?.indices ?? []).map((index) => index.name));
        if (indexNames.has(self.SID_INDEX)) {
            await queryRunner.dropIndex(self.TABLE, self.SID_INDEX);
        }
        if (indexNames.has(self.IDENTITY_INDEX)) {
            await queryRunner.dropIndex(self.TABLE, self.IDENTITY_INDEX);
        }
        if (await queryRunner.hasColumn(self.TABLE, self.SID_COLUMN)) {
            await queryRunner.dropColumn(self.TABLE, self.SID_COLUMN);
        }
        if (await queryRunner.hasColumn(self.TABLE, self.IDENTITY_COLUMN)) {
            await queryRunner.dropColumn(self.TABLE, self.IDENTITY_COLUMN);
        }
    }
}
