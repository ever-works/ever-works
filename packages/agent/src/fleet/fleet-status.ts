import type {
    FleetGitIdentity,
    FleetGitIdentitySetResult,
    FleetKillSwitchState,
    FleetNodeWakeResult,
    FleetNodeView,
    FleetOperationCancelResult,
    FleetOperationState,
    FleetOperationView,
    FleetStatusComputer,
    FleetStatusView,
    NeedsALookItem,
} from '@ever-works/contracts';

/**
 * FL-19 — "how is my fleet?" in one read-only call (spec FR-4, S1).
 *
 * `fleet_status` (Agent), `GET /api/fleet/status` (web, MCP, CLI) and
 * `ever-works fleet status` answer the same object: every computer the caller
 * may see (name, status, platform, consents, compact health, live session
 * count), the Needs-a-look list, the kill-switch state and a server
 * timestamp. The composition is pure so the shape is pinned by a test; the
 * API's `FleetStatusService` does the reads and calls it, and binds itself
 * under {@link FLEET_STATUS_READER} for the Agent tool.
 */

/** The reads the composition needs, already done. */
export interface ComposeFleetStatusInput {
    nodes: readonly FleetNodeView[];
    needsALook: readonly NeedsALookItem[];
    needsALookPartial: boolean;
    killSwitch: FleetKillSwitchState;
    /** Live sessions per node id; null when sessions are off or could not be read. */
    liveSessionsByNode: ReadonlyMap<string, number> | null;
    now: Date;
}

/** Compact health: the four numbers a one-line summary needs, and when they were read. */
function compactHealth(node: FleetNodeView): FleetStatusComputer['health'] {
    const health = node.health;
    if (!health) return null;
    const out: NonNullable<FleetStatusComputer['health']> = {};
    if (typeof health.cpuPercent === 'number') out.cpuPercent = health.cpuPercent;
    if (typeof health.memPercent === 'number') out.memPercent = health.memPercent;
    if (typeof health.diskPercent === 'number') out.diskPercent = health.diskPercent;
    if (typeof health.diskFreeMiB === 'number') out.diskFreeMiB = health.diskFreeMiB;
    if (typeof health.at === 'string') out.at = health.at;
    return Object.keys(out).length > 0 ? out : null;
}

export function composeFleetStatus(input: ComposeFleetStatusInput): FleetStatusView {
    const computers: FleetStatusComputer[] = input.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        status: node.status,
        kind: node.kind,
        platform: node.platform ?? null,
        viewerRole: node.viewerRole ?? 'owner',
        consents: node.consents ? { ...node.consents } : null,
        health: compactHealth(node),
        sessionCount: input.liveSessionsByNode ? (input.liveSessionsByNode.get(node.id) ?? 0) : null,
        lastSeenAt: node.lastHeartbeatAt ?? null,
    }));
    return {
        computers,
        needsALook: [...input.needsALook],
        needsALookPartial: input.needsALookPartial,
        killSwitch: { ...input.killSwitch },
        generatedAt: input.now.toISOString(),
    };
}

/** The API's half of `fleet_status` (bound by the API's fleet tools module). */
export interface FleetStatusReaderPort {
    status(userId: string): Promise<FleetStatusView>;
}

/** DI token the API binds to its `FleetStatusService`. */
export const FLEET_STATUS_READER = 'FLEET_STATUS_READER' as const;

/**
 * The API's operations registry (FL-02 `FleetOperationsService`), as the
 * `fleet_operations_*` tools read it: one operation, the caller's recent
 * ones, and a cancel. The registry already scopes every read to the person
 * who asked or the node's owner (`not_found` otherwise).
 */
export interface FleetOperationsToolPort {
    get(operationId: string, userId: string): FleetOperationView;
    listForUser(
        userId: string,
        query?: { state?: FleetOperationState; nodeId?: string; limit?: number },
    ): FleetOperationView[];
    requestCancel?(operationId: string, userId: string): Promise<FleetOperationCancelResult>;
}

/**
 * FL-19 P2 — `fleet_nodes_wake` (FL-03's row): the API's wake route as the
 * Agent's owner (visibility, the target's `machines` audience, the stop
 * switch, 3 tries in 5 minutes, the audit row — all the route's own). Bound by
 * the API under {@link FLEET_WAKE_TOOL_PORT}.
 */
export interface FleetWakeToolPort {
    wake(userId: string, nodeId: string): Promise<FleetNodeWakeResult>;
}

export const FLEET_WAKE_TOOL_PORT = 'FLEET_WAKE_TOOL_PORT' as const;

/**
 * FL-19 P2 — `fleet_nodes_git_identity_get|set` (FL-15's rows): the agent-side
 * `FleetGitIdentityService`, called with the Agent as the caller (the owner's
 * own computers only for a set, class `confirm`).
 */
export interface FleetGitIdentityToolPort {
    read(
        nodeId: string,
        caller: { kind: 'agent'; agentId: string; ownerUserId: string },
        options?: { fresh?: boolean },
    ): Promise<FleetGitIdentity>;
    set(
        nodeId: string,
        caller: { kind: 'agent'; agentId: string; ownerUserId: string },
        request?: { confirm?: boolean },
    ): Promise<FleetGitIdentitySetResult>;
}
