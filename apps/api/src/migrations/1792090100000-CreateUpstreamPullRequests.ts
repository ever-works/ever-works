import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-09 T7 — `upstream_pull_requests`, the record of every upstream pull request an App
 * Work proposes or opens (plan §3.1, CONTRACTS §1 `UpstreamPullRequest`).
 *
 * ## The timestamp (Resolution R-39)
 *
 * The App Works block is `1792` + two-digit epic + two-digit slot + `00000`. APW-09's slot
 * `00` (`1792090000000`) is taken by `AddWorkUpstreamCredentialMember` (T43), so this
 * migration takes slot `01`, and its two siblings `02` / `03` — stamped in merge order, as
 * R-39 requires, rather than in the plan's authoring order.
 *
 * ## Columns
 *
 * Plan §3.1's list, plus two additive columns the APW-09 lane log records:
 * `origin` (`proposal` · `direct`, default `proposal`) and `draft` (default `false`). And one
 * relaxation: `sourceTaskId` is NULLABLE, because the direct route may name a fork branch
 * rather than a Task. NULLs never collide in the partial unique index on either driver.
 *
 * Dates are `timestamp`, matching the entity's `PortableDateColumn`, and `createdAt` /
 * `updatedAt` default to `CURRENT_TIMESTAMP` (portable) rather than `now()`. The
 * `simple-json` columns are `text`.
 *
 * ## Indexes
 *
 * - `idx_upr_work_state (workId, state)` — the Upstream tab's list.
 * - `idx_upr_user_upstream_opened (userId, upstreamOwner, upstreamRepo, openedAt)` — FR-26's
 *   per-member windows.
 * - `idx_upr_upstream_opened (upstreamOwner, upstreamRepo, openedAt)` — FR-39's platform-wide
 *   ceiling, counted across every member (an addition to the plan's four, for the same reason).
 * - `idx_upr_due (state, nextCheckAt)` — the status poll.
 * - `idx_upr_preparing_started (state, preparationStartedAt)` — the G14 deadline sweep.
 * - `uq_upr_active_source (sourceTaskId)` UNIQUE **WHERE `state IN (…active…)`** — at most one
 *   active record per source Task (FR-5, S27). TypeORM emits the predicate on PostgreSQL and
 *   the SQLite family; MySQL/MariaDB receive the index without it, the same posture as
 *   `uq_work_app_provisionings_active`.
 *
 * ## Keys
 *
 * `userId → users(id)` and `workId → works(id)`, both ON DELETE CASCADE. Every Task id is
 * bare: a Task deletion must not erase a published pull request's record.
 *
 * ## Forward-only, idempotent, portable, no driver branch
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and foreign key),
 * so a re-run is a no-op and `down()` is safe where `up()` never ran. No
 * `queryRunner.connection.options.type` read, no raw statement, no dialect expression.
 */
export class CreateUpstreamPullRequests1792090100000 implements MigrationInterface {
    name = 'CreateUpstreamPullRequests1792090100000';

    private static readonly TABLE = 'upstream_pull_requests';

    private static readonly INDEX_WORK_STATE = 'idx_upr_work_state';
    private static readonly INDEX_USER_UPSTREAM_OPENED = 'idx_upr_user_upstream_opened';
    private static readonly INDEX_UPSTREAM_OPENED = 'idx_upr_upstream_opened';
    private static readonly INDEX_DUE = 'idx_upr_due';
    private static readonly INDEX_PREPARING_STARTED = 'idx_upr_preparing_started';
    private static readonly UNIQUE_ACTIVE_SOURCE = 'uq_upr_active_source';

    private static readonly FK_USER = 'fk_upr_user';
    private static readonly FK_WORK = 'fk_upr_work';

    /** `UPSTREAM_ACTIVE_STATES` — the partial predicate of the unique index. */
    private static readonly ACTIVE_PREDICATE =
        "state IN ('preparing', 'needs_signature', 'awaiting_approval', 'opening', 'open')";

    /** Every index this migration creates — used by `down()`, and by nothing else. */
    private static readonly INDEXES = [
        CreateUpstreamPullRequests1792090100000.INDEX_WORK_STATE,
        CreateUpstreamPullRequests1792090100000.INDEX_USER_UPSTREAM_OPENED,
        CreateUpstreamPullRequests1792090100000.INDEX_UPSTREAM_OPENED,
        CreateUpstreamPullRequests1792090100000.INDEX_DUE,
        CreateUpstreamPullRequests1792090100000.INDEX_PREPARING_STARTED,
        CreateUpstreamPullRequests1792090100000.UNIQUE_ACTIVE_SOURCE,
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = CreateUpstreamPullRequests1792090100000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            await queryRunner.createTable(
                new Table({
                    name: table,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'workId', type: 'uuid' },
                        // NULL only for a direct, branch-named pull request (see the docstring).
                        { name: 'sourceTaskId', type: 'uuid', isNullable: true },
                        { name: 'preparationTaskId', type: 'uuid', isNullable: true },
                        { name: 'followUpTaskId', type: 'uuid', isNullable: true },
                        // 'proposal' | 'direct'.
                        { name: 'origin', type: 'varchar', length: '16', default: "'proposal'" },
                        { name: 'upstreamOwner', type: 'varchar', length: '100' },
                        { name: 'upstreamRepo', type: 'varchar', length: '100' },
                        { name: 'baseBranch', type: 'varchar', length: '255' },
                        { name: 'headOwner', type: 'varchar', length: '100' },
                        { name: 'headRepo', type: 'varchar', length: '100' },
                        { name: 'headBranch', type: 'varchar', length: '255' },
                        { name: 'headSha', type: 'varchar', length: '64', isNullable: true },
                        {
                            name: 'upstreamBaseSha',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'preparationStartedAt', type: 'timestamp', isNullable: true },
                        { name: 'preparationHeldSince', type: 'timestamp', isNullable: true },
                        { name: 'preparationPausedMs', type: 'bigint', default: 0 },
                        // UPSTREAM_PULL_REQUEST_STATES.
                        { name: 'state', type: 'varchar', length: '24', default: "'preparing'" },
                        { name: 'number', type: 'int', isNullable: true },
                        { name: 'url', type: 'varchar', length: '512', isNullable: true },
                        { name: 'draft', type: 'boolean', default: false },
                        { name: 'title', type: 'varchar', length: '200', isNullable: true },
                        { name: 'body', type: 'text', isNullable: true },
                        {
                            name: 'disclosureText',
                            type: 'varchar',
                            length: '300',
                            isNullable: true,
                        },
                        { name: 'claUrl', type: 'varchar', length: '512', isNullable: true },
                        { name: 'missingPieces', type: 'text', isNullable: true },
                        { name: 'maintainerCanModify', type: 'boolean', default: true },
                        { name: 'fingerprint', type: 'varchar', length: '64', isNullable: true },
                        { name: 'approvalProposalId', type: 'uuid', isNullable: true },
                        { name: 'approvalExpiresAt', type: 'timestamp', isNullable: true },
                        { name: 'extraFilesAcknowledgedAt', type: 'timestamp', isNullable: true },
                        { name: 'extraFilesAcknowledgedById', type: 'uuid', isNullable: true },
                        { name: 'checksSummary', type: 'varchar', length: '32', isNullable: true },
                        { name: 'reviewSummary', type: 'varchar', length: '24', isNullable: true },
                        { name: 'signatureState', type: 'varchar', length: '24', isNullable: true },
                        { name: 'refusalCode', type: 'varchar', length: '32', isNullable: true },
                        { name: 'refusalDetail', type: 'varchar', length: '500', isNullable: true },
                        { name: 'diffStats', type: 'text', isNullable: true },
                        { name: 'checkResults', type: 'text', isNullable: true },
                        { name: 'seenReviewIds', type: 'text', isNullable: true },
                        { name: 'pushTimestamps', type: 'text', isNullable: true },
                        { name: 'forkBranchDeletedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastUpstreamActivityAt', type: 'timestamp', isNullable: true },
                        { name: 'lastCheckedAt', type: 'timestamp', isNullable: true },
                        { name: 'nextCheckAt', type: 'timestamp', isNullable: true },
                        { name: 'openedAt', type: 'timestamp', isNullable: true },
                        { name: 'mergedAt', type: 'timestamp', isNullable: true },
                        { name: 'closedAt', type: 'timestamp', isNullable: true },
                        // EW-655 scope stamping — plain columns, no relation.
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const created = await queryRunner.getTable(table);
        if (!created) {
            return;
        }

        const indexes = [
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.INDEX_WORK_STATE,
                columnNames: ['workId', 'state'],
            }),
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.INDEX_USER_UPSTREAM_OPENED,
                columnNames: ['userId', 'upstreamOwner', 'upstreamRepo', 'openedAt'],
            }),
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.INDEX_UPSTREAM_OPENED,
                columnNames: ['upstreamOwner', 'upstreamRepo', 'openedAt'],
            }),
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.INDEX_DUE,
                columnNames: ['state', 'nextCheckAt'],
            }),
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.INDEX_PREPARING_STARTED,
                columnNames: ['state', 'preparationStartedAt'],
            }),
            // The ACTIVE row per source Task. Partial on purpose — see the docstring.
            new TableIndex({
                name: CreateUpstreamPullRequests1792090100000.UNIQUE_ACTIVE_SOURCE,
                columnNames: ['sourceTaskId'],
                isUnique: true,
                where: CreateUpstreamPullRequests1792090100000.ACTIVE_PREDICATE,
            }),
        ];

        for (const index of indexes) {
            if (!created.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }

        const foreignKeys = [
            new TableForeignKey({
                name: CreateUpstreamPullRequests1792090100000.FK_USER,
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
            new TableForeignKey({
                name: CreateUpstreamPullRequests1792090100000.FK_WORK,
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        ];

        for (const fk of foreignKeys) {
            if (!created.foreignKeys.some((existing) => existing.name === fk.name)) {
                await queryRunner.createForeignKey(table, fk);
            }
        }
    }

    /**
     * Drops the six indexes and then the table — nothing else. Each step is re-checked, so
     * a database where `up()` never ran (or ran halfway) leaves without an error. The foreign
     * keys belong to the table and go with it.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = CreateUpstreamPullRequests1792090100000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const existing = await queryRunner.getTable(table);

        for (const name of CreateUpstreamPullRequests1792090100000.INDEXES) {
            if (existing?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(table, name);
            }
        }

        await queryRunner.dropTable(table, true, true, true);
    }
}
