import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-04 (App Provisioner) — creates `work_app_provisionings`.
 *
 * Entity: `packages/agent/src/entities/work-app-provisioning.entity.ts` (T7).
 * Repository: `packages/agent/src/database/repositories/work-app-provisioning.repository.ts` (T7).
 * Plan: `docs/specs/features/app-works/APW-04-app-provisioner/plan.md` §3.1 (the
 * column table, `:346-394`) and §3.4 (`:752-758`).
 *
 * ## The stamp is `1792040000000`, and it is NOT re-stamped above the newest file
 *
 * Slot **00 of epic 04** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * the stamp T8 and plan §3.4 both fix.
 *
 * 🛑 The newest file in this directory is
 * `1792110000000-CreateAppLauncherPreferences.ts` (APW-11's slot-00 migration),
 * so a literal reading of T8's "re-stamped above the newest migration on
 * `develop` at merge time (`1791240000000-AddSafetyRailsCore.ts` at `ee45946e5`)"
 * **cannot hold**: T8's own Done-when names the newest migration it knew about,
 * and the block has moved past it. Re-stamping to `179212…` would take this file
 * out of epic 04's reserved slot and collide with a future epic 12's; the
 * 179204 stamp is kept and this note records why (APW-05 T5's migration carries
 * the identical note for the identical reason, `1792050000000-CreateWorkBuilds.ts:16-23`).
 *
 * The ordering concern is unreal in practice: TypeORM orders ALL migrations by
 * timestamp and then filters out the applied ones, so this file still RUNS on a
 * database that has already executed APW-11's — and the two are independent
 * additive migrations over disjoint tables. T8's spec proves both directions
 * (`up()` then `down()` then `up()`, with a pre-existing table present
 * throughout).
 *
 * ## What `up()` does, and nothing else
 *
 * One `CREATE TABLE`, its one foreign key and the six indexes plan §3.1:387-394
 * names. Nothing is renamed, dropped or narrowed (CONTRACTS R-26, the owner's
 * additive-only rule), and no existing table is read or written.
 *
 * ## No backfill
 *
 * There is none to write: no App Work was ever provisioned before APW-04, so the
 * table is empty on arrival.
 *
 * ## The dates are `timestamp`, matching `PortableDateColumn`
 *
 * The entity declares every date with `PortableDateColumn` (`type: Date`), which
 * TypeORM renders as `timestamp` on PostgreSQL and `datetime` on the SQLite
 * family. The columns are spelled `timestamp` here for that reason, and
 * `createdAt` / `updatedAt` use `CURRENT_TIMESTAMP` rather than `now()`: `now()`
 * is a function of one dialect and every insert under the test driver would fail
 * on it. 🛑 This table deliberately does NOT use `TimestampColumn` (bigint epoch
 * ms): plan §3.1:383 names `PortableDateColumn` for these four groups, and the
 * repository's window predicates (`leaseExpiresAt < :now`,
 * `verificationExpiresAt <= :now`) compare stored dates against a bound date on
 * every driver rather than doing arithmetic on a number.
 *
 * ## The one foreign key
 *
 * `workId → works(id)` ON DELETE CASCADE: the row describes one Work and has no
 * meaning without it. It is the ONLY foreign key. `taskId`, `agentId`,
 * `conversationId`, `openInboxItemId` and the two run-id bags are deliberately
 * bare (`plan.md:356`): a Task, an Agent or a conversation is retained on its own
 * schedule, and a delete there must never take a provisioning's history with it.
 *
 * ## The six indexes, three of them PARTIAL
 *
 * - `uq_work_app_provisionings_active` UNIQUE `(workId)` **WHERE `status IN
 *   ('queued','running','needs_input')`** — one ACTIVE provisioning per App Work
 *   (ACC-04-03). A plain unique would make the second provisioning of a Work
 *   impossible forever, and re-provisioning is the epic's own FR-59.
 * - `uq_work_app_provisionings_task` UNIQUE `(taskId)` **WHERE `taskId IS NOT
 *   NULL`** — one row per provisioning Task, while every queued row may carry no
 *   Task yet without colliding.
 * - `uq_work_app_provisionings_suggestion` UNIQUE `(suggestionUpstream)` **WHERE
 *   `suggestionState = 'queued'`** — one OPEN suggestion per upstream; a settled
 *   one leaves the slot free.
 * - `idx_work_app_provisionings_user_status` `(userId, status)` — the per-user
 *   cap (3).
 * - `idx_work_app_provisionings_org_status` `(organizationId, status)` — the
 *   per-org cap (10).
 * - `idx_work_app_provisionings_expiry` `(verificationExpiresAt)` — the sweeper.
 *
 * TypeORM emits a `TableIndex`'s `where` on **PostgreSQL and the SQLite family**,
 * both of which support partial indexes; that is the same treatment
 * `uq_org_invitations_pending_email`
 * (`1786930000000-CreateOrganizationInvitationsAndMembers.ts`) and
 * `uq_conversation_messages_client_id`
 * (`1791120000000-AddConversationKindAndParticipants.ts`) already use, and it is
 * ONE declaration rather than a branch on `queryRunner.connection.options.type`.
 * MySQL and MariaDB have no partial index at all and receive the index without
 * the predicate; there the service's compare-and-set plus T50's lost-insert race
 * path is what keeps one ACTIVE row. Every index is created as a unique/named
 * INDEX rather than a table constraint, so the same object and the same name
 * exist on every driver.
 *
 * ## Forward-only, idempotent, portable, no driver branch
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * the foreign key), so a re-run is a no-op and `down()` is safe on a database
 * where `up()` never ran. There is no `queryRunner.connection.options.type` read,
 * no `queryRunner.query(...)` raw statement and no dialect-specific expression
 * anywhere in this file, so `up()` and `down()` behave identically on all four
 * drivers — which is what `apps/api/src/migrations/__tests__/CreateWorkAppProvisionings.spec.ts`
 * asserts by reading this source, and the same rule commit `b5a7d6857` fixed for
 * the repositories.
 */
export class CreateWorkAppProvisionings1792040000000 implements MigrationInterface {
    name = 'CreateWorkAppProvisionings1792040000000';

    private static readonly TABLE = 'work_app_provisionings';

    private static readonly UNIQUE_ACTIVE = 'uq_work_app_provisionings_active';
    private static readonly UNIQUE_TASK = 'uq_work_app_provisionings_task';
    private static readonly INDEX_USER_STATUS = 'idx_work_app_provisionings_user_status';
    private static readonly INDEX_ORG_STATUS = 'idx_work_app_provisionings_org_status';
    private static readonly INDEX_EXPIRY = 'idx_work_app_provisionings_expiry';
    private static readonly UNIQUE_SUGGESTION = 'uq_work_app_provisionings_suggestion';

    private static readonly FK_WORK = 'fk_work_app_provisionings_work';

    /** The three statuses that mean ACTIVE — the partial predicate of index one. */
    private static readonly ACTIVE_PREDICATE = "status IN ('queued', 'running', 'needs_input')";

    /** Every index this migration creates — used by `down()`, and by nothing else. */
    private static readonly INDEXES = [
        CreateWorkAppProvisionings1792040000000.UNIQUE_ACTIVE,
        CreateWorkAppProvisionings1792040000000.UNIQUE_TASK,
        CreateWorkAppProvisionings1792040000000.INDEX_USER_STATUS,
        CreateWorkAppProvisionings1792040000000.INDEX_ORG_STATUS,
        CreateWorkAppProvisionings1792040000000.INDEX_EXPIRY,
        CreateWorkAppProvisionings1792040000000.UNIQUE_SUGGESTION,
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkAppProvisionings1792040000000.TABLE;

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
                        // One provisioning of one App Work. The partial unique
                        // index below is what makes at most ONE of them active.
                        { name: 'workId', type: 'uuid' },
                        // The starter; the question's recipient.
                        { name: 'userId', type: 'uuid' },
                        // No FK on any of these four (plan :356).
                        { name: 'taskId', type: 'uuid', isNullable: true },
                        { name: 'agentId', type: 'uuid', isNullable: true },
                        // 'auto-create' | 'manual' | 'chat' | 'upstream-smoke' | 'auto-upstream-smoke'.
                        { name: 'trigger', type: 'varchar', length: '24' },
                        // 'queued' | 'running' | 'needs_input' | 'succeeded' | 'merged' | 'failed' | 'cancelled'.
                        { name: 'status', type: 'varchar', length: '16' },
                        // 'user-limit' | 'org-limit' — set only while waiting for a slot.
                        { name: 'queuedReason', type: 'varchar', length: '24', isNullable: true },
                        { name: 'step', type: 'varchar', length: '16', default: "'repository'" },
                        // The simple-json columns are text on every driver.
                        { name: 'stepStates', type: 'text', isNullable: true },
                        // 'app-spec' | 'compose' | 'dockerfile' | 'helm' | 'descriptor-hint' | 'auto'.
                        {
                            name: 'detectionSource',
                            type: 'varchar',
                            length: '24',
                            isNullable: true,
                        },
                        { name: 'verified', type: 'boolean', isNullable: true },
                        // Spec §5.3's closed set, incl. 'private-repository'.
                        { name: 'failureReason', type: 'varchar', length: '40', isNullable: true },
                        { name: 'baseSha', type: 'varchar', length: '64', isNullable: true },
                        { name: 'headSha', type: 'varchar', length: '64', isNullable: true },
                        { name: 'prNumber', type: 'int', isNullable: true },
                        { name: 'prUrl', type: 'varchar', length: '512', isNullable: true },
                        { name: 'attempts', type: 'text', isNullable: true },
                        { name: 'attemptBudget', type: 'int', default: 3 },
                        { name: 'attemptsUsed', type: 'int', default: 0 },
                        { name: 'questionsAsked', type: 'int', default: 0 },
                        // Never on the wire except as question.inboxItemId.
                        { name: 'openInboxItemId', type: 'uuid', isNullable: true },
                        { name: 'questionAskedAt', type: 'timestamp', isNullable: true },
                        { name: 'questionRemindedAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'questionReason',
                            type: 'varchar',
                            length: '24',
                            isNullable: true,
                        },
                        // Names and numbers only, ≤ 1 KB, scanForSecrets-ed.
                        { name: 'questionParams', type: 'text', isNullable: true },
                        { name: 'tokensUsed', type: 'bigint', default: 0 },
                        { name: 'tokenCap', type: 'bigint', default: 3_000_000 },
                        { name: 'runnerMinutesUsed', type: 'int', default: 0 },
                        { name: 'runnerMinuteCap', type: 'int', default: 240 },
                        { name: 'activeMs', type: 'bigint', default: 0 },
                        // 'kill-switch' | 'agent-paused' | 'workspace-paused' | 'scope-paused'.
                        { name: 'parkedReason', type: 'varchar', length: '24', isNullable: true },
                        { name: 'parkedAt', type: 'timestamp', isNullable: true },
                        { name: 'runIds', type: 'text', isNullable: true },
                        { name: 'buildIds', type: 'text', isNullable: true },
                        // The last session's provision-output block, ≤ 512 KB,
                        // cleared once the guard has read it. 🛑 MySQL/MariaDB
                        // needs `mediumtext` for a value this size; the portable
                        // spelling is used here on purpose (no driver branch).
                        { name: 'lastRunOutput', type: 'text', isNullable: true },
                        // 'cluster' | 'runner'.
                        {
                            name: 'verificationTargetKind',
                            type: 'varchar',
                            length: '16',
                            isNullable: true,
                        },
                        {
                            name: 'verificationNamespace',
                            type: 'varchar',
                            length: '63',
                            isNullable: true,
                        },
                        { name: 'verificationExpiresAt', type: 'timestamp', isNullable: true },
                        { name: 'conversationId', type: 'uuid', isNullable: true },
                        { name: 'chatMessagesPosted', type: 'int', default: 0 },
                        // "Anything to tell the agent" — fenced as user input.
                        { name: 'note', type: 'varchar', length: '500', isNullable: true },
                        {
                            name: 'upstreamFromSha',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'upstreamToSha', type: 'varchar', length: '64', isNullable: true },
                        {
                            name: 'suggestionState',
                            type: 'varchar',
                            length: '16',
                            isNullable: true,
                        },
                        {
                            name: 'suggestionUpstream',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                        },
                        { name: 'suggestedAt', type: 'timestamp', isNullable: true },
                        { name: 'suggestionBundle', type: 'text', isNullable: true },
                        // The step executor's lease: a token and its expiry (5 min).
                        { name: 'lease', type: 'varchar', length: '36', isNullable: true },
                        { name: 'leaseExpiresAt', type: 'timestamp', isNullable: true },
                        { name: 'startedAt', type: 'timestamp', isNullable: true },
                        { name: 'finishedAt', type: 'timestamp', isNullable: true },
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

        const provisionings = await queryRunner.getTable(table);
        if (!provisionings) {
            return;
        }

        const indexes = [
            // The ACTIVE row. Partial on purpose — see the file docstring.
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.UNIQUE_ACTIVE,
                columnNames: ['workId'],
                isUnique: true,
                where: CreateWorkAppProvisionings1792040000000.ACTIVE_PREDICATE,
            }),
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.UNIQUE_TASK,
                columnNames: ['taskId'],
                isUnique: true,
                where: '"taskId" IS NOT NULL',
            }),
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.INDEX_USER_STATUS,
                columnNames: ['userId', 'status'],
            }),
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.INDEX_ORG_STATUS,
                columnNames: ['organizationId', 'status'],
            }),
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.INDEX_EXPIRY,
                columnNames: ['verificationExpiresAt'],
            }),
            new TableIndex({
                name: CreateWorkAppProvisionings1792040000000.UNIQUE_SUGGESTION,
                columnNames: ['suggestionUpstream'],
                isUnique: true,
                where: '"suggestionState" = \'queued\'',
            }),
        ];

        for (const index of indexes) {
            if (!provisionings.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }

        if (
            !provisionings.foreignKeys.some(
                (fk) => fk.name === CreateWorkAppProvisionings1792040000000.FK_WORK,
            )
        ) {
            await queryRunner.createForeignKey(
                table,
                new TableForeignKey({
                    name: CreateWorkAppProvisionings1792040000000.FK_WORK,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * Drops the six indexes and then the table — nothing else.
     *
     * Each step is re-checked rather than assumed, so a database where `up()`
     * never ran (or ran only halfway) leaves without an error and a table this
     * migration did not create is never dropped. The foreign key belongs to the
     * table and goes with it (`dropTable(name, ifExists, dropIndices, cascade)`).
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkAppProvisionings1792040000000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const provisionings = await queryRunner.getTable(table);

        for (const name of CreateWorkAppProvisionings1792040000000.INDEXES) {
            if (provisionings?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(table, name);
            }
        }

        await queryRunner.dropTable(table, true, true, true);
    }
}
