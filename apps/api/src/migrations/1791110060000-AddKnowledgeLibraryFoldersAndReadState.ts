import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Knowledge library, phase 1 (the shelf) — shared folders for Knowledge Base
 * documents, a substantive-change revision on every document, archive
 * bookkeeping, and the per-person reader-state table the read badges and
 * pins are built on.
 *
 * Entities:
 *   `packages/agent/src/entities/memory-folder.entity.ts` (`scope`)
 *   `packages/agent/src/entities/work-knowledge-document.entity.ts` (6 columns)
 *   `packages/agent/src/entities/knowledge-document-reader-state.entity.ts` (new)
 *
 * ## `memory_folders.scope`
 *
 * The existing per-person folder tree gains a second scope instead of a
 * second tree: `'user'` (every existing row, backfilled by the column
 * default) or `'organization'` (a shared library folder). The only index
 * change is a WIDENING. `uq_memory_folders_user_path` is dropped and
 * immediately recreated as a PARTIAL unique index over the same columns
 * `WHERE scope = 'user'` — since every existing row is `'user'`, it enforces
 * exactly what the original index enforced over existing data. Two partial
 * indexes are added for the shared scope: path uniqueness per Organization
 * and the `(organizationId, parentId)` child lookup.
 *
 * ## `work_knowledge_documents`
 *
 * `folder_id` (NULL = Unfiled, FK → `memory_folders` SET NULL, so deleting a
 * folder unfiles and never deletes), `revision` (NOT NULL DEFAULT 1),
 * `revision_at`, `normalized_content_hash` (left NULL: the first write seeds
 * it without moving `revision`, so no existing document is flagged as
 * changed on the day this ships), `archived_at` and `archived_by_id`
 * (FK → `users` SET NULL). `revision_at` is backfilled from `updatedAt`
 * (falling back to `createdAt`) so the first library render has a sort key;
 * `archived_at` is backfilled from `updatedAt` for already-archived rows.
 *
 * The two FKs on the existing table are Postgres-only raw DDL — the same
 * posture as `1786830001000-AddMemoryFolderIdToUploads`: better-sqlite3
 * cannot add an FK to an existing table without a rebuild, and the library
 * service clears `folder_id` explicitly on folder delete anyway.
 *
 * ## `knowledge_document_reader_states`
 *
 * One row per (person, document), written lazily. UNIQUE `(userId,
 * documentId)`; `(userId, pinnedAt)` for the pinned group; `(documentId)`
 * for cascades. FKs → `users` and → `work_knowledge_documents`, both
 * CASCADE: read state means nothing without either side.
 *
 * Forward-only and idempotent (`hasTable` / `hasColumn` / index-name
 * guards), portable `Table` / `TableColumn` / `TableIndex` DDL because
 * production runs Postgres while CI runs better-sqlite3.
 */
export class AddKnowledgeLibraryFoldersAndReadState1791110060000 implements MigrationInterface {
    name = 'AddKnowledgeLibraryFoldersAndReadState1791110060000';

    private static readonly FOLDERS = 'memory_folders';
    private static readonly DOCUMENTS = 'work_knowledge_documents';
    private static readonly READER_STATES = 'knowledge_document_reader_states';

    private static readonly USER_PATH_INDEX = 'uq_memory_folders_user_path';

    private static readonly DOCUMENT_COLUMNS = [
        new TableColumn({ name: 'folder_id', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'revision', type: 'int', default: 1 }),
        new TableColumn({ name: 'revision_at', type: 'timestamp', isNullable: true }),
        new TableColumn({
            name: 'normalized_content_hash',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
        new TableColumn({ name: 'archived_at', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'archived_by_id', type: 'uuid', isNullable: true }),
    ];

    private static readonly DOCUMENT_INDEXES = [
        new TableIndex({ name: 'idx_wkd_folder', columnNames: ['folder_id'] }),
        new TableIndex({
            name: 'idx_wkd_org_status_revision_at',
            columnNames: ['organizationId', 'status', 'revision_at'],
        }),
        new TableIndex({
            name: 'idx_wkd_work_status_revision_at',
            columnNames: ['workId', 'status', 'revision_at'],
        }),
    ];

    private static readonly READER_STATE_INDEXES = [
        new TableIndex({
            name: 'uq_knowledge_reader_state_user_doc',
            columnNames: ['userId', 'documentId'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_knowledge_reader_state_user_pinned',
            columnNames: ['userId', 'pinnedAt'],
        }),
        new TableIndex({ name: 'idx_knowledge_reader_state_doc', columnNames: ['documentId'] }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.upFolders(queryRunner);
        await this.upDocuments(queryRunner);
        await this.upReaderStates(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const self = AddKnowledgeLibraryFoldersAndReadState1791110060000;
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (await queryRunner.hasTable(self.READER_STATES)) {
            await queryRunner.dropTable(self.READER_STATES, true, true, true);
        }

        if (await queryRunner.hasTable(self.DOCUMENTS)) {
            if (isPostgres) {
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}" DROP CONSTRAINT IF EXISTS "fk_wkd_folder"`,
                );
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}" DROP CONSTRAINT IF EXISTS "fk_wkd_archived_by"`,
                );
            }
            for (const index of self.DOCUMENT_INDEXES) {
                const table = await queryRunner.getTable(self.DOCUMENTS);
                if (table?.indices.some((existing) => existing.name === index.name)) {
                    await queryRunner.dropIndex(self.DOCUMENTS, index.name as string);
                }
            }
            // Fresh `getTable` per drop: drivers that cannot drop a column in
            // place rebuild the table, replacing the Table object each time.
            for (const column of [...self.DOCUMENT_COLUMNS].reverse()) {
                const table = await queryRunner.getTable(self.DOCUMENTS);
                const existing = table?.findColumnByName(column.name);
                if (existing) {
                    await queryRunner.dropColumn(self.DOCUMENTS, existing);
                }
            }
        }

        if (
            (await queryRunner.hasTable(self.FOLDERS)) &&
            (await queryRunner.hasColumn(self.FOLDERS, 'scope'))
        ) {
            // Reverting DISCARDS every shared (organization-scope) folder:
            // the pre-library schema has nowhere to keep them, and leaving
            // them would break the restored full unique index. Documents are
            // never deleted — their `folder_id` column is dropped above, so
            // they simply become unfiled.
            await queryRunner.query(`DELETE FROM "${self.FOLDERS}" WHERE "scope" = 'organization'`);
            for (const name of [
                'idx_memory_folders_org_parent',
                'uq_memory_folders_org_path',
                self.USER_PATH_INDEX,
            ]) {
                const table = await queryRunner.getTable(self.FOLDERS);
                if (table?.indices.some((existing) => existing.name === name)) {
                    await queryRunner.dropIndex(self.FOLDERS, name);
                }
            }
            await queryRunner.createIndex(
                self.FOLDERS,
                new TableIndex({
                    name: self.USER_PATH_INDEX,
                    columnNames: ['userId', 'path'],
                    isUnique: true,
                }),
            );
            const table = await queryRunner.getTable(self.FOLDERS);
            const scope = table?.findColumnByName('scope');
            if (scope) {
                await queryRunner.dropColumn(self.FOLDERS, scope);
            }
        }
    }

    // ─── memory_folders ──────────────────────────────────────────────────

    private async upFolders(queryRunner: QueryRunner): Promise<void> {
        const self = AddKnowledgeLibraryFoldersAndReadState1791110060000;
        if (!(await queryRunner.hasTable(self.FOLDERS))) return;

        if (!(await queryRunner.hasColumn(self.FOLDERS, 'scope'))) {
            await queryRunner.addColumn(
                self.FOLDERS,
                new TableColumn({
                    name: 'scope',
                    type: 'varchar',
                    length: '16',
                    default: "'user'",
                }),
            );
            // Belt and braces — the NOT NULL default already fills every row.
            await queryRunner.query(
                `UPDATE "${self.FOLDERS}" SET "scope" = 'user' WHERE "scope" IS NULL`,
            );

            // The widening: same columns, now scoped to the per-person rows —
            // which, on existing data, is every row.
            const table = await queryRunner.getTable(self.FOLDERS);
            if (table?.indices.some((existing) => existing.name === self.USER_PATH_INDEX)) {
                await queryRunner.dropIndex(self.FOLDERS, self.USER_PATH_INDEX);
            }
            await queryRunner.createIndex(
                self.FOLDERS,
                new TableIndex({
                    name: self.USER_PATH_INDEX,
                    columnNames: ['userId', 'path'],
                    isUnique: true,
                    where: `"scope" = 'user'`,
                }),
            );
        }

        await this.ensureIndexes(queryRunner, self.FOLDERS, [
            new TableIndex({
                name: 'uq_memory_folders_org_path',
                columnNames: ['organizationId', 'path'],
                isUnique: true,
                where: `"scope" = 'organization'`,
            }),
            new TableIndex({
                name: 'idx_memory_folders_org_parent',
                columnNames: ['organizationId', 'parentId'],
                where: `"scope" = 'organization'`,
            }),
        ]);
    }

    // ─── work_knowledge_documents ────────────────────────────────────────

    private async upDocuments(queryRunner: QueryRunner): Promise<void> {
        const self = AddKnowledgeLibraryFoldersAndReadState1791110060000;
        if (!(await queryRunner.hasTable(self.DOCUMENTS))) return;

        let addedRevisionAt = false;
        for (const column of self.DOCUMENT_COLUMNS) {
            if (!(await queryRunner.hasColumn(self.DOCUMENTS, column.name))) {
                await queryRunner.addColumn(self.DOCUMENTS, column);
                if (column.name === 'revision_at') addedRevisionAt = true;
            }
        }

        if (addedRevisionAt) {
            await queryRunner.query(
                `UPDATE "${self.DOCUMENTS}" SET "revision_at" = COALESCE("updatedAt", "createdAt") WHERE "revision_at" IS NULL`,
            );
            await queryRunner.query(
                `UPDATE "${self.DOCUMENTS}" SET "archived_at" = "updatedAt" WHERE "status" = 'archived' AND "archived_at" IS NULL`,
            );
        }

        if (queryRunner.connection.options.type === 'postgres') {
            if (await queryRunner.hasTable(self.FOLDERS)) {
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}" DROP CONSTRAINT IF EXISTS "fk_wkd_folder"`,
                );
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}"
                     ADD CONSTRAINT "fk_wkd_folder"
                     FOREIGN KEY ("folder_id") REFERENCES "${self.FOLDERS}"("id")
                     ON DELETE SET NULL`,
                );
            }
            if (await queryRunner.hasTable('users')) {
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}" DROP CONSTRAINT IF EXISTS "fk_wkd_archived_by"`,
                );
                await queryRunner.query(
                    `ALTER TABLE "${self.DOCUMENTS}"
                     ADD CONSTRAINT "fk_wkd_archived_by"
                     FOREIGN KEY ("archived_by_id") REFERENCES "users"("id")
                     ON DELETE SET NULL`,
                );
            }
        }

        await this.ensureIndexes(queryRunner, self.DOCUMENTS, self.DOCUMENT_INDEXES);
    }

    // ─── knowledge_document_reader_states ────────────────────────────────

    private async upReaderStates(queryRunner: QueryRunner): Promise<void> {
        const self = AddKnowledgeLibraryFoldersAndReadState1791110060000;
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable(self.READER_STATES))) {
            await queryRunner.createTable(
                new Table({
                    name: self.READER_STATES,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'documentId', type: 'uuid' },
                        { name: 'lastOpenedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastReadRevision', type: 'int', default: 0 },
                        { name: 'pinnedAt', type: 'timestamp', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndexes(queryRunner, self.READER_STATES, self.READER_STATE_INDEXES);

        const foreignKeys: TableForeignKey[] = [];
        if (await queryRunner.hasTable('users')) {
            foreignKeys.push(
                new TableForeignKey({
                    name: 'fk_knowledge_reader_state_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
        if (await queryRunner.hasTable(self.DOCUMENTS)) {
            foreignKeys.push(
                new TableForeignKey({
                    name: 'fk_knowledge_reader_state_document',
                    columnNames: ['documentId'],
                    referencedTableName: self.DOCUMENTS,
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
        for (const foreignKey of foreignKeys) {
            const table = await queryRunner.getTable(self.READER_STATES);
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey(self.READER_STATES, foreignKey);
            }
        }
    }

    private async ensureIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of indexes) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(tableName, index);
            }
        }
    }
}
