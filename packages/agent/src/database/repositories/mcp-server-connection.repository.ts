import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServerConnection } from '../../entities/mcp-server-connection.entity';

/**
 * Agent Plugins MCP slice — data surface for the manual/global MCP
 * connection registry. Every read/write is user-scoped: cross-user ids
 * resolve to null so the service layer can 404 without an existence leak
 * (security spec §8 posture, same as SkillRepository).
 */
@Injectable()
export class McpServerConnectionRepository {
    constructor(
        @InjectRepository(McpServerConnection)
        private readonly repository: Repository<McpServerConnection>,
    ) {}

    async findByIdAndUser(id: string, userId: string): Promise<McpServerConnection | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByUser(userId: string): Promise<McpServerConnection[]> {
        return this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    async findEnabledByUser(userId: string): Promise<McpServerConnection[]> {
        return this.repository.find({
            where: { userId, enabled: true },
            order: { createdAt: 'ASC' },
        });
    }

    async findByUserAndName(userId: string, name: string): Promise<McpServerConnection | null> {
        return this.repository.findOne({ where: { userId, name } });
    }

    async create(data: Partial<McpServerConnection>): Promise<McpServerConnection> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async save(entity: McpServerConnection): Promise<McpServerConnection> {
        return this.repository.save(entity);
    }

    async deleteByIdAndUser(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }

    /**
     * Stamp the outcome of a connect/list/call attempt. `lastError` is a
     * CLASSIFIED message (never raw header material); success clears it.
     */
    async stampConnectionResult(
        id: string,
        result: { ok: boolean; error?: string | null },
    ): Promise<void> {
        if (result.ok) {
            await this.repository.update(id, { lastConnectedAt: new Date(), lastError: null });
        } else {
            await this.repository.update(id, { lastError: result.error ?? 'Unknown error' });
        }
    }
}
