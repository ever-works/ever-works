import type {
    FleetConsents,
    FleetLinkActionFamily,
    FleetPortOpenResult,
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10) — how the ports services reach a machine.
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.request` on the shared `machine` channel, FL-02's viewer
 * minter for the preview picture) and this package must not import the API.
 * The API binds it (`FleetPortsLinkAdapter`); a context without it (the
 * worker, a test) answers `unreachable`, the honest answer without a link.
 *
 * Every request passes the link's own gate in its order — the link flag,
 * existence, the kill switch, the verb's consent against the consents the
 * live link presented, the action family's audience, "is it connected" —
 * before the machine is asked. A refusal, the link's or the node's, is
 * thrown as a `FleetPortsException` carrying the CONTRACTS §8 error.
 */

/** Who asks: a person, or an Agent acting for its owner (audited as `agent:<id>`). */
export type FleetPortsCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string; ownerUserId: string };

export interface FleetPortsNodeRequest {
    nodeId: string;
    /** `ports.list` or `ports.open`. */
    verb: string;
    params: Record<string, unknown>;
    caller: FleetPortsCaller;
    actionFamily: FleetLinkActionFamily;
    stateChanging: boolean;
    /** What the act is about (`:3000`), for the link's own channel audit. */
    target?: string;
    timeoutMs?: number;
}

export interface FleetPortsPreviewAttachRequest {
    nodeId: string;
    /** The view the node keeps the preview browser under (the viewer path target). */
    viewId: string;
    /** The person who opened the preview — the only one a driver token is minted for. */
    userId: string;
}

export interface FleetPortsNodePort {
    /** The platform holds the node's link right now (on any API replica). */
    isConnected(nodeId: string): boolean;
    /** What the live link presented, or null without a link. */
    liveConsents(nodeId: string): FleetConsents | null;
    /** One `machine` verb; resolves the reply's `result`. */
    request(input: FleetPortsNodeRequest): Promise<unknown>;
    /** A 60-second, single-use driver token for `/ws/fleet/desktop/<viewId>` (`profile: 'preview'`). */
    mintPreviewAttach(
        input: FleetPortsPreviewAttachRequest,
    ): Promise<NonNullable<FleetPortOpenResult['attach']>>;
}

export const FLEET_PORTS_NODE_PORT = 'FLEET_PORTS_NODE_PORT' as const;
