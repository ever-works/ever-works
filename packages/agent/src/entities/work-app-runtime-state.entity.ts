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
import type { AppDeployTarget } from '@ever-works/contracts';
import type { AppClusterCheck, AppStatusSnapshot } from '@ever-works/plugin';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * App Works — the per-Work **runtime** state row (APW-06 T17).
 *
 * Spec: `docs/specs/features/app-works/APW-06-app-runtime/tasks.md` T17. Plan:
 * `…/plan.md` §7.2 is the normative column list — this file implements it column
 * for column, with the four index names §7.2 fixes. Migration:
 * `apps/api/src/migrations/1792060100000-CreateWorkAppRuntimeStates.ts` (§7.3).
 *
 * ## Why this row is the thing the epic could not run without
 *
 * Twelve services inject it through one token, `WORK_APP_RUNTIME_STATES`
 * (declared at `app-launcher/app-launcher.service.ts:223`). Until 2026-09-21
 * **nothing provided it and this table existed in no migration**, so
 * `AppDeployRequestService.requestDeploy` short-circuited at
 * `app-deploy-request.service.ts:606` with `503 app_deploy_state_unavailable`
 * before it ever reached the lock claim — which is to say no App Work could be
 * deployed at all, and none of APW-06's deploy path could execute. Every
 * injection site is `@Optional()`, so nothing crashed; the feature was simply
 * inert. That is the shape of the whole branch's problem, and this row is where
 * it is worst.
 *
 * ## One row per App Work
 *
 * `workId` is UNIQUE (`uq_work_app_runtime_states_work`), exactly as
 * `WorkUpstreamState` is: the target, the namespace, the deploy lock, the queue
 * of one, the health counters and the deletion claim are ONE row, so two writers
 * cannot leave two half-states behind. The FK is
 * `workId → works(id) ON DELETE CASCADE`, which §7.2 justifies explicitly: the
 * row disappears only after §9.7 has removed the workloads and APW-01 deletes
 * the Work, so nothing the teardown needs (target, namespace, fingerprint) is
 * gone before it runs.
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * Exactly as in `WorkDeployment` and `WorkUpstreamState`, and §7.2 states the
 * reason in its own words at `plan.md:1020`: better-sqlite3 cannot boot with
 * `timestamptz`, and the health poller's hot predicate orders by `lastPolledAt`,
 * which has to mean the same thing on both drivers. The transformer turns the
 * stored epoch back into a `Date` on read, so callers see a normal `Date`.
 *
 * ## No `licenseAttestation` column, on purpose (R-3, ACC-06-39)
 *
 * Hosting eligibility is read from APW-03's `AppLicenseService` at the moment it
 * is needed, never cached here. A column would be a second source of truth for a
 * legal answer, and a stale one. `work-app-runtime-state.repository.spec.ts`
 * asserts the absence against the entity METADATA, not against this file's text.
 *
 * ## Scope columns carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the reason `WorkDeployment` records (EW-654/EW-655) and
 * `WorkUpstreamState` repeats: a relation here drags the Tenant/Organization
 * entity graph into the decorator evaluation of the whole inventory and
 * re-creates an import cycle. `currentDeploymentId`, `queuedDeploymentId`,
 * `queuedBuildId`, `pendingDomainRebuildBuildId`, `deployLockId`,
 * `cancelRequestedByUserId` and `deletionRequestedByUserId` are bare uuids for
 * the same class of reason `plan.md:244` gives for `conflictTaskId`: a deleted
 * Deployment, Build or User must not cascade into a state row whose only
 * connection to it is an id.
 */
@Entity({ name: 'work_app_runtime_states' })
@Index('uq_work_app_runtime_states_work', ['workId'], { unique: true })
@Index('idx_work_app_runtime_states_poll', ['target', 'paused', 'lastPolledAt'])
@Index('idx_work_app_runtime_states_lock', ['deployLockId'])
@Index('idx_work_app_runtime_states_deletion', ['deletionRequestedAt'])
export class WorkAppRuntimeState {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work this row describes. One row per Work — see the class docstring. */
    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /**
     * `none` · `your-cluster` · `ever-works-apps` (R-12).
     *
     * `none` is the default and is a real product state — "None — don't deploy
     * yet" — not a missing value. FR-63's derivation in
     * `WorkAppRuntimeStateRepository.getOrCreate` fills it in from the Work's
     * creation-time choice the first time the row is read, and never overwrites
     * a target the owner has since changed.
     */
    @Column({ type: 'varchar', length: 24, default: 'none' })
    target: AppDeployTarget;

    /**
     * `{ namespaceOverride?, ingressClass?, controllerNamespace?, tls, issuer?,
     * storageClass?, networkIsolation, allowRoot, managedSubdomain,
     * primaryDomain?, autoDeploy, previews }` (§7.2). `managedSubdomain` is
     * effective only when the apps domain is configured (R-16).
     */
    @Column({ type: 'simple-json', nullable: true })
    targetSettings?: AppRuntimeTargetSettings | null;

    /**
     * **Frozen at the first `prepare-namespace`** — whichever of dependency
     * provisioning or the first Deployment comes first — per
     * `clusterFingerprint` (GAP-06). 63 characters is the Kubernetes limit for a
     * namespace name, so the column cannot hold one the API server would refuse.
     */
    @Column({ type: 'varchar', length: 63, nullable: true })
    namespace?: string | null;

    /**
     * The **deployed** cluster, from `parseKubeconfig`. Written by
     * `prepare-namespace` and §5.6 only: a `cluster-check` never writes it, and
     * its own fingerprint lives inside {@link clusterCheck}. Reading one where
     * the other belongs is how a check against the wrong cluster would look like
     * a successful deploy.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    clusterFingerprint?: string | null;

    /** Secret-free check result, including its own `fingerprint` and observed address. */
    @Column({ type: 'simple-json', nullable: true })
    clusterCheck?: (AppClusterCheck & { fingerprint?: string | null }) | null;

    @TimestampColumn({ nullable: true })
    clusterCheckedAt?: Date | null;

    /** The Deployment this Work last reached `READY` on. */
    @Column({ type: 'uuid', nullable: true })
    currentDeploymentId?: string | null;

    /**
     * The atomic deploy claim. NULL ⇒ nothing is dispatching.
     *
     * `claimDeployLock` sets it with a conditional UPDATE that also requires
     * `paused = false` and `deletionRequestedAt IS NULL` (APW06-G03), so a paused
     * or deleting App Work cannot be deployed by a racing request. A lock is
     * stale after `APP_DEPLOY_LOCK_STALE_S` (7 260 s = the max deploy duration
     * plus 60) and is then reclaimable — that bound is what stops a crashed
     * dispatcher from wedging a Work forever.
     */
    @Column({ type: 'uuid', nullable: true })
    deployLockId?: string | null;

    @TimestampColumn({ nullable: true })
    deployLockedAt?: Date | null;

    /**
     * The cancel flag `hooks.isCancelled()` reads (APW06-G05). Honoured only
     * while {@link deployLockId} still holds the same Deployment id, and cleared
     * by `releaseDeployLock` **in the same UPDATE** — otherwise a cancel left
     * behind by one Deployment would cancel the next one.
     */
    @TimestampColumn({ nullable: true })
    cancelRequestedAt?: Date | null;

    @Column({ type: 'uuid', nullable: true })
    cancelRequestedByUserId?: string | null;

    /**
     * Latest-wins queue of exactly one (§7.2:1056). `setQueued` writes both
     * columns in one transaction and answers the id it displaced, so the caller
     * can mark that Deployment `SUPERSEDED`; one call for both is what makes
     * "at most 1 is queued" hold under two concurrent requests. For
     * `build.strategy: image`, `queuedBuildId` stays NULL and the row carries the
     * spec commit (§5.8).
     */
    @Column({ type: 'uuid', nullable: true })
    queuedDeploymentId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    queuedBuildId?: string | null;

    /**
     * The Build requested by a `rebuild` domain change (§8.2). Cleared when its
     * Deployment is requested, or when that Build's `app.build.failed` /
     * `app.build.cancelled` arrives (APW06-G11).
     */
    @Column({ type: 'uuid', nullable: true })
    pendingDomainRebuildBuildId?: string | null;

    /** The upstream-sync `toSha` whose first Deployment has already been judged (APW06-G10). */
    @Column({ type: 'varchar', length: 40, nullable: true })
    upstreamSyncJudgedToSha?: string | null;

    @TimestampColumn({ nullable: true })
    firstPublishedAt?: Date | null;

    /** Reset when {@link clusterFingerprint} changes — a new cluster has run no first-deploy jobs. */
    @TimestampColumn({ nullable: true })
    firstDeployJobsCompletedAt?: Date | null;

    /**
     * Stopped by its owner. The pair is read as "paused if either says so"
     * everywhere (`app-launcher.service.ts`, `app-deploy-preconditions`), so a
     * `pausedAt` without the flag still means paused.
     */
    @Column({ type: 'boolean', default: false })
    paused: boolean;

    @TimestampColumn({ nullable: true })
    pausedAt?: Date | null;

    /** The runtime was removed (§9.10's terminal write, which also clears `currentDeploymentId`). */
    @TimestampColumn({ nullable: true })
    removedAt?: Date | null;

    /** App Work deletion in progress (§9.7, R-15). */
    @TimestampColumn({ nullable: true })
    deletionRequestedAt?: Date | null;

    /** The typed-confirmed "Also delete stored data". */
    @Column({ type: 'boolean', nullable: true })
    deletionDeleteData?: boolean | null;

    @Column({ type: 'int', default: 0 })
    deletionAttempts: number;

    /**
     * Who requested the deletion, for Activity attribution. The fork/copy
     * decision stays APW-01's and is carried out in its request, not here.
     */
    @Column({ type: 'uuid', nullable: true })
    deletionRequestedByUserId?: string | null;

    /** `{ ip?, hostname? }` — FR-41's address, re-validated on every health poll. */
    @Column({ type: 'simple-json', nullable: true })
    ingressAddress?: AppRuntimeIngressAddress | null;

    @Column({ type: 'boolean', nullable: true })
    isolationEnforced?: boolean | null;

    /** `unknown` · `healthy` · `degraded` · `down` · `unreachable` (§7.2:1067). */
    @Column({ type: 'varchar', length: 16, default: 'unknown' })
    health: AppRuntimeHealth;

    @Column({ type: 'int', default: 0 })
    consecutiveFailures: number;

    @Column({ type: 'int', default: 0 })
    consecutivePasses: number;

    @Column({ type: 'int', default: 0 })
    unreachableStreak: number;

    /** The 6 h notification window **and** §9.4's streak handle. */
    @TimestampColumn({ nullable: true })
    lastHealthNotifiedAt?: Date | null;

    /** §9.3's ordering key — `NULLS FIRST`, so a never-polled row is polled first. */
    @TimestampColumn({ nullable: true })
    lastPolledAt?: Date | null;

    @TimestampColumn({ nullable: true })
    certInvalidSince?: Date | null;

    /** `AppStatusSnapshot` — component names and phases, never log text. */
    @Column({ type: 'simple-json', nullable: true })
    statusSnapshot?: AppStatusSnapshot | null;

    @TimestampColumn({ nullable: true })
    statusObservedAt?: Date | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs, plain
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

/**
 * §7.2's `targetSettings` bag.
 *
 * Declared here rather than in `@ever-works/contracts` because the shape the
 * COLUMN holds is this entity's business, and every consumer reads a narrower
 * view of it (`{ tls }`, `{ tls, managedSubdomain }`,
 * `{ tls, managedSubdomain, primaryDomain }`). A structural type keeps those
 * views assignable without a cast, which is what they do today.
 */
export interface AppRuntimeTargetSettings {
    namespaceOverride?: string | null;
    ingressClass?: string | null;
    controllerNamespace?: string | null;
    tls?: string | null;
    issuer?: string | null;
    storageClass?: string | null;
    networkIsolation?: boolean | null;
    allowRoot?: boolean | null;
    /** Effective only when the apps domain is configured (R-16). */
    managedSubdomain?: boolean | null;
    primaryDomain?: string | null;
    autoDeploy?: boolean | null;
    previews?: boolean | null;
}

/** §7.2's `ingressAddress` bag — what a cluster check or a reconcile observed. */
export interface AppRuntimeIngressAddress {
    ip?: string | null;
    hostname?: string | null;
}

/**
 * §7.2's `health` values. `unknown` is the default and a real state: a Work with
 * nothing deployed has not been judged, which is not the same as `down`.
 */
export type AppRuntimeHealth = 'unknown' | 'healthy' | 'degraded' | 'down' | 'unreachable';
