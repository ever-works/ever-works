import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_BEHIND_EVENT_STEP,
    APP_PRIVATE_COPY_MAX_SIZE_KB,
    APP_RATE_LIMIT_BACKOFF_BASE_MS,
    APP_RATE_LIMIT_BACKOFF_MAX_MS,
    APP_RATE_LIMIT_MIN_REMAINING,
    APP_RATE_LIMIT_RESET_GRACE_MS,
    APP_UPSTREAM_SYNC_BRANCH,
    APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS,
    APP_UPSTREAM_UNAVAILABLE_RECHECK_MS,
    appRateLimitAllowsSync,
    type AppLicenseEvaluationReason,
    type AppSpec,
    type AppSyncResult,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ownershipScopeOf, type OwnershipScope } from '../database/ownership-scope';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { WorkUpstreamStatePatch } from '../database/repositories/work-upstream-state.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import type { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import { GitFacadeService, GitOperationNotSupportedError } from '../facades/git.facade';
import {
    AppActionsHygieneService,
    type AppActionsHygieneResult,
} from './app-actions-hygiene.service';
import { conflictPaths } from './app-upstream-conflict.copy';
import {
    AppUpstreamStateService,
    APP_WORK_GIT_PROVIDER_ID,
    type AppConflictResult,
    type AppUpstreamSyncJobPayload,
    type AppUpstreamSyncTrigger,
} from './app-upstream-state.service';
import {
    nextUpstreamSyncAt,
    readUpstreamSyncSettings,
    upstreamSyncBranch,
    type AppUpstreamSyncSettings,
} from './upstream-schedule';

/**
 * APW-02 T26 — one upstream sync run (plan §6.3, `plan.md:715-754`).
 *
 * Spec: FR-32…FR-62, ACC-02-09…ACC-02-19. FR-39 is the invariant every branch of
 * this file exists to keep: **the platform never pushes to the upstream, never
 * force-moves a branch, and never resolves a conflict itself.**
 *
 * ## The claim is API-side, and this service takes it through the state service
 *
 * `plan.md:720` writes the run as `runExclusive('app-upstream-sync:' + workId, …)`,
 * and T26's own text corrects it: **the per-App-Work claim is taken API-side.**
 * `DistributedTaskLockService` needs `@InjectRepository(CacheEntry)` and a
 * callback cannot cross the SuperJSON remote proxy, and the worker imports no
 * database module — so the lock cannot live here. This run therefore calls
 * `AppUpstreamStateService.beginSync(workId, trigger)` (the remote-proxied
 * conditional update that returns allowed/denied) and always ends through
 * `finishSync(workId, …)`, which is what stamps `syncFinishedAt` and releases the
 * claim.
 *
 * **`finishSync` is called on every path that claimed** — the paused paths, the
 * skipped paths, the failure paths and the conflict path included. A run that
 * returned early without settling would leave the row claimed for the whole
 * `APP_UPSTREAM_SYNC_LOCK_TTL_MS` (30 minutes), which is why {@link settle} is a
 * single call site rather than one `finishSync` per branch. A run whose claim was
 * **refused** does not settle: there is nothing of its own to release, and
 * finishing another run's claim would be worse than leaking one.
 *
 * ## Where the coordinates come from
 *
 * `beginSync` answers allowed/denied and nothing else, and the run needs the
 * Work's coordinates (data repository, tracked branch, upstream, relation) and
 * two stored numbers the plan's §6.3 steps 3 and 9 read (`rateLimitedUntil`,
 * `consecutiveRateLimited`). Those are the epic's own row, so they are read
 * through `WorkUpstreamStateRepository` — exactly as T25's
 * `AppActionsHygieneService` reads the Actions columns of the same table, and
 * with the same fail-closed posture: no row ⇒ `failed/state_not_found`, never a
 * guessed repository.
 *
 * ⚠️ **Binding requirement for T28** (reported, not worked around): the worker's
 * `remoteMap` must carry `WorkUpstreamStateRepository` for this run to work off
 * the API event loop — T28's task text names `AppUpstreamStateService` and
 * `AppUpstreamSyncDispatcherService`. The alternative is for `AppSyncBeginResult`
 * to carry the coordinates and counters; either way it is one binding, and until
 * it exists every worker-side run answers `failed/state_not_found` rather than
 * syncing the wrong repository.
 *
 * ## What this run does, step by step (plan §6.3)
 *
 *   1. read the App spec's four `upstreamSync` fields **fresh, every run**
 *      (FR-64: a spec change is picked up without waiting for the next slot);
 *   2. `beginSync` — refused ⇒ `skipped` with the refusal code, no provider call,
 *      and nothing settled;
 *   3. the spec gate: `enabled: false` stops the **scheduled** path only (FR-64,
 *      ACC-02-28 — **Sync now** still works), a `mode` other than `merge` stops
 *      every path because it is a desync this epic cannot carry out;
 *   4. the member's rate-limit budget: a stored window still in force skips the
 *      run before its first provider call (FR-50);
 *   5. upstream and Work Repository reads, with the four pauses of §6.3 step 4
 *      (FR-41, FR-42, FR-45) and the default-branch rename of FR-43;
 *   6. `trigger === 'divergence'` ⇒ compare only, settle with the outcome that was
 *      already recorded, and stop;
 *   7. the compare, then either the fast-forward (fork, behind-only, licence not
 *      worse) or the pull-request path (FR-35, FR-36, FR-37);
 *   8. settle: record the outcome, the next slot (§6.4), the licence request and
 *      the hygiene pass — the last two only when the tracked branch changed
 *      (FR-40, plan §6.3 step 8).
 *
 * ## Fail-closed everywhere a seam is missing
 *
 * Every collaborator below `AppUpstreamStateService` is `@Optional()`, and each
 * absence has a defined answer that is never "sync anyway": no state row or no
 * owner ⇒ `failed`; no app-spec source ⇒ the documented schedule defaults (§6.4);
 * no licence service ⇒ the fast-forward proceeds, exactly as `plan.md:731-732`
 * says ("`@Optional()`; absent ⇒ proceed"); a licence service that **throws** ⇒
 * the pull-request path, because a gate that cannot answer has not said yes; no
 * private-copy port ⇒ `failed/provider_unsupported`.
 */

// ── provisional — APW-03 T12 `AppSpecService` ────────────────────────────────
//
// `AppSpecService.getEffectiveSpec(workId, commitSha?)` (`APW-03/tasks.md:274`)
// does not exist in this tree; the identical seam is already declared by APW-06's
// preconditions (`app-runtime/app-deploy-preconditions.service.ts:155-197`,
// `APP_DEPLOY_SPEC_SOURCE`), and this is the same read for the same reason: the
// effective spec at a commit, plus its validation status. `status` is compared as
// a **string** and never narrowed — this package sets `strictNullChecks: false`,
// under which a boolean discriminant narrows nothing.
//
// The swap is one binding: `{ provide: APP_UPSTREAM_SYNC_SPEC_SOURCE,
// useExisting: AppSpecService }`. 🛑 Mandatory, not cosmetic: a Nest token is
// compared by identity, so a second `Symbol('…')` of the same name would leave
// this injection unbound and §6.4 would silently fall back to the default
// schedule — which is exactly the failure `enabled: false` must not have.

/** The effective App spec, as the sync run needs it (§6.4). */
export interface AppUpstreamSyncSpecSnapshot {
    /** `valid` ⇔ zero validation errors. Any other status still carries a spec here. */
    status: string;
    spec?: AppSpec | null;
    commitSha?: string | null;
}

/** APW-03 T12's `AppSpecService`, as the sync run consumes it. */
export interface AppUpstreamSyncSpecSource {
    getEffectiveSpec(
        workId: string,
        commitSha?: string | null,
    ): Promise<AppUpstreamSyncSpecSnapshot | null>;
}

/** DI token for {@link AppUpstreamSyncSpecSource} — owned by APW-03 T12. */
export const APP_UPSTREAM_SYNC_SPEC_SOURCE = Symbol('APP_UPSTREAM_SYNC_SPEC_SOURCE');

// ── provisional — APW-03 T42 `AppLicenseService` ─────────────────────────────
//
// CONTRACTS §2A (line 328) fixes APW-03's `previewUpstream(workId, owner, repo,
// sha)`; the class does not exist in this tree, and the only other consumer of it
// (APW-06's licence gate) declares its own narrower seam for
// `getHostingEligibility` (`app-runtime/app-license-gate.ts:74-109`). This port is
// the consumer half of §6.3 step 6 and step 8 and nothing more:
// `previewUpstream` (FR-37's "is upstream's head worse?") and `request` (FR-40's
// "ask for re-evaluation"), whose reason union is
// `APP_LICENSE_EVALUATION_REASONS` in `@ever-works/contracts`.
//
// **T28** maps `AppLicenseService` through the same remote proxy it names for the
// state service, so a missing binding can never silently skip FR-37.

/** What a licence preview answers (§6.3 step 6). */
export interface AppUpstreamLicensePreview {
    /** `true` ⇒ upstream's head classifies **worse**; the fast-forward becomes a pull request. */
    worse: boolean;
    /** The upstream SPDX id, when the preview names one — a code, never a sentence. */
    spdx?: string | null;
    /** The classification, when the preview names one (`green` · `amber` · `red` · …). */
    licenseClass?: string | null;
}

/** APW-03 T42's `AppLicenseService`, as the sync run consumes it. */
export interface AppUpstreamLicenseService {
    previewUpstream(
        workId: string,
        owner: string,
        repo: string,
        sha: string,
    ): Promise<AppUpstreamLicensePreview | null>;
    request(workId: string, reason: AppLicenseEvaluationReason): Promise<void> | void;
}

/** DI token for {@link AppUpstreamLicenseService} — owned by APW-03 T42. */
export const APP_UPSTREAM_LICENSE_SERVICE = Symbol('APP_UPSTREAM_LICENSE_SERVICE');

// ── provisional — the private copy's compare/move capability ─────────────────
//
// FR-63: "A private copy's sync MUST be expressible with the platform's own
// capabilities: comparing a private copy against its upstream and moving the sync
// branch MUST NOT require the platform layer to shell out to git itself." The fork
// half of that is landed (`getForkDivergence`, `syncForkBranch`,
// `createBranchFromSha`, `updateBranchRef` — APW-02 T17-T22) and the private
// copy's half is not: `GitRepositoryCopyInput`/`GitRepositoryCopyResult` cover the
// **initial** copy only (FR-21), and no capability compares a copy with its
// upstream or moves `ever-works/upstream-sync`.
//
// This port is that missing capability, as this run consumes it. It is a
// **plugin-level** capability (the merge-base walk of §6.3 step 6 is isomorphic-git
// work that belongs behind the plugin boundary, never in the agent package).
// Unbound ⇒ `failed/provider_unsupported` (plan §7), never a local git call and
// never a silently skipped sync.

/** How far a private copy has drifted, counted from the merge base (§6.3 step 6, FR-63). */
export interface AppUpstreamPrivateCopyComparison {
    aheadBy: number;
    behindBy: number;
    upstreamHeadSha: string;
    /** `true` ⇔ the walk hit the 10 000-commit cap; the counts are reported as `10000+`. */
    capped: boolean;
}

/** What moving the sync branch did. `not_fast_forward` ⇒ upstream rewrote its history. */
export type AppUpstreamSyncBranchMove = 'moved' | 'not_fast_forward';

/** The private copy's compare/move capability (FR-63) — see the note above. */
export interface AppUpstreamPrivateCopyPort {
    compare(input: {
        workId: string;
        owner: string;
        repo: string;
        branch: string;
        upstreamOwner: string;
        upstreamRepo: string;
        upstreamBranch: string;
    }): Promise<AppUpstreamPrivateCopyComparison | null>;
    /** Point `ever-works/upstream-sync` at `headSha` — fast-forward only, never a force. */
    moveSyncBranch(input: {
        workId: string;
        owner: string;
        repo: string;
        headSha: string;
    }): Promise<AppUpstreamSyncBranchMove>;
}

/** DI token for {@link AppUpstreamPrivateCopyPort} — owned by APW-02 P1's plugin capability. */
export const APP_UPSTREAM_PRIVATE_COPY_PORT = Symbol('APP_UPSTREAM_PRIVATE_COPY_PORT');

// ── shapes ───────────────────────────────────────────────────────────────────

/**
 * What the task hands the run: the job runtime's wait, and a clock.
 *
 * `sleep` is what makes §9.2's "re-read up to 3 times, 5 s apart" a recorded
 * ladder in a test instead of fifteen real seconds in CI (the task passes
 * `wait.for({ seconds: … })`, the shape `app-fork-readiness` uses), and `now` is
 * injectable because the schedule, the rate-limit window and the backoff are all
 * clock arithmetic. Both are optional, so `run(payload)` — the signature plan §6.3
 * fixes — stays callable as it is written there.
 */
export interface AppUpstreamSyncDeps {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /**
     * A budget the caller already holds. The job runtime creates one per run (FR-49's
     * ceiling), and a caller that injects its own gets exactly that ceiling — which is
     * how a test drives the `skipped/skipped_budget` path without making twenty real
     * calls, and how a future caller with a second budget (a dispatcher sharing one
     * across a batch) can hand it in rather than having two.
     */
    budget?: ProviderCallBudget;
}

/** How one sync run ended, with the counters plan §9.1's telemetry wants. */
export interface AppUpstreamSyncRunResult {
    workId: string;
    trigger: AppUpstreamSyncTrigger;
    /**
     * `refused` ⇒ the claim was never taken, so **nothing was settled** and the row
     * is untouched; `settled` ⇒ the run claimed the Work and recorded its outcome.
     */
    outcome: 'refused' | 'settled';
    /** The coarse result — recorded on the row when `settled`, reported only when refused. */
    result: AppSyncResult | null;
    /** The reason code beside it — a member of a closed set, never a sentence. */
    reason: string | null;
    commits: number | null;
    fromSha: string | null;
    toSha: string | null;
    /** The compare this run made, when it made one. */
    divergence: { aheadBy: number; behindBy: number; capped: boolean } | null;
    /** The sync pull request this run opened, updated or found conflicting. */
    pullRequest: { number: number; url: string } | null;
    /** What `recordConflict` answered, on the conflict path (FR-38). */
    conflict: AppConflictResult | null;
    /** What hygiene answered, when the tracked branch changed (FR-40). */
    hygiene: AppActionsHygieneResult | null;
    /** `true` ⇔ `AppLicenseService.request(workId, 'upstream_synced')` was called. */
    licenseRequested: boolean;
    /** Every Activity event this run emitted, in order. */
    events: string[];
    /** The next slot written to the row, as ISO-8601 (`null` = left unset). */
    nextSyncAt: string | null;
    /** The instant the run may try again after a rate limit, as ISO-8601. */
    rateLimitedUntil: string | null;
    /** Provider calls made — the budget is {@link APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS}. */
    providerCalls: number;
    /** Every wait this run took, in order (plan §9.2's 3 × 5 s ladder). */
    sleeps: number[];
    durationMs: number;
    /** The four fields §6.4 reads, as the run resolved them — for the log and the tests. */
    settings: AppUpstreamSyncSettings;
}

/**
 * The per-run provider-call budget of FR-49 (`plan.md:723`, §9.2's "Token budget
 * exhausted mid-run").
 *
 * One instance per run, wrapping **every** facade call the run makes, because
 * FR-49's "at most 20 provider calls" is a property of the run and not of any one
 * step. When the budget is spent the next call raises
 * {@link ProviderBudgetExceededError}, the run stops with the counts it already
 * has, and the outcome is `skipped/skipped_budget` (§9.2 says `budget_exhausted`;
 * `APP_SYNC_REASONS` — FR-65's closed set — is the source of the recorded code,
 * and it has `skipped_budget`).
 *
 * It also carries the rate-limit observation of §6.3 step 3: `remaining` and the
 * instant it refills, as the last answer reported them. `appRateLimitAllowsSync`
 * (contracts, FR-50's own predicate — "fewer than 300 remaining") is what decides
 * whether a run may start, so the boundary is the contract's and not a second copy
 * of the number.
 */
export class ProviderCallBudget {
    private used = 0;
    private remaining: number | null = null;
    private resetAtMs: number | null = null;

    constructor(
        private readonly limit: number = APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS,
        private readonly now: () => number = Date.now,
    ) {}

    /** Provider calls made so far. */
    get calls(): number {
        return this.used;
    }

    /**
     * How many calls this budget still allows (never negative).
     *
     * Added for APW-01 T12's inspect budget (FR-7/FR-9, `plan.md:187-194`), which
     * reuses this class with a different ceiling rather than keeping a second copy
     * of the same arithmetic: the inspect path's fork scan asks whether at least
     * `APP_INSPECT_OWNER_MIN_CALLS_REMAINING` calls remain before it starts another
     * owner. Additive — no existing caller reads it and nothing about `call`,
     * `exhausted` or the rate-limit observation changes.
     */
    get callsRemaining(): number {
        return Math.max(0, this.limit - this.used);
    }

    /** `true` ⇔ no further call may be made. */
    get exhausted(): boolean {
        return this.used >= this.limit;
    }

    /** The last observed remaining request budget, or `null` when none was reported. */
    get lastRemaining(): number | null {
        return this.remaining;
    }

    /** The last observed reset instant, in epoch ms, or `null`. */
    get lastResetAtMs(): number | null {
        return this.resetAtMs;
    }

    /**
     * Whether a run may make its first call (FR-50): fewer than
     * `APP_RATE_LIMIT_MIN_REMAINING` observed remaining refuses it, and an
     * observation nobody made refuses nothing.
     */
    allowsStart(): boolean {
        return this.remaining === null || appRateLimitAllowsSync(this.remaining);
    }

    /**
     * The instant a rate-limited run may try again: the provider's reset plus the
     * 60-second grace (FR-50), or `from + grace` when no reset was reported — never
     * `null` for a limit that was observed.
     */
    rateLimitedUntil(from: number = this.now()): number {
        const base =
            this.resetAtMs !== null && Number.isFinite(this.resetAtMs) ? this.resetAtMs : from;
        return base + APP_RATE_LIMIT_RESET_GRACE_MS;
    }

    /** Record what an answer reported about the member's budget. */
    observe(input: { remaining?: number | null; resetAtMs?: number | null }): void {
        if (typeof input?.remaining === 'number' && Number.isFinite(input.remaining)) {
            this.remaining = input.remaining;
        }
        if (typeof input?.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)) {
            this.resetAtMs = input.resetAtMs;
        }
    }

    /**
     * Run one provider call under the budget.
     *
     * The count is taken **before** the call: a call that throws still spent a
     * request, and a budget that only counted successes would let a failing run
     * spend the member's whole allowance twenty times over.
     */
    async call<T>(operation: () => Promise<T>): Promise<T> {
        if (this.exhausted) {
            throw new ProviderBudgetExceededError(this.limit);
        }
        this.used += 1;
        return operation();
    }
}

/** FR-49's ceiling reached — the run stops with the counts it has (§9.2). */
export class ProviderBudgetExceededError extends Error {
    readonly code = 'skipped_budget';

    constructor(readonly limit: number) {
        super(`The sync run reached its ${limit}-provider-call budget.`);
        this.name = 'ProviderBudgetExceededError';
    }
}

/** One Activity event this run emits itself (§3.5's eight, minus the ones T23 owns). */
interface SyncEvent {
    action: 'app.upstream.behind' | 'app.upstream.unavailable' | 'app.fork.missing';
    actionType: ActivityActionType;
    status: ActivityStatus;
    summary: string;
    details: Record<string, unknown>;
}

/**
 * What {@link AppUpstreamSyncService.execute} decided, before it is recorded.
 *
 * Every branch of §6.3 produces exactly one of these, and
 * {@link AppUpstreamSyncService.settle} is the only thing that turns one into
 * state — which is what makes "every path that claimed settles" a property of the
 * shape rather than a rule someone has to remember.
 */
interface SyncOutcome {
    result: AppSyncResult;
    reason: string;
    commits?: number | null;
    fromSha?: string | null;
    toSha?: string | null;
    pullRequestNumber?: number | null;
    pullRequestUrl?: string | null;
    pullRequestClosedHeadSha?: string | null;
    /** Epoch ms the member may retry at, for a rate-limited run (FR-50/FR-51). */
    rateLimitedUntil?: number | null;
    /** `true` ⇒ this was a rate-limited run; `finishSync` increments the streak (FR-52). */
    rateLimited?: boolean;
    /** `true` ⇒ the tracked branch moved; the licence and hygiene legs run (FR-40). */
    trackedBranchChanged?: boolean;
    /** `true` ⇒ `nextSyncAt` is cleared (the pause states, §6.4). */
    pause?: boolean;
    /** The sync-owned columns this run wrote outside `finishSync` (§3.1). */
    rowPatch?: WorkUpstreamStatePatch;
    /** The one-time events (§3.5). */
    events?: SyncEvent[];
    /** For the log and the caller. */
    divergence?: { aheadBy: number; behindBy: number; capped: boolean } | null;
    pullRequest?: { number: number; url: string } | null;
    conflict?: AppConflictResult | null;
}

@Injectable()
export class AppUpstreamSyncService {
    private readonly logger = new Logger(AppUpstreamSyncService.name);

    constructor(
        /** The epic's state service — a remote proxy in the worker (plan §2.4). */
        private readonly states: AppUpstreamStateService,
        private readonly git: GitFacadeService,
        private readonly hygiene: AppActionsHygieneService,
        // Read for the coordinates and the two counters §6.3's steps 3 and 9 need;
        // see the class docstring for why, and for T28's binding requirement.
        @Optional() private readonly rows?: WorkUpstreamStateRepository,
        // The Work owner: every facade call resolves a token per USER and every
        // Activity entry belongs to one. In the worker this is already a remote proxy
        // (the shape `AppForkReadinessService` documents for the same read).
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly activity?: ActivityLogService,
        // The three optional hand-offs, appended in the order plan §6.3 names them.
        // Each absence has a defined answer — see the class docstring.
        @Optional()
        @Inject(APP_UPSTREAM_SYNC_SPEC_SOURCE)
        private readonly specs?: AppUpstreamSyncSpecSource,
        @Optional()
        @Inject(APP_UPSTREAM_LICENSE_SERVICE)
        private readonly licenses?: AppUpstreamLicenseService,
        @Optional()
        @Inject(APP_UPSTREAM_PRIVATE_COPY_PORT)
        private readonly privateCopies?: AppUpstreamPrivateCopyPort,
    ) {}

    /**
     * One sync run (plan §6.3). Never throws: a declined claim, a provider failure
     * and a missing collaborator are all *answers* here, because a Trigger.dev job
     * that throws is a job whose outcome nobody recorded.
     */
    async run(
        payload: AppUpstreamSyncJobPayload,
        deps: AppUpstreamSyncDeps = {},
    ): Promise<AppUpstreamSyncRunResult> {
        const workId = String(payload?.workId ?? '');
        const trigger: AppUpstreamSyncTrigger = payload?.trigger ?? 'schedule';
        const providerId = payload?.providerId ?? APP_WORK_GIT_PROVIDER_ID;
        const now = deps.now ?? Date.now;
        const sleep = deps.sleep ?? (async (): Promise<void> => undefined);
        const startedAtMs = now();

        const result: AppUpstreamSyncRunResult = {
            workId,
            trigger,
            outcome: 'refused',
            result: null,
            reason: null,
            commits: null,
            fromSha: null,
            toSha: null,
            divergence: null,
            pullRequest: null,
            conflict: null,
            hygiene: null,
            licenseRequested: false,
            events: [],
            nextSyncAt: null,
            rateLimitedUntil: null,
            providerCalls: 0,
            sleeps: [],
            durationMs: 0,
            settings: readUpstreamSyncSettings(null),
        };

        if (!workId) {
            // A payload with no Work names nothing to sync: fail closed, and do not
            // touch the state service with an empty id.
            result.result = 'failed';
            result.reason = 'work_not_found';
            result.durationMs = Math.max(0, now() - startedAtMs);
            return result;
        }

        // ── step 1: the App spec, read fresh every run (FR-64) ────────────────
        result.settings = await this.readSettings(workId);

        // ── step 2: the claim (API-side, plan §6.3 step 2) ────────────────────
        const claim = await this.safe(() => this.states.beginSync(workId, trigger));
        if (!claim) {
            result.result = 'failed';
            result.reason = 'state_unavailable';
            result.durationMs = Math.max(0, now() - startedAtMs);
            return result;
        }
        if (!claim.allowed) {
            // Refused before any provider call, and **nothing is settled**: the claim
            // belongs to whoever holds it (FR-34), and finishing it here would release
            // a lease this run never owned.
            result.result = 'skipped';
            result.reason = claim.reason ?? 'sync_in_progress';
            result.durationMs = Math.max(0, now() - startedAtMs);
            return result;
        }

        const budget =
            deps.budget ?? new ProviderCallBudget(APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS, now);
        const context: RunContext = {
            workId,
            trigger,
            providerId,
            now,
            sleep,
            budget,
            row: null,
            ownerUserId: null,
            ownerScope: null,
            settings: result.settings,
            result,
        };

        let outcome: SyncOutcome;
        try {
            outcome = await this.execute(context);
        } catch (error) {
            outcome = classifyFailure(error, context);
        }

        result.outcome = 'settled';
        await this.settle(context, outcome);
        result.providerCalls = budget.calls;
        result.durationMs = Math.max(0, now() - startedAtMs);
        return result;
    }

    // ── §6.3 steps 3-7 ───────────────────────────────────────────────────────

    /** The run proper: everything between the claim and the settle. */
    private async execute(context: RunContext): Promise<SyncOutcome> {
        const { workId, trigger } = context;

        // ── step 3: the spec gate (FR-64, ACC-02-28) ─────────────────────────
        if (context.settings.modeHonoured !== true) {
            // A `mode` this epic cannot carry out is refused whatever the trigger: the
            // spec asks for a desync the platform does not implement, and pretending to
            // merge is worse than saying so (plan §6.4).
            return { result: 'skipped', reason: 'disabled_by_spec' };
        }
        if (trigger !== 'manual' && context.settings.enabled !== true) {
            // FR-64: the *scheduled* path is off. A manual **Sync now** deliberately
            // ignores this — a person is never locked out of their own repository.
            return { result: 'skipped', reason: 'disabled_by_spec' };
        }

        // ── the row: coordinates and the two counters of steps 3 and 9 ───────
        const row = await this.readRow(workId);
        if (!row) {
            return { result: 'failed', reason: 'state_not_found' };
        }
        context.row = row;

        if (row.relation === 'link' || !row.upstreamOwner || !row.upstreamRepo) {
            // `beginSync` refuses a link, so this is the "no upstream coordinates" case
            // — a fork row that was never completed. Never guessed (FR-44).
            return { result: 'skipped', reason: 'no_upstream' };
        }

        // ── step 3 (cont.): the member's budget (FR-50) ──────────────────────
        const storedRateLimit = toEpoch(row.rateLimitedUntil);
        if (storedRateLimit !== null && storedRateLimit > context.now()) {
            // The last run's limit is still in force. Its reset travelled as
            // `rateLimitedUntil = reset + 60 000` (FR-50), so the reset is recovered by
            // subtracting the grace — and re-recording it is idempotent.
            context.budget.observe({
                remaining: 0,
                resetAtMs: storedRateLimit - APP_RATE_LIMIT_RESET_GRACE_MS,
            });
        }
        if (!context.budget.allowsStart()) {
            return {
                result: 'skipped',
                reason: 'skipped_rate_limited',
                rateLimited: true,
                rateLimitedUntil: context.budget.rateLimitedUntil(context.now()),
            };
        }

        // ── step 4: the two repository reads (FR-41, FR-42, FR-43, FR-45) ────
        const owner = await this.readOwner(workId);
        if (!owner) {
            return { result: 'failed', reason: 'work_not_found' };
        }
        const ownerUserId = owner.userId;
        context.ownerUserId = ownerUserId;
        context.ownerScope = owner.scope;

        const upstream = await context.budget.call(() =>
            this.git.getRepository(row.upstreamOwner as string, row.upstreamRepo as string, {
                userId: ownerUserId,
                providerId: context.providerId,
                workId,
            }),
        );
        if (!upstream) {
            // FR-41: unreadable ⇒ pause, one `app.upstream.unavailable`, re-checked daily
            // by the dispatcher's `unavailable` sweep (§6.6).
            return {
                result: 'paused',
                reason: 'upstream_unavailable',
                pause: true,
                rowPatch: { upstreamStatus: 'unavailable', upstreamCheckedAt: new Date() },
                events:
                    row.upstreamStatus === 'unavailable'
                        ? []
                        : [
                              {
                                  action: 'app.upstream.unavailable',
                                  actionType: ActivityActionType.APP_UPSTREAM,
                                  status: ActivityStatus.FAILED,
                                  summary: 'Upstream is no longer reachable',
                                  details: {
                                      reason: 'upstream_unavailable',
                                      recheckInMs: APP_UPSTREAM_UNAVAILABLE_RECHECK_MS,
                                  },
                              },
                          ],
            };
        }
        if (upstream.archived === true) {
            // FR-41: an archived upstream is read-only — sync pauses, and there is
            // nothing to re-check: only the member can unarchive it.
            return {
                result: 'paused',
                reason: 'upstream_archived',
                pause: true,
                rowPatch: { upstreamStatus: 'archived', upstreamCheckedAt: new Date() },
            };
        }

        // FR-43: upstream renamed its default branch — follow it, and remember the old
        // name so the card can say "changed from {old} to {new}".
        const upstreamDefaultBranch = nonEmptyString(upstream.defaultBranch);
        const renamed =
            !!upstreamDefaultBranch &&
            !!row.upstreamDefaultBranch &&
            upstreamDefaultBranch !== row.upstreamDefaultBranch;
        const renamePatch: WorkUpstreamStatePatch = renamed
            ? {
                  upstreamDefaultBranch,
                  upstreamPreviousDefaultBranch: row.upstreamDefaultBranch ?? null,
              }
            : {};

        // §6.4: `branch` is read here, and it is what the compare and the merge use.
        const branch =
            upstreamSyncBranch(context.settings, upstreamDefaultBranch) ??
            row.upstreamDefaultBranch ??
            row.dataDefaultBranch;

        const data = await context.budget.call(() =>
            this.git.getRepository(row.dataOwner, row.dataRepo, {
                userId: ownerUserId,
                providerId: context.providerId,
                workId,
            }),
        );
        if (!data) {
            // FR-42: the Work Repository is gone. Every background job for the Work
            // stops, one `app.fork.missing` is recorded, and `nextSyncAt` is cleared.
            return {
                result: 'paused',
                reason: 'data_repository_missing',
                pause: true,
                rowPatch: {
                    ...renamePatch,
                    dataRepositoryStatus: 'missing',
                    upstreamCheckedAt: new Date(),
                },
                events:
                    row.dataRepositoryStatus === 'missing'
                        ? []
                        : [
                              {
                                  action: 'app.fork.missing',
                                  actionType: ActivityActionType.APP_FORK,
                                  status: ActivityStatus.FAILED,
                                  summary: 'The App Work repository no longer exists',
                                  details: { reason: 'data_repository_missing' },
                              },
                          ],
            };
        }

        if (
            row.relation === 'private-copy' &&
            typeof upstream.sizeKb === 'number' &&
            upstream.sizeKb > APP_PRIVATE_COPY_MAX_SIZE_KB
        ) {
            // FR-45: a private copy refuses to sync an upstream past 500 MB, and the
            // refusal is a pause the card names (`privateCopyTooLarge`, §6.2).
            return {
                result: 'paused',
                reason: 'too_large_for_private_copy',
                pause: true,
                rowPatch: {
                    ...renamePatch,
                    upstreamStatus: 'available',
                    upstreamCheckedAt: new Date(),
                },
            };
        }

        // ── step 6: the compare, then either the fast-forward or a PR ────────
        const comparison = await this.compare(context, row, branch);
        const countsPatch: WorkUpstreamStatePatch = {
            ...renamePatch,
            aheadBy: comparison.aheadBy,
            behindBy: comparison.behindBy,
            divergenceComputedAt: new Date(),
            upstreamHeadSha: comparison.upstreamHeadSha,
            upstreamStatus: 'available',
            upstreamCheckedAt: new Date(),
            // FR-48's "since the last emission" is this column: the reading at the last
            // `app.upstream.behind`, so a Work behind 400 commits emits once, not weekly.
            behindEventCount: comparison.behindBy,
        };

        const base: SyncOutcome = {
            result: 'up_to_date',
            reason: 'up_to_date',
            commits: comparison.behindBy,
            // The sha the fork last reached, so the event's range reads from → to.
            fromSha: row.lastSyncedUpstreamSha ?? row.upstreamHeadSha ?? null,
            toSha: comparison.upstreamHeadSha,
            divergence: comparison,
            rowPatch: countsPatch,
            events: behindEvents(row, comparison),
        };

        // §6.3 step 5: a divergence-only dispatch compares and stops. The run still
        // settles — `finishSync` is what releases the claim — and it settles with the
        // outcome already on the row, which `finishSync`'s own duplicate guard turns
        // into "no second `app.upstream.synced`".
        if (trigger === 'divergence') {
            return {
                ...base,
                ...recordedOutcomeOf(row, countsPatch),
                divergence: comparison,
                rowPatch: countsPatch,
                events: base.events,
            };
        }

        if (comparison.behindBy === 0) {
            return { ...base, commits: 0 };
        }

        if (row.relation === 'private-copy') {
            // FR-36 + FR-63: behind ⇒ the sync branch moves and one pull request is
            // kept open on it. The move itself lives in the pull-request path, so both
            // relations take exactly one route to a pull request.
            return await this.pullRequestPath(context, row, base);
        }

        if (comparison.aheadBy === 0) {
            // FR-35: behind-only — the one case a fast-forward is written for. (R-4
            // gives every fork a commit of its own, so this stays the exception;
            // ACC-02-25 is the rule.)
            const worse = await this.licenseIsWorse(context, row, comparison.upstreamHeadSha);
            if (worse) {
                // FR-37: a worse licence turns the fast-forward into a pull request, and
                // the reason says why.
                return await this.pullRequestPath(context, row, base, 'license_worse');
            }

            try {
                const synced = await context.budget.call(() =>
                    this.git.syncForkBranch(row.dataOwner, row.dataRepo, row.dataDefaultBranch, {
                        userId: context.ownerUserId as string,
                        providerId: context.providerId,
                        workId,
                    }),
                );
                const outcome = String(synced?.outcome ?? '');
                if (outcome === 'fast_forwarded' || outcome === 'merged') {
                    return {
                        ...base,
                        result: 'fast_forwarded',
                        reason: 'fast_forwarded',
                        // FR-40: the tracked branch moved, so this is the run that asks
                        // the licence gate again and re-runs hygiene.
                        trackedBranchChanged: true,
                    };
                }
                if (outcome === 'up_to_date') {
                    return { ...base, commits: 0 };
                }
                // `conflict` / `unprocessable`: the platform does not resolve it and does
                // not force anything — the pull-request path carries it (§9.2).
            } catch (error) {
                // A 409 race (upstream moved between the compare and the merge) is an
                // answer, not a failure: the pull request carries the range instead.
                if (!isPullRequestWorthy(error)) {
                    throw error;
                }
            }
        }

        // A fork with commits of its own (the normal case), a behind-only fork whose
        // fast-forward raced or was refused, and every private copy that is behind: one
        // reusable pull request on `ever-works/upstream-sync` (FR-36).
        return await this.pullRequestPath(context, row, base);
    }

    // ── the compare (§6.3 step 6) ────────────────────────────────────────────

    /** The divergence reading of FR-46, by relation. */
    private async compare(
        context: RunContext,
        row: WorkUpstreamState,
        branch: string,
    ): Promise<{ aheadBy: number; behindBy: number; upstreamHeadSha: string; capped: boolean }> {
        if (row.relation === 'private-copy') {
            if (!this.privateCopies) {
                // FR-63's capability is not bound: a private copy cannot be compared
                // without shelling out to git, which this layer must never do (plan §7).
                throw new GitOperationNotSupportedError('comparePrivateCopy', 'private-copy');
            }
            const comparison = await context.budget.call(() =>
                (this.privateCopies as AppUpstreamPrivateCopyPort).compare({
                    workId: context.workId,
                    owner: row.dataOwner,
                    repo: row.dataRepo,
                    branch: row.dataDefaultBranch,
                    upstreamOwner: row.upstreamOwner as string,
                    upstreamRepo: row.upstreamRepo as string,
                    upstreamBranch: branch,
                }),
            );
            if (!comparison) {
                // The comparison could not be produced — a provider refusal the plugin
                // reports as `not_found`, mapped by the caller to `failed/not_found`.
                throw new GitProviderRequestError('not_found', 404);
            }
            return {
                aheadBy: count(comparison.aheadBy),
                behindBy: count(comparison.behindBy),
                upstreamHeadSha: String(comparison.upstreamHeadSha ?? ''),
                capped: comparison.capped === true,
            };
        }

        const divergence = await context.budget.call(() =>
            this.git.getForkDivergence(
                row.dataOwner,
                row.dataRepo,
                row.dataDefaultBranch,
                row.upstreamOwner as string,
                branch,
                {
                    userId: context.ownerUserId as string,
                    providerId: context.providerId,
                    workId: context.workId,
                },
            ),
        );

        return {
            aheadBy: count(divergence?.aheadBy),
            behindBy: count(divergence?.behindBy),
            upstreamHeadSha: String(divergence?.upstreamHeadSha ?? ''),
            capped: false,
        };
    }

    // ── the pull-request path (§6.3 step 7, FR-36, FR-39) ────────────────────

    /**
     * Point `ever-works/upstream-sync` at the upstream head and keep exactly one open
     * pull request on it (FR-36).
     *
     * Nothing here merges, force-moves or resolves: the branch is moved
     * fast-forward-only (`createBranchFromSha` / `updateBranchRef` with
     * `{ force: false }`, or FR-63's capability for a private copy), the pull request
     * is opened or reused, and a pull request GitHub reports as **conflicting**
     * becomes the one Task of FR-38.
     */
    private async pullRequestPath(
        context: RunContext,
        row: WorkUpstreamState,
        base: SyncOutcome,
        reasonOverride?: string,
        options: { moveBranch?: boolean } = {},
    ): Promise<SyncOutcome> {
        const head = String(base.toSha ?? '');
        const existing = await this.findOpenSyncPullRequest(context, row);
        const closedHeadSha = row.syncPullRequestClosedHeadSha ?? null;
        // The history-rewritten path has just recreated the branch at `head` itself, so
        // it asks for the pull request only — moving the ref again would either be a
        // no-op or, for a provider that still answers "not a fast forward", a second
        // recreation of the same branch.
        const moveBranch = options.moveBranch !== false;

        if (existing) {
            const moved = moveBranch
                ? await this.moveSyncBranchForRelation(context, row, head)
                : 'moved';
            if (moved === 'not_fast_forward') {
                return await this.historyRewritten(context, row, base);
            }
            return await this.verdict(context, row, {
                ...base,
                result: 'pull_request_updated',
                reason: reasonOverride ?? 'pull_request_updated',
                pullRequestNumber: existing.number,
                pullRequestUrl: existing.url,
                pullRequest: { number: existing.number, url: existing.url },
                pullRequestClosedHeadSha: closedHeadSha,
            });
        }

        // S26: a pull request the member closed, still pointing at this same head, is
        // **not reopened** — it is the same upstream commit they already said no to.
        // Upstream moving is what makes the next sync open a fresh one.
        if (closedHeadSha && closedHeadSha === head) {
            return {
                ...base,
                result: 'skipped',
                reason: 'pull_request_closed',
                pullRequestClosedHeadSha: closedHeadSha,
            };
        }

        const moved = moveBranch
            ? await this.moveSyncBranchForRelation(context, row, head)
            : 'moved';
        if (moved === 'not_fast_forward') {
            return await this.historyRewritten(context, row, base);
        }

        const commits = count(base.commits);
        const created = await context.budget.call(() =>
            this.git.createPullRequest(
                {
                    owner: row.dataOwner,
                    repo: row.dataRepo,
                    // Plan §6.3 step 7's own title shape, with the range it carries.
                    title: `Sync with upstream (${commits} commits)`,
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: row.dataDefaultBranch,
                    body:
                        `This pull request brings ${commits} upstream commit(s) into ` +
                        `${row.dataDefaultBranch} via ${APP_UPSTREAM_SYNC_BRANCH}.\n\n` +
                        `Upstream: ${row.upstreamOwner}/${row.upstreamRepo} at ` +
                        `${String(base.toSha ?? '')}.\n` +
                        'Nothing is merged automatically: review it like any other change.',
                },
                {
                    userId: context.ownerUserId as string,
                    providerId: context.providerId,
                    workId: context.workId,
                },
            ),
        );

        return await this.verdict(context, row, {
            ...base,
            result: 'pull_request_opened',
            reason: reasonOverride ?? 'pull_request_opened',
            pullRequestNumber: created?.number ?? null,
            pullRequestUrl: created?.url ?? null,
            pullRequest:
                created && typeof created.number === 'number'
                    ? { number: created.number, url: String(created.url ?? '') }
                    : null,
            pullRequestClosedHeadSha: closedHeadSha,
        });
    }

    /**
     * Read the new pull request's mergeability, and turn the two answers that matter
     * into outcomes: `false` ⇒ the conflict of FR-38, `null` after three re-reads ⇒
     * opened without a verdict (§9.2's "avoid a false conflict Task").
     */
    private async verdict(
        context: RunContext,
        row: WorkUpstreamState,
        outcome: SyncOutcome,
    ): Promise<SyncOutcome> {
        const number = outcome.pullRequestNumber;
        if (typeof number !== 'number') {
            return outcome;
        }

        const mergeable = await this.readMergeable(context, row, number);
        if (mergeable !== false) {
            return outcome;
        }

        const paths = await this.conflictPathsOf(context, row, number);
        let conflict: AppConflictResult | null = null;
        let reason = 'conflict';

        try {
            conflict = await this.states.recordConflict(context.workId, {
                pr: { number, url: outcome.pullRequestUrl ?? null },
                fromSha: outcome.fromSha ?? null,
                toSha: outcome.toSha ?? null,
                commits: outcome.commits ?? null,
                paths,
            });
        } catch (error) {
            // §9.2: the pull request is the durable record, so a Task that could not be
            // filed is recorded as the reason and retried by the next run.
            this.logger.warn(
                `App upstream sync: recording the conflict for work ${context.workId} failed (${errorText(error)}).`,
            );
            reason = 'task_create_failed';
        }

        return { ...outcome, result: 'conflict', reason, conflict };
    }

    /**
     * Upstream rewrote its history: the sync branch cannot be moved forward, and
     * **nothing is force-moved** (FR-39, ACC-02-10).
     *
     * With the sync pull request still open the run ends
     * `failed/upstream_history_rewritten` and the card asks the member to close it;
     * once it is closed the platform-owned branch is deleted and recreated at the new
     * head, which is safe precisely because no open pull request uses it.
     */
    private async historyRewritten(
        context: RunContext,
        row: WorkUpstreamState,
        outcome: SyncOutcome,
    ): Promise<SyncOutcome> {
        const existing = await this.findOpenSyncPullRequest(context, row);
        if (existing) {
            return {
                ...outcome,
                result: 'failed',
                reason: 'upstream_history_rewritten',
                pullRequestNumber: existing.number,
                pullRequestUrl: existing.url,
                pullRequest: { number: existing.number, url: existing.url },
            };
        }

        const options = {
            userId: context.ownerUserId as string,
            providerId: context.providerId,
            workId: context.workId,
        };
        await context.budget.call(() =>
            this.git.deleteBranch(row.dataOwner, row.dataRepo, APP_UPSTREAM_SYNC_BRANCH, options),
        );
        await context.budget.call(() =>
            this.git.createBranchFromSha(
                row.dataOwner,
                row.dataRepo,
                APP_UPSTREAM_SYNC_BRANCH,
                String(outcome.toSha ?? ''),
                options,
            ),
        );

        // The branch is at the new head now, so only the pull request is left.
        return await this.pullRequestPath(context, row, outcome, undefined, { moveBranch: false });
    }

    /** The relation-appropriate branch move: FR-63's capability, or the fork methods. */
    private async moveSyncBranchForRelation(
        context: RunContext,
        row: WorkUpstreamState,
        headSha: string,
    ): Promise<AppUpstreamSyncBranchMove> {
        if (row.relation === 'private-copy') {
            if (!this.privateCopies) {
                throw new GitOperationNotSupportedError('moveSyncBranch', 'private-copy');
            }
            const moved = await context.budget.call(() =>
                (this.privateCopies as AppUpstreamPrivateCopyPort).moveSyncBranch({
                    workId: context.workId,
                    owner: row.dataOwner,
                    repo: row.dataRepo,
                    headSha,
                }),
            );
            return moved === 'moved' ? 'moved' : 'not_fast_forward';
        }

        return await this.moveSyncBranch(context, row, headSha);
    }

    /**
     * Move the platform-owned sync branch to `headSha`, fast-forward only.
     *
     * The provider answers are the whole reason this is one method: `not_found` is
     * "the branch does not exist yet" (create it), `unprocessable` is "not a fast
     * forward" (upstream rewrote its history — the caller decides), and `conflict` is
     * "it already exists" (the ref is there; whether it is current is the mergeability
     * read's answer). `{ force: false }` is the only value the facade's signature
     * allows, so nothing here can rewrite history even by mistake.
     */
    private async moveSyncBranch(
        context: RunContext,
        row: WorkUpstreamState,
        headSha: string,
    ): Promise<AppUpstreamSyncBranchMove> {
        try {
            await context.budget.call(() =>
                this.git.updateBranchRef(
                    row.dataOwner,
                    row.dataRepo,
                    APP_UPSTREAM_SYNC_BRANCH,
                    headSha,
                    { force: false },
                    {
                        userId: context.ownerUserId as string,
                        providerId: context.providerId,
                        workId: context.workId,
                    },
                ),
            );
            return 'moved';
        } catch (error) {
            const reason = providerReasonOf(error);
            if (reason === 'not_found') {
                await this.createSyncBranch(context, row, headSha);
                return 'moved';
            }
            if (reason === 'unprocessable') {
                return 'not_fast_forward';
            }
            if (reason === 'conflict') {
                return 'moved';
            }
            throw error;
        }
    }

    /** Create the sync branch at an exact sha; "it already exists" is not an error. */
    private async createSyncBranch(
        context: RunContext,
        row: WorkUpstreamState,
        headSha: string,
    ): Promise<void> {
        try {
            await context.budget.call(() =>
                this.git.createBranchFromSha(
                    row.dataOwner,
                    row.dataRepo,
                    APP_UPSTREAM_SYNC_BRANCH,
                    headSha,
                    {
                        userId: context.ownerUserId as string,
                        providerId: context.providerId,
                        workId: context.workId,
                    },
                ),
            );
        } catch (error) {
            const reason = providerReasonOf(error);
            if (reason !== 'conflict' && reason !== 'unprocessable') {
                throw error;
            }
        }
    }

    /**
     * The one open sync pull request (FR-36's "reused and updated on later syncs"): the
     * stored number first, then a scan of the open pull requests for the platform's own
     * head branch.
     *
     * A stored number that answers `closed` records its head in
     * `syncPullRequestClosedHeadSha` (S26) — which is what stops the next run from
     * reopening the very pull request the member closed. The record is written to the
     * local row so this run's own branch decision sees it, and travels to the row
     * through the outcome.
     */
    private async findOpenSyncPullRequest(
        context: RunContext,
        row: WorkUpstreamState,
    ): Promise<{ number: number; url: string } | null> {
        const options = {
            userId: context.ownerUserId as string,
            providerId: context.providerId,
            workId: context.workId,
        };

        if (typeof row.syncPullRequestNumber === 'number') {
            const tracked = await context.budget.call(() =>
                this.git.getPullRequest(
                    row.dataOwner,
                    row.dataRepo,
                    row.syncPullRequestNumber as number,
                    options,
                ),
            );
            if (tracked && tracked.state === 'open') {
                return { number: tracked.number, url: String(tracked.url ?? '') };
            }
            if (tracked && tracked.state === 'closed') {
                const status = await context.budget.call(() =>
                    this.git.getPullRequestStatus(
                        row.dataOwner,
                        row.dataRepo,
                        row.syncPullRequestNumber as number,
                        options,
                    ),
                );
                const headSha = String(status?.headSha ?? '');
                if (headSha.length > 0 && status?.merged !== true) {
                    row.syncPullRequestClosedHeadSha = headSha;
                }
            }
        }

        const open = await context.budget.call(() =>
            this.git.listPullRequests(
                row.dataOwner,
                row.dataRepo,
                { state: 'open', perPage: 100 },
                options,
            ),
        );
        const match = (open ?? []).find(
            (pullRequest) => String(pullRequest?.head ?? '') === APP_UPSTREAM_SYNC_BRANCH,
        );

        return match ? { number: match.number, url: String(match.url ?? '') } : null;
    }

    /**
     * `mergeable`, re-read up to three times 5 s apart while GitHub is still computing
     * it (§9.2). `null` is the honest "no verdict", never a conflict.
     */
    private async readMergeable(
        context: RunContext,
        row: WorkUpstreamState,
        pullRequestNumber: number,
    ): Promise<boolean | null> {
        const options = {
            userId: context.ownerUserId as string,
            providerId: context.providerId,
            workId: context.workId,
        };

        const read = async (): Promise<boolean | null> => {
            const status = await context.budget.call(() =>
                this.git.getPullRequestStatus(
                    row.dataOwner,
                    row.dataRepo,
                    pullRequestNumber,
                    options,
                ),
            );
            if (!status) {
                return null;
            }
            if (status.mergeable === true) {
                return true;
            }
            if (status.mergeable === false) {
                return false;
            }
            // `undefined` and `null` are the same statement here: "not computed yet".
            return null;
        };

        let verdict: boolean | null = null;
        for (let attempt = 0; attempt <= APP_SYNC_MERGEABLE_REREADS; attempt++) {
            if (context.budget.exhausted) {
                // The PR is open and the budget is spent: the run records
                // `pull_request_opened` without a verdict rather than failing a sync that
                // already happened (§9.2's own fallback for "no verdict").
                return null;
            }
            verdict = await read();
            if (verdict !== null || attempt === APP_SYNC_MERGEABLE_REREADS) {
                return verdict;
            }
            await context.sleep(APP_SYNC_MERGEABLE_REREAD_MS);
            context.result.sleeps.push(APP_SYNC_MERGEABLE_REREAD_MS);
        }

        return verdict;
    }

    /** The first 50 changed files, for the conflict Task (FR-38, §6.5 step 3). */
    private async conflictPathsOf(
        context: RunContext,
        row: WorkUpstreamState,
        pullRequestNumber: number,
    ): Promise<string[] | null> {
        if (context.budget.exhausted) {
            // The API side reads them itself when they are absent (§6.5 step 3).
            return null;
        }
        try {
            const files = await context.budget.call(() =>
                this.git.getPullRequestFiles(row.dataOwner, row.dataRepo, pullRequestNumber, {
                    userId: context.ownerUserId as string,
                    providerId: context.providerId,
                    workId: context.workId,
                }),
            );
            const paths = conflictPaths((files ?? []).map((file) => String(file?.filename ?? '')));
            return paths.length > 0 ? paths : null;
        } catch (error) {
            this.logger.warn(
                `App upstream sync: reading the conflicting files of ${row.dataOwner}/${row.dataRepo}#${pullRequestNumber} failed (${errorText(error)}); the API side reads them instead.`,
            );
            return null;
        }
    }

    // ── §6.3 step 6: FR-37's licence question ────────────────────────────────

    /**
     * Ask APW-03 whether upstream's head changes the licence class **for the worse**
     * (FR-37).
     *
     * **Both “I don't know” answers are the safe one: `true`.** A gate that cannot
     * answer has not said yes, and the cost of being wrong the other way is a
     * fast-forward nobody reviewed onto a licence the member may not be allowed to
     * run — which is the exact outcome FR-37 exists to prevent.
     *
     * The absent branch used to return `false` (“proceed”), citing `plan.md`'s
     * default. Measured 2026-09-20: `APP_UPSTREAM_LICENSE_SERVICE` is provided by no
     * Nest module anywhere in the tree, so `this.licenses` is `undefined` on **every**
     * production run — meaning that default was not a rare fallback, it was the only
     * answer the gate ever gave, and FR-37 was off. The two branches now agree:
     * unknown ⇒ take the pull-request path.
     *
     * The visible consequence, stated rather than hidden: until that token is bound,
     * every sync of a Work whose upstream moved opens a pull request instead of
     * fast-forwarding. That is slower and it is correct; the way to get the
     * fast-forward back is to BIND the licence service, not to loosen the gate.
     */
    private async licenseIsWorse(
        context: RunContext,
        row: WorkUpstreamState,
        headSha: string,
    ): Promise<boolean> {
        if (!this.licenses || typeof this.licenses.previewUpstream !== 'function') {
            // Unknown, not “fine” — see this method's docstring. `APP_UPSTREAM_LICENSE_SERVICE`
            // is bound nowhere today, so this is the branch production actually takes.
            this.logger.warn(
                `App upstream sync: no licence service is wired (APP_UPSTREAM_LICENSE_SERVICE is bound in no module), so the FR-37 licence check for work ${context.workId} cannot run; the sync takes the pull-request path rather than fast-forwarding unasked.`,
            );
            return true;
        }
        try {
            const preview = await this.licenses.previewUpstream(
                context.workId,
                row.upstreamOwner as string,
                row.upstreamRepo as string,
                headSha,
            );
            return preview?.worse === true;
        } catch (error) {
            this.logger.warn(
                `App upstream sync: previewing upstream's license for work ${context.workId} failed (${errorText(error)}); the sync takes the pull-request path rather than fast-forwarding unasked.`,
            );
            return true;
        }
    }

    // ── settle (§6.3 step 8) ─────────────────────────────────────────────────

    /**
     * Record the outcome, release the claim, emit the one-time events, and run the two
     * follow-ups FR-40 hangs off "the tracked branch changed".
     *
     * **This is the only `finishSync` call site in the file, and it runs for every path
     * that claimed the Work.** That is what makes the release structural: the paused,
     * skipped, failed, conflict and success branches all end here, so there is no branch
     * that can return early and leave the row claimed for the 30-minute TTL.
     */
    private async settle(context: RunContext, outcome: SyncOutcome): Promise<void> {
        const { workId, result } = context;

        const patch: WorkUpstreamStatePatch = { ...(outcome.rowPatch ?? {}) };
        // §3.1's `syncSchedule`: the effective cron the card renders. Nobody else writes
        // it, and a card that shows no schedule for a Work that clearly has one is a card
        // that lies (FR-32).
        if (context.row && context.row.syncSchedule !== context.settings.schedule) {
            patch.syncSchedule = context.settings.schedule;
        }
        if (Object.keys(patch).length > 0) {
            await this.recordRow(workId, patch);
        }

        const nextSyncAt =
            outcome.pause === true
                ? null
                : nextUpstreamSyncAt(context.settings, new Date(context.now()), workId);
        const rateLimitedUntil =
            typeof outcome.rateLimitedUntil === 'number' ? outcome.rateLimitedUntil : undefined;

        const settled = await this.safe(() =>
            this.states.finishSync(workId, {
                result: outcome.result,
                reason: outcome.reason,
                commits: outcome.commits ?? null,
                fromSha: outcome.fromSha ?? null,
                toSha: outcome.toSha ?? null,
                ...(outcome.pullRequestNumber !== undefined
                    ? { pullRequestNumber: outcome.pullRequestNumber }
                    : {}),
                ...(outcome.pullRequestUrl !== undefined
                    ? { pullRequestUrl: outcome.pullRequestUrl }
                    : {}),
                ...(outcome.pullRequestClosedHeadSha !== undefined
                    ? { pullRequestClosedHeadSha: outcome.pullRequestClosedHeadSha }
                    : {}),
                nextSyncAt,
                ...(rateLimitedUntil !== undefined ? { rateLimitedUntil } : {}),
                rateLimited: outcome.rateLimited === true,
                trackedBranchChanged: outcome.trackedBranchChanged === true,
            }),
        );

        if (!settled) {
            this.logger.warn(
                `App upstream sync: recording the outcome of work ${workId} failed; the claim expires with its TTL.`,
            );
        }

        result.result = outcome.result ?? null;
        result.reason = outcome.reason ?? null;
        result.commits = outcome.commits ?? null;
        result.fromSha = outcome.fromSha ?? null;
        result.toSha = outcome.toSha ?? null;
        result.divergence = outcome.divergence ?? null;
        result.pullRequest = outcome.pullRequest ?? null;
        result.conflict = outcome.conflict ?? null;
        result.nextSyncAt =
            nextSyncAt instanceof Date && !Number.isNaN(nextSyncAt.getTime())
                ? nextSyncAt.toISOString()
                : null;
        result.rateLimitedUntil =
            typeof rateLimitedUntil === 'number' ? new Date(rateLimitedUntil).toISOString() : null;

        for (const event of outcome.events ?? []) {
            const emitted = await this.emit(context, event);
            if (emitted) {
                result.events.push(event.action);
            }
        }

        // ── step 8's two follow-ups: only when the tracked branch changed ────
        if (outcome.trackedBranchChanged === true) {
            result.licenseRequested = await this.requestLicense(workId, 'upstream_synced');
            result.hygiene = await this.runHygiene(workId);
        }
    }

    /** FR-40: ask APW-03 for a licence re-evaluation. Failures are logged, never fatal. */
    private async requestLicense(
        workId: string,
        reason: AppLicenseEvaluationReason,
    ): Promise<boolean> {
        if (!this.licenses || typeof this.licenses.request !== 'function') {
            this.logger.warn(
                `App upstream sync: the license re-evaluation for work ${workId} was not requested (no AppLicenseService).`,
            );
            return false;
        }
        try {
            await this.licenses.request(workId, reason);
            return true;
        } catch (error) {
            this.logger.warn(
                `App upstream sync: requesting the license re-evaluation of work ${workId} failed (${errorText(error)}).`,
            );
            return false;
        }
    }

    /** FR-25/FR-40: hygiene after the tracked branch moved. Never fatal (FR-30). */
    private async runHygiene(workId: string): Promise<AppActionsHygieneResult | null> {
        try {
            return await this.hygiene.apply(workId);
        } catch (error) {
            this.logger.warn(
                `App upstream sync: Actions hygiene for work ${workId} failed (${errorText(error)}); the sync itself is unaffected.`,
            );
            return null;
        }
    }

    /**
     * One Activity entry of §3.5. A failure to record is logged, never thrown.
     *
     * The row carries the Work's own tenant and Organization, as
     * `AppUpstreamStateService.emit` stamps the `app.upstream.*` rows it writes. The
     * feed is scope-filtered, and this run is built for the Trigger worker, where the
     * Activity sink is a remote proxy whose request carries no workspace: the API's
     * stamping subscriber fills only an absent scope, and it would fill it from that
     * empty request, so an unstamped row lands null/null and never shows in an
     * org-scoped App Work's feed. A null scope column is passed as `null`, not left
     * out, for the same reason.
     */
    private async emit(context: RunContext, event: SyncEvent): Promise<boolean> {
        const owner =
            context.ownerUserId && context.ownerScope
                ? { userId: context.ownerUserId, scope: context.ownerScope }
                : await this.readOwner(context.workId);
        if (!this.activity || !owner) {
            this.logger.warn(
                `App upstream sync: ${event.action} for work ${context.workId} was not recorded (no Activity sink or no owner).`,
            );
            return false;
        }

        const entry: CreateActivityLogDto = {
            userId: owner.userId,
            workId: context.workId,
            tenantId: owner.scope.tenantId,
            organizationId: owner.scope.organizationId,
            actionType: event.actionType,
            action: event.action,
            status: event.status,
            summary: event.summary,
            details: event.details,
        };

        try {
            await this.activity.log(entry);
            return true;
        } catch (error) {
            this.logger.warn(
                `App upstream sync: recording ${event.action} for work ${context.workId} failed (${errorText(error)}).`,
            );
            return false;
        }
    }

    // ── reads ────────────────────────────────────────────────────────────────

    /**
     * The four `upstreamSync` fields of §6.4, read from APW-03's effective spec.
     *
     * Read on **every** run: FR-64's "a spec change that touches those blocks MUST be
     * picked up without waiting for the next scheduled run" is satisfied by having no
     * cache to invalidate. A missing source, a `null` snapshot and a throw all resolve to
     * the documented defaults (`enabled: true`, `0 6 * * 1`, `merge`) — the same answer
     * the schema documents for an absent block, and never "sync is off".
     */
    private async readSettings(workId: string): Promise<AppUpstreamSyncSettings> {
        if (!this.specs || typeof this.specs.getEffectiveSpec !== 'function') {
            return readUpstreamSyncSettings(null);
        }
        try {
            const snapshot = await this.specs.getEffectiveSpec(workId);
            return readUpstreamSyncSettings(snapshot?.spec ?? null);
        } catch (error) {
            this.logger.warn(
                `App upstream sync: reading the App spec of work ${workId} failed (${errorText(error)}); the documented schedule defaults apply.`,
            );
            return readUpstreamSyncSettings(null);
        }
    }

    /** The epic's own row (§3.1). Absent ⇒ the run fails closed, never guesses. */
    private async readRow(workId: string): Promise<WorkUpstreamState | null> {
        if (!this.rows) {
            return null;
        }
        try {
            return await this.rows.findByWorkId(workId);
        } catch (error) {
            this.logger.warn(
                `App upstream sync: reading the state row of work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * The Work's owner — whose credential every call is made with, and who owns the
     * events — and the Work's workspace, which the events are stamped with. Both come
     * from the one read, so a run never reads the Work twice.
     */
    private async readOwner(
        workId: string,
    ): Promise<{ userId: string; scope: OwnershipScope } | null> {
        if (!this.works) {
            return null;
        }
        try {
            const work = await this.works.findById(workId);
            return work?.userId ? { userId: work.userId, scope: ownershipScopeOf(work) } : null;
        } catch (error) {
            this.logger.warn(
                `App upstream sync: reading work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** The sync-owned columns outside `finishSync` (§3.1). A failure is logged, never fatal. */
    private async recordRow(workId: string, patch: WorkUpstreamStatePatch): Promise<boolean> {
        if (!this.rows) {
            return false;
        }
        try {
            return await this.rows.update(workId, patch);
        } catch (error) {
            this.logger.warn(
                `App upstream sync: recording the sync columns of work ${workId} failed (${errorText(error)}); the outcome itself is unaffected.`,
            );
            return false;
        }
    }

    /** A state call that must not take the run down with it. */
    private async safe<T>(call: () => Promise<T>): Promise<T | null> {
        try {
            return await call();
        } catch (error) {
            this.logger.warn(`App upstream sync: a state call failed (${errorText(error)}).`);
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * internals
 * -------------------------------------------------------------------------- */

/**
 * Everything one run threads through its steps.
 *
 * `result` is the object the caller receives, mutated as the run learns things; `row`,
 * `ownerUserId` and `ownerScope` are filled in by the steps that read them, so no later
 * step re-reads the database.
 */
interface RunContext {
    workId: string;
    trigger: AppUpstreamSyncTrigger;
    providerId: string;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    budget: ProviderCallBudget;
    row: WorkUpstreamState | null;
    ownerUserId: string | null;
    /** The Work's tenant and Organization, set with `ownerUserId` from the same read. */
    ownerScope: OwnershipScope | null;
    settings: AppUpstreamSyncSettings;
    result: AppUpstreamSyncRunResult;
}

/** §9.2: `mergeable` is re-read up to three times, 5 s apart. */
const APP_SYNC_MERGEABLE_REREADS = 3;

/** …and the gap between them. */
const APP_SYNC_MERGEABLE_REREAD_MS = 5_000;

/**
 * The outcome already on the row — what a divergence-only run settles with (§6.3
 * step 5). `finishSync`'s duplicate guard compares the result, the commit count, the
 * upstream sha and the pull request number, so re-recording them is a no-op write and
 * emits no second `app.upstream.synced`.
 */
function recordedOutcomeOf(row: WorkUpstreamState, patch: WorkUpstreamStatePatch): SyncOutcome {
    return {
        result: (row.lastSyncResult ?? 'up_to_date') as AppSyncResult,
        reason: row.lastSyncReason ?? 'up_to_date',
        commits: row.lastSyncCommitCount ?? null,
        toSha: row.lastSyncedUpstreamSha ?? null,
        pullRequestNumber: row.syncPullRequestNumber ?? null,
        rowPatch: patch,
    };
}

/**
 * FR-48's two emissions, as the run decides them: behind went from 0 to more than 0,
 * or grew by {@link APP_BEHIND_EVENT_STEP} or more since the last one.
 *
 * `behindEventCount` is the row's own record of the last emission (§3.1), so a Work
 * that has been behind 400 commits for a year emits once, on the change — not on every
 * sync.
 */
function behindEvents(
    row: WorkUpstreamState,
    comparison: { aheadBy: number; behindBy: number; upstreamHeadSha: string },
): SyncEvent[] {
    const previous = typeof row.behindEventCount === 'number' ? row.behindEventCount : 0;
    const grew = comparison.behindBy - previous;
    const firstTime = previous === 0 && comparison.behindBy > 0;
    if (!firstTime && !(comparison.behindBy > 0 && grew >= APP_BEHIND_EVENT_STEP)) {
        return [];
    }

    return [
        {
            action: 'app.upstream.behind',
            actionType: ActivityActionType.APP_UPSTREAM,
            status: ActivityStatus.COMPLETED,
            summary: 'Upstream has new commits',
            details: {
                behindBy: comparison.behindBy,
                aheadBy: comparison.aheadBy,
                upstreamHeadSha: comparison.upstreamHeadSha,
            },
        },
    ];
}

/**
 * Turn a thrown provider failure into an outcome (§6.3 step 9, FR-49…FR-52).
 *
 * The two rate-limit reasons are the only ones that are not `failed`: `rate_limited`
 * waits for the provider's own reset **plus 60 s** (FR-50), and
 * `secondary_rate_limited` waits for `retryAt` when the provider named one, else 60 s
 * doubling per consecutive rate-limited run up to an hour (FR-51). The streak is the
 * row's (`consecutiveRateLimited`, FR-52), so this run's own position in it is that
 * value plus one.
 */
function classifyFailure(error: unknown, context: RunContext): SyncOutcome {
    if (error instanceof ProviderBudgetExceededError) {
        return { result: 'skipped', reason: 'skipped_budget' };
    }
    if (error instanceof GitOperationNotSupportedError) {
        // Plan §7: absence of a capability is a typed refusal, never a crash.
        return { result: 'failed', reason: 'provider_unsupported' };
    }

    const reason = providerReasonOf(error);
    const retryAtMs = providerRetryAtMs(error);
    const now = context.now();

    if (reason === 'rate_limited') {
        return {
            result: 'skipped',
            reason: 'skipped_rate_limited',
            rateLimited: true,
            rateLimitedUntil: (retryAtMs ?? now) + APP_RATE_LIMIT_RESET_GRACE_MS,
        };
    }

    if (reason === 'secondary_rate_limited') {
        const streak = (context.row?.consecutiveRateLimited ?? 0) + 1;
        const backoff = Math.min(
            APP_RATE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1),
            APP_RATE_LIMIT_BACKOFF_MAX_MS,
        );
        return {
            result: 'skipped',
            reason: 'skipped_rate_limited',
            rateLimited: true,
            rateLimitedUntil: retryAtMs ?? now + backoff,
        };
    }

    return { result: 'failed', reason: reason ?? 'failed' };
}

/**
 * Whether a failed fast-forward should be carried by the pull request instead of failing
 * the run.
 *
 * §9.2 names the case: "`merge-upstream` 409 after 'behind only'" is a race — the
 * upstream moved between the compare and the merge — and the pull request is how a race
 * is resolved. A `conflict` or an `unprocessable` from the merge call is the same answer
 * as the plugin's own `conflict`/`unprocessable` outcome; a secondary rate limit or a
 * permission failure is not.
 */
function isPullRequestWorthy(error: unknown): boolean {
    const reason = providerReasonOf(error);
    return reason === 'conflict' || reason === 'unprocessable';
}

/** The typed provider reason, duck-typed so it survives a bundle boundary. */
function providerReasonOf(error: unknown): string | null {
    if (error instanceof GitProviderRequestError) {
        return error.reason;
    }
    const candidate = error as { reason?: unknown; status?: unknown } | null | undefined;
    if (candidate && typeof candidate.reason === 'string' && typeof candidate.status === 'number') {
        return candidate.reason;
    }
    return null;
}

/** The instant a rate-limited provider named for the retry, in epoch ms. */
function providerRetryAtMs(error: unknown): number | null {
    const retryAt = (error as { details?: { retryAt?: unknown } } | null | undefined)?.details
        ?.retryAt;
    if (typeof retryAt !== 'string' || retryAt.length === 0) {
        return null;
    }
    const parsed = Date.parse(retryAt);
    return Number.isFinite(parsed) ? parsed : null;
}

/** A stored timestamp column as epoch ms, or `null`. */
function toEpoch(value: Date | string | number | null | undefined): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.getTime();
    }
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
}

/** A provider count as a non-negative integer; anything else is `0`, never `NaN`. */
function count(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A trimmed non-empty string, or `null`. */
function nonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** A safe, log-injectable rendering of a caught value. */
function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}
