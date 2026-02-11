import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { Directory } from '../entities/directory.entity';
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

    async submitItem(
        directory: Directory,
        user: User,
        submitItemDto: SubmitItemDto,
    ): Promise<SubmitItemResponseDto> {
        this.logger.debug(
            `Submitting item for directory: ${directory.slug}, item: ${submitItemDto.name}`,
        );

        try {
            // Use directory owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const directoryOwner = directory.user as User;
            const committer = user.asCommitter();

            const repo = directory.getDataRepo();
            const owner = directory.getRepoOwner();

            // Clone or pull the data repository
            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
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
            const provider = directory.gitProvider;
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
                            userId: directoryOwner.id,
                            directoryId: directory.id,
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

            // Create item directory and write files
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
                user.asCommitter(),
            );

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            // If direct commit, return success without PR
            if (!shouldCreatePR) {
                this.logger.log(
                    `Item "${itemWithMarkdown.name}" committed directly to main branch`,
                );
                return {
                    status: 'success',
                    slug: directory.slug,
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
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            this.logger.log(`PR #${pr.number} created for item "${itemWithMarkdown.name}"`);

            return {
                status: 'success',
                slug: directory.slug,
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
                slug: directory.slug,
                item_name: submitItemDto.name,
                message: error.message,
            };
        }
    }

    async removeItem(
        directory: Directory,
        user: User,
        removeItemDto: RemoveItemDto,
    ): Promise<RemoveItemResponseDto> {
        this.logger.debug(
            `Removing item for directory: ${directory.slug}, item slug: ${removeItemDto.item_slug}`,
        );

        try {
            // Use directory owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const directoryOwner = directory.user as User;
            const committer = user.asCommitter();

            const repo = directory.getDataRepo();
            const owner = directory.getRepoOwner();

            // Clone or pull the data repository
            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            const data = await DataRepository.create(dest);

            // Check if item exists
            const itemExists = await data.itemExists(removeItemDto.item_slug);
            if (!itemExists) {
                return {
                    status: 'error',
                    slug: directory.slug,
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
                    slug: directory.slug,
                    item_name: 'Unknown',
                    item_slug: removeItemDto.item_slug,
                    message: `Failed to retrieve item details for '${removeItemDto.item_slug}'`,
                };
            }

            const shouldCreatePR = removeItemDto.create_pull_request === true;
            const provider = directory.gitProvider;
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
                    slug: directory.slug,
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
            await this.gitFacade.commit(provider, dest, commitMessage, user.asCommitter());

            // Push changes
            await this.gitFacade.push(
                { dir: dest },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
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
                    { userId: directoryOwner.id, providerId: directory.gitProvider },
                );

                return {
                    status: 'success',
                    slug: directory.slug,
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
                slug: directory.slug,
                item_name: itemData.name,
                item_slug: removeItemDto.item_slug,
                message: `Item "${itemData.name}" removed successfully.`,
            };
        } catch (error) {
            this.logger.error('Failed to remove item', error);
            return {
                status: 'error',
                slug: directory.slug,
                item_name: 'Unknown',
                item_slug: removeItemDto.item_slug,
                message: error.message,
            };
        }
    }

    async updateItem(
        directory: Directory,
        user: User,
        updateItemDto: UpdateItemDto,
    ): Promise<SubmitItemResponseDto> {
        this.logger.debug(
            `Updating item metadata for directory: ${directory.slug}, item slug: ${updateItemDto.item_slug}`,
        );

        try {
            // Use directory owner's credentials (they set up the repos)
            // but use current user as committer for attribution
            const directoryOwner = directory.user as User;
            const committer = user.asCommitter();

            const repo = directory.getDataRepo();
            const owner = directory.getRepoOwner();

            const dest = await this.gitFacade.cloneOrPull(
                {
                    owner,
                    repo,
                    committer,
                },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            const data = await DataRepository.create(dest);

            const itemExists = await data.itemExists(updateItemDto.item_slug);
            if (!itemExists) {
                return {
                    status: 'error',
                    slug: directory.slug,
                    item_name: 'Unknown',
                    item_slug: updateItemDto.item_slug,
                    message: `Item with slug '${updateItemDto.item_slug}' not found`,
                };
            }

            const provider = directory.gitProvider;
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

            const updatedItem = await data.updateItemMetadata(updateItemDto.item_slug, {
                featured: updateItemDto.featured,
                order:
                    updateItemDto.order !== undefined && updateItemDto.order !== null
                        ? updateItemDto.order
                        : undefined,
            });

            if (!updatedItem) {
                return {
                    status: 'error',
                    slug: directory.slug,
                    item_name: 'Unknown',
                    item_slug: updateItemDto.item_slug,
                    message: `Failed to update item '${updateItemDto.item_slug}'`,
                };
            }

            await this.gitFacade.addAll(provider, dest);
            const commitMessage = `Update ${updatedItem.name} metadata`;
            await this.gitFacade.commit(provider, dest, commitMessage, user.asCommitter());
            await this.gitFacade.push(
                { dir: dest },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );

            if (shouldCreatePR && branchName && defaultBranch) {
                const prTitle = `Update ${updatedItem.name} metadata - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
                const prBody =
                    `Update item metadata: ${updatedItem.name}\n\n` +
                    `**Item Slug:** ${updateItemDto.item_slug}\n` +
                    `**Featured:** ${String(!!updatedItem.featured)}\n` +
                    `**Order:** ${updatedItem.order ?? 'n/a'}\n` +
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
                    { userId: directoryOwner.id, providerId: directory.gitProvider },
                );

                return {
                    status: 'success',
                    slug: directory.slug,
                    item_name: updatedItem.name,
                    item_slug: updateItemDto.item_slug,
                    message: `Item "${updatedItem.name}" metadata update submitted. PR #${pr.number} created.`,
                    pr_number: pr.number,
                    pr_url: pr.url,
                    pr_branch_name: branchName,
                    pr_title: prTitle,
                    pr_body: prBody,
                };
            }

            return {
                status: 'success',
                slug: directory.slug,
                item_name: updatedItem.name,
                item_slug: updateItemDto.item_slug,
                message: `Item "${updatedItem.name}" metadata updated.`,
            };
        } catch (error) {
            this.logger.error('Failed to update item metadata', error);
            return {
                status: 'error',
                slug: directory.slug,
                item_name: 'Unknown',
                item_slug: updateItemDto.item_slug,
                message: error.message,
            };
        }
    }
}
