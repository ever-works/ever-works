import {
    fleetCommandStateFor,
    summarizeFleetCommandRuns,
    type FleetCommandRunView,
    type FleetCommandView,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { FleetCommand } from '../../entities/fleet-command.entity';
import type { FleetCommandRun } from '../../entities/fleet-command-run.entity';

const time = (value: Date | string | null | undefined): number | null => {
    if (!value) return null;
    const at = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(at) ? at : null;
};

const iso = (value: Date | string | null | undefined): string | null => {
    const at = time(value);
    return at === null ? null : new Date(at).toISOString();
};

/**
 * Commands on computers (FL-12) — the one mapping from rows to what every
 * surface reads (the hub card, the CLI `--json`, the tools). The machine's
 * own key for the full output (`outputRef`) never leaves the platform; only
 * whether the machine still holds it.
 */
export function toFleetCommandRunView(
    row: FleetCommandRun,
    nodeName: string | null,
    now: number,
    connected: (nodeId: string) => boolean = () => true,
): FleetCommandRunView {
    const started = time(row.startedAt) ?? now;
    const ended = time(row.endedAt);
    const error: FleetLinkError | null = row.errorCode
        ? { code: row.errorCode, hint: row.errorHint ?? '' }
        : null;
    return {
        id: row.id,
        commandId: row.commandId,
        nodeId: row.nodeId,
        nodeName,
        status: row.status,
        failedReason: row.failedReason ?? null,
        exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
        error,
        startedAt: new Date(started).toISOString(),
        endedAt: ended === null ? null : new Date(ended).toISOString(),
        durationMs: Math.max(0, (ended ?? (row.status === 'running' ? now : started)) - started),
        outputHead: row.outputHead ?? '',
        outputTail: row.outputTail ?? '',
        truncated: row.truncated === true,
        capped: row.capped === true,
        outputBytes: typeof row.outputBytes === 'number' ? row.outputBytes : Number(row.outputBytes ?? 0) || 0,
        hasFullOutput: typeof row.outputRef === 'string' && row.outputRef.length > 0,
        linkDown: row.status === 'running' && !connected(row.nodeId),
    };
}

export function toFleetCommandView(
    command: FleetCommand,
    runs: readonly FleetCommandRun[],
    nodeNames: ReadonlyMap<string, string>,
    now: number,
    connected: (nodeId: string) => boolean = () => true,
): FleetCommandView {
    const runViews = runs.map((run) =>
        toFleetCommandRunView(run, nodeNames.get(run.nodeId) ?? null, now, connected),
    );
    // The stored state is the writer's; while a run is still live the runs say so.
    const state =
        runViews.length > 0
            ? fleetCommandStateFor(runViews, command.state === 'cancelled')
            : command.state;
    return {
        id: command.id,
        userId: command.userId,
        command: command.command,
        commandRedacted: command.commandRedacted === true,
        cwd: command.cwd ?? null,
        timeoutSec: command.timeoutSec,
        requestedBy: command.requestedBy,
        state,
        nodeIds: Array.isArray(command.nodeIds) ? [...command.nodeIds] : [],
        createdAt: iso(command.createdAt) ?? new Date(now).toISOString(),
        updatedAt: iso(command.updatedAt) ?? iso(command.createdAt) ?? new Date(now).toISOString(),
        runs: runViews,
        summary: summarizeFleetCommandRuns(runViews),
    };
}
