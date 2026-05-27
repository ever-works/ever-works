import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { AiFacadeService } from '../facades/ai.facade';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkGenerationHistoryRepository } from '../database/repositories/work-generation-history.repository';
import type { Work } from '../entities/work.entity';
import type { CommunityPrState } from '../entities/types';
import type { GitPullRequest } from '@ever-works/plugin';
import type { Category } from '@ever-works/contracts';
import { slugifyText } from '../utils/text.utils';
import { DataRepository } from '../generators/data-generator/data-repository';
import { GenerateStatusType } from '../entities/types';
import { WorkHistoryActivityType, type WorkHistoryChangeEntry } from '@ever-works/contracts/api';
import { buildWorkChangelog } from '../utils/work-changelog.utils';

const MAX_PROCESSED_PR_NUMBERS = 500;
const MAX_CHANGE_CONTEXT_LENGTH = 50_000;
const COMMUNITY_PR_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * C-11: cap items added per community PR. Default 10 — generous for a
 * legitimate "add 3 new awesome-list entries" PR, but stops a malicious
 * PR from flooding the data repo with attacker-chosen items in one go.
 * Tunable via `COMMUNITY_PR_MAX_ITEMS_PER_PR` env.
 */
function getMaxItemsPerPr(): number {
    const v = Number(process.env.COMMUNITY_PR_MAX_ITEMS_PER_PR ?? 10);
    return Number.isFinite(v) && v > 0 ? v : 10;
}

/**
 * C-11: default-off auto-apply. Until the GitHub Verified-org author
 * check ships (requires extending GitPullRequest with author info from
 * the git-provider plugin), community-PR auto-extraction is off by
 * default. Operators can opt in globally with `COMMUNITY_PR_AUTO_APPLY=true`,
 * or per-Work via the Work's own settings (not wired here yet — operator
 * roadmap item).
 */
function isAutoApplyEnabled(): boolean {
    return process.env.COMMUNITY_PR_AUTO_APPLY === 'true';
}

/**
 * C-11 — Verified-org author allow-list. When
 * `COMMUNITY_PR_VERIFIED_ORGS` is set (comma-separated org logins,
 * e.g. `ever-works,ever-co`), only PRs whose author is a verified
 * member of one of those orgs get auto-applied. PRs from anyone else
 * are short-circuited with `outcome: 'ignored'`. The
 * `pr.author.orgVerified` flag is populated by the git-provider
 * plugin (currently the github plugin in
 * `packages/plugins/github/src/github-verified-org.service.ts`).
 *
 * When the env var is unset, the verified-org check is disabled and
 * any author may auto-apply — useful for self-hosted operators who
 * accept that risk in exchange for friction-free contributions.
 */
function parseVerifiedOrgs(): string[] {
    const raw = process.env.COMMUNITY_PR_VERIFIED_ORGS;
    if (!raw) return [];
    const set = new Set<string>();
    for (const part of raw.split(',')) {
        const v = part.trim().toLowerCase();
        if (v) set.add(v);
    }
    return [...set];
}

/**
 * C-11 — strict item shape. The previous schema allowed `source_url:
 * z.string()` which trivially admits `javascript:...`. Now requires
 * http/https + length caps + tag count caps.
 */
const extractedItemSchema = z.object({
    items: z
        .array(
            z.object({
                name: z.string().min(1).max(256),
                description: z.string().min(1).max(8_000),
                source_url: z
                    .string()
                    .max(2048)
                    .refine(
                        (v) => {
                            try {
                                const u = new URL(v);
                                return u.protocol === 'http:' || u.protocol === 'https:';
                            } catch {
                                return false;
                            }
                        },
                        { message: 'source_url must be http(s)' },
                    ),
                category: z.string().min(1).max(128),
                tags: z.array(z.string().min(1).max(64)).max(32),
            }),
        )
        .max(256), // sanity ceiling — the per-PR cap below is the real limit
});

export interface CommunityPrProcessingResult {
    processed: number;
    errors: Array<{ workId: string; error: string }>;
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
        private readonly workRepository: WorkRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    private async recordCommunityPrHistory(params: {
        workId: string;
        userId: string;
        prNumber: number;
        entries: WorkHistoryChangeEntry[];
        triggeredBy: CommunityPrTriggerSource;
    }): Promise<void> {
        const now = new Date();

        await this.generationHistoryRepository.createEntry({
            workId: params.workId,
            userId: params.userId,
            status: GenerateStatusType.GENERATED,
            startedAt: now,
            finishedAt: now,
            durationInSeconds: 0,
            newItemsCount: params.entries.length,
            triggeredBy: params.triggeredBy,
            activityType: WorkHistoryActivityType.COMMUNITY_PR_MERGED,
            changelog: buildWorkChangelog(
                params.entries,
                `Community PR #${params.prNumber} merged: ${params.entries.length} item${params.entries.length === 1 ? '' : 's'} added`,
            ),
        });
    }

    private workLockKey(workId: string): string {
        return `community-pr:${workId}`;
    }

    /**
     * Has this PR (at its current `updatedAt`) already been processed?
     *
     * Reads from TWO state shapes that coexist on the work row:
     *  - `state.processedPrs` (the modern shape, since EW-... migration):
     *    array of `{ number, updatedAt, outcome }`. Lets us detect that
     *    a previously-processed PR has been edited since (different
     *    `updatedAt`) and SHOULD be re-processed.
     *  - `state.processedPrNumbers` (legacy shape, kept in sync by
     *    `markPrHandled` for rows that pre-date the migration): array
     *    of bare PR numbers. No `updatedAt`, so a match here is treated
     *    as "handled forever — don't re-process even if edited".
     *
     * The modern record wins when both exist: if a `processedPrs` entry
     * is present, the legacy `processedPrNumbers` membership is
     * ignored. Drop the legacy fallback once the migration has been
     * verified to have backfilled every active work — until then,
     * removing it would silently re-process every old PR on those
     * works.
     */
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
        state.processedPrNumbers = Array.from(
            new Set([...(state.processedPrNumbers ?? []), pr.number]),
        );

        const processedRecords = (state.processedPrs ?? []).filter(
            (entry) => entry.number !== pr.number,
        );
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

    async processAllWorks(
        triggeredBy: CommunityPrTriggerSource = 'schedule',
    ): Promise<CommunityPrProcessingResult> {
        const works = await this.workRepository.findWithCommunityPrEnabled();
        const result: CommunityPrProcessingResult = { processed: 0, errors: [] };

        for (const work of works) {
            try {
                const state: CommunityPrState = work.communityPrState || {
                    processedPrNumbers: [],
                    totalItemsAdded: 0,
                };

                const autoClose = work.communityPrAutoClose;

                const count = await this.processWork(work, state, autoClose, triggeredBy);
                result.processed += count;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const stack = error instanceof Error ? error.stack : undefined;
                this.logger.error(`Failed to process work ${work.id}: ${message}`, stack);
                result.errors.push({ workId: work.id, error: message });
            }
        }

        return result;
    }

    async processWork(
        work: Work,
        state?: CommunityPrState,
        autoClose?: boolean,
        triggeredBy: CommunityPrTriggerSource = 'api',
    ): Promise<number> {
        const lockResult = await this.taskLockService.runExclusive(
            this.workLockKey(work.id),
            async () => {
                const owner = work.getRepoOwner();
                const mainRepo = work.getMainRepo();
                const gitOptions: GitFacadeOptions = {
                    userId: work.userId,
                    providerId: work.gitProvider,
                    workId: work.id,
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

                const currentState: CommunityPrState = state ||
                    work.communityPrState || {
                        processedPrNumbers: [],
                        totalItemsAdded: 0,
                    };

                const shouldAutoClose =
                    autoClose === undefined ? work.communityPrAutoClose : autoClose;

                const unprocessedPRs = openPRs.filter((pr) => !this.isPrHandled(currentState, pr));

                if (unprocessedPRs.length === 0) {
                    return 0;
                }

                let totalItemsAdded = 0;
                let lastError: string | null = null;

                for (const pr of unprocessedPRs) {
                    try {
                        const prResult = await this.processSinglePr(
                            work,
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
                            `Failed to process PR #${pr.number} for work ${work.id}: ${message}`,
                            stack,
                        );
                        lastError = message;
                    }
                }

                currentState.lastProcessedAt = new Date().toISOString();
                currentState.lastError = lastError;
                currentState.totalItemsAdded =
                    (currentState.totalItemsAdded || 0) + totalItemsAdded;

                await this.workRepository.update(work.id, {
                    communityPrState: currentState,
                });

                if (totalItemsAdded > 0) {
                    await this.workRepository.increment(work.id, 'itemsCount', totalItemsAdded);
                }

                return totalItemsAdded;
            },
            {
                ttlMs: COMMUNITY_PR_LOCK_TTL_MS,
                onLocked: () =>
                    this.logger.debug(
                        `Skipping community PR processing for work ${work.id} because another instance is already processing it`,
                    ),
            },
        );

        return lockResult.result ?? 0;
    }

    private async processSinglePr(
        work: Work,
        pr: GitPullRequest,
        gitOptions: GitFacadeOptions,
        autoClose: boolean,
        triggeredBy: CommunityPrTriggerSource,
    ): Promise<CommunityPrSinglePrResult> {
        // C-11: default-off auto-apply. AI extraction from community PRs
        // is disabled unless the operator explicitly enables it. The PR
        // is left untouched (still visible in GitHub) so a maintainer
        // can review it manually. See the 2026-05-17 security audit
        // (`docs/specs/security/audits/2026-05-17-ever-works-platform-security-audit.md`)
        // — finding C-11.
        if (!isAutoApplyEnabled()) {
            this.logger.debug(
                `Community PR auto-apply is disabled (set COMMUNITY_PR_AUTO_APPLY=true to enable). Skipping PR #${pr.number} for work ${work.id}.`,
            );
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        // C-11: Verified-org author allow-list. When
        // `COMMUNITY_PR_VERIFIED_ORGS` is set, the git-provider plugin
        // must have populated `pr.author.orgVerified === true` for the
        // PR to be applied. The github plugin (see
        // `packages/plugins/github/src/github-verified-org.service.ts`)
        // performs the membership lookup via
        // `GET /orgs/{org}/members/{username}` with a short-TTL
        // per-process cache. Anything else (missing author, missing
        // flag, false, or undefined) is treated as untrusted and the
        // PR is left for a maintainer to review.
        const verifiedOrgs = parseVerifiedOrgs();
        if (verifiedOrgs.length > 0 && pr.author?.orgVerified !== true) {
            this.logger.warn(
                `Community PR #${pr.number} for work ${work.id} skipped — author "${pr.author?.username ?? '<unknown>'}" is not a verified member of any configured org (${verifiedOrgs.join(', ')}). See C-11 in docs/specs/security/audits/2026-05-17-ever-works-platform-security-audit.md.`,
            );
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        const owner = work.getRepoOwner();
        const mainRepo = work.getMainRepo();
        const dataRepo = work.getDataRepo();

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
            workName: work.name,
            workDescription: work.description,
            categories: categoryNames,
            prTitle: pr.title,
            prBody: pr.body || '',
            prChanges: changeContext,
        });

        const aiResponse = await this.aiFacade.askJson(
            extractionPrompt,
            extractedItemSchema,
            { temperature: 0.3 },
            { userId: work.userId, workId: work.id },
        );

        const extractedItems = aiResponse.result;

        if (!extractedItems.items || extractedItems.items.length === 0) {
            return { outcome: 'ignored', itemsAdded: 0 };
        }

        // C-11: cap items per PR. The Zod schema enforces a hard ceiling
        // of 256; here we enforce the operator-tuned cap (default 10) so
        // a single malicious PR can't flood the data repo.
        const maxItems = getMaxItemsPerPr();
        const itemsToConsider = extractedItems.items.slice(0, maxItems);
        if (extractedItems.items.length > maxItems) {
            this.logger.warn(
                `Community PR #${pr.number} for work ${work.id} extracted ${extractedItems.items.length} items; capped at ${maxItems}.`,
            );
        }

        // Write items to data repo
        const addedEntries: WorkHistoryChangeEntry[] = [];
        const seenSlugs = new Set<string>();

        for (const item of itemsToConsider) {
            const slug = slugifyText(item.name);
            if (!slug || seenSlugs.has(slug) || (await data.itemExists(slug))) {
                this.logger.warn(
                    `Skipping community PR item "${item.name}" for work ${work.id} because slug "${slug}" already exists`,
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
        await this.gitFacade.add(work.gitProvider, dest, '.');
        await this.gitFacade.commit(
            work.gitProvider,
            dest,
            `Add ${addedEntries.length} item(s) from community PR #${pr.number}`,
        );
        await this.gitFacade.push({ dir: dest }, gitOptions);

        try {
            await this.recordCommunityPrHistory({
                workId: work.id,
                userId: work.userId,
                prNumber: pr.number,
                entries: addedEntries,
                triggeredBy,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Community PR #${pr.number} for work ${work.id} was applied but history recording failed: ${message}`,
            );
        }

        // Comment on PR
        const itemNames = addedEntries.map((entry) => `- ${entry.name}`).join('\n');
        try {
            await this.gitFacade.createPullRequestComment(
                owner,
                mainRepo,
                pr.number,
                `Thank you for your contribution! The following items have been added to the work:\n\n${itemNames}\n\nThe data repository has been updated automatically.`,
                gitOptions,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Community PR #${pr.number} for work ${work.id} was applied but commenting failed: ${message}`,
            );
        }

        // Optionally close the PR
        if (autoClose) {
            try {
                await this.gitFacade.closePullRequest(owner, mainRepo, pr.number, gitOptions);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Community PR #${pr.number} for work ${work.id} was applied but auto-close failed: ${message}`,
                );
            }
        }

        return { outcome: 'applied', itemsAdded: addedEntries.length };
    }

    private buildExtractionPrompt(vars: {
        workName: string;
        workDescription: string;
        categories: string;
        prTitle: string;
        prBody: string;
        prChanges: string;
    }): string {
        return `You are analyzing a community pull request submitted to the "${vars.workName}" work.

Work description: ${vars.workDescription}

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

Only extract items that are clearly being added as new entries to the work. Do not extract items that are being removed or modified.`;
    }
}
