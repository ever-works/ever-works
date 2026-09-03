import {
    resolveFleetExecutionMode,
    type FleetAgentNodeAffinityView,
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
 * The three fleet reads the Capabilities page issues, each settled on its
 * own. `affinity` is the read's RESULT rather than the API value because
 * "asked and failed" and "asked and unbound" must land in different
 * states — and a personal workspace never asks at all (the API answers
 * 400), which is what `organizationScoped` tells the composer.
 */
export interface AgentFleetReads {
    nodes: PromiseSettledResult<FleetNodeView[]>;
    /** `serverFetch` collapses an empty body to `undefined`; unbound is `null` on the wire. */
    affinity: PromiseSettledResult<FleetAgentNodeAffinityView | null | undefined>;
    preferences: PromiseSettledResult<FleetExecutionPreferenceView[]>;
}

/**
 * Turn the settled reads into what the section renders, or null when
 * there is nothing true to show.
 *
 * The node list is the one read the section cannot render without —
 * both the picker and the "no nodes yet" pointer are statements about
 * it — so its failure hides the whole section rather than rendering a
 * pointer that claims the fleet is empty. The other two degrade only
 * their own column: a failed routing read must not hide the picker, and
 * a failed affinity read must not become an "unbound" picker (see
 * `AgentFleetAffinityState`).
 */
export function composeAgentFleet(
    reads: AgentFleetReads,
    organizationScoped: boolean,
): AgentFleetData | null {
    if (reads.nodes.status !== 'fulfilled') return null;

    const affinity: AgentFleetAffinityState = !organizationScoped
        ? { available: false, reason: 'personal-scope' }
        : reads.affinity.status === 'fulfilled'
          ? { available: true, nodeId: reads.affinity.value?.nodeId ?? null }
          : { available: false, reason: 'unavailable' };

    return {
        nodes: reads.nodes.value,
        affinity,
        preferences: reads.preferences.status === 'fulfilled' ? reads.preferences.value : null,
    };
}

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
