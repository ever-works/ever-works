import type {
    FleetActionFamily,
    FleetCheckoutLinkVerb,
    FleetConsents,
    FleetLinkConsentRequirement,
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14) — how the checkout service reaches a machine.
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.request` on the shared `machine` channel) and this package
 * must not import the API. The API binds it (`FleetCheckoutLinkAdapter`); a
 * context without it (the worker, a test) answers `unreachable` for every
 * machine, which is the honest answer when there is no link.
 *
 * The link's own gate runs on every request, in its order (flag, existence,
 * kill switch for a state-changing act, the consent against what the live
 * link presented, the `checkouts` family audience, "is it connected"); a
 * refusal rejects with an `HttpException` whose body is the CONTRACTS §8
 * envelope (read it with `readFleetSessionError`).
 */

/** Who the request is for: a person, or the platform itself (the reconcile sweep). */
export type FleetCheckoutPortCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string; ownerUserId: string }
    | { kind: 'system'; job: string };

export interface FleetCheckoutNodeRequest {
    nodeId: string;
    verb: FleetCheckoutLinkVerb;
    params: Record<string, unknown>;
    caller: FleetCheckoutPortCaller;
    /** Narrow the verb's consent (a person's rescan needs `manage`, CONTRACTS §3.3 override). */
    consent?: FleetLinkConsentRequirement;
    /** The action family the audience is checked in (default: the verb's, `checkouts`; a plain list reads under `view`). */
    actionFamily?: FleetActionFamily;
    /** Refused under the kill switch when true. */
    stateChanging: boolean;
    /** The checkout path (audit target). */
    target?: string | null;
    timeoutMs?: number;
}

/** The node answered inline (`result`), or the work continues as a link operation. */
export type FleetCheckoutNodeOutcome = { result: unknown } | { operationId: string };

export interface FleetCheckoutNodePort {
    /** The platform holds the node's link right now (this replica or another). */
    isConnected(nodeId: string): boolean;
    /** What the live link presented, or null without a link. */
    liveConsents(nodeId: string): FleetConsents | null;
    /** One `machine` request. */
    request(input: FleetCheckoutNodeRequest): Promise<FleetCheckoutNodeOutcome>;
}

export const FLEET_CHECKOUT_NODE_PORT = 'FLEET_CHECKOUT_NODE_PORT' as const;
