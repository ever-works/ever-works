import {
    FLEET_COMMAND_MAX_NODES,
    isFleetCommandLine,
    type FleetCommandRunView,
    type FleetCommandView,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { fleetCommandError, readFleetCommandError } from './fleet-command.errors';
import type { FleetCommandService } from './fleet-command.service';

/**
 * Commands on computers (FL-12 P2, spec FR-20, S5, plan §9) — the `commands`
 * tool family an Agent works with (CONTRACTS §11.3 names):
 *
 *  - `fleet_commands_run` — DESTRUCTIVE, class `confirm`, AW-24 category
 *    `machine.run`. A command runs in the machine OWNER's login shell, as the
 *    owner, so an Agent never runs one by itself: every call is HELD as an
 *    Approval in the owner's My Decisions (the Agent Action Approval Queue,
 *    CONTRACTS R-33), naming the computers, the command and the shell. A
 *    person's approval runs exactly it, as this Agent
 *    (`FleetCommandProposalListener`: `requestedBy: agent:<id>` in every audit
 *    row), through the same chain a person's run takes — the computers'
 *    `commands` audience must include the Agent's owner, `--manage`, the kill
 *    switch, the limits. Unbound approval queue: refused, never run.
 *  - `fleet_commands_list` / `fleet_commands_get` — read-only: the Commands
 *    Agents asked for, with each computer's status, exit code and the head
 *    and tail of its output (bounded for the model).
 *  - `fleet_commands_cancel` — not destructive (`plain`): stop a running
 *    Command an Agent asked for.
 *
 * Every refusal answers the CONTRACTS §8 envelope (`{ error: { code, hint } }`)
 * so the model reads a reason it can act on.
 */

/** The platform-written `payload.kind` of a held Agent command. */
export const FLEET_COMMAND_PROPOSAL_KIND = 'fleet-command-run' as const;

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_COMMAND_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_commands_run: { destructive: true, confirmationClass: 'confirm' },
    fleet_commands_get: { readOnly: true },
    fleet_commands_list: { readOnly: true },
    fleet_commands_cancel: { destructive: false, confirmationClass: 'plain' },
};

/** What a held Agent command stores, so a person's approval runs exactly it (no model-authored field beyond these). */
export interface FleetCommandProposalPayload {
    kind: typeof FLEET_COMMAND_PROPOSAL_KIND;
    agentId: string;
    command: string;
    nodeIds: string[];
    cwd?: string;
    timeoutSec?: number;
}

/** Output handed to the model per computer: the head and tail, bounded. */
const MODEL_EDGE_CHARS = 4_000;

type ToolError = { error: FleetLinkError };

function toolError(error: unknown): ToolError {
    const known = readFleetCommandError(error);
    return {
        error: known ?? {
            code: 'internal',
            hint: error instanceof Error ? error.message.slice(0, 200) : 'failed',
        },
    };
}

function invalid(field: string, hint: string): ToolError {
    return { error: { code: 'invalid', hint, details: { field } } };
}

function compactRun(run: FleetCommandRunView) {
    const head =
        run.outputHead.length > MODEL_EDGE_CHARS
            ? `${run.outputHead.slice(0, MODEL_EDGE_CHARS)}…`
            : run.outputHead;
    const tail =
        run.outputTail.length > MODEL_EDGE_CHARS
            ? `…${run.outputTail.slice(-MODEL_EDGE_CHARS)}`
            : run.outputTail;
    return {
        nodeId: run.nodeId,
        computer: run.nodeName,
        status: run.status,
        failedReason: run.failedReason,
        exitCode: run.exitCode,
        error: run.error,
        durationMs: run.durationMs,
        output:
            run.truncated || run.outputHead.length > MODEL_EDGE_CHARS
                ? { head, tail }
                : { all: head },
        truncated: run.truncated,
    };
}

function compact(view: FleetCommandView) {
    return {
        id: view.id,
        command: view.command,
        state: view.state,
        createdAt: view.createdAt,
        summary: view.summary,
        runs: view.runs.map(compactRun),
    };
}

export function buildFleetCommandTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetCommandService, 'listRecent' | 'get' | 'cancel'>;
    /** The approval seam; null = runs are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const actor = { userId: args.userId, agentId: args.agentId };
    /** An Agent-requested Command of this owner, else as unknown as a missing one. */
    const agentCommand = async (commandId: string): Promise<FleetCommandView> => {
        const view = await args.service.get(String(commandId ?? ''), actor);
        if (view.requestedBy !== 'agent') throw fleetCommandError('not_found', 'no such command');
        return view;
    };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'fleet_commands_run',
        description:
            "DESTRUCTIVE. Ask to run one shell command on one or more of the owner's computers, in the owner's login shell, as the owner, with no input (prompts fail — pass -y). It is NOT run now: it is held for the owner's approval in My Decisions and runs when they approve it. Read the result later with fleet_commands_list. Needs `--manage` on each computer. These are real machines, not a sandbox.",
        parameters: {
            type: 'object',
            properties: {
                nodeIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `The computers (Fleet node ids), 1–${FLEET_COMMAND_MAX_NODES}.`,
                },
                command: { type: 'string', description: 'The command line (at most 8 KiB).' },
                cwd: {
                    type: 'string',
                    description: "Optional folder (default the owner's home, ~).",
                },
                timeoutSec: {
                    type: 'integer',
                    description: 'Optional timeout in seconds (default 600, at most 3600).',
                },
            },
            required: ['nodeIds', 'command'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeIds?: unknown;
                command?: unknown;
                cwd?: unknown;
                timeoutSec?: unknown;
            };
            if (!isFleetCommandLine(a.command))
                return invalid('command', 'command is 1 … 8 KiB of text');
            const nodeIds = Array.isArray(a.nodeIds)
                ? a.nodeIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
                : [];
            if (nodeIds.length === 0)
                return invalid('nodeIds', 'nodeIds names at least one computer');
            if (nodeIds.length > FLEET_COMMAND_MAX_NODES) {
                return {
                    error: {
                        code: 'limit_exceeded',
                        hint: `a command runs on at most ${FLEET_COMMAND_MAX_NODES} computers`,
                        details: { limit: FLEET_COMMAND_MAX_NODES },
                    },
                } satisfies ToolError;
            }
            if (!args.proposals) {
                return {
                    error: {
                        code: 'confirmation_required',
                        hint: 'running a command needs the owner’s approval and no approval queue is available; ask the owner to run it',
                    },
                } satisfies ToolError;
            }
            const payload: FleetCommandProposalPayload = {
                kind: FLEET_COMMAND_PROPOSAL_KIND,
                agentId: args.agentId,
                command: a.command,
                nodeIds,
                ...(typeof a.cwd === 'string' && a.cwd.trim() ? { cwd: a.cwd.trim() } : {}),
                ...(typeof a.timeoutSec === 'number' && Number.isFinite(a.timeoutSec)
                    ? { timeoutSec: Math.floor(a.timeoutSec) }
                    : {}),
            };
            try {
                const firstLine = a.command.split(/\r?\n/, 1)[0];
                const proposal = await args.proposals.propose(args.userId, {
                    agentId: args.agentId,
                    runId: args.runId,
                    title: `Run on ${nodeIds.length === 1 ? 'one computer' : `${nodeIds.length} computers`}: ${firstLine}`.slice(
                        0,
                        200,
                    ),
                    payload: { ...payload },
                    // Every call is its own decision: the same command may rightly be asked for again.
                    subjectKey: null,
                });
                return {
                    held: true,
                    proposalId: proposal.id,
                    status: proposal.status,
                    hint: 'held for the owner’s approval in My Decisions; it runs when they approve it — read the result with fleet_commands_list',
                };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

    out.push({
        name: 'fleet_commands_list',
        description:
            "Read-only. The most recent commands Agents asked to run on the owner's computers (newest first), each with every computer's status, exit code and the head and tail of what it printed.",
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'Max commands (default 8, at most 20).' },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { limit?: unknown };
            const limit = Math.min(Math.max(Math.floor(Number(a.limit) || 8), 1), 20);
            try {
                const page = await args.service.listRecent(actor, limit, { requestedBy: 'agent' });
                return { commands: page.commands.map(compact) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ limit?: unknown }, unknown>);

    out.push({
        name: 'fleet_commands_get',
        description:
            'Read-only. One command an Agent asked to run: every computer’s status, exit code and the head and tail of its output.',
        parameters: {
            type: 'object',
            properties: { commandId: { type: 'string', description: 'The command id.' } },
            required: ['commandId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { commandId?: unknown };
            if (typeof a.commandId !== 'string' || !a.commandId)
                return invalid('commandId', 'commandId is required');
            try {
                return { command: compact(await agentCommand(a.commandId)) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ commandId?: unknown }, unknown>);

    out.push({
        name: 'fleet_commands_cancel',
        description:
            'Stop a running command an Agent asked to run, on every computer it still runs on. Each machine ends the process and everything it started.',
        parameters: {
            type: 'object',
            properties: { commandId: { type: 'string', description: 'The command id.' } },
            required: ['commandId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { commandId?: unknown };
            if (typeof a.commandId !== 'string' || !a.commandId)
                return invalid('commandId', 'commandId is required');
            try {
                const view = await agentCommand(a.commandId);
                return { command: compact(await args.service.cancel(view.id, actor)) };
            } catch (error) {
                return toolError(error);
            }
        },
    } satisfies TaskToolDescriptor<{ commandId?: unknown }, unknown>);

    return out;
}
