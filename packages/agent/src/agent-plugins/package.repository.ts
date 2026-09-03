import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    AgentPluginPackage,
    type AgentPluginPackageInstallState,
    type AgentPluginPackageSource,
} from '../entities/agent-plugin-package.entity';

/**
 * Data access for the Agent Plugins package registry.
 *
 * Kept in the feature folder rather than `database/repositories/` to match
 * `ingest-install-binding.repository.ts`, which does the same for a
 * feature-local table.
 */
@Injectable()
export class AgentPluginPackageRepository {
    constructor(
        @InjectRepository(AgentPluginPackage)
        private readonly repository: Repository<AgentPluginPackage>,
    ) {}

    /**
     * Every remote package this replica is expected to have on disk.
     *
     * `local` is excluded because a local package IS its directory — there is
     * nothing to re-materialise, and re-creating one would mean inventing
     * bytes the operator never supplied.
     */
    async findRemoteInstalled(): Promise<AgentPluginPackage[]> {
        return this.repository.find({
            where: {
                source: In(['git', 'npm'] as AgentPluginPackageSource[]),
                installState: 'installed' as AgentPluginPackageInstallState,
            },
        });
    }

    async findByUser(userId: string): Promise<AgentPluginPackage[]> {
        return this.repository.find({ where: { userId } });
    }

    async findById(id: string): Promise<AgentPluginPackage | null> {
        return this.repository.findOne({ where: { id } });
    }

    async markInstalled(
        id: string,
        patch: {
            installPath: string;
            integrity?: string | null;
            version?: string | null;
            installError?: string | null;
        },
    ): Promise<void> {
        await this.repository.update(id, {
            installState: 'installed' as AgentPluginPackageInstallState,
            lastValidatedAt: new Date(),
            ...patch,
            installError: patch.installError ?? null,
        });
    }

    /**
     * Record a failure WITHOUT clearing `installPath` or `integrity`.
     *
     * Those fields are the record of what the package should be; erasing them
     * on a transient network failure would lose the coordinates needed to
     * retry, turning a retryable outage into an unrecoverable one.
     */
    async markFailed(id: string, error: string): Promise<void> {
        await this.repository.update(id, {
            installState: 'failed' as AgentPluginPackageInstallState,
            installError: error.slice(0, 2000),
        });
    }
}
