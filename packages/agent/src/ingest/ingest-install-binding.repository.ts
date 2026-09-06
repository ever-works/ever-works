import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    IngestInstallBinding,
    type IngestInstallProvider,
} from '../entities/ingest-install-binding.entity';

export interface RecordIngestBindingData {
    provider: IngestInstallProvider;
    externalWorkspaceId: string;
    externalEnterpriseId?: string | null;
    userId: string;
    pluginId: string;
    externalWorkspaceName?: string | null;
}

/**
 * Per-workspace / per-installation bindings for the inbound receivers
 * (see `IngestInstallBinding`). Feature-owned repository provided by
 * `EventIngestModule` — same split as `IngestedEventRepository` and
 * `IngestCursorRepository`.
 *
 * Every method is safe to call on the webhook hot path: reads are a
 * single indexed lookup and the write is check-then-insert with the
 * UNIQUE-index race resolved by retrying as an update (same convention
 * as `IngestCursorRepository.save`).
 */
@Injectable()
export class IngestInstallBindingRepository {
    private readonly logger = new Logger(IngestInstallBindingRepository.name);

    constructor(
        @InjectRepository(IngestInstallBinding)
        private readonly repository: Repository<IngestInstallBinding>,
    ) {}

    /** Exact binding for one external workspace, or null. */
    async findByWorkspace(
        provider: IngestInstallProvider,
        externalWorkspaceId: string,
    ): Promise<IngestInstallBinding | null> {
        if (!externalWorkspaceId) return null;
        return this.repository.findOne({ where: { provider, externalWorkspaceId } });
    }

    /** Every binding owned by one platform user (settings UI / diagnostics). */
    async findByUser(userId: string): Promise<IngestInstallBinding[]> {
        return this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    /** Count of bindings for a provider — used to reason about ambiguity. */
    async countByProvider(provider: IngestInstallProvider): Promise<number> {
        return this.repository.count({ where: { provider } });
    }

    /**
     * Record (or re-point) the binding for one external workspace.
     *
     * Callers MUST only invoke this after a delivery has passed signature
     * verification — the row is a record of proven ownership, never a
     * user-supplied claim.
     */
    async record(data: RecordIngestBindingData): Promise<IngestInstallBinding | null> {
        if (!data.externalWorkspaceId) return null;
        const existing = await this.findByWorkspace(data.provider, data.externalWorkspaceId);
        if (existing) {
            existing.userId = data.userId;
            existing.pluginId = data.pluginId;
            existing.externalEnterpriseId = data.externalEnterpriseId ?? null;
            if (data.externalWorkspaceName) {
                existing.externalWorkspaceName = data.externalWorkspaceName;
            }
            return this.repository.save(existing);
        }
        try {
            return await this.repository.save(
                this.repository.create({
                    provider: data.provider,
                    externalWorkspaceId: data.externalWorkspaceId,
                    externalEnterpriseId: data.externalEnterpriseId ?? null,
                    userId: data.userId,
                    pluginId: data.pluginId,
                    externalWorkspaceName: data.externalWorkspaceName ?? null,
                }),
            );
        } catch (error) {
            // Concurrent first-delivery from the same workspace — the
            // UNIQUE index picked a winner; adopt it rather than throw on
            // a public webhook path.
            const winner = await this.findByWorkspace(data.provider, data.externalWorkspaceId);
            if (winner) return winner;
            this.logger.warn(
                `Failed to record ${data.provider} install binding for "${data.externalWorkspaceId}": ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * Insert the binding for one external workspace ONLY when nothing
     * holds it yet, and return whoever holds it afterwards (never null
     * unless the insert failed for a non-race reason).
     *
     * The difference from {@link record} is deliberate and
     * security-relevant. `record` RE-POINTS an existing row, which is
     * correct after a signature-verified delivery has proven ownership.
     * An authenticated FIRST-CLAIM surface (Sentry installations) has no
     * such proof — the claimant only knows an id — so a second claimant
     * must lose to the first instead of overwriting it. `record`'s
     * check-then-write cannot express that: two concurrent claims both
     * see no row, and the second one's update silently steals the first
     * one's binding. Here the existence check and the insert are the
     * only two outcomes, so the loser of the race gets the winner's row
     * back and the caller answers 409 by comparing `userId`.
     */
    async recordIfAbsent(data: RecordIngestBindingData): Promise<IngestInstallBinding | null> {
        if (!data.externalWorkspaceId) return null;
        const existing = await this.findByWorkspace(data.provider, data.externalWorkspaceId);
        if (existing) return existing;
        try {
            return await this.repository.save(
                this.repository.create({
                    provider: data.provider,
                    externalWorkspaceId: data.externalWorkspaceId,
                    externalEnterpriseId: data.externalEnterpriseId ?? null,
                    userId: data.userId,
                    pluginId: data.pluginId,
                    externalWorkspaceName: data.externalWorkspaceName ?? null,
                }),
            );
        } catch (error) {
            // Concurrent first claim — the UNIQUE index picked a winner;
            // hand it back so the caller can tell "mine" from "theirs".
            const winner = await this.findByWorkspace(data.provider, data.externalWorkspaceId);
            if (winner) return winner;
            this.logger.warn(
                `Failed to claim ${data.provider} install binding for "${data.externalWorkspaceId}": ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * Remove the binding for one external workspace. True when a row
     * went. Used when the external side tells us the installation is
     * gone (Sentry `installation.deleted`) or when the owner unbinds it
     * from the settings surface — the caller is responsible for having
     * verified either the delivery signature or the owner.
     */
    async remove(provider: IngestInstallProvider, externalWorkspaceId: string): Promise<boolean> {
        if (!externalWorkspaceId) return false;
        const existing = await this.findByWorkspace(provider, externalWorkspaceId);
        if (!existing) return false;
        await this.repository.remove(existing);
        return true;
    }
}
