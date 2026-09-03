import {
    resolveFleetExecutionMode,
    type FleetExecutionMode,
    type FleetExecutionPreferenceView,
    type FleetNodeStatus,
    type FleetNodeView,
} from '@ever-works/contracts';

/**
 * Capabilities tab — the Execution section's policy, as pure functions.
 *
 * Split out of `AgentFleetSection` for the same reason the tool-switch
 * semantics live in `agent-capabilities.shared.ts`: which nodes are
 * offerable, what a chosen node's status means for the Agent, and which
 * routing mode is in force are all DECISIONS, and each one is cheap to
 * get subtly wrong in layout code (offering a cluster node that can never
 * lease work; calling a paused machine "offline"; reading the wrong
 * preference row). Keeping them here makes each one a one-line test.
 */

/**
 * What the page hands the section, composed server-side by the
 * Capabilities page from three independent fleet reads.
 *
 * `affinity` is a discriminated union rather than `nodeId | null` because
 * "unbound" and "could not be read" must render differently: the first
 * is a picker showing "Any node", the second must NOT be — a picker that
 * looks unbound because the read failed would invite the user to "fix"
 * a binding that may well exist.
 */
export interface AgentFleetData {
    /** `GET /api/fleet/nodes` — every node the owner has, cluster rows included. */
    nodes: FleetNodeView[];
    affinity: AgentFleetAffinityState;
    /**
     * `GET /api/fleet/execution-preferences`, or null when that read
     * failed. Null renders a "could not load" note, never the default
     * mode — the default is a real routing decision and must not be
     * shown as fact on the strength of a failed request.
     */
    preferences: FleetExecutionPreferenceView[] | null;
}

export type AgentFleetAffinityState =
    | { available: true; nodeId: string | null }
    /**
     * `personal-scope`: the affinity API refuses requests that carry no
     * active Organization (a binding is Organization-scoped on top of
     * the owner). `unavailable`: the read itself failed.
     */
    | { available: false; reason: 'personal-scope' | 'unavailable' };

/**
 * Whether the platform will lease work onto a node right now, from the
 * Agent's point of view.
 *
 * - `available` — online; work leased to it starts promptly.
 * - `draining`  — `paused` / `disabled`: an operator took it out of
 *                 service. It may still be heartbeating, so "offline"
 *                 would be the wrong word and the wrong remedy.
 * - `offline`   — no accepted heartbeat inside the window, or the
 *                 machine never finished enrolling.
 */
export type FleetNodeAvailability = 'available' | 'draining' | 'offline';

export function nodeAvailability(status: FleetNodeStatus): FleetNodeAvailability {
    switch (status) {
        case 'online':
            return 'available';
        case 'paused':
        case 'disabled':
            return 'draining';
        default:
            return 'offline';
    }
}

/**
 * The nodes an Agent may be pinned to.
 *
 * Cluster-sourced rows (`kind: 'k8s'`, never persisted) are surfaced in
 * the Fleet list for inventory, but the platform never leases work onto
 * them and the affinity API refuses their ids (they are not rows the
 * owner enrolled). Offering one would produce a binding that can only
 * ever wait.
 */
export function selectableFleetNodes(nodes: readonly FleetNodeView[]): FleetNodeView[] {
    return nodes.filter((node) => node.persisted && node.kind !== 'k8s');
}

/** What the picker should say about the CURRENT binding. */
export type PreferredNodeState =
    /** Unbound — any of the owner's nodes may take the Agent's work. */
    | { kind: 'any' }
    /**
     * Bound to a node id the list no longer carries (removed after the
     * binding was made). The binding still applies — its jobs wait for
     * a machine that will never come — so it must be shown, not hidden.
     */
    | { kind: 'missing'; nodeId: string }
    | { kind: 'node'; node: FleetNodeView; availability: FleetNodeAvailability };

export function preferredNodeState(
    nodeId: string | null,
    nodes: readonly FleetNodeView[],
): PreferredNodeState {
    if (!nodeId) return { kind: 'any' };
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node) return { kind: 'missing', nodeId };
    return { kind: 'node', node, availability: nodeAvailability(node.status) };
}

/**
 * The routing mode in force for this account, for read-only display.
 *
 * Resolved through the SAME `resolveFleetExecutionMode` the router uses,
 * with no Work / Goal scope: an Agent is not a routing scope, so what
 * the page can truthfully show is the account-wide answer plus how many
 * narrower overrides exist. `configured` distinguishes "the owner chose
 * this" from "nothing is set and this is the platform default" — the
 * two look identical as a mode and mean different things to the person
 * deciding whether to visit Settings.
 */
export interface AccountExecutionPreference {
    mode: FleetExecutionMode;
    configured: boolean;
    /** Work- and Goal-scoped rows, which beat the account row in their scope. */
    overrideCount: number;
}

export function describeAccountExecutionPreference(
    preferences: readonly FleetExecutionPreferenceView[],
): AccountExecutionPreference {
    return {
        mode: resolveFleetExecutionMode(preferences),
        configured: preferences.some((entry) => entry.scopeType === 'user'),
        overrideCount: preferences.filter((entry) => entry.scopeType !== 'user').length,
    };
}
