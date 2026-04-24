import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { AiFacadeService } from '../facades/ai.facade';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '../database/repositories/directory-generation-history.repository';
import type { Directory } from '../entities/directory.entity';
import type { CommunityPrState } from '../entities/types';
import type { GitPullRequest } from '@ever-works/plugin';
import type { Category } from '@ever-works/contracts';
import { slugifyText } from '../utils/text.utils';
import { DataRepository } from '../generators/data-generator/data-repository';
import { GenerateStatusType } from '../entities/types';
import {
    DirectoryHistoryActivityType,
    type DirectoryHistoryChangeEntry,
} from '@ever-works/contracts/api';
import { buildDirectoryChangelog } from '../utils/directory-changelog.utils';

const MAX_PROCESSED_PR_NUMBERS = 500;
const MAX_CHANGE_CONTEXT_LENGTH = 50_000;
const COMMUNITY_PR_LOCK_TTL_MS = 30 * 60 * 1000;

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

export interface CommunityPrProcessingResult {
    processed: number;
    errors: Array<{ directoryId: string; error: string }>;
}

type CommunityPrTriggerSource = 'user' | 'schedule' | 'api';

interface CommunityPrSinglePrResult {
    outcome: 'applied' | 'ignored';
    itemsAdded: number;
}

@Injectable()
export class CommunityPrProcessorService {
    private readonly logger = new Logger(CommunityPrProcessorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly aiFacade: AiFacadeService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    private async recordCommunityPrHistory(params: {
        directoryId: string;
        userId: string;
        prNumber: number;
        entries: DirectoryHistoryChangeEntry[];
        triggeredBy: CommunityPrTriggerSource;
    }): Promise<void> {
        const now = new Date();

        await this.generationHistoryRepository.createEntry({
            directoryId: params.directoryId,
            userId: params.userId,
            status: GenerateStatusType.GENERATED,
            startedAt: now,
            finishedAt: now,
            durationInSeconds: 0,
            newItemsCount: params.entries.length,
            triggeredBy: params.triggeredBy,
            activityType: DirectoryHistoryActivityType.COMMUNITY_PR_MERGED,
            changelog: buildDirectoryChangelog(
                params.entries,
                `Community PR #${params.prNumber} merged: ${params.entries.length} item${params.entries.length === 1 ? '' : 's'} added`,
            ),
        });
    }

    private directoryLockKey(directoryId: string): string {
        return `community-pr:${directoryId}`;
    }

    private isPrHandled(state: CommunityPrState, pr: GitPullRequest): boolean {
        const processedRecords = state.processedPrs ?? [];
        const record = processedRecords.find((entry) => entry.number === pr.number);
        if (record) {
            return record.updatedAt === pr.updatedAt;
        }

        return (state.processedPrNumbers ?? []).includes(pr.number);
    }

    private markPrHandled(
        state: CommunityPrState,
        pr: GitPullRequest,
        outcome: CommunityPrSinglePrResult['outcome'],
    ): void {
        state.processedPrNumbers = Array.from(new Set([...(state.processedPrNumbers ?? []), pr.number]));

        const processedRecords = (state.processedPrs ?? []).filter((entry) => entry.number !== pr.number);
        processedRecords.push({
            number: pr.number,
            updatedAt: pr.updatedAt,
            outcome,
        });

        if (state.processedPrNumbers.length > MAX_PROCESSED_PR_NUMBERS) {
            state.processedPrNumbers = state.processedPrNumbers.slice(-MAX_PROCESSED_PR_NUMBERS);
        }

        if (processedRecords.length > MAX_PROCESSED_PR_NUMBERS) {
            state.processedPrs = processedRecords.slice(-MAX_PROCESSED_PR_NUMBERS);
        } else {
            state.processedPrs = processedRecords;
        }
    }

    async processAllDirectories(
        triggeredBy: CommunityPrTriggerSource = 'schedule',
    ): Promise<CommunityPrProcessingResult> {
        const directories = await this.directoryRepository.findWithCommunityPrEnabled();
        const result: CommunityPrProcessingResult = { processed: 0, errors: [] };

        for (const directory of directories) {
            try {
                const state: CommunityPrState = directory.communityPrState || {
                    processedPrNumbers: [],
                    totalItemsAdded: 0,
                };

                const autoClose = directory.communityPrAutoClose;

                const count = await this.processDirectory(directory, state, autoClose, triggeredBy);
                result.processed += count;
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
        triggeredBy: CommunityPrTriggerSource = 'api',
    ): Promise<number> {
        const lockResult = await this.taskLockService.runExclusive(
            this.directoryLockKey(directory.id),
            async () => {
                const owner = directory.getRepoOwner();
                const mainRepo = directory.getMainRepo();
                const gitOptions: GitFacadeOptions = {
                    userId: directory.userId,
                    providerId: directory.gitProvider,
                };

                const openPRs = await this.gitFacade.listPullRequests(
                    owner,
                    mainRepo,
                    { state: 'open', perPage: 100 },
                    gitOptions,
                );

                if (openPRs.length === 0) {
                    return 0;
                }

                const currentState: CommunityPrState = state || directory.communityPrState || {
                    processedPrNumbers: [],
                    totalItemsAdded: 0,
                };

                const shouldAutoClose =
                    autoClose === undefined ? directory.communityPrAutoClose : autoClose;

                const unprocessedPRs = openPRs.filter((pr) => !this.isPrHandled(currentState, pr));

                if (unprocessedPRs.length === 0) {
                    return 0;
                }

                let totalItemsAdded = 0;
                let lastError: string | null = null;

                for (const pr of unprocessedPRs) {
                    try {
                        const prResult = await this.processSinglePr(
                            directory,
                            pr,
                            gitOptions,
                            shouldAutoClose,
                            triggeredBy,
                        );
                        totalItemsAdded += prResult.itemsAdded;
                        this.markPrHandled(currentState, pr, prResult.outcome);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const stack = error instanceof Error ? error.stack : undefined;
                        this.logger.error(
                            `Failed to process PR #${pr.number} for directory ${directory.id}: ${message}`,
                            stack,
                        );
                        lastError = message;
                    }
                }

                currentState.lastProcessedAt = new Date().toISOString();
                currentState.lastError = lastError;
                currentState.totalItemsAdded =
                    (currentState.totalItemsAdded || 0) + totalItemsAdded;

                await this.directoryRepository.update(directory.id, { communityPrState: currentState });

                if (totalItemsAdded > 0) {
                    await this.directoryRepository.increment(directory.id, 'itemsCount', totalItemsAdded);
                }

                return totalItemsAdded;
            },
            {
                ttlMs: COMMUNITY_PR_LOCK_TTL_MS,
                onLocked: () =>
                    this.logger.debug(
                        `Skipping community PR processing for directory ${directory.id} because another instance is already processing it`,
                    ),
            },
        );

        return lockResult.result ?? 0;
    }

    private async processSinglePr(
        directory: Directory,
        pr: GitPullRequest,
        gitOptions: GitFacadeOptions,
        autoClose: boolean,
        triggeredBy: CommunityPrTriggerSource,
    ): Promise<CommunityPrSinglePrResult> {
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
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        // Clone/pull data repo
        const dest = await this.gitFacade.cloneOrPull({ owner, repo: dataRepo }, gitOptions);

        const data = await DataRepository.create(dest);
        const categories = await data.getCategories().catch((): Category[] => []);
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
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        // Write items to data repo
        const addedEntries: DirectoryHistoryChangeEntry[] = [];
        const seenSlugs = new Set<string>();

        for (const item of extractedItems.items) {
            const slug = slugifyText(item.name);
            if (!slug || seenSlugs.has(slug) || (await data.itemExists(slug))) {
                this.logger.warn(
                    `Skipping community PR item "${item.name}" for directory ${directory.id} because slug "${slug}" already exists`,
                );
                continue;
            }

            seenSlugs.add(slug);
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

            addedEntries.push({
                entityType: 'item',
                action: 'added',
                name: item.name,
                slug,
            });
        }

        if (addedEntries.length === 0) {
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        // Commit and push
        await this.gitFacade.add(directory.gitProvider, dest, '.');
        await this.gitFacade.commit(
            directory.gitProvider,
            dest,
            `Add ${addedEntries.length} item(s) from community PR #${pr.number}`,
        );
        await this.gitFacade.push({ dir: dest }, gitOptions);

        try {
            await this.recordCommunityPrHistory({
                directoryId: directory.id,
                userId: directory.userId,
                prNumber: pr.number,
                entries: addedEntries,
                triggeredBy,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Community PR #${pr.number} for directory ${directory.id} was applied but history recording failed: ${message}`,
            );
        }

        // Comment on PR
        const itemNames = addedEntries.map((entry) => `- ${entry.name}`).join('\n');
        try {
            await this.gitFacade.createPullRequestComment(
                owner,
                mainRepo,
                pr.number,
                `Thank you for your contribution! The following items have been added to the directory:\n\n${itemNames}\n\nThe data repository has been updated automatically.`,
                gitOptions,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Community PR #${pr.number} for directory ${directory.id} was applied but commenting failed: ${message}`,
            );
        }

        // Optionally close the PR
        if (autoClose) {
            try {
                await this.gitFacade.closePullRequest(owner, mainRepo, pr.number, gitOptions);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Community PR #${pr.number} for directory ${directory.id} was applied but auto-close failed: ${message}`,
                );
            }
        }

        return { outcome: 'applied', itemsAdded: addedEntries.length };
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
