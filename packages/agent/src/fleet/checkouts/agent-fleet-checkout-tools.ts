import {
    isFleetCheckoutState,
    isFleetCheckoutSyncOp,
    type FleetCheckoutCreateRequest,
    type FleetCheckoutDeleteMode,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { config } from '../../config';
import { readFleetSessionError } from '../sessions/fleet-session.errors';
import type { FleetCheckoutService } from './fleet-checkout.service';

/**
 * Checkouts on computers (FL-14 P2, spec FR-29, CONTRACTS §11.3) — the same
 * acts a person has, as Agent tools: read-only tools always, state-changing
 * ones through the Agent's permissions (the trust ladder classifies them in
 * `safety/action-category.ts`) AND the Node's `checkouts` audience, which the
 * service checks for the Agent's OWNER on every call. A confirmation class is
 * satisfied exactly as for a person (CONTRACTS §2.2): the first call answers
 * `confirmation_required` with what to confirm; the Agent repeats it with
 * `confirm: true` or `confirmName`.
 *
 * Offered only while `FLEET_CHECKOUTS_ENABLED` is on.
 */

/** Annotations FL-19's catalogue reads (MCP tool annotations, CONTRACTS §11.3). */
export interface FleetCheckoutToolAnnotations {
    readOnly: boolean;
    destructive: boolean;
    confirmationClass: 'plain' | 'confirm' | 'confirm-destructive';
}

export const FLEET_CHECKOUT_TOOL_ANNOTATIONS: Readonly<Record<string, FleetCheckoutToolAnnotations>> = {
    fleet_checkouts_list: { readOnly: true, destructive: false, confirmationClass: 'plain' },
    fleet_checkouts_get: { readOnly: true, destructive: false, confirmationClass: 'plain' },
    fleet_checkouts_create: { readOnly: false, destructive: false, confirmationClass: 'plain' },
    fleet_checkouts_sync: { readOnly: false, destructive: false, confirmationClass: 'confirm' },
    fleet_checkouts_archive: { readOnly: false, destructive: false, confirmationClass: 'confirm' },
    fleet_checkouts_delete: { readOnly: false, destructive: true, confirmationClass: 'confirm-destructive' },
};

type CheckoutToolService = Pick<
    FleetCheckoutService,
    'list' | 'listForNode' | 'get' | 'create' | 'sync' | 'archive' | 'remove'
>;

function failure(error: unknown): { error: { code: string; hint: string; details?: Record<string, unknown> } } {
    const typed = readFleetSessionError(error);
    if (typed) return { error: { code: typed.code, hint: typed.hint, ...(typed.details ? { details: typed.details } : {}) } };
    return { error: { code: 'internal', hint: error instanceof Error ? error.message : String(error) } };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildFleetCheckoutTools(args: {
    /** The Agent's owner — every act is checked against the Node's audience for THEM. */
    userId: string;
    agentId?: string;
    service: CheckoutToolService;
}): TaskToolDescriptor[] {
    if (!config.fleet.isCheckoutsEnabled()) return [];
    const actor = { userId: args.userId, ...(args.agentId ? { agentId: args.agentId } : {}) };
    const checkoutId = {
        type: 'string' as const,
        description: 'The checkout (its id, from fleet_checkouts_list).',
    };
    const tools: TaskToolDescriptor[] = [
        {
            name: 'fleet_checkouts_list',
            description:
                'List git checkouts (clones and worktrees) on the user’s computers: path, repository, branch, git line (changes, ahead/behind, uncommitted), state and size. With nodeId, one computer (asks it for fresh git lines when it is online).',
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'Only this computer.' },
                    state: { type: 'string', description: 'creating, ready, missing or archived (the bin).' },
                },
                required: [],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as { nodeId?: unknown; state?: unknown };
                const state = isFleetCheckoutState(input.state) ? input.state : undefined;
                try {
                    const nodeId = text(input.nodeId);
                    if (nodeId) return await args.service.listForNode(nodeId, actor, state ? { state } : {});
                    return await args.service.list(actor, state ? { state } : {});
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_checkouts_get',
            description: 'One checkout, with its git line and last command.',
            parameters: { type: 'object', properties: { checkoutId }, required: ['checkoutId'] },
            invoke: async (raw) => {
                try {
                    return await args.service.get(text((raw as { checkoutId?: unknown })?.checkoutId) ?? '', actor);
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_checkouts_create',
            description:
                'Create a checkout on a computer: a fresh clone of repoUrl, or a new worktree of an existing checkout (parentCheckoutId) on a new branch. Answers at once with the checkout in state creating; it becomes ready when the computer finishes. Uses disk on that computer; no credits.',
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer.' },
                    repoUrl: { type: 'string', description: 'For a fresh clone: the repository URL (no credential in it).' },
                    parentCheckoutId: { type: 'string', description: 'For a worktree: the checkout to branch off.' },
                    branch: { type: 'string', description: 'Branch name; proposed (and made unique) when absent.' },
                    baseRef: { type: 'string', description: 'What a new branch starts from.' },
                },
                required: ['nodeId'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as Record<string, unknown>;
                const parentCheckoutId = text(input.parentCheckoutId);
                const repoUrl = text(input.repoUrl);
                const request: FleetCheckoutCreateRequest = {
                    nodeId: text(input.nodeId) ?? '',
                    source: parentCheckoutId
                        ? { kind: 'worktree', parentCheckoutId }
                        : { kind: 'clone', repoUrl: repoUrl ?? '' },
                };
                const branch = text(input.branch);
                const baseRef = text(input.baseRef);
                if (branch) request.branch = branch;
                if (baseRef) request.baseRef = baseRef;
                try {
                    return await args.service.create(actor, request);
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_checkouts_sync',
            description:
                'Fetch, pull (fast-forward only) or push a checkout on its computer. Fetch needs no confirmation; pull and push answer confirmation_required first — repeat with confirm: true after the user agreed.',
            parameters: {
                type: 'object',
                properties: {
                    checkoutId,
                    op: { type: 'string', description: 'fetch, pull or push.' },
                    confirm: { type: 'boolean', description: 'The user confirmed this pull or push.' },
                },
                required: ['checkoutId', 'op'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as { checkoutId?: unknown; op?: unknown; confirm?: unknown };
                if (!isFleetCheckoutSyncOp(input.op)) {
                    return { error: { code: 'invalid', hint: 'op must be fetch, pull or push' } };
                }
                try {
                    return await args.service.sync(text(input.checkoutId) ?? '', actor, {
                        op: input.op,
                        confirm: input.confirm === true,
                    });
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_checkouts_archive',
            description:
                'Move a checkout to the bin (the folder is not touched). Answers confirmation_required first; repeat with confirm: true.',
            parameters: {
                type: 'object',
                properties: { checkoutId, confirm: { type: 'boolean' } },
                required: ['checkoutId'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as { checkoutId?: unknown; confirm?: unknown };
                try {
                    return await args.service.archive(text(input.checkoutId) ?? '', actor, {
                        confirm: input.confirm === true,
                    });
                } catch (error) {
                    return failure(error);
                }
            },
        },
        {
            name: 'fleet_checkouts_delete',
            description:
                'Delete a checkout Ever Works created (its folder; a worktree keeps its branch), or forget one found on the computer (mode forget: row only). The first call answers confirmation_required with what would be lost; repeat with confirm: true when nothing would be, else with confirmName set to the folder name the user typed.',
            parameters: {
                type: 'object',
                properties: {
                    checkoutId,
                    mode: { type: 'string', description: 'delete or forget.' },
                    confirm: { type: 'boolean' },
                    confirmName: { type: 'string', description: 'The checkout’s folder name, typed by the user.' },
                },
                required: ['checkoutId'],
            },
            invoke: async (raw) => {
                const input = (raw ?? {}) as Record<string, unknown>;
                const mode = input.mode === 'delete' || input.mode === 'forget' ? (input.mode as FleetCheckoutDeleteMode) : undefined;
                try {
                    return await args.service.remove(text(input.checkoutId) ?? '', actor, {
                        ...(mode ? { mode } : {}),
                        confirm: input.confirm === true,
                        ...(text(input.confirmName) ? { confirmName: text(input.confirmName) } : {}),
                    });
                } catch (error) {
                    return failure(error);
                }
            },
        },
    ];
    return tools;
}
