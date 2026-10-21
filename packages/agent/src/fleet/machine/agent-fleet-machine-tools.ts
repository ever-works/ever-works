import {
    isFleetProcessPid,
    isFleetProcessSignal,
    isFleetServiceAction,
    isFleetServiceManager,
    isFleetServiceName,
    isFleetServiceScope,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import type { FleetMachineActionsService } from './fleet-machine-actions.service';
import { readFleetMachineError } from './fleet-machine.errors';

/**
 * Machine actions (FL-09 P1, plan §9, spec FR-21, FR-22) — the Agent tools
 * of Services and Processes. Named after the permission family (CONTRACTS
 * §11.3): `fleet_services_list`, `fleet_services_action`,
 * `fleet_processes_list`, `fleet_processes_signal`.
 *
 * Every call runs the SAME chain a person's click runs
 * (`FleetMachineActionsService`): the link's gate with the Agent as the
 * caller (`agent:<id>`, the node's family audience must include the Agent's
 * owner — CONTRACTS §2.1), the confirmation, the machine, one audit row.
 * The tool satisfies a plain `confirm` class itself — calling the tool IS the
 * Agent's confirmation — but never a riskier one: an act the machine says
 * could cut it off (`blast-radius`) and every SIGKILL are HELD as an Approval
 * in the owner's My Decisions (the Agent Action Approval Queue, CONTRACTS
 * R-33); only a person's approval runs them, with the acknowledgement set
 * (`FleetMachineProposalListener`). A `root_required` refusal comes back
 * with the exact command as the hint, for the Agent to relay.
 *
 * Unbound approval queue: a held act fails CLOSED — refused with the reason,
 * never run.
 */

/** The platform-written `payload.kind` of a held machine act. */
export const FLEET_MACHINE_ACTION_PROPOSAL_KIND = 'fleet-machine-action' as const;

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_MACHINE_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_services_list: { readOnly: true },
    fleet_services_action: { destructive: true, confirmationClass: 'confirm | blast-radius' },
    fleet_processes_list: { readOnly: true },
    fleet_processes_signal: { destructive: true, confirmationClass: 'confirm' },
};

/** What a held act stores so a person's approval can run exactly it (no model-authored field). */
export interface FleetMachineActionProposalPayload {
    kind: typeof FLEET_MACHINE_ACTION_PROPOSAL_KIND;
    verb: 'services.action' | 'processes.signal';
    nodeId: string;
    agentId: string;
    /** `services.action`: name, action, scope, manager. `processes.signal`: pid, signal. */
    args: Record<string, unknown>;
    /** Why it was held: `blast-radius` (with the node's sentence) or `kill`. */
    reason: 'blast-radius' | 'kill';
    sentence?: string;
}

type ToolError = { error: FleetLinkError };

function toolError(error: unknown): ToolError {
    const known = readFleetMachineError(error);
    return {
        error: known ?? { code: 'internal', hint: error instanceof Error ? error.message.slice(0, 200) : 'failed' },
    };
}

function invalid(field: string, hint: string): ToolError {
    return { error: { code: 'invalid', hint, details: { field } } };
}

export function buildFleetMachineTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetMachineActionsService, 'listServices' | 'serviceAction' | 'listProcesses' | 'signalProcess'>;
    /** The approval seam for held acts; null = held acts are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const caller = { kind: 'agent' as const, agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    const hold = async (payload: Omit<FleetMachineActionProposalPayload, 'kind' | 'agentId'>, title: string) => {
        if (!args.proposals) {
            return {
                error: {
                    code: 'confirmation_required' as const,
                    hint: 'this act needs the owner’s approval and no approval queue is available; ask the owner to do it',
                },
            };
        }
        const full: FleetMachineActionProposalPayload = {
            kind: FLEET_MACHINE_ACTION_PROPOSAL_KIND,
            agentId: args.agentId,
            ...payload,
        };
        const subject = JSON.stringify([full.verb, full.nodeId, full.args]);
        const proposal = await args.proposals.propose(args.userId, {
            agentId: args.agentId,
            runId: args.runId,
            title: title.slice(0, 200),
            payload: { ...full },
            subjectKey: `fleet-machine:${subject.slice(0, 180)}`,
        });
        return {
            held: true,
            proposalId: proposal.id,
            status: proposal.status,
            hint: 'held for the owner’s approval in My Decisions; it runs when they approve it',
        };
    };

    out.push({
        name: 'fleet_services_list',
        description:
            'List the services of one of the owner’s computers (systemd units, launchd and Homebrew services, or Windows services), failed first, with state, since, at-boot, CPU and memory, the acts each supports and what stopping it could cut off. Read-only. Needs `--manage` on the computer.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                scope: { type: 'string', description: 'system, user or all (default all).' },
                find: { type: 'string', description: 'Optional filter on name or description.' },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown; scope?: unknown; find?: unknown };
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            try {
                return await args.service.listServices(a.nodeId, caller, {
                    ...(a.scope === 'system' || a.scope === 'user' || a.scope === 'all' ? { scope: a.scope } : {}),
                    ...(typeof a.find === 'string' ? { find: a.find } : {}),
                });
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_services_action',
        description:
            'Start, stop, restart, enable (start at boot) or disable one service on one of the owner’s computers. State-changing and audited as this Agent. An act the computer says could cut it off from Ever Works (its network, ssh, VPN, the node itself) is held for the owner’s approval instead of running; an act that needs root and is not pre-authorised is refused with the exact command for the owner to run.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                name: { type: 'string', description: 'The service name exactly as fleet_services_list shows it.' },
                action: { type: 'string', description: 'start, stop, restart, enable or disable.' },
                scope: { type: 'string', description: 'system (default) or user.' },
                manager: { type: 'string', description: 'macOS only: launchd (default) or brew.' },
            },
            required: ['nodeId', 'name', 'action'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (!isFleetServiceName(a.name)) return invalid('name', 'that is not a service name Ever Works acts on');
            if (!isFleetServiceAction(a.action)) {
                return invalid('action', 'action must be start, stop, restart, enable or disable');
            }
            if (a.scope !== undefined && !isFleetServiceScope(a.scope)) return invalid('scope', 'scope must be system or user');
            if (a.manager !== undefined && !isFleetServiceManager(a.manager)) return invalid('manager', 'unknown manager');
            const input = {
                name: a.name,
                action: a.action,
                ...(isFleetServiceScope(a.scope) ? { scope: a.scope } : {}),
                ...(isFleetServiceManager(a.manager) ? { manager: a.manager } : {}),
            };
            try {
                return await args.service.serviceAction(a.nodeId, caller, { ...input, fields: { confirm: true } });
            } catch (error) {
                const known = readFleetMachineError(error);
                if (known?.code === 'confirmation_required' && known.details?.class === 'blast-radius') {
                    const sentence = typeof known.details.sentence === 'string' ? known.details.sentence : undefined;
                    return hold(
                        {
                            verb: 'services.action',
                            nodeId: a.nodeId,
                            args: { ...input },
                            reason: 'blast-radius',
                            ...(sentence ? { sentence } : {}),
                        },
                        typeof known.details.summary === 'string'
                            ? known.details.summary
                            : `${input.action} ${input.name}`,
                    );
                }
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_processes_list',
        description:
            'List the busiest 300 processes of one of the owner’s computers by CPU (or memory) with pid, owner, run time and a secret-scanned command line, and its GPUs. Read-only. Needs `--manage` on the computer.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                sort: { type: 'string', description: 'cpu (default) or mem.' },
                find: { type: 'string', description: 'Optional filter on name, command, owner or pid.' },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown; sort?: unknown; find?: unknown };
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            try {
                return await args.service.listProcesses(a.nodeId, caller, {
                    ...(a.sort === 'mem' ? { sort: 'mem' as const } : {}),
                    ...(typeof a.find === 'string' ? { find: a.find } : {}),
                });
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_processes_signal',
        description:
            'Stop (TERM, SIGTERM) one process on one of the owner’s computers. State-changing and audited as this Agent. KILL (SIGKILL) is always held for the owner’s approval. The computer never signals its own node, its session daemon or PID 1; another user’s process needs root and is refused with the exact command unless pre-authorised.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                pid: { type: 'integer', description: 'The process id from fleet_processes_list.' },
                signal: { type: 'string', description: 'TERM (default) or KILL.' },
            },
            required: ['nodeId', 'pid'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            const pid = typeof a.pid === 'string' ? Number(a.pid) : a.pid;
            if (!isFleetProcessPid(pid)) return invalid('pid', 'pid must be a positive whole number');
            const signal = a.signal === undefined ? 'TERM' : a.signal;
            if (!isFleetProcessSignal(signal)) return invalid('signal', 'signal must be TERM or KILL');
            if (signal === 'KILL') {
                return hold(
                    { verb: 'processes.signal', nodeId: a.nodeId, args: { pid, signal }, reason: 'kill' },
                    `Send SIGKILL to process ${pid}`,
                );
            }
            try {
                return await args.service.signalProcess(a.nodeId, caller, { pid, signal, fields: { confirm: true } });
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    return out;
}
