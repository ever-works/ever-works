import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
    AgentMcpServerBinding,
    type McpBindingTargetType,
} from '../../entities/agent-mcp-server-binding.entity';

/**
 * Agent Plugins MCP slice — binding rows connecting `mcp_server_connections`
 * to targets ('tenant' inherit-all rows + per-'agent' override rows).
 * User-scoped like SkillBindingRepository: cross-user lookups return
 * nothing so services can 404 without an existence leak.
 */
@Injectable()
export class AgentMcpServerBindingRepository {
    constructor(
        @InjectRepository(AgentMcpServerBinding)
        private readonly repository: Repository<AgentMcpServerBinding>,
    ) {}

    async findByUser(userId: string): Promise<AgentMcpServerBinding[]> {
        return this.repository.find({ where: { userId } });
    }

    async findByConnection(connectionId: string, userId: string): Promise<AgentMcpServerBinding[]> {
        return this.repository.find({ where: { connectionId, userId } });
    }

    /**
     * All rows that can influence one agent's resolution: its own
     * 'agent' override rows plus every 'tenant' inherit row.
     */
    async findForAgent(userId: string, agentId: string): Promise<AgentMcpServerBinding[]> {
        return this.repository.find({
            where: [
                { userId, targetType: 'agent' as const, targetId: agentId },
                { userId, targetType: 'tenant' as const, targetId: IsNull() },
            ],
        });
    }

    async findOne(
        userId: string,
        connectionId: string,
        targetType: McpBindingTargetType,
        targetId: string | null,
    ): Promise<AgentMcpServerBinding | null> {
        return this.repository.findOne({
            where: {
                userId,
                connectionId,
                targetType,
                targetId: targetId === null ? IsNull() : targetId,
            },
        });
    }

    /** Create-or-update on the (connectionId, targetType, targetId) unique key. */
    async upsert(data: {
        userId: string;
        connectionId: string;
        targetType: McpBindingTargetType;
        targetId: string | null;
        enabled: boolean;
        tenantId?: string | null;
        organizationId?: string | null;
    }): Promise<AgentMcpServerBinding> {
        const existing = await this.findOne(
            data.userId,
            data.connectionId,
            data.targetType,
            data.targetId,
        );
        if (existing) {
            existing.enabled = data.enabled;
            return this.repository.save(existing);
        }
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async deleteOne(
        userId: string,
        connectionId: string,
        targetType: McpBindingTargetType,
        targetId: string | null,
    ): Promise<void> {
        await this.repository.delete({
            userId,
            connectionId,
            targetType,
            targetId: targetId === null ? IsNull() : targetId,
        });
    }
}
