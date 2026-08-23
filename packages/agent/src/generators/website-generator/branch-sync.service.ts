import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { WebsiteTemplateConfig } from './config/website-template.config';
import { getWorkOwner } from '../../utils/work.utils';
import type { GitCommitter } from '@ever-works/plugin';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import * as fs from 'node:fs/promises';
import { WebsiteTemplateResolverService } from './website-template-resolver.service';

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

// Security: `template.syncBranches` / `template.betaBranch` originate from the
// operator-managed `templates` DB row (persisted as a `simple-json` text column
// and deserialized without re-validation). They flow unvalidated into git ref
// operations here — `cloneOrPull({ branch })`, `renameBranch`, and as
// branch-mapping keys/targets. A ref that begins with `-` or smuggles a git
// protocol switch (e.g. `--upload-pack=...`) is a known argument-/protocol-
// injection vector for any downstream git invocation. Restrict refs to the
// conservative character set real branch names use and forbid a leading dash or
// slash so a malicious/corrupt catalog row cannot inject an option. Legitimate
// branches (`main`, `stage`, `develop`, `feature/x`, configured beta branches)
// are unaffected.
const SAFE_GIT_BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function isSafeGitBranchName(name: unknown): name is string {
    return (
        typeof name === 'string' &&
        name.length > 0 &&
        name.length <= 255 &&
        SAFE_GIT_BRANCH_NAME.test(name)
    );
}

/**
 * Pulls upstream template branches into each Work's own website repo so
 * the operator's customisations stay rebased against the latest template
 * code (and any beta branch overrides, when `Work.websiteTemplateUseBeta`
 * is set).
 *
 * **Every branch is cloned into a directory of its own** via
 * `gitFacade.cloneBranch`. `cloneOrPull` cannot be used here: its working
 * directory is keyed on owner+repo (not on branch) AND it switches the
 * checkout back to the default branch, so syncing `['main','stage',
 * 'develop']` from one template resolved to the same `main` checkout three
 * times and pushed `main` three times — while reporting three successes.
 * See the verification guard in `syncBranch` for why that stayed invisible.
 *
 * `MAX_CONCURRENT_SYNCS = 1` is retained: per-branch directories mean it is
 * no longer required for correctness, but sequential syncing keeps the
 * provider API call rate and the pure-JS git CPU cost predictable. Raising
 * it is a separate, measured change.
 *
 * Return shape: `BranchSyncSummary` (or `null` when there's no template
 * resolved for the work). Each branch's outcome is one of `synced` /
 * `skipped` / `error`; the summary's `errors` count drives the calling
 * service's "did the deploy refresh succeed" gate — so a branch whose push
 * cannot be VERIFIED to have landed is reported as `error`, never `synced`.
 */
@Injectable()
export class BranchSyncService {
    private readonly logger = new Logger(BranchSyncService.name);

    // Kept at 1 deliberately. `cloneBranch` gives each branch its own dir,
    // so this is no longer load-bearing for correctness — it now just keeps
    // provider API calls and pure-JS git work sequential.
    private readonly MAX_CONCURRENT_SYNCS = 1;

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly websiteTemplateResolver: WebsiteTemplateResolverService,
    ) {}

    async syncFromTemplate(
        work: Work,
        user: User,
        cleanupExtraBranches = false,
    ): Promise<BranchSyncSummary | null> {
        const workOwner = getWorkOwner(work);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);

        // Security: validate the DB-sourced beta branch before it becomes a
        // git ref / mapping key. An unsafe value is dropped (no beta mapping),
        // matching the "no beta branch configured" path rather than feeding a
        // malformed ref into cloneOrPull.
        const useBetaBranch =
            work.websiteTemplateUseBeta &&
            template.betaBranch &&
            isSafeGitBranchName(template.betaBranch);
        if (work.websiteTemplateUseBeta && template.betaBranch && !useBetaBranch) {
            this.logger.warn(
                `Ignoring beta branch with unsafe name for ${websiteOwner}/${websiteRepo}`,
            );
        }
        const branchMapping = useBetaBranch
            ? { [template.betaBranch as string]: 'main' }
            : undefined;

        this.logger.log(
            `Syncing all branches from template to ${websiteOwner}/${websiteRepo}` +
                (branchMapping ? ` (beta: ${Object.keys(branchMapping)[0]}→main)` : ''),
        );

        try {
            const result = await this.syncAllBranches({
                targetOwner: websiteOwner,
                targetRepo: websiteRepo,
                userId: workOwner.id,
                committer: work.resolveCommitter(user),
                forcePush: true,
                branchMapping,
                template,
                providerId: work.gitProvider,
                workId: work.id,
                cleanupExtraBranches,
            });

            this.logger.log(
                `Branch sync completed: ${result.synced} synced, ${result.errors} errors`,
            );

            return result;
        } catch (error) {
            this.logger.error(`Failed to sync branches from template: ${error.message}`);
            return null;
        }
    }

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
        template: WebsiteTemplateConfig;
        providerId?: string;
        workId?: string;
        /** Delete target branches not in syncBranches; needed after CREATE_USING_TEMPLATE copies all template branches */
        cleanupExtraBranches?: boolean;
    }): Promise<BranchSyncSummary> {
        const {
            targetOwner,
            targetRepo,
            userId,
            committer,
            forcePush = true,
            branchMapping = {},
            template,
            providerId,
            workId,
            cleanupExtraBranches = false,
        } = params;

        const branchesToSync = [...template.syncBranches];
        const mappedTargets = Object.values(branchMapping);

        this.logger.log(
            `Syncing branches [${branchesToSync.join(', ')}] to ${targetOwner}/${targetRepo}`,
        );

        // Build sync operations
        const syncOperations: Array<{ branchName: string; targetBranch: string }> = [];
        // Security: branches rejected by ref-name validation are reported as
        // errors (not silently dropped) so the summary's `errors` count — which
        // gates the caller's "did the deploy refresh succeed" check — reflects
        // the rejection rather than reporting a clean success.
        const rejectedResults: BranchSyncResult[] = [];

        for (const branchName of branchesToSync) {
            // Security: never feed an unsafe ref name into git operations.
            if (!isSafeGitBranchName(branchName)) {
                this.logger.warn(
                    `Skipping branch with unsafe name in template.syncBranches for ${targetOwner}/${targetRepo}`,
                );
                rejectedResults.push({
                    branch: String(branchName),
                    status: 'error',
                    message: 'Branch name rejected: contains unsafe characters',
                });
                continue;
            }

            // Skip if this branch would be overwritten by a mapped branch
            if (mappedTargets.includes(branchName) && !branchMapping[branchName]) {
                this.logger.log(`Skipping '${branchName}' - will be overwritten by mapped branch`);
                continue;
            }

            syncOperations.push({ branchName, targetBranch: branchName });

            // If mapped, also sync to the mapped target
            const mappedTarget = branchMapping[branchName];
            // Security: the mapped target also becomes a git ref (renameBranch);
            // reject an unsafe mapping target instead of syncing to it.
            if (mappedTarget && mappedTarget !== branchName && !isSafeGitBranchName(mappedTarget)) {
                this.logger.warn(
                    `Skipping unsafe branch-mapping target for '${branchName}' in ${targetOwner}/${targetRepo}`,
                );
                rejectedResults.push({
                    branch: branchName,
                    status: 'error',
                    message: 'Branch mapping target rejected: contains unsafe characters',
                });
            } else if (mappedTarget && mappedTarget !== branchName) {
                syncOperations.push({ branchName, targetBranch: mappedTarget });
                this.logger.log(`Branch '${branchName}' will also sync to '${mappedTarget}'`);
            }
        }

        // Sync with controlled parallelism.
        // Security: seed with any ref-name rejections so they're counted in the
        // summary's `errors` total alongside genuine sync failures.
        const results: BranchSyncResult[] = [...rejectedResults];

        for (let i = 0; i < syncOperations.length; i += this.MAX_CONCURRENT_SYNCS) {
            const batch = syncOperations.slice(i, i + this.MAX_CONCURRENT_SYNCS);

            const batchResults = await Promise.allSettled(
                batch.map((op) =>
                    this.syncBranch({
                        branchName: op.branchName,
                        targetBranch: op.targetBranch,
                        targetOwner,
                        targetRepo,
                        template,
                        userId,
                        committer,
                        forcePush,
                        providerId,
                        workId,
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

        if (cleanupExtraBranches) {
            await this.deleteExtraBranches({
                targetOwner,
                targetRepo,
                userId,
                providerId,
                template,
            });
        }

        return summary;
    }

    private async deleteExtraBranches(params: {
        targetOwner: string;
        targetRepo: string;
        userId: string;
        providerId?: string;
        template: WebsiteTemplateConfig;
    }): Promise<void> {
        const { targetOwner, targetRepo, userId, providerId, template } = params;
        const allowed = new Set<string>(template.syncBranches);

        let remoteBranches: { name: string }[];
        try {
            remoteBranches = await this.gitFacade.listBranches(targetOwner, targetRepo, {
                userId,
                providerId,
            });
        } catch (error) {
            this.logger.warn(`Could not list branches for cleanup: ${error.message}`);
            return;
        }

        for (const branch of remoteBranches) {
            if (!allowed.has(branch.name)) {
                this.logger.log(
                    `Deleting extra branch '${branch.name}' from ${targetOwner}/${targetRepo}`,
                );
                await this.gitFacade
                    .deleteBranch(targetOwner, targetRepo, branch.name, { userId, providerId })
                    .catch((err) => {
                        this.logger.warn(
                            `Failed to delete extra branch '${branch.name}': ${err.message}`,
                        );
                    });
            }
        }
    }

    /** Sync a single branch from template to target repository */
    async syncBranch(params: {
        branchName: string;
        targetBranch?: string;
        targetOwner: string;
        targetRepo: string;
        template: WebsiteTemplateConfig;
        userId: string;
        /**
         * Kept on the signature so existing callers are unaffected. It is no
         * longer read here: the sync is a fresh single-branch clone followed
         * by a push, which never authors a merge commit.
         */
        committer: GitCommitter;
        forcePush?: boolean;
        providerId?: string;
        workId?: string;
    }): Promise<BranchSyncResult> {
        const {
            branchName,
            targetBranch = branchName,
            targetOwner,
            targetRepo,
            template,
            userId,
            forcePush = true,
            providerId,
            workId,
        } = params;

        const mappingInfo = targetBranch !== branchName ? ` (mapped to '${targetBranch}')` : '';
        this.logger.log(
            `Syncing branch '${branchName}'${mappingInfo} to ${targetOwner}/${targetRepo}`,
        );

        let tempDir: string | null = null;

        try {
            // The sha the target branch has to end up at. Read BEFORE the
            // clone: if the template moves mid-run the guard below fires
            // (loud, one branch) instead of comparing the new head against
            // itself and rubber-stamping whatever happened.
            const expectedSha = await this.resolveRemoteBranchSha(
                template.owner,
                template.repo,
                branchName,
                { userId, providerId },
            );
            if (!expectedSha) {
                return {
                    branch: branchName,
                    status: 'error',
                    message: `Template branch '${branchName}' not found on ${template.owner}/${template.repo}; nothing to sync`,
                };
            }

            // Clone the template branch into a directory of its own.
            // NOT cloneOrPull: that keys its dir on owner+repo only and
            // switches the checkout back to the default branch, so every
            // branch of one template collapsed onto the same main checkout.
            tempDir = await this.gitFacade.cloneBranch(
                {
                    owner: template.owner,
                    repo: template.repo,
                    branch: branchName,
                },
                { userId, providerId, workId },
            );

            // Rename branch if needed
            if (targetBranch !== branchName) {
                await this.gitFacade.renameBranch(providerId, tempDir, branchName, targetBranch);
            }

            // Update remote to point to target repo
            const targetRepoUrl = this.gitFacade.getCloneUrl(providerId, targetOwner, targetRepo);
            await this.gitFacade.replaceRemote(providerId, tempDir, 'origin', targetRepoUrl);

            // Push to target. `ref`/`remoteRef` are explicit on purpose:
            // without them the push follows HEAD and whatever
            // `branch.<name>.merge` the clone left in the config, which is
            // exactly how a 'develop' sync used to land on 'main'.
            await this.gitFacade.push(
                {
                    dir: tempDir,
                    force: forcePush,
                    ref: targetBranch,
                    remoteRef: targetBranch,
                },
                { userId, providerId, workId },
            );

            // Verification guard. A push that resolves without throwing is
            // NOT proof the remote branch moved — it is proof the transport
            // did not error. Read the ref back and compare; a mismatch (or
            // a branch that still doesn't exist) is an `error`, so the
            // caller's `errors` gate can see it. Without this, the next
            // regression in the git layer is silent all over again.
            const actualSha = await this.resolveRemoteBranchSha(
                targetOwner,
                targetRepo,
                targetBranch,
                { userId, providerId },
            );
            if (actualSha !== expectedSha) {
                const message =
                    `Push reported success but ${targetOwner}/${targetRepo}@${targetBranch} is at ` +
                    `${actualSha ?? '(branch missing)'}, expected ${expectedSha}`;
                this.logger.error(message);
                return { branch: branchName, status: 'error', message };
            }

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

    /**
     * Head sha of `branch` on `owner/repo`, straight from the provider API,
     * or `null` when the repo has no such branch.
     *
     * Uses `listBranches` on purpose. It is a REQUIRED capability, whereas
     * `getLatestCommit` is optional and the facade answers `null` for a
     * provider that lacks it — a verification guard built on that would
     * quietly degrade into a no-op, which is the failure mode this whole
     * change exists to remove. Errors are deliberately NOT swallowed: an
     * unverifiable sync must surface as `error`, not as success.
     */
    private async resolveRemoteBranchSha(
        owner: string,
        repo: string,
        branch: string,
        options: { userId: string; providerId?: string },
    ): Promise<string | null> {
        const branches = await this.gitFacade.listBranches(owner, repo, {
            userId: options.userId,
            providerId: options.providerId,
        });
        const match = branches.find((b) => b.name === branch);
        return match?.commit ? match.commit.toLowerCase() : null;
    }
}
