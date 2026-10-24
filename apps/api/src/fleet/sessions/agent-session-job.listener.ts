import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { FleetSessionService } from '@ever-works/agent/fleet';
import type { FleetAgentSessionResult } from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04 P2) — an Agent session's job lifecycle into its
 * session row and Run (CONTRACTS R-1: ending either ends both).
 *
 *  - **Leased** — a machine claimed the job: the Run is running. A lease of a
 *    session that is already over (ended while the claim raced its
 *    withdrawal) is withdrawn at once.
 *  - **Completed** (done, failed, cancelled, expired) — the session ends if it
 *    has not, with the exit evidence the node reported, and the Run settles.
 *
 * Both are idempotent and never throw (the session service logs).
 */
@Injectable()
export class AgentSessionJobListener {
    private readonly logger = new Logger(AgentSessionJobListener.name);

    constructor(private readonly sessions: FleetSessionService) {}

    @OnEvent(FleetJobLeasedEvent.EVENT_NAME, { async: true })
    async onJobLeased(event: FleetJobLeasedEvent): Promise<void> {
        if (event.job?.kind !== 'agent-session') return;
        const sessionId = event.job.payload?.fleetSessionId;
        if (typeof sessionId !== 'string') return;
        await this.sessions.agentSessionLeased(sessionId);
    }

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onJobCompleted(event: FleetJobCompletedEvent): Promise<void> {
        if (event.job?.kind !== 'agent-session') return;
        const sessionId = event.job.payload?.fleetSessionId;
        if (typeof sessionId !== 'string') return;
        try {
            await this.sessions.agentSessionJobSettled(sessionId, {
                succeeded: event.succeeded,
                result: (event.result ?? null) as Partial<FleetAgentSessionResult> | null,
                error: event.error,
            });
        } catch (error) {
            this.logger.warn(
                `Agent session ${sessionId}: settled job ${event.job.id} not applied: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
