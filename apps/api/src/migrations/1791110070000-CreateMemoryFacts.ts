import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableCheck,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Memory facts (AW-07) — the `memory_facts` table.
 *
 * Timestamp: authored in AW-07's reserved block as slot 00
 * (`1791070000000`), re-stamped above the newest migration on `develop`
 * (`1791110000000-CreateComputerSessions`) so applied order stays monotonic.
 * `…0070000` is deliberately NOT a multiple of 100000, so it cannot collide
 * with any epic's reserved slot.
 *
 * Entity: `packages/agent/src/entities/memory-fact.entity.ts`
 *
 * ## What it holds
 *
 * One row per atomic fact an owner wants every agent in a workspace to
 * carry into its runs. Tier C ownership like `memory_folders`: `userId` is
 * the owner, `tenantId` / `organizationId` the workspace.
 *
 * ## No vector column — deliberately
 *
 * Vectors go through the vector-store capability (the bundled pgvector store
 * or a registry-installed Qdrant store) into the workspace's own namespace.
 * The platform keeps only the coordinates of that write — `vectorStoreId`,
 * `embeddingModel`, `embeddingDims`, `embeddedAt` — which is what the nightly
 * sweep reads to find facts that were never embedded, were embedded by a
 * model that has since changed, or live in a store that has been swapped out.
 * A `vector(1536)` column here would be a second vector store beside the one
 * the platform already abstracts, pinned to one backend and one dimension.
 *
 * ## Constraints
 *
 *  - `chk_memory_facts_agent_scope`: an `agent`-scoped fact names exactly
 *    one agent and a `workspace`-scoped fact names none.
 *  - `chk_memory_facts_body_len`: 1–500 characters. `length()` rather than
 *    `char_length()` because both drivers understand it.
 *  - The exact-duplicate defence (`LOWER(body)` per workspace among live
 *    rows) is enforced in the service: a partial expression index cannot be
 *    expressed identically on Postgres and better-sqlite3.
 *
 * ## Indexes
 *
 *  - `idx_memory_facts_owner_status` — every list and count.
 *  - `idx_memory_facts_agent` — "facts limited to this agent".
 *  - `idx_memory_facts_forgotten_at` — the purge sweep.
 *  - `idx_memory_facts_embedded_at` — the embed backfill sweep.
 *
 * ## Foreign keys
 *
 * `userId → users.id` and `agentId → agents.id`, both CASCADE: a fact
 * limited to an agent means nothing once the agent is gone. `sourceRunId`
 * and `sourceAgentId` carry no FK — runs are reaped and a proposal's
 * provenance must outlive them.
 *
 * Forward-only + idempotent (`hasTable` guard), portable `Table` DDL rather
 * than raw SQL, because production runs Postgres while CI runs
 * better-sqlite3.
 */
export class CreateMemoryFacts1791110070000 implements MigrationInterface {
    name = 'CreateMemoryFacts1791110070000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('memory_facts')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'memory_facts',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'scope', type: 'varchar', length: '16', default: "'workspace'" },
                    { name: 'agentId', type: 'uuid', isNullable: true },
                    { name: 'body', type: 'varchar', length: '500' },
                    { name: 'status', type: 'varchar', length: '16', default: "'active'" },
                    { name: 'origin', type: 'varchar', length: '16', default: "'user'" },
                    { name: 'sourceRunId', type: 'uuid', isNullable: true },
                    { name: 'sourceConversationId', type: 'uuid', isNullable: true },
                    { name: 'sourceAgentId', type: 'uuid', isNullable: true },
                    { name: 'pinned', type: 'boolean', default: false },
                    { name: 'vectorStoreId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'embeddingModel', type: 'varchar', length: '128', isNullable: true },
                    { name: 'embeddingDims', type: 'int', isNullable: true },
                    { name: 'embeddedAt', type: 'timestamp', isNullable: true },
                    { name: 'recallCount', type: 'int', default: 0 },
                    { name: 'lastRecalledAt', type: 'timestamp', isNullable: true },
                    { name: 'supersedesFactId', type: 'uuid', isNullable: true },
                    { name: 'forgottenAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
                checks: [
                    new TableCheck({
                        name: 'chk_memory_facts_agent_scope',
                        expression: `("scope" = 'agent' AND "agentId" IS NOT NULL) OR ("scope" = 'workspace' AND "agentId" IS NULL)`,
                    }),
                    new TableCheck({
                        name: 'chk_memory_facts_body_len',
                        expression: 'length("body") BETWEEN 1 AND 500',
                    }),
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'memory_facts',
            new TableIndex({
                name: 'idx_memory_facts_owner_status',
                columnNames: ['userId', 'organizationId', 'status'],
            }),
        );
        await queryRunner.createIndex(
            'memory_facts',
            new TableIndex({ name: 'idx_memory_facts_agent', columnNames: ['agentId'] }),
        );
        await queryRunner.createIndex(
            'memory_facts',
            new TableIndex({ name: 'idx_memory_facts_forgotten_at', columnNames: ['forgottenAt'] }),
        );
        await queryRunner.createIndex(
            'memory_facts',
            new TableIndex({ name: 'idx_memory_facts_embedded_at', columnNames: ['embeddedAt'] }),
        );

        // Guarded on the referenced tables existing so a hand-rolled database
        // whose earlier migrations have not run cannot explode here.
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'memory_facts',
                new TableForeignKey({
                    name: 'fk_memory_facts_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
        if (await queryRunner.hasTable('agents')) {
            await queryRunner.createForeignKey(
                'memory_facts',
                new TableForeignKey({
                    name: 'fk_memory_facts_agent',
                    columnNames: ['agentId'],
                    referencedTableName: 'agents',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('memory_facts'))) {
            return;
        }
        const table = await queryRunner.getTable('memory_facts');
        for (const name of [
            'idx_memory_facts_embedded_at',
            'idx_memory_facts_forgotten_at',
            'idx_memory_facts_agent',
            'idx_memory_facts_owner_status',
        ]) {
            const index = table?.indices.find((candidate) => candidate.name === name);
            if (index) {
                await queryRunner.dropIndex('memory_facts', index);
            }
        }
        // Dropping the table also drops its checks and foreign keys. The
        // vectors themselves live in the vector store and are not touched —
        // they are unreachable without these rows and a re-embed rebuilds
        // them, so reverting loses the facts but nothing else.
        await queryRunner.dropTable('memory_facts', true);
    }
}
