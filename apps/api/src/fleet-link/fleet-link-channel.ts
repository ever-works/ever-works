import type {
    FleetLinkCloseReason,
    FleetLinkFamily,
    FleetLinkFrameKind,
    FleetLinkReply,
} from '@ever-works/contracts';

/** What a caller listens to on a channel. */
export interface FleetLinkChannelEvents {
    json?(message: Record<string, unknown>): void;
    binary?(kind: FleetLinkFrameKind, payload: Uint8Array): void;
    close?(reason: FleetLinkCloseReason, hint?: string): void;
    resume?(linkGeneration: number): void;
}

/**
 * One open channel on a node's link, wherever the link is (FL-02).
 *
 * `FleetLinkService.openChannel` answers one of these whether the node's link
 * is held by this API replica (`FleetLinkChannelHandle`, straight onto the
 * socket) or by another one (`RemoteFleetLinkChannel`, through the relay
 * bus). A caller — the viewer bridge, an epic's controller — never needs to
 * know which.
 */
export interface FleetLinkChannel {
    readonly nodeId: string;
    readonly channel: number;
    readonly family: FleetLinkFamily;
    readonly isOpen: boolean;
    readonly isClosed: boolean;
    readonly linkGeneration: number | null;
    /** Send a request on this channel; resolves the node's reply (result, error or operation id). */
    request(
        verb: string,
        params?: Record<string, unknown>,
        options?: { timeoutMs?: number },
    ): Promise<FleetLinkReply>;
    sendJson(message: Record<string, unknown>): boolean;
    sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean;
    close(reason?: FleetLinkCloseReason, hint?: string): void;
    /** Listen; returns the unsubscribe. */
    listen(events: FleetLinkChannelEvents): () => void;
}
