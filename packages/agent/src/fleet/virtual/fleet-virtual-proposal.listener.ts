import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    isFleetVirtualCpus,
    isFleetVirtualDiskGiB,
    isFleetVirtualMemoryGiB,
    isFleetVirtualName,
    isFleetVirtualSystemId,
} from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_VIRTUAL_ACTION_PROPOSAL_KIND } from './agent-fleet-virtual-tools';
import { FleetVirtualService } from './fleet-virtual.service';

/**
 * Virtual computers (FL-16, spec S9, CONTRACTS R-33) — runs a held Agent act
 * (`fleet_virtual_create`, a stop, a destroy) once a PERSON approved it in My
 * Decisions. The act runs as the Agent (`requestedBy: agent:<id>`, so the host's
 * `machines` audience must still include the Agent's owner) with the
 * confirmation the approval stands for; every gate runs again — a host that
 * went offline or a child that started working meanwhile is refused, not
 * forced. Only platform-written payload fields are read, each re-validated.
 */
@Injectable()
export class FleetVirtualProposalListener {
    private readonly logger = new Logger(FleetVirtualProposalListener.name);

    constructor(private readonly virtual: FleetVirtualService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_VIRTUAL_ACTION_PROPOSAL_KIND) return;
        if (
            payload.agentId !== event.agentId ||
            typeof payload.hostNodeId !== 'string' ||
            !payload.hostNodeId
        ) {
            this.logger.warn(
                `Approved virtual-computer act ${event.proposalId} names another Agent or no host; not run`,
            );
            return;
        }
        const args = (payload.args ?? {}) as Record<string, unknown>;
        const caller = {
            kind: 'agent' as const,
            agentId: event.agentId,
            ownerUserId: event.userId,
        };
        try {
            if (payload.verb === 'create') {
                if (!isFleetVirtualName(args.name) || !isFleetVirtualSystemId(args.systemId)) {
                    this.logger.warn(
                        `Approved virtual-computer create ${event.proposalId} is invalid; not run`,
                    );
                    return;
                }
                await this.virtual.create(caller, payload.hostNodeId, {
                    name: args.name,
                    systemId: args.systemId,
                    ...(isFleetVirtualCpus(args.cpus) ? { cpus: args.cpus } : {}),
                    ...(isFleetVirtualMemoryGiB(args.memoryGiB)
                        ? { memoryGiB: args.memoryGiB }
                        : {}),
                    ...(isFleetVirtualDiskGiB(args.diskGiB) ? { diskGiB: args.diskGiB } : {}),
                    fields: { confirm: true },
                });
                return;
            }
            if (typeof payload.childNodeId !== 'string' || !payload.childNodeId) {
                this.logger.warn(
                    `Approved virtual-computer act ${event.proposalId} names no virtual computer; not run`,
                );
                return;
            }
            if (payload.verb === 'stop') {
                await this.virtual.power(caller, payload.hostNodeId, payload.childNodeId, 'stop', {
                    confirm: true,
                });
                return;
            }
            if (payload.verb === 'destroy') {
                if (!isFleetVirtualName(args.name)) {
                    this.logger.warn(
                        `Approved virtual-computer destroy ${event.proposalId} has no name; not run`,
                    );
                    return;
                }
                await this.virtual.destroy(caller, payload.hostNodeId, payload.childNodeId, {
                    confirmName: args.name,
                });
            }
        } catch (error) {
            this.logger.warn(
                `Approved virtual-computer act ${event.proposalId} (${String(payload.verb)}) did not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
