import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    isFleetProcessPid,
    isFleetProcessSignal,
    isFleetServiceAction,
    isFleetServiceManager,
    isFleetServiceName,
    isFleetServiceScope,
} from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_MACHINE_ACTION_PROPOSAL_KIND } from './agent-fleet-machine-tools';
import { FleetMachineActionsService } from './fleet-machine-actions.service';

/**
 * Machine actions (FL-09, spec FR-22, CONTRACTS R-33) — runs a held Agent
 * act once a PERSON approves it in My Decisions.
 *
 * The Agent tools hold every act the machine says could cut it off
 * (`blast-radius`) and every SIGKILL as an Agent Action Approval Queue
 * proposal (`actionType: 'other'`, the platform-written
 * `payload.kind: 'fleet-machine-action'`, `humanDecisionRequired`). This
 * listener re-runs exactly that act — re-validated, as the same Agent, through
 * the same chain (the link's gate with the node's family audience, the
 * machine, the audit row) — with the confirmation the person just gave:
 * `confirm: true`, and `acknowledgeBlastRadius: true` for a blast radius.
 *
 * Only a person's approval acts: a guardrail decision (no `decidedById`) and a
 * rejection do nothing; a payload that names another Agent, or args that no
 * longer pass the contracts patterns, are dropped with a warning. Best-effort
 * like every listener of this event: a failure is logged (and audited by the
 * act itself), never thrown back into the request that decided.
 */
@Injectable()
export class FleetMachineProposalListener {
    private readonly logger = new Logger(FleetMachineProposalListener.name);

    constructor(private readonly machine: FleetMachineActionsService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_MACHINE_ACTION_PROPOSAL_KIND) return;
        if (payload.agentId !== event.agentId || typeof payload.nodeId !== 'string' || !payload.nodeId) {
            this.logger.warn(`Approved machine act ${event.proposalId} names another Agent or no computer; not run`);
            return;
        }
        const args = (payload.args ?? {}) as Record<string, unknown>;
        const caller = { kind: 'agent' as const, agentId: event.agentId, ownerUserId: event.userId };
        try {
            if (payload.verb === 'services.action') {
                if (!isFleetServiceName(args.name) || !isFleetServiceAction(args.action)) {
                    this.logger.warn(`Approved machine act ${event.proposalId} has an invalid service; not run`);
                    return;
                }
                await this.machine.serviceAction(payload.nodeId, caller, {
                    name: args.name,
                    action: args.action,
                    ...(isFleetServiceScope(args.scope) ? { scope: args.scope } : {}),
                    ...(isFleetServiceManager(args.manager) ? { manager: args.manager } : {}),
                    fields: { confirm: true, acknowledgeBlastRadius: true },
                });
                return;
            }
            if (payload.verb === 'processes.signal') {
                if (!isFleetProcessPid(args.pid) || !isFleetProcessSignal(args.signal)) {
                    this.logger.warn(`Approved machine act ${event.proposalId} has an invalid process; not run`);
                    return;
                }
                await this.machine.signalProcess(payload.nodeId, caller, {
                    pid: args.pid,
                    signal: args.signal,
                    fields: { confirm: true },
                });
            }
        } catch (error) {
            this.logger.warn(
                `Approved machine act ${event.proposalId} (${String(payload.verb)}) did not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
