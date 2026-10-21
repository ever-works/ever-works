import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import {
    FLEET_LINK_COMPUTER_LEG_FRAME,
    FLEET_LINK_COMPUTER_LEG_REQUEST,
    FLEET_LINK_COMPUTER_LEG_SOURCE,
    type FleetLinkExtensionMessage,
} from '@ever-works/contracts';
import { ComputerSessionService } from '@ever-works/agent/computer';
import { config } from '@ever-works/agent/config';
import type { FleetLinkChannel } from '../fleet-link/fleet-link-channel';
import { FleetLinkRegistry } from '../fleet-link/fleet-link.registry';
import { FleetLinkService } from '../fleet-link/fleet-link.service';
import { ComputerRelayRegistry } from './computer-relay.registry';

/** The system job a leg channel is opened as (audit and logs read `system:computer-session-leg`). */
export const COMPUTER_LINK_LEG_JOB = 'computer-session-leg';

/** Most leg channels one replica keeps at once (one per live view; bounded against a misbehaving node). */
export const COMPUTER_LINK_LEG_MAX = 2_000;

interface LinkLegEntry {
    nodeId: string;
    clientId: string;
    channel: FleetLinkChannel;
}

/**
 * Fleet node link (FL-02, T-22, spec FR-34) — a live view's machine leg over
 * the node link, on the platform side.
 *
 * A `computer-session` view on a node asks for its inbound leg on channel 0
 * (`computer.leg { sessionId }`, CONTRACTS-side constant
 * `FLEET_LINK_COMPUTER_LEG_REQUEST`); the replica holding the node's link
 * receives it (`FleetLinkRegistry.onNodeControl`). This bridge then:
 *
 *  1. checks the view is pinned to THAT node and still live (the same
 *     `findForNode` + expiry + stop-switch checks the worker-token route
 *     makes) — a node can never attach to another machine's view;
 *  2. opens a `desktop` channel with `{ source: 'browser', sessionId }`
 *     through `FleetLinkService.openChannel` as a system caller, so the
 *     authoriser runs exactly as for every other channel (kill switch, the
 *     node's `attend` consent);
 *  3. attaches the channel to the live-view relay as the view's `worker`
 *     client — the role the legacy socket leg has — so the relay's own rules
 *     decide what reaches the machine (quality, refresh, mode, input from the
 *     view holding control), each frame sent as `{ type: 'desktop.frame',
 *     data }` in the computer frame encoding;
 *  4. detaches it when the channel closes (the node falls back to its own
 *     socket leg, which re-attaches through the existing gateway).
 *
 * Anything it cannot do is silent: the node waits a few seconds and opens
 * its legacy leg, which is unchanged. Nothing here writes a row.
 */
@Injectable()
export class ComputerLinkLegBridge implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ComputerLinkLegBridge.name);
    private readonly legs = new Map<string, LinkLegEntry>();
    private readonly opening = new Set<string>();
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly sessions: ComputerSessionService,
        private readonly relay: ComputerRelayRegistry,
        @Optional() private readonly linkRegistry?: FleetLinkRegistry,
        @Optional() private readonly link?: FleetLinkService,
    ) {}

    onModuleInit(): void {
        if (!this.linkRegistry || !this.link) return;
        this.unsubscribe = this.linkRegistry.onNodeControl(
            FLEET_LINK_COMPUTER_LEG_REQUEST,
            (nodeId, message) => void this.onLegRequest(nodeId, message),
        );
    }

    onModuleDestroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const [sessionId, entry] of [...this.legs]) {
            this.legs.delete(sessionId);
            this.relay.detach(sessionId, entry.clientId);
            try {
                entry.channel.close('normal', 'server shutting down');
            } catch {
                // already gone
            }
        }
    }

    /** How many views ride the link on this replica (health, tests). */
    get size(): number {
        return this.legs.size;
    }

    /** Handle one `computer.leg` request from a node. Never throws. */
    async onLegRequest(nodeId: string, message: FleetLinkExtensionMessage): Promise<boolean> {
        const sessionId =
            typeof message.sessionId === 'string' && isUUID(message.sessionId)
                ? message.sessionId
                : null;
        if (!sessionId || !this.link) return false;
        if (!config.fleet.isEnabled() || !config.fleet.isNodeLinkEnabled()) return false;
        const existing = this.legs.get(sessionId);
        if (existing && !existing.channel.isClosed && existing.nodeId === nodeId) return true;
        if (this.opening.has(sessionId) || this.legs.size >= COMPUTER_LINK_LEG_MAX) return false;
        this.opening.add(sessionId);
        try {
            if (!(await this.viewIsLiveOn(sessionId, nodeId))) return false;
            let channel: FleetLinkChannel;
            try {
                channel = await this.link.openChannel({
                    nodeId,
                    family: 'desktop',
                    params: { source: FLEET_LINK_COMPUTER_LEG_SOURCE, sessionId },
                    caller: { kind: 'system', job: COMPUTER_LINK_LEG_JOB },
                    requirement: { target: sessionId },
                });
            } catch (error) {
                this.logger.debug(
                    `live view ${sessionId}: no leg over the link of node ${nodeId} (${describe(error)}); it keeps its own socket`,
                );
                return false;
            }
            return this.attachLeg(sessionId, nodeId, channel);
        } finally {
            this.opening.delete(sessionId);
        }
    }

    private async viewIsLiveOn(sessionId: string, nodeId: string): Promise<boolean> {
        try {
            const row = await this.sessions.findForNode(sessionId, nodeId);
            if (!row || row.status === 'ended') return false;
            const current = await this.sessions.expireIfDue(row);
            if (current.status === 'ended') return false;
            return !(await this.sessions.endIfStopped(current));
        } catch (error) {
            this.logger.debug(`live view ${sessionId}: could not be checked (${describe(error)})`);
            return false;
        }
    }

    private attachLeg(sessionId: string, nodeId: string, channel: FleetLinkChannel): boolean {
        const previous = this.legs.get(sessionId);
        if (previous) {
            this.legs.delete(sessionId);
            this.relay.detach(sessionId, previous.clientId);
            try {
                previous.channel.close('normal', 'replaced');
            } catch {
                // already gone
            }
        }
        const clientId = `link-leg:${channel.channel}:${randomUUID()}`;
        const entry: LinkLegEntry = { nodeId, clientId, channel };
        this.legs.set(sessionId, entry);
        const release = (): void => {
            if (this.legs.get(sessionId) !== entry) return;
            this.legs.delete(sessionId);
            this.relay.detach(sessionId, clientId);
        };
        channel.listen({ close: release });
        if (channel.isClosed) {
            release();
            return false;
        }
        this.relay.attach(sessionId, {
            id: clientId,
            role: 'worker',
            send: (wire) => {
                // A throw drops this client from the relay session (the relay's rule).
                if (!channel.sendJson({ type: FLEET_LINK_COMPUTER_LEG_FRAME, data: wire })) {
                    throw new Error('link channel not writable');
                }
            },
        });
        this.logger.log(`live view ${sessionId}: machine leg rides the link of node ${nodeId}`);
        return true;
    }
}

function describe(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
        return String((error as { code: unknown }).code);
    }
    return error instanceof Error ? error.message : String(error);
}
