import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from './github.service';
import { WEBSITE_TEMPLATE_CONFIG } from '../website-generator/config/website-template.config';
import { ICommitter } from './git.provider';
import * as fs from 'node:fs/promises';

export interface BranchSyncResult {
    branch: string;
    status: 'synced' | 'skipped' | 'error';
    message?: string;
}

export interface BranchSyncSummary {
    totalBranches: number;
    synced: number;
    skipped: number;
    errors: number;
    results: BranchSyncResult[];
}

@Injectable()
export class BranchSyncService {
    private readonly logger = new Logger(BranchSyncService.name);

    // Control parallelism to avoid rate limiting
    private readonly MAX_CONCURRENT_SYNCS = 3;

    constructor(private readonly githubService: GithubService) {}

    /**
     * Sync branches from template repository to target repository
     * @param params.branchMapping - Optional mapping to also push source branch to different target (e.g., { 'stage': 'main' })
     */
    async syncAllBranches(params: {
        targetOwner: string;
        targetRepo: string;
        token: string;
        committer: ICommitter;
        forcePush?: boolean;
        branchMapping?: { [sourceBranch: string]: string };
    }): Promise<BranchSyncSummary> {
        const {
            targetOwner,
            targetRepo,
            token,
            committer,
            forcePush = true,
            branchMapping = {},
        } = params;

        const branchesToSync = [...WEBSITE_TEMPLATE_CONFIG.syncBranches];
        const mappedTargets = Object.values(branchMapping);

        this.logger.log(
            `Syncing branches [${branchesToSync.join(', ')}] to ${targetOwner}/${targetRepo}`,
        );

        // Build sync operations
        const syncOperations: Array<{ branchName: string; targetBranch: string }> = [];

        for (const branchName of branchesToSync) {
            // Skip if this branch would be overwritten by a mapped branch
            if (mappedTargets.includes(branchName) && !branchMapping[branchName]) {
                this.logger.log(`Skipping '${branchName}' - will be overwritten by mapped branch`);
                continue;
            }

            syncOperations.push({ branchName, targetBranch: branchName });

            // If mapped, also sync to the mapped target
            const mappedTarget = branchMapping[branchName];
            if (mappedTarget && mappedTarget !== branchName) {
                syncOperations.push({ branchName, targetBranch: mappedTarget });
                this.logger.log(`Branch '${branchName}' will also sync to '${mappedTarget}'`);
            }
        }

        // Sync with controlled parallelism
        const results: BranchSyncResult[] = [];

        for (let i = 0; i < syncOperations.length; i += this.MAX_CONCURRENT_SYNCS) {
            const batch = syncOperations.slice(i, i + this.MAX_CONCURRENT_SYNCS);

            const batchResults = await Promise.allSettled(
                batch.map((op) =>
                    this.syncBranch({
                        branchName: op.branchName,
                        targetBranch: op.targetBranch,
                        targetOwner,
                        targetRepo,
                        token,
                        committer,
                        forcePush,
                    }),
                ),
            );

            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                const op = batch[j];

                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    results.push({
                        branch: op.branchName,
                        status: 'error',
                        message: result.reason?.message || 'Unknown error',
                    });
                }
            }

            // Small delay between batches to avoid rate limiting
            if (i + this.MAX_CONCURRENT_SYNCS < syncOperations.length) {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }

        const summary: BranchSyncSummary = {
            totalBranches: branchesToSync.length,
            synced: results.filter((r) => r.status === 'synced').length,
            skipped: results.filter((r) => r.status === 'skipped').length,
            errors: results.filter((r) => r.status === 'error').length,
            results,
        };

        this.logger.log(
            `Branch sync completed for ${targetOwner}/${targetRepo}: ${summary.synced} synced, ${summary.skipped} skipped, ${summary.errors} errors`,
        );

        return summary;
    }

    /** Sync a single branch from template to target repository */
    async syncBranch(params: {
        branchName: string;
        targetBranch?: string;
        targetOwner: string;
        targetRepo: string;
        token: string;
        committer: ICommitter;
        forcePush?: boolean;
    }): Promise<BranchSyncResult> {
        const {
            branchName,
            targetBranch = branchName,
            targetOwner,
            targetRepo,
            token,
            committer,
            forcePush = true,
        } = params;

        const mappingInfo = targetBranch !== branchName ? ` (mapped to '${targetBranch}')` : '';
        this.logger.log(
            `Syncing branch '${branchName}'${mappingInfo} to ${targetOwner}/${targetRepo}`,
        );

        let tempDir: string | null = null;

        try {
            const uniqueRepoName = `${WEBSITE_TEMPLATE_CONFIG.repo}-sync-${branchName}-${Date.now()}`;
            await this.githubService.removeDir(WEBSITE_TEMPLATE_CONFIG.owner, uniqueRepoName);

            tempDir = await this.githubService.cloneOrPull({
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch: branchName,
                token,
                committer: this.githubService.getCommitter(committer),
                autoSwitchToMainBranch: false,
            });

            await this.githubService.switchToBranch(tempDir, branchName);

            if (targetBranch !== branchName) {
                await this.githubService.renameBranch(tempDir, branchName, targetBranch);
            }

            const targetRepoUrl = this.githubService.getURL(targetOwner, targetRepo);
            await this.githubService.remoteRemove(tempDir, 'origin');
            await this.githubService.remoteAdd(tempDir, 'origin', targetRepoUrl);

            await this.githubService.push(tempDir, token, forcePush);

            return {
                branch: branchName,
                status: 'synced',
                message: `Successfully synced branch '${branchName}'${mappingInfo}`,
            };
        } catch (error) {
            this.logger.error(`Failed to sync branch '${branchName}':`, error.message);

            return {
                branch: branchName,
                status: 'error',
                message: error.message,
            };
        } finally {
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }
}
