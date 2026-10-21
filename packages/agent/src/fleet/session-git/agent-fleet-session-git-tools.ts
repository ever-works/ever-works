import { isFleetSessionActionId, type FleetOpenPullRequestRequest, type FleetOpenPullRequestResponse } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { config } from '../../config';
import type { FleetCheckoutService } from '../checkouts/fleet-checkout.service';
import { readFleetSessionError } from '../sessions/fleet-session.errors';
import type { FleetSessionActionService } from './fleet-session-action.service';

/**
 * Session git & actions (FL-06 P3, spec FR-26, CONTRACTS §11.3) — the same
 * acts a person has around a session's checkout, as Agent tools:
 *
 *  - `fleet_sessions_actions_list` (read-only) — the seven actions of a
 *    session, offered or not and why, with their rendered prompts;
 *  - `fleet_sessions_action` (`destructive: false`, `plain`) — type one into
 *    a session in the Node's `sessions` audience (an Agent's action never
 *    answers a permission prompt; the service refuses it);
 *  - `fleet_checkouts_changes` (read-only) — a checkout's uncommitted diff;
 *  - `fleet_checkouts_open_pull_request` (`destructive: false`, `plain`) —
 *    the platform opens or updates the pull request through the GitHub App,
 *    under the Agent's "may open pull requests" permission; never merges.
 *
 * Clean up for an Agent is FL-14's `fleet_checkouts_delete` with the clean-up
 * gate — there is no second delete tool. Every call is checked against the
 * Node's audience for the Agent's OWNER. Offered only while
 * `FLEET_SESSIONS_ENABLED` is on (the checkout tools also need
 * `FLEET_CHECKOUTS_ENABLED`).
 */

/** Annotations FL-19's catalogue reads (MCP tool annotations, CONTRACTS §11.3). */
export const FLEET_SESSION_GIT_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly: boolean; destructive: boolean; confirmationClass: 'plain' | 'confirm' | 'confirm-destructive' }>
> = {
    fleet_sessions_actions_list: { readOnly: true, destructive: false, confirmationClass: 'plain' },
    fleet_sessions_action: { readOnly: false, destructive: false, confirmationClass: 'plain' },
    fleet_checkouts_changes: { readOnly: true, destructive: false, confirmationClass: 'plain' },
    fleet_checkouts_open_pull_request: { readOnly: false, destructive: false, confirmationClass: 'plain' },
};

/** The API's pull-request service, as the tools reach it (the GitHub App credentials are the API's). */
export interface FleetSessionPullRequestOpener {
    open(
        checkoutId: string,
        caller: { userId: string; agentId?: string | null },
        request: FleetOpenPullRequestRequest,
    ): Promise<FleetOpenPullRequestResponse>;
}

function failure(error: unknown): { error: { code: string; hint: string; details?: Record<string, unknown> } } {
    const typed = readFleetSessionError(error);
    if (typed) return { error: { code: typed.code, hint: typed.hint, ...(typed.details ? { details: typed.details } : {}) } };
    return { error: { code: 'internal', hint: error instanceof Error ? error.message : String(error) } };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildFleetSessionGitTools(args: {
    /** The Agent's owner — every act is checked against the Node's audience for THEM. */
    userId: string;
    agentId?: string;
    actions: Pick<FleetSessionActionService, 'list' | 'send'>;
    checkouts?: Pick<FleetCheckoutService, 'changes'> | null;
    pullRequests?: FleetSessionPullRequestOpener | null;
}): TaskToolDescriptor[] {
    if (!config.fleet.isSessionsEnabled()) return [];
    const actor = { userId: args.userId, ...(args.agentId ? { agentId: args.agentId } : {}) };
    const sessionId = { type: 'string' as const, description: 'The session (its id, from fleet_sessions_list).' };
    const checkoutId = { type: 'string' as const, description: 'The checkout (its id, from fleet_checkouts_list).' };
    const tools: TaskToolDescriptor[] = [
        {
            name: 'fleet_sessions_actions_list',
            description:
                'The actions a session on a computer offers right now — commit, commit and push, open or update the pull request, review the changes, fix the review comments, resolve conflicts, write a recap — each with whether it is available, why not, and the prompt it would type.',
            parameters: { type: 'object', properties: { sessionId }, required: ['sessionId'] },
            invoke: async (raw) => {
                try {
                    return await args.actions.list(text((raw as { sessionId?: unknown })?.sessionId) ?? '', actor);
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_sessions_action',
            description:
                'Type one of a session’s actions into it, as owner input: the agent in the session still asks before running anything it was not allowed. With no prompt the action’s own template is used. Refused when the action is not offered, within 2 s of another, past 10 a minute, while the session waits on a permission prompt, under the kill switch, or while the computer is offline. No credits beyond the session’s own model use.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId,
                    actionId: {
                        type: 'string',
                        description: 'commit, commitPush, pullRequest, review, fixComments, resolveConflicts or recap.',
                    },
                    prompt: { type: 'string', description: 'The prompt to type; the action’s template when absent.' },
                },
                required: ['sessionId', 'actionId'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as Record<string, unknown>;
                const id = text(input.sessionId) ?? '';
                if (!isFleetSessionActionId(input.actionId)) {
                    return { error: { code: 'invalid', hint: 'actionId is one of the seven actions' } };
                }
                try {
                    let prompt = text(input.prompt);
                    if (!prompt) prompt = (await args.actions.list(id, actor)).templates[input.actionId].text;
                    return await args.actions.send(id, actor, { actionId: input.actionId, prompt });
                } catch (error) {
                    return failure(error);
                }
            },
        },
    ];
    if (args.checkouts && config.fleet.isCheckoutsEnabled()) {
        const checkouts = args.checkouts;
        tools.push({
            name: 'fleet_checkouts_changes',
            description:
                'The uncommitted diff of a checkout, read on its computer: changed files with lines added and removed and each patch as plain text, capped at 1 MiB (64 KiB per file), saying what was left out. Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    checkoutId,
                    maxBytes: { type: 'number', description: 'At most this many bytes of patch text (4 KiB … 1 MiB).' },
                },
                required: ['checkoutId'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as Record<string, unknown>;
                try {
                    return await checkouts.changes(
                        text(input.checkoutId) ?? '',
                        actor,
                        typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
                    );
                } catch (error) {
                    return failure(error);
                }
            },
        });
    }
    if (args.pullRequests && config.fleet.isCheckoutsEnabled()) {
        const pullRequests = args.pullRequests;
        tools.push({
            name: 'fleet_checkouts_open_pull_request',
            description:
                'Ask Ever Works to open the pull request of a checkout’s pushed branch — or to update the title and body of the one already open — through the GitHub App. Needs the "may open pull requests" permission; push the branch first. Never merges: the merge policy decides that.',
            parameters: {
                type: 'object',
                properties: {
                    checkoutId,
                    title: { type: 'string', description: 'At most 70 characters.' },
                    body: { type: 'string', description: 'What changed and why.' },
                    draft: { type: 'boolean' },
                    sessionId: { type: 'string', description: 'The session the pull request comes from (its ledger is credited).' },
                },
                required: ['checkoutId', 'title'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as Record<string, unknown>;
                try {
                    return await pullRequests.open(
                        text(input.checkoutId) ?? '',
                        { userId: args.userId, agentId: args.agentId ?? null },
                        {
                            title: text(input.title) ?? '',
                            ...(text(input.body) ? { body: text(input.body) } : {}),
                            ...(input.draft === true ? { draft: true } : {}),
                            ...(text(input.sessionId) ? { sessionId: text(input.sessionId) } : {}),
                        },
                    );
                } catch (error) {
                    return failure(error);
                }
            },
        });
    }
    return tools;
}
