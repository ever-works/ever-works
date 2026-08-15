import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRepoAttachment } from '../../entities/agent-repo-attachment.entity';

/**
 * Repository registry (Feature G) — persistence for the Agent →
 * RepoConnection grant edge rows (`agent_repo_attachments`).
 */
@Injectable()
export class AgentRepoAttachmentRepository {
    constructor(
        @InjectRepository(AgentRepoAttachment)
        private readonly repository: Repository<AgentRepoAttachment>,
    ) {}

    async listForAgent(agentId: string, userId: string): Promise<AgentRepoAttachment[]> {
        return this.repository.find({
            where: { agentId, userId },
            order: { createdAt: 'ASC' },
        });
    }

    /** Enabled attachments with their repo rows — the provisioning read. */
    async listEnabledForAgentWithRepos(
        agentId: string,
        userId: string,
    ): Promise<AgentRepoAttachment[]> {
        return this.repository.find({
            where: { agentId, userId, enabled: true },
            relations: { repoConnection: true },
            order: { createdAt: 'ASC' },
        });
    }

    async findByAgentAndRepo(
        agentId: string,
        repoConnectionId: string,
        userId: string,
    ): Promise<AgentRepoAttachment | null> {
        return this.repository.findOne({ where: { agentId, repoConnectionId, userId } });
    }

    /** Idempotent attach: creates the edge or updates its `enabled` flag. */
    async upsert(data: {
        userId: string;
        agentId: string;
        repoConnectionId: string;
        enabled: boolean;
    }): Promise<AgentRepoAttachment> {
        const existing = await this.findByAgentAndRepo(
            data.agentId,
            data.repoConnectionId,
            data.userId,
        );
        if (existing) {
            existing.enabled = data.enabled;
            return this.repository.save(existing);
        }
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async deleteByAgentAndRepo(
        agentId: string,
        repoConnectionId: string,
        userId: string,
    ): Promise<boolean> {
        const result = await this.repository.delete({ agentId, repoConnectionId, userId });
        return (result.affected ?? 0) > 0;
    }
}
