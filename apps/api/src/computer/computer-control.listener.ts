import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import {
    ComputerControlArbiter,
    ComputerControlChangedEvent,
    ComputerSessionEndedEvent,
} from '@ever-works/agent/computer';
import { ComputerRelayRegistry } from './computer-relay.registry';

/**
 * Agent computers, take-over — keeps the live relay in step with the control
 * arbiter, whichever path moved the lock.
 *
 *  - **Control changed** (taken, handed over, kept, extended, given back, or
 *    released automatically): the relay learns the view's hold, so input is
 *    gated on it, and — when held flips — the view's sockets and the
 *    machine's own leg get a `mode` frame (the machine pauses or resumes the
 *    Agent's own input on it).
 *  - **A stretch of control ended** (any reason): one Activity Log row on the
 *    Agent's feed saying who held the machine, for how long and why it ended
 *    — the owner-legible trail beside the fleet audit ledger's rows.
 *  - **The view ended**: whatever control it held is released as
 *    `session-ended`, and a request it had pending is withdrawn — an ended
 *    view can never keep a machine locked away from its owner.
 *
 * Best-effort by construction: a failure is logged, never thrown into the
 * event bus; the arbiter also settles an ended view's hold on the next read.
 */
@Injectable()
export class ComputerControlListener {
    private readonly logger = new Logger(ComputerControlListener.name);

    constructor(
        private readonly control: ComputerControlArbiter,
        private readonly relay: ComputerRelayRegistry,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    @OnEvent(ComputerControlChangedEvent.EVENT_NAME)
    onControlChanged(event: ComputerControlChangedEvent): void {
        const { sessionId, held, untilMs } = event.change;
        try {
            this.relay.applyControl(sessionId, { held, untilMs });
        } catch (error) {
            this.logger.warn(
                `computer session ${sessionId}: control change not applied to the relay: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (!held && event.change.reason) void this.logControlled(event);
    }

    private async logControlled(event: ComputerControlChangedEvent): Promise<void> {
        const change = event.change;
        if (!this.activityLog || !change.agentId) return;
        const minutes = Math.max(1, Math.round((change.heldMs ?? 0) / 60_000));
        try {
            await this.activityLog.log({
                userId: change.ownerUserId,
                actionType: ActivityActionType.AGENT_COMPUTER_CONTROLLED,
                action: 'agent.computer.controlled',
                status: ActivityStatus.COMPLETED,
                summary: `Took control of the agent's computer for about ${minutes} min (${change.reason})`,
                details: {
                    resourceType: 'agent',
                    resourceId: change.agentId,
                    nodeId: change.nodeId,
                    sessionId: change.sessionId,
                    releaseReason: change.reason,
                    heldMs: change.heldMs ?? 0,
                },
            });
        } catch (error) {
            this.logger.warn(
                `computer session ${change.sessionId}: control activity not logged: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    @OnEvent(ComputerSessionEndedEvent.EVENT_NAME, { async: true })
    async onSessionEnded(event: ComputerSessionEndedEvent): Promise<void> {
        try {
            await this.control.releaseForSession(event.sessionId, 'session-ended');
        } catch (error) {
            this.logger.warn(
                `computer session ${event.sessionId}: control not released on end: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
