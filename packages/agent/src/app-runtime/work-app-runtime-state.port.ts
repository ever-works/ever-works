import type { AppClusterCheck, AppJobResult, AppStatusSnapshot } from '@ever-works/plugin';
import type {
    AppRuntimeIngressAddress,
    AppRuntimeTargetSettings,
    WorkAppRuntimeState,
} from '../entities/work-app-runtime-state.entity';
import type { AppDeployTarget } from '@ever-works/contracts';

/**
 * APW-06 T17 — the port behind `WORK_APP_RUNTIME_STATES`, as the UNION of every
 * view its consumers declare.
 *
 * ## Why this file exists at all
 *
 * There was no such interface. Twelve consumers each declared their own
 * structural view of the same provider — `AppDeployRuntimeStateStore`,
 * `AppDeployRuntimeStateReader`, `AppDeployOrchestratorStateStore`,
 * `AppHealthStateStore`, `AppHostsStateStore`, `AppLifecycleOpStateStore`,
 * `WorkAppRuntimeStateDeletionStore`, `AppSmokeStateStore`,
 * `AppDomainsStateStore`, `AppRuntimeStateTargetStore`,
 * `WorkAppRuntimeStateReader`, plus one untyped `appContext.get(...)` in
 * `packages/tasks` — and the token is a `Symbol`, so **nothing type-checked the
 * binding against them**. A method with the wrong arity, or one simply missing,
 * would have bound cleanly and then answered `undefined` at the call site,
 * where every consumer's `hasMember` probe reads it as "not configured" rather
 * than as a bug. That failure mode is exactly what this epic already suffered
 * from at scale.
 *
 * `WorkAppRuntimeStateRepository implements WorkAppRuntimeStatePort` turns that
 * class of drift into a compile error.
 *
 * ## The rule for the signatures below
 *
 * Parameters are the **widest** any consumer passes; return types are the
 * **narrowest** any consumer accepts. One implementation then satisfies all
 * twelve views by ordinary structural assignability, and a consumer that later
 * widens its own view still type-checks.
 *
 * **The twelve consumer views are not edited.** They are deliberately loose
 * (almost every member is optional, because they were written while this port
 * did not exist) and they are additive-only. This file does not replace them;
 * it is what the implementation is checked against.
 *
 * Type-only imports throughout, and nothing from `database/` — an entity type
 * is imported for the row shape, not a repository, so this module adds no
 * runtime edge and cannot create an import cycle.
 */
export interface WorkAppRuntimeStatePort {
    // ── reads ───────────────────────────────────────────────────────────────

    /**
     * Insert-if-absent, plus FR-63's target derivation. Non-nullable: two views
     * (`AppDeployRuntimeStateReader`, `WorkAppRuntimeStateDeletionStore`)
     * declare it that way and dereference the result directly.
     */
    getOrCreate(workId: string): Promise<WorkAppRuntimeState>;

    /** APW-11's batched read. Creates nothing — see the method's own docstring. */
    findStateForWorks(workIds: string[]): Promise<Map<string, WorkAppRuntimeState>>;

    /**
     * §9.3's selection, ordered `lastPolledAt` nulls-first. `userId` is joined
     * from `works` because §7.2 carries no user id of its own.
     */
    selectForHealthPoll(limit: number): Promise<readonly WorkAppRuntimeStatePollRow[]>;

    /**
     * §9.10:1592's read half — the status of the named job's last run.
     *
     * Declared in NO consumer interface: `app-lifecycle-ops.service.ts:1734`
     * reaches it through an `as unknown as` cast and a `hasMember` probe. It is
     * in this port precisely because the probe hides its absence.
     */
    findJobState(workId: string, name: string): Promise<string | null>;

    // ── the deploy lock (§2.2 step 3, §9.10) ────────────────────────────────

    /** `staleAfterS` is OPTIONAL — `AppLifecycleOpStateStore` calls it with two arguments. */
    claimDeployLock(workId: string, deploymentId: string, staleAfterS?: number): Promise<boolean>;

    /** Clears the cancel flag in the same UPDATE (T17's own rule). */
    releaseDeployLock(workId: string, deploymentId: string): Promise<boolean>;

    requestCancel(workId: string, deploymentId: string, userId: string | null): Promise<boolean>;

    // ── the queue of one (§7.2:1056, §5.6 step 7) ───────────────────────────

    setQueued(
        workId: string,
        queued: AppDeployQueueWrite,
    ): Promise<{ supersededDeploymentId: string | null }>;

    takeQueued(
        workId: string,
    ): Promise<{ queuedDeploymentId: string | null; queuedBuildId: string | null } | null>;

    // ── the deploy writes (§5.6 step 6, §8.2) ───────────────────────────────

    patchRuntimeState(workId: string, patch: AppRuntimeStatePatch): Promise<void>;
    setUpstreamSyncJudgedToSha(workId: string, sha: string | null): Promise<void>;
    setPendingDomainRebuildBuildId(workId: string, buildId: string | null): Promise<void>;
    clearPendingDomainRebuild(workId: string, buildId: string): Promise<boolean>;

    // ── health and status (§7.2, §9.3, §9.10) ───────────────────────────────

    recordHealth(workId: string, patch: AppHealthStatePatch): Promise<void>;

    /**
     * `observedAt` is OPTIONAL — `AppHealthStateStore` calls it with two
     * arguments and `AppLifecycleOpStateStore` with three.
     */
    saveSnapshot(
        workId: string,
        snapshot: AppStatusSnapshot,
        observedAt?: string | Date,
    ): Promise<void>;

    /** Takes the `AppJobResult` ITSELF; it carries its own `name`. */
    saveJobResult(workId: string, job: AppJobResult): Promise<void>;

    saveClusterCheck(
        workId: string,
        check: AppClusterCheck & { fingerprint?: string | null },
        checkedAt: string | Date,
        ingressAddress: AppRuntimeIngressAddress | null,
    ): Promise<void>;

    saveIngressAddress(workId: string, address: AppRuntimeIngressAddress | null): Promise<void>;

    // ── lifecycle (§9.7, §9.10) ─────────────────────────────────────────────

    setPaused(workId: string, paused: boolean, at: Date): Promise<boolean>;
    markRemoved(workId: string, removedAt: Date): Promise<void>;

    claimDeletion(
        workId: string,
        opts: { deleteStoredData: boolean; requestedByUserId: string },
    ): Promise<boolean>;

    recordDeletionAttempt(workId: string): Promise<number>;
}

/** What {@link WorkAppRuntimeStatePort.selectForHealthPoll} adds to the row. */
export type WorkAppRuntimeStatePollRow = WorkAppRuntimeState & { userId?: string | null };

/**
 * §7.2:1056 — the latest-wins queue of exactly one, written in one transaction
 * so that "at most 1 is queued" holds under two concurrent requests.
 */
export interface AppDeployQueueWrite {
    deploymentId: string | null;
    buildId?: string | null;
}

/**
 * What one health poll writes back.
 *
 * An absent optional member means **leave the column exactly as it was**, which
 * is load-bearing for both of them: stamping `lastHealthNotifiedAt` on a poll
 * that notified nobody would suppress the next real notification for the whole
 * six-hour window, and writing an `undefined` address would clear a good one.
 */
export interface AppHealthStatePatch {
    health: string;
    consecutiveFailures: number;
    consecutivePasses: number;
    unreachableStreak: number;
    lastPolledAt: Date;
    lastHealthNotifiedAt?: Date;
    ingressAddress?: AppRuntimeIngressAddress | null;
}

/** §5.6 step 6 — the one write for the fields that step names. */
export interface AppRuntimeStatePatch {
    currentDeploymentId?: string | null;
    firstDeployJobsCompletedAt?: Date | null;
    firstPublishedAt?: Date | null;
    clusterFingerprint?: string | null;
    ingressAddress?: AppRuntimeIngressAddress | null;
    isolationEnforced?: boolean | null;
    namespace?: string | null;
    statusSnapshot?: AppStatusSnapshot | null;
    target?: AppDeployTarget;
    targetSettings?: AppRuntimeTargetSettings | null;
}
