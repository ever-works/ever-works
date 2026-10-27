import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isFleetCommandLine } from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_COMMAND_PROPOSAL_KIND } from './agent-fleet-command-tools';
import { FleetCommandService } from './fleet-command.service';

/**
 * Commands on computers (FL-12 P2, spec S5, FR-20, CONTRACTS R-33) — runs a
 * held Agent command once a PERSON approves it in My Decisions.
 *
 * `fleet_commands_run` holds every call as an Agent Action Approval Queue
 * proposal (`actionType: 'other'`, the platform-written `payload.kind:
 * 'fleet-command-run'`, `humanDecisionRequired`). This listener runs exactly
 * that command — re-validated, as the same Agent, through the same chain a
 * person's run takes (`FleetCommandService.run`: each computer's `commands`
 * audience must include the Agent's owner, `--manage`, the kill switch, the
 * limits, one `node.command.run` row per computer with `requestedBy:
 * agent:<id>`) — with the confirmation the person just gave (`confirm: true`).
 *
 * Only a person's approval acts: a guardrail decision (no `decidedById`) and a
 * rejection do nothing; a payload that names another Agent, or a command that
 * no longer passes the contract's bounds, is dropped with a warning. Never the
 * command line in a log line. Best-effort like every listener of this event: a
 * failure is logged (the run's own refusal is on its card), never thrown back
 * into the request that decided.
 */
@Injectable()
export class FleetCommandProposalListener {
    private readonly logger = new Logger(FleetCommandProposalListener.name);

    constructor(private readonly commands: FleetCommandService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_COMMAND_PROPOSAL_KIND) return;
        if (payload.agentId !== event.agentId) {
            this.logger.warn(`Approved command ${event.proposalId} names another Agent; not run`);
            return;
        }
        const nodeIds = Array.isArray(payload.nodeIds)
            ? payload.nodeIds.filter((id): id is string => typeof id === 'string')
            : [];
        if (!isFleetCommandLine(payload.command) || nodeIds.length === 0) {
            this.logger.warn(
                `Approved command ${event.proposalId} is not a valid command; not run`,
            );
            return;
        }
        try {
            const view = await this.commands.run(
                { userId: event.userId, agentId: event.agentId },
                {
                    command: payload.command,
                    nodeIds,
                    ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
                    ...(typeof payload.timeoutSec === 'number'
                        ? { timeoutSec: payload.timeoutSec }
                        : {}),
                    confirm: true,
                },
            );
            this.logger.log(`Approved command ${event.proposalId} sent as command ${view.id}`);
        } catch (error) {
            this.logger.warn(
                `Approved command ${event.proposalId} did not run: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
