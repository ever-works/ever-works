import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GitHubAppInstallation } from '../../entities';

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

    async listAll(): Promise<GitHubAppInstallation[]> {
        return this.repository.find({
            order: {
                createdAt: 'DESC',
            },
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
