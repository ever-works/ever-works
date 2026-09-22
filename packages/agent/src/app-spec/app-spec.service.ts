import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    APP_SPEC_LAZY_HEAD_CHECK_MS,
    APP_SOURCE_SPEC_FILE,
    APP_SOURCE_REPOSITORY_TYPE_BY_MODE,
    isSourceOnlyAppSpec,
    type AppRepositoryMode,
    type AppSpec,
    type AppSpecEvaluationTrigger,
    type AppSpecIssue,
    type AppSpecSourceRelation,
    type AppSpecValidationStatus,
} from '@ever-works/contracts';
import { parse as parseYaml } from 'yaml';
import { WorkAppSpecState } from '../entities/work-app-spec-state.entity';
import {
    WorkAppSpecStateRepository,
    type AppSpecEvaluationResult,
    type WorkAppSpecStateScope,
} from '../database/repositories/work-app-spec-state.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import { APP_WORK_GIT_PROVIDER_ID } from '../app-works/app-upstream-state.service';
import {
    APP_SPEC_EVALUATE_DISPATCHER,
    type AppSpecEvaluateDispatcher,
} from '../tasks/app-spec-evaluate-dispatcher';
import {
    APP_SPEC_EVALUATE_JOB_ID,
    hasInProcessFallback,
    runAppSpecEvaluateJob,
} from '../tasks/app-works-jobs';
import type { AppSpecEvaluatePayload } from '../tasks/app-spec-evaluate.types';
import {
    validateAppSpecDocument,
    type AppSpecValidationResult,
    type RuleContext,
} from '../works-config/schema/app-spec.validate';
import { hashAppSpec, appSpecHashesEqual } from './app-spec-hash';
import { diffGuardedSpecBlocks } from './app-spec-guarded-blocks';

/**
 * APW-03 T12 — `AppSpecService`: the App spec read true.
 *
 * Plan §2.3 (`plan.md:168-201`) is the normative flow; FR-15…FR-26 are the
 * requirements it satisfies; ACC-03-09…ACC-03-15 and ACC-03-57 are the
 * acceptance ids it is tested against.
 *
 * ```
 * requestEvaluation ─► requestedSeq++ · coalesce ─► APP_SPEC_EVALUATE_DISPATCHER
 *                                                       │ (null ⇒ run here)
 * evaluate ─► runExclusive('app-spec-evaluate:<workId>')
 *          ─► markStarted (startedSeq = requestedSeq — the NEWEST request)
 *          ─► getLatestCommit(trackedBranch) → getFileContent(.works/works.yml, sha)
 *          ─► validateAppSpecDocument(text, { mode: 'data-repository' })
 *          ─► writeEvaluation(seq)   // guarded by evaluatedSeq < :seq
 *          ─► Activity (only on a head-hash change) · AppSpecAppliedEvent (only
 *             on an effective-hash change)
 * ```
 *
 * ## The four rules this class exists to keep
 *
 * 1. **Only a zero-error evaluation becomes the effective spec** (FR-20), and an
 *    invalid, missing or unreadable head **keeps** the previous one (ACC-03-10).
 *    The repository's "absent field leaves its column untouched" contract is what
 *    makes that true, so this class simply never passes an effective field on a
 *    head it did not accept.
 * 2. **An older evaluation never overwrites a newer result** (FR-22, ACC-03-12).
 *    Every write goes through `writeEvaluation(workId, seq, …)`, whose guard is
 *    `evaluatedSeq < :seq`, and **nothing is emitted unless that write won** — a
 *    job that lost the race records no Activity and emits no event, because the
 *    state it would describe is not the state that was stored.
 * 3. **The "spec applied" event fires once per effective-hash transition**
 *    (FR-21). Both the head-hash Activity and the applied event are computed
 *    against the row read *before* the write, and are emitted *after* it wins —
 *    so a re-delivery, a coalesced trigger, a retry or a second pass over
 *    identical content emits nothing.
 * 4. **The tracked branch moves only towards itself** (FR-16): a head may declare
 *    `source.branch`; that branch is adopted only when it exists, validates with
 *    zero errors and declares the same branch. Otherwise the move is refused and
 *    `lastEvaluationError: 'tracked_branch_missing'` records why.
 *
 * ## Every collaborator that is not this epic's is `@Optional()`
 *
 * The epic's established pattern (`app-env.service.ts`, `app-dependencies.service.ts`,
 * `app-runtime/ports.ts`): a lean module graph that provides the service without
 * one of its collaborators must still bootstrap, and each absence is a **named
 * answer** — never a silent success. `states` and `git` are the two the service
 * cannot do anything without, so they are required and the module provides them;
 * the lock, the Work row, the Activity log, the event bus and the dispatcher are
 * optional and each absence has a documented consequence.
 *
 * ## What this class deliberately does NOT do
 *
 * - **It never writes on a read.** `getEffectiveSpec`, `validateDraft`,
 *   `getState` and `hasValidAppSpec` are reads: no state write, no Activity, no
 *   event. `getEffectiveSpec` therefore does **not** persist the rebuild of the
 *   `effectiveSpec` cache when the column is empty (plan §3.1:419 sanctions a
 *   write there); it rebuilds the value in memory and returns it, because a read
 *   path that writes would race the evaluation job's guarded write and could
 *   emit nothing useful. The column is refilled by the next evaluation, which
 *   always carries `effectiveSpec` when the head is valid.
 * - **It emits no telemetry.** Plan §9.1 declares `APP_SPEC_TELEMETRY_SINK` in
 *   `packages/agent/src/app-spec/app-spec-telemetry.port.ts`; that port is not in
 *   T12's file list (T49 binds it in `apps/api`), so `app.spec.evaluated` is not
 *   emitted yet. See this task's report — routed, not forgotten.
 * - **It does not touch the licence.** The licence-relevant-path fan-out
 *   (`getCompareDiff` → `APP_LICENSE_EVALUATE_DISPATCHER`, plan §2.3:185-186) is
 *   T22/T31's; the state row and the dispatcher it needs do not exist in this
 *   tree.
 */

/** The per-Work lock key of one evaluation (plan §2.3:178). */
export const APP_SPEC_EVALUATE_LOCK_PREFIX = 'app-spec-evaluate:';

/** The lock key of one App Work's evaluation. */
export function appSpecEvaluateLockKey(workId: string): string {
    return `${APP_SPEC_EVALUATE_LOCK_PREFIX}${workId}`;
}

/**
 * How many evaluation passes one `evaluate` call may run while it holds the
 * per-Work lock (see the class docstring and {@link AppSpecService.evaluate}).
 *
 * Three, and the number is derived rather than picked: one pass for the request
 * that started this run, one for a tracked-branch move adopted by that pass
 * (FR-16's "request a second evaluation"), and one for a trigger that arrived
 * *while* the run was in flight (FR-22's coalescing is only allowed to defer a
 * request, never to lose it). A fourth pass would mean another request arrived
 * during the third — and that one is served by the next dispatch.
 */
export const APP_SPEC_EVALUATE_MAX_PASSES = 3;

/** The Activity `action` names this epic writes, exactly as CONTRACTS §6 spells them (R-2). */
export const APP_SPEC_ACTIVITY_ACTIONS = {
    validated: 'app.spec.validated',
    invalid: 'app.spec.invalid',
    applied: 'app.spec.applied',
} as const;

/** The five named failure codes this service records in `lastEvaluationError`. */
export const APP_SPEC_EVALUATION_ERRORS = {
    /** The provider could not answer for the tracked branch's head. */
    headUnreadable: 'head_unreadable',
    /** The provider could not answer for `.works/works.yml` at the head. */
    fileUnreadable: 'file_unreadable',
    /** The validator itself threw (plan §9.2: "Caught at the job boundary"). */
    validatorError: 'validatorError',
    /** FR-16's refusal: the branch a valid head declares could not be adopted. */
    trackedBranchMissing: 'tracked_branch_missing',
    /** The Work has no repository coordinates to read — nothing to evaluate. */
    repositoryUnresolved: 'repository_unresolved',
} as const;

/** Timing source, injectable so a spec can drive the 60-second window exactly. */
export interface AppSpecServiceDeps {
    readonly now?: () => number;
}

/**
 * What `requestEvaluation` answers. `dispatched` is the coalescing verdict — the
 * job is on its way exactly when it is `true`; `ranInProcess` says this call also
 * ran the handler, which happens **only** when the dispatcher answered `null`
 * (plan §6.1:661-662).
 */
export interface AppSpecEvaluationRequestOutcome {
    readonly workId: string;
    readonly trigger: AppSpecEvaluationTrigger;
    /** A state row existed to request against. `false` ⇒ the App Work is gone. */
    readonly requested: boolean;
    /** This call stamped `dispatchedAt` and owns the dispatch. */
    readonly dispatched: boolean;
    /** A job was already waiting inside the 5-second window, so this request coalesced. */
    readonly coalesced: boolean;
    readonly requestedSeq: number;
    readonly evaluatedSeq: number;
    /** The runtime's run id, or `null` when no runtime was configured. */
    readonly runId: string | null;
    /** `true` when this call ran the handler itself (no runtime registered). */
    readonly ranInProcess: boolean;
    /** The in-process pass's outcome, or `null` when the runtime took the job. */
    readonly evaluation: AppSpecEvaluationOutcome | null;
    /** A named reason when nothing could be dispatched — never a silent no-op. */
    readonly reason?: string | null;
    /** The message of a failure that stopped the dispatch itself. */
    readonly error?: string | null;
}

/**
 * What one `evaluate` call did. `status` is the **string discriminant** this
 * package's callers switch on (`strictNullChecks: false`, so a boolean would not
 * narrow a union — the same rule `app-deploy-preconditions.service.ts:158-162`
 * records).
 */
export interface AppSpecEvaluationOutcome {
    readonly workId: string;
    /** `evaluated` · `no_state` · `work_missing` · `locked` · `failed`. */
    readonly status: string;
    readonly trigger: AppSpecEvaluationTrigger | null;
    /** The status the head produced: `valid`, `invalid`, `missing`, `unreadable`… */
    readonly validationStatus: AppSpecValidationStatus | null;
    readonly headCommitSha: string | null;
    readonly headSpecHash: string | null;
    readonly effectiveCommitSha: string | null;
    readonly effectiveSpecHash: string | null;
    readonly errorCount: number;
    readonly warningCount: number;
    /** The guarded write won, so this evaluation's result is the stored one. */
    readonly written: boolean;
    /** A newer evaluation already stored a result: nothing was written or emitted. */
    readonly superseded: boolean;
    /** The effective spec hash changed and the transition was published. */
    readonly applied: boolean;
    /** The commit the previous effective spec was read at, when a transition happened. */
    readonly previousCommitSha: string | null;
    /** `true` when the tracked branch moved and a second pass ran (FR-16). */
    readonly trackedBranchMoved: boolean;
    /** The branch now tracked, when it moved. */
    readonly trackedBranch: string | null;
    /** `true` when an Activity row was recorded. */
    readonly activityRecorded: boolean;
    /** `true` when `AppSpecAppliedEvent` was emitted. */
    readonly eventEmitted: boolean;
    /** How many passes this call ran while holding the lock (see MAX_PASSES). */
    readonly passes: number;
    readonly error: string | null;
    readonly durationMs: number;
}

/** What `getEffectiveSpec` answers — the read APW-05, 06 and 08 consume (plan §2.7:383-386). */
/**
 * The two validation statuses that mean "this spec may be used".
 *
 * APW-03 has TWO of them on purpose: warnings do not stop anything, and a
 * single `valid` would have forced every consumer to decide for itself whether
 * a warning is fatal. Three places were deciding that independently before this
 * constant existed — twice in this service and once in APW-05's Build spec
 * source — and a fourth (APW-07's env source) was about to.
 *
 * Every other status is NOT usable, including `missing` and `unreadable`, which
 * mean "we could not tell" rather than "it is broken". They are the same answer
 * to a consumer: a spec we could not read is a spec we cannot act on.
 */
export const APP_SPEC_USABLE_STATUSES: readonly string[] = Object.freeze([
    'valid',
    'valid_with_warnings',
]);

/** `true` ⇔ {@link APP_SPEC_USABLE_STATUSES} contains this status. */
export function isUsableAppSpecStatus(status: unknown): boolean {
    return APP_SPEC_USABLE_STATUSES.includes(String(status ?? ''));
}

export interface AppSpecEffectiveRead {
    /** `valid` · `valid_with_warnings` · `invalid` · `missing` · `unreadable` · `no_state`. */
    readonly status: string;
    readonly workId: string;
    readonly spec: AppSpec | null;
    readonly specHash: string | null;
    readonly commitSha: string | null;
    readonly issues: readonly AppSpecIssue[] | null;
    readonly errorCount: number;
    readonly warningCount: number;
    /** `stored` (the effective row answered) or `read` (the commit was read now). */
    readonly source: string;
    readonly error: string | null;
}

/** What `validateDraft` answers — APW-04's editor path (plan §2.7:382, §4.1:548). */
export interface AppSpecDraftValidation {
    readonly workId: string;
    readonly status: AppSpecValidationStatus;
    readonly issues: readonly AppSpecIssue[];
    readonly errorCount: number;
    readonly warningCount: number;
    readonly truncated: boolean;
    readonly rulesRan: boolean;
    readonly suppressedRules: readonly string[];
}

/** What `getState` answers: the row, plus what the 60-second lazy check did. */
export interface AppSpecStateRead {
    readonly workId: string;
    /** `ok` · `no_state`. */
    readonly status: string;
    /** The state row, for the DTO to map. `null` when the App Work has none. */
    readonly state: WorkAppSpecState | null;
    /** FR-18: `evaluatedSeq < requestedSeq` — the DTO publishes this as `evaluationPending`. */
    readonly evaluationPending: boolean;
    /** The lazy head check of plan §6.6 (≤ 1 per 60 s per Work, one head read). */
    readonly lazyCheck: AppSpecLazyCheckOutcome;
}

/** What the lazy head check did — never a silent no-op (FR-19(d), ACC-03-14). */
export interface AppSpecLazyCheckOutcome {
    readonly checked: boolean;
    readonly headCommitSha: string | null;
    readonly headChanged: boolean;
    readonly requested: boolean;
    readonly reason: string | null;
}

/** The Work's repository coordinates and the facade options every read uses. */
export interface AppSpecWorkContext {
    readonly workId: string;
    readonly ownerUserId: string;
    readonly tenantId: string | null;
    readonly organizationId: string | null;
    readonly owner: string;
    readonly repo: string;
    readonly providerId: string;
    readonly gitOptions: GitFacadeOptions;
    /** The relation APW-01 recorded, when it is one this epic knows. */
    readonly recordedRelation: AppSpecSourceRelation | null;
}

/**
 * One pass's verdict, before it is folded into {@link AppSpecEvaluationOutcome}.
 * `pass` itself never emits — the caller emits only when `written` is true.
 */
interface AppSpecPassOutcome {
    outcome: AppSpecEvaluationOutcome;
    /** The next pass must run for this reason, or `null` when the pass settled it. */
    again: string | null;
}

@Injectable()
export class AppSpecService {
    private readonly logger = new Logger(AppSpecService.name);

    /**
     * When each Work's lazy head check last ran **in this process**.
     *
     * The durable half of the window is `lastEvaluatedAt` on the state row, which
     * survives a restart and is shared by every replica; this map covers the case
     * the row cannot — several `GET app-spec` calls in the same second, before any
     * evaluation has written. Bounded by the number of App Works one process has
     * served, and deliberately never persisted: it is a throttle, not state.
     */
    private readonly lazyChecks = new Map<string, number>();

    constructor(
        /** The epic's own row — required: without it there is nothing to evaluate. */
        private readonly states: WorkAppSpecStateRepository,
        /** The Git facade — required: the spec lives in the user's repository (FR-15). */
        private readonly git: GitFacadeService,
        /** Serialises concurrent evaluations of one Work (plan §2.3:178). */
        @Optional() private readonly locks?: DistributedTaskLockService,
        /** The Work row: repository coordinates, owner and scope stamps. */
        @Optional() private readonly works?: WorkRepository,
        /** Activity: `app.spec.validated` / `app.spec.invalid` / `app.spec.applied` (R-2, R-34). */
        @Optional() private readonly activity?: ActivityLogService,
        /** The in-process bus APW-05/06/07/08 listen on. */
        @Optional() private readonly events?: EventEmitter2,
        /** The job runtime; `null` dispatch ⇒ the handler runs here (plan §6.1:661-662). */
        @Optional()
        @Inject(APP_SPEC_EVALUATE_DISPATCHER)
        private readonly dispatcher?: AppSpecEvaluateDispatcher,
    ) {}

    // ────────────────────────────────────────────────────────────────────────
    // initialize / request / read — the four doors
    // ────────────────────────────────────────────────────────────────────────

    /**
     * APW-01's creation path (plan §2.7:380): one state row per App Work, on the
     * branch the Work Repository was created with. Idempotent — a second call, two
     * replicas racing, or a retried create returns the row that exists.
     */
    async initialize(
        workId: string,
        trackedBranch: string,
        scope: WorkAppSpecStateScope = {},
    ): Promise<WorkAppSpecState> {
        return this.states.initialize(workId, trackedBranch, scope);
    }

    /**
     * FR-22 — ask for an evaluation, coalescing inside the 5-second window.
     *
     * The sequence arithmetic and the `dispatchedAt` stamp are the repository's
     * single atomic `UPDATE` (`work-app-spec-state.repository.ts:271-334`); this
     * method only decides what a `dispatched: true` means, and what a **`null`
     * dispatch** means. Per plan §6.1:661-662 a `null` runs the handler in-process
     * **for this job id only** — {@link hasInProcessFallback} is the list, and
     * `app-spec-evaluate` is its only member — because "a user is waiting on the
     * page" and because FR-90 requires the evaluation, its writes and its
     * in-process events to happen in the API process.
     *
     * A `coalesced` request is **not** lost: it bumped `requestedSeq`, the waiting
     * job reads the newest sequence when it starts (`markStarted`), and a request
     * that lands while a run is in flight is picked up by that run's next pass
     * ({@link APP_SPEC_EVALUATE_MAX_PASSES}). That is the whole point of the
     * arithmetic: coalescing may defer work, never drop it.
     */
    async requestEvaluation(
        workId: string,
        trigger: AppSpecEvaluationTrigger,
        scope: WorkAppSpecStateScope & {
            providerId?: string | null;
            credentialVersion?: number | null;
        } = {},
        deps: AppSpecServiceDeps = {},
    ): Promise<AppSpecEvaluationRequestOutcome> {
        const now = deps.now ?? Date.now;
        const requested = await this.states.requestEvaluation(workId, now());
        const base = {
            workId,
            trigger,
            requested: requested.requested,
            requestedSeq: requested.requestedSeq,
            evaluatedSeq: requested.evaluatedSeq,
        };

        if (!requested.requested) {
            // The Work — and its cascaded state row — is gone. Nothing is raised
            // that could never find its row (plan §9.2: "App Work deleted mid-job").
            return {
                ...base,
                dispatched: false,
                coalesced: false,
                runId: null,
                ranInProcess: false,
                evaluation: null,
                reason: 'work_not_found',
            };
        }

        if (!requested.dispatched) {
            return {
                ...base,
                dispatched: false,
                coalesced: true,
                runId: null,
                ranInProcess: false,
                evaluation: null,
                reason: 'coalesced',
            };
        }

        const payload: AppSpecEvaluatePayload = {
            workId,
            trigger,
            tenantId: scope.tenantId ?? null,
            organizationId: scope.organizationId ?? null,
            providerId: scope.providerId ?? null,
            credentialVersion: scope.credentialVersion ?? null,
        };

        return {
            ...base,
            dispatched: true,
            coalesced: false,
            ...(await this.dispatchOrRun(payload, deps)),
        };
    }

    /**
     * The dispatch half: hand the payload to the runtime, or run it here.
     *
     * Three cases, each named rather than inferred:
     *
     * 1. the bound dispatcher has no `dispatchAppSpecEvaluate` (a runtime whose
     *    `dispatchers` view predates this job) ⇒ run in-process, `reason:
     *    'dispatcherUnavailable'`;
     * 2. the dispatcher answered a run id ⇒ the runtime owns the job;
     * 3. the dispatcher answered `null` ⇒ no runtime is configured ⇒ run
     *    in-process (plan §6.1:661-662).
     *
     * A job id with no in-process fallback would record `dispatchUnavailable`
     * here — the sibling jobs' behaviour — and the list is
     * `APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS`, not an `if` on a literal.
     */
    private async dispatchOrRun(
        payload: AppSpecEvaluatePayload,
        deps: AppSpecServiceDeps,
    ): Promise<{
        runId: string | null;
        ranInProcess: boolean;
        evaluation: AppSpecEvaluationOutcome | null;
        reason?: string | null;
        error?: string | null;
    }> {
        const inProcess = hasInProcessFallback(APP_SPEC_EVALUATE_JOB_ID);
        const dispatch =
            this.dispatcher && typeof this.dispatcher.dispatchAppSpecEvaluate === 'function'
                ? this.dispatcher.dispatchAppSpecEvaluate.bind(this.dispatcher)
                : null;

        if (dispatch) {
            try {
                const runId = await dispatch(payload);
                if (runId) {
                    return { runId, ranInProcess: false, evaluation: null };
                }
            } catch (error) {
                // A runtime that refuses the enqueue has NOT accepted the job: the
                // in-process path is what keeps a user's Re-check from doing
                // nothing, so it runs and the refusal is reported beside it.
                const failure = errorText(error);
                this.logger.warn(
                    `App spec: dispatching the evaluation of work ${payload.workId} failed (${failure}); running it in-process.`,
                );
                const hostRun = inProcess
                    ? await this.runInProcess(payload, deps)
                    : { evaluation: null, error: null };
                return {
                    runId: null,
                    ranInProcess: inProcess,
                    evaluation: hostRun.evaluation,
                    reason: 'dispatchFailed',
                    error: failure,
                };
            }
        }

        if (!inProcess) {
            return {
                runId: null,
                ranInProcess: false,
                evaluation: null,
                reason: 'dispatchUnavailable',
            };
        }

        const hostRun = await this.runInProcess(payload, deps);
        return {
            runId: null,
            ranInProcess: true,
            evaluation: hostRun.evaluation,
            reason: dispatch ? null : 'dispatcherUnavailable',
            error: hostRun.error,
        };
    }

    /** Run the registered handler in this process — the `null`-dispatch path. */
    private async runInProcess(
        payload: AppSpecEvaluatePayload,
        deps: AppSpecServiceDeps,
    ): Promise<{
        evaluation: AppSpecEvaluationOutcome | null;
        error: string | null;
    }> {
        try {
            const evaluation = await runAppSpecEvaluateJob<AppSpecEvaluationOutcome>(payload, {
                evaluate: (workId: string) => this.evaluate(workId, deps),
            });
            return { evaluation, error: null };
        } catch (error) {
            const failure = errorText(error);
            this.logger.warn(
                `App spec: the in-process evaluation of work ${payload.workId} failed (${failure}).`,
            );
            return { evaluation: null, error: failure };
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // evaluate — the job body
    // ────────────────────────────────────────────────────────────────────────

    /**
     * One full evaluation of one App Work (plan §2.3).
     *
     * Serialised per Work with `runExclusive('app-spec-evaluate:<workId>')`. A
     * second job that finds the lock held returns `status: 'locked'` and writes
     * nothing: the holder is already evaluating the **current** head, which is
     * what that job would have read.
     *
     * While the lock is held the method runs up to
     * {@link APP_SPEC_EVALUATE_MAX_PASSES} passes, and each pass re-reads the
     * sequence the repository holds. That is what stops a request that arrives
     * *during* a run from being stranded: the coalescing rule only skips the
     * dispatch of a job that has not started, so a trigger landing mid-run leaves
     * `evaluatedSeq < requestedSeq` with nothing queued behind it — and FR-18
     * would then report the App Work as pending forever. The next pass settles it
     * here, where the lock is already held.
     */
    async evaluate(
        workId: string,
        deps: AppSpecServiceDeps = {},
    ): Promise<AppSpecEvaluationOutcome> {
        const now = deps.now ?? Date.now;
        const startedAtMs = now();

        const run = async (): Promise<AppSpecEvaluationOutcome> => {
            let passes = 0;
            let latest: AppSpecEvaluationOutcome = this.baseOutcome(workId, {
                status: 'no_state',
                durationMs: 0,
            });
            let again: string | null = 'requested';
            let trackedBranchMoved = false;

            while (again !== null && passes < APP_SPEC_EVALUATE_MAX_PASSES) {
                // Every pass claims a sequence that OUT-RANKS the last write, which is
                // what the guard (`evaluatedSeq < :seq`) requires of it: a pass that
                // reused its predecessor's sequence could never write.
                const seq = await this.claimSequence(workId);
                if (seq === null) {
                    // The Work — and its cascaded state row — was deleted while this
                    // job sat in the queue. Exit clean, resurrect nothing (plan §9.2).
                    latest = this.baseOutcome(workId, {
                        status: 'no_state',
                        durationMs: Math.max(0, now() - startedAtMs),
                    });
                    break;
                }

                passes += 1;
                const pass = await this.runPass(workId, seq, deps);
                trackedBranchMoved = trackedBranchMoved || pass.outcome.trackedBranchMoved;
                latest = {
                    ...pass.outcome,
                    passes,
                    // A move made by an earlier pass is a fact about this run, not
                    // about the pass that observed it: the second pass reads the
                    // branch it has already adopted and sees no move.
                    trackedBranchMoved,
                    durationMs: Math.max(0, now() - startedAtMs),
                };
                again = pass.again;
            }

            return latest;
        };

        if (!this.locks) {
            // No lock service in this graph: evaluate anyway and report the absence
            // by the outcome the row carries, rather than refusing a read the user
            // asked for. The guarded write is what keeps two concurrent runs sane.
            return run();
        }

        const locked = await this.locks.runExclusive(appSpecEvaluateLockKey(workId), run);
        if (!locked.acquired) {
            return this.baseOutcome(workId, {
                status: 'locked',
                error: 'Another evaluation of this App Work is in flight.',
                durationMs: Math.max(0, now() - startedAtMs),
            });
        }
        return locked.result;
    }

    /**
     * One evaluation pass: read, validate, write, publish. Never emits unless the
     * guarded write won (see the class docstring, rule 2).
     */
    private async runPass(
        workId: string,
        seq: number,
        deps: AppSpecServiceDeps,
    ): Promise<AppSpecPassOutcome> {
        const now = deps.now ?? Date.now;

        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return { outcome: this.baseOutcome(workId, { status: 'no_state' }), again: null };
        }

        const context = await this.loadContext(workId, state);
        if (!context) {
            return {
                outcome: this.baseOutcome(workId, {
                    status: 'work_missing',
                    error: 'The App Work row is gone, so there is nothing to evaluate.',
                }),
                again: null,
            };
        }

        const head = await this.readHead(context, state);
        if (head.status !== 'ok') {
            const written = await this.states.writeEvaluation(workId, seq, {
                trigger: state.lastEvaluationTrigger ?? 'manual',
                headCommitSha: head.commitSha ?? state.headCommitSha ?? null,
                headSpecHash: null,
                validationStatus: 'unreadable',
                errorCount: 0,
                warningCount: 0,
                issues: null,
                lastEvaluationError: head.error,
                evaluatedAt: new Date(now()),
            });
            return {
                outcome: this.baseOutcome(workId, {
                    status: 'evaluated',
                    validationStatus: 'unreadable',
                    headCommitSha: head.commitSha ?? null,
                    effectiveCommitSha: state.effectiveCommitSha ?? null,
                    effectiveSpecHash: state.effectiveSpecHash ?? null,
                    written,
                    superseded: !written,
                    error: head.error,
                }),
                again: written ? await this.pendingAgain(workId, seq) : null,
            };
        }

        const headCommitSha = head.commitSha as string;

        // ── the file (FR-15, FR-21: "File deleted on the tracked branch ⇒ missing") ──
        const file = await this.readSpecFile(context, headCommitSha);
        if (file.status !== 'ok') {
            const missing = file.status === 'missing';
            const written = await this.states.writeEvaluation(workId, seq, {
                trigger: state.lastEvaluationTrigger ?? 'manual',
                headCommitSha,
                headSpecHash: null,
                validationStatus: missing ? 'missing' : 'unreadable',
                errorCount: 0,
                warningCount: 0,
                issues: null,
                lastEvaluationError: missing ? null : file.error,
                evaluatedAt: new Date(now()),
            });
            return {
                outcome: this.baseOutcome(workId, {
                    status: 'evaluated',
                    validationStatus: missing ? 'missing' : 'unreadable',
                    headCommitSha,
                    effectiveCommitSha: state.effectiveCommitSha ?? null,
                    effectiveSpecHash: state.effectiveSpecHash ?? null,
                    written,
                    superseded: !written,
                    error: missing ? null : file.error,
                }),
                again: written ? await this.pendingAgain(workId, seq) : null,
            };
        }

        // ── the validator (FR-18; its own contract: never throws) ──────────────
        let validation: AppSpecValidationResult;
        try {
            validation = validateAppSpecDocument(file.text as string, {
                mode: 'data-repository',
                context: this.ruleContext(context, true),
            });
        } catch (error) {
            // Plan §9.2: "Validator bug throws ⇒ Caught at the job boundary ⇒
            // unreadable with validatorError; logged once with the Work id".
            const failure = errorText(error);
            this.logger.error(
                `App spec: the validator threw for work ${workId} at ${headCommitSha} (${failure}).`,
            );
            const written = await this.states.writeEvaluation(workId, seq, {
                trigger: state.lastEvaluationTrigger ?? 'manual',
                headCommitSha,
                headSpecHash: null,
                validationStatus: 'unreadable',
                errorCount: 0,
                warningCount: 0,
                issues: null,
                lastEvaluationError: APP_SPEC_EVALUATION_ERRORS.validatorError,
                evaluatedAt: new Date(now()),
            });
            return {
                outcome: this.baseOutcome(workId, {
                    status: 'evaluated',
                    validationStatus: 'unreadable',
                    headCommitSha,
                    effectiveCommitSha: state.effectiveCommitSha ?? null,
                    effectiveSpecHash: state.effectiveSpecHash ?? null,
                    written,
                    superseded: !written,
                    error: APP_SPEC_EVALUATION_ERRORS.validatorError,
                }),
                again: written ? await this.pendingAgain(workId, seq) : null,
            };
        }

        const headSpecHash = hashAppSpec(validation.spec);
        const accepted = validation.spec !== null && validation.errorCount === 0;
        const effectiveChanged =
            accepted && !appSpecHashesEqual(headSpecHash, state.effectiveSpecHash);
        const headChanged =
            !appSpecHashesEqual(state.headSpecHash, headSpecHash) ||
            state.validationStatus !== validation.status;

        // ── FR-16: the tracked-branch move, decided BEFORE the write so it lands
        //    on the same guarded statement ──────────────────────────────────────
        const move = accepted
            ? await this.branchMove(context, state, validation.spec)
            : { branch: null, error: null };

        // The guarded write's payload. `accepted` decides the four effective fields
        // together — FR-20 — and their ABSENCE is what keeps the previous effective
        // spec on an invalid, missing or unreadable head (ACC-03-10), because the
        // repository leaves a column untouched when its field is omitted.
        const result: AppSpecEvaluationResult = {
            trigger: state.lastEvaluationTrigger ?? 'manual',
            headCommitSha,
            headSpecHash,
            validationStatus: validation.status,
            errorCount: validation.errorCount,
            warningCount: validation.warningCount,
            issues: [...validation.issues],
            issuesTruncated: validation.truncated,
            lastEvaluationError: move.error,
            evaluatedAt: new Date(now()),
            ...(accepted
                ? {
                      // The effective commit advances even when the hash does not
                      // (the same content at a new commit is the same spec), but the
                      // EVENT does not (FR-21).
                      effectiveCommitSha: headCommitSha,
                      effectiveSpecHash: headSpecHash,
                      effectiveSpec: validation.spec,
                      effectiveAt: new Date(now()),
                  }
                : {}),
            ...(move.branch ? { trackedBranch: move.branch } : {}),
        };

        const written = await this.states.writeEvaluation(workId, seq, result);
        if (!written) {
            // An older job that lost the race writes nothing AND publishes nothing:
            // the stored state is a newer evaluation's, and announcing this one
            // would describe a spec the platform does not have.
            return {
                outcome: this.baseOutcome(workId, {
                    status: 'evaluated',
                    validationStatus: validation.status,
                    headCommitSha,
                    headSpecHash,
                    effectiveCommitSha: state.effectiveCommitSha ?? null,
                    effectiveSpecHash: state.effectiveSpecHash ?? null,
                    errorCount: validation.errorCount,
                    warningCount: validation.warningCount,
                    written: false,
                    superseded: true,
                }),
                again: null,
            };
        }

        // ── the published half, only now that the write won ───────────────────
        const activityRecorded = headChanged
            ? await this.recordHeadActivity(context, validation, headCommitSha)
            : false;

        let eventEmitted = false;
        if (effectiveChanged) {
            // One transition object, so the Activity row and the in-process event
            // can never describe different changes.
            const transition: AppSpecTransition = {
                commitSha: headCommitSha,
                previousCommitSha: state.effectiveCommitSha ?? null,
                specHash: headSpecHash as string,
                previousSpec: state.effectiveSpec ?? null,
                spec: validation.spec as AppSpec,
                addedDependencies: addedDependencies(state.effectiveSpec ?? null, validation.spec),
                changedEnvNames: changedEnvNames(state.effectiveSpec ?? null, validation.spec),
                changedBlocks: changedBlocks(state.effectiveSpec ?? null, validation.spec),
            };
            await this.recordAppliedActivity(context, transition);
            eventEmitted = this.emitApplied(context, transition);
        }

        return {
            outcome: this.baseOutcome(workId, {
                status: 'evaluated',
                validationStatus: validation.status,
                headCommitSha,
                headSpecHash,
                effectiveCommitSha: accepted ? headCommitSha : (state.effectiveCommitSha ?? null),
                effectiveSpecHash: accepted ? headSpecHash : (state.effectiveSpecHash ?? null),
                errorCount: validation.errorCount,
                warningCount: validation.warningCount,
                written: true,
                applied: effectiveChanged,
                previousCommitSha: state.effectiveCommitSha ?? null,
                trackedBranchMoved: Boolean(move.branch),
                trackedBranch: move.branch ?? state.trackedBranch,
                activityRecorded,
                eventEmitted,
                error: move.error,
            }),
            // FR-22 — a request that landed while this pass ran is settled by the
            // next pass, and FR-16's move asks for a second evaluation. Both are
            // the same answer here: run again while the lock is held.
            again: move.branch ? 'tracked_branch_moved' : await this.pendingAgain(workId, seq),
        };
    }

    /**
     * Claim the sequence one pass writes under — `startedSeq = requestedSeq`, and
     * guaranteed to out-rank `evaluatedSeq`.
     *
     * `markStarted` alone is not enough for the two cases a pass can find itself
     * in: a row nobody has ever requested an evaluation for (`requestedSeq` is
     * still 0 — the row APW-01 created and nothing has triggered yet), and a row a
     * previous pass has already written (`evaluatedSeq` equals the sequence that
     * pass claimed). Both would claim a sequence the guard `evaluatedSeq < :seq`
     * refuses, so the pass would silently write nothing. When that is the case this
     * requests a fresh sequence first — one extra `UPDATE` — and the guard is then
     * satisfied by construction rather than by hope.
     *
     * Returns `null` when the App Work's row is gone (the Work was deleted while
     * the job was queued).
     */
    private async claimSequence(workId: string): Promise<number | null> {
        const claimed = await this.states.markStarted(workId);
        if (claimed === null) {
            return null;
        }

        const row = await this.states.findByWorkId(workId);
        if (!row || Number(claimed) > Number(row.evaluatedSeq)) {
            return claimed;
        }

        await this.states.requestEvaluation(workId);
        return this.states.markStarted(workId);
    }

    /**
     * Does the row still hold an unsatisfied request (`evaluatedSeq < requestedSeq`)?
     *
     * Read **after** this pass's guarded write, so it answers "did a trigger arrive
     * that this pass did not satisfy?" — the coalescing rule's own blind spot (see
     * {@link AppSpecService.evaluate}).
     */
    private async pendingAgain(workId: string, seq: number): Promise<string | null> {
        const row = await this.states.findByWorkId(workId);
        if (!row) {
            return null;
        }
        if (Number(row.requestedSeq) > Number(row.evaluatedSeq)) {
            return 'request_pending';
        }
        return null;
    }

    // ────────────────────────────────────────────────────────────────────────
    // The reads other epics consume
    // ────────────────────────────────────────────────────────────────────────

    /**
     * FR-19(g) / plan §2.3:195-198 — the effective App spec, optionally **at a
     * specific commit**.
     *
     * - `commitSha` absent, or equal to the stored effective commit or the stored
     *   head commit ⇒ the stored effective spec answers, with no provider read.
     *   When the `effectiveSpec` cache column is empty (a row written before the
     *   spec was cached) the file at `effectiveCommitSha` is authoritative
     *   (plan §3.1:419) and is read now — in memory only: this method never writes.
     * - any other commit ⇒ that commit's `.works/works.yml` is read and validated
     *   synchronously, and `{ status: 'invalid', issues }` is returned for a spec
     *   with errors, which is what makes APW-05 refuse a Build of that commit
     *   (FR-20). A commit that cannot be read answers `missing`/`unreadable`
     *   rather than a half-read spec.
     *
     * The answer is `null` only when there is no App Work to read at all
     * (`worksUnavailable`) — never a partially-populated spec.
     */
    async getEffectiveSpec(
        workId: string,
        commitSha?: string | null,
    ): Promise<AppSpecEffectiveRead | null> {
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return null;
        }

        const target = commitSha ?? null;
        const headIsUsable =
            state.validationStatus === 'valid' || state.validationStatus === 'valid_with_warnings';
        const isStoredCommit =
            !target ||
            target === state.effectiveCommitSha ||
            // 🛑 The head-commit shortcut applies only while the row's OWN verdict
            // for that head is a usable one. T12: "an invalid head keeps the
            // effective commit and `getEffectiveSpec(workId, badSha)` returns
            // `invalid`" — and ACC-03-10's second half is "a Build requested for
            // that commit is refused". Answering the stored (previous, valid) spec
            // for an invalid head would hand APW-05 exactly the spec it must NOT
            // build from, so a head the row already knows is invalid, missing or
            // unreadable is read and validated here instead.
            (target === state.headCommitSha && headIsUsable);

        if (isStoredCommit) {
            const stored = state.effectiveSpec ?? null;
            if (stored) {
                return {
                    workId,
                    // Only a zero-error evaluation ever wrote `effectiveSpec`
                    // (FR-20), so the stored read is `valid` by construction; the
                    // warning count belongs to the tab, which reads `getState`.
                    status: 'valid',
                    spec: stored,
                    specHash: state.effectiveSpecHash ?? hashAppSpec(stored),
                    commitSha: state.effectiveCommitSha ?? state.headCommitSha ?? null,
                    issues: null,
                    errorCount: 0,
                    warningCount: 0,
                    source: 'stored',
                    error: null,
                };
            }
            if (state.effectiveCommitSha) {
                // The cache is empty but the commit is known: the file is the
                // authority, and the value is rebuilt here rather than written.
                return this.readSpecAt(workId, state, state.effectiveCommitSha, 'stored');
            }
        }

        const readCommit = target ?? state.headCommitSha;
        if (!readCommit) {
            return {
                workId,
                status: 'missing',
                spec: null,
                specHash: null,
                commitSha: null,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                source: 'stored',
                error: 'This App Work has no evaluated commit yet.',
            };
        }

        return this.readSpecAt(workId, state, readCommit, 'read');
    }

    /** Read and validate `.works/works.yml` at one commit — never writing anything. */
    private async readSpecAt(
        workId: string,
        state: WorkAppSpecState,
        commitSha: string,
        source: string,
    ): Promise<AppSpecEffectiveRead> {
        const context = await this.loadContext(workId, state);
        if (!context) {
            return {
                workId,
                status: 'unreadable',
                spec: null,
                specHash: null,
                commitSha,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                source,
                error: 'The App Work row is gone, so its repository cannot be resolved.',
            };
        }

        const file = await this.readSpecFile(context, commitSha);
        if (file.status !== 'ok') {
            return {
                workId,
                status: file.status === 'missing' ? 'missing' : 'unreadable',
                spec: null,
                specHash: null,
                commitSha,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                source,
                error: file.error,
            };
        }

        let validation: AppSpecValidationResult;
        try {
            validation = validateAppSpecDocument(file.text as string, {
                mode: 'data-repository',
                context: this.ruleContext(context, false),
            });
        } catch (error) {
            return {
                workId,
                status: 'unreadable',
                spec: null,
                specHash: null,
                commitSha,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                source,
                error: `${APP_SPEC_EVALUATION_ERRORS.validatorError}: ${errorText(error)}`,
            };
        }

        return {
            workId,
            status: validation.status,
            spec: validation.spec,
            specHash: hashAppSpec(validation.spec),
            commitSha,
            issues: validation.issues,
            errorCount: validation.errorCount,
            warningCount: validation.warningCount,
            source,
            error: null,
        };
    }

    /**
     * FR-89 / ACC-03-57 — "does this commit already carry a usable App spec?".
     *
     * `true` only when `.works/works.yml` at `commitSha` parses, selects kind
     * `app`, validates with **zero errors** (warnings allowed) and its `spec` holds
     * at least one key outside `{ kind, appSpecVersion, source }` — the last clause
     * is contracts' `isSourceOnlyAppSpec`, the pure helper APW-01's minimal path and
     * this epic's apply job share, because R2 requires `build`/`components` only
     * when one of them is present and the `{version, kind, spec.source}` file
     * APW-01 writes would otherwise read as a *valid* App spec.
     *
     * 🛑 **It reads the commit, never the state row.** Both
     * `WorkAppSpecState.validationStatus` and the effective-spec cache are
     * asynchronous — the row APW-01 just initialized has not been evaluated yet and
     * still reads `missing` — so a predicate that consulted them would answer
     * "there is no App spec" for every freshly created App Work and start the App
     * Provisioner over a repository that already has one. It writes nothing.
     */
    async hasValidAppSpec(workId: string, commitSha: string): Promise<boolean> {
        if (!workId || !commitSha) {
            return false;
        }

        const context = await this.loadContext(workId, null);
        if (!context) {
            return false;
        }

        const file = await this.readSpecFile(context, commitSha);
        if (file.status !== 'ok') {
            return false;
        }
        const text = file.text as string;

        let validation: AppSpecValidationResult;
        try {
            validation = validateAppSpecDocument(text, {
                mode: 'data-repository',
                context: this.ruleContext(context, false),
            });
        } catch {
            return false;
        }

        if (validation.errorCount > 0 || validation.spec === null) {
            return false;
        }
        if (!this.selectsAppKind(text, validation.spec)) {
            return false;
        }
        return !isSourceOnlyAppSpec(validation.spec);
    }

    /**
     * Does the document select kind `app`?
     *
     * The root `kind` is the envelope's discriminator (`works-config.schema.ts:469-474`
     * reads the kind from `spec.kind` first and the root second), and
     * `validateAppSpecDocument` validates the `spec` block **without** requiring a
     * root kind — a document declaring `kind: website` whose `spec` block happens to
     * satisfy the App rules would otherwise pass. So the root is read here: `app`
     * when it says so, or when it says nothing and the spec block itself declares
     * `kind: app` (which the schema only allows for this kind). Anything else — a
     * different kind, an unparseable root — is refused.
     */
    private selectsAppKind(text: string, spec: AppSpec): boolean {
        let root: unknown;
        try {
            root = parseYaml(text);
        } catch {
            // The validator already parsed this text successfully; a second parse
            // failing means the two disagree, and the safe answer is "not an app".
            return false;
        }
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return false;
        }
        const rootKind = (root as Record<string, unknown>)['kind'];
        if (typeof rootKind === 'string' && rootKind.length > 0) {
            return rootKind === 'app';
        }
        return spec.kind === 'app';
    }

    /**
     * APW-04's editor path (plan §2.7:382, §4.1:548) — validate text the member is
     * still editing, in `draft` mode, storing **nothing**.
     *
     * Not a dry run of the evaluation: `draft` is the contract's own mode for text
     * a member holds (`APP_SPEC_VALIDATION_MODES`), and the server-only rules run
     * only where their context is known — the same rule that keeps an unknown input
     * from inventing a warning (`app-spec.rules.ts:21-22`).
     */
    async validateDraft(workId: string, text: string): Promise<AppSpecDraftValidation> {
        const context = await this.loadContext(workId, null);
        const validation = validateAppSpecDocument(text, {
            mode: 'draft',
            context: this.ruleContext(context, false),
        });

        return {
            workId,
            status: validation.status,
            issues: validation.issues,
            errorCount: validation.errorCount,
            warningCount: validation.warningCount,
            truncated: validation.truncated,
            rulesRan: validation.rulesRan,
            suppressedRules: validation.suppressedRules,
        };
    }

    /**
     * The App spec state, plus FR-19(d)'s lazy head check: when the page is opened
     * and the live branch head differs from the stored head, an evaluation is
     * scheduled — **at most once per 60 s per Work**, with exactly one
     * `getLatestCommit` read (plan §6.6:701-705, ACC-03-14).
     *
     * The window is measured against the later of this process's own last check
     * ({@link AppSpecService.lazyChecks}) and the row's `lastEvaluatedAt` — the
     * first covers a burst of requests before anything has been written, the second
     * survives a restart and is shared by every replica.
     *
     * Never throws and never writes: a provider failure answers
     * `lazyCheck.reason: 'head_unreadable'` and leaves the stored state to speak
     * for itself.
     */
    async getState(workId: string, deps: AppSpecServiceDeps = {}): Promise<AppSpecStateRead> {
        const now = deps.now ?? Date.now;
        const state = await this.states.findByWorkId(workId);
        if (!state) {
            return {
                workId,
                status: 'no_state',
                state: null,
                evaluationPending: false,
                lazyCheck: {
                    checked: false,
                    headCommitSha: null,
                    headChanged: false,
                    requested: false,
                    reason: 'no_state',
                },
            };
        }

        const lazyCheck = await this.lazyHeadCheck(workId, state, now);
        // Re-read so `evaluationPending` reflects a lazy check that just requested
        // an evaluation, and so a caller sees the row the check left behind.
        const fresh = (await this.states.findByWorkId(workId)) ?? state;

        return {
            workId,
            status: 'ok',
            state: fresh,
            evaluationPending: Number(fresh.requestedSeq) > Number(fresh.evaluatedSeq),
            lazyCheck,
        };
    }

    /** The ≤ 1-per-60-s head check of FR-19(d). See {@link AppSpecService.getState}. */
    private async lazyHeadCheck(
        workId: string,
        state: WorkAppSpecState,
        now: () => number,
    ): Promise<AppSpecLazyCheckOutcome> {
        const at = now();
        const lastCheck = this.lazyChecks.get(workId) ?? 0;
        const lastEvaluated = state.lastEvaluatedAt ? new Date(state.lastEvaluatedAt).getTime() : 0;
        const since = Math.max(lastCheck, lastEvaluated);

        // A Work that has never been checked or evaluated has no window to be
        // inside: the first `GET app-spec` after a push MUST check, which is the
        // whole point of FR-19(d) — the webhook-less repository is exactly the one
        // whose first read has no baseline.
        if (since > 0 && at - since < APP_SPEC_LAZY_HEAD_CHECK_MS) {
            return {
                checked: false,
                headCommitSha: state.headCommitSha ?? null,
                headChanged: false,
                requested: false,
                reason: 'checkedRecently',
            };
        }

        this.lazyChecks.set(workId, at);

        const context = await this.loadContext(workId, state);
        if (!context) {
            return {
                checked: true,
                headCommitSha: null,
                headChanged: false,
                requested: false,
                reason: 'worksUnavailable',
            };
        }

        let head: { sha: string | null; error: string | null };
        try {
            const commit = await this.git.getLatestCommit(
                context.owner,
                context.repo,
                state.trackedBranch,
                context.gitOptions,
            );
            head = { sha: commit?.sha ?? null, error: null };
        } catch (error) {
            head = { sha: null, error: errorText(error) };
        }

        if (!head.sha) {
            return {
                checked: true,
                headCommitSha: null,
                headChanged: false,
                requested: false,
                reason: head.error ? 'headUnreadable' : 'headUnknown',
            };
        }

        if (head.sha === state.headCommitSha) {
            return {
                checked: true,
                headCommitSha: head.sha,
                headChanged: false,
                requested: false,
                reason: null,
            };
        }

        const requested = await this.requestEvaluation(
            workId,
            'lazy',
            {
                tenantId: state.tenantId ?? null,
                organizationId: state.organizationId ?? null,
            },
            { now },
        );

        return {
            checked: true,
            headCommitSha: head.sha,
            headChanged: true,
            requested: requested.dispatched || requested.ranInProcess,
            reason: requested.reason ?? null,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Publishing
    // ────────────────────────────────────────────────────────────────────────

    /**
     * `app.spec.validated` (COMPLETED) or `app.spec.invalid` (FAILED) — the row
     * R-34 requires for the two head verdicts, emitted only when the head reading
     * changed (T12: "the dotted `action` only on head-hash change", ACC-03-11).
     *
     * `missing` and `unreadable` deliberately write **no** row: there is no
     * `app.spec.missing` in CONTRACTS §6's list, the absence is already on the row
     * as `validationStatus`, and a row reading "App spec has 0 problems" for a
     * repository that has no spec would be a lie.
     */
    private async recordHeadActivity(
        context: AppSpecWorkContext,
        validation: AppSpecValidationResult,
        commitSha: string,
    ): Promise<boolean> {
        if (validation.status === 'invalid') {
            return this.record(context, {
                action: APP_SPEC_ACTIVITY_ACTIONS.invalid,
                status: ActivityStatus.FAILED,
                summary: `App spec has ${validation.errorCount} problems`,
                details: {
                    commitSha,
                    errorCount: validation.errorCount,
                    warningCount: validation.warningCount,
                    codes: firstCodes(validation.issues),
                },
            });
        }

        if (validation.status === 'valid' || validation.status === 'valid_with_warnings') {
            return this.record(context, {
                action: APP_SPEC_ACTIVITY_ACTIONS.validated,
                status: ActivityStatus.COMPLETED,
                summary: `App spec checked — ${validation.warningCount} warnings`,
                details: {
                    commitSha,
                    errorCount: validation.errorCount,
                    warningCount: validation.warningCount,
                    codes: firstCodes(validation.issues),
                },
            });
        }

        return false;
    }

    /** `app.spec.applied` — the Activity half of one effective-spec transition (R-2, R-34). */
    private async recordAppliedActivity(
        context: AppSpecWorkContext,
        transition: AppSpecTransition,
    ): Promise<boolean> {
        return this.record(context, {
            action: APP_SPEC_ACTIVITY_ACTIONS.applied,
            status: ActivityStatus.COMPLETED,
            summary: 'App spec applied',
            details: {
                commitSha: transition.commitSha,
                previousCommitSha: transition.previousCommitSha,
                specHash: transition.specHash,
                addedDependencies: addedDependencies(transition.previousSpec, transition.spec),
                changedEnvNames: changedEnvNames(transition.previousSpec, transition.spec),
                changedBlocks: changedBlocks(transition.previousSpec, transition.spec),
            },
        });
    }

    /**
     * The R-34 write itself: one row, with the three fields the DTO requires.
     *
     * A row whose Work has no resolvable owner is **not written** and is counted in
     * the log instead — R-34: "there is no system actor in the model", and a row
     * with a blank `userId` is worse than no row.
     */
    private async record(
        context: AppSpecWorkContext,
        entry: {
            action: string;
            status: ActivityStatus;
            summary: string;
            details: Record<string, unknown>;
        },
    ): Promise<boolean> {
        if (!this.activity || !context.ownerUserId) {
            this.logger.warn(
                `App spec: ${entry.action} for work ${context.workId} was not recorded — ${
                    this.activity
                        ? 'the Work has no resolvable owner'
                        : 'no ActivityLogService is bound'
                } (R-34: a row is never written blank).`,
            );
            return false;
        }

        try {
            await this.activity.log({
                userId: context.ownerUserId,
                workId: context.workId,
                actionType: ActivityActionType.APP_SPEC,
                action: entry.action,
                status: entry.status,
                summary: entry.summary,
                details: entry.details,
                tenantId: context.tenantId,
                organizationId: context.organizationId,
            });
            return true;
        } catch (error) {
            // An Activity failure never fails the evaluation: the state row is
            // already written and the spec is live. It is logged, not swallowed.
            this.logger.warn(
                `App spec: recording ${entry.action} for work ${context.workId} failed (${errorText(error)}).`,
            );
            return false;
        }
    }

    /**
     * Emit {@link AppSpecAppliedEvent} — once per transition, on the API process's
     * own bus (FR-90). A missing `EventEmitter2` is reported, never silent: with no
     * bus there is no listener, and APW-05/06/07/08 would wait for an event that
     * was never published.
     */
    private emitApplied(context: AppSpecWorkContext, transition: AppSpecTransition): boolean {
        const payload = {
            workId: context.workId,
            commitSha: transition.commitSha,
            previousCommitSha: transition.previousCommitSha,
            specHash: transition.specHash,
            addedDependencies: addedDependencies(transition.previousSpec, transition.spec),
            changedEnvNames: changedEnvNames(transition.previousSpec, transition.spec),
            changedBlocks: changedBlocks(transition.previousSpec, transition.spec),
        };

        if (!this.events) {
            this.logger.warn(
                `App spec: work ${context.workId}'s spec became effective at ${transition.commitSha}, but no EventEmitter2 is bound — no listener was told.`,
            );
            return false;
        }

        try {
            this.events.emit(AppSpecAppliedEvent.EVENT_NAME, new AppSpecAppliedEvent(payload));
            return true;
        } catch (error) {
            // A synchronous listener that throws must not turn a successful
            // evaluation into a failed job: the state is written and correct.
            this.logger.warn(
                `App spec: emitting ${AppSpecAppliedEvent.EVENT_NAME} for work ${context.workId} failed (${errorText(error)}).`,
            );
            return false;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Reading the repository
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Resolve the Work's Work Repository (the `website` role, never `data` — see
     * README §1's repository-role note) and the facade options every read uses.
     *
     * `null` when there is nothing to read through: no `WorkRepository` in this
     * graph, no Work row, or no resolvable coordinates. Each is reported by the
     * caller as a named failure, never as an empty spec.
     */
    private async loadContext(
        workId: string,
        state: WorkAppSpecState | null,
    ): Promise<AppSpecWorkContext | null> {
        if (!this.works) {
            return null;
        }

        let work: Awaited<ReturnType<WorkRepository['findById']>>;
        try {
            work = await this.works.findById(workId);
        } catch (error) {
            this.logger.warn(`App spec: reading work ${workId} failed (${errorText(error)}).`);
            return null;
        }
        if (!work) {
            return null;
        }

        const owner = work.getRepoOwner('website');
        const repo = work.getWebsiteRepo();
        if (!owner || !repo) {
            return null;
        }

        const providerId = work.gitProvider || APP_WORK_GIT_PROVIDER_ID;

        return {
            workId,
            ownerUserId: work.userId ?? '',
            tenantId: state?.tenantId ?? work.tenantId ?? null,
            organizationId: state?.organizationId ?? work.organizationId ?? null,
            owner,
            repo,
            providerId,
            gitOptions: { userId: work.userId, providerId, workId },
            recordedRelation: recordedRelationOf(work),
        };
    }

    /**
     * The tracked branch's head commit. `status: 'ok'` carries the sha; every other
     * status names why it could not be read, which becomes
     * `lastEvaluationError` and leaves the effective spec alone (plan §9.2: "A
     * provider blip must not flip a valid app to invalid").
     */
    private async readHead(
        context: AppSpecWorkContext,
        state: WorkAppSpecState,
    ): Promise<{ status: string; commitSha: string | null; error: string | null }> {
        try {
            const commit = await this.git.getLatestCommit(
                context.owner,
                context.repo,
                state.trackedBranch,
                context.gitOptions,
            );
            if (!commit?.sha) {
                return {
                    status: 'unreadable',
                    commitSha: null,
                    error: APP_SPEC_EVALUATION_ERRORS.headUnreadable,
                };
            }
            return { status: 'ok', commitSha: commit.sha, error: null };
        } catch (error) {
            return {
                status: 'unreadable',
                commitSha: null,
                error: `${APP_SPEC_EVALUATION_ERRORS.headUnreadable}: ${errorText(error)}`,
            };
        }
    }

    /**
     * `.works/works.yml` at one commit.
     *
     * A `null` from the facade is **`missing`**, not an error: the provider answers
     * `null` both for "no such file" and for a plugin without a file read, and
     * plan §9.2 treats the deleted file as `missing` with the effective spec kept.
     * The provider's own note (`task-workspace.service.ts:535-541`) records the same
     * ambiguity for the same read; it is reported rather than hidden, and the next
     * trigger with a working provider settles it.
     */
    private async readSpecFile(
        context: AppSpecWorkContext,
        commitSha: string,
    ): Promise<{ status: string; text: string | null; error: string | null }> {
        try {
            const file = await this.git.getFileContent(
                context.owner,
                context.repo,
                APP_SOURCE_SPEC_FILE,
                context.gitOptions,
                commitSha,
            );
            if (!file || typeof file.content !== 'string' || file.content.length === 0) {
                return { status: 'missing', text: null, error: null };
            }
            return { status: 'ok', text: file.content, error: null };
        } catch (error) {
            return {
                status: 'unreadable',
                text: null,
                error: `${APP_SPEC_EVALUATION_ERRORS.fileUnreadable}: ${errorText(error)}`,
            };
        }
    }

    /**
     * FR-16 — may the tracked branch move, and to what?
     *
     * A valid head may declare `source.branch`; the branch is adopted only when
     * **all three** hold: it differs from the tracked branch, its own head can be
     * read, and its spec validates with zero errors *and declares the same branch*.
     * Anything else is refused and recorded as `tracked_branch_missing`, so a
     * member's typo cannot point the Work at a branch nobody maintains.
     */
    private async branchMove(
        context: AppSpecWorkContext,
        state: WorkAppSpecState,
        spec: AppSpec,
    ): Promise<{ branch: string | null; error: string | null }> {
        const declared = spec?.source?.branch;
        if (typeof declared !== 'string' || declared.length === 0) {
            return { branch: null, error: null };
        }
        if (declared === state.trackedBranch) {
            return { branch: null, error: null };
        }

        try {
            const commit = await this.git.getLatestCommit(
                context.owner,
                context.repo,
                declared,
                context.gitOptions,
            );
            if (!commit?.sha) {
                return { branch: null, error: APP_SPEC_EVALUATION_ERRORS.trackedBranchMissing };
            }

            const file = await this.readSpecFile(context, commit.sha);
            if (file.status !== 'ok') {
                return { branch: null, error: APP_SPEC_EVALUATION_ERRORS.trackedBranchMissing };
            }

            const validation = validateAppSpecDocument(file.text as string, {
                mode: 'data-repository',
                context: this.ruleContext(context, true),
            });
            if (validation.errorCount > 0 || validation.spec === null) {
                return { branch: null, error: APP_SPEC_EVALUATION_ERRORS.trackedBranchMissing };
            }
            if (validation.spec.source?.branch !== declared) {
                return { branch: null, error: APP_SPEC_EVALUATION_ERRORS.trackedBranchMissing };
            }

            return { branch: declared, error: null };
        } catch {
            return { branch: null, error: APP_SPEC_EVALUATION_ERRORS.trackedBranchMissing };
        }
    }

    /**
     * The server-only rule input this service can answer honestly
     * (plan §2.2:139, §22:490-500).
     *
     * `recordedRelation` comes from the Work's own `sourceRepository.type` — the
     * value APW-01 wrote — so `source_relation_mismatch` means what it says: a hand
     * edit tried to turn a fork into a link. `trackedBranchExists` is `true` exactly
     * when the caller has just read the tracked branch's head.
     *
     * Everything else is left **absent on purpose**: §22:502 makes an absent input
     * *unknown*, so no rule fires on a guess. The Apps catalog does not exist in this
     * tree (T20–T29), the deploy target belongs to APW-06 and the licence registry to
     * T31 — a `null` there is the honest answer, and passing a guess would invent
     * warnings on every App Work.
     */
    private ruleContext(context: AppSpecWorkContext, trackedBranchExists: boolean): RuleContext {
        return {
            recordedRelation: context.recordedRelation,
            // 🛑 `trackedBranchExists` is passed ONLY when it is true. `false` is not
            // "unknown" — it is the positive statement "the tracked branch could not
            // be read", and `checkTrackedBranch` answers it with the ERROR
            // `tracked_branch_missing` (`app-spec.validate.ts:714-734`). A read that
            // resolved a commit has proved the branch exists; a read that did not is
            // `null`/absent, which §22:502 defines as unknown and which skips the
            // rule. Passing `false` there would mark every valid spec invalid.
            ...(trackedBranchExists ? { trackedBranchExists: true } : {}),
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Small shapes
    // ────────────────────────────────────────────────────────────────────────

    /** A fully-populated outcome, so no caller ever reads an `undefined` field. */
    private baseOutcome(
        workId: string,
        overrides: Partial<AppSpecEvaluationOutcome> = {},
    ): AppSpecEvaluationOutcome {
        return {
            workId,
            status: 'evaluated',
            trigger: null,
            validationStatus: null,
            headCommitSha: null,
            headSpecHash: null,
            effectiveCommitSha: null,
            effectiveSpecHash: null,
            errorCount: 0,
            warningCount: 0,
            written: false,
            superseded: false,
            applied: false,
            previousCommitSha: null,
            trackedBranchMoved: false,
            trackedBranch: null,
            activityRecorded: false,
            eventEmitted: false,
            passes: 0,
            error: null,
            durationMs: 0,
            ...overrides,
        };
    }
}

/** What one effective-spec transition carries into the Activity row and the event. */
interface AppSpecTransition {
    readonly commitSha: string;
    readonly previousCommitSha: string | null;
    readonly specHash: string;
    readonly previousSpec: AppSpec | null;
    readonly spec: AppSpec;
    readonly addedDependencies: readonly string[];
    readonly changedEnvNames: readonly string[];
    readonly changedBlocks: readonly string[];
}

/** The dependency kinds a spec declares, in the contract's own order. */
const DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage', 'smtp'] as const;

/** Kinds declared now and not declared before — what APW-07 has provisioned nothing for. */
function addedDependencies(before: AppSpec | null, after: AppSpec | null): readonly string[] {
    const previous = before?.dependencies ?? {};
    const next = after?.dependencies ?? {};
    return DEPENDENCY_KINDS.filter(
        (kind) =>
            Boolean((next as Record<string, unknown>)[kind]) &&
            !(previous as Record<string, unknown>)[kind],
    );
}

/**
 * `env[].name` of every entry added, changed or removed between two effective
 * specs. **Names only** — never a value, a default, an example or a prompt (R8,
 * FR-6): the comparison is over the entry's whole declaration, and only the name
 * leaves this function.
 */
function changedEnvNames(before: AppSpec | null, after: AppSpec | null): readonly string[] {
    const previous = new Map<string, string>();
    for (const entry of before?.env ?? []) {
        if (entry?.name) {
            previous.set(entry.name, JSON.stringify(entry));
        }
    }

    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of after?.env ?? []) {
        if (!entry?.name || seen.has(entry.name)) {
            continue;
        }
        seen.add(entry.name);
        if (previous.get(entry.name) !== JSON.stringify(entry)) {
            names.push(entry.name);
        }
    }
    for (const name of previous.keys()) {
        if (!seen.has(name)) {
            names.push(name);
            seen.add(name);
        }
    }
    return names;
}

/**
 * The top-level `spec` keys whose value changed — what APW-05 grades a rebuild on
 * (`changedBlocks` includes `build` or `checks` ⇒ prepare) and what APW-08's loop
 * reads. `kind` and `appSpecVersion` are envelope keys, not blocks, and are not
 * reported; a `null` previous spec reports every key the new one declares.
 */
function changedBlocks(before: AppSpec | null, after: AppSpec | null): readonly string[] {
    const source = (after ?? {}) as Record<string, unknown>;
    const previous = (before ?? {}) as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(source), ...Object.keys(previous)]);
    keys.delete('kind');
    keys.delete('appSpecVersion');

    const changed: string[] = [];
    for (const key of [...keys].sort()) {
        if (JSON.stringify(source[key]) !== JSON.stringify(previous[key])) {
            changed.push(key);
        }
    }
    return changed;
}

/** The first 10 issue codes, in the validator's order (plan §6.2:666-669). */
function firstCodes(issues: readonly AppSpecIssue[]): readonly string[] {
    return issues.slice(0, 10).map((issue) => issue?.code ?? '');
}

/** The relation APW-01 recorded, when it is one this epic's rules understand. */
function recordedRelationOf(work: {
    sourceRepository?: { type?: string | null } | null;
}): AppSpecSourceRelation | null {
    const type = work?.sourceRepository?.type;
    if (!type) {
        return null;
    }
    for (const mode of Object.keys(APP_SOURCE_REPOSITORY_TYPE_BY_MODE) as AppRepositoryMode[]) {
        if (APP_SOURCE_REPOSITORY_TYPE_BY_MODE[mode] === type) {
            return mode as AppSpecSourceRelation;
        }
    }
    return null;
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
