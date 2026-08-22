import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';

export interface UpsertFleetAgentNodeAffinityData {
    userId: string;
    organizationId: string;
    agentId: string;
    nodeId: string;
}

@Injectable()
export class FleetAgentNodeAffinityRepository {
    constructor(
        @InjectRepository(FleetAgentNodeAffinity)
        private readonly repository: Repository<FleetAgentNodeAffinity>,
    ) {}

    async findForAgent(
        userId: string,
        organizationId: string,
        agentId: string,
    ): Promise<FleetAgentNodeAffinity | null> {
        return this.repository.findOne({ where: { userId, organizationId, agentId } });
    }

    async upsert(data: UpsertFleetAgentNodeAffinityData): Promise<FleetAgentNodeAffinity> {
        await this.repository.upsert(data, ['userId', 'organizationId', 'agentId']);
        const affinity = await this.findForAgent(data.userId, data.organizationId, data.agentId);
        if (!affinity) {
            throw new Error('Fleet Agent node affinity upsert did not produce a row');
        }
        return affinity;
    }
}
