import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_SCHEDULE_PROPOSAL_KIND } from './agent-fleet-schedule-tools';
import { FleetScheduleService } from './fleet-schedule.service';

/**
 * Schedules on computers (FL-13 P2, spec FR-32, CONTRACTS R-33) — applies a
 * held Agent schedule write once a PERSON approves it in My Decisions.
 *
 * `fleet_schedules_create|update|delete|run` hold every call as an Agent
 * Action Approval Queue proposal (`actionType: 'other'`, the platform-written
 * `payload.kind: 'fleet-schedule-write'`). This listener applies exactly that
 * write, as the same Agent (`requestedBy: agent:<id>` in every audit row),
 * through `FleetScheduleService` — the computer's `schedules` audience, the
 * limits and the kill switch included — with the confirmation the person just
 * gave (`confirm: true`).
 *
 * Only a person's approval acts: a guardrail decision and a rejection do
 * nothing; a payload naming another Agent is dropped with a warning. Never
 * the command line in a log line; a failure is logged, never thrown back into
 * the request that decided.
 */
@Injectable()
export class FleetScheduleProposalListener {
    private readonly logger = new Logger(FleetScheduleProposalListener.name);

    constructor(private readonly schedules: FleetScheduleService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_SCHEDULE_PROPOSAL_KIND) return;
        if (payload.agentId !== event.agentId) {
            this.logger.warn(`Approved schedule write ${event.proposalId} names another Agent; not applied`);
            return;
        }
        const actor = { userId: event.userId, agentId: event.agentId };
        const scheduleId = typeof payload.scheduleId === 'string' ? payload.scheduleId : '';
        try {
            switch (payload.op) {
                case 'create': {
                    const view = await this.schedules.create(actor, {
                        name: typeof payload.name === 'string' ? payload.name : '',
                        nodeId: typeof payload.nodeId === 'string' ? payload.nodeId : '',
                        command: typeof payload.command === 'string' ? payload.command : '',
                        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
                        cadence: payload.cadence,
                        confirm: true,
                    });
                    this.logger.log(`Approved schedule write ${event.proposalId} created schedule ${view.id}`);
                    return;
                }
                case 'update':
                    await this.schedules.update(scheduleId, actor, {
                        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
                        ...(typeof payload.nodeId === 'string' ? { nodeId: payload.nodeId } : {}),
                        ...(typeof payload.command === 'string' ? { command: payload.command } : {}),
                        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
                        ...(payload.cadence !== undefined ? { cadence: payload.cadence } : {}),
                        confirm: true,
                    });
                    break;
                case 'delete':
                    await this.schedules.remove(scheduleId, actor, true);
                    break;
                case 'run':
                    await this.schedules.runNow(scheduleId, actor, true);
                    break;
                default:
                    this.logger.warn(`Approved schedule write ${event.proposalId} names no known operation; not applied`);
                    return;
            }
            this.logger.log(`Approved schedule write ${event.proposalId} applied (${String(payload.op)})`);
        } catch (error) {
            this.logger.warn(
                `Approved schedule write ${event.proposalId} was not applied: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
