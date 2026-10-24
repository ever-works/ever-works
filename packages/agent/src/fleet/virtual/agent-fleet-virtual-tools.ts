import {
    isFleetVirtualCpus,
    isFleetVirtualDiskGiB,
    isFleetVirtualMemoryGiB,
    isFleetVirtualName,
    isFleetVirtualPowerAction,
    isFleetVirtualSystemId,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import { readFleetMachineError } from '../machine/fleet-machine.errors';
import type { FleetVirtualService } from './fleet-virtual.service';

/**
 * Virtual computers (FL-16, plan §9, spec FR-35, FR-36, S9) — the Agent tools,
 * named after the API segment (CONTRACTS §11.3): `fleet_virtual_list`,
 * `fleet_virtual_options` (read-only), `fleet_virtual_create`,
 * `fleet_virtual_power`, `fleet_virtual_destroy` (destructive).
 *
 * Every call runs the SAME chain a person's click runs (`FleetVirtualService`)
 * with the Agent as the caller (`agent:<id>`; the host's `machines` audience
 * must include the Agent's owner — CONTRACTS §2.1): existence, the kill
 * switch, the host's eligibility, the request, the confirmation. A create, a
 * stop and a destroy are never run by the Agent itself: once the chain has
 * accepted everything but the confirmation, the act is HELD as an Approval in
 * the owner's My Decisions (the Agent Action Approval Queue, CONTRACTS R-33)
 * titled with the confirmation's own summary — "Creates a Container on build-01
 * using 2 CPUs, 4 GB of memory and about 3 GB of disk. No credits are spent."
 * — and the call answers `{ held: true, proposalId }`. A person's approval runs
 * it (`FleetVirtualProposalListener`). A start (`plain`) runs at once.
 *
 * Unbound approval queue: a held act fails CLOSED — refused, never run.
 */

/** The platform-written `payload.kind` of a held virtual-computer act. */
export const FLEET_VIRTUAL_ACTION_PROPOSAL_KIND = 'fleet-virtual-action' as const;

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_VIRTUAL_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_virtual_list: { readOnly: true },
    fleet_virtual_options: { readOnly: true },
    fleet_virtual_create: { destructive: true, confirmationClass: 'confirm' },
    fleet_virtual_power: { destructive: true, confirmationClass: 'plain | confirm' },
    fleet_virtual_destroy: { destructive: true, confirmationClass: 'confirm-destructive' },
};

/** What a held act stores so a person's approval can run exactly it (no model-authored free text). */
export interface FleetVirtualActionProposalPayload {
    kind: typeof FLEET_VIRTUAL_ACTION_PROPOSAL_KIND;
    verb: 'create' | 'stop' | 'destroy';
    agentId: string;
    /** The host the act is on (a create's resolved host — "Choose for me" is resolved before holding). */
    hostNodeId: string;
    /** stop / destroy: the child. */
    childNodeId?: string;
    /** create: name, systemId, cpus, memoryGiB, diskGiB. destroy: name (the typed confirmation). */
    args: Record<string, unknown>;
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

export function buildFleetVirtualTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetVirtualService, 'options' | 'listChildren' | 'listAllChildren' | 'create' | 'power' | 'destroy'>;
    /** The approval seam for held acts; null = held acts are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const caller = { kind: 'agent' as const, agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    const hold = async (payload: Omit<FleetVirtualActionProposalPayload, 'kind' | 'agentId'>, title: string) => {
        if (!args.proposals) {
            return {
                error: {
                    code: 'confirmation_required' as const,
                    hint: 'this act needs the owner’s approval and no approval queue is available; ask the owner to do it',
                },
            };
        }
        const full: FleetVirtualActionProposalPayload = {
            kind: FLEET_VIRTUAL_ACTION_PROPOSAL_KIND,
            agentId: args.agentId,
            ...payload,
        };
        const subject = JSON.stringify([full.verb, full.hostNodeId, full.childNodeId ?? null, full.args]);
        const proposal = await args.proposals.propose(args.userId, {
            agentId: args.agentId,
            runId: args.runId,
            title: title.slice(0, 200),
            payload: { ...full },
            subjectKey: `fleet-virtual:${subject.slice(0, 180)}`,
        });
        return {
            held: true,
            proposalId: proposal.id,
            decisionId: proposal.id,
            status: proposal.status,
            hint: 'held for the owner’s approval in My Decisions; it runs when they approve it',
        };
    };

    /** The summary a `confirmation_required` refusal carried, or null when the error is anything else. */
    const confirmationSummary = (error: unknown): string | null => {
        const known = readFleetMachineError(error);
        if (known?.code !== 'confirmation_required') return null;
        return typeof known.details?.summary === 'string' ? known.details.summary : '';
    };

    out.push({
        name: 'fleet_virtual_list',
        description:
            'List the virtual computers (Containers, Windows VMs) on one of the owner’s computers — or, without hostNodeId, on all of them — with system, size, create phase and state, and each host’s memory net of what they reserve. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                hostNodeId: { type: 'string', description: 'Optional: the host computer (Fleet node id).' },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { hostNodeId?: unknown };
            try {
                if (typeof a.hostNodeId === 'string' && a.hostNodeId) {
                    return await args.service.listChildren(caller, a.hostNodeId);
                }
                return { hosts: await args.service.listAllChildren(caller) };
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_virtual_options',
        description:
            'Which of the owner’s computers can host a new virtual computer of a given system, with free memory, free disk, KVM and the reason each other one cannot (offline, management off, no Docker, Windows, itself virtual, 4 of 4), plus the systems, sizes and the host "Choose for me" would pick. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                systemId: {
                    type: 'string',
                    description: 'ubuntu-26.04, ubuntu-24.04, debian-13, fedora, alpine or arch (default ubuntu-26.04).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { systemId?: unknown };
            try {
                return await args.service.options(caller, isFleetVirtualSystemId(a.systemId) ? a.systemId : undefined);
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_virtual_create',
        description:
            'Create a Container on one of the owner’s computers (or let Ever Works pick the host with the most free memory). It uses that computer’s CPU, memory and disk; no credits are spent; it enrols itself as its own computer in about a minute. Never runs on the Agent’s say-so: once checked, it is held for the owner’s approval with the exact host, CPUs, memory and disk.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '2–39 lower-case letters, digits and hyphens.' },
                systemId: { type: 'string', description: 'ubuntu-26.04, ubuntu-24.04, debian-13, fedora, alpine or arch.' },
                hostNodeId: { type: 'string', description: 'Optional: the host computer; omitted = Choose for me.' },
                cpus: { type: 'number', description: '2, 4 or 8 (default 4).' },
                memoryGiB: { type: 'number', description: '4, 8 or 16 (default 8).' },
            },
            required: ['name', 'systemId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (!isFleetVirtualName(a.name)) {
                return invalid('name', 'the name must be 2–39 lower-case letters, digits and hyphens');
            }
            if (!isFleetVirtualSystemId(a.systemId)) return invalid('systemId', 'choose one of the listed systems');
            if (a.cpus !== undefined && !isFleetVirtualCpus(a.cpus)) return invalid('cpus', 'CPUs must be 2, 4 or 8');
            if (a.memoryGiB !== undefined && !isFleetVirtualMemoryGiB(a.memoryGiB)) {
                return invalid('memoryGiB', 'memory must be 4, 8 or 16 GB');
            }
            if (a.diskGiB !== undefined && !isFleetVirtualDiskGiB(a.diskGiB)) {
                return invalid('diskGiB', 'disk must be 64, 128 or 256 GB');
            }
            const requestedHost = typeof a.hostNodeId === 'string' && a.hostNodeId ? a.hostNodeId : 'auto';
            const input = {
                name: a.name,
                systemId: a.systemId,
                ...(isFleetVirtualCpus(a.cpus) ? { cpus: a.cpus } : {}),
                ...(isFleetVirtualMemoryGiB(a.memoryGiB) ? { memoryGiB: a.memoryGiB } : {}),
                ...(isFleetVirtualDiskGiB(a.diskGiB) ? { diskGiB: a.diskGiB } : {}),
            };
            try {
                // Without `confirm`: the whole chain runs and answers with the summary.
                await args.service.create(caller, requestedHost, { ...input, fields: {} });
                // Not reachable: create always needs `confirm`. Belt: never report success without it.
                return { error: { code: 'internal' as const, hint: 'the create was not confirmed' } };
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                const details = readFleetMachineError(error)?.details ?? {};
                const hostNodeId =
                    typeof details.hostNodeId === 'string' && details.hostNodeId
                        ? details.hostNodeId
                        : requestedHost;
                return hold({ verb: 'create', hostNodeId, args: { ...input } }, summary || `Create ${input.name}`);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_virtual_power',
        description:
            'Start or stop one of the owner’s virtual computers. Start runs at once; stop is held for the owner’s approval (a Container stops within 10 seconds; Windows gets 2 minutes to shut down; sessions on it end).',
        parameters: {
            type: 'object',
            properties: {
                hostNodeId: { type: 'string', description: 'The host computer (Fleet node id).' },
                childNodeId: { type: 'string', description: 'The virtual computer (Fleet node id).' },
                action: { type: 'string', description: 'start or stop.' },
            },
            required: ['hostNodeId', 'childNodeId', 'action'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.hostNodeId !== 'string' || !a.hostNodeId) return invalid('hostNodeId', 'hostNodeId is required');
            if (typeof a.childNodeId !== 'string' || !a.childNodeId) return invalid('childNodeId', 'childNodeId is required');
            if (!isFleetVirtualPowerAction(a.action)) return invalid('action', 'action must be start or stop');
            try {
                return await args.service.power(caller, a.hostNodeId, a.childNodeId, a.action, {});
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                return hold(
                    { verb: 'stop', hostNodeId: a.hostNodeId, childNodeId: a.childNodeId, args: {} },
                    summary || 'Stop a virtual computer',
                );
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_virtual_destroy',
        description:
            'Destroy one of the owner’s virtual computers: its machine and disk on the host, then its Fleet registration (job history is kept). Irreversible, so it is always held for the owner’s approval; refused while a Run or a session is live on it.',
        parameters: {
            type: 'object',
            properties: {
                hostNodeId: { type: 'string', description: 'The host computer (Fleet node id).' },
                childNodeId: { type: 'string', description: 'The virtual computer (Fleet node id).' },
                name: { type: 'string', description: 'The virtual computer’s exact name.' },
            },
            required: ['hostNodeId', 'childNodeId', 'name'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.hostNodeId !== 'string' || !a.hostNodeId) return invalid('hostNodeId', 'hostNodeId is required');
            if (typeof a.childNodeId !== 'string' || !a.childNodeId) return invalid('childNodeId', 'childNodeId is required');
            if (!isFleetVirtualName(a.name)) return invalid('name', 'the name is not a virtual computer name');
            try {
                // Without `confirmName`: the chain runs (busy, permission, kill switch) and answers with the summary.
                await args.service.destroy(caller, a.hostNodeId, a.childNodeId, {});
                return { error: { code: 'internal' as const, hint: 'the destroy was not confirmed' } };
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                return hold(
                    { verb: 'destroy', hostNodeId: a.hostNodeId, childNodeId: a.childNodeId, args: { name: a.name } },
                    summary || `Destroy ${a.name}`,
                );
            }
        },
    } as TaskToolDescriptor);

    return out;
}
