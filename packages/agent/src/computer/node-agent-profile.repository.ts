import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NodeAgentProfile } from '../entities/node-agent-profile.entity';

/** Data access for `node_agent_profiles` — one row per (Node, Agent). */
@Injectable()
export class NodeAgentProfileRepository {
    constructor(
        @InjectRepository(NodeAgentProfile)
        private readonly repository: Repository<NodeAgentProfile>,
    ) {}

    async findForNodeAgent(nodeId: string, agentId: string): Promise<NodeAgentProfile | null> {
        return this.repository.findOne({ where: { nodeId, agentId } });
    }

    async create(data: Partial<NodeAgentProfile>): Promise<NodeAgentProfile> {
        return this.repository.save(this.repository.create(data));
    }

    /**
     * The node's own usage report, accepted only for the profile key it was
     * handed — a report about a key that a reset has since rotated is stale
     * and changes nothing.
     */
    async recordUsage(
        nodeId: string,
        agentId: string,
        profileKey: string,
        usage: Pick<NodeAgentProfile, 'signedInSiteCount' | 'diskBytes' | 'lastUsedAt'>,
    ): Promise<boolean> {
        const result = await this.repository.update({ nodeId, agentId, profileKey }, usage);
        return (result.affected ?? 0) === 1;
    }

    /** Rotate the key and zero the usage — the platform half of a reset. */
    async reset(
        id: string,
        previousKey: string,
        patch: Pick<
            NodeAgentProfile,
            'profileKey' | 'signedInSiteCount' | 'diskBytes' | 'lastResetAt' | 'lastResetByUserId'
        >,
    ): Promise<boolean> {
        const result = await this.repository.update({ id, profileKey: previousKey }, patch);
        return (result.affected ?? 0) === 1;
    }
}
