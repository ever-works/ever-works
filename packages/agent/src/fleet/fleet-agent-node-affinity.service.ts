import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import { FleetAgentNodeAffinityRepository } from './fleet-agent-node-affinity.repository';
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

        return this.affinities.upsert({
            userId: input.userId,
            organizationId,
            agentId: input.agentId,
            nodeId: input.nodeId,
        });
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
