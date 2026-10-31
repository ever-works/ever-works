import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { config } from '../config';
import { Mission, MissionStatus, MissionType } from '../entities/mission.entity';
import { WorkProposal, WorkProposalSource } from '../entities/work-proposal.entity';
import { WorkAgentService } from '../work-agent/work-agent.service';
import {
    IDEA_BUILD_EXECUTE_DISPATCHER,
    type IdeaBuildExecuteDispatcher,
} from '../work-agent/idea-build-executor.dispatcher';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { WorkProposalService } from '../user-research/work-proposal.service';
import { MAX_MISSION_WORKS_IN_PROMPT, type MissionWorkContext } from '../user-research/prompts';
import { WorkRepository } from '../database/repositories/work.repository';
import { matchesCron } from './cron-matcher';
import {
    DomainEventPublisher,
    recordAfterWrite,
} from '../domain-events/domain-event-publisher.service';
import { isAppWorkKind } from '@ever-works/contracts';
import { Task, TaskStatus } from '../entities/task.entity';
import { TasksService } from '../tasks-domain/tasks.service';
import { MissionWorkRepository } from '../database/repositories/mission-work.repository';
import {
    ownershipRelationScopeOf,
    ownershipScopeOf,
    type OwnershipScope,
} from '../database/ownership-scope';
import { AppChangeTelemetry } from '../app-works/app-change.telemetry';
import {
    APP_WORKS_TELEMETRY_SINK,
    type AppWorksTelemetrySink,
} from '../app-works/app-works-telemetry.service';
import {
    MISSION_TASK_OUTPUT_RELATIONS,
    normalizeMissionOutputMode,
    normalizeMissionTaskOutput,
    type MissionTaskOutput,
} from './mission-task-output';
import {
    MISSION_PLANNER_RECENT_TASKS,
    MissionTaskPlannerService,
    normalizeTaskTitle,
} from './mission-task-planner.service';

/** APW-08 T35 — at most this many App Works get Tasks per tick (plan §2.7). */
export const MISSION_TASK_OUTPUT_MAX_WORKS = 5;

/** APW-08 T35 (FR-52) — the label every Mission-filed Task carries. */
export const MISSION_TASK_LABEL = 'mission-task';

/**
 * Outcome of running a single Mission tick (either via the
 * scheduled dispatcher or via `runNow`). Mirrors the shape of
 * `WorkScheduleDispatcherSummary.entries` so the Trigger.dev
 * task can emit a uniform summary.
 */
export interface MissionTickOutcome {
    /** Mission was skipped this cycle and why. */
    outcome:
        | 'cron-no-match' // schedule didn't fire on this tick
        | 'cap-hit' // outstanding-Ideas cap reached
        | 'no-ideas' // generator returned 0 proposals
        | 'spawned' // 1+ Ideas created
        | 'tasks-filed' // APW-08 T35 — 1+ Tasks filed on the Mission's App Works
        | 'no-tasks' // APW-08 T35 — the Task branch ran and filed nothing
        | 'failed'; // generator threw
    message?: string;
    /** Number of new Ideas persisted (only meaningful for `spawned`). */
    ideasCreated?: number;
    /** Number of those Ideas that were queued for build (autoBuildWorks=true). */
    ideasQueued?: number;
    /** Current outstanding-Ideas count BEFORE this cycle ran (for `cap-hit` diagnostics). */
    outstanding?: number;
    /** Effective cap that was enforced (null = unlimited). */
    cap?: number | null;
    /** APW-08 T35 — Tasks filed on the Mission's App Works this tick. */
    tasksFiled?: number;
}

export interface MissionTickEntry extends MissionTickOutcome {
    missionId: string;
    userId: string;
}

export interface MissionTickSummary {
    /** Total ACTIVE+SCHEDULED Missions evaluated this tick. */
    evaluated: number;
    /** Missions whose schedule matched the tick AND that spawned ≥1 Idea. */
    ran: number;
    /** Missions skipped for any reason (cron-no-match, cap-hit, no-ideas). */
    skipped: number;
    /** Missions whose generator threw. */
    failed: number;
    entries: MissionTickEntry[];
}

/**
 * Platform-side fallback when the user has neither a per-Mission
 * cap nor a `missionDefaultOutstandingCap` pref set. Mirrors the
 * spec §6.3 default. Keep this in sync with the seed value of
 * `WorkAgentPreference.missionDefaultOutstandingCap` (Phase 0 PR 0.4).
 */
const PLATFORM_DEFAULT_OUTSTANDING_CAP = 20;

/**
 * Maximum Ideas to ask the generator for in a single tick, even
 * if the cap-headroom would allow more. Keeps token cost bounded
 * per tick and matches the existing user-research generator's
 * comfortable batch size (Phase 1 PR D's default of 3-5 was a
 * cadence default; we let Missions go a bit higher because each
 * Mission ticks less frequently than the user-research run).
 */
const MAX_IDEAS_PER_TICK = 5;

/**
 * Security (DoS hardening): upper bound on how many ACTIVE+SCHEDULED
 * Missions a single tick will load and evaluate. Without a bound the
 * per-minute tick query loads the entire table, so an attacker (or a
 * runaway script) mass-creating scheduled Missions could make every
 * tick slower and heavier until the worker stalls. 500 is far above
 * realistic deployment load, so legitimate behavior is unchanged; if
 * the bound is ever hit we log loudly (ops signal) and the overflow
 * simply waits for the ACTIVE+SCHEDULED set to shrink. Exported so
 * the unit tests pin the bound to the query.
 */
export const MISSION_TICK_MAX_PER_TICK = 500;

/**
 * Phase 3 PR J — Mission tick worker. Drives both the scheduled
 * dispatcher (via Trigger.dev cron `* * * * *`) and the manual
 * `runNow` button on the Mission detail page.
 *
 * Responsibilities:
 *   1. Find every ACTIVE+SCHEDULED Mission whose `schedule` cron
 *      matches the current tick.
 *   2. For each, count outstanding (PENDING/QUEUED/BUILDING)
 *      Ideas; if the count meets the effective cap, skip.
 *   3. Otherwise, call the proposal generator with a
 *      `missionContext` derived from the Mission's description
 *      and a `targetCount` bounded by the cap headroom and
 *      `MAX_IDEAS_PER_TICK`.
 *   4. Persist spawned Ideas with `source = MISSION` + `missionId`
 *      (the generator already wires both via
 *      `WorkProposalService.generate`'s opts).
 *   5. If `autoBuildWorks=true`, queue each new Idea for build so
 *      it lands in QUEUED immediately — the existing
 *      goal-execution path then picks it up like any other build.
 *
 * The service does NOT own the cron schedule itself — that's the
 * Trigger.dev task at `packages/tasks/src/tasks/trigger/mission-tick.task.ts`,
 * which calls `tickDue()` on every fire.
 */
@Injectable()
export class MissionTickService {
    private readonly logger = new Logger(MissionTickService.name);

    constructor(
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
        private readonly workProposals: WorkProposalService,
        private readonly workProposalRepo: WorkProposalRepository,
        private readonly workAgent: WorkAgentService,
        // Idea/mission lifecycle activity (PR-3) + Schedules P2 `mission_tick`
        // coverage — same @Optional() ActivityLogService (hand-rolled unit-test
        // constructors omit it; production DI provides it via ActivityLogModule
        // imported by MissionsModule).
        @Optional()
        private readonly activityLog?: ActivityLogService,
        // PR-4 — Idea build executor dispatch seam (same token the API
        // build path uses). Optional: unbound in tests / CLI, and only
        // ever consulted when the executor flag is on.
        @Optional()
        @Inject(IDEA_BUILD_EXECUTE_DISPATCHER)
        private readonly ideaBuildDispatcher?: IdeaBuildExecuteDispatcher,
        // Existing Works are handed to idea generation so a Mission can
        // propose improving one instead of always minting a new Work.
        // Optional so the hand-rolled unit-test constructors keep working;
        // when absent the generator simply sees no existing Works, which is
        // the previous behaviour.
        @Optional()
        private readonly works?: WorkRepository,
        // EW-P2-5 — `mission.status_changed` when a fatal tick fails the Mission.
        // TRAILING + @Optional(): absent records nothing.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // APW-08 T35 (FR-51…FR-54) — the Task branch: the planner, the Mission's Work relations,
        // the Tasks on those Works, and (lazily, no module cycle) TasksService to file and start
        // them. TRAILING + @Optional(): absent, a `tasks` Mission files nothing and says why.
        @Optional() private readonly taskPlanner?: MissionTaskPlannerService,
        @Optional() private readonly missionWorks?: MissionWorkRepository,
        @Optional() @InjectRepository(Task) private readonly taskRows?: Repository<Task>,
        @Optional() private readonly moduleRef?: ModuleRef,
        // APW-08 T43 — `mission.task_output.*` over the App Works sanitizer.
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        private readonly appWorksSink?: AppWorksTelemetrySink,
    ) {}

    /**
     * Evaluate every ACTIVE+SCHEDULED Mission against the current
     * tick. Returns a per-Mission outcome map so the Trigger.dev
     * task can return a structured summary (visible in the
     * Trigger.dev dashboard for ops).
     *
     * `now` is injectable for testability — production callers
     * leave it default.
     */
    async tickDue(now: Date = new Date()): Promise<MissionTickSummary> {
        const due = await this.missions.find({
            where: { status: MissionStatus.ACTIVE, type: MissionType.SCHEDULED },
            // Security (DoS hardening): bound the per-tick batch so an
            // unbounded number of scheduled Missions can't bloat every
            // tick. Oldest-first keeps the selection deterministic (a
            // flood of newly-created Missions cannot starve the
            // long-standing ones).
            order: { createdAt: 'ASC' },
            take: MISSION_TICK_MAX_PER_TICK,
        });
        if (due.length >= MISSION_TICK_MAX_PER_TICK) {
            this.logger.warn(
                `Mission tick loaded ${due.length} Missions — the per-tick bound ` +
                    `(MISSION_TICK_MAX_PER_TICK=${MISSION_TICK_MAX_PER_TICK}) was hit; ` +
                    `ACTIVE+SCHEDULED Missions beyond the bound were truncated this tick.`,
            );
        }
        const summary: MissionTickSummary = {
            evaluated: due.length,
            ran: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };
        for (const mission of due) {
            const outcome = await this.evaluateAndRun(mission, now, { allowCronMismatch: false });
            const entry: MissionTickEntry = {
                missionId: mission.id,
                userId: mission.userId,
                ...outcome,
            };
            summary.entries.push(entry);
            if (outcome.outcome === 'spawned' || outcome.outcome === 'tasks-filed') summary.ran += 1;
            else if (outcome.outcome === 'failed') summary.failed += 1;
            else summary.skipped += 1;

            // Schedules P2 — record every FIRED scheduled tick in the
            // Activity feed. A tick "fires" when its cron matched this
            // cycle; the no-match minutes — the vast majority — are
            // intentionally NOT logged so the feed isn't flooded once
            // per minute. The domain-model tick already emits a dedicated
            // lifecycle row for `failed` (mission_failed) and `cap-hit`
            // (mission_tick_capped), so only the outcomes without their
            // own row emit the generic `mission_tick`. Every fired tick
            // therefore lands exactly one Activity row, with no
            // double-logging. Best-effort + user-scoped to the owner.
            if (
                outcome.outcome === 'spawned' ||
                outcome.outcome === 'no-ideas' ||
                outcome.outcome === 'tasks-filed' ||
                outcome.outcome === 'no-tasks'
            ) {
                void this.emitMissionTick(mission, outcome);
            }
        }
        return summary;
    }

    /**
     * Emit a `mission_tick` ActivityLog row for a scheduled Mission whose
     * cron fired this cycle. FAILED status only for the generator-threw
     * outcome; every other fired outcome (spawned / no-ideas / cap-hit) is
     * a COMPLETED tick. Best-effort — wrapped so a logging failure can
     * never disrupt the tick loop.
     */
    private async emitMissionTick(mission: Mission, outcome: MissionTickOutcome): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: mission.userId,
                actionType: ActivityActionType.MISSION_TICK,
                action: 'mission.tick',
                status:
                    outcome.outcome === 'failed' ? ActivityStatus.FAILED : ActivityStatus.COMPLETED,
                summary: `Mission "${mission.title}" ticked (${outcome.outcome})`,
                details: {
                    missionId: mission.id,
                    outcome: outcome.outcome,
                    ideasCreated: outcome.ideasCreated ?? 0,
                    ideasQueued: outcome.ideasQueued ?? 0,
                    tasksFiled: outcome.tasksFiled ?? 0,
                    outstanding: outcome.outstanding ?? null,
                    cap: outcome.cap ?? null,
                    message: outcome.message ?? null,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Failed to emit mission_tick activity for mission ${mission.id}: ${message}`,
            );
        }
    }

    /**
     * Force-run a single Mission immediately, bypassing the cron
     * match check. Called from `MissionsService.runNow`. The cap
     * IS still enforced (otherwise repeated clicks could fill the
     * Mission with junk and bypass the user's own throttle).
     *
     * Returns the same outcome shape as a single `tickDue` entry
     * so the API controller can render a consistent response.
     */
    async runOnce(missionId: string, userId: string): Promise<MissionTickOutcome> {
        const mission = await this.missions.findOne({
            where: { id: missionId, userId },
        });
        if (!mission) {
            return { outcome: 'failed', message: 'mission-not-found' };
        }
        // Manual run-now is allowed from ACTIVE or PAUSED — the API
        // gate in `MissionsService.runNow` lets PAUSED through
        // (a paused user click is a legitimate "run this once even
        // though the cron is paused" request). Mirror it here so the
        // tick-service path doesn't reject what the API just accepted.
        // COMPLETED + FAILED remain forbidden (Codex review on PR #1013).
        if (mission.status !== MissionStatus.ACTIVE && mission.status !== MissionStatus.PAUSED) {
            return {
                outcome: 'failed',
                message: `mission-not-runnable (status=${mission.status})`,
            };
        }
        return this.evaluateAndRun(mission, new Date(), { allowCronMismatch: true });
    }

    // ─── internals ──────────────────────────────────────────────────

    private async evaluateAndRun(
        mission: Mission,
        now: Date,
        opts: { allowCronMismatch: boolean },
    ): Promise<MissionTickOutcome> {
        // Cron match check (skipped for runNow).
        if (!opts.allowCronMismatch) {
            if (!mission.schedule) {
                return { outcome: 'cron-no-match', message: 'no-schedule-set' };
            }
            let matched: boolean;
            try {
                matched = matchesCron(mission.schedule, now);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(
                    `Mission ${mission.id} has invalid schedule "${mission.schedule}": ${message}`,
                );
                return { outcome: 'failed', message: `invalid-schedule: ${message}` };
            }
            if (!matched) {
                return { outcome: 'cron-no-match' };
            }
        }

        // APW-08 T35 (FR-51) — the output mode decides what this tick files. `ideas` is every
        // Mission before P2, exactly as before; `both` runs the Ideas branch, then the Tasks one.
        const mode = normalizeMissionOutputMode(mission.outputMode);
        if (mode === 'tasks') return this.runTaskOutput(mission, now);
        const ideas = await this.runIdeaOutput(mission);
        if (mode === 'ideas' || ideas.outcome === 'failed') return ideas;
        const tasks = await this.runTaskOutput(mission, now);
        return { ...ideas, tasksFiled: tasks.tasksFiled ?? 0 };
    }

    /** The Ideas branch — what every Mission's tick did before APW-08 P2 (unchanged). */
    private async runIdeaOutput(mission: Mission): Promise<MissionTickOutcome> {
        // Outstanding-Ideas cap.
        const outstanding = await this.workProposalRepo.countOutstandingByMission(mission.id);
        const cap = await this.resolveEffectiveCap(mission);
        if (cap !== null && outstanding >= cap) {
            // PR-3 - the spec's "at-cap event into the activity log"
            // (spec §1.3) finally lands (review gap G3).
            await this.recordActivity(
                mission,
                ActivityActionType.MISSION_TICK_CAPPED,
                'tick-capped',
                {
                    outstanding,
                    cap,
                },
            );
            return {
                outcome: 'cap-hit',
                outstanding,
                cap,
                message: `outstanding=${outstanding} >= cap=${cap}`,
            };
        }

        // Determine batch size: cap headroom, bounded by MAX_IDEAS_PER_TICK.
        const headroom = cap === null ? MAX_IDEAS_PER_TICK : Math.max(1, cap - outstanding);
        const targetCount = Math.max(1, Math.min(headroom, MAX_IDEAS_PER_TICK));

        try {
            const result = await this.workProposals.generate(mission.userId, {
                source: WorkProposalSource.MISSION,
                missionId: mission.id,
                missionContext: {
                    description: mission.description,
                    // KB excerpts wiring lands when Phase 8 PR JJ
                    // mounts the per-Mission KB; until then the
                    // generator just gets the Mission's prose Goal.
                    existingWorks: await this.loadExistingWorks(mission),
                },
                targetCount,
            });

            if (result.status !== 'generated' || result.proposals.length === 0) {
                return {
                    outcome: 'no-ideas',
                    message: result.status === 'generated' ? 'empty-batch' : result.status,
                    outstanding,
                    cap,
                };
            }

            let queued = 0;
            if (mission.autoBuildWorks) {
                // PR-4 (review finding P3): when the executor flag is ON we
                // ALSO create a WorkAgentGoal per queued Idea and enqueue it
                // (mirroring the API build() path), so Mission-auto-queued
                // Ideas actually produce goals for the executor instead of
                // being stranded in QUEUED. When the flag is OFF this is
                // exactly today's behavior — queueForBuild only, no goal,
                // nothing executes.
                const executorEnabled = config.ideaBuildExecutor.isEnabled();
                for (const proposal of result.proposals) {
                    const queuedProposal = await this.workProposals.queueForBuild(
                        mission.userId,
                        proposal.id,
                    );
                    if (!queuedProposal) continue;
                    queued += 1;
                    if (executorEnabled) {
                        await this.createAndEnqueueBuildGoal(mission.userId, queuedProposal);
                    }
                }
            }

            return {
                outcome: 'spawned',
                ideasCreated: result.proposals.length,
                ideasQueued: queued,
                outstanding,
                cap,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(
                `Mission ${mission.id} tick failed for user ${mission.userId}: ${message}`,
                err as Error,
            );
            // PR-3 (review finding P4) - persist the fatal failure so the
            // FAILED status is finally reachable. Revivable: the user's
            // resume endpoint accepts FAILED. Best-effort - a persistence
            // error must not mask the original failure.
            try {
                const failed = await this.missions.update(
                    { id: mission.id, status: MissionStatus.ACTIVE },
                    { status: MissionStatus.FAILED },
                );
                if (failed.affected) {
                    await recordAfterWrite(
                        this.domainEvents,
                        (publisher, manager) =>
                            publisher.changed(
                                manager,
                                'mission',
                                mission.id,
                                'mission.status_changed',
                                {
                                    changedFields: ['status'],
                                    previous: { status: MissionStatus.ACTIVE },
                                    actor: { type: 'system', id: 'mission-tick', label: null },
                                },
                            ),
                        (message) => this.logger.warn(message),
                        `mission.status_changed for mission ${mission.id}`,
                    );
                }
                await this.recordActivity(
                    mission,
                    ActivityActionType.MISSION_FAILED,
                    'tick-failed',
                    {
                        message: message.slice(0, 500),
                    },
                );
            } catch (persistErr) {
                this.logger.warn(
                    `Mission ${mission.id}: failed to persist FAILED status: ${
                        persistErr instanceof Error ? persistErr.message : String(persistErr)
                    }`,
                );
            }
            return { outcome: 'failed', message };
        }
    }

    /**
     * PR-4 (review finding P3) — mirror the API `build()` path for a
     * Mission-auto-queued Idea: create a `WorkAgentGoal`
     * (`maxWorksPerRun=1` + `ideaId`) and enqueue it onto the Idea
     * build executor. Only called when the executor flag is on.
     *
     * Best-effort per Idea: a failure here (e.g. the Mission owner has
     * not enabled the Work agent, so `createGoal` throws) is logged and
     * swallowed — the Idea is already QUEUED (today's behavior), so the
     * tick is never failed and other Ideas in the batch still proceed.
     */
    /**
     * The Works idea generation should know about for this Mission.
     *
     * A Mission orchestrates Works; without this the generator only sees the
     * Mission's own prose and can therefore only ever propose building
     * something new, even when extending an existing Work is the right
     * answer.
     *
     * Scoped to the Mission owner's Works — the same scope every other
     * Mission read uses. Best-effort: a failure here degrades idea quality,
     * so it must not abort the tick.
     */
    private async loadExistingWorks(mission: Mission): Promise<MissionWorkContext[]> {
        if (!this.works) {
            return [];
        }

        try {
            const works = await this.works.findByUser(mission.userId);
            return works.slice(0, MAX_MISSION_WORKS_IN_PROMPT).map((work) => ({
                name: work.name,
                slug: work.slug,
                kind: work.kind ?? null,
                description: work.description ?? null,
            }));
        } catch (error) {
            this.logger.warn(
                `Mission ${mission.id}: failed to load existing Works for idea context: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }

    private async createAndEnqueueBuildGoal(userId: string, proposal: WorkProposal): Promise<void> {
        try {
            // PR-4 x PR-5 — the build-request factory was renamed from
            // createGoal → createBuildRequest ({ goal } → { buildRequest }).
            const { buildRequest } = await this.workAgent.createBuildRequest(userId, {
                instruction: proposal.generatedPrompt?.trim() || proposal.description.trim(),
                maxWorksPerRun: 1,
                ideaId: proposal.id,
            });
            if (this.ideaBuildDispatcher) {
                await this.ideaBuildDispatcher.enqueue({
                    goalId: buildRequest.id,
                    userId,
                    ideaId: proposal.id,
                });
            } else {
                this.logger.warn(
                    `Idea build executor enabled but no dispatcher bound; ` +
                        `mission build request ${buildRequest.id} for idea ${proposal.id} will not execute.`,
                );
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `Mission auto-build goal creation failed for idea ${proposal.id} ` +
                    `(user ${userId}): ${message}`,
            );
        }
    }

    /**
     * Resolve the cap for a Mission, in priority order:
     *   1. Per-Mission `outstandingIdeasCap` if set (incl. -1).
     *   2. User pref `missionDefaultOutstandingCap` if set
     *      (incl. -1 = user-set "unlimited" sentinel).
     *   3. Platform default (20).
     *
     * Returns `null` for unlimited (sentinel -1 in either source),
     * `number` otherwise. The caller checks `outstanding >= cap`
     * (so `null` = no cap).
     */
    private async resolveEffectiveCap(mission: Mission): Promise<number | null> {
        if (typeof mission.outstandingIdeasCap === 'number') {
            return mission.outstandingIdeasCap < 0 ? null : mission.outstandingIdeasCap;
        }
        // Per-Mission cap not set — fall back to user pref. Pref
        // fetch failures are non-fatal (the cap defaults to the
        // platform value); we don't want a flaky prefs read to
        // strand a Mission tick.
        try {
            const prefs = await this.workAgent.getPreferences(mission.userId);
            const userCap = prefs.missionDefaultOutstandingCap;
            if (typeof userCap === 'number') {
                return userCap < 0 ? null : userCap;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `Mission ${mission.id} cap fallback: getPreferences failed (${message}); using platform default.`,
            );
        }
        return PLATFORM_DEFAULT_OUTSTANDING_CAP;
    }

    /** PR-3 - best-effort activity write; no-ops when unwired. */
    /**
     * APW-08 T35 (FR-51…FR-54) — the Task branch: for each App Work attached as Improves or
     * Operates (at most {@link MISSION_TASK_OUTPUT_MAX_WORKS}), propose Tasks, drop a duplicate of
     * an open Task's title, file the rest on the Work (Backlog when the Mission requires approval
     * before creating, otherwise To do and started), within `tasksPerTick` and `openTasksCap`.
     * Best-effort per Work: one Work's failure never stops the others or fails the Mission.
     */
    private async runTaskOutput(mission: Mission, now: Date): Promise<MissionTickOutcome> {
        const tasksService = this.tasksService();
        if (!this.taskPlanner || !this.missionWorks || !this.taskRows || !tasksService) {
            this.logger.warn(
                `Mission ${mission.id}: Task output is not wired in this context; nothing filed.`,
            );
            return { outcome: 'no-tasks', tasksFiled: 0, message: 'task-output-unavailable' };
        }
        const scope = ownershipRelationScopeOf(mission) ?? undefined;
        let relations: Awaited<ReturnType<MissionWorkRepository['listForMissionWithWork']>> = [];
        try {
            relations = await this.missionWorks.listForMissionWithWork(
                mission.id,
                mission.userId,
                scope,
            );
        } catch (err) {
            this.logger.warn(`Mission ${mission.id}: its Works could not be read (${err}).`);
            return { outcome: 'no-tasks', tasksFiled: 0, message: 'works-unreadable' };
        }
        const eligible: Array<{ workId: string; workName: string; relation: 'improves' | 'operates' }> = [];
        for (const row of relations) {
            if (eligible.length >= MISSION_TASK_OUTPUT_MAX_WORKS) break;
            if (!(MISSION_TASK_OUTPUT_RELATIONS as readonly string[]).includes(row.relation)) continue;
            if (!isAppWorkKind(row.workKind ?? null)) continue;
            if (eligible.some((entry) => entry.workId === row.workId)) continue;
            eligible.push({
                workId: row.workId,
                workName: row.workName ?? 'App',
                relation: row.relation as 'improves' | 'operates',
            });
        }
        if (eligible.length === 0) {
            await this.recordNothingToFile(mission, now, 'no-app-work');
            return { outcome: 'no-tasks', tasksFiled: 0, message: 'no-app-work' };
        }

        const output = normalizeMissionTaskOutput(mission.taskOutput);
        const requireApproval = mission.guardrailsOverride?.requireApprovalBeforeCreate === true;
        let tasksFiled = 0;
        let skippedCap = 0;
        let skippedDuplicate = 0;
        for (const target of eligible) {
            try {
                const result = await this.fileOnWork(mission, target, output, requireApproval, scope);
                tasksFiled += result.filed;
                skippedCap += result.cappedOut ? 1 : 0;
                skippedDuplicate += result.duplicates;
            } catch (err) {
                this.logger.warn(
                    `Mission ${mission.id}: Task output on Work ${target.workId} failed (${
                        err instanceof Error ? err.message : String(err)
                    }); the other Works continue.`,
                );
            }
        }
        this.telemetry().track(
            'mission.task_output.tick',
            {
                missionId: mission.id,
                worksConsidered: eligible.length,
                tasksFiled,
                skippedCap,
                skippedDuplicate,
            },
            mission.userId,
        );
        if (tasksFiled === 0) await this.recordNothingToFile(mission, now, 'nothing-new');
        return {
            outcome: tasksFiled > 0 ? 'tasks-filed' : 'no-tasks',
            tasksFiled,
            message: `works=${eligible.length} filed=${tasksFiled} capped=${skippedCap} duplicates=${skippedDuplicate}`,
        };
    }

    /** One Work's share of a tick (see {@link runTaskOutput}). */
    private async fileOnWork(
        mission: Mission,
        target: { workId: string; workName: string; relation: 'improves' | 'operates' },
        output: MissionTaskOutput,
        requireApproval: boolean,
        scope: OwnershipScope | undefined,
    ): Promise<{ filed: number; cappedOut: boolean; duplicates: number }> {
        const taskRows = this.taskRows!;
        const tasksService = this.tasksService()!;
        const open = await taskRows.find({
            where: {
                workId: target.workId,
                status: Not(In([TaskStatus.DONE, TaskStatus.CANCELLED])),
            },
            select: ['id', 'title', 'missionId'],
            take: 500,
        });
        const openForMission = open.filter((task) => task.missionId === mission.id).length;
        if (openForMission >= output.openTasksCap) {
            return { filed: 0, cappedOut: true, duplicates: 0 };
        }
        const count = Math.min(output.tasksPerTick, output.openTasksCap - openForMission);
        const recent = await taskRows.find({
            where: { workId: target.workId },
            order: { createdAt: 'DESC' },
            select: ['id', 'title'],
            take: MISSION_PLANNER_RECENT_TASKS,
        });
        const work = this.works ? await this.works.findById(target.workId).catch(() => null) : null;
        const proposals = await this.taskPlanner!.plan({
            userId: mission.userId,
            missionId: mission.id,
            missionDescription: mission.description,
            relation: target.relation,
            work: {
                id: target.workId,
                name: work?.name ?? target.workName,
                description: (work as { description?: string | null } | null)?.description ?? null,
            },
            recentTaskTitles: recent.map((task) => task.title),
            count,
        });
        const openTitles = new Set(open.map((task) => normalizeTaskTitle(task.title)));
        let filed = 0;
        let duplicates = 0;
        for (const proposal of proposals) {
            if (filed >= count) break;
            const key = normalizeTaskTitle(proposal.title);
            if (!key || openTitles.has(key)) {
                duplicates += 1;
                continue;
            }
            const input = {
                title: proposal.title,
                description: proposal.description || null,
                missionId: mission.id,
                workId: target.workId,
                labels: [MISSION_TASK_LABEL],
                status: requireApproval ? TaskStatus.BACKLOG : TaskStatus.TODO,
                ...(output.agentId ? { agentId: output.agentId } : {}),
            } as Parameters<TasksService['create']>[1];
            const task = scope
                ? await tasksService.create(mission.userId, input, scope)
                : await tasksService.create(mission.userId, input, undefined, {
                      ownershipStamp: ownershipScopeOf(mission),
                  });
            openTitles.add(key);
            filed += 1;
            if (!requireApproval) {
                // FR-52 — started with the Mission's Agent (its own, else the Work's default).
                // A Task with no Agent to run it stays in To do: filed, not lost.
                try {
                    await tasksService.runTask(
                        mission.userId,
                        task.id,
                        { agentId: output.agentId ?? null },
                        scope,
                    );
                } catch (err) {
                    this.logger.warn(
                        `Mission ${mission.id}: Task ${task.id} was filed but not started (${
                            err instanceof Error ? err.message : String(err)
                        }).`,
                    );
                }
            }
        }
        return { filed, cappedOut: false, duplicates };
    }

    /**
     * FR-54 / S27 (APW08-G21) — a Task-output tick that files nothing records ONE Activity entry
     * per Mission per (UTC) day, stamped on `missions.taskOutputNoticeAt`, never a Task label.
     */
    private async recordNothingToFile(
        mission: Mission,
        now: Date,
        reason: 'no-app-work' | 'nothing-new',
    ): Promise<void> {
        const last = mission.taskOutputNoticeAt ? new Date(mission.taskOutputNoticeAt) : null;
        if (last && last.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return;
        try {
            await this.missions.update({ id: mission.id }, { taskOutputNoticeAt: now });
            mission.taskOutputNoticeAt = now;
        } catch (err) {
            this.logger.warn(`Mission ${mission.id}: the notice stamp failed (${err}).`);
            return;
        }
        await this.recordActivity(mission, ActivityActionType.MISSION_NOTHING_TO_FILE, 'nothing-to-file', {
            reason,
            message:
                reason === 'no-app-work'
                    ? 'No attached App Work to file Tasks on.'
                    : 'Nothing new to file on the attached App Works.',
        });
        this.telemetry().track(
            'mission.task_output.nothing_to_file',
            { missionId: mission.id },
            mission.userId,
        );
    }

    private tasksService(): TasksService | null {
        if (!this.moduleRef) return null;
        try {
            return this.moduleRef.get(TasksService, { strict: false }) ?? null;
        } catch {
            return null;
        }
    }

    private appChangeTelemetryInstance?: AppChangeTelemetry;
    private telemetry(): AppChangeTelemetry {
        return (this.appChangeTelemetryInstance ??= new AppChangeTelemetry(this.appWorksSink));
    }

    private async recordActivity(
        mission: Mission,
        actionType: ActivityActionType,
        action: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: mission.userId,
                actionType,
                action,
                status: ActivityStatus.COMPLETED,
                summary: `Mission ${action}: ${mission.title}`,
                details: { missionId: mission.id, ...details } as Record<string, any>,
            });
        } catch (error) {
            this.logger.warn(
                `Mission ${mission.id}: activity write failed (${actionType}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
