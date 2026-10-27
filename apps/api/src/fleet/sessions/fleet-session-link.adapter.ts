import { Injectable, Logger } from '@nestjs/common';
import {
    FleetSessionException,
    type FleetSessionNodePort,
    type FleetSessionNodeRequest,
} from '@ever-works/agent/fleet';
import {
    fleetSessionConsentFor,
    makeFleetLinkError,
    type FleetConsents,
    type FleetSessionAckMessage,
} from '@ever-works/contracts';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';

/** How long one session request waits for the machine (a start spawns a process). */
export const FLEET_SESSION_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Sessions on computers (FL-04) — `FLEET_SESSION_NODE_PORT` over the node
 * link (FL-02). The agent package's `FleetSessionService` decides; this only
 * carries one request to the machine and its answer back.
 *
 * Every request opens a short-lived channel of the `session` family with
 * `{ sessionId, mode, kind }` (CONTRACTS §3.3, lane-log decision 2), through
 * `FleetLinkService.openChannel` — so the link's own gate runs first, in its
 * order: the link flag, existence, the kill switch for a state-changing act,
 * the consent the kind needs (`manage` for an owner session, `work` for an
 * Agent's, R-5) against the consents the live link presented, the `sessions`
 * family audience, then "is it connected" (on any API replica). The channel
 * open is audited by the link (`node.link.channel-open`) when the act changes
 * the machine; the session's own audit row is the session service's.
 *
 * The node's refusal comes back as the same CONTRACTS §8 error, thrown as a
 * `FleetSessionException` so the service and the controller read one shape.
 * The channel is always closed, answered or not.
 */
@Injectable()
export class FleetSessionLinkAdapter implements FleetSessionNodePort {
    private readonly logger = new Logger(FleetSessionLinkAdapter.name);

    constructor(
        private readonly link: FleetLinkService,
        private readonly registry: FleetLinkRegistry,
    ) {}

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    liveConsents(nodeId: string): FleetConsents | null {
        return this.link.liveConsents(nodeId);
    }

    async request(input: FleetSessionNodeRequest): Promise<unknown> {
        let channel: FleetLinkChannel | null = null;
        try {
            channel = await this.link.openChannel({
                nodeId: input.nodeId,
                family: 'session',
                params: { sessionId: input.sessionId, mode: input.mode, kind: input.kind },
                caller: input.caller,
                requirement: {
                    consent: fleetSessionConsentFor(input.kind),
                    actionFamily: 'sessions',
                    stateChanging: input.stateChanging,
                    target: input.sessionId,
                },
            });
            const reply = await channel.request(input.verb, input.params, {
                timeoutMs: input.timeoutMs ?? FLEET_SESSION_REQUEST_TIMEOUT_MS,
            });
            if ('error' in reply) throw new FleetSessionException(reply.error);
            if ('result' in reply) return reply.result;
            // A session verb never answers with a long-running operation id;
            // a node that does is a node this platform does not understand.
            throw new FleetSessionException(
                makeFleetLinkError(
                    'operation_failed',
                    'the computer answered a session request in a way this platform does not understand',
                ),
            );
        } finally {
            if (channel && !channel.isClosed) {
                try {
                    channel.close('normal');
                } catch (error) {
                    this.logger.debug(
                        `closing a session channel on node ${input.nodeId} failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
    }

    /**
     * `session.ack` on channel 0. Node reports (and so the acks they cause) are
     * handled on the replica that holds the node's link, so the local registry
     * is the right — and only — sender; a link that moved meanwhile just
     * re-reports, and the platform acks again.
     */
    ack(nodeId: string, sessionIds: readonly string[]): void {
        if (sessionIds.length === 0) return;
        const message: FleetSessionAckMessage = {
            type: 'session.ack',
            sessionIds: [...sessionIds],
        };
        if (!this.registry.sendNodeControl(nodeId, { ...message })) {
            this.logger.debug(`session.ack for node ${nodeId} not sent: no link on this replica`);
        }
    }
}
