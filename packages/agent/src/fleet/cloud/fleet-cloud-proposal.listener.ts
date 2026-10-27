import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    isFleetCloudIdlePolicyMode,
    isFleetCloudName,
    isFleetCloudPowerAction,
    normalizeFleetCloudSoftware,
} from '@ever-works/contracts';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { FLEET_CLOUD_ACTION_PROPOSAL_KIND } from './agent-fleet-cloud-tools';
import { FleetCloudService } from './fleet-cloud.service';

/**
 * Cloud computers (FL-17, spec S9, CONTRACTS R-33) — runs a held Agent act
 * (`fleet_cloud_create`, a power change, a destroy and — P2 — an idle-policy
 * change) once a PERSON approved it
 * in My Decisions. The act runs as the Agent (`requestedBy: agent:<id>`) with
 * the confirmation the approval stands for; every gate runs again — a price
 * that changed since the Agent read it is refused `invalid` (the approval
 * stood for THAT price, FR-34), the kill switch, the limit, a machine that
 * started working meanwhile. Only platform-written payload fields are read,
 * each re-validated.
 */
@Injectable()
export class FleetCloudProposalListener {
    private readonly logger = new Logger(FleetCloudProposalListener.name);

    constructor(private readonly cloud: FleetCloudService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other' || event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload.kind !== FLEET_CLOUD_ACTION_PROPOSAL_KIND) return;
        if (payload.agentId !== event.agentId) {
            this.logger.warn(
                `Approved cloud-computer act ${event.proposalId} names another Agent; not run`,
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
                if (
                    typeof args.providerPluginId !== 'string' ||
                    !isFleetCloudName(args.name) ||
                    typeof args.regionId !== 'string' ||
                    typeof args.sizeId !== 'string' ||
                    typeof args.acknowledgedPriceCents !== 'number'
                ) {
                    this.logger.warn(
                        `Approved cloud-computer create ${event.proposalId} is invalid; not run`,
                    );
                    return;
                }
                await this.cloud.create(caller, {
                    providerPluginId: args.providerPluginId,
                    name: args.name,
                    regionId: args.regionId,
                    sizeId: args.sizeId,
                    acknowledgedPriceCents: args.acknowledgedPriceCents,
                    software: normalizeFleetCloudSoftware(args.software),
                    fields: { confirm: true },
                });
                return;
            }
            if (typeof payload.nodeId !== 'string' || !payload.nodeId) {
                this.logger.warn(
                    `Approved cloud-computer act ${event.proposalId} names no computer; not run`,
                );
                return;
            }
            if (payload.verb === 'power') {
                if (!isFleetCloudPowerAction(args.action)) return;
                await this.cloud.power(caller, payload.nodeId, args.action, { confirm: true });
                return;
            }
            if (payload.verb === 'idle-policy') {
                if (!isFleetCloudIdlePolicyMode(args.mode) || typeof args.afterHours !== 'number') {
                    this.logger.warn(
                        `Approved cloud-computer idle policy ${event.proposalId} is invalid; not run`,
                    );
                    return;
                }
                await this.cloud.setIdlePolicy(caller, payload.nodeId, {
                    mode: args.mode,
                    afterHours: args.afterHours,
                });
                return;
            }
            if (payload.verb === 'destroy') {
                if (!isFleetCloudName(args.name)) {
                    this.logger.warn(
                        `Approved cloud-computer destroy ${event.proposalId} has no name; not run`,
                    );
                    return;
                }
                await this.cloud.destroy(caller, payload.nodeId, { confirmName: args.name });
            }
        } catch (error) {
            this.logger.warn(
                `Approved cloud-computer act ${event.proposalId} (${String(payload.verb)}) did not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
