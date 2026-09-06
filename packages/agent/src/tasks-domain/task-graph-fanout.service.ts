import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
import { config } from '../config';
import { TaskStatus, type Task } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { RunDispatchGateService } from '../agents/run-dispatch-gate.service';
import { QUEUED_REASON_KILL_SWITCH } from '../agents/run-admission-chain';
import { RUN_KILL_SWITCH, type RunKillSwitch } from '../agents/run-kill-switch';
import { TaskTransitionService } from './task-transition.service';

/** Why one candidate did not start. Stable machine tokens. */
export type TaskFanoutSkipReason =
    | 'blocked'
    | 'no-agent'
    | 'already-run'
    | 'in-flight'
    | 'owner-bound'
    | 'owner-refused'
    | 'claim-lost';

export interface TaskFanoutEntry {
    taskId: string;
    taskSlug: string;
    outcome: 'started' | 'skipped' | 'failed';
    /** Set on `skipped`. */
    reason?: TaskFanoutSkipReason;
    message?: string;
}

export interface TaskFanoutSummary {
    limit: number;
    /** How many TODO Tasks the scan returned (before any filtering). */
    candidateCount: number;
    /**
     * Tasks CLAIMED into `in_progress` this tick. Deliberately not
     * "dispatched": the `→ in_progress` dispatch hook is fire-and-forget
     * (`TaskTransitionService.transition`), so this driver knows a Task
     * was claimed and handed to the dispatch path, not that a job runtime
     * accepted a run. Reporting a dispatch it cannot observe would be a
     * lie in an operator dashboard.
     */
    started: number;
    skipped: number;
    failed: number;
    /** True when the global stop flag stopped (or aborted) this tick. */
    halted: boolean;
    /** True when the driver is switched off (`<= 0` starts per owner). */
    disabled: boolean;
    /** The per-owner tick bound that was in force. */
    maxStartsPerOwner: number;
    entries: TaskFanoutEntry[];
}

function emptySummary(
    limit: number,
    maxStartsPerOwner: number,
    flags: { halted?: boolean; disabled?: boolean } = {},
): TaskFanoutSummary {
    return {
        limit,
        candidateCount: 0,
        started: 0,
        skipped: 0,
        failed: 0,
        halted: flags.halted ?? false,
        disabled: flags.disabled ?? false,
        maxStartsPerOwner,
        entries: [],
    };
}

/**
 * Task-graph fan-out (self-build slice AH, EW-801) — the bounded driver
 * that keeps more than one machine busy.
 *
 * ## The ceiling it removes
 *
 * A Task tree instantiated from a template is a DAG of TODO sub-tasks
 * wired together by `task_blocks`. Nothing walked that graph:
 * `TaskTransitionService.tryUnblockSingleTask` restores Tasks whose
 * status is literally `blocked`, so a TODO sub-task whose last blocker
 * finished simply waited for a human to drag it. This driver starts
 * every TODO Task with zero OPEN blockers instead.
 *
 * ## What "open blocker" means here
 *
 * Exactly what it means to the blocker gate — `listOpenBlockerIds` on
 * `TaskTransitionService`, called by this driver and by
 * `transition()` itself. There is no second definition to drift.
 *
 * ## What it will NOT touch
 *
 * "Still `todo`" does not mean "never started". Three shipped paths
 * dispatch a run and deliberately leave the Task in `todo`: board Run
 * (`TasksService.runTask`), the recurrence scan
 * (`TaskRecurrenceDispatcherService.dispatchDue`) and the Goal loop
 * (`GoalOrchestratorService.applyDispatch`). Each keys its own dedup
 * differently from the generation key this driver's dispatch would use,
 * so re-starting one of their Tasks would run the same work twice —
 * and, for a Goal, drive a serial loop past its own
 * `maxConcurrentIterations` ceiling. `findFanoutCandidates` therefore
 * takes only Tasks that have never been run (`startedAt` and
 * `latestRunId` both NULL) and never belonged to another driver
 * (`goalId` and `parentRecurringTaskId` both NULL), and
 * {@link priorRunSkipReason} re-checks the run history authoritatively
 * because the `latestRunId` denorm's write is best-effort.
 *
 * ## It cannot become a way past a limit
 *
 * Every start goes through `transition(→ in_progress)`, whose dispatch
 * hook is `TaskTransitionService.dispatchAgentRun` — THE dispatch path,
 * with its admission chain (global stop flag → per-Work valve →
 * per-org/user valve + plan entitlement → credits precheck), its
 * `agent_runs` reservation under the admission lock, and, downstream in
 * the worker, `AgentRunService.checkBudget`. This driver adds gates in
 * front of that; it removes none.
 *
 * Before it CLAIMS a Task it probes the gate with a verdict-only
 * `admit()` (the documented probe form, no `reserve`), so a refusal
 * leaves the Task in `todo` — startable again next tick — rather than
 * consuming it into `in_progress` with a parked run. And it re-reads the
 * global stop flag itself at tick level, fail-closed, so a stopped
 * platform starts nothing at all.
 *
 * ## Off by default
 *
 * `TASK_FANOUT_MAX_STARTS_PER_OWNER` defaults to `0`, which means the
 * driver starts nothing. This is the one thing on the platform that
 * begins work nobody clicked; it does not arrive switched on with a
 * deploy.
 */
@Injectable()
export class TaskGraphFanoutService {
    private readonly logger = new Logger(TaskGraphFanoutService.name);

    constructor(
        private readonly tasks: TaskRepository,
        // Every collaborator is @Optional() and appended in a stable order
        // so hand-rolled positional test constructions keep working (the
        // house idiom). Without `transitions` there is no dispatch path,
        // and the driver refuses rather than inventing one.
        @Optional() private readonly transitions?: TaskTransitionService,
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
        @Optional() private readonly runs?: AgentRunRepository,
        // The GLOBAL STOP FLAG, read at tick level as well as inside the
        // admission chain. Bound by the api-side @Global() AgentsModule;
        // unbound in unit tests and fleet-less installs.
        @Optional()
        @Inject(RUN_KILL_SWITCH)
        private readonly killSwitch?: RunKillSwitch,
    ) {}

    /**
     * One fan-out tick.
     *
     * @param limit how many TODO Tasks to SCAN (default
     *        `TASK_FANOUT_SCAN_LIMIT`). Not how many may start — that is
     *        `TASK_FANOUT_MAX_STARTS_PER_OWNER`, per owner.
     */
    async dispatchUnblocked(limit?: number): Promise<TaskFanoutSummary> {
        const scanLimit = limit ?? config.agents.getTaskFanoutScanLimit();
        const maxPerOwner = config.agents.getTaskFanoutMaxStartsPerOwner();

        // Off by default: no scan, no gate probe, no Task touched.
        if (maxPerOwner <= 0) {
            return emptySummary(scanLimit, maxPerOwner, { disabled: true });
        }
        if (!this.transitions) {
            // Loud degradation, matching every other driver in this file's
            // neighbourhood: report that nothing was attempted rather than
            // counting starts that never happened.
            this.logger.warn(
                'Task fan-out skipped: the transition service is not available on this install.',
            );
            return emptySummary(scanLimit, maxPerOwner);
        }
        if (await this.isHalted()) {
            return emptySummary(scanLimit, maxPerOwner, { halted: true });
        }

        const candidates = await this.tasks.findFanoutCandidates(scanLimit);
        const summary: TaskFanoutSummary = {
            ...emptySummary(scanLimit, maxPerOwner),
            candidateCount: candidates.length,
        };

        const startsByOwner = new Map<string, number>();
        const refusedOwners = new Set<string>();

        for (const task of candidates) {
            const owner = task.userId;
            // ── cheap, in-memory gates first ──────────────────────────
            if (refusedOwners.has(owner)) {
                this.skip(summary, task, 'owner-refused');
                continue;
            }
            if ((startsByOwner.get(owner) ?? 0) >= maxPerOwner) {
                this.skip(summary, task, 'owner-bound');
                continue;
            }

            try {
                // ── the graph gate: the SAME predicate transition() uses ──
                const openBlockers = await this.transitions.listOpenBlockerIds(task.id);
                if (openBlockers.length > 0) {
                    this.skip(summary, task, 'blocked', `${openBlockers.length} open blocker(s)`);
                    continue;
                }

                // A Task nobody can run must never be auto-started: a
                // human's TODO with no agent stays a human's TODO.
                const agentIds = await this.transitions.resolveDispatchAgentIds(task);
                if (agentIds.length === 0) {
                    this.skip(summary, task, 'no-agent');
                    continue;
                }

                // Already run, or still running. `transition()` would
                // refuse a Task that is no longer `todo`, but "still todo"
                // does NOT mean "never started": board Run
                // (`TasksService.runTask`), the recurrence scan and the
                // Goal loop all dispatch a run and deliberately leave the
                // row in `todo`. Their dedup keys differ from the
                // generation key this driver's dispatch would use, so
                // without this check the fan-out silently re-runs their
                // work the moment the first run goes terminal.
                const priorRun = await this.priorRunSkipReason(task, agentIds);
                if (priorRun) {
                    this.skip(summary, task, priorRun);
                    continue;
                }

                // ── the admission probe: BEFORE the claim, on purpose ──
                const verdict = await this.probeAdmission(task);
                if (verdict.abortTick) {
                    // The global stop flag came on mid-tick. Stop the
                    // whole tick — not just this owner — and leave every
                    // remaining candidate untouched in `todo`.
                    summary.halted = true;
                    this.logger.log(
                        'Task fan-out aborted: the global stop flag is set — remaining candidates left in todo.',
                    );
                    break;
                }
                if (!verdict.admitted) {
                    refusedOwners.add(owner);
                    this.skip(summary, task, 'owner-refused', verdict.queuedReason);
                    continue;
                }

                // ── the claim ─────────────────────────────────────────
                // `casUpdateStatus(todo → in_progress)` inside transition()
                // is the atomic claim: two overlapping ticks resolve to
                // exactly ONE winner, and the loser lands in the
                // BadRequest branch below as `claim-lost`. transition()
                // also re-checks blockers inside the claim, closing the
                // scan → claim window. Its `→ in_progress` hook performs
                // the dispatch through `dispatchAgentRun`; calling that
                // directly here as well would double-dispatch.
                await this.transitions.transition(task, TaskStatus.IN_PROGRESS);
                startsByOwner.set(owner, (startsByOwner.get(owner) ?? 0) + 1);
                summary.started += 1;
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    outcome: 'started',
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (err instanceof BadRequestException || err instanceof ConflictException) {
                    // A lost CAS, or a blocker that appeared between the
                    // scan and the claim. Neither is a failure: the Task is
                    // still `todo` (or already moved by whoever won) and is
                    // a candidate again next tick.
                    this.skip(summary, task, 'claim-lost', message);
                    continue;
                }
                this.logger.warn(`Task fan-out failed to start ${task.slug}: ${message}`);
                summary.failed += 1;
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    outcome: 'failed',
                    message,
                });
            }
        }

        if (summary.started > 0) {
            this.logger.log(
                `Task fan-out started ${summary.started} Task(s) of ${summary.candidateCount} candidate(s) ` +
                    `(bound ${maxPerOwner}/owner).`,
            );
        }
        return summary;
    }

    // ── internals ─────────────────────────────────────────────────

    private skip(
        summary: TaskFanoutSummary,
        task: Task,
        reason: TaskFanoutSkipReason,
        message?: string,
    ): void {
        summary.skipped += 1;
        summary.entries.push({
            taskId: task.id,
            taskSlug: task.slug,
            outcome: 'skipped',
            reason,
            ...(message ? { message } : {}),
        });
    }

    /**
     * Tick-level read of the global stop flag.
     *
     * 🛑 FAIL CLOSED. A flag that cannot be read is treated as SET, the
     * same posture `killSwitchAdmission` takes inside the admission
     * chain: the failure this flag exists to survive must not be the
     * thing that lets work through. Unbound port ⇒ no fleet stack ⇒
     * nothing to halt on.
     */
    private async isHalted(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            if (!(await this.killSwitch.shouldHaltDispatch())) return false;
        } catch (err) {
            this.logger.warn(
                `Task fan-out: global stop flag could not be read — skipping the tick (fail-closed): ${err}`,
            );
            return true;
        }
        this.logger.log('Task fan-out: global stop flag is set — no Task started this tick.');
        return true;
    }

    /**
     * Why this candidate must not be started because a run already
     * exists for it — `null` when it is genuinely un-run.
     *
     * `findLatestForTask` is the AUTHORITATIVE check (any run, any agent,
     * any status): it is the only one that catches a Task whose run has
     * already gone terminal while the row stayed `todo`, which is the end
     * state of every board Run, every recurrence instance and every Goal
     * iteration Task. `findFanoutCandidates` filters those out in SQL
     * too, but that filter reads `tasks.latestRunId`, a best-effort
     * denorm whose write is allowed to fail — so the authoritative query
     * runs here as well.
     *
     * The per-agent in-flight check stays behind it as the fallback for
     * repositories (and hand-built test stubs) that do not expose
     * `findLatestForTask`.
     */
    private async priorRunSkipReason(
        task: Task,
        agentIds: string[],
    ): Promise<TaskFanoutSkipReason | null> {
        if (!this.runs) return null;
        if (typeof this.runs.findLatestForTask === 'function') {
            if (await this.runs.findLatestForTask(task.id)) return 'already-run';
        }
        return (await this.allAgentsBusy(task, agentIds)) ? 'in-flight' : null;
    }

    /**
     * True when EVERY resolvable agent for this Task already has a
     * queued/running run on it. One free agent is enough to start.
     */
    private async allAgentsBusy(task: Task, agentIds: string[]): Promise<boolean> {
        if (!this.runs?.findInFlightForTaskAgent) return false;
        for (const agentId of agentIds) {
            const inFlight = await this.runs.findInFlightForTaskAgent(
                task.id,
                agentId,
                task.userId,
            );
            if (!inFlight) return false;
        }
        return true;
    }

    /**
     * Verdict-only admission probe — `admit()` WITHOUT `reserve`, which
     * is the documented probe form (`RunDispatchGateService.admit`:
     * "callers that only need the verdict"). It creates no run row and
     * consumes no slot; the authoritative admission still happens inside
     * `dispatchAgentRun` with the reservation attached.
     *
     * 🛑 Fails CLOSED here even though the valve itself is fail-open for
     * ordinary dispatch. A human clicking Run past a broken counting
     * query is one run; a driver doing it is a loop. When this driver
     * cannot get an answer it does not start the Task — the Task is not
     * lost, it is simply a candidate again next tick.
     */
    private async probeAdmission(
        task: Task,
    ): Promise<{ admitted: boolean; queuedReason?: string; abortTick?: boolean }> {
        if (!this.dispatchGate) return { admitted: true };
        let verdict: { admitted: boolean; queuedReason?: string };
        try {
            verdict = await this.dispatchGate.admit({
                userId: task.userId,
                workId: task.workId ?? null,
                organizationId: task.organizationId ?? null,
            });
        } catch (err) {
            this.logger.warn(
                `Task fan-out: admission probe failed for ${task.slug} — not starting it (fail-closed): ${err}`,
            );
            return { admitted: false, queuedReason: 'admission-probe-failed' };
        }
        if (verdict.admitted) return { admitted: true };
        // The chain's first middleware is the global stop flag. Its
        // reason means the whole platform is stopped, not that this owner
        // is saturated — so the tick ends rather than walking the rest of
        // the candidate list.
        if (verdict.queuedReason === QUEUED_REASON_KILL_SWITCH) {
            return { admitted: false, queuedReason: verdict.queuedReason, abortTick: true };
        }
        return { admitted: false, queuedReason: verdict.queuedReason };
    }
}
