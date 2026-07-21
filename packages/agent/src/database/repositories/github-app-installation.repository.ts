import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GitHubAppInstallation } from '../../entities/github-app-installation.entity';
export type UpsertGitHubAppInstallationData = {
    installationId: string;
    appSlug?: string | null;
    accountLogin: string;
    accountType: string;
    targetType: string;
    createdByUserId?: string | null;
    createdByGithubUserId?: string | null;
    suspendedAt?: Date | null;
    deletedAt?: Date | null;
    rawPayload?: Record<string, unknown> | null;
};

@Injectable()
export class GitHubAppInstallationRepository {
    constructor(
        @InjectRepository(GitHubAppInstallation)
        private readonly repository: Repository<GitHubAppInstallation>,
    ) {}

    async findById(id: string): Promise<GitHubAppInstallation | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByInstallationId(installationId: string): Promise<GitHubAppInstallation | null> {
        return this.repository.findOne({ where: { installationId } });
    }

    /**
     * Find the active (not deleted, not suspended) GitHub App installation
     * for an account login (org or user) — e.g. the `ever-works` org's
     * installation. Used for system-level reads of org-owned repos
     * (agent-template catalog) without a Work context. Newest first.
     */
    async findActiveByAccountLogin(accountLogin: string): Promise<GitHubAppInstallation | null> {
        return this.repository.findOne({
            where: { accountLogin, deletedAt: IsNull(), suspendedAt: IsNull() },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Security: returns EVERY installation across ALL tenants.
     * Must only be called from platform-admin–gated code paths (e.g. an
     * IsPlatformAdminGuard-protected controller). NEVER wire this to a
     * tenant-scoped route — use `listByTenantId` instead.
     */
    async listAll(): Promise<GitHubAppInstallation[]> {
        return this.repository.find({
            order: {
                createdAt: 'DESC',
            },
        });
    }

    /**
     * Security: tenant-scoped enumeration — safe for use in tenant routes.
     * Always prefer this over `listAll()` when the caller has a tenantId.
     */
    async listByTenantId(tenantId: string): Promise<GitHubAppInstallation[]> {
        // Security: filters to a single tenant to prevent cross-tenant data exposure
        return this.repository.find({
            where: { tenantId, deletedAt: IsNull() },
            order: { createdAt: 'DESC' },
        });
    }

    async listByCreatedByUserId(createdByUserId: string): Promise<GitHubAppInstallation[]> {
        return this.repository.find({
            where: { createdByUserId, deletedAt: IsNull() },
            order: {
                createdAt: 'DESC',
            },
        });
    }

    async upsertFromGithub(data: UpsertGitHubAppInstallationData): Promise<GitHubAppInstallation> {
        const existing = await this.findByInstallationId(data.installationId);
        const definedData = this.removeUndefinedValues(data);

        if (existing) {
            await this.repository.update(existing.id, definedData);
            return this.repository.findOneOrFail({ where: { id: existing.id } });
        }

        try {
            return await this.repository.save(this.repository.create(definedData));
        } catch (error) {
            if (!this.isUniqueConstraintError(error)) {
                throw error;
            }

            await this.repository.update({ installationId: data.installationId }, definedData);
            return this.repository.findOneOrFail({
                where: { installationId: data.installationId },
            });
        }
    }

    async claimOwnershipIfUnassigned(
        installationId: string,
        createdByUserId: string,
        createdByGithubUserId: string,
    ): Promise<GitHubAppInstallation | null> {
        const existing = await this.findByInstallationId(installationId);
        if (!existing) {
            return null;
        }

        if (existing.createdByUserId) {
            return existing;
        }

        await this.repository
            .createQueryBuilder()
            .update(GitHubAppInstallation)
            .set({
                createdByUserId,
                createdByGithubUserId,
            })
            .where('id = :id AND "createdByUserId" IS NULL', { id: existing.id })
            .execute();

        return this.findByInstallationId(installationId);
    }

    async markSuspended(
        installationId: string,
        suspendedAt: Date | null,
    ): Promise<GitHubAppInstallation | null> {
        const existing = await this.findByInstallationId(installationId);
        if (!existing) {
            return null;
        }

        await this.repository.update(existing.id, { suspendedAt });
        return this.repository.findOne({ where: { id: existing.id } });
    }

    async markDeleted(
        installationId: string,
        deletedAt: Date | null,
    ): Promise<GitHubAppInstallation | null> {
        const existing = await this.findByInstallationId(installationId);
        if (!existing) {
            return null;
        }

        await this.repository.update(existing.id, {
            deletedAt,
            suspendedAt: null,
        });
        return this.repository.findOne({ where: { id: existing.id } });
    }

    private removeUndefinedValues<T extends object>(data: T): Partial<T> {
        return Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
        ) as Partial<T>;
    }

    private isUniqueConstraintError(error: unknown): boolean {
        if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as { code: string }).code;
            return code === '23505' || code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT';
        }

        return false;
    }
}
