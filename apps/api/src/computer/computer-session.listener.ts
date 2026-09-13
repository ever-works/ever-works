import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { ComputerSessionEndedEvent, ComputerSessionService } from '@ever-works/agent/computer';
import { ComputerRelayRegistry } from './computer-relay.registry';

/**
 * Agent computers — the two events that end a live view from outside the
 * owner's own "End session".
 *
 *  - **The session ended** (any reason, any path): pin the `end` frame on the
 *    relay so every attached viewer, and every later one, learns the view is
 *    over and why — never a silently frozen picture.
 *  - **Its fleet job settled on its own** (the machine finished or dropped
 *    it, its lease lapsed, the queue gave up): end the session. The fleet
 *    already converges every terminal path on one completion event, so one
 *    subscription covers all of them without touching the lease protocol.
 *  - **Its fleet job was leased after the view was already over**: withdraw
 *    the lease and end the view (see `onJobLeased`).
 *
 * Best-effort by construction: a failure is logged, never thrown into the
 * event bus, and the session reaper is the floor behind both.
 */
@Injectable()
export class ComputerSessionListener {
    private readonly logger = new Logger(ComputerSessionListener.name);

    constructor(
        private readonly sessions: ComputerSessionService,
        private readonly relay: ComputerRelayRegistry,
    ) {}

    @OnEvent(ComputerSessionEndedEvent.EVENT_NAME)
    onSessionEnded(event: ComputerSessionEndedEvent): void {
        try {
            this.relay.end(event.sessionId, event.reason);
        } catch (error) {
            this.logger.warn(
                `computer session ${event.sessionId}: end frame not pinned: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * **Its fleet job was just leased.** The lease protocol claims a queued
     * job without knowing what a live view is, so a machine can claim the
     * job of a view that is already over — ended while the claim raced its
     * withdrawal, or past its claim timeout with nobody having looked yet.
     * Such a lease is withdrawn at once (the machine aborts on its next job
     * heartbeat) and the view is ended as `abandoned`, owner-independently.
     */
    @OnEvent(FleetJobLeasedEvent.EVENT_NAME, { async: true })
    async onJobLeased(event: FleetJobLeasedEvent): Promise<void> {
        if (event.job?.kind !== 'computer-session') return;
        const sessionId = event.job.payload?.sessionId;
        if (typeof sessionId !== 'string') return;
        try {
            await this.sessions.withdrawLeaseIfOver(sessionId, event.job.id);
        } catch (error) {
            this.logger.warn(
                `computer session ${sessionId}: leased job ${event.job.id} not checked: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onJobCompleted(event: FleetJobCompletedEvent): Promise<void> {
        if (event.job?.kind !== 'computer-session') return;
        const sessionId = event.job.payload?.sessionId;
        if (typeof sessionId !== 'string') return;
        try {
            await this.sessions.closeForSettledJob(sessionId, event.job.id);
        } catch (error) {
            this.logger.warn(
                `computer session ${sessionId}: settled job ${event.job.id} did not end it: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
