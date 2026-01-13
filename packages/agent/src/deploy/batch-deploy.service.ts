import { Injectable, Logger } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { User } from '../entities/user.entity';

export interface BatchDeployItem {
    directoryId: string;
    vercelTeamScope?: string;
}

export interface BatchDeployOptions {
    directories: BatchDeployItem[];
    vercelToken: string;
    ghToken?: string;
    defaultTeamScope?: string;
}

export interface BatchDeployItemResult {
    directoryId: string;
    slug: string;
    status: 'pending' | 'error';
    message: string;
    owner?: string;
    repository?: string;
}

export interface BatchDeployResult {
    totalRequested: number;
    successfullyStarted: number;
    failed: number;
    results: BatchDeployItemResult[];
}

@Injectable()
export class BatchDeployService {
    private readonly logger = new Logger(BatchDeployService.name);

    // Limit concurrent deployments to avoid overwhelming services
    private readonly MAX_CONCURRENT_DEPLOYS = 5;

    constructor(
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    /**
     * Deploy multiple directories in batch
     */
    async deployBatch(options: BatchDeployOptions, user: User): Promise<BatchDeployResult> {
        const results: BatchDeployItemResult[] = [];
        let successCount = 0;
        let failCount = 0;

        this.logger.log(`Starting batch deployment of ${options.directories.length} directories`);

        // Process in batches to avoid overwhelming services
        for (let i = 0; i < options.directories.length; i += this.MAX_CONCURRENT_DEPLOYS) {
            const batch = options.directories.slice(i, i + this.MAX_CONCURRENT_DEPLOYS);

            const batchResults = await Promise.allSettled(
                batch.map((item) =>
                    this.deploySingleDirectory(
                        item.directoryId,
                        {
                            vercelToken: options.vercelToken,
                            ghToken: options.ghToken,
                            vercelTeamScope: item.vercelTeamScope || options.defaultTeamScope,
                        },
                        user,
                    ),
                ),
            );

            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                const item = batch[j];

                if (result.status === 'fulfilled') {
                    results.push(result.value);
                    if (result.value.status === 'pending') {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } else {
                    failCount++;
                    results.push({
                        directoryId: item.directoryId,
                        slug: 'unknown',
                        status: 'error',
                        message: result.reason?.message || 'Unknown error',
                    });
                }
            }

            // Small delay between batches
            if (i + this.MAX_CONCURRENT_DEPLOYS < options.directories.length) {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        this.logger.log(`Batch deployment completed: ${successCount} started, ${failCount} failed`);

        return {
            totalRequested: options.directories.length,
            successfullyStarted: successCount,
            failed: failCount,
            results,
        };
    }

    /**
     * Deploy a single directory (includes branch sync via VercelService)
     */
    private async deploySingleDirectory(
        directoryId: string,
        tokens: {
            vercelToken: string;
            ghToken?: string;
            vercelTeamScope?: string;
        },
        user: User,
    ): Promise<BatchDeployItemResult> {
        try {
            const directory = await this.directoryRepository.findById(directoryId);

            if (!directory) {
                return {
                    directoryId,
                    slug: 'unknown',
                    status: 'error',
                    message: 'Directory not found',
                };
            }

            this.logger.log(`Deploying directory: ${directory.slug}`);

            // VercelService.deploy already handles branch sync
            const deploymentInitiated = await this.vercelService.deploy(
                {
                    owner: directory.getRepoOwner(),
                    repo: directory.getWebsiteRepo(),
                    provider: 'vercel',
                    data: {
                        vercelTeamScope: tokens.vercelTeamScope,
                        vercelToken: tokens.vercelToken,
                        ghToken: tokens.ghToken || user.getGitToken(),
                    },
                },
                directory,
                user,
            );

            return {
                directoryId,
                slug: directory.slug,
                status: deploymentInitiated ? 'pending' : 'error',
                message: deploymentInitiated
                    ? 'Deployment started'
                    : 'Failed to initiate deployment',
                owner: directory.getRepoOwner(),
                repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            };
        } catch (error) {
            this.logger.error(`Failed to deploy directory ${directoryId}:`, error.message);

            return {
                directoryId,
                slug: 'unknown',
                status: 'error',
                message: error.message,
            };
        }
    }
}
