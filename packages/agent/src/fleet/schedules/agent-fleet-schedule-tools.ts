import {
    isFleetCommandLine,
    isValidFleetScheduleCadence,
    type FleetCommandRunView,
    type FleetLinkError,
    type FleetScheduleView,
} from '@ever-works/contracts';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { fleetCommandError, readFleetCommandError } from '../commands/fleet-command.errors';
import type { FleetScheduleService } from './fleet-schedule.service';

/**
 * Schedules on computers (FL-13 P2, spec FR-32, plan §9) — the `schedules`
 * tool family an Agent works with (CONTRACTS §11.3 names):
 *
 *  - `fleet_schedules_create` / `_update` / `_delete` / `_run` — DESTRUCTIVE,
 *    class `confirm` (AW-24 `agent.fanout` for create and update,
 *    `write.destructive` for delete, `machine.run` for run). A schedule runs a
 *    command in the machine OWNER's login shell, as the owner, again and again
 *    — so, exactly like `fleet_commands_run` (FL-12 decision 15), an Agent never
 *    writes one by itself: every call is HELD as an Approval in the owner's My
 *    Decisions (the Agent Action Approval Queue, CONTRACTS R-33), and a
 *    person's approval applies exactly it, as this Agent
 *    (`FleetScheduleProposalListener`, `requestedBy: agent:<id>` in every audit
 *    row), through the same chain a person's write takes (the computer's
 *    `schedules` audience, the limits, the kill switch). Unbound queue:
 *    refused, never written.
 *  - `fleet_schedules_pause` / `_resume` — not destructive (`plain`, AW-24
 *    `agent.fanout`): applied at once.
 *  - `fleet_schedules_list` / `_get` / `_runs` — read-only.
 *
 * The tools see only the schedules Agents asked for (`requestedBy: 'agent'`
 * of the owner): a schedule a person made is as unknown to them as a missing
 * one (FL-12 question Q3 applies: Agents of one owner see each other's).
 */

/** The platform-written `payload.kind` of a held Agent schedule write. */
export const FLEET_SCHEDULE_PROPOSAL_KIND = 'fleet-schedule-write' as const;

export type FleetScheduleProposalOp = 'create' | 'update' | 'delete' | 'run';

/** What a held Agent schedule write stores, so a person's approval applies exactly it. */
export interface FleetScheduleProposalPayload {
    kind: typeof FLEET_SCHEDULE_PROPOSAL_KIND;
    agentId: string;
    op: FleetScheduleProposalOp;
    /** The schedule (update, delete, run). */
    scheduleId?: string;
    name?: string;
    nodeId?: string;
    command?: string;
    cwd?: string | null;
    cadence?: Record<string, unknown>;
}

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_SCHEDULE_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_schedules_list: { readOnly: true },
    fleet_schedules_get: { readOnly: true },
    fleet_schedules_runs: { readOnly: true },
    fleet_schedules_create: { destructive: true, confirmationClass: 'confirm' },
    fleet_schedules_update: { destructive: true, confirmationClass: 'confirm' },
    fleet_schedules_delete: { destructive: true, confirmationClass: 'confirm' },
    fleet_schedules_run: { destructive: true, confirmationClass: 'confirm' },
    fleet_schedules_pause: { destructive: false, confirmationClass: 'plain' },
    fleet_schedules_resume: { destructive: false, confirmationClass: 'plain' },
};

type ToolError = { error: FleetLinkError };

const MODEL_EDGE_CHARS = 2_000;

function toolError(error: unknown): ToolError {
    const known = readFleetCommandError(error);
    return {
        error: known ?? { code: 'internal', hint: error instanceof Error ? error.message.slice(0, 200) : 'failed' },
    };
}

function invalid(field: string, hint: string): ToolError {
    return { error: { code: 'invalid', hint, details: { field } } };
}

function compact(view: FleetScheduleView) {
    return {
        id: view.id,
        name: view.name,
        computer: view.nodeName,
        nodeId: view.nodeId,
        timeZone: view.nodeTimeZone,
        command: view.command,
        cwd: view.cwd,
        cadence: view.cadence,
        when: view.cadenceHuman,
        enabled: view.enabled,
        pausedReason: view.pausedReason,
        nextRunAt: view.nextRunAt,
        lastRun: view.lastRun,
        failureStreak: view.failureStreak,
        sync: view.syncState,
        neverRuns: view.neverRuns,
    };
}

function compactRun(run: FleetCommandRunView) {
    const head = run.outputHead.length > MODEL_EDGE_CHARS ? `${run.outputHead.slice(0, MODEL_EDGE_CHARS)}…` : run.outputHead;
    const tail = run.outputTail.length > MODEL_EDGE_CHARS ? `…${run.outputTail.slice(-MODEL_EDGE_CHARS)}` : run.outputTail;
    return {
        id: run.id,
        scheduledFor: run.scheduledFor ?? null,
        startedAt: run.startedAt,
        status: run.status,
        failedReason: run.failedReason,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        output: run.truncated ? { head, tail } : { all: head },
    };
}

const CADENCE_SCHEMA = {
    type: 'object',
    description:
        "When it runs, on the computer's own clock: { kind: 'interval', expr: '30' } (every 30 min; '60' = hourly), { kind: 'daily', at: '08:30' }, { kind: 'weekdays', at: '02:00' }, or { kind: 'cron', expr: '0 9 * * 1,3' }.",
    properties: {
        kind: { type: 'string', enum: ['interval', 'daily', 'weekdays', 'cron'] },
        expr: { type: 'string' },
        at: { type: 'string' },
    },
    required: ['kind'],
} as const;

export function buildFleetScheduleTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetScheduleService, 'listForUser' | 'get' | 'runs' | 'pause' | 'resume'>;
    /** The approval seam; null = writes are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const actor = { userId: args.userId, agentId: args.agentId };
    /** An Agent-requested schedule of this owner, else as unknown as a missing one. */
    const agentSchedule = async (scheduleId: unknown): Promise<FleetScheduleView> => {
        const view = await args.service.get(String(scheduleId ?? ''), actor);
        if (view.requestedBy !== 'agent' || view.deletedAt) throw fleetCommandError('not_found', 'no such schedule');
        return view;
    };
    const hold = async (payload: FleetScheduleProposalPayload, title: string) => {
        if (!args.proposals) {
            return {
                error: {
                    code: 'confirmation_required',
                    hint: 'changing a schedule needs the owner’s approval and no approval queue is available; ask the owner to do it',
                },
            } satisfies ToolError;
        }
        try {
            const proposal = await args.proposals.propose(args.userId, {
                agentId: args.agentId,
                runId: args.runId,
                title: title.slice(0, 200),
                payload: { ...payload },
                subjectKey: null,
            });
            return {
                held: true,
                proposalId: proposal.id,
                status: proposal.status,
                hint: 'held for the owner’s approval in My Decisions; it is applied when they approve it — read it with fleet_schedules_list',
            };
        } catch (error) {
            return toolError(error);
        }
    };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'fleet_schedules_list',
        description:
            "Read-only. The schedules Agents asked for on the owner's computers: name, computer, command, when it runs (on the computer's clock), next fire, last run, failure streak.",
        parameters: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Only this computer (Fleet node id).' } },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown };
            try {
                const rows = await args.service.listForUser(actor, typeof a.nodeId === 'string' && a.nodeId ? { nodeId: a.nodeId } : {});
                return { schedules: rows.filter((row) => row.requestedBy === 'agent').map(compact) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ nodeId?: unknown }, unknown>);

    out.push({
        name: 'fleet_schedules_get',
        description: 'Read-only. One schedule an Agent asked for.',
        parameters: {
            type: 'object',
            properties: { scheduleId: { type: 'string', description: 'The schedule id.' } },
            required: ['scheduleId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { scheduleId?: unknown };
            if (typeof a.scheduleId !== 'string' || !a.scheduleId) return invalid('scheduleId', 'scheduleId is required');
            try {
                return { schedule: compact(await agentSchedule(a.scheduleId)) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ scheduleId?: unknown }, unknown>);

    out.push({
        name: 'fleet_schedules_runs',
        description:
            'Read-only. The last runs (newest first, at most 30) of a schedule an Agent asked for: the fire, the status or why it was skipped, the exit code and the head and tail of its output.',
        parameters: {
            type: 'object',
            properties: { scheduleId: { type: 'string', description: 'The schedule id.' } },
            required: ['scheduleId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { scheduleId?: unknown };
            if (typeof a.scheduleId !== 'string' || !a.scheduleId) return invalid('scheduleId', 'scheduleId is required');
            try {
                const view = await agentSchedule(a.scheduleId);
                return { runs: (await args.service.runs(view.id, actor)).map(compactRun) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ scheduleId?: unknown }, unknown>);

    out.push({
        name: 'fleet_schedules_create',
        description:
            "DESTRUCTIVE. Ask to schedule a shell command on ONE of the owner's computers, run on that computer's own clock in the owner's login shell, as the owner, with no input. It is NOT created now: it is held for the owner's approval in My Decisions. Needs `--manage` on the computer. These are real machines, not a sandbox.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                name: { type: 'string', description: 'A short name (1–120 characters).' },
                command: { type: 'string', description: 'The command line (at most 8 KiB).' },
                cwd: { type: 'string', description: "Optional folder (default the owner's home, ~)." },
                cadence: CADENCE_SCHEMA,
            },
            required: ['nodeId', 'name', 'command', 'cadence'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown; name?: unknown; command?: unknown; cwd?: unknown; cadence?: unknown };
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId names one computer');
            if (typeof a.name !== 'string' || !a.name.trim()) return invalid('name', 'name the schedule');
            if (!isFleetCommandLine(a.command)) return invalid('command', 'command is 1 … 8 KiB of text');
            if (!isValidFleetScheduleCadence({ ...((a.cadence ?? {}) as object), timezone: 'node' })) {
                return invalid('cadence', 'cadence is one of the four kinds (see the schema)');
            }
            return hold(
                {
                    kind: FLEET_SCHEDULE_PROPOSAL_KIND,
                    agentId: args.agentId,
                    op: 'create',
                    nodeId: a.nodeId,
                    name: a.name.trim(),
                    command: a.command,
                    ...(typeof a.cwd === 'string' && a.cwd.trim() ? { cwd: a.cwd.trim() } : {}),
                    cadence: a.cadence as Record<string, unknown>,
                },
                `Schedule on one computer: ${a.name.trim()} — ${a.command.split(/\r?\n/, 1)[0]}`,
            );
        },
    } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

    out.push({
        name: 'fleet_schedules_update',
        description:
            'DESTRUCTIVE. Ask to change a schedule an Agent asked for (name, command, folder, cadence, or nodeId to move it). Held for the owner’s approval.',
        parameters: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string' },
                nodeId: { type: 'string', description: 'Move it to this computer.' },
                name: { type: 'string' },
                command: { type: 'string' },
                cwd: { type: 'string' },
                cadence: CADENCE_SCHEMA,
            },
            required: ['scheduleId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            try {
                const view = await agentSchedule(a.scheduleId);
                if (a.command !== undefined && !isFleetCommandLine(a.command)) {
                    return invalid('command', 'command is 1 … 8 KiB of text');
                }
                return hold(
                    {
                        kind: FLEET_SCHEDULE_PROPOSAL_KIND,
                        agentId: args.agentId,
                        op: 'update',
                        scheduleId: view.id,
                        ...(typeof a.name === 'string' ? { name: a.name } : {}),
                        ...(typeof a.nodeId === 'string' ? { nodeId: a.nodeId } : {}),
                        ...(typeof a.command === 'string' ? { command: a.command } : {}),
                        ...(typeof a.cwd === 'string' ? { cwd: a.cwd } : {}),
                        ...(a.cadence && typeof a.cadence === 'object' ? { cadence: a.cadence as Record<string, unknown> } : {}),
                    },
                    `Change the schedule ${view.name}`,
                );
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

    const heldOp = (name: 'fleet_schedules_delete' | 'fleet_schedules_run', op: 'delete' | 'run', description: string) =>
        ({
            name,
            description,
            parameters: {
                type: 'object',
                properties: { scheduleId: { type: 'string', description: 'The schedule id.' } },
                required: ['scheduleId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { scheduleId?: unknown };
                try {
                    const view = await agentSchedule(a.scheduleId);
                    return hold(
                        { kind: FLEET_SCHEDULE_PROPOSAL_KIND, agentId: args.agentId, op, scheduleId: view.id },
                        op === 'delete' ? `Delete the schedule ${view.name}` : `Run the schedule ${view.name} now`,
                    );
                } catch (error) {
                    return toolError(error);
                }
            },
        }) satisfies TaskToolDescriptor<{ scheduleId?: unknown }, unknown>;

    out.push(
        heldOp(
            'fleet_schedules_delete',
            'delete',
            'DESTRUCTIVE. Ask to delete a schedule an Agent asked for (it stops on the computer; its runs stay readable for 30 days). Held for the owner’s approval.',
        ),
        heldOp(
            'fleet_schedules_run',
            'run',
            'DESTRUCTIVE. Ask to run a schedule an Agent asked for now, on its computer (the next fire does not move). Held for the owner’s approval.',
        ),
    );

    const plainOp = (name: 'fleet_schedules_pause' | 'fleet_schedules_resume', description: string) =>
        ({
            name,
            description,
            parameters: {
                type: 'object',
                properties: { scheduleId: { type: 'string', description: 'The schedule id.' } },
                required: ['scheduleId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { scheduleId?: unknown };
                try {
                    const view = await agentSchedule(a.scheduleId);
                    const next =
                        name === 'fleet_schedules_pause'
                            ? await args.service.pause(view.id, actor)
                            : await args.service.resume(view.id, actor);
                    return { schedule: compact(next) };
                } catch (error) {
                    return toolError(error);
                }
            },
        }) satisfies TaskToolDescriptor<{ scheduleId?: unknown }, unknown>;

    out.push(
        plainOp('fleet_schedules_pause', 'Pause a schedule an Agent asked for (its cadence is kept). Applied at once.'),
        plainOp(
            'fleet_schedules_resume',
            'Resume a paused schedule an Agent asked for. Applied at once; fires missed while paused are not replayed.',
        ),
    );

    return out;
}
