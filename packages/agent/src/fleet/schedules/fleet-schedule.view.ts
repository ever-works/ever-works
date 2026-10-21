import {
    describeFleetScheduleCadence,
    fleetNodeScheduleRowId,
    fleetScheduleFailureStreak,
    isFleetSchedulePausedReason,
    nextFleetScheduleFire,
    parseFleetScheduleCadence,
    type FleetCommandRunStatus,
    type FleetCommandRunView,
    type FleetLinkError,
    type FleetScheduleCadence,
    type FleetScheduleLastRun,
    type FleetScheduleNeverRunsReason,
    type FleetScheduleSyncState,
    type FleetScheduleView,
} from '@ever-works/contracts';
import type { FleetCommand } from '../../entities/fleet-command.entity';
import type { FleetCommandRun } from '../../entities/fleet-command-run.entity';

/**
 * Schedules on computers (FL-13) — rows to the wire shapes every surface
 * reads (`FleetScheduleView`, and `FleetCommandRunView` for a history row).
 * Pure: the clock, the link state and the node facts are handed in.
 */

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMs(value: Date | string | null | undefined): number | null {
    if (!value) return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
}

/** The stored cadence, re-read (a hand-edited row reads as a 00:00 daily rather than crashing a list). */
export function storedFleetScheduleCadence(command: Pick<FleetCommand, 'cadence'>): FleetScheduleCadence {
    return (
        parseFleetScheduleCadence(command.cadence).cadence ?? { kind: 'daily', at: '00:00', timezone: 'node' }
    );
}

/** The run the history and the "last run" cell show. Refusals before a run never count as runs. */
export function isCountedFleetScheduleRun(run: Pick<FleetCommandRun, 'errorCode'>): boolean {
    return !run.errorCode;
}

/** Everything one schedule's view reads, gathered by the service. */
export interface FleetScheduleViewFacts {
    command: FleetCommand;
    /** Null when the computer was removed. */
    node: { id: string; name: string; timeZone: string | null } | null;
    /** The newest runs (newest first; at least enough for the failure streak). */
    runs: readonly FleetCommandRun[];
    neverRuns: { reason: FleetScheduleNeverRunsReason; hint: string } | null;
    /** The node is older than schedules (its last `schedule.sync` was refused `unsupported_on_node`). */
    unsupported: boolean;
    /** The machine refused this definition in its last sync. */
    refusal: FleetLinkError | null;
    /** The platform holds the computer's link right now. */
    linkUp: boolean;
    now: number;
}

export function toFleetScheduleView(facts: FleetScheduleViewFacts): FleetScheduleView {
    const { command, node } = facts;
    const cadence = storedFleetScheduleCadence(command);
    const counted = facts.runs.filter(isCountedFleetScheduleRun);
    const latest = counted[0] ?? null;
    const paused = Boolean(command.pausedAt) || command.enabled === false;
    const deleted = Boolean(command.deletedAt);
    const live = !paused && !deleted && node !== null && facts.neverRuns === null;
    const next = live ? nextFleetScheduleFire(cadence, node?.timeZone ?? null, facts.now) : null;
    let syncState: FleetScheduleSyncState = 'synced';
    if (facts.unsupported) syncState = 'unsupported';
    else if (facts.refusal) syncState = 'refused';
    else if ((command.syncGeneration ?? 0) > (command.syncedGeneration ?? 0)) syncState = 'pending';
    const lastRun: FleetScheduleLastRun | null = latest
        ? {
              runId: latest.id,
              status: latest.status,
              failedReason: latest.failedReason ?? null,
              exitCode: latest.exitCode ?? null,
              scheduledFor: toIso(latest.scheduledFor),
              startedAt: toIso(latest.startedAt) ?? new Date(facts.now).toISOString(),
              endedAt: toIso(latest.endedAt),
          }
        : null;
    return {
        kind: 'schedule',
        id: command.id,
        scheduleId: fleetNodeScheduleRowId(command.id),
        name: command.name ?? 'Schedule',
        nodeId: (command.nodeIds ?? [])[0] ?? '',
        nodeName: node?.name ?? null,
        nodeTimeZone: node?.timeZone ?? null,
        command: command.command,
        commandRedacted: Boolean(command.commandRedacted),
        cwd: command.cwd ?? null,
        cadence,
        cadenceHuman: describeFleetScheduleCadence(cadence),
        enabled: !paused && !deleted,
        pausedAt: toIso(command.pausedAt),
        pausedReason: isFleetSchedulePausedReason(command.pausedReason) ? command.pausedReason : null,
        nextRunAt: next === null ? null : new Date(next).toISOString(),
        lastRunAt: toIso(command.lastRunAt) ?? lastRun?.startedAt ?? null,
        lastRun,
        running: latest?.status === 'running',
        linkUp: facts.linkUp,
        requestedBy: command.requestedBy === 'agent' ? 'agent' : 'user',
        failureStreak: fleetScheduleFailureStreak(counted as Array<{ status: FleetCommandRunStatus }>),
        syncState,
        syncError: facts.refusal,
        neverRuns: deleted ? null : facts.neverRuns,
        deletedAt: toIso(command.deletedAt),
        createdAt: toIso(command.createdAt) ?? new Date(facts.now).toISOString(),
        updatedAt: toIso(command.updatedAt) ?? new Date(facts.now).toISOString(),
    };
}

/** One history row (FR-20): FL-12's run view plus the fire it belongs to. */
export function toFleetScheduleRunView(
    run: FleetCommandRun,
    nodeName: string | null,
    now: number,
    linkUp: boolean,
): FleetCommandRunView {
    const started = toMs(run.startedAt) ?? now;
    const ended = toMs(run.endedAt);
    return {
        id: run.id,
        commandId: run.commandId,
        nodeId: run.nodeId,
        nodeName,
        status: run.status,
        failedReason: run.failedReason ?? null,
        exitCode: run.exitCode ?? null,
        error: run.errorCode ? { code: run.errorCode, hint: run.errorHint ?? '' } : null,
        startedAt: new Date(started).toISOString(),
        endedAt: ended === null ? null : new Date(ended).toISOString(),
        durationMs: ended === null ? (run.status === 'running' ? Math.max(0, now - started) : null) : ended - started,
        outputHead: run.outputHead ?? '',
        outputTail: run.outputTail ?? '',
        truncated: Boolean(run.truncated),
        capped: Boolean(run.capped),
        outputBytes: run.outputBytes ?? 0,
        hasFullOutput: Boolean(run.outputRef),
        linkDown: run.status === 'running' && !linkUp,
        scheduledFor: toIso(run.scheduledFor),
    };
}
