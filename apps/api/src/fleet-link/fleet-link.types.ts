import type { FleetNode } from '@ever-works/agent/fleet';
import type {
    FleetConsents,
    FleetLinkActionFamily,
    FleetLinkConsentRequirement,
    FleetLinkFamily,
    FleetNodeLinkView,
} from '@ever-works/contracts';

/**
 * Fleet node link — the platform side's own vocabulary (not wire shapes;
 * those live in `@ever-works/contracts`).
 */

/** Who asked for a channel or a request (CONTRACTS §2.3 `requestedBy`). */
export type FleetLinkCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string; ownerUserId: string }
    | { kind: 'schedule'; commandId: string; ownerUserId: string }
    | { kind: 'system'; job: string };

/** `user:<id>` · `agent:<id>` · `schedule:<commandId>` · `system:<job>`. */
export function describeFleetLinkCaller(caller: FleetLinkCaller): string {
    switch (caller.kind) {
        case 'user':
            return `user:${caller.userId}`;
        case 'agent':
            return `agent:${caller.agentId}`;
        case 'schedule':
            return `schedule:${caller.commandId}`;
        case 'system':
            return `system:${caller.job}`;
    }
}

/** The person an audit row and an operation belong to, or null for the system. */
export function fleetLinkCallerUserId(caller: FleetLinkCaller): string | null {
    switch (caller.kind) {
        case 'user':
            return caller.userId;
        case 'agent':
        case 'schedule':
            return caller.ownerUserId;
        case 'system':
            return null;
    }
}

/**
 * What a channel or a request needs, resolved from the family table and the
 * caller's narrowing. Every field defaults from CONTRACTS; an epic names a
 * field only to narrow it for its own verb (a session channel's `work` vs
 * `manage`, `health.now`'s `view`).
 */
export interface FleetLinkRequirement {
    consent: FleetLinkConsentRequirement;
    actionFamily: FleetLinkActionFamily;
    /** Audited on open and refused under the kill switch. */
    stateChanging: boolean;
    /** What the act is about — a session id, a service name, a path (CONTRACTS §2.3 `target`). */
    target?: string | null;
}

/** The node facts the authoriser and the audience read. */
export interface FleetLinkNodeFacts {
    id: string;
    userId: string;
    organizationId: string | null;
    name: string;
    kind: string;
    lastHeartbeatAt: Date | string | null;
    /** The consents the node last reported (stored), or null. */
    storedConsents: unknown;
    capabilities: string[] | null;
    workerState: string | null;
    /** The legacy single policy value — the `desktop` family's mirror (FL-01). */
    controlPolicy?: FleetNode['controlPolicy'];
    /** The stored per-family control policy (FL-01, CONTRACTS §2.1). */
    controlPolicyFamilies?: FleetNode['controlPolicyFamilies'];
}

/** The audience answer (CONTRACTS §2.1). */
export type FleetLinkAudienceDecision =
    | { allowed: true }
    | {
          allowed: false;
          /** The hint a refused caller reads; a default names the owner. */
          hint?: string;
          /** Answer `not_found` instead of `permission_denied` (the caller may not even see the node). */
          asNotFound?: boolean;
      };

export interface FleetLinkAudienceQuery {
    node: FleetLinkNodeFacts;
    caller: FleetLinkCaller;
    actionFamily: FleetLinkActionFamily;
}

/**
 * The family-audience lookup (CONTRACTS §2.1) as a port, bound under
 * {@link FLEET_LINK_AUDIENCE} to the Fleet hub's role derivation (FL-01
 * `FleetAccessService`, through `RoleBasedFleetLinkAudience`). A context
 * without that service answers owner-only — the node's owner (and the owner's
 * own schedules and system jobs) and nobody else — which is fail-closed.
 */
export interface FleetLinkAudience {
    check(
        query: FleetLinkAudienceQuery,
    ): Promise<FleetLinkAudienceDecision> | FleetLinkAudienceDecision;
}

/** Bound by the link module to the Fleet hub's role derivation (owner-only without it). */
export const FLEET_LINK_AUDIENCE = 'FLEET_LINK_AUDIENCE' as const;

/**
 * Called by the fleet heartbeat with the consents a beat reported, so the
 * link closes the channels of a consent the node no longer holds (spec
 * FR-22). Bound by the link module; consumed `@Optional()`.
 */
export interface FleetLinkHeartbeatObserver {
    onHeartbeat(nodeId: string, consents: FleetConsents): void;
}

export const FLEET_LINK_HEARTBEAT_OBSERVER = 'FLEET_LINK_HEARTBEAT_OBSERVER' as const;

/** The link as the platform's own socket sees it, for a node view (spec FR-42). */
export interface FleetLinkNodeStateLookup {
    linkView(node: { id: string; kind: string }): FleetNodeLinkView;
}

export const FLEET_LINK_NODE_STATE = 'FLEET_LINK_NODE_STATE' as const;

/**
 * A node whose registration is gone or whose credential was replaced loses
 * its live link at once (close `4001`). The fleet controller calls it after
 * delete, unenrol and an owner re-key; the gateway's periodic re-read of the
 * connected nodes' rows catches every other path. Bound by the link module;
 * consumed `@Optional()`.
 */
export interface FleetLinkNodeLifecycle {
    nodeGone(
        nodeId: string,
        reason: 'node removed' | 'node unenrolled' | 'credential replaced',
    ): void;
}

export const FLEET_LINK_NODE_LIFECYCLE = 'FLEET_LINK_NODE_LIFECYCLE' as const;

/** Drain-all (CONTRACTS R-24): warn every owner session on these nodes, then end them. */
export interface FleetLinkDrainNotifier {
    drainNodes(nodeIds: readonly string[], graceSec: number): void;
}

export const FLEET_LINK_DRAIN_NOTIFIER = 'FLEET_LINK_DRAIN_NOTIFIER' as const;

/** A channel family and the defaults it opens with. */
export interface FleetLinkChannelSpec {
    family: FleetLinkFamily;
    params?: Record<string, unknown>;
}
