import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    AppBuildBlockedReason,
    AppBuildCancelReason,
    AppBuildRunnerClass,
    AppBuildSecretCheckResult,
    AppBuildStatus,
    AppBuildSyncOrigin,
    AppBuildTrigger,
} from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * App Works — one Build of one App Work (APW-05).
 *
 * Spec: `docs/specs/features/app-works/APW-05-builds/spec.md` (FR-17 the Build
 * row, FR-34/FR-35 the two intake paths, FR-41 Rebuild). Plan:
 * `…/plan.md` §3.1 (`plan.md:329-396`) is the normative column list — this
 * file implements it column for column, with the five index names the plan
 * fixes at `plan.md:367-373`. Migration:
 * `apps/api/src/migrations/1792050000000-CreateWorkBuilds.ts` (§3.3). Repository:
 * `packages/agent/src/database/repositories/app-build.repository.ts` (T6),
 * which owns the number arithmetic below.
 *
 * ## `number` is the per-App-Work sequence, and `(workId, number)` is UNIQUE
 *
 * `uq_work_builds_work_number` is what makes "Build #14" (APW-06) a name and
 * not a guess: the number is assigned inside the insert transaction by
 * `AppBuildRepository.insertWithNextNumber`, which locks the parent Work row on
 * the pooled drivers and retries on a unique violation — the arithmetic lives
 * there (`plan.md:381-392`), never here.
 *
 * ## The run-identity index carries NO partial clause on purpose
 *
 * `uq_work_builds_provider_run` is a plain UNIQUE over
 * `(buildPluginId, providerRunId, runAttempt)`. This is the `APW05-G10`
 * portability rule, stated at `plan.md:375-379`: the platform also runs on
 * MySQL and MariaDB (`database.config.ts:29-34`), and three things follow —
 *
 *   1. NULLs are distinct inside a unique index on Postgres, SQLite **and**
 *      MySQL/MariaDB, so a manual or verification Build that has not been
 *      adopted yet (`providerRunId` NULL) never collides;
 *   2. `upsert(conflictPaths)` therefore works on every driver, without the
 *      Postgres-only `indexPredicate`;
 *   3. one DDL statement is valid on all four drivers.
 *
 * A `WHERE` clause here would compile on Postgres, be refused by MySQL, and
 * silently stop the two intake paths (webhook and poll) from converging on one
 * row. `work-build.entity.spec.ts` pins its absence.
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * Exactly as in `WorkDeployment` (`_types.ts:69-105`) and `WorkUpstreamState`.
 * A raw `Date` column is `timestamptz` on Postgres and `datetime` on SQLite,
 * and the sweep's predicates are numeric comparisons (`lastObservedAt <
 * :cutoff`, `watchLeaseUntil < :now`) that have to mean the same thing on both
 * — `plan.md:387-388` and §7.3 (`plan.md:1386-1388`) state the same for the
 * lease. The transformer turns the stored epoch back into a `Date` on read.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `status`, `trigger`, `cancelReason`, `secretCheck`, `runnerClass` and
 * `syncOrigin` are typed by the contracts unions (`APP_BUILD_STATUSES`,
 * `APP_BUILD_TRIGGERS`, `APP_BUILD_CANCEL_REASONS`,
 * `APP_BUILD_SECRET_CHECK_RESULTS`, `APP_BUILD_RUNNER_CLASSES`,
 * `APP_BUILD_SYNC_ORIGINS` — `packages/contracts/src/apps/builds.ts`, APW-05's
 * own module), so a value the API renders is a value the column can hold.
 * `blockedReason`, `notDeployableReason` and `failureClass` stay deliberately
 * plain varchars: those sets are closed in contracts too, and the columns are
 * widened there first, never by a migration here.
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the reason `WorkDeployment` records at `_types.ts` (EW-654/EW-655): a
 * relation here drags the Tenant/Organization entity graph into the decorator
 * evaluation of the whole inventory and re-creates the import cycle that bit
 * Phase 2. `apps/api/src/scope/scope-stamping.subscriber.ts` stamps them, which
 * is what `plan.md:578` means by "declared so the subscriber stamps them".
 *
 * `usageEventId` (`plugin_usage_events.id`, the receipt), `triggeredByUserId`
 * and `verifiesBuildId` (the verification run that reused an earlier Build's
 * image) are bare uuids for the same class of reason the plan gives
 * `WorkUpstreamState.conflictTaskId`: the row they point at may be deleted or
 * retained on its own schedule, and a cascade from it must never take a Build's
 * history with it. `plan.md:362` says so for the first; the other two follow
 * the same rule and carry no FK in the migration.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/builds.jsonl`, reached through the parent Work ids;
 * the secret-name and spec-hash columns are reviewed as benign and
 * `buildInputsHash` is dropped (`plan.md:327`, T45).
 */
@Entity({ name: 'work_builds' })
@Index('uq_work_builds_work_number', ['workId', 'number'], { unique: true })
@Index('uq_work_builds_provider_run', ['buildPluginId', 'providerRunId', 'runAttempt'], {
    unique: true,
})
@Index('idx_work_builds_work_created', ['workId', 'createdAt'])
@Index('idx_work_builds_work_commit', ['workId', 'commitSha'])
@Index('idx_work_builds_status_observed', ['status', 'lastObservedAt'])
export class WorkBuild {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work this Build belongs to. */
    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** Per-App-Work sequence from 1 — `uq_work_builds_work_number` (plan §3.1:334). */
    @Column({ type: 'int' })
    number: number;

    /** Which build plugin ran it; part of the run identity below. */
    @Column({ type: 'varchar', length: 64 })
    buildPluginId: string;

    /** `queued` · `running` · `succeeded` · `failed` · `cancelled` · `blocked`. */
    @Column({ type: 'varchar', length: 16 })
    status: AppBuildStatus;

    /** `push` · `pull_request` · `manual` · `verification`. */
    @Column({ type: 'varchar', length: 16 })
    trigger: AppBuildTrigger;

    /** A reason code from `APP_BUILD_BLOCKED_REASONS`; NULL unless `blocked`. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    blockedReason?: AppBuildBlockedReason | null;

    /** Names and numbers only, ≤ 2 KB — never a value (`plan.md:338`). */
    @Column({ type: 'simple-json', nullable: true })
    blockedDetail?: Record<string, string | number | string[]> | null;

    /** `user` · `superseded`. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    cancelReason?: AppBuildCancelReason | null;

    /** The branch the run was dispatched for. */
    @Column({ type: 'varchar', length: 255 })
    branch: string;

    /** The commit the run built. */
    @Column({ type: 'varchar', length: 40 })
    commitSha: string;

    /** Set for a `pull_request` Build; NULL otherwise. */
    @Column({ type: 'int', nullable: true })
    pullRequestNumber?: number | null;

    /** The provider's run id; NULL until a manual or verification dispatch is adopted. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    providerRunId?: string | null;

    /** The provider's attempt counter; a re-run is a second row under the same run id. */
    @Column({ type: 'int', default: 1 })
    runAttempt: number;

    /** Equals `id` for a manual or verification Build (`plan.md:342`); NULL otherwise. */
    @Column({ type: 'uuid', nullable: true })
    dispatchCorrelationId?: string | null;

    /** When the run was dispatched — the adoption window and the sweep's fallback clock. */
    @TimestampColumn({ nullable: true })
    dispatchedAt?: Date | null;

    /** The App spec hash at `commitSha` (`AppSpecService`, APW-03). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    appSpecHash?: string | null;

    /** `getEffectiveSpec(workId, sha)`'s verdict at this commit; NULL = never read. */
    @Column({ type: 'boolean', nullable: true })
    specValidAtCommit?: boolean | null;

    /** sha256 over (name, fingerprint) of the synced build values (§4.7). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    buildInputsHash?: string | null;

    /** The `EW_` names this preparation wrote (≤ 50). Names only, never values. */
    @Column({ type: 'simple-json', nullable: true })
    buildSecretNames?: string[] | null;

    /** When that sync finished — the deployable verdict's freshness clock (§5.1). */
    @TimestampColumn({ nullable: true })
    secretsSyncedAt?: Date | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    runnerLabel?: string | null;

    /** `github-public` · `github-private` · `github-larger` · `apps-builder`. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    runnerClass?: AppBuildRunnerClass | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    imageRepository?: string | null;

    /** `sha256:<64 hex>`; only a confirmed digest is ever deployable. */
    @Column({ type: 'varchar', length: 71, nullable: true })
    imageDigest?: string | null;

    /** At most three tags (`plan.md:348`). */
    @Column({ type: 'simple-json', nullable: true })
    imageTags?: string[] | null;

    /** Set only after the registry digest was read back (§4.8). */
    @Column({ type: 'boolean', default: false })
    digestConfirmed: boolean;

    /** `passed` · `failed` · `not_needed`; NULL until the check ran (§4.11). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    secretCheck?: AppBuildSecretCheckResult | null;

    /** The verdict, recomputed at completion (§5.1) — never set before then. */
    @Column({ type: 'boolean', default: false })
    deployable: boolean;

    /** The first failing clause of §5.1's order, or NULL while deployable. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    notDeployableReason?: string | null;

    /** A member of `APP_BUILD_FAILURE_CLASSES`, or NULL while not failed. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    failureClass?: string | null;

    /** `{ step?, total?, command? (≤ 120), names?, memory?, max? }` (`plan.md:352`). */
    @Column({ type: 'simple-json', nullable: true })
    failureDetail?: Record<string, unknown> | null;

    /** `string[]` ≤ 20, each ≤ 300, redacted (§4.9). */
    @Column({ type: 'simple-json', nullable: true })
    failureExcerpt?: string[] | null;

    /** `{ componentsReady, jobs[] ≤ 10, smoke[] ≤ 50 }` (CONTRACTS §3 shape). */
    @Column({ type: 'simple-json', nullable: true })
    verificationResult?: Record<string, unknown> | null;

    /** The verification run that reused an earlier Build's image. No FK — see the docstring. */
    @Column({ type: 'uuid', nullable: true })
    verifiesBuildId?: string | null;

    /** `none` · `upstreamSync` — the producer APW-04 and APW-06 read (`APW04-G06`). */
    @Column({ type: 'varchar', length: 24, default: 'none' })
    syncOrigin: AppBuildSyncOrigin;

    /** The upstream range this Build's commit came from; NULL unless `upstreamSync`. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    syncFromSha?: string | null;

    @Column({ type: 'varchar', length: 40, nullable: true })
    syncToSha?: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    logsUrl?: string | null;

    @TimestampColumn({ nullable: true })
    queuedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    startedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    completedAt?: Date | null;

    /** The sweep's freshness reading; every observation re-stamps it (§7.4). */
    @TimestampColumn({ nullable: true })
    lastObservedAt?: Date | null;

    /** The `app-build-watch` one-shot lease (§7.3); NULL = nobody is watching. */
    @TimestampColumn({ nullable: true })
    watchLeaseUntil?: Date | null;

    @Column({ type: 'int', nullable: true })
    durationSeconds?: number | null;

    /** The billed minutes of the build job itself. */
    @Column({ type: 'int', nullable: true })
    billableMinutes?: number | null;

    /** The `checks` job's minutes, included in `billableMinutes` (R-9, `plan.md:360`). */
    @Column({ type: 'int', nullable: true })
    checksBillableMinutes?: number | null;

    /** The per-run prompted-value secret a verification wrote (§4.10); removed at the end. */
    @Column({ type: 'simple-json', nullable: true })
    verifySecretNames?: string[] | null;

    /** `plugin_usage_events.id` — the receipt. Bare uuid, no FK (see the docstring). */
    @Column({ type: 'uuid', nullable: true })
    usageEventId?: string | null;

    /** Who asked for a manual or verification Build. No FK — see the docstring. */
    @Column({ type: 'uuid', nullable: true })
    triggeredByUserId?: string | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope stamps, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
