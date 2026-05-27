import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { Work } from '../entities/work.entity';
import { User } from '../entities/user.entity';
import { DataRepository, IDataConfig } from '../generators/data-generator/data-repository';
import { slugifyText } from '../utils/text.utils';
import { ScreenshotFacadeService } from '../facades/screenshot.facade';
import type { MutableItemData } from '@ever-works/contracts';
import {
    SubmitItemDto,
    SubmitItemResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    UpdateItemDto,
} from './dto';
import { format } from 'date-fns';
import { config as appConfig } from '../config';

@Injectable()
export class ItemSubmissionService {
    private readonly logger = new Logger(ItemSubmissionService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly screenshotFacade: ScreenshotFacadeService,
    ) {}

    /**
     * Submit a single item to a work's data repo.
     *
     * Credential / attribution split: the **work owner's** git
     * credentials clone+push (because the owner is the one who set up
     * the repo's auth and is guaranteed to be authorised), but the
     * **current user** is recorded as the git committer for attribution
     * (`work.resolveCommitter(user)`). This is what lets a public
     * submission from a non-owner end up in the data repo's history
     * with the submitter's name on it.
     *
     * Direct-commit vs PR mode:
     * - `submitItemDto.create_pull_request === true` always wins —
     *   forces a PR even if autoapproval or pay-to-publish would have
     *   allowed a direct commit.
     * - Otherwise, direct-commit fires when either
     *   `submitItemDto.pay_and_publish_now` is true OR the repo's
     *   `.works/works.yml` has `autoapproval: true`.
     * - In all other cases the change goes to a PR.
     */
    async submitItem(
        work: Work,
        user: User,
        submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        this.logger.debug(`Submitting item for work: ${work.slug}, item: ${submitItemDto.name}`);

        try {
            // Use work owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const workOwner = work.user as User;
            const committer = work.resolveCommitter(user);

            const repo = work.getDataRepo();
            const owner = work.getRepoOwner();

            // Clone or pull the data repository
            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            const data = await DataRepository.create(dest);

            // Get config to check autoapproval settings
            const config: IDataConfig | null = await data.getConfig().catch((error) => {
                this.logger.warn('Failed to get config, using defaults', error);
                return null;
            });

            // Determine if we should create a PR or commit directly to main
            // If create_pull_request is explicitly true, always create PR (no auto-merge)
            // If create_pull_request is false/undefined and (pay_and_publish_now OR autoapproval), commit directly
            const forceCreatePR = submitItemDto.create_pull_request === true;
            const shouldDirectCommit =
                !forceCreatePR &&
                (submitItemDto.pay_and_publish_now || (config && config.autoapproval === true));
            const shouldCreatePR = forceCreatePR || !shouldDirectCommit;

            this.logger.log(
                `Item submission mode: ${shouldDirectCommit ? 'direct commit to main' : 'create PR'}${forceCreatePR ? ' (forced by user)' : ''}`,
            );

            // Get main branch
            const provider = work.gitProvider;
            const defaultBranch = await this.gitFacade.getMainBranch(provider, dest);

            let branchName: string | null = null;
            if (shouldCreatePR) {
                // Create new branch for the item submission
                branchName = await this.gitFacade.switchBranch(
                    provider,
                    dest,
                    `item-${slugifyText(submitItemDto.name)}-${Date.now()}`,
                    true,
                );
                this.logger.log(`Created and switched to new branch: ${branchName}`);
            } else {
                // Switch to main branch for direct commit
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, dest, defaultBranch)
                        .catch((err) => {
                            this.logger.error('Failed to switch to main branch', err);
                            throw new Error('Failed to switch to main branch for direct commit');
                        });
                }
                this.logger.log(`Switched to main branch: ${defaultBranch}`);
            }

            // Prepare item data
            // Handle both category (string) and categories (array) for backward compatibility
            const category =
                submitItemDto.categories && submitItemDto.categories.length > 0
                    ? submitItemDto.categories
                    : submitItemDto.category;

            const itemData: MutableItemData = {
                name: submitItemDto.name,
                description: submitItemDto.description,
                source_url: submitItemDto.source_url,
                category,
                tags: submitItemDto.tags || [],
                featured: submitItemDto.featured || false,
                order: submitItemDto.order,
                slug: submitItemDto.slug || slugifyText(submitItemDto.name),
                brand: submitItemDto.brand,
                brand_logo_url: submitItemDto.brand_logo_url || null,
                images: submitItemDto.images || [],
                markdown: submitItemDto.markdown,
            };

            // Capture screenshot if source URL provided and no images yet
            if (submitItemDto.source_url && this.screenshotFacade.isAvailable()) {
                try {
                    const result = await this.screenshotFacade.capture(
                        {
                            url: submitItemDto.source_url,
                            blockAds: true,
                            blockCookieBanners: true,
                            cache: true,
                        },
                        {
                            userId: workOwner.id,
                            workId: work.id,
                        },
                    );

                    if (result.success && result.cacheUrl) {
                        if (!itemData.images.includes(result.cacheUrl)) {
                            itemData.images = [result.cacheUrl, ...itemData.images];
                            this.logger.debug(
                                `Captured screenshot for item: ${submitItemDto.name}`,
                            );
                        }
                    }
                } catch (error) {
                    this.logger.warn(
                        `Failed to capture screenshot for ${submitItemDto.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
                    );
                }
            }

            // TODO: Badge processing and markdown generation should use pipeline step executors
            // For now, proceed without badges/markdown (user-submitted items don't need AI enhancement)
            const itemWithMarkdown = { ...itemData };

            // Ensure slug is set
            itemWithMarkdown.slug = slugifyText(itemWithMarkdown.slug || itemWithMarkdown.name);

            // Create item work and write files
            await data.createItemDir(itemWithMarkdown);
            await data.writeItem(itemWithMarkdown);

            // Write item markdown
            const markdown =
                itemWithMarkdown.markdown ||
                `# ${itemWithMarkdown.name}\n\n${itemWithMarkdown.description}\n\n[${itemWithMarkdown.source_url}](${itemWithMarkdown.source_url})`;
            await data.writeItemMarkdown(itemWithMarkdown, markdown);

            // Commit changes
            await this.gitFacade.add(provider, dest, '.');
            await this.gitFacade.commit(
                provider,
                dest,
                `Add ${itemWithMarkdown.name}`,
                work.resolveCommitter(user),
            );

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            // If direct commit, return success without PR
            if (!shouldCreatePR) {
                this.logger.log(
                    `Item "${itemWithMarkdown.name}" committed directly to main branch`,
                );
                return {
                    status: 'success',
                    slug: work.slug,
                    item_name: itemWithMarkdown.name,
                    item_slug: itemWithMarkdown.slug,
                    message: `Item "${itemWithMarkdown.name}" has been successfully added and published (committed directly to ${defaultBranch}).`,
                    direct_commit: true,
                    item: itemWithMarkdown,
                };
            }

            // Create PR
            const prTitle = `Add ${itemWithMarkdown.name} - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;

            // Build badge information for PR body
            let badgeInfo = '';
            if (itemWithMarkdown.badges && Object.keys(itemWithMarkdown.badges).length > 0) {
                badgeInfo = '\n**Badges:**\n';
                if (itemWithMarkdown.badges.security) {
                    badgeInfo += `- Security: ${itemWithMarkdown.badges.security.value} ${itemWithMarkdown.badges.security.details ? `(${itemWithMarkdown.badges.security.details})` : ''}\n`;
                }
                if (itemWithMarkdown.badges.license) {
                    badgeInfo += `- License: ${itemWithMarkdown.badges.license.value} ${itemWithMarkdown.badges.license.details ? `(${itemWithMarkdown.badges.license.details})` : ''}\n`;
                }
                if (itemWithMarkdown.badges.quality) {
                    badgeInfo += `- Quality: ${itemWithMarkdown.badges.quality.value} ${itemWithMarkdown.badges.quality.details ? `(${itemWithMarkdown.badges.quality.details})` : ''}\n`;
                }
            }

            const prBody =
                `Add new item: ${itemWithMarkdown.name}\n\n` +
                `**Description:** ${itemWithMarkdown.description}\n` +
                `**Source URL:** ${itemWithMarkdown.source_url}\n` +
                `**Category:** ${itemWithMarkdown.category}\n` +
                (itemWithMarkdown.brand ? `**Brand:** ${itemWithMarkdown.brand}\n` : '') +
                (itemWithMarkdown.brand_logo_url
                    ? `**Brand Logo:** ${itemWithMarkdown.brand_logo_url}\n`
                    : '') +
                `**Tags:** ${Array.isArray(itemWithMarkdown.tags) ? itemWithMarkdown.tags.join(', ') : ''}${badgeInfo}\n\n` +
                `Generated by [${appConfig.branding.getAppName()}](${appConfig.branding.getPlatformWebsite()})`;

            const pr = await this.gitFacade.createPullRequest(
                {
                    owner,
                    repo,
                    head: branchName!,
                    base: defaultBranch!,
                    title: prTitle,
                    body: prBody,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            this.logger.log(`PR #${pr.number} created for item "${itemWithMarkdown.name}"`);

            return {
                status: 'success',
                slug: work.slug,
                item_name: itemWithMarkdown.name,
                item_slug: itemWithMarkdown.slug,
                message: `Item "${itemWithMarkdown.name}" has been submitted for review. PR #${pr.number} created.`,
                pr_number: pr.number,
                pr_url: pr.url,
                pr_title: prTitle,
                pr_body: prBody,
                pr_branch_name: branchName!,
                auto_merged: false,
                item: itemWithMarkdown, // Return the created item for client-side list update
            };
        } catch (error) {
            this.logger.error('Failed to submit item', error);
            return {
                status: 'error',
                slug: work.slug,
                item_name: submitItemDto.name,
                message: error.message,
            };
        }
    }

    async removeItem(
        work: Work,
        user: User,
        removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        this.logger.debug(
            `Removing item for work: ${work.slug}, item slug: ${removeItemDto.item_slug}`,
        );

        try {
            // Use work owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const workOwner = work.user as User;
            const committer = work.resolveCommitter(user);

            const repo = work.getDataRepo();
            const owner = work.getRepoOwner();

            // Clone or pull the data repository
            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            const data = await DataRepository.create(dest);

            // Check if item exists
            const itemExists = await data.itemExists(removeItemDto.item_slug);
            if (!itemExists) {
                return {
                    status: 'error',
                    slug: work.slug,
                    item_name: 'Unknown',
                    item_slug: removeItemDto.item_slug,
                    message: `Item with slug '${removeItemDto.item_slug}' not found`,
                };
            }

            // Get item details before removal for response
            const itemData = await data.getItem(removeItemDto.item_slug);

            if (!itemData) {
                return {
                    status: 'error',
                    slug: work.slug,
                    item_name: 'Unknown',
                    item_slug: removeItemDto.item_slug,
                    message: `Failed to retrieve item details for '${removeItemDto.item_slug}'`,
                };
            }

            const shouldCreatePR = removeItemDto.create_pull_request === true;
            const provider = work.gitProvider;
            const defaultBranch = await this.gitFacade.getMainBranch(provider, dest);

            let branchName: string | null = null;
            if (shouldCreatePR) {
                branchName = await this.gitFacade.switchBranch(
                    provider,
                    dest,
                    `remove-${removeItemDto.item_slug}-${Date.now()}`,
                    true,
                );
                this.logger.log(`Created and switched to new branch: ${branchName}`);
            } else if (defaultBranch) {
                await this.gitFacade.switchBranch(provider, dest, defaultBranch).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });
            }

            // Remove the item
            const removed = await data.removeItem(removeItemDto.item_slug);
            if (!removed) {
                return {
                    status: 'error',
                    slug: work.slug,
                    item_name: itemData.name,
                    item_slug: removeItemDto.item_slug,
                    message: `Failed to remove item '${removeItemDto.item_slug}'`,
                };
            }

            // Commit changes
            await this.gitFacade.addAll(provider, dest);
            const commitMessage = removeItemDto.reason
                ? `Remove ${itemData.name} - ${removeItemDto.reason}`
                : `Remove ${itemData.name}`;
            await this.gitFacade.commit(provider, dest, commitMessage, work.resolveCommitter(user));

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            if (shouldCreatePR && branchName && defaultBranch) {
                const prTitle = `Remove ${itemData.name} - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
                const prBody =
                    `Remove item: ${itemData.name}\n\n` +
                    `**Item Slug:** ${removeItemDto.item_slug}\n` +
                    `**Source URL:** ${itemData.source_url}\n` +
                    `**Category:** ${itemData.category}\n` +
                    (removeItemDto.reason ? `**Reason:** ${removeItemDto.reason}\n` : '') +
                    `\nGenerated by [${appConfig.branding.getAppName()}](${appConfig.branding.getPlatformWebsite()})`;

                const pr = await this.gitFacade.createPullRequest(
                    {
                        owner,
                        repo,
                        head: branchName,
                        base: defaultBranch,
                        title: prTitle,
                        body: prBody,
                    },
                    {
                        userId: workOwner.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    },
                );

                return {
                    status: 'success',
                    slug: work.slug,
                    item_name: itemData.name,
                    item_slug: removeItemDto.item_slug,
                    message: `Item "${itemData.name}" removal has been submitted for review. PR #${pr.number} created.`,
                    pr_number: pr.number,
                    pr_url: pr.url,
                    pr_branch_name: branchName,
                    pr_title: prTitle,
                    pr_body: prBody,
                };
            }

            return {
                status: 'success',
                slug: work.slug,
                item_name: itemData.name,
                item_slug: removeItemDto.item_slug,
                message: `Item "${itemData.name}" removed successfully.`,
            };
        } catch (error) {
            this.logger.error('Failed to remove item', error);
            return {
                status: 'error',
                slug: work.slug,
                item_name: 'Unknown',
                item_slug: removeItemDto.item_slug,
                message: error.message,
            };
        }
    }

    async updateItem(
        work: Work,
        user: User,
        updateItemDto: UpdateItemDto,
    ): Promise<SubmitItemResponseDto> {
        this.logger.debug(
            `Updating item metadata for work: ${work.slug}, item slug: ${updateItemDto.item_slug}`,
        );

        try {
            // Use work owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const workOwner = work.user as User;
            const committer = work.resolveCommitter(user);

            const repo = work.getDataRepo();
            const owner = work.getRepoOwner();

            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            const data = await DataRepository.create(dest);

            const existingItem = await data.getItem(updateItemDto.item_slug).catch(() => null);
            if (!existingItem) {
                return {
                    status: 'error',
                    slug: work.slug,
                    item_name: 'Unknown',
                    item_slug: updateItemDto.item_slug,
                    message: `Item with slug '${updateItemDto.item_slug}' not found`,
                };
            }

            const provider = work.gitProvider;
            const defaultBranch = await this.gitFacade.getMainBranch(provider, dest);
            const shouldCreatePR = updateItemDto.create_pull_request === true;

            let branchName: string | null = null;
            if (shouldCreatePR) {
                branchName = await this.gitFacade.switchBranch(
                    provider,
                    dest,
                    `update-${updateItemDto.item_slug}-${Date.now()}`,
                    true,
                );
                this.logger.log(`Created and switched to new branch: ${branchName}`);
            } else if (defaultBranch) {
                await this.gitFacade.switchBranch(provider, dest, defaultBranch).catch((err) => {
                    this.logger.error('Failed to switch to main branch', err);
                    return null;
                });
            }

            const sourceUrlChanged =
                updateItemDto.source_url !== undefined &&
                updateItemDto.source_url !== existingItem.source_url;

            // Use `typeof === 'string'` (not `!== undefined`) so a client
            // sending `"markdown": null` does NOT slip into the write branch
            // — `class-validator`'s `@IsOptional()` short-circuits on null,
            // so the DTO accepts it, but `fs.writeFile(path, null)` would
            // throw downstream. Codex P1 on PR #786.
            const markdownChanged =
                typeof updateItemDto.markdown === 'string' &&
                updateItemDto.markdown !== existingItem.markdown;

            const itemUpdates: {
                featured?: boolean;
                order?: number;
                source_url?: string;
                health?: { status: 'unchecked' };
                source_validation?: undefined;
                markdown?: string;
            } = {};

            if (updateItemDto.featured !== undefined) {
                itemUpdates.featured = updateItemDto.featured;
            }

            if (updateItemDto.order !== undefined && updateItemDto.order !== null) {
                itemUpdates.order = updateItemDto.order;
            }

            if (updateItemDto.source_url !== undefined) {
                itemUpdates.source_url = updateItemDto.source_url;
            }

            if (sourceUrlChanged) {
                itemUpdates.health = { status: 'unchecked' };
                itemUpdates.source_validation = undefined;
            }

            if (markdownChanged) {
                itemUpdates.markdown = updateItemDto.markdown;
            }

            const updatedItem = await data.updateItemMetadata(updateItemDto.item_slug, itemUpdates);

            if (!updatedItem) {
                return {
                    status: 'error',
                    slug: work.slug,
                    item_name: 'Unknown',
                    item_slug: updateItemDto.item_slug,
                    message: `Failed to update item '${updateItemDto.item_slug}'`,
                };
            }

            // The site renders from `data/<slug>/<slug>.md` (the YAML `markdown`
            // field is only a fallback). Keep both channels in sync when the
            // body changes so the next site generation picks up the edit.
            if (markdownChanged) {
                // `markdownChanged` is a `typeof === 'string'` check, so the
                // non-null assertion is provably safe here (null is excluded).
                await data.writeItemMarkdown(updatedItem, updateItemDto.markdown!);
            }

            await this.gitFacade.addAll(provider, dest);
            const commitMessage = markdownChanged
                ? `Update ${updatedItem.name} content`
                : sourceUrlChanged
                  ? `Update ${updatedItem.name} source`
                  : `Update ${updatedItem.name} metadata`;
            await this.gitFacade.commit(provider, dest, commitMessage, work.resolveCommitter(user));
            await this.gitFacade.push(
                { dir: dest },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            if (shouldCreatePR && branchName && defaultBranch) {
                const prKind = markdownChanged
                    ? 'Update content for'
                    : sourceUrlChanged
                      ? 'Update source for'
                      : 'Update';
                const prTitle = `${prKind} ${updatedItem.name} - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
                const prBodyKind = markdownChanged
                    ? 'Update item content'
                    : sourceUrlChanged
                      ? 'Update item source'
                      : 'Update item metadata';
                const prBody =
                    `${prBodyKind}: ${updatedItem.name}\n\n` +
                    `**Item Slug:** ${updateItemDto.item_slug}\n` +
                    `**Featured:** ${String(!!updatedItem.featured)}\n` +
                    `**Order:** ${updatedItem.order ?? 'n/a'}\n` +
                    `**Source URL:** ${updatedItem.source_url}\n` +
                    (markdownChanged ? `**Content:** Updated (see diff)\n` : '') +
                    `\nGenerated by [${appConfig.branding.getAppName()}](${appConfig.branding.getPlatformWebsite()})`;

                const pr = await this.gitFacade.createPullRequest(
                    {
                        owner,
                        repo,
                        head: branchName,
                        base: defaultBranch,
                        title: prTitle,
                        body: prBody,
                    },
                    {
                        userId: workOwner.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    },
                );

                return {
                    status: 'success',
                    slug: work.slug,
                    item_name: updatedItem.name,
                    item_slug: updateItemDto.item_slug,
                    message: markdownChanged
                        ? `Item "${updatedItem.name}" content update submitted. PR #${pr.number} created.`
                        : sourceUrlChanged
                          ? `Item "${updatedItem.name}" source update submitted. PR #${pr.number} created.`
                          : `Item "${updatedItem.name}" metadata update submitted. PR #${pr.number} created.`,
                    pr_number: pr.number,
                    pr_url: pr.url,
                    pr_branch_name: branchName,
                    pr_title: prTitle,
                    pr_body: prBody,
                };
            }

            return {
                status: 'success',
                slug: work.slug,
                item_name: updatedItem.name,
                item_slug: updateItemDto.item_slug,
                message: markdownChanged
                    ? `Item "${updatedItem.name}" content updated.`
                    : sourceUrlChanged
                      ? `Item "${updatedItem.name}" source updated.`
                      : `Item "${updatedItem.name}" metadata updated.`,
            };
        } catch (error) {
            this.logger.error('Failed to update item metadata', error);
            return {
                status: 'error',
                slug: work.slug,
                item_name: 'Unknown',
                item_slug: updateItemDto.item_slug,
                message: error.message,
            };
        }
    }
}
