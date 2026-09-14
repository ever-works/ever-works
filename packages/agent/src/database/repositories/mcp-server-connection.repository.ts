import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { ConnectionHealthErrorCode } from '@ever-works/contracts';
import { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import { classifyProbeResult } from '../../connections/connection-health';
import { mcpHealthErrorCode } from '../../mcp/mcp-connection-health';

/**
 * How many times a failed attempt re-reads the failure counter after a
 * concurrent stamp changed it. Each miss means another attempt's write DID
 * land, so contention converges long before this bound.
 */
export const MCP_HEALTH_STAMP_MAX_ATTEMPTS = 10;

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
     * AW-15: the same write also records connection health. A failure is a
     * compare-and-set on the failure counter: the count is read, classified
     * (`classifyProbeResult` tells `degraded` from `unreachable`), and written
     * only if the row still holds the count that was read. When a concurrent
     * attempt stamped the row in between, nothing is written and the attempt
     * re-reads and classifies against the fresh count, so no increment is
     * ever lost. `errorCode` is optional — when absent it is derived from the
     * classified message the MCP client already produced.
     *
     * A success may carry `warning: 'insecure_transport'` (literal
     * credentials sent over plain http). It is still a success —
     * `lastConnectedAt` advances, `lastError` clears, the failure count
     * resets — but health records the warning instead of `healthy`.
     */
    async stampConnectionResult(
        id: string,
        result: {
            ok: boolean;
            error?: string | null;
            errorCode?: ConnectionHealthErrorCode | null;
            warning?: ConnectionHealthErrorCode | null;
        },
    ): Promise<void> {
        const now = new Date();
        if (result.ok) {
            const classified = classifyProbeResult({ ok: true, warning: result.warning ?? null });
            await this.repository.update(id, {
                lastConnectedAt: now,
                lastError: null,
                health: classified.health,
                healthCheckedAt: now,
                healthFailureCount: 0,
                lastErrorCode: classified.errorCode,
            });
            return;
        }

        const error = result.error ?? 'Unknown error';
        const outcome = { ok: false, errorCode: result.errorCode ?? mcpHealthErrorCode(error) };
        for (let attempt = 0; attempt < MCP_HEALTH_STAMP_MAX_ATTEMPTS; attempt += 1) {
            const current = await this.repository.findOne({
                where: { id },
                select: { id: true, healthFailureCount: true },
            });
            // The row is gone (deleted mid-attempt): there is nothing to stamp.
            if (!current) return;
            const stored = current.healthFailureCount;
            const classified = classifyProbeResult(outcome, stored ?? 0);
            const written = await this.repository.update(
                {
                    id,
                    healthFailureCount: stored === null || stored === undefined ? IsNull() : stored,
                },
                {
                    lastError: error,
                    health: classified.health,
                    healthCheckedAt: now,
                    healthFailureCount: classified.failureCount,
                    lastErrorCode: classified.errorCode,
                },
            );
            // Every supported driver reports affected rows; one that does not
            // cannot confirm the compare, so its write is accepted as is.
            if (written?.affected === undefined || written.affected > 0) return;
        }
        throw new Error(
            `Could not record health for MCP connection ${id}: the row changed under ${MCP_HEALTH_STAMP_MAX_ATTEMPTS} consecutive attempts.`,
        );
    }
}
