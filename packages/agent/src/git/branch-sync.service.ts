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
     * Sync all branches from template repository to target repository
     */
    async syncAllBranches(params: {
        targetOwner: string;
        targetRepo: string;
        token: string;
        committer: ICommitter;
        forcePush?: boolean;
        excludeBranches?: string[];
    }): Promise<BranchSyncSummary> {
        const {
            targetOwner,
            targetRepo,
            token,
            committer,
            forcePush = true,
            excludeBranches = [],
        } = params;

        // 1. List all branches from template repository
        const templateBranches = await this.githubService.listBranches(
            WEBSITE_TEMPLATE_CONFIG.owner,
            WEBSITE_TEMPLATE_CONFIG.repo,
            token,
        );

        this.logger.log(
            `Found ${templateBranches.length} branches in template repository to sync to ${targetOwner}/${targetRepo}`,
        );

        // 2. Filter out excluded branches
        const branchesToSync = templateBranches.filter((b) => !excludeBranches.includes(b.name));

        // 3. Sync branches with controlled parallelism
        const results: BranchSyncResult[] = [];

        for (let i = 0; i < branchesToSync.length; i += this.MAX_CONCURRENT_SYNCS) {
            const batch = branchesToSync.slice(i, i + this.MAX_CONCURRENT_SYNCS);

            const batchResults = await Promise.allSettled(
                batch.map((branch) =>
                    this.syncBranch({
                        branchName: branch.name,
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
                const branch = batch[j];

                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    results.push({
                        branch: branch.name,
                        status: 'error',
                        message: result.reason?.message || 'Unknown error',
                    });
                }
            }

            // Small delay between batches to avoid rate limiting
            if (i + this.MAX_CONCURRENT_SYNCS < branchesToSync.length) {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }

        const summary: BranchSyncSummary = {
            totalBranches: templateBranches.length,
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

    /**
     * Sync a single branch from template to target repository
     */
    async syncBranch(params: {
        branchName: string;
        targetOwner: string;
        targetRepo: string;
        token: string;
        committer: ICommitter;
        forcePush?: boolean;
    }): Promise<BranchSyncResult> {
        const { branchName, targetOwner, targetRepo, token, committer, forcePush = true } = params;

        this.logger.log(`Syncing branch '${branchName}' to ${targetOwner}/${targetRepo}`);

        let tempDir: string | null = null;

        try {
            // Use unique directory for each branch sync to avoid conflicts
            const uniqueRepoName = `${WEBSITE_TEMPLATE_CONFIG.repo}-sync-${branchName}-${Date.now()}`;

            // Clean up any existing directory
            await this.githubService.removeDir(WEBSITE_TEMPLATE_CONFIG.owner, uniqueRepoName);

            // Clone template repo at specific branch
            tempDir = await this.githubService.cloneOrPull({
                owner: WEBSITE_TEMPLATE_CONFIG.owner,
                repo: WEBSITE_TEMPLATE_CONFIG.repo,
                branch: branchName,
                token,
                committer: this.githubService.getCommitter(committer),
                autoSwitchToMainBranch: false,
            });

            // Switch to the specific branch
            await this.githubService.switchToBranch(tempDir, branchName);

            // Update remote to point to target repo
            const targetRepoUrl = this.githubService.getURL(targetOwner, targetRepo);
            await this.githubService.remoteRemove(tempDir, 'origin');
            await this.githubService.remoteAdd(tempDir, 'origin', targetRepoUrl);

            // Push to target repository
            await this.githubService.push(tempDir, token, forcePush);

            return {
                branch: branchName,
                status: 'synced',
                message: `Successfully synced branch '${branchName}'`,
            };
        } catch (error) {
            this.logger.error(`Failed to sync branch '${branchName}':`, error.message);

            return {
                branch: branchName,
                status: 'error',
                message: error.message,
            };
        } finally {
            // Cleanup temp directory
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }
}
