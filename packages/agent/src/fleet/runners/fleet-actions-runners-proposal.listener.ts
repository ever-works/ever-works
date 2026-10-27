import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    clampFleetActionsRunnerCount,
    isFleetActionsRunnerName,
    isFleetActionsRunnerScope,
    isFleetActionsRunnerTarget,
} from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_RUNNERS_ACTION_PROPOSAL_KIND } from './agent-fleet-runners-tools';
import { FleetActionsRunnersService } from './fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18, spec S8, CONTRACTS R-33) — runs a held
 * Agent act (`fleet_runners_install`, a stop, a restart, a remove) once a
 * PERSON approved it in My Decisions. The act runs as the Agent
 * (`requestedBy: agent:<id>`, so the computer's `machines` audience must still
 * include the Agent's owner) with the confirmation the approval stands for;
 * every gate runs again — a computer that went offline or a runner that
 * started a job meanwhile is refused, not forced. Only platform-written
 * payload fields are read, each re-validated.
 */
@Injectable()
export class FleetActionsRunnersProposalListener {
    private readonly logger = new Logger(FleetActionsRunnersProposalListener.name);

    constructor(private readonly runners: FleetActionsRunnersService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_RUNNERS_ACTION_PROPOSAL_KIND) return;
        if (payload.agentId !== event.agentId || typeof payload.nodeId !== 'string' || (!payload.nodeId && payload.verb !== 'cancel-run')) {
            this.logger.warn(`Approved runner act ${event.proposalId} names another Agent or no computer; not run`);
            return;
        }
        const args = (payload.args ?? {}) as Record<string, unknown>;
        const caller = { kind: 'agent' as const, agentId: event.agentId, ownerUserId: event.userId };
        try {
            if (payload.verb === 'cancel-run') {
                // P2 (FR-23): a whole workflow run of a repository the owner's installation covers.
                await this.runners.cancelRun(caller, {
                    repository: args.repository,
                    runId: args.runId,
                    runNumber: args.runNumber,
                    fields: { confirm: true },
                });
                return;
            }
            if (payload.verb === 'install') {
                const target = (args.target ?? {}) as { scope?: unknown; target?: unknown };
                if (!isFleetActionsRunnerScope(target.scope) || !isFleetActionsRunnerTarget(target.scope, target.target)) {
                    this.logger.warn(`Approved runner install ${event.proposalId} is invalid; not run`);
                    return;
                }
                const names = Array.isArray(args.names) ? args.names.filter((name) => isFleetActionsRunnerName(name)) : [];
                const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
                await this.runners.install(caller, payload.nodeId, {
                    target: { scope: target.scope, target: target.target as string },
                    count: clampFleetActionsRunnerCount(args.count),
                    ...(names.length > 0 ? { names: names as string[] } : {}),
                    ...(labels.length > 0 ? { labels } : {}),
                    mode: 'service',
                    fields: { confirm: true },
                });
                return;
            }
            if (typeof payload.runnerId !== 'string' || !payload.runnerId) {
                this.logger.warn(`Approved runner act ${event.proposalId} names no runner; not run`);
                return;
            }
            if (payload.verb === 'stop' || payload.verb === 'restart') {
                await this.runners.control(caller, payload.nodeId, payload.runnerId, payload.verb, { confirm: true });
                return;
            }
            if (payload.verb === 'remove') {
                if (!isFleetActionsRunnerName(args.name)) {
                    this.logger.warn(`Approved runner remove ${event.proposalId} has no name; not run`);
                    return;
                }
                await this.runners.control(caller, payload.nodeId, payload.runnerId, 'remove', { confirmName: args.name });
            }
        } catch (error) {
            this.logger.warn(
                `Approved runner act ${event.proposalId} (${String(payload.verb)}) did not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
