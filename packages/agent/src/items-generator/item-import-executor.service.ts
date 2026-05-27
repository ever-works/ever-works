import { Injectable, Logger } from '@nestjs/common';
import pMap from 'p-map';
import { format } from 'date-fns';
import type { MutableItemData } from '@ever-works/contracts';
import { GitFacadeService } from '../facades/git.facade';
import { Work } from '../entities/work.entity';
import { User } from '../entities/user.entity';
import { DataRepository } from '../generators/data-generator/data-repository';
import { slugifyText } from '../utils/text.utils';
import { config as appConfig } from '../config';
import { ItemImportService } from './item-import.service';
import type {
    ImportDuplicateStrategy,
    ImportResult,
    ImportRowData,
    ImportRowValidation,
} from './item-import-export.types';

/**
 * Concurrency cap for the per-row YAML write step.
 *
 * **Bounded for two reasons:**
 *   1. The downstream `DataRepository` writes touch the same on-disk
 *      git working tree — high concurrency thrashes the fs cache and
 *      can race on intermediate index updates. 5 is empirically the
 *      sweet spot between throughput and write-contention noise.
 *   2. Each write may resolve images / brand logos via inline URL
 *     validation; uncapped parallelism would fan out hundreds of
 *     simultaneous network probes per import batch.
 *
 * Don't push past ~10 without re-measuring. The whole bulk-write is
 * still bounded above by `MAX_IMPORT_ROWS_CEILING` (currently 2000)
 * so even at low concurrency, worst-case wall-time stays in the
 * "minutes, not hours" bucket.
 */
const WRITE_CONCURRENCY = 5;

export interface ExecuteImportInput {
    rows: ReadonlyArray<ImportRowValidation>;
    duplicate_strategy: ImportDuplicateStrategy;
    /**
     * Status to apply to rows that don't specify one. Currently informational
     * — the column contract has no `status` field yet — but kept on the DTO
     * so the wizard can collect it and Phase 4 can wire it up. Defaults to
     * `'pending'` at the controller layer.
     */
    default_status?: string;
}

export interface ExecuteImportResult extends ImportResult {
    pr_url?: string;
    pr_number?: number;
    direct_commit?: boolean;
}

/**
 * Bulk-write side of EW-533 Phase 3. Reuses the same git primitives as
 * `ItemSubmissionService.submitItem` — clone/pull → switch branch → write
 * YAMLs with `p-map` concurrency → single commit + push → optional PR.
 *
 * The validated rows come from Phase 2's `/import-items/validate`. Phase 3
 * re-checks duplicates against the freshly cloned data repo before writing
 * so a concurrent change between Validate and Execute doesn't slip through.
 */
@Injectable()
export class ItemImportExecutorService {
    private readonly logger = new Logger(ItemImportExecutorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly itemImportService: ItemImportService,
    ) {}

    async executeImport(
        work: Work,
        user: User,
        input: ExecuteImportInput,
    ): Promise<ExecuteImportResult> {
        const workOwner = work.user as User;
        const committer = work.resolveCommitter(user);
        const repo = work.getDataRepo();
        const owner = work.getRepoOwner();
        const provider = work.gitProvider;

        const dest = await this.gitFacade.cloneOrPull(
            { owner, repo, committer },
            { userId: workOwner.id, providerId: work.gitProvider, workId: work.id },
        );

        const data = await DataRepository.create(dest);
        const config = await data.getConfig().catch((error) => {
            this.logger.warn('Failed to read directory config; assuming autoapproval=false', error);
            return null;
        });
        const autoApproval = config?.autoapproval === true;

        // Snapshot existing items for duplicate detection at execute time.
        const existingItems = (await data.getItems()).filter(
            (entry): entry is NonNullable<typeof entry> => entry !== null,
        );
        const existingSlugs = new Set<string>();
        const existingUrls = new Set<string>();
        // Map source_url → existing item's slug. When `duplicate_strategy=update`
        // matches a row by URL only and the incoming row's slug differs from
        // the existing item's directory, the update must target the existing
        // slug — otherwise `writeItem` (which skips `createItemDir` on update)
        // tries to write into a directory that doesn't exist.
        const urlToExistingSlug = new Map<string, string>();
        for (const item of existingItems) {
            if (item.slug) existingSlugs.add(item.slug);
            if (item.source_url) {
                existingUrls.add(item.source_url);
                if (item.slug) urlToExistingSlug.set(item.source_url, item.slug);
            }
        }

        const defaultBranch = await this.gitFacade.getMainBranch(provider, dest);
        const shouldCreatePR = !autoApproval;
        let branchName: string | null = null;
        if (shouldCreatePR) {
            branchName = await this.gitFacade.switchBranch(
                provider,
                dest,
                `items-import-${Date.now()}`,
                true,
            );
        } else if (defaultBranch) {
            await this.gitFacade.switchBranch(provider, dest, defaultBranch);
        }

        const validRows = input.rows.filter(
            (row): row is ImportRowValidation & { data: ImportRowData } =>
                row.valid && row.data !== undefined,
        );

        let createdCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const errors: { rowIndex: number; message: string }[] = [];

        // Two-pass design — the previous single-pass loop ran in `pMap` with
        // concurrency=5 AND mutated the shared `existingSlugs` / `existingUrls`
        // sets after each write. Two rows whose name-derived slugs collide
        // could both pass `existingSlugs.has(slug)` before either had finished
        // writing, so the second `writeItem` would silently overwrite the
        // first while the result counter said "2 created".
        //
        // Pass 1 (this loop): serial. Revalidate, build the canonical
        // `itemData`, classify as create/update/skip/error, and **claim** the
        // slug + source_url against the shared sets immediately. This is
        // CPU-only — no I/O — so going serial here is cheap and gives us
        // deterministic intra-batch collision detection.
        //
        // Pass 2 (the `pMap` below): parallel. Only the disk + git writes,
        // each operating on the already-classified plan entry. No shared
        // mutation, no race.
        type PlanEntry =
            | { kind: 'create'; rowIndex: number; itemData: MutableItemData }
            | { kind: 'update'; rowIndex: number; itemData: MutableItemData };
        const plan: PlanEntry[] = [];

        for (const row of validRows) {
            const revalidated = this.itemImportService.revalidateImportRowData(
                row.data,
                row.rowIndex,
            );
            if (!revalidated.valid || !revalidated.data) {
                errors.push({
                    rowIndex: row.rowIndex,
                    message: `Server-side validation failed: ${revalidated.errors.join('; ')}`,
                });
                continue;
            }
            const itemData = this.buildItemData(revalidated.data);
            const slug = itemData.slug ?? '';
            const isDuplicate =
                (slug.length > 0 && existingSlugs.has(slug)) ||
                (typeof itemData.source_url === 'string' && existingUrls.has(itemData.source_url));

            if (isDuplicate) {
                if (input.duplicate_strategy === 'skip') {
                    skippedCount += 1;
                    continue;
                }
                const matchedBySlug = slug.length > 0 && existingSlugs.has(slug);
                const sourceUrl =
                    typeof itemData.source_url === 'string' ? itemData.source_url : undefined;
                // If the row matched only by source_url and the incoming slug
                // differs from the existing item's directory, rewrite the slug
                // so `writeItem` targets the correct existing directory.
                const existingSlug = sourceUrl ? urlToExistingSlug.get(sourceUrl) : undefined;
                const updateData: MutableItemData =
                    !matchedBySlug && existingSlug && existingSlug !== slug
                        ? { ...itemData, slug: existingSlug }
                        : itemData;
                plan.push({ kind: 'update', rowIndex: row.rowIndex, itemData: updateData });
                // Even on update, mark the URL as taken so a subsequent row
                // with the same source_url is also routed to update / skip
                // instead of trying to create a fresh item directory.
                if (sourceUrl) existingUrls.add(sourceUrl);
                continue;
            }

            plan.push({ kind: 'create', rowIndex: row.rowIndex, itemData });
            if (slug.length > 0) existingSlugs.add(slug);
            if (typeof itemData.source_url === 'string') existingUrls.add(itemData.source_url);
        }

        await pMap(
            plan,
            async (entry) => {
                try {
                    if (entry.kind === 'update') {
                        await data.writeItem(entry.itemData);
                        updatedCount += 1;
                        return;
                    }
                    await data.createItemDir(entry.itemData);
                    await data.writeItem(entry.itemData);
                    createdCount += 1;
                } catch (error) {
                    this.logger.error(
                        `Failed to write item at row ${entry.rowIndex}`,
                        error instanceof Error ? error.stack : String(error),
                    );
                    errors.push({
                        rowIndex: entry.rowIndex,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            },
            { concurrency: WRITE_CONCURRENCY },
        );

        const wrote = createdCount + updatedCount;
        if (wrote === 0) {
            this.logger.log(
                `Bulk import: no items written (skipped=${skippedCount}, errors=${errors.length}) — skipping commit/push`,
            );
            return {
                total: input.rows.length,
                created: createdCount,
                updated: updatedCount,
                skipped: skippedCount,
                errors,
            };
        }

        await this.gitFacade.add(provider, dest, '.');
        const commitTitle = buildCommitTitle(createdCount, updatedCount);
        await this.gitFacade.commit(provider, dest, commitTitle, committer);
        await this.gitFacade.push(
            { dir: dest },
            { userId: workOwner.id, providerId: work.gitProvider, workId: work.id },
        );

        if (!shouldCreatePR || !branchName || !defaultBranch) {
            return {
                total: input.rows.length,
                created: createdCount,
                updated: updatedCount,
                skipped: skippedCount,
                errors,
                direct_commit: true,
            };
        }

        const prTitle = `${commitTitle} - ${format(new Date(), 'MM/dd/yyyy HH:mm')}`;
        const prBody =
            `Bulk CSV/Excel item import.\n\n` +
            `- Created: ${createdCount}\n` +
            `- Updated: ${updatedCount}\n` +
            `- Skipped (duplicates): ${skippedCount}\n` +
            `- Errors: ${errors.length}\n\n` +
            `Generated by [${appConfig.branding.getAppName()}](${appConfig.branding.getPlatformWebsite()})`;

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
        this.logger.log(`Bulk-import PR #${pr.number} created for work ${work.slug}`);

        return {
            total: input.rows.length,
            created: createdCount,
            updated: updatedCount,
            skipped: skippedCount,
            errors,
            pr_url: pr.url,
            pr_number: pr.number,
        };
    }

    private buildItemData(row: ImportRowData): MutableItemData {
        // Prefer `categories` (array) when provided; fall back to `category`
        // string. Matches `ItemSubmissionService.submitItem`'s handling.
        const category: MutableItemData['category'] | undefined =
            row.categories && row.categories.length > 0
                ? row.categories
                : row.category && row.category.length > 0
                  ? row.category
                  : undefined;
        const slug = slugifyText(row.slug || row.name);
        return {
            name: row.name,
            description: row.description,
            source_url: row.source_url,
            category: category ?? '',
            tags: row.tags ?? [],
            featured: row.featured ?? false,
            order: row.order,
            slug,
            brand: row.brand,
            brand_logo_url: row.brand_logo_url ?? null,
            images: row.images ?? [],
        };
    }
}

function buildCommitTitle(created: number, updated: number): string {
    if (created > 0 && updated > 0) {
        return `Bulk import: ${created} created, ${updated} updated`;
    }
    if (created > 0) {
        return `Bulk import: ${created} item${created === 1 ? '' : 's'} added`;
    }
    return `Bulk import: ${updated} item${updated === 1 ? '' : 's'} updated`;
}
