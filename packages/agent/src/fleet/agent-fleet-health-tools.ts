import {
    FLEET_HEALTH_DEFAULT_RANGE,
    hasFleetNodeHealthReading,
    isFleetNodeHealthRange,
    isFleetNodeHealthStale,
    resolveComputerState,
    type FleetNodeHealthHistory,
    type FleetNodeHealthView,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import { config } from '../config';
import type { FleetService } from './fleet.service';
import type { FleetNodeHealthService } from './fleet-node-health.service';
import type { NeedsALookResult, NeedsALookService } from './needs-a-look/needs-a-look.service';

/**
 * Computer health (FL-03, plan §9, T-22) — the Agent / MCP / CLI shapes of
 * health, under the names FL-19's catalogue uses (FL-19 plan §9.1, CONTRACTS
 * §11.3):
 *
 *  - `fleet_nodes_health` — read-only: one computer's snapshot, whether it is
 *    stale, its state sentence and fix (the same `resolveComputerState` the
 *    page uses — spec S9), and with `range` its history. `fresh: true` asks
 *    for Refresh now (a read under CONTRACTS R-31); it needs the node link,
 *    which lives in the API, so here it answers the stored snapshot and says
 *    so (`fresh: false`) until FL-19 binds the link-backed refresh.
 *  - `fleet_nodes_needs_a_look` — read-only: the "needs a look" items for the
 *    computers the caller can see (FL-01's registry, FL-03's producers).
 *  - `fleet_nodes_wake` — the one state-changing act (`destructive: false`,
 *    confirmation `plain`, audited `node.wake`): exported as a DESCRIPTOR
 *    ({@link FLEET_NODES_WAKE_TOOL}) for FL-19, which owns Agent gates (grants,
 *    trust ladder, caps — CONTRACTS §2.1), and is never assembled here.
 *
 * Every tool answers the API's envelopes: the same shapes on success, and
 * `{ error: { code, hint } }` on refusal (CONTRACTS §8). Visibility is the
 * caller's (`getVisibleForUser`): a computer outside it is `not_found`, never
 * "exists but hidden". Nothing here spends a model token (FR-29).
 */

/** Annotations FL-19's catalogue reads (MCP tool annotations, CONTRACTS §11.3). */
export interface FleetToolAnnotations {
    readOnly: boolean;
    destructive: boolean;
    confirmationClass: 'plain' | 'typed' | 'blast-radius';
}

export const FLEET_NODES_HEALTH_TOOL_NAME = 'fleet_nodes_health';
export const FLEET_NODES_NEEDS_A_LOOK_TOOL_NAME = 'fleet_nodes_needs_a_look';
export const FLEET_NODES_WAKE_TOOL_NAME = 'fleet_nodes_wake';

export const FLEET_HEALTH_TOOL_ANNOTATIONS: Readonly<Record<string, FleetToolAnnotations>> = {
    [FLEET_NODES_HEALTH_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    [FLEET_NODES_NEEDS_A_LOOK_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    [FLEET_NODES_WAKE_TOOL_NAME]: {
        readOnly: false,
        destructive: false,
        confirmationClass: 'plain',
    },
};

/**
 * The wake tool's shape, for FL-19 to bind to `POST /api/fleet/nodes/:id/wake`
 * behind its Agent gates. Not assembled by {@link buildFleetHealthTools}.
 */
export const FLEET_NODES_WAKE_TOOL = {
    name: FLEET_NODES_WAKE_TOOL_NAME,
    description:
        'Wake an offline computer of the user: send a Wake-on-LAN packet through another online computer of theirs on the same network (one started with --manage). Answers which computer it went through; ask fleet_nodes_health 20 and 60 seconds later whether it came back. Refused when it never reported a hardware address, no computer on its network can wake it, all computers are stopped, or after 3 attempts in 5 minutes.',
    parameters: {
        type: 'object' as const,
        properties: {
            nodeId: { type: 'string' as const, description: 'The computer to wake (its id).' },
        },
        required: ['nodeId'],
    },
    annotations: FLEET_HEALTH_TOOL_ANNOTATIONS[FLEET_NODES_WAKE_TOOL_NAME],
};

export interface FleetNodesHealthArgs {
    nodeId: string;
    /** `1h` · `24h` · `7d` · `90d`: also answer the history over that range. */
    range?: string;
    /** Ask the computer for a fresh snapshot (Refresh now) instead of the stored one. */
    fresh?: boolean;
}

export interface FleetNodesHealthResult extends FleetNodeHealthView {
    /** True only when the snapshot was refreshed over the link for this call. */
    fresh: boolean;
    history?: FleetNodeHealthHistory;
}

export interface FleetNodesNeedsALookArgs {
    /** Only this computer's items. */
    nodeId?: string;
}

type ToolError = { error: { code: string; hint: string } };

function toolError(code: string, hint: string): ToolError {
    return { error: { code, hint } };
}

/** `NotFoundException`-shaped refusals become the CONTRACTS `not_found` envelope. */
function refusal(err: unknown): ToolError {
    const status = (err as { status?: unknown; getStatus?: () => number } | null)?.getStatus?.();
    if (status === 404) return toolError('not_found', 'no such computer');
    if (status === 403)
        return toolError('permission_denied', err instanceof Error ? err.message : 'not allowed');
    return toolError('internal', err instanceof Error ? err.message : String(err));
}

export function buildFleetHealthTools(args: {
    /** Visibility scope — tools only ever read what this user may see. */
    userId: string;
    service: Pick<FleetService, 'getVisibleForUser' | 'listVisibleForUser'>;
    history: Pick<FleetNodeHealthService, 'history' | 'isHistoryEnabled'>;
    needsALook?: Pick<NeedsALookService, 'forNodes'>;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: FLEET_NODES_HEALTH_TOOL_NAME,
        description:
            "Read one of the user's computers' health: CPU, memory, disk, load, uptime, GPU, pending reboot and failed services from its latest check-in (with the time it was taken and whether it is stale), its state in plain words with its one fix, and optionally its history over 1h, 24h, 7d or 90d. Read-only; spends no tokens.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: {
                    type: 'string',
                    description: 'The computer (its id, from list_fleet_nodes).',
                },
                range: {
                    type: 'string',
                    description: 'Optional history range: 1h, 24h, 7d or 90d.',
                },
                fresh: {
                    type: 'boolean',
                    description:
                        'Ask the computer for a fresh reading now instead of its last check-in.',
                },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetNodesHealthArgs;
            if (typeof a.nodeId !== 'string' || a.nodeId.length === 0) {
                return toolError('invalid', 'nodeId') as never;
            }
            if (a.range !== undefined && !isFleetNodeHealthRange(a.range)) {
                return toolError('invalid', 'range must be one of 1h, 24h, 7d, 90d') as never;
            }
            try {
                const { view } = await args.service.getVisibleForUser(args.userId, a.nodeId);
                const now = Date.now();
                const offlineAfterMs = config.fleet.getNodeOfflineAfterMs();
                const snapshot = hasFleetNodeHealthReading(view.health)
                    ? (view.health ?? null)
                    : null;
                const result: FleetNodesHealthResult = {
                    nodeId: view.id,
                    snapshot,
                    stale: isFleetNodeHealthStale(snapshot, now, offlineAfterMs),
                    state: resolveComputerState(view, {
                        now,
                        offlineAfterMs,
                        canWake: Boolean(view.canWake),
                    }),
                    historyEnabled: args.history.isHistoryEnabled(),
                    // Refresh now rides the node link, which is the API's; FL-19
                    // binds the link-backed variant. Said, never pretended.
                    fresh: false,
                };
                if (a.range !== undefined) {
                    result.history = await args.history.history(
                        view.id,
                        isFleetNodeHealthRange(a.range) ? a.range : FLEET_HEALTH_DEFAULT_RANGE,
                    );
                }
                return result;
            } catch (err) {
                return refusal(err) as never;
            }
        },
    } satisfies TaskToolDescriptor<FleetNodesHealthArgs, FleetNodesHealthResult>);

    if (args.needsALook) {
        const needsALook = args.needsALook;
        out.push({
            name: FLEET_NODES_NEEDS_A_LOOK_TOOL_NAME,
            description:
                "List what needs a look across the user's computers (or one computer): disk running low, a throttled or usage-limited computer, one that stopped itself, one that only reports health, a screen helper with reduced trust — each with its severity, a plain sentence and the one fix. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: {
                        type: 'string',
                        description: "Optional: only this computer's items.",
                    },
                },
                required: [],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as FleetNodesNeedsALookArgs;
                try {
                    const nodes = await args.service.listVisibleForUser(args.userId, {
                        includeClusters: false,
                    });
                    const scoped = a.nodeId ? nodes.filter((node) => node.id === a.nodeId) : nodes;
                    if (a.nodeId && scoped.length === 0) {
                        return toolError('not_found', 'no such computer') as never;
                    }
                    return await needsALook.forNodes(scoped, { userId: args.userId });
                } catch (err) {
                    return refusal(err) as never;
                }
            },
        } satisfies TaskToolDescriptor<FleetNodesNeedsALookArgs, NeedsALookResult>);
    }

    return out;
}
