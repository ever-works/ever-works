import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_DIVERGENCE_TTL_MS,
    APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR,
    APP_READINESS_FAILURE_REASONS,
    APP_SYNC_REASONS,
    APP_UPSTREAM_CONFLICT_LABEL_PREFIX,
    APP_UPSTREAM_CONFLICT_MAX_PATHS,
    APP_UPSTREAM_SYNC_BRANCH,
    APP_UPSTREAM_SYNC_LOCK_TTL_MS,
    APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
    isAppWorkKind,
    TASK_BOARD_STATUSES,
    TASK_BOARD_TERMINAL_STATUSES,
    type AppReadinessFailureReason,
    type AppReadinessState,
    type AppRepositoryMode,
    type AppSyncReason,
    type AppSyncResult,
    type AppUpstreamStateResponse,
    type AppUpstreamWarning,
    type AppUpstreamWarningCode,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { ownershipScopeOf, type OwnershipScope } from '../database/ownership-scope';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { WorkUpstreamStatePatch } from '../database/repositories/work-upstream-state.repository';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import { NotificationCategory, NotificationType } from '../entities/notification.types';
import type { Task, TaskStatus } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';
import type { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import { GitFacadeService, NoGitCredentialsError } from '../facades/git.facade';
import { NotificationService } from '../notifications/notification.service';
import { TaskChatService } from '../tasks-domain/task-chat.service';
import { TasksService } from '../tasks-domain/tasks.service';
import type { AppForkReadyOutcome } from './app-fork-ready-handler.port';
import { computeNextUpstreamSync } from './upstream-schedule';

/**
 * APW-02 (Fork lifecycle) — the Upstream state service: the one writer of
 * `work_upstream_states` and the one reader the Upstream tab renders.
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md` FR-17…FR-24a,
 * FR-33, FR-34, FR-38, FR-41, FR-42, FR-44, FR-56, FR-65.
 * Plan: §4.1 (the response and its error codes, `plan.md:487-516`), §6.2 (readiness,
 * `plan.md:664-713`), §6.3 (the sync run, `plan.md:715-754`), §6.5 (the conflict Task,
 * `plan.md:773-798`), §3.1 (the columns, `plan.md:205-259`).
 *
 * ## Why this service exists at all
 *
 * Five epics need to know how an App Work's repository is doing — the readiness job
 * in the worker, the sync job, the dispatcher, the API routes and the Upstream card.
 * One row per App Work is the state (plan §3.1) and **this class is the only thing
 * that writes it**, so "who moved this Work to `ready`?" has a one-line answer, and
 * the two background jobs (which run as separate Trigger.dev processes) reach it
 * through a SuperJSON remote proxy rather than through a second copy of the rules
 * (plan §2.4's process table, `plan.md:190-197`).
 *
 * ## Events are emitted exactly once, and the state write is the guard
 *
 * `app.fork.ready` fires from {@link markReady} only for the call that finds the row
 * without a `readyAt`, so a duplicated job or a retried proxy call cannot double the
 * Activity entry. `app.fork.timeout` fires from {@link timeout} only for the call that
 * finds the row not already `timed_out`. `app.upstream.synced` fires from
 * {@link finishSync} only when the recorded outcome is not already the one being
 * recorded. Details — and the one place where the plan's "guarded by `readyAt IS NULL`
 * **in the update**" is weaker than it says — are in {@link markReady}.
 *
 * ## The optional seams
 *
 * Everything below `WorkUpstreamStateRepository` is `@Optional()` and appended after
 * it, in a stable order. Two reasons, and both matter:
 *
 *   1. **The module spec.** `app-works.module.spec.ts` (T15) compiles
 *      `AppWorksModule` on its own, with nothing but the entity's repository token
 *      bound — so a *required* collaborator would make that compile fail. The
 *      repositories and services this class reads (Works, Task, Tasks, chat, Activity,
 *      notifications, the git facade, the distributed lock) belong to other modules
 *      and are supplied by whichever API module imports this one (T27).
 *   2. **Fail-closed, never fail-silent-but-wrong.** Every absent seam has a defined
 *      answer: no `WorkRepository` ⇒ every request is `404 not_found` (a Work nobody
 *      can read is a Work nobody may act on); no `ActivityLogService` ⇒ the state
 *      write still happens and the entry is logged as a warning; no dispatcher ⇒ the
 *      manual door still records the attempt and answers `runId: null` (the 202 body
 *      of §4.1 already types that case).
 *
 * ## The three provisional seams (APW-08 T25, APW-02 T31)
 *
 * `APP_WORK_AGENT_RESOLVER` and the two dispatcher tokens are declared at the bottom
 * of this file because the tasks that own them have not landed. Each block carries the
 * exact names and shapes their owner fixes, and each says what the swap is.
 */

/** The rolling window both manual doors count in (FR-19, FR-33). */
const HOUR_MS = 3_600_000;

/**
 * The git provider an App Work's repository lives on.
 *
 * APW-01 creates App Works from a GitHub repository URL and spec §7 scopes the whole
 * epic to GitHub ("GitLab, Bitbucket and self-hosted Git" are out of scope), and the
 * state row carries no provider column — so this is the one provider the facade is
 * asked for until a later epic stores it. The readiness job's payload carries the same
 * value (`plan.md:655`) and {@link probeReadiness} accepts it.
 */
export const APP_WORK_GIT_PROVIDER_ID = 'github';

/** The lock key a sync run holds for an App Work (`plan.md:720`). */
export const UPSTREAM_SYNC_LOCK_KEY_PREFIX = 'app-upstream-sync:';

/**
 * How long a setup pull request check is trusted before the sweeper may claim the row again
 * (`tasks.md:562`: `claimSetupPullRequestChecks(now, 600_000, 50)`, plan §6.6's fourth leg).
 *
 * Ten minutes is the plan's number and it is a *provider* budget rather than a UI one: the
 * setup pull request is opened by the platform and merged by the member, so polling it faster
 * buys nothing and spends the installation's rate limit against the two legs that matter more
 * (the fork readiness probes and the sync dispatch).
 */
export const APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS = 600_000;

/**
 * How stale `setupCheckedAt` may be before **opening the Upstream card** is allowed to trigger
 * another check (`tasks.md:564-565`, plan §4.1's on-view half).
 *
 * Sixty seconds, not the ten minutes above, because the two doors answer different questions:
 * the sweeper is asking "has anything changed in the last ten minutes", while the member who
 * just merged the setup pull request and reloaded the page is asking "is it ready **now**".
 * The row is the gate for both, so a burst of reloads still produces at most one read a minute
 * (ACC-02-22's "at most once per 60 s").
 */
export const APP_SETUP_PULL_REQUEST_ON_VIEW_MS = 60_000;

/** The lock key of one App Work's sync — what `requestSync` asks about. */
export function upstreamSyncLockKey(workId: string): string {
    return `${UPSTREAM_SYNC_LOCK_KEY_PREFIX}${workId}`;
}

/**
 * Exactly the five open Task statuses of plan §6.5 (`plan.md:777-782`): the board's
 * seven minus the two terminal members, derived from the contract constant so a status
 * added later joins the list by itself and a Task in `done` or `cancelled` is never
 * mistaken for the open conflict Task.
 *
 * The cast is the seam between two vocabularies that are deliberately kept apart — the
 * contract's plain string union (which the web app imports) and the agent package's
 * `TaskStatus` enum (which the repository's filter takes). They are the same seven
 * strings; `TASK_BOARD_STATUSES` is described in contracts as the enum's mirror.
 */
const OPEN_CONFLICT_TASK_STATUSES = TASK_BOARD_STATUSES.filter(
    (status) => !TASK_BOARD_TERMINAL_STATUSES.includes(status),
) as readonly TaskStatus[];

/**
 * The sync results that are recorded as `app.upstream.synced` (plan §6.3 step 8,
 * `plan.md:750`): the two the branch actually moved under — a fast-forward and either
 * pull-request outcome. `up_to_date`, `conflict`, `skipped`, `paused` and `failed` are
 * recorded in the row and are not "upstream synced".
 */
const SYNCED_EVENT_RESULTS: ReadonlySet<string> = new Set([
    'fast_forwarded',
    'pull_request_opened',
    'pull_request_updated',
]);

/** The eight refusal codes of plan §4.1 (`plan.md:504-516`), plus the two 404s. */
export type AppUpstreamErrorCode =
    | 'not_found'
    | 'no_upstream'
    | 'not_ready'
    | 'sync_in_progress'
    | 'sync_limit_reached'
    | 'sync_paused'
    | 'not_retryable'
    | 'retry_limit_reached';

/**
 * The typed refusal every route of plan §4.1 answers with — `{ status: 'error', code,
 * message, details? }` once the API filter renders it.
 *
 * Shape follows the package's existing typed errors (`AppLauncherPinLimitError`,
 * `packages/agent/src/app-launcher/app-launcher.errors.ts:27`): a real `Error` subclass
 * carrying the machine-readable `code`, the HTTP status the plan's table fixes, and the
 * `details` bag (`retryAt`, `reason`) as readonly properties, so the controller maps it
 * without re-deriving anything and `instanceof` plus a `code` switch both work.
 */
export class AppUpstreamRefusalError extends Error {
    readonly code: AppUpstreamErrorCode;
    readonly status: number;
    readonly details?: Record<string, string>;

    constructor(
        code: AppUpstreamErrorCode,
        status: number,
        message: string,
        details?: Record<string, string>,
    ) {
        super(message);
        this.name = 'AppUpstreamRefusalError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

/** Whether a caught value is this epic's refusal (`instanceof` plus the code, across bundles). */
export function isAppUpstreamRefusalError(value: unknown): value is AppUpstreamRefusalError {
    if (value instanceof AppUpstreamRefusalError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { code?: unknown }).code === 'string' &&
        typeof (value as { status?: unknown }).status === 'number' &&
        (value as { name?: unknown }).name === 'AppUpstreamRefusalError'
    );
}

/** What {@link AppUpstreamStateService.beginAttempt} answers the readiness job (§6.2 step 1). */
export interface AppReadinessAttempt {
    /** `false` ⇒ there is no state row for this Work; the job exits without writing. */
    found: boolean;
    /** `true` ⇒ the Work is already `ready`; the job exits without polling (FR-22). */
    ready: boolean;
    readinessState: AppReadinessState | null;
    relation: AppRepositoryMode | null;
    dataOwner: string | null;
    dataRepo: string | null;
    dataDefaultBranch: string | null;
    upstreamOwner: string | null;
    upstreamRepo: string | null;
    upstreamDefaultBranch: string | null;
    /** Set ⇒ the private copy was already pushed and must not be pushed again (FR-21). */
    copyPushedSha: string | null;
    /** Set ⇒ this run is the setup-pull-request follow-through (FR-24a). */
    setupPullRequestNumber: number | null;
}

/**
 * What one {@link AppUpstreamStateService.probeReadiness} read found (§6.2 step 3).
 *
 * `preparing` is also the answer when the repository reads back `null`: a fork that is
 * not readable *yet* is not an error, and treating it as one would fail every Work
 * whose fork GitHub is still creating. The deadline is what ends the wait.
 */
export interface AppReadinessProbe {
    status: 'ready' | 'preparing' | 'access_revoked' | 'rate_limited' | 'failed';
    /** `empty` as the provider reported it; `null` when the repository could not be read. */
    empty: boolean | null;
    /** For `rate_limited`: the instant the run may probe again. */
    retryAt?: string;
    /** For `access_revoked` / `failed`: a reason code, never a provider message. */
    reason?: string;
}

/** The state a readiness transition left behind. */
export interface AppReadinessResolution {
    found: boolean;
    state: AppReadinessState | null;
    /** `true` only for the call whose write was the one that emitted the Activity entry. */
    emitted: boolean;
}

/** The `202` body of plan §4.1 (`plan.md:495-496`). */
export interface AppUpstreamDispatchResult {
    queued: boolean;
    runId: string | null;
}

/** Why a sync run was dispatched (`plan.md:656`). */
export type AppUpstreamSyncTrigger = 'schedule' | 'manual' | 'divergence' | 'merged';

/** What {@link AppUpstreamStateService.beginSync} answers the sync job (§6.3 step 2). */
export interface AppSyncBeginResult {
    allowed: boolean;
    /** `not_found` / `no_upstream` / `not_ready` / `sync_in_progress` when refused. */
    reason: AppUpstreamErrorCode | null;
    startedAt: string | null;
}

/** What {@link AppUpstreamStateService.finishSync} records (plan §6.3 step 8). */
export interface AppSyncFinishInput {
    result: AppSyncResult;
    reason?: string | null;
    commits?: number | null;
    fromSha?: string | null;
    /** The upstream head the run reached — the fast-forward's stored sha (FR-40). */
    toSha?: string | null;
    pullRequestNumber?: number | null;
    pullRequestUrl?: string | null;
    /** Head of a pull request the member closed without merging (S26). */
    pullRequestClosedHeadSha?: string | null;
    /** The next claimable slot, from T26's schedule helper; omitted = leave the stored value. */
    nextSyncAt?: Date | string | number | null;
    rateLimitedUntil?: Date | string | number | null;
    /** `true` ⇒ this run was rate limited; the consecutive counter increments (FR-52). */
    rateLimited?: boolean;
    /** `true` ⇒ the tracked branch moved this run (the licence + hygiene legs of step 8). */
    trackedBranchChanged?: boolean;
}

/** What {@link AppUpstreamStateService.finishSync} answers its caller. */
export interface AppSyncFinishResult {
    found: boolean;
    emitted: boolean;
    /** `true` when the run was a repeat of the outcome already recorded (no second event). */
    duplicate: boolean;
    /** Echoed so the worker can run the licence and hygiene legs of §6.3 step 8. */
    trackedBranchChanged: boolean;
}

/** The conflict a sync pull request cannot merge (plan §6.5, `plan.md:773-798`). */
export interface AppConflictInput {
    /** The sync pull request: its number is the key, its URL is what the member opens. */
    pr?: { number?: number | null; url?: string | null } | null;
    /** The upstream head the sync moved from and to. */
    fromSha?: string | null;
    toSha?: string | null;
    /** How many commits upstream moved. */
    commits?: number | null;
    /**
     * The conflicting paths, in the caller's order. Computed by the sync run from the
     * files changed on both sides since the merge base (GitHub lists no conflicting
     * files directly, §6.5 step 3); when absent this service reads the pull request's
     * files itself, capped at {@link APP_UPSTREAM_CONFLICT_MAX_PATHS}.
     */
    paths?: readonly string[] | null;
}

/** What {@link AppUpstreamStateService.recordConflict} answers. */
export interface AppConflictResult {
    /** The Task the conflict is parked on, or `null` when no Task service was available. */
    taskId: string | null;
    /** `true` when this call created the Task; `false` when it commented on the open one. */
    created: boolean;
    /** `true` when the open Task was commented on instead of duplicated (ACC-02-11). */
    commented: boolean;
    /** The Agent APW-08's resolver named, or `null` when none resolved (R-21). */
    agentId: string | null;
    /** The paths the Task's description lists. */
    paths: string[];
}

// ── provisional seams ───────────────────────────────────────────────────────
//
// Three tokens whose owner tasks have not landed. Each is declared with the exact name
// and shape its owner fixes in the plan, in the same style as the git facade's
// "APW-09 T1/T2 provisional shapes (temporary seam)" block
// (`packages/agent/src/facades/git.facade.ts:290-309`): the runtime contract — the token
// identity, the positional arguments, the resolved value — is already the final one, so
// the swap below changes an import and nothing else.
//
// 🛑 **Each swap is mandatory, not cosmetic, and the reason is the same for all three:**
// a Nest token is compared by identity, so two Symbols that happen to share a name are
// two different tokens. If the owner lands its own declaration and this block is left in
// place, the owner's binding will not reach this injection — the service would fall back
// to its fail-closed default and the feature would fail silently rather than loudly.

/**
 * _Provisional — APW-08 T25_ (`packages/agent/src/app-works/app-work-agent-resolver.ts`,
 * CONTRACTS.md:351, Resolution R-21).
 *
 * APW-08's change-Agent rule: the most recent Task's Agent, else the only Work-scoped
 * Agent, else the only assigned Agent, skipping archived and non-committing ones. APW-08
 * T25 states that the token is bound in `packages/agent/src/app-works/app-works.module.ts`
 * (APW-08 plan §2.8, `APW-08-evolve-loop/plan.md:523-533`), together with a
 * module-compilation spec asserting the injected token is **defined** — which is exactly
 * the check that will catch a forgotten swap.
 *
 * When T25 lands: delete this block, import `AppWorkAgentResolver` and
 * `APP_WORK_AGENT_RESOLVER` from `./app-work-agent-resolver`, and let that module bind
 * it. The port below is the consumer half of the CONTRACTS §2 row and nothing more.
 */
export interface AppWorkAgentResolver {
    resolve(input: {
        userId: string;
        workId: string;
    }): Promise<{ agentId: string; source: 'recent-task' | 'pinned' | 'assigned' } | null>;
}

/** DI token for {@link AppWorkAgentResolver} — owned by APW-08 T25. */
export const APP_WORK_AGENT_RESOLVER = Symbol('APP_WORK_AGENT_RESOLVER');

/**
 * _Provisional — APW-02 T31_ (`packages/agent/src/tasks/app-fork-readiness.types.ts`,
 * plan §6.1 `plan.md:655`).
 *
 * The payload the readiness job is dispatched with; `reason: 'retry'` is what
 * {@link AppUpstreamStateService.retryReadiness} sends.
 */
export interface AppForkReadinessJobPayload {
    workId: string;
    attempt: number;
    reason?: 'initial' | 'retry' | 'redispatch' | 'setup_merged';
    providerId?: string;
    credentialVersion?: number;
}

/** The dispatcher APW-02's P1.7 binds to the real Trigger.dev dispatch (plan §6.1). */
export interface AppForkReadinessDispatcher {
    dispatch(payload: AppForkReadinessJobPayload): Promise<string | null>;
}

/** DI token for {@link AppForkReadinessDispatcher} — owned by APW-02 T31. */
export const APP_FORK_READINESS_DISPATCHER = Symbol('APP_FORK_READINESS_DISPATCHER');

/**
 * _Provisional — APW-02 T31_ (`packages/agent/src/tasks/app-upstream-sync.types.ts`,
 * plan §6.1 `plan.md:656`).
 */
export interface AppUpstreamSyncJobPayload {
    workId: string;
    trigger: AppUpstreamSyncTrigger;
    providerId?: string;
    credentialVersion?: number;
}

/** The dispatcher APW-02's P1.7 binds to the real Trigger.dev dispatch (plan §6.1). */
export interface AppUpstreamSyncDispatcher {
    dispatch(payload: AppUpstreamSyncJobPayload): Promise<string | null>;
}

/** DI token for {@link AppUpstreamSyncDispatcher} — owned by APW-02 T31. */
export const APP_UPSTREAM_SYNC_DISPATCHER = Symbol('APP_UPSTREAM_SYNC_DISPATCHER');

/**
 * What one setup-pull-request check did (FR-24a, APW-02 T43).
 *
 * `status` is the *outcome of the transition*, not the provider's raw state, because that is
 * what the caller (a tick, or the on-view dispatch) can act on: `not_waiting` means there was
 * nothing to follow up, `open` means the check ran and the pull request is still open,
 * `merged` and `closed` are the two transitions, and `unknown` means the provider would not
 * answer — which is deliberately **not** a transition.
 *
 * `checked` distinguishes "we read the provider" from "we had nothing to read", so an
 * unreadable row is never mistaken for a checked one.
 */
export interface AppSetupPullRequestCheck {
    readonly found: boolean;
    readonly checked: boolean;
    readonly status: 'open' | 'merged' | 'closed' | 'unknown' | 'not_waiting';
    /** The readiness run id, when this check dispatched one (`merged` only). */
    readonly runId?: string | null;
}

@Injectable()
export class AppUpstreamStateService {
    private readonly logger = new Logger(AppUpstreamStateService.name);

    constructor(
        private readonly states: WorkUpstreamStateRepository,
        // Every dependency below is `@Optional()` and appended in a stable order, so a
        // hand-rolled construction (a unit test, a lean CLI context) can pass a prefix
        // of them and the module spec's bare compile still resolves (see the class doc).
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly workMembers?: WorkMemberRepository,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly taskRepository?: TaskRepository,
        @Optional() private readonly tasks?: TasksService,
        @Optional() private readonly taskChat?: TaskChatService,
        @Optional() private readonly activity?: ActivityLogService,
        @Optional() private readonly notifications?: NotificationService,
        @Optional() private readonly locks?: DistributedTaskLockService,
        @Optional()
        @Inject(APP_WORK_AGENT_RESOLVER)
        private readonly agentResolver?: AppWorkAgentResolver,
        @Optional()
        @Inject(APP_FORK_READINESS_DISPATCHER)
        private readonly readinessDispatcher?: AppForkReadinessDispatcher,
        @Optional()
        @Inject(APP_UPSTREAM_SYNC_DISPATCHER)
        private readonly syncDispatcher?: AppUpstreamSyncDispatcher,
    ) {}

    // ── §4.1 — the read ──────────────────────────────────────────────────────

    /**
     * `GET /api/works/:id/upstream` — the whole Upstream card in one answer
     * (`plan.md:494`, the shape at `plan.md:384-434`).
     *
     * Visibility is checked here as well as in the controller's guard, and that is
     * deliberate: `get` is reachable from the readiness job and from the on-view setup
     * check, and "who may read this Work's upstream" must not depend on which door was
     * used. A Work that is missing, not kind `app`, not the caller's and not one they
     * are a member of answers **the same** `404 not_found` — the answer never tells a
     * stranger that the Work exists (ACC-02-21, FR-56).
     *
     * The two background dispatches §4.1 hangs off this route (the divergence compare
     * and the setup pull request check) belong to T26 and T43 and are **not** here: this
     * method never dispatches anything, so a read can never queue work as a side effect.
     */
    async get(workId: string, userId: string): Promise<AppUpstreamStateResponse> {
        const work = await this.requireVisibleAppWork(workId, userId);
        const state = await this.requireState(workId);
        const now = Date.now();

        const upstream =
            state.relation === 'link' || !state.upstreamOwner || !state.upstreamRepo
                ? null
                : {
                      owner: state.upstreamOwner,
                      repo: state.upstreamRepo,
                      url: repositoryWebUrl(state.upstreamOwner, state.upstreamRepo),
                      defaultBranch: state.upstreamDefaultBranch ?? state.dataDefaultBranch,
                      previousDefaultBranch: state.upstreamPreviousDefaultBranch ?? undefined,
                      status: state.upstreamStatus,
                  };

        return {
            workId: state.workId,
            relation: state.relation,
            dataRepository: {
                owner: state.dataOwner,
                repo: state.dataRepo,
                url: repositoryWebUrl(state.dataOwner, state.dataRepo),
                defaultBranch: state.dataDefaultBranch,
                status: state.dataRepositoryStatus,
            },
            upstream,
            readiness: {
                state: state.readinessState,
                ...this.readinessReasonOf(state.readinessReason),
                startedAt: isoOf(state.readinessStartedAt) ?? new Date(0).toISOString(),
                readyAt: isoOf(state.readyAt),
                setupPullRequestUrl: state.setupPullRequestUrl ?? undefined,
                setupPullRequestNumber: state.setupPullRequestNumber ?? undefined,
                manualRetriesLeft: this.manualAttemptsLeft(
                    state.readinessManualRetries,
                    state.readinessManualWindowAt,
                    APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR,
                    now,
                ),
            },
            divergence: this.divergenceOf(state, now),
            // §3.4: a linked App Work has no upstream and no sync at all (FR-44).
            sync: state.relation === 'link' ? null : this.syncOf(state, now),
            actions: this.actionsOf(state),
            warnings: this.warningsOf(state, now),
        };
    }

    // ── §6.2 — readiness ─────────────────────────────────────────────────────

    /**
     * Step 1 of the readiness run (`plan.md:675-677`): stamp the heartbeat the stale
     * sweeper measures (`readinessHeartbeatAt`, FR-23) and hand the job everything it
     * needs to decide, in one read.
     *
     * `ready` is the short-circuit FR-22 asks for — the API route queues a re-dispatch
     * and the job that finds the Work already ready exits without polling, without
     * hygiene and without calling the handler a second time.
     *
     * This method deliberately does **not** touch `readinessDispatches`: that counter is
     * the sweeper's (FR-23's "at most 3 restarts"), and a job that incremented it on
     * every start would exhaust the allowance by itself.
     */
    async beginAttempt(workId: string, attempt: number): Promise<AppReadinessAttempt> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return {
                found: false,
                ready: false,
                readinessState: null,
                relation: null,
                dataOwner: null,
                dataRepo: null,
                dataDefaultBranch: null,
                upstreamOwner: null,
                upstreamRepo: null,
                upstreamDefaultBranch: null,
                copyPushedSha: null,
                setupPullRequestNumber: null,
            };
        }

        await this.states.update(workId, { readinessHeartbeatAt: new Date() });

        return {
            found: true,
            ready: state.readinessState === 'ready',
            readinessState: state.readinessState,
            relation: state.relation,
            dataOwner: state.dataOwner,
            dataRepo: state.dataRepo,
            dataDefaultBranch: state.dataDefaultBranch,
            upstreamOwner: state.upstreamOwner ?? null,
            upstreamRepo: state.upstreamRepo ?? null,
            upstreamDefaultBranch: state.upstreamDefaultBranch ?? null,
            copyPushedSha: state.copyPushedSha ?? null,
            setupPullRequestNumber: state.setupPullRequestNumber ?? null,
        };
    }

    /**
     * Step 3 of the readiness run (`plan.md:680-683`): read the Work Repository and
     * answer whether it has a commit yet.
     *
     * `empty === false` is the whole signal (FR-17): a repository whose default branch
     * has a commit is ready, whether it got there by a fork finishing or by the member
     * pushing. A repository the provider does not report (`null`), or one that reports
     * `empty: true`/`undefined`, keeps the job polling — an unreadable repository is
     * "not yet", never "broken", because GitHub makes a fork readable some seconds after
     * it accepts the request.
     *
     * The two failures that must NOT be waited out are classified here (FR-20): a dead
     * credential (`NoGitCredentialsError`, or the provider's `unauthorized`) ends the
     * attempt in `access_revoked`, and a rate limit hands back the instant to retry at
     * (FR-50/FR-51) so the job sleeps until then instead of hammering.
     */
    async probeReadiness(
        workId: string,
        providerId: string = APP_WORK_GIT_PROVIDER_ID,
    ): Promise<AppReadinessProbe> {
        const state = await this.states.findByWorkId(workId);
        const work = state ? await this.loadWork(workId) : null;
        if (!state || !work) {
            return { status: 'preparing', empty: null };
        }
        if (!this.git) {
            // §7's posture for a capability the platform cannot reach: a named failure, not
            // a 15-minute wait that ends in a timeout nobody can explain.
            return { status: 'failed', empty: null, reason: 'provider_unsupported' };
        }

        // The probe is the job's own liveness signal: a probe that never reports is a
        // job the sweeper restarts (FR-23).
        await this.states.update(workId, { readinessHeartbeatAt: new Date() });

        try {
            const repository = await this.git.getRepository(state.dataOwner, state.dataRepo, {
                userId: work.userId,
                providerId,
                workId,
            });

            if (!repository) {
                // Not readable yet (GitHub makes a fork readable seconds after it accepts
                // the request) — the deadline is what ends this wait, not an error.
                return { status: 'preparing', empty: null };
            }

            return {
                status: isRepositoryNonEmpty(repository) ? 'ready' : 'preparing',
                empty: repository.empty ?? null,
            };
        } catch (error) {
            return this.classifyProbeFailure(error);
        }
    }

    /**
     * Step 2's success leg (`plan.md:678-679`): remember the head the private copy
     * already pushed, so a re-dispatched job does not push the full history twice
     * (FR-21). Idempotent — the same sha writes nothing.
     */
    async recordCopyPushed(workId: string, sha: string): Promise<boolean> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return false;
        }
        if (state.copyPushedSha === sha) {
            return true;
        }
        return this.states.update(workId, { copyPushedSha: sha });
    }

    /**
     * Step 5 of the readiness run (`plan.md:684-688`): the handler has answered, so the
     * App Work comes to rest — `ready`, or `waiting_for_setup_pr` when the handler
     * opened a pull request the member still has to merge (FR-24a, R-4). A `failed`
     * outcome is recorded as `failed` with `handler_failed:<reason>` (`plan.md:705`).
     *
     * **`app.fork.ready` is emitted once per App Work.** The guard is `readyAt`: the
     * call that finds it unset is the call that owns the event, and every later call —
     * a retried job, the setup-merged re-run of FR-24a — writes the row and emits
     * nothing.
     *
     * ⚠️ **Weaker than the plan says, and deliberately reported rather than hidden.**
     * `plan.md:687` asks for the guard to be *in the update* (`… WHERE readyAt IS NULL`),
     * which would make two concurrent calls safe. `WorkUpstreamStateRepository.update()`
     * (`packages/agent/src/database/repositories/work-upstream-state.repository.ts:156`)
     * takes no extra predicate and this service owns no SQL (T12–T14 own the queries), so
     * the guard is the read below. Two truly concurrent `markReady` calls can therefore
     * both see `readyAt` unset and emit twice; the ordered calls the epic actually makes
     * (one job per Work, one remote-proxy hop at a time) cannot. Closing it properly needs
     * one repository method — `markReadyIfUnset(workId, patch): Promise<boolean>` — which
     * is reported to the coordinator rather than added here.
     *
     * `attempt` is not part of this transition: readiness is a property of the Work, and
     * "ready" is only ever reached once.
     */
    async markReady(
        workId: string,
        outcome?: AppForkReadyOutcome | null,
    ): Promise<AppReadinessResolution> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { found: false, state: null, emitted: false };
        }

        const firstReady = !state.readyAt;
        const failed = outcome?.result === 'failed';
        const waiting = !failed && outcome?.result === 'waiting_for_setup_pr';
        const nextState: AppReadinessState = failed
            ? 'failed'
            : waiting
              ? 'waiting_for_setup_pr'
              : 'ready';
        const now = new Date();

        /**
         * **Plan §6.2 step 5: `readyAt` and `nextSyncAt` are written together.** A ready fork that
         * keeps `nextSyncAt = NULL` never syncs, because the dispatcher selects rows by
         * `nextSyncAt <= now` (`app-upstream-sync-dispatcher.service.ts`, plan §6.2) and NULL is not
         * `<=` anything — the first scheduled sync would have to wait for something else to stamp
         * the slot first, which nothing does until the Work is dispatched some other way. So the
         * slot is computed here, through the same §6.4 helper the dispatcher's own `stampNextSlot`
         * uses (the row's effective cron, the hourly clamp and this Work's stable jitter).
         *
         * A **failed** readiness is deliberately left unstamped rather than cleared: there is no
         * repository to sync, and overwriting a stored slot would change a row this transition does
         * not own. `null` is the documented "nothing scheduled" state either way (§3.1).
         */
        const nextSyncAt = failed
            ? undefined
            : (computeNextUpstreamSync(state.syncSchedule ?? null, now, workId) ?? null);

        await this.states.update(workId, {
            readinessState: nextState,
            readinessReason: failed ? handlerFailureReason(outcome?.reason) : null,
            readinessHeartbeatAt: now,
            readyAt: now,
            setupPullRequestUrl: outcome?.setupPullRequestUrl ?? state.setupPullRequestUrl ?? null,
            setupPullRequestNumber:
                outcome?.setupPullRequestNumber ?? state.setupPullRequestNumber ?? null,
            ...(nextSyncAt === undefined ? {} : { nextSyncAt }),
        });

        if (!firstReady) {
            return { found: true, state: nextState, emitted: false };
        }

        await this.emit(workId, {
            actionType: ActivityActionType.APP_FORK,
            action: 'app.fork.ready',
            status: failed ? ActivityStatus.FAILED : ActivityStatus.COMPLETED,
            summary: failed
                ? 'The App Work repository could not be set up'
                : 'The App Work repository is ready',
            details: {
                result: outcome?.result ?? 'initialized',
                readinessState: nextState,
                setupPullRequestNumber: outcome?.setupPullRequestNumber ?? null,
            },
        });

        return { found: true, state: nextState, emitted: true };
    }

    /**
     * **FR-24a — the setup pull request follow-through** (`plan.md:707`, §6.6's fourth leg,
     * APW-02 T43).
     *
     * A `waiting_for_setup_pr` App Work rests on a pull request the platform opened in the
     * member's own repository (the setup PR that makes the fork's default branch publishable).
     * Nothing was watching it: this method is the watcher, and it is called from two doors —
     * the dispatcher's tick (`claimSetupPullRequestChecks`, at most one check per row per
     * {@link APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS}) and the on-view read
     * (`app-upstream.controller.ts`, when the card is opened and the last check is older than
     * {@link APP_SETUP_PULL_REQUEST_ON_VIEW_MS}).
     *
     * **Three transitions, and a fourth answer that is not one:**
     *
     *   - `merged` ⇒ queue `app-fork-readiness` with `reason: 'setup_merged'` (attempt 1) and
     *     put the row back to `preparing` first, exactly as {@link retryReadiness} does, so the
     *     work the dispatch represents is visible in the row before the queue is asked. The
     *     readiness run then **skips copy, polling and hygiene** and calls the setup handler
     *     once (`app-fork-readiness.service.ts`), because the source is on the default branch
     *     already.
     *   - `closed` **and not merged** ⇒ `failed` / `setup_pull_request_closed`. The member
     *     closed the setup PR without merging, so there is nothing to wait for and saying so is
     *     the honest resting state — the card then offers **Try again** like any other failure.
     *   - still `open` (or `draft`) ⇒ **no state change at all**. The check's only trace is
     *     `setupCheckedAt`, which is what keeps the on-view door from checking on every poll.
     *   - **the provider would not answer** (`null`, or a thrown read: no credential, the scope
     *     withdrawn, the capability unsupported) ⇒ `unknown`, and again no state change. This is
     *     the deliberate one: a credential problem is transient and belongs to the credential
     *     path (FR-43's pause), and failing the Work here would turn "we could not read GitHub
     *     this minute" into a lost setup that the member never asked for.
     *
     * **The read uses the member's own credential** — `work.userId`, and `workId` is
     * deliberately **not** passed in the facade options, so nothing here can reach for a
     * platform token or an installation token. The setup pull request is in the member's
     * repository and is theirs to read; the background job's credential question is FR-43's and
     * is answered elsewhere.
     */
    async checkSetupPullRequest(workId: string): Promise<AppSetupPullRequestCheck> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { found: false, checked: false, status: 'not_waiting' };
        }

        const number = state.setupPullRequestNumber;
        const waiting =
            state.readinessState === 'waiting_for_setup_pr' &&
            typeof number === 'number' &&
            Boolean(state.dataOwner) &&
            Boolean(state.dataRepo);

        if (!waiting) {
            // Nothing to follow up: not waiting on a setup pull request, no number recorded, or
            // no coordinates to read. Deliberately **no** `setupCheckedAt` stamp either — a check
            // that did not happen must not make the row look freshly checked and thereby suppress
            // the next real one.
            return { found: true, checked: false, status: 'not_waiting' };
        }

        // `loadWork` rather than a repository call of my own: it is this service's one accessor
        // for the Work row (it fails closed and logs), so a second way to read the same row here
        // would be a second answer to "which Work is this" — the same reasoning the class applies
        // to its other reads.
        const work = await this.loadWork(workId);
        if (!this.git || !work) {
            // No facade bound, or the Work row is gone: answer `unknown` rather than pretending
            // the pull request is still open.
            return { found: true, checked: false, status: 'unknown' };
        }

        let status: GitPullRequestStatus | null = null;
        try {
            status = await this.git.getPullRequestStatus(state.dataOwner, state.dataRepo, number, {
                userId: work.userId,
                providerId: APP_WORK_GIT_PROVIDER_ID,
            });
        } catch (error) {
            this.logger.warn(
                `App upstream: the setup pull request check for work ${workId} could not read the provider (${errorText(error)}); it stays waiting.`,
            );
            await this.states.update(workId, { setupCheckedAt: new Date() });
            return { found: true, checked: true, status: 'unknown' };
        }

        await this.states.update(workId, { setupCheckedAt: new Date() });

        if (!status) {
            // The provider answered "no such pull request" (deleted, transferred, or a token that
            // cannot see it). Not a merge, not a close — see the docstring's fourth answer.
            return { found: true, checked: true, status: 'unknown' };
        }

        if (status.merged || status.state === 'merged') {
            const now = new Date();
            await this.states.update(workId, {
                readinessState: 'preparing',
                readinessReason: null,
                readinessStartedAt: now,
                readinessHeartbeatAt: now,
                readinessDispatches: 0,
            });

            const runId = await this.dispatchReadiness(workId, {
                workId,
                attempt: 1,
                reason: 'setup_merged',
            });

            return { found: true, checked: true, status: 'merged', runId };
        }

        if (status.state === 'closed') {
            await this.fail(workId, 'setup_pull_request_closed');
            return { found: true, checked: true, status: 'closed' };
        }

        return { found: true, checked: true, status: 'open' };
    }

    /**
     * Step 3's deadline (`plan.md:682-683`, FR-18): 15 minutes of polling ended with
     * nothing to show, so the Work is `timed_out` and `app.fork.timeout` is recorded
     * **once per attempt**.
     *
     * The row's own `readinessState` is the per-attempt marker, and that is exact rather
     * than approximate: `timed_out` is a resting state — the only two ways out of it are
     * {@link retryReadiness} (**Try again**, which is a new attempt by definition) and
     * `beginAttempt`, which the readiness job calls only after a *dispatch* — and the
     * sweeper's re-dispatch path only ever sees `preparing` rows
     * (`findStalePreparing`). A second `timeout()` for the same attempt therefore finds
     * the state already `timed_out` and emits nothing; the attempt number rides in the
     * event details so the Activity feed still says which one ended.
     */
    async timeout(workId: string, attempt: number = 1): Promise<AppReadinessResolution> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { found: false, state: null, emitted: false };
        }

        const alreadyTimedOut = state.readinessState === 'timed_out';
        await this.states.update(workId, {
            readinessState: 'timed_out',
            readinessReason: 'timed_out',
            readinessHeartbeatAt: new Date(),
        });

        if (alreadyTimedOut) {
            return { found: true, state: 'timed_out', emitted: false };
        }

        await this.emit(workId, {
            actionType: ActivityActionType.APP_FORK,
            action: 'app.fork.timeout',
            status: ActivityStatus.FAILED,
            summary: 'The repository did not become ready in time',
            details: { attempt },
        });

        return { found: true, state: 'timed_out', emitted: true };
    }

    /**
     * The `failed` door of the readiness machine (`plan.md:679`, FR-20, FR-45): the copy
     * was refused, the credential died, the upstream is too large, the handler gave up.
     *
     * No event: §3.5 gives this epic eight dotted events and the failure that a member
     * must see (`app.fork.missing`) is the *data repository disappeared* case, which the
     * sync path owns (T26). A `failed` state is a card state, and the reason code is what
     * the card renders (FR-65).
     */
    async fail(
        workId: string,
        reason: AppReadinessFailureReason | string,
    ): Promise<AppReadinessResolution> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { found: false, state: null, emitted: false };
        }

        await this.states.update(workId, {
            readinessState: 'failed',
            readinessReason: reason,
            readinessHeartbeatAt: new Date(),
        });

        return { found: true, state: 'failed', emitted: false };
    }

    // ── §4.1 — the two manual doors ──────────────────────────────────────────

    /**
     * `POST /api/works/:id/upstream/readiness/retry` — **Try again** (FR-19).
     *
     * Order matters and is the plan's: the Work is resolved and checked first (so a
     * stranger gets `404`, never `409`), then the state is asked whether a retry means
     * anything (`preparing` and `ready` are `not_retryable` — nothing is stuck), then the
     * rolling-hour allowance is taken (the fourth call in an hour is
     * `429 retry_limit_reached`, ACC-02-05) and only then is the Work put back to
     * `preparing` and the job queued. A refusal therefore consumes no attempt.
     *
     * The retry resumes **without a new fork** (ACC-02-05, ACC-02-06): the coordinates in
     * the row are untouched, `copyPushedSha` is kept (so a private copy is not pushed
     * again), and only the clock and the reason are cleared. `readinessDispatches` is
     * reset because the automatic allowance is per attempt (FR-23).
     */
    async retryReadiness(workId: string, userId: string): Promise<AppUpstreamDispatchResult> {
        await this.requireVisibleAppWork(workId, userId);
        const state = await this.requireState(workId);

        if (state.readinessState === 'preparing' || state.readinessState === 'ready') {
            throw new AppUpstreamRefusalError(
                'not_retryable',
                409,
                'This App Work is not waiting on anything to retry.',
            );
        }

        const now = Date.now();
        const attempt = await this.states.incrementManualRetry(
            workId,
            now,
            HOUR_MS,
            APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR,
        );
        if (!attempt.allowed) {
            throw new AppUpstreamRefusalError(
                'retry_limit_reached',
                429,
                'Try again is limited to three times an hour.',
                { retryAt: retryAtIso(attempt.windowAtMs, HOUR_MS) },
            );
        }

        await this.states.update(workId, {
            readinessState: 'preparing',
            readinessReason: null,
            readinessStartedAt: new Date(now),
            readinessHeartbeatAt: new Date(now),
            readinessDispatches: 0,
        });

        const runId = await this.dispatchReadiness(workId, {
            workId,
            attempt: 1,
            reason: 'retry',
        });

        return { queued: true, runId };
    }

    /**
     * `POST /api/works/:id/upstream/sync` — **Sync now** (FR-33, FR-34).
     *
     * The refusals are plan §4.1's, in its order, and each one is a different sentence to
     * the member: a `link` App Work has no upstream at all (`422 no_upstream`, FR-44);
     * anything but `ready` means there is nothing to sync into yet (`409 not_ready`);
     * paused means the platform already knows why (`409 sync_paused` + the reason);
     * a live run means wait (`409 sync_in_progress`); the seventh call in the hour is
     * `429 sync_limit_reached` with the instant the window frees (ACC-02-14).
     *
     * **`paused` is read from the states the sync run writes, never from `nextSyncAt`.**
     * `nextSyncAt` is NULL both for a paused Work *and* for a Work whose spec turns the
     * schedule off (`plan.md:765-771`, FR-64) — and **Sync now** must still work for the
     * second (ACC-02-28) — so the pause is the recorded outcome (`lastSyncResult` =
     * `paused` with its reason) plus the three live statuses (archived, unavailable,
     * missing) that §4.1 names.
     *
     * The attempt is stamped here and `syncStartedAt` is **not**: the run itself claims
     * the Work in {@link beginSync}, and a request that stamped it would deny its own
     * run.
     */
    async requestSync(workId: string, userId: string): Promise<AppUpstreamDispatchResult> {
        await this.requireVisibleAppWork(workId, userId);
        const state = await this.requireState(workId);
        const now = Date.now();

        if (state.relation === 'link') {
            throw new AppUpstreamRefusalError(
                'no_upstream',
                422,
                'A linked App Work has no upstream to sync from.',
            );
        }

        if (state.readinessState !== 'ready') {
            throw new AppUpstreamRefusalError(
                'not_ready',
                409,
                'The App Work repository is not ready to sync yet.',
            );
        }

        const paused = await this.pauseReasonOf(state, now);
        if (paused) {
            throw new AppUpstreamRefusalError(
                'sync_paused',
                409,
                'Sync is paused for this App Work.',
                {
                    reason: paused.reason,
                    ...(paused.retryAt ? { retryAt: paused.retryAt } : {}),
                },
            );
        }

        if (await this.syncInProgress(workId, state, now)) {
            throw new AppUpstreamRefusalError(
                'sync_in_progress',
                409,
                'A sync is already running for this App Work.',
            );
        }

        const attempt = await this.states.incrementManualSync(
            workId,
            now,
            HOUR_MS,
            APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
        );
        if (!attempt.allowed) {
            throw new AppUpstreamRefusalError(
                'sync_limit_reached',
                429,
                'Sync now is limited to six times an hour.',
                { retryAt: retryAtIso(attempt.windowAtMs, HOUR_MS) },
            );
        }

        const runId = await this.dispatchSync(workId, { workId, trigger: 'manual' });
        return { queued: true, runId };
    }

    // ── §6.3 — the sync run's two state transitions ──────────────────────────

    /**
     * Step 2 of the sync run (`plan.md:721-722`): claim the Work, or tell the run to
     * stop before it has made a single provider call.
     *
     * The run is allowed for `ready` **and** `waiting_for_setup_pr` — deliberately wider
     * than {@link requestSync}'s `not_ready` gate, because those two sentences are about
     * different things: the member's button may only be offered on a finished setup, while
     * a Work whose setup pull request is still open is perfectly able to receive upstream
     * commits (that is what S1b's "ready once it is merged" follows). `link` is refused
     * here too, because a schedule or a divergence dispatch can reach a linked Work even
     * though the button cannot.
     *
     * The claim is the row's own running window (`syncStartedAt` after `syncFinishedAt`
     * and inside {@link APP_UPSTREAM_SYNC_LOCK_TTL_MS}), which is the only claim the
     * columns of §3.1 can express: T26 plans a `syncLeaseUntil` column for an atomic
     * conditional update, and until that column exists this is what keeps two jobs apart.
     * The lock is released by {@link finishSync}; a run that dies without finishing leaves
     * the row claimed for at most the TTL, which is the same ceiling the plan gives a
     * crashed dispatch (`plan.md:809-810`).
     *
     * Denials are **answers, not exceptions**: the worker maps `allowed: false` to
     * `skipped`/`paused` with the reason (§6.3 steps 1-2) and a throw across the remote
     * proxy would surface as a failed run.
     */
    async beginSync(workId: string, trigger: AppUpstreamSyncTrigger): Promise<AppSyncBeginResult> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { allowed: false, reason: 'not_found', startedAt: null };
        }
        if (state.relation === 'link') {
            return { allowed: false, reason: 'no_upstream', startedAt: null };
        }
        if (state.readinessState !== 'ready' && state.readinessState !== 'waiting_for_setup_pr') {
            return { allowed: false, reason: 'not_ready', startedAt: null };
        }

        const now = Date.now();
        if (
            this.runningSince(state) !== null &&
            now - (state.syncStartedAt as Date).getTime() < APP_UPSTREAM_SYNC_LOCK_TTL_MS
        ) {
            return { allowed: false, reason: 'sync_in_progress', startedAt: null };
        }

        const startedAt = new Date(now);
        await this.states.update(workId, { syncStartedAt: startedAt });

        this.logger.debug(`App upstream sync started for work ${workId} (trigger: ${trigger}).`);

        return { allowed: true, reason: null, startedAt: startedAt.toISOString() };
    }

    /**
     * Step 8 of the sync run (`plan.md:749-752`): record how the run ended, and emit
     * `app.upstream.synced` for the outcomes in which upstream actually landed —
     * a fast-forward or one of the two pull-request results — with
     * `{ result, commits, fromSha, toSha, pullRequestNumber? }`.
     *
     * **Emitted once per run**, where "the run" is identified by the outcome it recorded:
     * a repeat call carrying the same result, the same head and the same commit count is
     * the same outcome arriving twice (a retried proxy hop, a re-delivered job) and writes
     * no second Activity entry. A genuinely new run always differs in at least one of
     * those — the upstream head moved, or the result changed from `pull_request_opened`
     * to `pull_request_updated`.
     *
     * The two follow-ups §6.3 step 8 hangs off "the tracked branch changed" — the licence
     * request (`AppLicenseService.request(workId, 'upstream_synced')`, FR-37) and the
     * Actions hygiene pass (`AppActionsHygieneService.apply`, FR-25) — are **not** called
     * here: both belong to the worker's run (T26) and neither service exists in this task.
     * The flag is echoed in {@link AppSyncFinishResult} so the caller cannot forget it.
     *
     * `consecutiveRateLimited` is reset by every ordinary run and incremented by a
     * rate-limited one (FR-52), and `nextSyncAt` is taken from the caller when it passes
     * one (T26's schedule helper, §6.4) and left alone otherwise — the pause path passes
     * an explicit `null` to clear it.
     */
    async finishSync(workId: string, input: AppSyncFinishInput): Promise<AppSyncFinishResult> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { found: false, emitted: false, duplicate: false, trackedBranchChanged: false };
        }

        const now = new Date();
        const commits = input.commits ?? null;
        const toSha = input.toSha ?? null;
        const pullRequestNumber = input.pullRequestNumber ?? null;

        const duplicate =
            state.lastSyncResult === input.result &&
            (state.lastSyncCommitCount ?? null) === commits &&
            (state.lastSyncedUpstreamSha ?? null) === toSha &&
            (state.syncPullRequestNumber ?? null) === pullRequestNumber;

        const patch: WorkUpstreamStatePatch = {
            lastSyncResult: input.result,
            lastSyncReason: input.reason ?? null,
            lastSyncCommitCount: commits,
            lastSyncedUpstreamSha: toSha,
            syncFinishedAt: now,
            consecutiveRateLimited: input.rateLimited ? (state.consecutiveRateLimited ?? 0) + 1 : 0,
        };

        if (input.pullRequestNumber !== undefined) {
            patch.syncPullRequestNumber = input.pullRequestNumber;
        }
        if (input.pullRequestUrl !== undefined) {
            patch.syncPullRequestUrl = input.pullRequestUrl;
        }
        if (input.pullRequestClosedHeadSha !== undefined) {
            patch.syncPullRequestClosedHeadSha = input.pullRequestClosedHeadSha;
        }
        if (input.rateLimitedUntil !== undefined) {
            patch.rateLimitedUntil = toDate(input.rateLimitedUntil);
        }
        if (input.nextSyncAt !== undefined) {
            patch.nextSyncAt = toDate(input.nextSyncAt);
        }

        await this.states.update(workId, patch);

        const emitEvent = SYNCED_EVENT_RESULTS.has(input.result) && !duplicate;
        if (emitEvent) {
            await this.emit(workId, {
                actionType: ActivityActionType.APP_UPSTREAM,
                action: 'app.upstream.synced',
                status: ActivityStatus.COMPLETED,
                summary: 'Upstream synced',
                details: {
                    result: input.result,
                    commits,
                    fromSha: input.fromSha ?? null,
                    toSha,
                    pullRequestNumber,
                },
            });
        }

        return {
            found: true,
            emitted: emitEvent,
            duplicate,
            trackedBranchChanged: input.trackedBranchChanged === true,
        };
    }

    // ── §6.5 — the conflict Task ─────────────────────────────────────────────

    /**
     * The conflict Task (FR-38, ACC-02-11, Resolution **R-21**).
     *
     * Three rules, and each one is a clause of the spec rather than a convenience:
     *
     *   1. **One Task per App Work, ever.** The Task carries the label
     *      `app-upstream-conflict:<workId>` and is looked up among the **five open
     *      statuses** of §6.5 — the board's seven minus `done` and `cancelled`. A Task the
     *      member already finished is not the open conflict Task: its status says the
     *      conflict was dealt with, so a new conflict files a new Task rather than
     *      reopening a closed one. (The label filter is the repository's existing
     *      case-insensitive JSON-token match — `TaskRepository.findByUserIdFiltered`.)
     *   2. **A later conflict comments on the open Task, never duplicates it** (S24). The
     *      comment goes through the Task page's own chat service, written as the Work's
     *      owner (there is no system actor), and its body is passed through
     *      {@link withoutMentions} — the chat service fans out **one agent run per
     *      `@<slug>` mention** and this epic starts none.
     *   3. **The Agent is APW-08's decision, not this epic's** (R-21). The resolver is
     *      asked `resolve({ userId: ownerUserId, workId })` and its `agentId` is used
     *      verbatim; unbound, `null` or throwing all mean the Task stays unassigned and the
     *      owner gets **exactly one** notification. `AgentRepository.findByUserIdScoped`
     *      is never called here and no fallback Agent is ever chosen — a Task quietly
     *      handed to the wrong Agent is worse than one waiting for a person.
     *
     * The Task never carries an `allowAgentMerge`-style override and nothing here starts
     * a run: the merge policy governs whatever pull request the Task later produces
     * (`plan.md:798`).
     *
     * **The Task lives in the Work's own workspace** (AW-1). The lookup, the new Task and
     * the comment are all bounded by `ownershipScopeOf(work)`, the way a system-filed Task
     * inherits its parent's scope elsewhere (`GoalOrchestratorService` files a Goal's
     * iteration Tasks under `ownershipScopeOf(goal)`). It cannot be left to the
     * scope-stamping subscriber: this method is reached from the Trigger worker through
     * the remote proxy, whose request carries no workspace, so an unscoped Task was
     * stamped null/null — invisible on an org-scoped Work's board and behind the Upstream
     * card's "resolve conflict" link.
     */
    async recordConflict(workId: string, input: AppConflictInput): Promise<AppConflictResult> {
        const state = await this.requireState(workId);
        const work = await this.loadWork(workId);
        const ownerUserId = work?.userId ?? null;

        if (!work || !ownerUserId) {
            // No Work ⇒ no owner ⇒ nowhere to file a Task and nobody to tell. The event is
            // still recorded, because the conflict itself is a fact about the App Work.
            await this.emit(workId, {
                actionType: ActivityActionType.APP_UPSTREAM,
                action: 'app.upstream.conflict',
                status: ActivityStatus.COMPLETED,
                summary: 'An upstream sync needs conflict resolution',
                details: {
                    pullRequestNumber: input.pr?.number ?? null,
                    taskId: null,
                    commits: input.commits ?? null,
                },
            });
            return { taskId: null, created: false, commented: false, agentId: null, paths: [] };
        }

        const paths = await this.conflictPaths(state, input);
        const label = conflictLabel(workId);
        const scope = ownershipScopeOf(work);

        const open = await this.findOpenConflictTask(ownerUserId, workId, label, scope);
        if (open) {
            await this.commentOnConflictTask(open, ownerUserId, input, scope);
            if (state.conflictTaskId !== open.id) {
                await this.states.update(workId, { conflictTaskId: open.id });
            }
            await this.emitConflict(workId, input, open.id);

            return {
                taskId: open.id,
                created: false,
                commented: true,
                agentId: open.agentId ?? null,
                paths,
            };
        }

        const agentId = await this.resolveConflictAgent(ownerUserId, workId);
        const task = await this.createConflictTask({
            ownerUserId,
            workId,
            state,
            input,
            paths,
            label,
            agentId,
            scope,
        });

        if (task) {
            await this.states.update(workId, { conflictTaskId: task.id });
            if (agentId === null) {
                await this.notifyOwnerWithoutAgent(ownerUserId, workId, task);
            }
        }

        await this.emitConflict(workId, input, task?.id ?? null);

        return {
            taskId: task?.id ?? null,
            created: task !== null,
            commented: false,
            agentId,
            paths,
        };
    }

    // ── internals: the Work, the row, and the two 404s ───────────────────────

    /**
     * The Work behind one request, or `404 not_found`.
     *
     * "Visible" is the Work's owner or one of its members, and the answer is identical
     * for a Work that does not exist, one that is not kind `app` and one that belongs to
     * somebody else — so this route can never be used to discover whose Work is whose
     * (ACC-02-21, FR-56). An unbound `WorkRepository` (or `WorkMemberRepository`) fails
     * closed: nothing is visible, so every request answers `404`.
     */
    private async requireVisibleAppWork(workId: string, userId: string): Promise<Work> {
        const work = await this.loadWork(workId);
        if (!work || !isAppWorkKind(work.kind) || !isUuid(workId)) {
            throw notFound();
        }

        if (work.userId === userId) {
            return work;
        }

        const member = this.workMembers
            ? await this.workMembers.isMember(workId, userId).catch(() => false)
            : false;
        if (!member) {
            throw notFound();
        }

        return work;
    }

    /** The state row of one App Work, or `404 not_found` — there is nothing to report. */
    private async requireState(workId: string): Promise<WorkUpstreamState> {
        const state = isUuid(workId) ? await this.states.findByWorkId(workId) : null;
        if (!state) {
            throw notFound();
        }
        return state;
    }

    private async loadWork(workId: string): Promise<Work | null> {
        if (!this.works || !isUuid(workId)) {
            return null;
        }
        try {
            return await this.works.findByIdForAccess(workId);
        } catch (error) {
            this.logger.warn(
                `App upstream: reading work ${workId} failed (${errorText(error)}); failing closed.`,
            );
            return null;
        }
    }

    // ── internals: the response mapping ──────────────────────────────────────

    /**
     * FR-65's closed reason set, out of the free-form column.
     *
     * The row stores a 48-character reason that may be a plain member of
     * `APP_READINESS_FAILURE_REASONS` or the composed `handler_failed:<code>` of
     * `plan.md:705`; the response's `reason` is a closed union and its `handlerReason`
     * carries the provider's own code (FR-54). Anything the union does not know —
     * including the `too_large_for_private_copy` / `uses_lfs` spellings §3.1 lists and
     * §3.4's union does not contain — is reported as `handler_failed` with the stored
     * value in `handlerReason.code`, so no reason is ever silently dropped.
     */
    private readinessReasonOf(raw: string | null | undefined): {
        reason?: AppReadinessFailureReason;
        handlerReason?: { code: string; permission?: string };
    } {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) {
            return {};
        }
        const member = (APP_READINESS_FAILURE_REASONS as readonly string[]).includes(value);
        if (member && value !== 'handler_failed') {
            return { reason: value as AppReadinessFailureReason };
        }
        const code = value.startsWith('handler_failed:')
            ? value.slice('handler_failed:'.length)
            : value;
        return { reason: 'handler_failed', handlerReason: { code } };
    }

    private divergenceOf(
        state: WorkUpstreamState,
        now: number,
    ): AppUpstreamStateResponse['divergence'] {
        if (state.aheadBy == null && state.behindBy == null) {
            return null;
        }
        const computedAt = isoOf(state.divergenceComputedAt);
        if (!computedAt) {
            return null;
        }
        return {
            aheadBy: state.aheadBy ?? 0,
            behindBy: state.behindBy ?? 0,
            computedAt,
            // FR-46: a reading older than ten minutes renders with its age, and the view
            // refreshes it.
            stale: now - (state.divergenceComputedAt as Date).getTime() > APP_DIVERGENCE_TTL_MS,
        };
    }

    private syncOf(state: WorkUpstreamState, now: number): AppUpstreamStateResponse['sync'] {
        return {
            schedule: state.syncSchedule ?? null,
            nextRunAt: isoOf(state.nextSyncAt),
            running: this.runningSince(state) !== null,
            lastResult: state.lastSyncResult ?? undefined,
            lastReason: syncReasonOf(state.lastSyncReason),
            lastStartedAt: isoOf(state.syncStartedAt),
            lastFinishedAt: isoOf(state.syncFinishedAt),
            lastCommitCount: state.lastSyncCommitCount ?? undefined,
            pullRequest:
                state.syncPullRequestNumber != null && state.syncPullRequestUrl
                    ? { number: state.syncPullRequestNumber, url: state.syncPullRequestUrl }
                    : undefined,
            conflictTaskId: state.conflictTaskId ?? undefined,
            manualSyncsLeft: this.manualAttemptsLeft(
                state.manualSyncCount,
                state.manualSyncWindowAt,
                APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
                now,
            ),
            rateLimitedUntil: isoOf(state.rateLimitedUntil),
            // FR-52: three consecutive rate-limited runs make the notice persistent.
            rateLimitedPersistent: (state.consecutiveRateLimited ?? 0) >= 3,
        };
    }

    /**
     * The hygiene block. A `link` App Work is `not_applicable` (FR-31 — hygiene never
     * touches a linked repository) and is reported as such even before any run has
     * written the column, because the answer is a property of the relation, not of a job
     * having visited it.
     */
    private actionsOf(state: WorkUpstreamState): AppUpstreamStateResponse['actions'] {
        const actionsState =
            state.relation === 'link' && state.actionsState === 'pending'
                ? 'not_applicable'
                : state.actionsState;

        return {
            state: actionsState,
            disabled: (state.actionsDisabledWorkflows ?? []).map((entry) => ({ path: entry.path })),
            kept: (state.actionsKeptWorkflows ?? []).map((entry) => ({ path: entry.path })),
            checkedAt: isoOf(state.actionsCheckedAt),
        };
    }

    /**
     * Spec §6.2's twelve warnings, derived from the row, in the table's order.
     *
     * Two of the table's rows cannot be derived from the columns of §3.1 and are
     * therefore not produced here: the `{permission}` of **App permission missing**
     * (`actionsState` is stored, the permission name is not) and **Workflows gated**,
     * which has no column at all. Both are reported to the coordinator rather than
     * invented — a warning that names no permission would render a broken sentence.
     */
    private warningsOf(state: WorkUpstreamState, now: number): AppUpstreamWarning[] {
        const warnings: AppUpstreamWarning[] = [];
        const push = (code: AppUpstreamWarningCode, params?: Record<string, string>): void => {
            warnings.push(params ? { code, params } : { code });
        };

        if (state.upstreamStatus === 'archived') {
            push('upstreamArchived');
        }
        if (state.upstreamStatus === 'unavailable') {
            push('upstreamUnavailable', { repo: state.upstreamRepo ?? state.dataRepo });
        }
        if (state.dataRepositoryStatus === 'missing') {
            push(state.relation === 'private-copy' ? 'privateCopyMissing' : 'forkMissing', {
                repo: state.dataRepo,
            });
        }
        if (state.rateLimitedUntil && state.rateLimitedUntil.getTime() > now) {
            push('rateLimited', { time: state.rateLimitedUntil.toISOString() });
        }
        if (state.upstreamPreviousDefaultBranch) {
            push('defaultBranchRenamed', {
                old: state.upstreamPreviousDefaultBranch,
                new: state.upstreamDefaultBranch ?? state.dataDefaultBranch,
            });
        }
        if (state.lastSyncReason === 'too_large_for_private_copy') {
            push('privateCopyTooLarge');
        }
        if (state.lastSyncReason === 'upstream_history_rewritten') {
            push('historyRewritten');
        }
        if (state.actionsState === 'needs_admin') {
            push('needsAdmin', { repo: state.dataRepo });
        }
        if (state.actionsState === 'permission_missing') {
            push('appPermissionMissing');
        }
        if (
            state.readinessState === 'preparing' ||
            state.readinessState === 'timed_out' ||
            state.readinessState === 'failed'
        ) {
            push('notReady');
        }

        return warnings;
    }

    // ── internals: §4.1's gates ───────────────────────────────────────────────

    /**
     * Why sync is paused, or `null`. The three statuses §4.1 names come first (they are
     * the live truth), and the persisted `paused` outcome carries the reasons only the
     * run can know — too large for a private copy, and the rest of §6.3 step 4.
     */
    private async pauseReasonOf(
        state: WorkUpstreamState,
        now: number,
    ): Promise<{ reason: string; retryAt?: string } | null> {
        if (state.dataRepositoryStatus === 'missing') {
            return { reason: 'data_repository_missing' };
        }
        if (state.upstreamStatus === 'archived') {
            return { reason: 'upstream_archived' };
        }
        if (state.upstreamStatus === 'unavailable') {
            return { reason: 'upstream_unavailable' };
        }
        if (state.lastSyncResult === 'paused') {
            return { reason: state.lastSyncReason ?? 'paused' };
        }
        if (state.rateLimitedUntil && state.rateLimitedUntil.getTime() > now) {
            return { reason: 'rate_limited', retryAt: state.rateLimitedUntil.toISOString() };
        }
        return null;
    }

    /**
     * Whether a sync is already running: ask the distributed lock when it is bound (the
     * authoritative claim, `plan.md:720`), and fall back to the row's running window when
     * it is not — the same display-only signal {@link beginSync} claims with.
     */
    private async syncInProgress(
        workId: string,
        state: WorkUpstreamState,
        now: number,
    ): Promise<boolean> {
        if (this.locks) {
            try {
                if (await this.locks.isLocked(upstreamSyncLockKey(workId))) {
                    return true;
                }
            } catch (error) {
                this.logger.warn(
                    `App upstream: the sync lock read failed for work ${workId} (${errorText(error)}); falling back to the recorded run window.`,
                );
            }
        }

        const since = this.runningSince(state);
        return since !== null && now - since < APP_UPSTREAM_SYNC_LOCK_TTL_MS;
    }

    /** When the run recorded in the row started, or `null` when nothing is running. */
    private runningSince(state: WorkUpstreamState): number | null {
        if (!state.syncStartedAt) {
            return null;
        }
        const startedAt = state.syncStartedAt.getTime();
        if (state.syncFinishedAt && state.syncFinishedAt.getTime() >= startedAt) {
            return null;
        }
        return startedAt;
    }

    /** FR-19 / FR-33: how many manual attempts are left in the current rolling hour. */
    private manualAttemptsLeft(
        count: number | null | undefined,
        windowAt: Date | null | undefined,
        max: number,
        now: number,
    ): number {
        const used = windowAt && now - windowAt.getTime() < HOUR_MS ? (count ?? 0) : 0;
        return Math.max(0, max - used);
    }

    // ── internals: §6.5 ─────────────────────────────────────────────────────

    /**
     * The conflicting paths, capped at {@link APP_UPSTREAM_CONFLICT_MAX_PATHS}.
     *
     * The caller's list wins (the sync run computes it from the merge base, §6.5 step 3);
     * when it passes none, the pull request's changed files are read here so the Task's
     * description is never empty. A read that fails yields no paths rather than no Task:
     * the conflict still needs a person.
     */
    private async conflictPaths(
        state: WorkUpstreamState,
        input: AppConflictInput,
    ): Promise<string[]> {
        const given = (input.paths ?? []).filter(
            (path) => typeof path === 'string' && path.length > 0,
        );
        if (given.length > 0) {
            return given.slice(0, APP_UPSTREAM_CONFLICT_MAX_PATHS);
        }

        const number = input.pr?.number;
        const work = await this.loadWork(state.workId);
        if (!number || !this.git || !work) {
            return [];
        }

        try {
            const files = await this.git.getPullRequestFiles(
                state.dataOwner,
                state.dataRepo,
                number,
                { userId: work.userId, providerId: APP_WORK_GIT_PROVIDER_ID, workId: state.workId },
            );
            return files
                .map((file) => file?.filename)
                .filter((path): path is string => typeof path === 'string' && path.length > 0)
                .slice(0, APP_UPSTREAM_CONFLICT_MAX_PATHS);
        } catch (error) {
            this.logger.warn(
                `App upstream: reading the changed files of pull request ${number} failed (${errorText(error)}); filing the conflict Task without paths.`,
            );
            return [];
        }
    }

    /**
     * The one open labelled Task of the Work, or `null` (FR-38, §6.5 step 1).
     *
     * Bounded by the Work's scope (AW-1), so a labelled Task stamped outside it — the
     * null/null row an org-scoped Work's conflict used to get, reachable from no
     * workspace — is not the one a new conflict comments on; a Task the member can
     * actually open is filed instead.
     */
    private async findOpenConflictTask(
        ownerUserId: string,
        workId: string,
        label: string,
        scope: OwnershipScope,
    ): Promise<Task | null> {
        if (!this.taskRepository) {
            return null;
        }
        try {
            const { rows } = await this.taskRepository.findByUserIdFiltered(
                ownerUserId,
                {
                    workId,
                    label,
                    status: [...OPEN_CONFLICT_TASK_STATUSES],
                },
                scope,
            );
            return rows?.[0] ?? null;
        } catch (error) {
            this.logger.warn(
                `App upstream: looking up the open conflict Task of work ${workId} failed (${errorText(error)}); a new Task will be filed.`,
            );
            return null;
        }
    }

    /**
     * The update comment (S24, §6.5 step 1): posted through the Task page's own chat
     * service, written by the Work's owner as the acting user, with a body that contains
     * no `@`.
     *
     * The `@` rule is not cosmetic. `TaskChatService.post` parses `@<slug>` mentions
     * server-side and fans out one agent-chat-reply run per resolved Agent mention — and
     * this epic starts no run: a conflict is the member's decision (spec §7, D11). The
     * body of §6.3 contains no `@` by construction, and {@link withoutMentions} keeps that
     * true if the copy ever grows an interpolated field. No mention lookups are passed
     * either, so nothing could resolve even if one slipped through.
     *
     * The Task is re-read through the Work's scope (AW-1) — the same one it was found in.
     */
    private async commentOnConflictTask(
        task: Task,
        ownerUserId: string,
        input: AppConflictInput,
        scope: OwnershipScope,
    ): Promise<void> {
        if (!this.taskChat) {
            return;
        }
        try {
            await this.taskChat.post(
                ownerUserId,
                {
                    taskId: task.id,
                    authorType: 'user',
                    authorId: ownerUserId,
                    body: withoutMentions(conflictComment(input)),
                },
                {},
                scope,
            );
        } catch (error) {
            this.logger.warn(
                `App upstream: commenting on conflict Task ${task.id} failed (${errorText(error)}); the Task is unchanged.`,
            );
        }
    }

    /**
     * **The Agent, from APW-08's rule and nowhere else** (R-21, `plan.md:790-794`).
     *
     * Unbound, `null`, a throw and a malformed answer are the same outcome: no Agent, and
     * the caller notifies the owner once. Nothing here falls back to a lookup of this
     * epic's own — that is the whole point of R-21, and it is why
     * `git grep findByUserIdScoped packages/agent/src/app-works` must stay empty.
     */
    private async resolveConflictAgent(
        ownerUserId: string,
        workId: string,
    ): Promise<string | null> {
        const resolver = this.agentResolver;
        if (!resolver || typeof resolver.resolve !== 'function') {
            return null;
        }
        try {
            const answer = await resolver.resolve({ userId: ownerUserId, workId });
            const agentId = answer?.agentId;
            return typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
        } catch (error) {
            this.logger.warn(
                `App upstream: the Agent resolver failed for work ${workId} (${errorText(error)}); the conflict Task stays unassigned.`,
            );
            return null;
        }
    }

    /**
     * The Task itself — same title, label and description whatever the Agent answer was.
     *
     * Filed in the Work's scope (AW-1). `TasksService.create` checks every owner pointer
     * against that scope, so an Agent the resolver answers must live in the Work's
     * workspace too; one that does not is refused there (and logged below) rather than
     * attached across workspaces.
     */
    private async createConflictTask(input: {
        ownerUserId: string;
        workId: string;
        state: WorkUpstreamState;
        input: AppConflictInput;
        paths: string[];
        label: string;
        agentId: string | null;
        scope: OwnershipScope;
    }): Promise<Task | null> {
        if (!this.tasks) {
            this.logger.warn(
                `App upstream: no TasksService is bound, so the conflict on work ${input.workId} was recorded without a Task.`,
            );
            return null;
        }

        try {
            return await this.tasks.create(
                input.ownerUserId,
                {
                    title: conflictTitle(input.state),
                    description: conflictDescription(input.state, input.input, input.paths),
                    labels: [input.label],
                    workId: input.workId,
                    agentId: input.agentId,
                    // There is no system actor (plan §6.5 step 1): the Task is filed as the
                    // Work's owner, exactly like the comment on the open one.
                    createdByType: 'user',
                    createdById: input.ownerUserId,
                },
                input.scope,
            );
        } catch (error) {
            this.logger.warn(
                `App upstream: creating the conflict Task for work ${input.workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * The one owner notification when no Agent resolved (R-21, §6.5 step 2).
     *
     * Sent from inside the "a Task was just created" branch and with **no deduplication
     * key**: a dedup key would silently swallow the notice for the *next* conflict — a
     * different Task, a different pull request, the same person — while a retry of the
     * same conflict cannot reach here at all, because by then the open Task exists and
     * the comment path is taken.
     *
     * `metadata.code` carries APW-08's copy key (`appRules.noAgentResolved`, APW-08 plan
     * §2.8) so the card can render its own translation of the same fact.
     *
     * No workspace scope is passed: notifications are listed per user, never filtered by
     * workspace, so the owner sees this one wherever they are; the link is the unprefixed
     * `/tasks/<id>` every Task notification uses.
     */
    private async notifyOwnerWithoutAgent(
        ownerUserId: string,
        workId: string,
        task: Task,
    ): Promise<void> {
        if (!this.notifications) {
            this.logger.warn(
                `App upstream: no NotificationService is bound, so the owner was not told that conflict Task ${task.id} is unassigned.`,
            );
            return;
        }

        try {
            await this.notifications.create({
                userId: ownerUserId,
                type: NotificationType.WARNING,
                category: NotificationCategory.TASK,
                title: 'Upstream sync needs an Agent',
                message:
                    'A sync conflict was filed on your App Work, but no Agent could be resolved for it. The Task is unassigned until you pick one.',
                actionUrl: `/tasks/${task.id}`,
                actionLabel: 'Open the Task',
                metadata: {
                    code: 'appRules.noAgentResolved',
                    workId,
                    taskId: task.id,
                },
            });
        } catch (error) {
            this.logger.warn(
                `App upstream: notifying the owner about unassigned Task ${task.id} failed (${errorText(error)}).`,
            );
        }
    }

    // ── internals: events, dispatch, failure classification ─────────────────

    /**
     * One Activity row, in the shape §3.5 fixes: the snake_case family in `actionType`
     * and the dotted CONTRACTS §6 event in `action`, with counts, shas, pull request
     * numbers and reason codes in `details` — never a token, never a body.
     *
     * The row belongs to the Work's owner, because there is no system actor (plan §6.5
     * step 1) and the Activity feed is the owner's. An unbound `ActivityLogService` (a
     * module that forgot `DatabaseModule`) is logged loudly and otherwise ignored: a
     * missing feed entry must not fail the state transition it describes.
     *
     * The row is stamped with the Work's own tenant and Organization (AW-1), because the
     * feed is scope-filtered and several of these transitions run from the Trigger worker,
     * whose proxied request carries no workspace for the stamping subscriber to copy.
     */
    private async emit(
        workId: string,
        entry: Pick<
            CreateActivityLogDto,
            'actionType' | 'action' | 'status' | 'summary' | 'details'
        >,
    ): Promise<void> {
        const work = await this.loadWork(workId);
        const userId = work?.userId;
        if (!work || !userId || !this.activity) {
            this.logger.warn(
                `App upstream: ${entry.action} for work ${workId} was not recorded (no owner or no ActivityLogService).`,
            );
            return;
        }

        try {
            const scope = ownershipScopeOf(work);
            await this.activity.log({
                userId,
                workId,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                actionType: entry.actionType,
                action: entry.action,
                status: entry.status,
                summary: entry.summary,
                details: entry.details,
            });
        } catch (error) {
            this.logger.warn(
                `App upstream: recording ${entry.action} for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private async emitConflict(
        workId: string,
        input: AppConflictInput,
        taskId: string | null,
    ): Promise<void> {
        await this.emit(workId, {
            actionType: ActivityActionType.APP_UPSTREAM,
            action: 'app.upstream.conflict',
            status: ActivityStatus.COMPLETED,
            summary: 'An upstream sync needs conflict resolution',
            details: {
                pullRequestNumber: input.pr?.number ?? null,
                taskId,
                commits: input.commits ?? null,
            },
        });
    }

    /**
     * Queue the readiness job. The dispatcher token is unbound until T31 lands (the class
     * doc's provisional seams), and the `202` body of §4.1 is what makes that survivable:
     * `queued: true, runId: null` is an accepted attempt the platform could not hand to a
     * runner, which is exactly the truth.
     */
    private async dispatchReadiness(
        workId: string,
        payload: AppForkReadinessJobPayload,
    ): Promise<string | null> {
        if (!this.readinessDispatcher) {
            this.logger.warn(
                `App upstream: no readiness dispatcher is bound, so work ${workId} was not queued.`,
            );
            return null;
        }
        try {
            return (await this.readinessDispatcher.dispatch(payload)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App upstream: dispatching the readiness job for work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** Queue the sync job — same shape, same fail-closed answer as {@link dispatchReadiness}. */
    private async dispatchSync(
        workId: string,
        payload: AppUpstreamSyncJobPayload,
    ): Promise<string | null> {
        if (!this.syncDispatcher) {
            this.logger.warn(
                `App upstream: no sync dispatcher is bound, so work ${workId} was not queued.`,
            );
            return null;
        }
        try {
            return (await this.syncDispatcher.dispatch(payload)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App upstream: dispatching the sync job for work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * One failed provider read, classified by the typed reason APW-02's plugin work
     * introduced (`GitProviderRequestError`, plan §4.2) — never by reading the provider's
     * prose here, and never by letting a message reach the member (FR-65).
     */
    private classifyProbeFailure(error: unknown): AppReadinessProbe {
        if (error instanceof NoGitCredentialsError || providerReasonOf(error) === 'unauthorized') {
            return { status: 'access_revoked', empty: null, reason: 'access_revoked' };
        }

        const reason = providerReasonOf(error);
        if (reason === 'rate_limited' || reason === 'secondary_rate_limited') {
            return {
                status: 'rate_limited',
                empty: null,
                reason,
                retryAt: providerRetryAtOf(error),
            };
        }

        return { status: 'failed', empty: null, reason: reason ?? 'provider_error' };
    }
}

// ── pure helpers (module scope: no `this`, no I/O) ───────────────────────────

/**
 * `404 not_found` — the ONE answer for a Work that is missing, not kind `app`, not the
 * caller's, or has no state row yet (ACC-02-21). One factory, so no door can drift into
 * telling a stranger which of those it was.
 */
function notFound(): AppUpstreamRefusalError {
    return new AppUpstreamRefusalError('not_found', 404, 'No such App Work.');
}

/** The label that ties the conflict Task to its App Work (`plan.md:777`). */
function conflictLabel(workId: string): string {
    return `${APP_UPSTREAM_CONFLICT_LABEL_PREFIX}${workId}`;
}

/** Spec §6.3's title row. */
function conflictTitle(state: WorkUpstreamState): string {
    return `Resolve upstream sync conflicts in ${state.dataRepo}`;
}

/**
 * Spec §6.3's description row: what moved, where the pull request is, the paths that
 * conflict (up to {@link APP_UPSTREAM_CONFLICT_MAX_PATHS}) and the one instruction that
 * matters — resolve on the sync branch, never merge into the tracked branch directly.
 */
function conflictDescription(
    state: WorkUpstreamState,
    input: AppConflictInput,
    paths: readonly string[],
): string {
    const upstream =
        state.upstreamOwner && state.upstreamRepo
            ? `${state.upstreamOwner}/${state.upstreamRepo}`
            : `${state.dataOwner}/${state.dataRepo}`;
    const pullRequestUrl = input.pr?.url ?? state.syncPullRequestUrl ?? '';
    const head = [
        `Upstream ${upstream} moved from ${shortSha(input.fromSha)} to ${shortSha(input.toSha)} (${input.commits ?? 0} commits).`,
        `The sync pull request ${pullRequestUrl} can't merge because these files conflict:`,
        ...paths,
        `Resolve the conflicts on ${APP_UPSTREAM_SYNC_BRANCH} and push. Don't merge into ${state.dataDefaultBranch} directly.`,
    ];

    return head.join('\n');
}

/** Spec §6.3's comment-on-update row. */
function conflictComment(input: AppConflictInput): string {
    return `Upstream moved again: now ${shortSha(input.toSha)} (${input.commits ?? 0} commits since the last sync).`;
}

/**
 * The `@`-free guarantee of {@link AppUpstreamStateService.recordConflict}'s comment.
 *
 * The chat service turns every `@<slug>` in a posted body into an agent run; this path
 * must start none, so the body is stripped of the character that could start one. The
 * §6.3 copy contains none, which makes this a no-op today and the guarantee tomorrow —
 * if the copy ever interpolates a repository name, a branch or a member's login, a
 * mention still cannot be forged from it.
 */
function withoutMentions(body: string): string {
    return body.split('@').join('');
}

/** The provider's typed reason, duck-typed so it survives a bundle boundary. */
function providerReasonOf(error: unknown): string | undefined {
    if (error instanceof GitProviderRequestError) {
        return error.reason;
    }
    const reason = (error as { reason?: unknown } | null)?.reason;
    const status = (error as { status?: unknown } | null)?.status;
    return typeof reason === 'string' && typeof status === 'number' ? reason : undefined;
}

/** The instant a rate-limited read may be retried, from the typed error's details. */
function providerRetryAtOf(error: unknown): string | undefined {
    const retryAt = (error as { details?: { retryAt?: unknown } } | null)?.details?.retryAt;
    return typeof retryAt === 'string' && retryAt.length > 0 ? retryAt : undefined;
}

/** The public web address of a repository. */
function repositoryWebUrl(owner: string, repo: string): string {
    return `https://github.com/${owner}/${repo}`;
}

/** A `Date` column as ISO-8601, or `undefined`. */
function isoOf(value: Date | null | undefined): string | undefined {
    return value instanceof Date ? value.toISOString() : undefined;
}

/** A stored reason for a failed handler outcome (`plan.md:705`). */
function handlerFailureReason(reason: string | undefined): string {
    const code = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'unknown';
    return `handler_failed:${code}`;
}

/** `null` / a `Date` / an ISO string / epoch ms, as a `Date` (or `null`). */
function toDate(value: Date | string | number | null): Date | null {
    if (value === null) {
        return null;
    }
    if (value instanceof Date) {
        return value;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** The first seven characters of a sha, or `unknown` when there is none. */
function shortSha(sha: string | null | undefined): string {
    return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : 'unknown';
}

/** When a rolling window frees, as ISO-8601. */
function retryAtIso(windowAtMs: number | null, windowMs: number): string {
    const base = typeof windowAtMs === 'number' ? windowAtMs : Date.now();
    return new Date(base + windowMs).toISOString();
}

/** A uuid, loosely — the repositories' own keys are uuids, and a bad one is a 404, not a query. */
function isUuid(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    );
}

/** A caught value as a log-safe line. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a repository has content yet (FR-17, FR-22).
 *
 * `empty === false` is the plan's own signal (`plan.md:681`) — the provider probed the
 * default branch and it answers. The second clause exists because the GitHub plugin
 * computes `empty` **only when `size === 0`** (`packages/plugins/github/src/github-api.service.ts:685`):
 * a repository with any content reports `empty` as *absent*, and a readiness check that
 * insisted on `false` would poll every ordinary fork until it timed out. A reported size
 * above zero IS "there is a commit here", so that case is ready; a repository that
 * reports neither is left `preparing`, because "the provider told me nothing" is not
 * "your fork is ready".
 */
function isRepositoryNonEmpty(repository: { empty?: boolean; sizeKb?: number }): boolean {
    if (repository.empty === false) {
        return true;
    }
    if (repository.empty === true) {
        return false;
    }
    return (repository.sizeKb ?? 0) > 0;
}

/** A stored sync reason as the response's closed union (FR-65), or `undefined`. */
function syncReasonOf(raw: string | null | undefined): AppSyncReason | undefined {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        return undefined;
    }
    // An unrecognised value is DROPPED rather than mapped onto a member it is not: the
    // closed set of FR-65 must never be widened by a read, and `sync_paused`'s details and
    // the §6.2 warnings still carry the free-form reason. (The plan's own examples are not
    // all members — §6.3 step 4's `too_large_for_private_copy` is not in
    // `APP_SYNC_REASONS` — which is reported, not papered over here.)
    return (APP_SYNC_REASONS as readonly string[]).includes(value)
        ? (value as AppSyncReason)
        : undefined;
}
