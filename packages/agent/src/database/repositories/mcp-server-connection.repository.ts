import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ConnectionHealthErrorCode } from '@ever-works/contracts';
import { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import { classifyProbeResult } from '../../connections/connection-health';
import { mcpHealthErrorCode } from '../../mcp/mcp-connection-health';

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
     *
     * AW-15: the same write also records connection health. The failure
     * counter is read first so `classifyProbeResult` can tell `degraded`
     * from `unreachable`; under two concurrent failed attempts one increment
     * can be lost, which only delays `unreachable` by one attempt and never
     * flips a working connection. `errorCode` is optional — when absent it is
     * derived from the classified message the MCP client already produced.
     */
    async stampConnectionResult(
        id: string,
        result: {
            ok: boolean;
            error?: string | null;
            errorCode?: ConnectionHealthErrorCode | null;
        },
    ): Promise<void> {
        const now = new Date();
        if (result.ok) {
            await this.repository.update(id, {
                lastConnectedAt: now,
                lastError: null,
                health: 'healthy',
                healthCheckedAt: now,
                healthFailureCount: 0,
                lastErrorCode: null,
            });
            return;
        }

        const error = result.error ?? 'Unknown error';
        const current = await this.repository.findOne({
            where: { id },
            select: { id: true, healthFailureCount: true },
        });
        const classified = classifyProbeResult(
            { ok: false, errorCode: result.errorCode ?? mcpHealthErrorCode(error) },
            current?.healthFailureCount ?? 0,
        );
        await this.repository.update(id, {
            lastError: error,
            health: classified.health,
            healthCheckedAt: now,
            healthFailureCount: classified.failureCount,
            lastErrorCode: classified.errorCode,
        });
    }
}
