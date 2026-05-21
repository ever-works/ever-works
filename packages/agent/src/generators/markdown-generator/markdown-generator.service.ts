import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { GitFacadeService } from '../../facades/git.facade';
import type { Category, Identifiable, ItemData, Tag } from '@ever-works/contracts';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { DataRepository, PRUpdate } from '../data-generator/data-repository';
import { ReadmeBuilder } from './readme-builder';
import { MarkdownRepository } from './markdown-repository';
import { GenerationMethod } from '../../items-generator/dto';
import { WorkOperationsService } from '@src/work-operations';
import { getWorkOwner } from '../../utils/work.utils';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { assertCreatedRepositoryTarget } from '../../utils/git-repository.utils';
import { throwIfGenerationCancelled } from '../../utils/generation-cancellation.utils';

type InitializeOptions = {
    generation_method?: GenerationMethod;
    pr_update?: PRUpdate;
    remove_details?: string[];
    signal?: AbortSignal;
};

/**
 * Input for {@link MarkdownGeneratorService.syncFromDataRepo} — the
 * render-only entrypoint introduced by EW-628 (data-repo instant sync).
 *
 * Unlike `initialize`, this entry is intended to be called *outside* the
 * generation pipeline (from the EW-628 dispatcher), and so it deliberately
 * never runs the AI items-generator — it just re-renders the main repo
 * against whatever the data repo currently holds.
 *
 * `expectedSourceSha` is informational only: if the data repo HEAD has
 * already advanced past it by the time we clone, we render against
 * current HEAD anyway. A stale webhook is not a reason to skip a sync.
 */
export type SyncFromDataRepoOptions = {
    expectedSourceSha?: string;
    signal?: AbortSignal;
};

export type SyncFromDataRepoResult = {
    /** Data-repo HEAD SHA before this sync's clone/pull. TODO(EW-628): wire when stats helper lands. */
    beforeSha?: string;
    /** Data-repo HEAD SHA the main repo was rendered against. TODO(EW-628): wire when stats helper lands. */
    afterSha?: string;
    /** Number of files written to the main repo. TODO(EW-628): wire from MarkdownRepository write counters. */
    filesChanged: number;
    /** Wall-clock duration of the sync run in ms (start to push). */
    durationMs: number;
};

@Injectable()
export class MarkdownGeneratorService {
    private readonly logger = new Logger(MarkdownGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly workOperations: WorkOperationsService,
    ) {}

    async initialize(
        work: Work,
        user: User,
        options: InitializeOptions = {},
    ): Promise<{ filesChanged: number }> {
        throwIfGenerationCancelled(options.signal);

        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const description = work.description;
        const mainRepoOwner = work.getRepoOwner('work');
        const mainRepo = work.getMainRepo();

        // Create repository through facade
        const markdownRepository = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: mainRepo,
                    description,
                    organization: work.organization ? mainRepoOwner : undefined,
                    isPrivate: true,
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            ),
            mainRepoOwner,
            mainRepo,
            'Markdown repository',
        );
        throwIfGenerationCancelled(options.signal);

        // Clone markdown repo
        const markdownPath = await cloneFreshRepository(
            this.gitFacade,
            {
                owner: markdownRepository.owner,
                repo: markdownRepository.name,
                committer,
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
            this.logger,
        );
        throwIfGenerationCancelled(options.signal);

        // Clone data repo
        const dataPath = await this.gitFacade.cloneOrPull(
            {
                owner: work.getRepoOwner(),
                repo: work.getDataRepo(),
                committer,
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );
        throwIfGenerationCancelled(options.signal);

        const markdownRepo = new MarkdownRepository(markdownPath);
        const dataRepo = await DataRepository.create(dataPath);

        try {
            const slugs = await fs.readdir(dataRepo.dataDir);
            await markdownRepo.ensureWorksExist();

            const provider = work.gitProvider;
            const defaultBranch = await this.gitFacade
                .getMainBranch(provider, markdownRepo.dir)
                .catch((err) => {
                    this.logger.error('Failed to get main branch', err);
                    return null;
                });

            const generation_method = options?.generation_method;
            const pr_update = options?.pr_update;

            let canCreatePR =
                generation_method !== GenerationMethod.RECREATE && !!pr_update?.branch;

            // In case of re-creation:
            // Switch to the main branch and remove existing items files.
            if (generation_method === GenerationMethod.RECREATE) {
                if (defaultBranch) {
                    await this.gitFacade
                        .switchBranch(provider, markdownRepo.dir, defaultBranch)
                        .catch((err) => {
                            this.logger.error('Failed to switch to main branch', err);
                            return null;
                        });
                }

                await markdownRepo.resetFiles();
            } else if (canCreatePR) {
                // Switch to PR branch (both repos)
                await Promise.all([
                    this.gitFacade.switchBranch(provider, markdownRepo.dir, pr_update.branch, true),
                    this.gitFacade.switchBranch(provider, dataRepo.dir, pr_update.branch, true),
                ]).catch((err) => {
                    canCreatePR = false;
                    this.logger.error('Failed to switch to PR branch', err);
                });
            }

            const markdowns = new Set<string>(); // will be needed to check if markdown exists before referencing them in README
            const categories = await this.loadCategories(dataRepo);
            const tags = await this.loadTags(dataRepo);
            const itemWarnings: string[] = [];

            const groups = {}; // we want to group items by category, like: { 'open-source': [items], 'commercial': [items] }
            for (const slug of slugs) {
                throwIfGenerationCancelled(options.signal);

                try {
                    const markdown = await dataRepo.getMarkdown(slug);
                    if (markdown) {
                        await markdownRepo.writeDetails(slug, markdown);
                        markdowns.add(slug);
                    }

                    let item = await dataRepo.getItem(slug);
                    if (!item) {
                        continue;
                    }

                    if (Array.isArray(item.tags)) {
                        item = {
                            ...item,
                            tags: item.tags.map((tag) => this.populate<Tag>(tag, tags)),
                        };
                    }

                    // Normalize category to array of strings
                    const itemCategories: string[] = Array.isArray(item.category)
                        ? item.category
                        : [item.category];

                    // Ensure each category is in the categories map
                    for (const cat of itemCategories) {
                        if (!categories.has(cat)) {
                            categories.set(cat, { id: cat, name: cat });
                        }
                    }

                    // Group item by each of its categories
                    for (const cat of itemCategories) {
                        const group = groups[cat];
                        if (group) {
                            group.push(item);
                        } else {
                            groups[cat] = [item];
                        }
                    }
                } catch (error) {
                    const message = `Skipping item "${slug}" during markdown generation: ${
                        error instanceof Error ? error.message : String(error)
                    }`;
                    itemWarnings.push(message);
                    this.logger.warn(message);
                }
            }

            if (itemWarnings.length > 0) {
                this.logger.warn(
                    `Markdown generation completed with ${itemWarnings.length} skipped item(s)`,
                );
            }

            // Remove detail files
            if (options?.remove_details && options.remove_details.length > 0) {
                for (const slug of options.remove_details) {
                    throwIfGenerationCancelled(options.signal);
                    await markdownRepo.removeDetails(slug);
                    markdowns.delete(slug);
                }
            }

            throwIfGenerationCancelled(options.signal);
            const license = await dataRepo.getLicense();
            if (license) {
                await markdownRepo.writeLicense(license);
            }

            throwIfGenerationCancelled(options.signal);
            const readme: string = await this.generateReadme(
                dataRepo,
                markdowns,
                groups,
                categories,
            );
            await markdownRepo.writeReadme(readme);

            throwIfGenerationCancelled(options.signal);
            await this.gitFacade.addAll(provider, markdownPath);
            await this.gitFacade.commit(
                provider,
                markdownPath,
                'sync README.md',
                work.resolveCommitter(user),
            );
            throwIfGenerationCancelled(options.signal);
            await this.gitFacade.push(
                { dir: markdownPath },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            throwIfGenerationCancelled(options.signal);
            if (canCreatePR && defaultBranch) {
                this.logger.log(
                    `Creating PR from ${pr_update.branch} to ${defaultBranch} for ${work.slug}`,
                );

                const pr = await this.gitFacade
                    .createPullRequest(
                        {
                            owner: mainRepoOwner,
                            repo: mainRepo,
                            base: defaultBranch,
                            head: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                        },
                        {
                            userId: workOwner.id,
                            providerId: work.gitProvider,
                            workId: work.id,
                        },
                    )
                    .catch((err) => {
                        this.logger.error('Failed to create PR', err);
                        return null;
                    });

                if (pr) {
                    await this.workOperations.updateLastPullRequest(work.id, {
                        main: {
                            branch: pr_update.branch,
                            title: pr_update.title,
                            body: pr_update.body,
                            number: pr.number,
                            url: pr.url,
                        },
                    });
                }
            } else {
                this.logger.log(`Pushed changes to main branch for ${work.slug}`);
            }

            // EW-628: surface the per-run filesystem write count so
            // callers (notably the data-sync entry below) can record
            // `filesChanged` on the activity row without an extra git
            // diff. Existing callers ignore the return value, so this
            // is backwards compatible.
            return { filesChanged: markdownRepo.getWriteCount() };
        } catch (err) {
            this.logger.error('Error during markdown generation', err);
            throw err;
        }
    }

    /**
     * Render-only sync entry — EW-628 Path A (webhook) and Path B (poller)
     * both converge here via the `DataSyncService` introduced in Phase 3.
     *
     * Behaviour is intentionally identical to `initialize()` minus the
     * upstream `ItemsGeneratorService` invocation: clone main + data repos,
     * regenerate `README.md` + `details/*.md` from current data-repo HEAD,
     * commit and push. The AI items pipeline never runs from this path.
     *
     * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.4.
     *
     * Stats wired in EW-628 G5:
     *   - `beforeSha` — `work.lastSyncedDataRepoSha` at entry, i.e. the
     *     SHA the previous sync rendered against. May be `undefined` for
     *     a Work's first sync.
     *   - `afterSha` — current data-repo HEAD SHA fetched via the git
     *     provider plugin AFTER `initialize` finishes (so we record the
     *     SHA we actually rendered against, not whatever races a webhook
     *     into HEAD mid-flight).
     *   - `filesChanged` — `MarkdownRepository.getWriteCount()` returned
     *     by `initialize`. Counts README, per-item detail markdowns,
     *     license writes, plus any `removeDetails` calls.
     *   - `durationMs` — wall-clock from entry to push completion.
     *
     * If the remote SHA fetch fails (provider down / stale token),
     * `afterSha` is left `undefined` rather than failing the whole sync
     * — the activity row degrades gracefully, the caller's success
     * outcome still counts.
     */
    async syncFromDataRepo(
        work: Work,
        user: User,
        options: SyncFromDataRepoOptions = {},
    ): Promise<SyncFromDataRepoResult> {
        const startedAt = Date.now();
        const beforeSha = work.lastSyncedDataRepoSha ?? undefined;

        const { filesChanged } = await this.initialize(work, user, { signal: options.signal });

        const afterSha = await this.captureDataRepoHeadSha(work, user).catch((err) => {
            this.logger.warn(
                `Failed to capture data-repo HEAD SHA for work=${work.id}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return undefined;
        });

        return {
            beforeSha,
            afterSha,
            filesChanged,
            durationMs: Date.now() - startedAt,
        };
    }

    /**
     * Resolve the current data-repo HEAD SHA via the git provider plugin
     * (one remote API call). Pulled out of `syncFromDataRepo` so the
     * error-swallowing wrapper at the call site stays readable and the
     * happy path is one expression.
     */
    private async captureDataRepoHeadSha(work: Work, user: User): Promise<string | undefined> {
        const workOwner = getWorkOwner(work);
        const dataRepoOwner = work.getRepoOwner('data');
        const dataRepoName = work.getDataRepo();
        const facadeOptions = {
            userId: workOwner.id,
            providerId: work.gitProvider,
            workId: work.id,
        };

        const repo = await this.gitFacade.getRepository(dataRepoOwner, dataRepoName, facadeOptions);
        const branch = repo?.defaultBranch ?? 'main';

        const commit = await this.gitFacade.getLatestCommit(
            dataRepoOwner,
            dataRepoName,
            branch,
            facadeOptions,
        );
        // `user` is unused on the happy path but kept on the signature so
        // future stats (e.g. `lastSyncedAtForUser`) can attribute without
        // a churn.
        void user;
        return commit?.sha;
    }

    async removeItemDetail(work: Work, user: User, slug: string, branch?: string) {
        const workOwner = getWorkOwner(work);
        const committer = work.resolveCommitter(user);
        const mainRepoOwner = work.getRepoOwner('work');
        const mainRepo = work.getMainRepo();

        const markdownPath = await this.gitFacade.cloneOrPull(
            {
                owner: mainRepoOwner,
                repo: mainRepo,
                committer,
            },
            {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            },
        );

        const markdownRepo = new MarkdownRepository(markdownPath);

        if (branch) {
            await this.gitFacade
                .switchBranch(work.gitProvider, markdownRepo.dir, branch, true)
                .catch((err) => {
                    this.logger.error('Failed to switch to PR branch', err);
                });
        }

        await markdownRepo.removeDetails(slug);
    }

    /**
     * Remove repository for a work
     */
    async removeRepository(work: Work, user: User): Promise<void> {
        const workOwner = getWorkOwner(work);
        const mainRepoOwner = work.getRepoOwner('work');
        const mainRepo = work.getMainRepo();

        try {
            // Delete the repository
            await this.gitFacade.deleteRepository(mainRepoOwner, mainRepo, {
                userId: workOwner.id,
                providerId: work.gitProvider,
                workId: work.id,
            });

            const dataDir = this.gitFacade.getLocalDir(
                work.gitProvider,
                work.getRepoOwner(),
                work.getMainRepo(),
            );

            new MarkdownRepository(dataDir).cleanup();

            this.logger.log(
                `Successfully deleted markdown repository: ${mainRepoOwner}/${mainRepo}`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to delete markdown repository ${mainRepoOwner}/${mainRepo}:`,
                error,
            );
            throw error;
        }
    }

    async cleanup(work: Work) {
        const dataDir = this.gitFacade.getLocalDir(
            work.gitProvider,
            work.getRepoOwner(),
            work.getMainRepo(),
        );

        return new MarkdownRepository(dataDir).cleanup();
    }

    private async generateReadme(
        data: DataRepository,
        markdowns: Set<string>,
        groups: Record<string, Array<ItemData>>,
        categories: Map<string, Category>,
    ) {
        const config = await data.getConfig();
        const { header, footer } = await data.readMarkdownTemplate();
        const builder = new ReadmeBuilder(header, footer);

        if (config.content_table) {
            builder.enableToC();
        }

        // Sort categories by priority, then alphabetically
        const sortedCategoryIds = this.sortCategoriesByPriority(groups, categories);

        for (const categoryId of sortedCategoryIds) {
            const categoryDetails = categories.get(categoryId);
            const items = groups[categoryId];
            builder.addSubHeader(categoryDetails.name, items.length);

            items.sort((a, b) => {
                const aFeatured = !!a.featured;
                const bFeatured = !!b.featured;

                if (aFeatured !== bFeatured) {
                    return aFeatured ? -1 : 1; // featured always first
                }

                // Within the same featured bucket, honor explicit order ascending
                const orderA = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
                const orderB = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
                if (orderA !== orderB) {
                    return orderA - orderB;
                }

                return a.name.localeCompare(b.name);
            });

            for (const item of items) {
                // TODO: consider making featured items bolder inside ReadmeBuilder.addItem
                builder.addItem(item, { hasDetails: item.slug && markdowns.has(item.slug) });
            }

            builder.addNewLine();
        }

        return builder.build();
    }

    /**
     * Sort category IDs by priority, then alphabetically
     * @param groups Groups of items by category ID
     * @param categories Map of category details
     */
    private sortCategoriesByPriority(
        groups: Record<string, ItemData[]>,
        categories: Map<string, Category>,
    ): string[] {
        const categoryIds = Object.keys(groups);

        return categoryIds.sort((aId, bId) => {
            const categoryA = categories.get(aId);
            const categoryB = categories.get(bId);
            const featuredCountA = groups[aId].filter((item) => item.featured).length;
            const featuredCountB = groups[bId].filter((item) => item.featured).length;

            // Ensure categories with featured items always come first
            const aHasFeatured = featuredCountA > 0;
            const bHasFeatured = featuredCountB > 0;
            if (aHasFeatured !== bHasFeatured) {
                return aHasFeatured ? -1 : 1;
            }

            // If both have priority, sort by priority number (lower = higher priority)
            if (categoryA?.priority !== undefined && categoryB?.priority !== undefined) {
                return categoryA.priority - categoryB.priority;
            }
            // If only A has priority, A comes first
            if (categoryA?.priority !== undefined && categoryB?.priority === undefined) {
                return -1;
            }
            // If only B has priority, B comes first
            if (categoryA?.priority === undefined && categoryB?.priority !== undefined) {
                return 1;
            }

            if (featuredCountA !== featuredCountB) {
                return featuredCountB - featuredCountA;
            }

            // If neither has priority, sort alphabetically by name
            const nameA = categoryA?.name || aId;
            const nameB = categoryB?.name || bId;
            return nameA.localeCompare(nameB);
        });
    }

    private async loadCategories(data: DataRepository): Promise<Map<string, Category>> {
        const list = await data.getCategories();
        const categories = new Map<string, Category>();

        for (const category of list) {
            categories.set(category.id, category);
        }

        return categories;
    }

    private async loadTags(data: DataRepository): Promise<Map<string, Category>> {
        const list = await data.getTags();
        const tags = new Map<string, Category>();

        for (const tag of list) {
            tags.set(tag.id, tag);
        }

        return tags;
    }

    /* Works with both tags and categories */
    private populate<T extends Identifiable>(value: string | T, collection: Map<string, T>): T {
        const id = typeof value === 'string' ? value : value.id;
        const populated = collection.get(id);

        if (populated) {
            return populated;
        }

        if (typeof value === 'string') {
            const result = { id, name: value } as T;
            collection.set(id, result);
            return result;
        }

        collection.set(value.id, value);
        return value;
    }
}
