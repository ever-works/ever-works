import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from '../git/github.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DataRepository, IDataConfig } from '../data-generator/data-repository';
import { slugifyText } from './utils/text.utils';
import { ItemsGeneratorService } from './items-generator.service';
import {
    SubmitItemDto,
    SubmitItemResponseDto,
    RemoveItemDto,
    RemoveItemResponseDto,
    ItemData,
} from './dto';
import { format } from 'date-fns';

@Injectable()
export class ItemSubmissionService {
    private readonly logger = new Logger(ItemSubmissionService.name);

    constructor(
        private readonly githubService: GithubService,
        private readonly itemsGeneratorService: ItemsGeneratorService,
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
            const token = user.getGitToken();
            const committer = user.asCommitter();

            const repo = directory.getDataRepo();

            // Clone or pull the data repository
            const dest = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo: repo,
                token: token,
                committer: committer,
            });

            const data = await DataRepository.create(dest);

            // Get config to check autoapproval settings
            const config: IDataConfig | null = await data.getConfig().catch((error) => {
                this.logger.warn('Failed to get config, using defaults', error);
                return null;
            });

            const shouldAutoMerge =
                submitItemDto.pay_and_publish_now || (config && config.autoapproval === true);

            // Get main branch
            const defaultBranch = await this.githubService.getMainBranch(dest);

            // Create new branch for the item submission
            const branchName = await this.githubService.createAndSwitchToRandomBranch(dest);
            this.logger.log(`Created and switched to new branch: ${branchName}`);

            // Prepare item data
            const itemData: ItemData = {
                name: submitItemDto.name,
                description: submitItemDto.description,
                source_url: submitItemDto.source_url,
                category: submitItemDto.category,
                tags: submitItemDto.tags || [],
                featured: submitItemDto.featured || false,
                slug: submitItemDto.slug || slugifyText(submitItemDto.name),
            };

            // Process badges for the item if it's a repository
            const itemWithBadges =
                await this.itemsGeneratorService.processSingleItemBadges(itemData);

            // Generate markdown for the item using AI
            const itemsWithMarkdown = await this.itemsGeneratorService.generateMarkdownForItems([
                itemWithBadges,
            ]);
            const itemWithMarkdown = itemsWithMarkdown[0];

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
            await this.githubService.add(dest, '.');
            await this.githubService.commit(
                dest,
                `Add ${itemWithMarkdown.name}`,
                user.asCommitter(),
            );

            // Push changes
            await this.githubService.push(dest, token);

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
                `**Tags:** ${Array.isArray(itemWithMarkdown.tags) ? itemWithMarkdown.tags.join(', ') : ''}${badgeInfo}\n\n` +
                `Generated by [Ever Works](https://ever.works)`;

            const pr = await this.githubService.createPR(
                {
                    owner: directory.getRepoOwner(),
                    repo: repo,
                    head: branchName,
                    base: defaultBranch,
                    title: prTitle,
                    body: prBody,
                },
                token,
            );

            let autoMerged = false;

            // Auto-merge if conditions are met
            if (shouldAutoMerge && pr.number) {
                try {
                    await this.githubService.mergePR(
                        {
                            owner: directory.getRepoOwner(),
                            repo: repo,
                            pull_number: pr.number,
                            commit_title: `Merge: ${prTitle}`,
                            merge_method: 'squash',
                        },
                        token,
                    );
                    autoMerged = true;
                    this.logger.log(
                        `Auto-merged PR #${pr.number} for item ${itemWithMarkdown.name}`,
                    );
                } catch (mergeError) {
                    this.logger.warn(
                        `Failed to auto-merge PR #${pr.number}: ${mergeError.message}`,
                    );
                    // Continue without auto-merge - PR is still created
                }
            }

            return {
                status: 'success',
                slug: directory.slug,
                item_name: itemWithMarkdown.name,
                message: autoMerged
                    ? `Item "${itemWithMarkdown.name}" has been successfully added and published.`
                    : `Item "${itemWithMarkdown.name}" has been submitted for review. PR #${pr.number} created.`,
                pr_number: pr.number,
                pr_url: pr.html_url,
                pr_title: prTitle,
                pr_body: prBody,
                pr_branch_name: branchName,
                auto_merged: autoMerged,
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
            const token = user.getGitToken();
            const committer = user.asCommitter();

            const repo = directory.getDataRepo();

            // Clone or pull the data repository
            const dest = await this.githubService.cloneOrPull({
                owner: directory.getRepoOwner(),
                repo: repo,
                token: token,
                committer: committer,
            });

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

            // Get main branch
            const defaultBranch = await this.githubService.getMainBranch(dest);

            // Create new branch for the item removal
            const branchName = await this.githubService.createAndSwitchToRandomBranch(dest);
            this.logger.log(`Created and switched to new branch: ${branchName}`);

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
            await this.githubService.addAll(dest);
            const commitMessage = removeItemDto.reason
                ? `Remove ${itemData.name} - ${removeItemDto.reason}`
                : `Remove ${itemData.name}`;
            await this.githubService.commit(dest, commitMessage, user.asCommitter());

            // Push changes
            await this.githubService.push(dest, token);

            // Create PR
            const prTitle = `Remove ${itemData.name} - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
            const prBody =
                `Remove item: ${itemData.name}\n\n` +
                `**Item Slug:** ${removeItemDto.item_slug}\n` +
                `**Source URL:** ${itemData.source_url}\n` +
                `**Category:** ${itemData.category}\n` +
                (removeItemDto.reason ? `**Reason:** ${removeItemDto.reason}\n` : '') +
                `\nGenerated by [Ever Works](https://ever.works)`;

            const pr = await this.githubService.createPR(
                {
                    owner: directory.getRepoOwner(),
                    repo: repo,
                    head: branchName,
                    base: defaultBranch,
                    title: prTitle,
                    body: prBody,
                },
                token,
            );

            return {
                status: 'success',
                slug: directory.slug,
                item_name: itemData.name,
                item_slug: removeItemDto.item_slug,
                message: `Item "${itemData.name}" removal has been submitted for review. PR #${pr.number} created.`,
                pr_number: pr.number,
                pr_url: pr.html_url,
                pr_branch_name: branchName,
                pr_title: prTitle,
                pr_body: prBody,
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
}
