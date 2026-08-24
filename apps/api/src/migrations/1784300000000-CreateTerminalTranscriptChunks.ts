import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Streaming-terminal M9 / founder decision D1 — persisted terminal
 * transcripts with plan-tier retention.
 *
 * WHAT
 *   1. `terminal_transcript_chunks` — the append-only store. One row per
 *      published `stdout` frame: (runId, seq) unique so the writer is
 *      idempotent under the worker transport's 413 split-and-retry, plus
 *      a `createdAt` index the retention sweeper scans.
 *   2. `terminal-transcript-retention-days` entitlement rows, seeded
 *      per plan CODE (INSERT-if-missing, same posture as the
 *      `1783400000000` credits seed).
 *
 * WHY
 *   Before this, the relay kept a bounded in-memory scrollback and
 *   nothing was persisted: closing the tab lost the session and a dead
 *   run could never be replayed. D1 confirmed transcripts are stored
 *   SERVER-SIDE, tenant-scoped, secret-redacted, and retention-capped,
 *   with **retention as a plan-tier lever** — "forever" on top plans,
 *   bounded windows on cheap ones.
 *
 * RETENTION SEMANTICS (`plan_entitlements.valueInt`)
 *   -1 → forever (never swept)
 *    0 → keep nothing (nothing is written at all)
 *    N → keep N days, `terminal-transcript-gc` prunes past the window
 *
 *   Seeded defaults: free = 0, standard = 30, premium = -1. Each is
 *   env-overridable at migration time so an operator can pick a
 *   different opening posture without editing history.
 *
 * SCHEMA NOTES
 *   - `runId` is a raw uuid column, no entity relation — the EW-654
 *     cycle-avoidance rule. The FK is declared here with ON DELETE
 *     CASCADE so deleting a run takes its transcript with it.
 *   - Content columns hold REDACTED text only; redaction happens in
 *     `TerminalTranscriptService` before the insert, never here.
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1784200000000-CreateIngestInstallBindings`.
 */
export class CreateTerminalTranscriptChunks1784300000000 implements MigrationInterface {
    name = 'CreateTerminalTranscriptChunks1784300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('terminal_transcript_chunks'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'terminal_transcript_chunks',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'runId', type: 'uuid' },
                        { name: 'seq', type: 'int' },
                        { name: 'direction', type: 'varchar', length: '8', default: `'out'` },
                        { name: 'text', type: 'text' },
                        { name: 'byteLength', type: 'int', default: 0 },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'terminal_transcript_chunks',
                new TableIndex({
                    name: 'idx_terminal_transcript_chunks_run_seq',
                    columnNames: ['runId', 'seq'],
                    isUnique: true,
                }),
            );

            await queryRunner.createIndex(
                'terminal_transcript_chunks',
                new TableIndex({
                    name: 'idx_terminal_transcript_chunks_created',
                    columnNames: ['createdAt'],
                }),
            );

            await queryRunner.createForeignKey(
                'terminal_transcript_chunks',
                new TableForeignKey({
                    name: 'fk_terminal_transcript_chunks_run',
                    columnNames: ['runId'],
                    referencedTableName: 'agent_runs',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        await CreateTerminalTranscriptChunks1784300000000.seedRetentionEntitlements(queryRunner);
    }

    /**
     * INSERT-if-missing seed of the retention lever per plan code. Never
     * overwrites an operator-edited row — an existing (planId, key) pair
     * is left exactly as found.
     */
    private static async seedRetentionEntitlements(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('plan_entitlements'))) {
            return;
        }

        const intFromEnv = (name: string, fallback: number): number => {
            const raw = process.env[name];
            if (raw === undefined || raw === null || raw === '') {
                return fallback;
            }
            const parsed = parseInt(raw, 10);
            // -1 (forever) is a legal value, so only reject non-numbers
            // and anything below the sentinel.
            return Number.isFinite(parsed) && parsed >= -1 ? parsed : fallback;
        };

        const KEY = 'terminal-transcript-retention-days';
        const seeds: Array<{ planId: string; key: string; valueInt: number }> = [
            // Cheap plan: nothing is written at all.
            { planId: 'free', key: KEY, valueInt: intFromEnv('TERMINAL_TRANSCRIPT_DAYS_FREE', 0) },
            // Bounded window.
            {
                planId: 'standard',
                key: KEY,
                valueInt: intFromEnv('TERMINAL_TRANSCRIPT_DAYS_STANDARD', 30),
            },
            // Top plan: forever.
            {
                planId: 'premium',
                key: KEY,
                valueInt: intFromEnv('TERMINAL_TRANSCRIPT_DAYS_PREMIUM', -1),
            },
        ];

        for (const seed of seeds) {
            const existing = await queryRunner.manager
                .createQueryBuilder()
                .select('pe.id', 'id')
                .from('plan_entitlements', 'pe')
                // Identifiers are double-quoted explicitly so this query does not
                // depend on TypeORM resolving the raw table name to an entity.
                //
                // It normally does: the runtime DataSource registers every entity
                // (`database.config.ts` → `entities: ENTITIES`) alongside the
                // migrations glob, so `.from('plan_entitlements', 'pe')` matches
                // `PlanEntitlement` BY TABLE NAME and the emitted SQL is fully
                // quoted — which is why this seed has always worked on Postgres.
                // Quoting here only removes the dependency on that lookup; it is
                // what makes the query correct for a table with NO entity, where
                // TypeORM would emit `pe.planId` verbatim and Postgres would fold
                // it to `pe.planid` (sqlite, which CI runs on, matches unquoted
                // identifiers case-insensitively and would not catch it).
                .where('pe."planId" = :planId AND pe."key" = :key', {
                    planId: seed.planId,
                    key: seed.key,
                })
                .getRawOne();
            if (existing) {
                continue;
            }
            await queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into('plan_entitlements', ['id', 'planId', 'key', 'valueInt'])
                .values({
                    id: randomUUID(),
                    planId: seed.planId,
                    key: seed.key,
                    valueInt: seed.valueInt,
                })
                .execute();
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('plan_entitlements')) {
            await queryRunner.manager
                .createQueryBuilder()
                .delete()
                .from('plan_entitlements')
                .where('key = :key', { key: 'terminal-transcript-retention-days' })
                .execute();
        }
        if (await queryRunner.hasTable('terminal_transcript_chunks')) {
            await queryRunner.dropTable('terminal_transcript_chunks', true);
        }
    }
}
