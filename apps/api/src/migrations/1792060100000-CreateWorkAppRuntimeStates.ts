import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-06 T17 — creates `work_app_runtime_states`, the per-App-Work runtime
 * state row.
 *
 * Entity: `packages/agent/src/entities/work-app-runtime-state.entity.ts`
 * Plan: `docs/specs/features/app-works/APW-06-app-runtime/plan.md` §7.2 (the
 * column table) and §7.3 (this migration, which names this exact filename)
 * Repository: `packages/agent/src/database/repositories/work-app-runtime-state.repository.ts`
 *
 * Slot **01 of epic 06** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`).
 * Stamped above `1792050000000-CreateWorkBuilds.ts` and below
 * `1792070000000-CreateAppEnvAndDependencies.ts`, which is where §7.3 puts it.
 * Slot `1792060000000` is reserved by §7.3 for
 * `ExtendWorkDeploymentsForApps` (T18) and is deliberately left free: that
 * migration's columns do not exist on `WorkDeployment` yet, so writing it here
 * would be a migration for an entity change nobody has made.
 *
 * ## Why this migration is the one the whole epic was waiting for
 *
 * Twelve services inject `WORK_APP_RUNTIME_STATES` and this table backed none of
 * them: it existed in no migration and as no entity. `AppDeployRequestService`
 * therefore answered `503 app_deploy_state_unavailable` at
 * `app-deploy-request.service.ts:606` on every real request, before the lock
 * claim was ever attempted — so no App Work could be deployed, and roughly
 * fourteen thousand lines of deploy code could not run. Creating the table is
 * the first half of fixing that; binding the repository (`AppRuntimeStateModule`)
 * is the second.
 *
 * ## What `up()` does, and nothing else
 *
 * One `CREATE TABLE`, one foreign key and the four indexes §7.2 names. Nothing
 * is renamed, dropped or narrowed (CONTRACTS R-26, the owner's additive-only
 * rule), and no existing table is read or written.
 *
 * ## No backfill
 *
 * There is none to write. The row is created on first read by
 * `WorkAppRuntimeStateRepository.getOrCreate`, and a Work that has never been
 * asked about has no runtime state to describe. Inventing a row per existing
 * Work would also invent a `target` for Works that have not chosen one, which
 * FR-63's derivation is there to decide at read time.
 *
 * ## Timestamps are `bigint` epoch milliseconds
 *
 * `bigint` here and `TimestampColumn` on the entity, exactly as
 * `work_upstream_states` and `work_deployments` do, and `plan.md:1020` states
 * the reason in the plan's own words: better-sqlite3 cannot boot with
 * `timestamptz`. The health poller's hot ordering key is `lastPolledAt`, which
 * has to mean the same thing on Postgres (production) and on the better-sqlite3
 * driver CI and the e2e lane run.
 *
 * `createdAt` / `updatedAt` use `CURRENT_TIMESTAMP` rather than Postgres'
 * `now()` for the same portability reason.
 *
 * The four `simple-json` columns of the entity (`targetSettings`,
 * `clusterCheck`, `ingressAddress`, `statusSnapshot`) are `text` here — that is
 * what TypeORM's `simple-json` stores, and it is portable.
 *
 * ## The foreign key, and the six uuids that deliberately have none
 *
 * `workId → works(id)` ON DELETE CASCADE, and it is the ONLY foreign key.
 * §7.2 justifies the cascade explicitly: the row disappears only after §9.7 has
 * removed the workloads and APW-01 deletes the Work, so nothing the teardown
 * needs (target, namespace, fingerprint) is gone before it runs.
 *
 * `currentDeploymentId`, `queuedDeploymentId`, `queuedBuildId`,
 * `pendingDomainRebuildBuildId`, `deployLockId`, `cancelRequestedByUserId` and
 * `deletionRequestedByUserId` are bare uuids on purpose, for the reason
 * `plan.md:244` gives for `conflictTaskId`: a Deployment, Build or User deleted
 * after it was named here must not cascade away the state row that merely links
 * to it — and `deployLockId` in particular must stay writable to a value no
 * table holds while a dispatch is in flight.
 *
 * ## The four indexes
 *
 * - `uq_work_app_runtime_states_work` UNIQUE `(workId)` — one row per App Work,
 *   and the thing that decides the `getOrCreate` insert race. Created as a
 *   unique INDEX rather than a table constraint so the same object and the same
 *   name exist on both drivers.
 * - `idx_work_app_runtime_states_poll` `(target, paused, lastPolledAt)` —
 *   §9.3's health-poll selection and its ordering key.
 * - `idx_work_app_runtime_states_lock` `(deployLockId)` — the stale-lock sweep.
 * - `idx_work_app_runtime_states_deletion` `(deletionRequestedAt)` — §9.7's
 *   deleting-Works scan.
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * the foreign key), so a re-run is a no-op and `down()` is safe on a database
 * where `up()` never ran. `down()` drops the four indexes and the table, and
 * touches nothing else.
 */
export class CreateWorkAppRuntimeStates1792060100000 implements MigrationInterface {
    name = 'CreateWorkAppRuntimeStates1792060100000';

    private static readonly TABLE = 'work_app_runtime_states';
    private static readonly UNIQUE_WORK = 'uq_work_app_runtime_states_work';
    private static readonly INDEX_POLL = 'idx_work_app_runtime_states_poll';
    private static readonly INDEX_LOCK = 'idx_work_app_runtime_states_lock';
    private static readonly INDEX_DELETION = 'idx_work_app_runtime_states_deletion';
    private static readonly FOREIGN_KEY = 'fk_work_app_runtime_states_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(CreateWorkAppRuntimeStates1792060100000.TABLE))) {
            await queryRunner.createTable(
                new Table({
                    name: CreateWorkAppRuntimeStates1792060100000.TABLE,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        // One row per App Work — the unique index below enforces it.
                        { name: 'workId', type: 'uuid' },
                        // 'none' | 'your-cluster' | 'ever-works-apps' (R-12). `none`
                        // is a real product state, not a missing value.
                        { name: 'target', type: 'varchar', length: '24', default: "'none'" },
                        // simple-json: ingress class, TLS, isolation, the two domain switches.
                        { name: 'targetSettings', type: 'text', isNullable: true },
                        // Frozen at the first `prepare-namespace` per fingerprint (GAP-06).
                        // 63 = the Kubernetes limit, so the column cannot hold a name
                        // the API server would refuse.
                        { name: 'namespace', type: 'varchar', length: '63', isNullable: true },
                        // The DEPLOYED cluster. A `cluster-check` never writes it.
                        {
                            name: 'clusterFingerprint',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        // simple-json, secret-free, carries its OWN fingerprint.
                        { name: 'clusterCheck', type: 'text', isNullable: true },
                        { name: 'clusterCheckedAt', type: 'bigint', isNullable: true },
                        // No FK: a deleted Deployment must not cascade (plan :244).
                        { name: 'currentDeploymentId', type: 'uuid', isNullable: true },
                        // The atomic claim. Stale after 7 260 s -> reclaimable.
                        { name: 'deployLockId', type: 'uuid', isNullable: true },
                        { name: 'deployLockedAt', type: 'bigint', isNullable: true },
                        // Cleared by releaseDeployLock in the SAME update (APW06-G03).
                        { name: 'cancelRequestedAt', type: 'bigint', isNullable: true },
                        { name: 'cancelRequestedByUserId', type: 'uuid', isNullable: true },
                        // Latest-wins queue of exactly one (§7.2:1056).
                        { name: 'queuedDeploymentId', type: 'uuid', isNullable: true },
                        { name: 'queuedBuildId', type: 'uuid', isNullable: true },
                        // The Build a `rebuild` domain change asked for (§8.2, APW06-G11).
                        { name: 'pendingDomainRebuildBuildId', type: 'uuid', isNullable: true },
                        // The upstream-sync toSha already judged (APW06-G10).
                        {
                            name: 'upstreamSyncJudgedToSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        { name: 'firstPublishedAt', type: 'bigint', isNullable: true },
                        // Reset when clusterFingerprint changes (§7.2).
                        { name: 'firstDeployJobsCompletedAt', type: 'bigint', isNullable: true },
                        { name: 'paused', type: 'boolean', default: false },
                        { name: 'pausedAt', type: 'bigint', isNullable: true },
                        { name: 'removedAt', type: 'bigint', isNullable: true },
                        // §9.7 / R-15 — App Work deletion in progress.
                        { name: 'deletionRequestedAt', type: 'bigint', isNullable: true },
                        { name: 'deletionDeleteData', type: 'boolean', isNullable: true },
                        { name: 'deletionAttempts', type: 'int', default: 0 },
                        { name: 'deletionRequestedByUserId', type: 'uuid', isNullable: true },
                        // simple-json `{ ip?, hostname? }` — FR-41's address.
                        { name: 'ingressAddress', type: 'text', isNullable: true },
                        { name: 'isolationEnforced', type: 'boolean', isNullable: true },
                        // 'unknown' | 'healthy' | 'degraded' | 'down' | 'unreachable'.
                        { name: 'health', type: 'varchar', length: '16', default: "'unknown'" },
                        { name: 'consecutiveFailures', type: 'int', default: 0 },
                        { name: 'consecutivePasses', type: 'int', default: 0 },
                        { name: 'unreachableStreak', type: 'int', default: 0 },
                        { name: 'lastHealthNotifiedAt', type: 'bigint', isNullable: true },
                        // §9.3's ordering key.
                        { name: 'lastPolledAt', type: 'bigint', isNullable: true },
                        { name: 'certInvalidSince', type: 'bigint', isNullable: true },
                        // simple-json `AppStatusSnapshot` — no log text.
                        { name: 'statusSnapshot', type: 'text', isNullable: true },
                        { name: 'statusObservedAt', type: 'bigint', isNullable: true },
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

        const table = await queryRunner.getTable(CreateWorkAppRuntimeStates1792060100000.TABLE);
        if (!table) {
            return;
        }

        // One runtime-state row per App Work. This index is also what decides
        // the `getOrCreate` insert race between two concurrent readers.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppRuntimeStates1792060100000.UNIQUE_WORK,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppRuntimeStates1792060100000.TABLE,
                new TableIndex({
                    name: CreateWorkAppRuntimeStates1792060100000.UNIQUE_WORK,
                    columnNames: ['workId'],
                    isUnique: true,
                }),
            );
        }

        // §9.3's health-poll selection and its ordering key.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppRuntimeStates1792060100000.INDEX_POLL,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppRuntimeStates1792060100000.TABLE,
                new TableIndex({
                    name: CreateWorkAppRuntimeStates1792060100000.INDEX_POLL,
                    columnNames: ['target', 'paused', 'lastPolledAt'],
                }),
            );
        }

        // The stale-lock sweep.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppRuntimeStates1792060100000.INDEX_LOCK,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppRuntimeStates1792060100000.TABLE,
                new TableIndex({
                    name: CreateWorkAppRuntimeStates1792060100000.INDEX_LOCK,
                    columnNames: ['deployLockId'],
                }),
            );
        }

        // §9.7's deleting-Works scan.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppRuntimeStates1792060100000.INDEX_DELETION,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppRuntimeStates1792060100000.TABLE,
                new TableIndex({
                    name: CreateWorkAppRuntimeStates1792060100000.INDEX_DELETION,
                    columnNames: ['deletionRequestedAt'],
                }),
            );
        }

        if (
            !table.foreignKeys.some(
                (fk) => fk.name === CreateWorkAppRuntimeStates1792060100000.FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateWorkAppRuntimeStates1792060100000.TABLE,
                new TableForeignKey({
                    name: CreateWorkAppRuntimeStates1792060100000.FOREIGN_KEY,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * Drops the four indexes and then the table — nothing else. Each step is
     * re-checked rather than assumed, so a database where `up()` never ran (or
     * ran only halfway) leaves without an error, and a table this migration did
     * not create is never dropped.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(CreateWorkAppRuntimeStates1792060100000.TABLE))) {
            return;
        }

        const table = await queryRunner.getTable(CreateWorkAppRuntimeStates1792060100000.TABLE);
        if (table) {
            for (const name of [
                CreateWorkAppRuntimeStates1792060100000.INDEX_DELETION,
                CreateWorkAppRuntimeStates1792060100000.INDEX_LOCK,
                CreateWorkAppRuntimeStates1792060100000.INDEX_POLL,
                CreateWorkAppRuntimeStates1792060100000.UNIQUE_WORK,
            ]) {
                if (table.indices.some((index) => index.name === name)) {
                    await queryRunner.dropIndex(
                        CreateWorkAppRuntimeStates1792060100000.TABLE,
                        name,
                    );
                }
            }

            if (
                table.foreignKeys.some(
                    (fk) => fk.name === CreateWorkAppRuntimeStates1792060100000.FOREIGN_KEY,
                )
            ) {
                await queryRunner.dropForeignKey(
                    CreateWorkAppRuntimeStates1792060100000.TABLE,
                    CreateWorkAppRuntimeStates1792060100000.FOREIGN_KEY,
                );
            }
        }

        await queryRunner.dropTable(CreateWorkAppRuntimeStates1792060100000.TABLE);
    }
}
