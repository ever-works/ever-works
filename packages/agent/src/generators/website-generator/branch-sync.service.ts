import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { WEBSITE_TEMPLATE_CONFIG } from './config/website-template.config';
import type { GitCommitter } from '@ever-works/plugin';
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

    // Syncs must run sequentially: cloneOrPull uses a deterministic dir
    // based on owner+repo (not branch), so parallel syncs corrupt each other.
    private readonly MAX_CONCURRENT_SYNCS = 1;

    constructor(private readonly gitFacade: GitFacadeService) {}

    /**
     * Sync branches from template repository to target repository
     * @param params.branchMapping - Optional mapping to also push source branch to different target (e.g., { 'stage': 'main' })
     * @param params.providerId - Git provider to use (e.g., 'github', 'gitlab')
     */
    async syncAllBranches(params: {
        targetOwner: string;
        targetRepo: string;
        userId: string;
        committer: GitCommitter;
        forcePush?: boolean;
        branchMapping?: { [sourceBranch: string]: string };
        providerId?: string;
    }): Promise<BranchSyncSummary> {
        const {
            targetOwner,
            targetRepo,
            userId,
            committer,
            forcePush = true,
            branchMapping = {},
            providerId,
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
                        userId,
                        committer,
                        forcePush,
                        providerId,
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
        userId: string;
        committer: GitCommitter;
        forcePush?: boolean;
        providerId?: string;
    }): Promise<BranchSyncResult> {
        const {
            branchName,
            targetBranch = branchName,
            targetOwner,
            targetRepo,
            userId,
            committer,
            forcePush = true,
            providerId,
        } = params;

        const mappingInfo = targetBranch !== branchName ? ` (mapped to '${targetBranch}')` : '';
        this.logger.log(
            `Syncing branch '${branchName}'${mappingInfo} to ${targetOwner}/${targetRepo}`,
        );

        let tempDir: string | null = null;

        try {
            // Clone template branch
            tempDir = await this.gitFacade.cloneOrPull(
                {
                    owner: WEBSITE_TEMPLATE_CONFIG.owner,
                    repo: WEBSITE_TEMPLATE_CONFIG.repo,
                    branch: branchName,
                    committer,
                },
                { userId, providerId },
            );

            // Rename branch if needed
            if (targetBranch !== branchName) {
                await this.renameBranch(tempDir, branchName, targetBranch);
            }

            // Update remote to point to target repo
            const targetRepoUrl = this.gitFacade.getCloneUrl(providerId, targetOwner, targetRepo);
            await this.updateRemote(tempDir, targetRepoUrl);

            // Push to target
            await this.gitFacade.push({ dir: tempDir, force: forcePush }, { userId, providerId });

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

    private async renameBranch(dir: string, oldName: string, newName: string): Promise<void> {
        const git = await import('isomorphic-git');
        const nodeFs = await import('node:fs');

        await git.renameBranch({
            fs: nodeFs.default,
            dir,
            oldref: oldName,
            ref: newName,
            checkout: true,
        });
    }

    private async updateRemote(dir: string, newRemoteUrl: string): Promise<void> {
        const git = await import('isomorphic-git');
        const nodeFs = await import('node:fs');

        try {
            await git.deleteRemote({ fs: nodeFs.default, dir, remote: 'origin' });
        } catch {
            // Remote might not exist
        }

        await git.addRemote({ fs: nodeFs.default, dir, remote: 'origin', url: newRemoteUrl });
    }
}
