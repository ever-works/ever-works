import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_FORK_READINESS_POLL_DELAYS_MS,
    APP_FORK_READINESS_POLL_INTERVAL_MS,
    APP_FORK_READINESS_TIMEOUT_ENV,
    APP_FORK_READINESS_TIMEOUT_MS,
    APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS,
    APP_PRIVATE_COPY_MAX_SIZE_KB,
    type AppReadinessFailureReason,
    type AppRepositoryMode,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService, GitOperationNotSupportedError } from '../facades/git.facade';
import {
    AppActionsHygieneService,
    type AppActionsHygieneResult,
} from './app-actions-hygiene.service';
import {
    APP_FORK_READY_HANDLER,
    type AppForkReadyHandler,
    type AppForkReadyOutcome,
} from './app-fork-ready-handler.port';
import {
    AppUpstreamStateService,
    APP_WORK_GIT_PROVIDER_ID,
    type AppForkReadinessJobPayload,
    type AppReadinessAttempt,
    type AppReadinessProbe,
} from './app-upstream-state.service';

/**
 * APW-02 T24 — the readiness run (plan §6.2, spec FR-17…FR-24a, ACC-02-04…06).
 *
 * ## What one run does
 *
 *   1. stamp the attempt (`beginAttempt`) and stop immediately when there is nothing
 *      to wait for — no state row, or a Work already `ready`;
 *   2. for a private copy that has not been pushed yet, push the upstream's default
 *      branch with full history into the empty repository (FR-21);
 *   3. poll the Work Repository at 2, 4, 8 and 15 seconds and then every 15 seconds
 *      until its default branch has a commit, for at most 15 minutes (FR-17, FR-18);
 *   4. run Actions hygiene for a fork or a copy (FR-22, FR-25);
 *   5. call the setup hand-off once and record what it answered (FR-22, FR-24a).
 *
 * ## Why it polls instead of subscribing
 *
 * GitHub creates a fork asynchronously: the API answers with a repository that is
 * readable seconds later and populated later still, and there is no webhook a member's
 * own account can be made to deliver. So the wait is a poll, and the poll is a
 * **background job** (Constitution IV) whose sleeps are handed in — `run(payload, {
 * sleep })` — which is what keeps a Trigger.dev machine free while it waits, and what
 * makes the schedule testable without waiting fifteen minutes.
 *
 * ## The three ways a run ends without a ready repository
 *
 *   - **`timed_out`** — the deadline (FR-18) passed with the repository still empty.
 *     One Activity entry, emitted once per attempt by `AppUpstreamStateService.timeout`
 *     (FR-18's "then marked timed out with one Activity entry").
 *   - **`access_revoked`** — the credential died while preparing (FR-20); **Try again**
 *     is what resumes it, and this run never re-forks (FR-19).
 *   - **the copy was refused** — the upstream is over 500 MB or uses LFS (FR-21), or the
 *     provider cannot do the copy at all (plan §7). The reason is recorded and the run
 *     stops; there is nothing to poll for.
 *
 * ## What this service deliberately does NOT do
 *
 * It never forks, never creates a repository and never opens a pull request. The fork
 * is APW-01's create path (FR-10), the setup pull request belongs to the registered
 * handler (FR-24a), and "Try again" resumes *this* repository rather than requesting
 * another one (FR-19) — which is exactly why the private-copy push is keyed on
 * `copyPushedSha` and is skipped once it is set (FR-21's "safe to repeat").
 */

/**
 * FR-18's deadline (900 000 ms = 15 minutes), with FR-18a's non-production override.
 *
 * The override exists so an automated acceptance test can reach **timed out** without
 * waiting a quarter of an hour. Two properties are load-bearing and both are asserted:
 * a **production** installation ignores the variable entirely, and any value outside
 * `5 000 … 900 000` is clamped rather than trusted. An unparseable value is not an
 * override at all — the default stands, so a typo shortens nothing.
 */
export function resolveReadinessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const fallback = APP_FORK_READINESS_TIMEOUT_MS;
    if (env.NODE_ENV === 'production') {
        return fallback;
    }

    const raw = String(env[APP_FORK_READINESS_TIMEOUT_ENV] ?? '').trim();
    if (!/^\d+$/.test(raw)) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS), fallback);
}

/**
 * What the task hands the run: the job runtime's wait, and — for tests and for a run
 * that wants a deterministic clock — the current instant.
 *
 * `sleep` is the whole reason polling does not hold a machine (the task passes
 * `wait.for({ seconds: ms / 1000 })`), and `now` defaults to `Date.now` so the plan's
 * `run(payload, { sleep })` signature is unchanged for every caller. It is injectable
 * because the deadline, the rate-limit wait and the poll schedule are all clock
 * arithmetic, and a test that has to wait 900 real seconds is a test nobody runs.
 */
export interface AppForkReadinessDeps {
    sleep: (ms: number) => Promise<void>;
    now?: () => number;
}

/** How one readiness run ended, with the counters plan §9.1's telemetry wants. */
export interface AppForkReadinessRunResult {
    workId: string;
    attempt: number;
    outcome:
        | 'not_found'
        | 'already_ready'
        | 'ready'
        | 'waiting_for_setup_pr'
        | 'failed'
        | 'timed_out'
        | 'setup_merged';
    /** The reason code recorded on the row (`access_revoked`, `too_large`, …). */
    reason?: string;
    /** How many readiness probes this run made. */
    probes: number;
    /** Every wait this run took, in order — the poll schedule, in one array. */
    sleeps: number[];
    /** Wall-clock milliseconds from the first probe to the last. */
    elapsedMs: number;
    /** The head the private copy pushed, when this run pushed one. */
    copyPushedSha?: string;
    /** What hygiene answered, when it ran. */
    hygiene?: AppActionsHygieneResult;
    /** What the setup hand-off answered, when it ran. */
    handler?: AppForkReadyOutcome;
}

// ── provisional seam ────────────────────────────────────────────────────────
//
// One token whose owner task has not landed. It is declared with the exact name and
// shape its owner fixes (APW-04 plan §6.5), in the same style as the state service's
// provisional block (`app-upstream-state.service.ts`): the runtime contract — the token
// identity, the argument, the resolved value — is already the final one, so the swap
// below changes an import and nothing else.
//
// 🛑 **The swap is mandatory, not cosmetic:** a Nest token is compared by identity, so
// two Symbols that happen to share a name are two different tokens. If APW-04 lands its
// own declaration and this block is left in place, the owner's binding will not reach
// this injection — provisioning would silently never be notified.

/**
 * _Provisional — APW-04 T? (`packages/agent/src/app-provisioning/app-provision-events.port.ts`,
 * `APW-04-app-provisioner/plan.md` §6.5)._
 *
 * The consumer half of that port and nothing more: `forkReady(workId)` is what APW-04
 * answers when it is told the Work Repository has content. When APW-04 lands, delete
 * this block and import `APP_PROVISION_EVENTS_PORT` (and its full interface) from
 * `../app-provisioning/app-provision-events.port`.
 */
export interface AppProvisionEventsPort {
    forkReady(workId: string): Promise<void> | void;
}

/** DI token for {@link AppProvisionEventsPort} — owned by APW-04. */
export const APP_PROVISION_EVENTS_PORT = Symbol('APP_PROVISION_EVENTS_PORT');

@Injectable()
export class AppForkReadinessService {
    private readonly logger = new Logger(AppForkReadinessService.name);

    constructor(
        /** The one writer of the state row — a remote proxy in the worker (plan §2.4). */
        private readonly states: AppUpstreamStateService,
        private readonly git: GitFacadeService,
        private readonly hygiene: AppActionsHygieneService,
        // The owner of the Work, and therefore whose credential the private-copy push is
        // made with. It is injected rather than assumed because the facade resolves a
        // token per USER (`GitFacadeUserAuth`), and this job's payload carries only the
        // Work. In the worker this is already a remote proxy — the same shape
        // `TriggerWorkerModule` binds for every repository the job reads.
        @Optional() private readonly works?: WorkRepository,
        // Both hand-offs are optional and appended last, in the order the plan names them:
        // an installation without APW-01's handler records `initialized` and comes to rest
        // `ready` (R-4's fail-closed default), and one without APW-04's port provisions
        // nothing. Neither absence may fail a readiness run.
        @Optional()
        @Inject(APP_FORK_READY_HANDLER)
        private readonly handler?: AppForkReadyHandler,
        @Optional()
        @Inject(APP_PROVISION_EVENTS_PORT)
        private readonly provisionEvents?: AppProvisionEventsPort,
    ) {}

    /**
     * One readiness attempt (plan §6.2, steps 0–5). Resolves with what happened; it does
     * not throw for a repository that is not ready — that is the normal case this job
     * exists for.
     */
    async run(
        payload: AppForkReadinessJobPayload,
        deps: AppForkReadinessDeps,
    ): Promise<AppForkReadinessRunResult> {
        const workId = payload.workId;
        const attempt = payload.attempt ?? 1;
        const providerId = payload.providerId ?? APP_WORK_GIT_PROVIDER_ID;
        const now = deps.now ?? Date.now;
        const timeoutMs = resolveReadinessTimeoutMs();
        const sleeps: number[] = [];

        const result: AppForkReadinessRunResult = {
            workId,
            attempt,
            outcome: 'not_found',
            probes: 0,
            sleeps,
            elapsedMs: 0,
        };

        // ── step 1: the attempt, and the two exits that cost nothing ──────────
        const attemptState = await this.safe(() => this.states.beginAttempt(workId, attempt));
        if (!attemptState) {
            result.outcome = 'failed';
            result.reason = 'state_unavailable';
            return result;
        }
        if (!attemptState.found) {
            result.outcome = 'not_found';
            result.reason = 'state_not_found';
            return result;
        }
        if (attemptState.ready) {
            // FR-22: readiness is reached once. A re-dispatched job that finds the Work
            // already ready exits without polling, without hygiene and without a second
            // setup call.
            result.outcome = 'already_ready';
            return result;
        }

        // FR-24a: this run IS the setup-pull-request follow-through — the source is on
        // the default branch already, so steps 2–4 are skipped and the handler runs once
        // more to perform its follow-ups exactly once (`unchanged`).
        const setupMerged = payload.reason === 'setup_merged';
        if (!setupMerged) {
            const copy = await this.pushPrivateCopy(workId, attemptState, result);
            if (copy.stop) {
                return copy.result;
            }

            const polled = await this.poll(workId, attemptState, providerId, {
                attempt,
                timeoutMs,
                now,
                deps,
                sleeps,
                result,
            });
            if (polled.stop) {
                return polled.result;
            }

            // ── step 4: hygiene (FR-22, FR-25) — forks and copies only, never fatal ──
            result.hygiene = await this.runHygiene(workId, attemptState);
        }

        // ── step 5: the setup hand-off, once ───────────────────────────────────
        const outcome = await this.callHandler(workId);
        result.handler = outcome;

        const resolution = await this.safe(() => this.states.markReady(workId, outcome));
        if (!resolution) {
            this.logger.warn(
                `App fork readiness: recording the outcome of work ${workId} failed; the setup itself is unaffected.`,
            );
        }

        // APW-04 is told the repository is ready only when it actually is (see the
        // provisional port note below): a `failed` handler outcome leaves the row in
        // `failed`, and "forkReady" for a repository whose setup failed would be a false
        // statement to the epic that provisions it.
        const settledState = resolution?.state ?? null;
        if (settledState === 'ready' || settledState === 'waiting_for_setup_pr') {
            await this.notifyProvisioning(workId);
        }

        result.outcome = setupMerged
            ? 'setup_merged'
            : outcome.result === 'failed'
              ? 'failed'
              : outcome.result === 'waiting_for_setup_pr'
                ? 'waiting_for_setup_pr'
                : 'ready';
        if (outcome.result === 'failed') {
            result.reason = outcome.reason ?? 'handler_failed';
        }

        return result;
    }

    // ── step 2: the private copy (FR-21) ─────────────────────────────────────

    /**
     * Push the upstream default branch, with full history, into the empty Work
     * Repository — once.
     *
     * `copyPushedSha` is the idempotency key (FR-21's "safe to repeat"): a re-dispatched
     * job that finds it set does not push again, and a push that has already happened is
     * never undone. `AppUpstreamStateService`'s `retryReadiness` keeps the column on
     * purpose, so **Try again** resumes the same copy rather than re-uploading it.
     *
     * A refusal is terminal for the attempt and is recorded as the row's reason: an
     * upstream over `APP_PRIVATE_COPY_MAX_SIZE_KB` or one that uses Git LFS cannot be
     * copied at all, and polling would only turn that into a fifteen-minute timeout that
     * says nothing.
     */
    private async pushPrivateCopy(
        workId: string,
        attemptState: AppReadinessAttempt,
        result: AppForkReadinessRunResult,
    ): Promise<{ stop: boolean; result: AppForkReadinessRunResult }> {
        const relation = attemptState.relation;
        if (relation !== 'private-copy' || attemptState.copyPushedSha) {
            return { stop: false, result };
        }

        const upstreamOwner = attemptState.upstreamOwner;
        const upstreamRepo = attemptState.upstreamRepo;
        const targetOwner = attemptState.dataOwner;
        const targetRepo = attemptState.dataRepo;
        const sourceBranch = attemptState.upstreamDefaultBranch ?? attemptState.dataDefaultBranch;
        if (!upstreamOwner || !upstreamRepo || !targetOwner || !targetRepo || !sourceBranch) {
            // A copy without both sets of coordinates cannot be made, and guessing one
            // would push the wrong history into the wrong repository.
            return this.failedCopy(workId, result, 'copy_refused');
        }

        // The push is made with the WORK OWNER's credential — a copy attributed to the
        // platform would land in a repository the member does not control.
        const work = await this.safe(() => this.works.findById(workId));
        const userId = work?.userId;
        if (!userId) {
            this.logger.warn(
                `App fork readiness: the owner of work ${workId} could not be read, so the private copy cannot be made.`,
            );
            return this.failedCopy(workId, result, 'copy_refused');
        }

        try {
            const copy = await this.git.createRepositoryCopy(
                {
                    sourceOwner: upstreamOwner,
                    sourceRepo: upstreamRepo,
                    sourceBranch,
                    targetOwner,
                    targetRepo,
                    // APW-01's constant, imported rather than redeclared (plan §3.4).
                    maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
                },
                { userId, providerId: APP_WORK_GIT_PROVIDER_ID, workId },
            );

            if (copy?.pushedSha) {
                await this.safe(() => this.states.recordCopyPushed(workId, copy.pushedSha));
                result.copyPushedSha = copy.pushedSha;
            }
            return { stop: false, result };
        } catch (error) {
            const reason = copyRefusalReason(error);
            this.logger.warn(
                `App fork readiness: the private copy for work ${workId} was refused (${reason}).`,
            );
            return this.failedCopy(workId, result, reason);
        }
    }

    private async failedCopy(
        workId: string,
        result: AppForkReadinessRunResult,
        reason: AppReadinessFailureReason,
    ): Promise<{ stop: boolean; result: AppForkReadinessRunResult }> {
        await this.safe(() => this.states.fail(workId, reason));
        result.outcome = 'failed';
        result.reason = reason;
        return { stop: true, result };
    }

    // ── step 3: the poll (FR-17, FR-18, FR-20) ───────────────────────────────

    /**
     * Poll until the Work Repository has a commit, the credential dies, or the deadline
     * passes.
     *
     * The schedule is the contract's `[2 000, 4 000, 8 000, 15 000]` and then every
     * 15 000 ms (FR-18), and the wait happens **before** each probe, so the recorded
     * sleeps are exactly that schedule. A wait that would cross the deadline is not
     * taken at all: the run ends `timed_out` at or before 900 000 ms rather than after
     * it, which is what "for at most 15 minutes" means.
     *
     * A rate limit is the one probe answer that overrides the schedule: the provider
     * names the instant it will answer again (FR-50), and sleeping to it — bounded by
     * the deadline — is the difference between waiting once and hammering a limiter for
     * fifteen minutes.
     */
    private async poll(
        workId: string,
        attemptState: AppReadinessAttempt,
        providerId: string,
        context: {
            attempt: number;
            timeoutMs: number;
            now: () => number;
            deps: AppForkReadinessDeps;
            sleeps: number[];
            result: AppForkReadinessRunResult;
        },
    ): Promise<{ stop: boolean; result: AppForkReadinessRunResult }> {
        const { attempt, timeoutMs, now, deps, sleeps, result } = context;
        const startedAt = now();
        let index = 0;
        // Set by a rate-limited probe: the wait that REPLACES the next scheduled delay
        // rather than adding to it, so a limiter is honoured once and not twice.
        let nextDelay: number | null = null;

        for (;;) {
            const delay = nextDelay ?? pollDelay(index++);
            nextDelay = null;

            const elapsed = now() - startedAt;
            result.elapsedMs = elapsed;
            if (elapsed + delay > timeoutMs) {
                await this.safe(() => this.states.timeout(workId, attempt));
                result.outcome = 'timed_out';
                result.reason = 'timed_out';
                return { stop: true, result };
            }

            await deps.sleep(delay);
            sleeps.push(delay);

            const probe = await this.safe(() => this.states.probeReadiness(workId, providerId));
            result.probes++;
            result.elapsedMs = now() - startedAt;

            if (!probe) {
                // The probe itself could not be made (the remote proxy is unreachable).
                // One lost probe is not a lost Work: the next one may answer, and the
                // deadline is what ends the wait.
                continue;
            }

            if (probe.status === 'ready') {
                return { stop: false, result };
            }

            if (probe.status === 'access_revoked') {
                // FR-20: losing access while preparing is terminal for the attempt, and
                // Try again resumes it once access is restored (FR-19) — this run never
                // asks for another fork.
                await this.safe(() => this.states.fail(workId, 'access_revoked'));
                result.outcome = 'failed';
                result.reason = 'access_revoked';
                return { stop: true, result };
            }

            if (probe.status === 'failed') {
                const reason = probe.reason ?? 'provider_unsupported';
                await this.safe(() => this.states.fail(workId, reason));
                result.outcome = 'failed';
                result.reason = reason;
                return { stop: true, result };
            }

            // FR-50: sleep to the provider's own retry instant instead of the schedule,
            // bounded by the deadline — a wait that long is a timeout, not a poll.
            const rateLimited = rateLimitDelay(probe, now, timeoutMs - (now() - startedAt));
            if (rateLimited !== null && rateLimited > 0) {
                nextDelay = rateLimited;
            }
        }
    }

    // ── steps 4 and 5 ────────────────────────────────────────────────────────

    /** Hygiene for a fork or a copy (FR-22). Never fatal: its own result carries the state. */
    private async runHygiene(
        workId: string,
        attemptState: AppReadinessAttempt,
    ): Promise<AppActionsHygieneResult | undefined> {
        const relation: AppRepositoryMode | null = attemptState.relation;
        if (relation !== 'fork' && relation !== 'private-copy') {
            // A linked repository is never touched (FR-31); the service answers
            // `not_applicable` for it, so it is asked and its answer is recorded rather
            // than assumed.
            if (relation !== 'link') {
                return undefined;
            }
        }

        try {
            return await this.hygiene.apply(workId, {
                relation,
                dataOwner: attemptState.dataOwner,
                dataRepo: attemptState.dataRepo,
            });
        } catch (error) {
            // The service is built never to throw (FR-30). If it somehow does, readiness
            // still finishes: a repository whose workflows could not be cleaned is still
            // a repository the member can run.
            this.logger.warn(
                `App fork readiness: Actions hygiene for work ${workId} failed (${errorText(error)}); readiness continues.`,
            );
            return undefined;
        }
    }

    /**
     * The setup hand-off, exactly once per attempt (FR-22, R-4).
     *
     * Unbound ⇒ `initialized`, which APW-01's port documents as the fail-closed default.
     * A handler that throws is treated as `{ result: 'failed' }` and never as an
     * exception: the Work must come to rest somewhere a member can see, and a readiness
     * job that dies leaves it in `preparing` until the sweeper gives up on it.
     */
    private async callHandler(workId: string): Promise<AppForkReadyOutcome> {
        if (!this.handler) {
            return { result: 'initialized' };
        }

        try {
            const outcome = await this.handler.onDataRepositoryReady({ workId });
            if (!outcome || typeof outcome.result !== 'string') {
                return { result: 'failed', reason: 'unexpected' };
            }
            return outcome;
        } catch (error) {
            this.logger.warn(
                `App fork readiness: the setup hand-off for work ${workId} threw (${errorText(error)}).`,
            );
            return { result: 'failed', reason: 'unexpected' };
        }
    }

    /** APW-04's `forkReady(workId)` — fire-and-forget, failures logged only. */
    private async notifyProvisioning(workId: string): Promise<void> {
        if (!this.provisionEvents) {
            return;
        }
        try {
            await this.provisionEvents.forkReady(workId);
        } catch (error) {
            this.logger.warn(
                `App fork readiness: notifying the provisioning port for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    /** A state call that must not take the run down with it. */
    private async safe<T>(call: () => Promise<T>): Promise<T | null> {
        try {
            return await call();
        } catch (error) {
            this.logger.warn(`App fork readiness: a state call failed (${errorText(error)}).`);
            return null;
        }
    }
}

/** The poll schedule of FR-18: 2, 4, 8, 15 seconds, then every 15 seconds. */
function pollDelay(index: number): number {
    const delays = APP_FORK_READINESS_POLL_DELAYS_MS;
    return index < delays.length ? delays[index] : APP_FORK_READINESS_POLL_INTERVAL_MS;
}

/**
 * How long to wait after a rate-limited probe, or `null` when the probe was not rate
 * limited (FR-50). A `retryAt` already in the past is not a wait at all — the schedule
 * applies — so a provider that reports a stale reset cannot make the job spin.
 */
function rateLimitDelay(
    probe: AppReadinessProbe,
    now: () => number,
    remainingMs: number,
): number | null {
    if (probe.status !== 'rate_limited' || !probe.retryAt) {
        return null;
    }
    const retryAtMs = Date.parse(probe.retryAt);
    if (!Number.isFinite(retryAtMs) || retryAtMs <= now()) {
        return null;
    }
    return Math.max(0, Math.min(retryAtMs - now(), Math.max(0, remainingMs)));
}

/**
 * Which refusal a failed private copy was, as a member of
 * `APP_READINESS_FAILURE_REASONS` (FR-65's closed set).
 *
 * The provider decides the first two and says so in the error's `message` — plan §4.3's
 * "`unprocessable` + `too_large`" and "`uses_lfs`" — while `reason` stays the contract's
 * `unprocessable`. `too_large` is itself a member of the closed set and is recorded
 * verbatim; `uses_lfs` is **not** a member (the plan §3.1 spelling and §3.4's union
 * disagree, and the union is the closed set FR-65 requires), so it is recorded as
 * `copy_refused` — the member that means exactly "the copy was refused", with the
 * provider's own words logged at the call site.
 */
function copyRefusalReason(error: unknown): AppReadinessFailureReason {
    if (error instanceof GitOperationNotSupportedError) {
        return 'provider_unsupported';
    }
    const message = error instanceof Error ? error.message : '';
    if (message === 'too_large') {
        return 'too_large';
    }
    if (message === 'git_operations_unavailable') {
        return 'provider_unsupported';
    }
    if (error instanceof GitProviderRequestError && error.reason === 'not_found') {
        return 'data_repository_missing';
    }
    return 'copy_refused';
}

/** A safe, log-injectable rendering of a caught value. */
function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}
