import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { AiFacadeService } from '../facades/ai.facade';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import type { Directory } from '../entities/directory.entity';
import type { CommunityPrState } from '../entities/types';
import type { GitPullRequest } from '@ever-works/plugin';
import { slugifyText } from '../utils/text.utils';
import { DataRepository } from '../generators/data-generator/data-repository';

const MAX_PROCESSED_PR_NUMBERS = 500;
const MAX_CHANGE_CONTEXT_LENGTH = 50_000;

const extractedItemSchema = z.object({
    items: z.array(
        z.object({
            name: z.string(),
            description: z.string(),
            source_url: z.string(),
            category: z.string(),
            tags: z.array(z.string()),
        }),
    ),
});

type ExtractedItems = z.infer<typeof extractedItemSchema>;

export interface CommunityPrProcessingResult {
    processed: number;
    errors: Array<{ directoryId: string; error: string }>;
}

// Re-export CommunityPrState from entities/types for backwards compatibility
export type { CommunityPrState } from '../entities/types';

@Injectable()
export class CommunityPrProcessorService {
    private readonly logger = new Logger(CommunityPrProcessorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly aiFacade: AiFacadeService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async processAllDirectories(): Promise<CommunityPrProcessingResult> {
        const directories = await this.directoryRepository.findWithCommunityPrEnabled();
        const result: CommunityPrProcessingResult = { processed: 0, errors: [] };

        for (const directory of directories) {
            try {
                const state: CommunityPrState = directory.communityPrState || {
                    processedPrNumbers: [],
                    totalItemsAdded: 0,
                };

                const autoClose = directory.communityPrAutoClose;

                const count = await this.processDirectory(directory, state, autoClose);
                result.processed += count;

                // Persist updated state to directory
                await this.directoryRepository.update(directory.id, { communityPrState: state });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const stack = error instanceof Error ? error.stack : undefined;
                this.logger.error(`Failed to process directory ${directory.id}: ${message}`, stack);
                result.errors.push({ directoryId: directory.id, error: message });
            }
        }

        return result;
    }

    async processDirectory(
        directory: Directory,
        state?: CommunityPrState,
        autoClose?: boolean,
    ): Promise<number> {
        const owner = directory.getRepoOwner();
        const mainRepo = directory.getMainRepo();
        const gitOptions: GitFacadeOptions = {
            userId: directory.userId,
            providerId: directory.gitProvider,
        };

        const openPRs = await this.gitFacade.listPullRequests(
            owner,
            mainRepo,
            { state: 'open' },
            gitOptions,
        );

        if (openPRs.length === 0) {
            return 0;
        }

        // If no state provided, load from directory entity
        if (!state) {
            state = directory.communityPrState || {
                processedPrNumbers: [],
                totalItemsAdded: 0,
            };
        }

        if (autoClose === undefined) {
            autoClose = directory.communityPrAutoClose;
        }

        const processedSet = new Set(state.processedPrNumbers);
        const unprocessedPRs = openPRs.filter((pr) => !processedSet.has(pr.number));

        if (unprocessedPRs.length === 0) {
            return 0;
        }

        let totalItemsAdded = 0;

        for (const pr of unprocessedPRs) {
            try {
                const itemsAdded = await this.processSinglePr(directory, pr, gitOptions, autoClose);
                totalItemsAdded += itemsAdded;
            } catch (error) {
                const stack = error instanceof Error ? error.stack : String(error);
                this.logger.error(
                    `Failed to process PR #${pr.number} for directory ${directory.id}: ${stack}`,
                );
                state.lastError = error instanceof Error ? error.message : String(error);
            } finally {
                if (!state.processedPrNumbers) {
                    state.processedPrNumbers = [];
                }
                state.processedPrNumbers.push(pr.number);
            }
        }

        // Cap processedPrNumbers to prevent unbounded growth
        if (state.processedPrNumbers.length > MAX_PROCESSED_PR_NUMBERS) {
            state.processedPrNumbers = state.processedPrNumbers.slice(-MAX_PROCESSED_PR_NUMBERS);
        }

        state.lastProcessedAt = new Date().toISOString();
        state.totalItemsAdded = (state.totalItemsAdded || 0) + totalItemsAdded;

        // Persist updated state to directory
        await this.directoryRepository.update(directory.id, { communityPrState: state });

        // Update directory itemsCount in the database
        if (totalItemsAdded > 0) {
            const currentCount = directory.itemsCount || 0;
            await this.directoryRepository.update(directory.id, {
                itemsCount: currentCount + totalItemsAdded,
            });
        }

        return totalItemsAdded;
    }

    private async processSinglePr(
        directory: Directory,
        pr: GitPullRequest,
        gitOptions: GitFacadeOptions,
        autoClose: boolean,
    ): Promise<number> {
        const owner = directory.getRepoOwner();
        const mainRepo = directory.getMainRepo();
        const dataRepo = directory.getDataRepo();

        // Get PR file changes
        const files = await this.gitFacade.getPullRequestFiles(
            owner,
            mainRepo,
            pr.number,
            gitOptions,
        );

        // Build change context from patches
        let changeContext = '';
        for (const file of files) {
            const patch = file.patch || '';
            const entry = `--- ${file.filename} (${file.status}) ---\n${patch}\n\n`;
            if (changeContext.length + entry.length > MAX_CHANGE_CONTEXT_LENGTH) {
                break;
            }
            changeContext += entry;
        }

        if (!changeContext.trim()) {
            await this.gitFacade.createPullRequestComment(
                owner,
                mainRepo,
                pr.number,
                'Thank you for your contribution! However, I was unable to extract any meaningful changes from this PR. Please ensure the PR contains additions to the directory listing.',
                gitOptions,
            );
            return 0;
        }

        // Clone/pull data repo
        const dest = await this.gitFacade.cloneOrPull({ owner, repo: dataRepo }, gitOptions);

        const data = await DataRepository.create(dest);
        const categories = await data.getCategories().catch(() => []);
        const categoryNames = categories.map((c) => c.name).join(', ');

        // Extract items via AI
        const extractionPrompt = this.buildExtractionPrompt({
            directoryName: directory.name,
            directoryDescription: directory.description,
            categories: categoryNames,
            prTitle: pr.title,
            prBody: pr.body || '',
            prChanges: changeContext,
        });

        const aiResponse = await this.aiFacade.askJson(
            extractionPrompt,
            extractedItemSchema,
            { temperature: 0.3 },
            { userId: directory.userId, directoryId: directory.id },
        );

        const extractedItems = aiResponse.result;

        if (!extractedItems.items || extractedItems.items.length === 0) {
            await this.gitFacade.createPullRequestComment(
                owner,
                mainRepo,
                pr.number,
                'Thank you for your contribution! I reviewed this PR but could not extract any directory items from the changes. This PR may contain formatting changes or other non-item updates.',
                gitOptions,
            );
            return 0;
        }

        // Write items to data repo
        for (const item of extractedItems.items) {
            const slug = slugifyText(item.name);
            const itemData = {
                name: item.name,
                slug,
                description: item.description,
                source_url: item.source_url,
                category: item.category,
                tags: item.tags,
                images: [] as string[],
            };

            await data.createItemDir(itemData);
            await data.writeItem(itemData);

            const markdown = `# ${item.name}\n\n${item.description}\n\n[${item.source_url}](${item.source_url})`;
            await data.writeItemMarkdown(itemData, markdown);
        }

        // Commit and push
        await this.gitFacade.add(directory.gitProvider, dest, '.');
        await this.gitFacade.commit(
            directory.gitProvider,
            dest,
            `Add ${extractedItems.items.length} item(s) from community PR #${pr.number}`,
        );
        await this.gitFacade.push({ dir: dest }, gitOptions);

        // Comment on PR
        const itemNames = extractedItems.items.map((i) => `- ${i.name}`).join('\n');
        await this.gitFacade.createPullRequestComment(
            owner,
            mainRepo,
            pr.number,
            `Thank you for your contribution! The following items have been added to the directory:\n\n${itemNames}\n\nThe data repository has been updated automatically.`,
            gitOptions,
        );

        // Optionally close the PR
        if (autoClose) {
            await this.gitFacade.closePullRequest(owner, mainRepo, pr.number, gitOptions);
        }

        return extractedItems.items.length;
    }

    private buildExtractionPrompt(vars: {
        directoryName: string;
        directoryDescription: string;
        categories: string;
        prTitle: string;
        prBody: string;
        prChanges: string;
    }): string {
        return `You are analyzing a community pull request submitted to the "${vars.directoryName}" directory.

Directory description: ${vars.directoryDescription}

Existing categories: ${vars.categories || 'None defined yet'}

PR Title: ${vars.prTitle}
PR Description: ${vars.prBody || 'No description provided'}

PR Changes:
${vars.prChanges}

Extract all new items being proposed in this PR. For each item, provide:
- name: The name of the tool/project/resource
- description: A concise description (1-2 sentences)
- source_url: The URL/link to the item (must be a valid URL)
- category: The most appropriate category from the existing categories listed above. If none fit, suggest a new category name.
- tags: An array of relevant tags (2-5 tags)

If the PR does not contain any new items (e.g., it's just formatting changes, typo fixes, or reorganization), return an empty items array.

Only extract items that are clearly being added as new entries to the directory. Do not extract items that are being removed or modified.`;
    }
}
