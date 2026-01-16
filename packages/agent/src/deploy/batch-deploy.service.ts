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
    /** Fallback Vercel token if directory owner's token is not available */
    vercelToken?: string;
    /** Fallback GitHub token if directory owner's token is not available */
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
    /** Resolved Vercel token used for this deployment (for verification) */
    resolvedVercelToken?: string;
    /** Team scope used for this deployment (for verification) */
    resolvedTeamScope?: string;
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
     * Resolves tokens based on directory ownership - for shared directories,
     * uses the owner's tokens since they set up the infrastructure.
     */
    private async deploySingleDirectory(
        directoryId: string,
        tokens: {
            vercelToken?: string;
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

            // Determine if user is the directory creator
            const directoryOwner = directory.user;
            const isCreator = directoryOwner?.id === user.id;

            // For shared directories, use the directory owner's tokens
            // The owner set up the infrastructure, collaborators just trigger deployments
            const resolvedGhToken =
                tokens.ghToken || (isCreator ? user.getGitToken() : directoryOwner?.getGitToken());

            const resolvedVercelToken =
                tokens.vercelToken ||
                (isCreator ? user.vercelToken : directoryOwner?.vercelToken) ||
                user.vercelToken;

            if (!resolvedVercelToken) {
                return {
                    directoryId,
                    slug: directory.slug,
                    status: 'error',
                    message: isCreator
                        ? 'Vercel token is required. Please configure it in your settings.'
                        : 'The directory owner has not configured a Vercel token for deployment.',
                };
            }

            // VercelService.deploy already handles branch sync
            const deploymentInitiated = await this.vercelService.deploy(
                {
                    owner: directory.getRepoOwner(),
                    repo: directory.getWebsiteRepo(),
                    provider: 'vercel',
                    data: {
                        vercelTeamScope: tokens.vercelTeamScope,
                        vercelToken: resolvedVercelToken,
                        ghToken: resolvedGhToken,
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
                // Include resolved tokens for verification (only on success)
                resolvedVercelToken: deploymentInitiated ? resolvedVercelToken : undefined,
                resolvedTeamScope: deploymentInitiated ? tokens.vercelTeamScope : undefined,
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
