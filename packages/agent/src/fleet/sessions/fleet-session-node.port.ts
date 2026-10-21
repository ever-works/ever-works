import type {
    FleetConsents,
    FleetSessionAttachRole,
    FleetSessionKind,
    FleetSessionLinkVerb,
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — how the session service reaches a machine.
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.openChannel` on the `session` family) and this package
 * must not import the API. The API binds it (`FleetSessionLinkAdapter`);
 * a context without it (the worker, a test) answers `unreachable` for every
 * machine, which is the honest answer when there is no link.
 *
 * Every request is a JSON `{ requestId, type: verb, params }` on a short-lived
 * `session` channel opened as `{ sessionId, mode, kind }`; the reply's
 * `result` resolves, its `error` rejects with an `HttpException` whose body is
 * the CONTRACTS §8 envelope (read it with `readFleetSessionError`).
 */

/** Who the request is for: a person, or the platform itself (reconciliation, drain). */
export type FleetSessionPortCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'system'; job: string };

export interface FleetSessionNodeRequest {
    nodeId: string;
    sessionId: string;
    kind: FleetSessionKind;
    mode: FleetSessionAttachRole;
    verb: FleetSessionLinkVerb;
    params: Record<string, unknown>;
    caller: FleetSessionPortCaller;
    /** Refused under the kill switch and audited as a channel open when true. */
    stateChanging: boolean;
    timeoutMs?: number;
}

export interface FleetSessionNodePort {
    /** The platform holds the node's link right now. */
    isConnected(nodeId: string): boolean;
    /** What the live link presented, or null without a link. */
    liveConsents(nodeId: string): FleetConsents | null;
    /** One request on a fresh `session` channel; resolves the reply's `result`. */
    request(input: FleetSessionNodeRequest): Promise<unknown>;
    /** Tell the node the platform holds these ended sessions' screens (`session.ack`). */
    ack(nodeId: string, sessionIds: readonly string[]): void;
}

export const FLEET_SESSION_NODE_PORT = 'FLEET_SESSION_NODE_PORT' as const;
