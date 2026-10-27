import type {
    FleetGitIdentity,
    FleetGitIdentitySetResult,
    FleetTaskHandoffOptions,
} from '@ever-works/contracts';
import { config } from '../config';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import { readFleetMachineError } from './machine/fleet-machine.errors';
import type { FleetMachineCaller } from './machine/fleet-machine-node.port';
import { readFleetSessionError } from './sessions/fleet-session.errors';

/**
 * Tasks on computers (FL-15 P3, spec FR-21, CONTRACTS §11.3) — the hand-off
 * and the git identity check as Agent tools:
 *
 *  - `fleet_tasks_handoff_options` — read-only: for a Task, the computers the
 *    Agent could work it on (with why not), the checkouts of its repository on
 *    each, and the prefilled first message. The hand-off itself is the ONE
 *    session-start tool, `fleet_sessions_start` with `taskId` — never a
 *    second start tool;
 *  - `fleet_nodes_git_identity_get` — read-only: a computer's global git
 *    identity (values for the owner's own computers) and whether Ever Works
 *    can push for agents there;
 *  - `fleet_nodes_git_identity_set` — class `confirm` (family `commands`):
 *    **Use my Ever Works identity** on the owner's own computer; without
 *    `confirm: true` it answers `confirmation_required` with the sentence.
 *
 * Every act runs as the Agent's OWNER through the same services a person's
 * routes use, so the Node's audiences, the kill switch, the rate and the audit
 * row are the same. Offered only while `FLEET_CHECKOUTS_ENABLED` is on.
 */

/** Annotations FL-19's catalogue reads (MCP tool annotations, CONTRACTS §11.3). */
export const FLEET_TASK_TOOL_ANNOTATIONS: Readonly<
    Record<
        string,
        { readOnly: boolean; destructive: boolean; confirmationClass: 'plain' | 'confirm' }
    >
> = {
    fleet_tasks_handoff_options: { readOnly: true, destructive: false, confirmationClass: 'plain' },
    fleet_nodes_git_identity_get: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    fleet_nodes_git_identity_set: {
        readOnly: false,
        destructive: false,
        confirmationClass: 'confirm',
    },
};

/** The hand-off options reader (the API's `FleetTaskHandoffService`). */
export interface FleetTaskHandoffToolPort {
    options(
        userId: string,
        taskId: string,
        agentId: string | null,
    ): Promise<FleetTaskHandoffOptions>;
}

/** The identity service (`FleetGitIdentityService`). */
export interface FleetGitIdentityToolPort {
    read(
        nodeId: string,
        caller: FleetMachineCaller,
        options?: { fresh?: boolean },
    ): Promise<FleetGitIdentity>;
    set(
        nodeId: string,
        caller: FleetMachineCaller,
        request?: { confirm?: boolean },
    ): Promise<FleetGitIdentitySetResult>;
}

function failure(error: unknown): {
    error: { code: string; hint: string; details?: Record<string, unknown> };
} {
    const typed = readFleetMachineError(error) ?? readFleetSessionError(error);
    if (typed) {
        return {
            error: {
                code: typed.code,
                hint: typed.hint,
                ...(typed.details ? { details: typed.details } : {}),
            },
        };
    }
    const status = (error as { status?: number })?.status;
    if (status === 404) return { error: { code: 'not_found', hint: 'no such Task' } };
    return {
        error: { code: 'internal', hint: error instanceof Error ? error.message : String(error) },
    };
}

const UUID = /^[0-9a-f-]{36}$/i;

export function buildFleetTaskTools(args: {
    /** The Agent's owner — every act runs as them. */
    userId: string;
    agentId: string;
    handoff?: FleetTaskHandoffToolPort | null;
    identity?: FleetGitIdentityToolPort | null;
}): TaskToolDescriptor[] {
    if (!config.fleet.isCheckoutsEnabled()) return [];
    const out: TaskToolDescriptor[] = [];
    const caller: FleetMachineCaller = {
        kind: 'agent',
        agentId: args.agentId,
        ownerUserId: args.userId,
    };

    if (args.handoff) {
        const handoff = args.handoff;
        out.push({
            name: 'fleet_tasks_handoff_options',
            description:
                'For a Task: the computers you could work it on (each with why not, e.g. offline, needs --work, missing CLI, no free slot, not your pinned computer), the checkouts of its repository on each, its branch, and a prefilled first message. Then start with fleet_sessions_start and the taskId.',
            parameters: {
                type: 'object',
                properties: {
                    taskId: { type: 'string', description: 'The Task’s id.' },
                },
                required: ['taskId'],
            },
            invoke: async (raw) => {
                const taskId = String((raw as { taskId?: unknown } | null)?.taskId ?? '');
                if (!UUID.test(taskId))
                    return { error: { code: 'invalid', hint: 'taskId must be a Task id' } };
                try {
                    const options = await handoff.options(args.userId, taskId, args.agentId);
                    return {
                        task: options.task,
                        computers: options.computers,
                        checkouts: options.checkouts,
                        firstMessage: options.firstMessage,
                        killSwitch: options.killSwitch,
                        activeSessionId: options.activeSessionId,
                    };
                } catch (error) {
                    return failure(error);
                }
            },
        } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);
    }

    if (args.identity) {
        const identity = args.identity;
        out.push({
            name: 'fleet_nodes_git_identity_get',
            description:
                "A computer's global git identity (name, email, credential helper) and whether Ever Works can push for agents there, with the reason when it cannot. Needs --manage on the computer.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer’s id.' },
                    fresh: {
                        type: 'boolean',
                        description: 'Read the computer again instead of the 60 s copy.',
                    },
                },
                required: ['nodeId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: unknown; fresh?: unknown };
                try {
                    return {
                        identity: await identity.read(String(a.nodeId ?? ''), caller, {
                            fresh: a.fresh === true,
                        }),
                    };
                } catch (error) {
                    return failure(error);
                }
            },
        } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

        out.push({
            name: 'fleet_nodes_git_identity_set',
            description:
                "Use your owner's Ever Works identity on one of their computers: sets its global git user.name and user.email (their GitHub no-reply address) and nothing else. Without confirm: true it answers confirmation_required with what would be set.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer’s id.' },
                    confirm: {
                        type: 'boolean',
                        description: 'true to set it (after showing the confirmation).',
                    },
                },
                required: ['nodeId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: unknown; confirm?: unknown };
                try {
                    const result = await identity.set(String(a.nodeId ?? ''), caller, {
                        confirm: a.confirm === true,
                    });
                    return { identity: result };
                } catch (error) {
                    return failure(error);
                }
            },
        } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);
    }

    return out;
}
