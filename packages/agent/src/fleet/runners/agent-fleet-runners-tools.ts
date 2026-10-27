import {
    clampFleetActionsRunnerCount,
    isFleetActionsRunnerControlAction,
    isFleetActionsRunnerName,
    isFleetActionsRunnerScope,
    isFleetActionsRunnerTarget,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import { readFleetMachineError } from '../machine/fleet-machine.errors';
import type { FleetActionsRunnersService } from './fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18, plan §9, spec FR-29, FR-30, S8) — the
 * Agent tools, named after the API segment (CONTRACTS §11.3):
 * `fleet_runners_list` (read-only), `fleet_runners_install`,
 * `fleet_runners_action`, `fleet_runners_remove` (destructive). Phase 2 adds
 * `fleet_runners_jobs` and `fleet_runners_cancel_run`.
 *
 * Every call runs the SAME chain a person's click runs
 * (`FleetActionsRunnersService`) with the Agent as the caller (`agent:<id>`;
 * the computer's `machines` audience must include the Agent's owner —
 * CONTRACTS §2.1): existence, the kill switch, the computer, the request, the
 * confirmation. An install, a stop, a restart and a remove are never run by the
 * Agent itself: once the chain has accepted everything but the confirmation,
 * the act is HELD as an Approval in the owner's My Decisions (CONTRACTS R-33),
 * titled with the confirmation's own summary — "Installs 2 Actions runners for
 * acme/api on build-01 as services. They run CI jobs on that computer; no
 * credits are spent." — and the call answers `{ held: true, proposalId }`. A
 * person's approval runs it (`FleetActionsRunnersProposalListener`). A start
 * (`plain`) runs at once. Unbound approval queue: a held act fails CLOSED.
 */

/** The platform-written `payload.kind` of a held runner act. */
export const FLEET_RUNNERS_ACTION_PROPOSAL_KIND = 'fleet-runners-action' as const;

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_RUNNERS_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_runners_list: { readOnly: true },
    fleet_runners_install: { destructive: true, confirmationClass: 'confirm' },
    fleet_runners_action: { destructive: true, confirmationClass: 'plain | confirm' },
    fleet_runners_remove: { destructive: true, confirmationClass: 'confirm-destructive' },
};

/** What a held act stores so a person's approval can run exactly it (no model-authored free text). */
export interface FleetRunnersActionProposalPayload {
    kind: typeof FLEET_RUNNERS_ACTION_PROPOSAL_KIND;
    verb: 'install' | 'stop' | 'restart' | 'remove';
    agentId: string;
    nodeId: string;
    /** stop / restart / remove: the runner. */
    runnerId?: string;
    /** install: target, count, names, labels. remove: name (the typed confirmation). */
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

function stringList(value: unknown, max: number): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const out = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());
    return out.length === value.length ? out.slice(0, max) : null;
}

export function buildFleetRunnersTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetActionsRunnersService, 'list' | 'listAll' | 'install' | 'control'>;
    /** The approval seam for held acts; null = held acts are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const caller = { kind: 'agent' as const, agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    const hold = async (payload: Omit<FleetRunnersActionProposalPayload, 'kind' | 'agentId'>, title: string) => {
        if (!args.proposals) {
            return {
                error: {
                    code: 'confirmation_required' as const,
                    hint: 'this act needs the owner’s approval and no approval queue is available; ask the owner to do it',
                },
            };
        }
        const full: FleetRunnersActionProposalPayload = {
            kind: FLEET_RUNNERS_ACTION_PROPOSAL_KIND,
            agentId: args.agentId,
            ...payload,
        };
        const subject = JSON.stringify([full.verb, full.nodeId, full.runnerId ?? null, full.args]);
        const proposal = await args.proposals.propose(args.userId, {
            agentId: args.agentId,
            runId: args.runId,
            title: title.slice(0, 200),
            payload: { ...full },
            subjectKey: `fleet-runners:${subject.slice(0, 180)}`,
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
        name: 'fleet_runners_list',
        description:
            'List the GitHub Actions self-hosted runners on one of the owner’s computers — or, without nodeId, on all of them — with repository or organisation, labels, state (installing · idle · working · offline · stopped · failed · unknown), where the state came from and when it was last checked. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Optional: the computer (Fleet node id).' },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown };
            try {
                if (typeof a.nodeId === 'string' && a.nodeId) return await args.service.list(caller, a.nodeId);
                return { computers: await args.service.listAll(caller) };
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_runners_install',
        description:
            'Install 1 to 16 GitHub Actions self-hosted runners on one of the owner’s computers, registered for a repository (owner/repo) or an organisation the Ever Works GitHub App is installed on, as services. The runner build is downloaded from GitHub and its checksum verified; registration goes through the GitHub App (no token is ever shown). Runners cost nothing in Ever Works. Never runs on the Agent’s say-so: once checked, it is held for the owner’s approval with the exact target, count, mode and computer.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                scope: { type: 'string', description: 'repo or org.' },
                target: { type: 'string', description: 'owner/repo (scope repo) or the organisation (scope org).' },
                count: { type: 'number', description: '1–16 (default 1).' },
                names: { type: 'array', items: { type: 'string' }, description: 'Optional: one name per runner (default <computer>-<n>).' },
                labels: { type: 'array', items: { type: 'string' }, description: 'Optional: extra labels (GitHub adds self-hosted, the OS and the architecture).' },
            },
            required: ['nodeId', 'scope', 'target'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (!isFleetActionsRunnerScope(a.scope)) return invalid('scope', 'scope must be repo or org');
            if (!isFleetActionsRunnerTarget(a.scope, a.target)) {
                return invalid('target', a.scope === 'org' ? 'target must be an organisation' : 'target must be owner/repo');
            }
            const count = clampFleetActionsRunnerCount(a.count ?? 1);
            const names = stringList(a.names, 16);
            if (names === null || names.some((name) => !isFleetActionsRunnerName(name))) {
                return invalid('names', 'names must be runner names (letters, digits, dots, dashes, underscores)');
            }
            const labels = stringList(a.labels, 20);
            if (labels === null) return invalid('labels', 'labels must be a list of strings');
            const input = {
                target: { scope: a.scope, target: a.target as string },
                count,
                ...(names.length > 0 ? { names } : {}),
                ...(labels.length > 0 ? { labels } : {}),
                mode: 'service' as const,
            };
            try {
                // Without `confirm`: the whole chain runs and answers with the summary.
                await args.service.install(caller, a.nodeId, { ...input, fields: {} });
                // Not reachable: an install always needs `confirm`. Belt: never report success without it.
                return { error: { code: 'internal' as const, hint: 'the install was not confirmed' } };
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                return hold(
                    { verb: 'install', nodeId: a.nodeId, args: { ...input } },
                    summary || `Install ${count} Actions runners for ${String(a.target)}`,
                );
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_runners_action',
        description:
            'Start, stop or restart one Actions runner on one of the owner’s computers. Start runs at once; a stop or a restart is held for the owner’s approval (a stopped runner takes no jobs until started; a job in progress finishes first).',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                runnerId: { type: 'string', description: 'The runner (from fleet_runners_list).' },
                action: { type: 'string', description: 'start, stop or restart.' },
            },
            required: ['nodeId', 'runnerId', 'action'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (typeof a.runnerId !== 'string' || !a.runnerId) return invalid('runnerId', 'runnerId is required');
            if (!isFleetActionsRunnerControlAction(a.action) || (a.action !== 'start' && a.action !== 'stop' && a.action !== 'restart')) {
                return invalid('action', 'action must be start, stop or restart');
            }
            const action = a.action;
            try {
                return await args.service.control(caller, a.nodeId, a.runnerId, action, {});
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                return hold(
                    { verb: action === 'restart' ? 'restart' : 'stop', nodeId: a.nodeId, runnerId: a.runnerId, args: {} },
                    summary || `${action === 'restart' ? 'Restart' : 'Stop'} an Actions runner`,
                );
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_runners_remove',
        description:
            'Remove one Actions runner: deregister it at GitHub, uninstall its service and delete its folder on the computer. Irreversible, so it is always held for the owner’s approval; refused while the runner is working on a job.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (Fleet node id).' },
                runnerId: { type: 'string', description: 'The runner (from fleet_runners_list).' },
                name: { type: 'string', description: 'The runner’s exact name.' },
            },
            required: ['nodeId', 'runnerId', 'name'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (typeof a.runnerId !== 'string' || !a.runnerId) return invalid('runnerId', 'runnerId is required');
            if (!isFleetActionsRunnerName(a.name)) return invalid('name', 'the name is not a runner name');
            try {
                // Without `confirmName`: the chain runs (busy, permission, kill switch) and answers with the summary.
                await args.service.control(caller, a.nodeId, a.runnerId, 'remove', {});
                return { error: { code: 'internal' as const, hint: 'the remove was not confirmed' } };
            } catch (error) {
                const summary = confirmationSummary(error);
                if (summary === null) return toolError(error);
                return hold(
                    { verb: 'remove', nodeId: a.nodeId, runnerId: a.runnerId, args: { name: a.name } },
                    summary || `Remove ${a.name}`,
                );
            }
        },
    } as TaskToolDescriptor);

    return out;
}
