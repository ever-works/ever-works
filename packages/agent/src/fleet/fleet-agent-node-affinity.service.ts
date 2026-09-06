import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import { FleetAgentNodeAffinityRepository } from './fleet-agent-node-affinity.repository';
import { FleetAuditService } from './fleet-audit.service';
import { FleetNodeRepository } from './fleet-node.repository';

const AFFINITY_NOT_FOUND = 'Fleet Agent or node not found';

export interface FleetAgentNodeAffinityScope {
    userId: string;
    organizationId: string | null | undefined;
    agentId: string;
}

export interface SetFleetAgentNodeAffinityInput extends FleetAgentNodeAffinityScope {
    nodeId: string;
}

/**
 * Owner/Organization validation boundary for durable Agent-to-PC intent.
 * Fleet nodes remain user-owned; only the binding is Organization-scoped.
 */
@Injectable()
export class FleetAgentNodeAffinityService {
    constructor(
        private readonly affinities: FleetAgentNodeAffinityRepository,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        private readonly nodes: FleetNodeRepository,
        // APPENDED and @Optional(), like every other fleet audit
        // dependency: binding an Agent to a PC must not become
        // impossible because the audit repository is unavailable.
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    async getAffinity(input: FleetAgentNodeAffinityScope): Promise<FleetAgentNodeAffinity | null> {
        const organizationId = this.requireOrganization(input.organizationId);
        await this.requireOwnedOrganizationAgent(input.userId, organizationId, input.agentId);
        return this.affinities.findForAgent(input.userId, organizationId, input.agentId);
    }

    async setAffinity(input: SetFleetAgentNodeAffinityInput): Promise<FleetAgentNodeAffinity> {
        const organizationId = this.requireOrganization(input.organizationId);
        await this.requireOwnedOrganizationAgent(input.userId, organizationId, input.agentId);

        const node = await this.nodes.findById(input.nodeId);
        if (!node || node.userId !== input.userId) {
            throw new NotFoundException(AFFINITY_NOT_FOUND);
        }

        const before = await this.affinities.findForAgent(
            input.userId,
            organizationId,
            input.agentId,
        );
        const row = await this.affinities.upsert({
            userId: input.userId,
            organizationId,
            agentId: input.agentId,
            nodeId: input.nodeId,
        });
        // Act first, then audit (EW-799). `nodeId` is the AFFINITY TARGET
        // — the machine the Agent is now pinned to — which is what makes
        // this row show up in that node's own history.
        await this.audit?.recordNodeAction({
            action: 'affinity.set',
            actorUserId: input.userId,
            ownerUserId: input.userId,
            nodeId: input.nodeId,
            before: before ? { nodeId: before.nodeId } : null,
            after: { nodeId: row.nodeId },
            extra: { agentId: input.agentId, organizationId },
        });
        return row;
    }

    /**
     * Return an Agent to "any of my PCs" (idempotent). The same owner +
     * active-Organization validation as `setAffinity` runs first, so a
     * foreign or unknown Agent is a 404 whether or not a row exists.
     * Already-queued jobs keep the snapshot they were enqueued with; only
     * future jobs become unbound.
     */
    async clearAffinity(input: FleetAgentNodeAffinityScope): Promise<{ cleared: boolean }> {
        const organizationId = this.requireOrganization(input.organizationId);
        await this.requireOwnedOrganizationAgent(input.userId, organizationId, input.agentId);
        const before = await this.affinities.findForAgent(
            input.userId,
            organizationId,
            input.agentId,
        );
        const cleared = await this.affinities.remove(input.userId, organizationId, input.agentId);
        await this.audit?.recordNodeAction({
            action: 'affinity.clear',
            actorUserId: input.userId,
            ownerUserId: input.userId,
            // The node the Agent WAS pinned to, so the unbinding lands in
            // that machine's history rather than nowhere.
            nodeId: before?.nodeId ?? null,
            before: before ? { nodeId: before.nodeId } : null,
            after: null,
            extra: { agentId: input.agentId, organizationId, cleared },
        });
        return { cleared };
    }

    private requireOrganization(organizationId: string | null | undefined): string {
        if (typeof organizationId !== 'string' || !organizationId.trim()) {
            throw new BadRequestException(
                'Fleet Agent node affinity requires an active Organization',
            );
        }
        return organizationId;
    }

    private async requireOwnedOrganizationAgent(
        userId: string,
        organizationId: string,
        agentId: string,
    ): Promise<void> {
        const agent = await this.agents.findOne({ where: { id: agentId, userId } });
        if (!agent || agent.organizationId !== organizationId) {
            throw new NotFoundException(AFFINITY_NOT_FOUND);
        }
    }
}
