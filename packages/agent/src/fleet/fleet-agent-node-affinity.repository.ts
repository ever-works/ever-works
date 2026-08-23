import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../entities/agent.entity';
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
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
    ) {}

    async findForAgent(
        userId: string,
        organizationId: string,
        agentId: string,
    ): Promise<FleetAgentNodeAffinity | null> {
        return this.repository.findOne({ where: { userId, organizationId, agentId } });
    }

    /**
     * The binding that governs an Agent's work, resolved through the
     * AGENT's own Organization rather than whatever scope a job happens to
     * carry. A Task is stamped with the scope that was active when it was
     * created (and a cron-spawned recurrence instance carries none at
     * all), so keying the scheduling lookup on the job's organizationId
     * would silently un-pin the very runs the owner bound. The Agent
     * belongs to exactly one Organization, and the binding was validated
     * against that Organization when it was written.
     *
     * Null when the Agent is not owned by `userId`, has no Organization
     * (personal scope — bindings are never written there), or is unbound.
     */
    async findForOwnedAgent(userId: string, agentId: string): Promise<FleetAgentNodeAffinity | null> {
        const agent = await this.agents.findOne({
            where: { id: agentId, userId },
            select: { id: true, organizationId: true },
        });
        if (!agent?.organizationId) {
            return null;
        }
        return this.findForAgent(userId, agent.organizationId, agentId);
    }

    async upsert(data: UpsertFleetAgentNodeAffinityData): Promise<FleetAgentNodeAffinity> {
        // `updatedAt` is set explicitly so a re-bind refreshes it on EVERY
        // driver: TypeORM appends `"updatedAt" = DEFAULT` to the
        // ON CONFLICT update on Postgres but deliberately not on the
        // sqlite family, where the row would otherwise keep its original
        // timestamp forever.
        await this.repository.upsert({ ...data, updatedAt: new Date() }, [
            'userId',
            'organizationId',
            'agentId',
        ]);
        const affinity = await this.findForAgent(data.userId, data.organizationId, data.agentId);
        if (!affinity) {
            throw new Error('Fleet Agent node affinity upsert did not produce a row');
        }
        return affinity;
    }

    /** Idempotent: clearing an Agent that has no binding is a no-op. Returns whether a row was removed. */
    async remove(userId: string, organizationId: string, agentId: string): Promise<boolean> {
        const result = await this.repository.delete({ userId, organizationId, agentId });
        return (result.affected ?? 0) > 0;
    }
}
