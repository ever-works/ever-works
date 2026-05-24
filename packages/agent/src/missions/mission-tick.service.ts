import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mission, MissionStatus, MissionType } from '../entities/mission.entity';
import { WorkProposalSource } from '../entities/work-proposal.entity';
import { WorkAgentService } from '../work-agent/work-agent.service';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { WorkProposalService } from '../user-research/work-proposal.service';
import { matchesCron } from './cron-matcher';

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
        });
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
            if (outcome.outcome === 'spawned') summary.ran += 1;
            else if (outcome.outcome === 'failed') summary.failed += 1;
            else summary.skipped += 1;
        }
        return summary;
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
        if (mission.status !== MissionStatus.ACTIVE) {
            return {
                outcome: 'failed',
                message: `mission-not-active (status=${mission.status})`,
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

        // Outstanding-Ideas cap.
        const outstanding = await this.workProposalRepo.countOutstandingByMission(mission.id);
        const cap = await this.resolveEffectiveCap(mission);
        if (cap !== null && outstanding >= cap) {
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
                for (const proposal of result.proposals) {
                    const ok = await this.workProposals.queueForBuild(
                        mission.userId,
                        proposal.id,
                    );
                    if (ok) queued += 1;
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
            return { outcome: 'failed', message };
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
}
