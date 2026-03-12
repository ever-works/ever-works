import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { format } from 'date-fns';
import { z } from 'zod';
import type {
    ItemData,
    ItemHealth,
    ItemHealthStatus,
    ItemSourceValidation,
} from '@ever-works/contracts';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { GitFacadeService } from '../facades/git.facade';
import { AiFacadeService } from '../facades/ai.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import type { CheckItemHealthResponseDto } from '../items-generator/dto';

type HealthCheckTrigger = 'manual' | 'schedule';

type CheckLinkResult = {
    status: 'alive' | 'dead' | 'invalid';
    statusCode?: number;
};

type CheckLinksFn = (
    urls: string[],
    options?: {
        concurrency?: number;
        timeout?: { request?: number };
        retry?: { limit?: number };
    },
) => Promise<Record<string, CheckLinkResult>>;

type DirectoryHealthCheckResult = {
    checkedCount: number;
    changedCount: number;
    items: ItemData[];
};

const sourceValidationSchema = z.object({
    accuracy_status: z.enum(['accurate', 'generic', 'weak', 'unknown']),
    confidence_score: z.number().min(0).max(1),
    is_relevant: z.boolean(),
    is_specific: z.boolean(),
    is_official: z.boolean(),
    reason: z.string(),
    suggested_source_url: z.string().url().nullable().optional(),
});

const SOURCE_VALIDATION_PROMPT = `You are validating whether a URL is a good source for a directory item.

Return a judgment about the source quality, not just whether the URL opens.

Item Name: {itemName}
Item Description: {itemDescription}
Candidate URL: {candidateUrl}
HTTP Check Summary: {httpSummary}
Extracted Page Content (first 2000 chars): {pageContent}

Decide whether this URL is:
- accurate: clearly the right, relevant, and specific source for the item
- generic: reachable and relevant, but too generic (homepage/root domain/company home)
- weak: somewhat related, but weak, indirect, or not a good canonical source
- unknown: not enough evidence to judge confidently

Rules:
- Prefer official product pages, official documentation, official repositories, or canonical package pages.
- A generic company homepage is usually generic if it does not clearly focus on the item itself.
- Blog posts, news articles, and third-party reviews are usually weak unless they are the only credible source.
- If the item is a product/feature but the URL is only a root domain or broad company homepage, prefer generic instead of accurate.
- If the HTTP check already indicates the link is clearly broken, do not return accurate.
- Be conservative. If unsure, return unknown.
`;

@Injectable()
export class ItemHealthService {
    private readonly logger = new Logger(ItemHealthService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly aiFacade: AiFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        @Optional()
        private readonly ownershipService?: DirectoryOwnershipService,
    ) {}

    async checkItem(
        directoryId: string,
        itemSlug: string,
        user: User,
    ): Promise<CheckItemHealthResponseDto> {
        if (!this.ownershipService) {
            throw new NotFoundException('Item health service is not available for manual checks');
        }

        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        const result = await this.checkDirectoryItems(directory, user, {
            trigger: 'manual',
            itemSlugs: [itemSlug],
        });

        const item = result.items[0];
        if (!item) {
            throw new NotFoundException(`Item '${itemSlug}' not found`);
        }

        return {
            status: 'success',
            item_slug: item.slug || itemSlug,
            item_name: item.name,
            message: this.buildManualMessage(item.health, item.source_validation),
            item,
            health: item.health,
        };
    }

    async runScheduledCheck(directory: Directory, user: User): Promise<void> {
        try {
            await this.checkDirectoryItems(directory, user, { trigger: 'schedule' });
        } catch (error) {
            this.logger.warn(
                `Failed scheduled item health check for directory ${directory.slug}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async checkDirectoryItems(
        directory: Directory,
        user: User,
        options: { trigger: HealthCheckTrigger; itemSlugs?: string[] },
    ): Promise<DirectoryHealthCheckResult> {
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
        const allItems = await data.getItems();

        const itemsToCheck = allItems
            .filter((item): item is ItemData => Boolean(item))
            .filter((item) => {
                if (!item.slug || !item.source_url) {
                    return false;
                }

                if (!options.itemSlugs?.length) {
                    return true;
                }

                return options.itemSlugs.includes(item.slug);
            });

        if (options.itemSlugs?.length && itemsToCheck.length === 0) {
            return {
                checkedCount: 0,
                changedCount: 0,
                items: [],
            };
        }

        if (itemsToCheck.length === 0) {
            return {
                checkedCount: 0,
                changedCount: 0,
                items: [],
            };
        }

        const checkLinks = await this.loadChecker();
        const uniqueUrls = [...new Set(itemsToCheck.map((item) => item.source_url))];
        const results = await checkLinks(uniqueUrls, {
            concurrency: 4,
            timeout: { request: 30000 },
            retry: { limit: 2 },
        });

        let changedCount = 0;
        const checkedItems: ItemData[] = [];

        for (const item of itemsToCheck) {
            const result = results[item.source_url];
            const nextHealth = this.buildItemHealth(item.health, result, options.trigger);
            const nextSourceValidation = await this.buildSourceValidation(
                item,
                nextHealth,
                directory,
                user,
            );

            const updatedItem = await data.updateItem(item.slug!, {
                health: nextHealth,
                source_validation: nextSourceValidation,
            });

            if (updatedItem) {
                checkedItems.push(updatedItem);
            } else {
                checkedItems.push({
                    ...item,
                    health: nextHealth,
                    source_validation: nextSourceValidation,
                });
            }

            if (!this.areHealthStatesEqual(item.health, nextHealth)) {
                changedCount += 1;
            }
        }

        if (checkedItems.length > 0) {
            await this.gitFacade.addAll(directory.gitProvider, data.dir);
            await this.gitFacade.commit(
                directory.gitProvider,
                data.dir,
                this.buildCommitMessage(options.trigger, checkedItems.length),
                committer,
            );
            await this.gitFacade.push(
                { dir: dest },
                { userId: directoryOwner.id, providerId: directory.gitProvider },
            );
        }

        return {
            checkedCount: checkedItems.length,
            changedCount,
            items: checkedItems,
        };
    }

    private buildItemHealth(
        previous: ItemHealth | undefined,
        result: CheckLinkResult | undefined,
        trigger: HealthCheckTrigger,
    ): ItemHealth {
        const checkedAt = format(new Date(), 'yyyy-MM-dd HH:mm');
        const previousFailures = previous?.failure_count || 0;

        if (!result) {
            return {
                status: 'unknown',
                checked_at: checkedAt,
                status_code: null,
                message: 'Automated check could not verify the source URL',
                failure_count: previousFailures + 1,
                checked_via: trigger,
            };
        }

        const status = this.mapHealthStatus(result);
        const failureCount = status === 'healthy' ? 0 : previousFailures + 1;

        return {
            status,
            checked_at: checkedAt,
            status_code: result.statusCode ?? null,
            message: this.buildHealthMessage(result, status),
            failure_count: failureCount,
            checked_via: trigger,
        };
    }

    private mapHealthStatus(result: CheckLinkResult): ItemHealthStatus {
        if (result.status === 'alive') {
            return 'healthy';
        }

        if (result.status === 'invalid') {
            return 'broken';
        }

        const statusCode = result.statusCode;
        if (statusCode === 404 || statusCode === 410) {
            return 'broken';
        }

        if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
            return 'unknown';
        }

        if (statusCode && statusCode >= 500) {
            return 'unknown';
        }

        return 'unknown';
    }

    private buildHealthMessage(result: CheckLinkResult, status: ItemHealthStatus): string | null {
        if (status === 'healthy') {
            return null;
        }

        if (result.status === 'invalid') {
            return 'Invalid or unsupported source URL';
        }

        if (result.statusCode) {
            return `Source URL returned HTTP ${result.statusCode}`;
        }

        return 'Automated check could not verify the source URL';
    }

    private async buildSourceValidation(
        item: ItemData,
        health: ItemHealth,
        directory: Directory,
        user: User,
    ): Promise<ItemSourceValidation> {
        const checkedAt = health.checked_at || format(new Date(), 'yyyy-MM-dd HH:mm');
        const baseReachabilityStatus = this.mapReachabilityStatus(health);

        if (baseReachabilityStatus === 'broken') {
            return {
                reachability_status: 'broken',
                accuracy_status: 'unknown',
                checked_at: checkedAt,
                confidence_score: 1,
                is_relevant: false,
                is_specific: false,
                is_official: false,
                reason: health.message || 'Source URL is broken',
                suggested_source_url: null,
            };
        }

        if (!this.aiFacade.isConfigured()) {
            return {
                reachability_status: baseReachabilityStatus,
                accuracy_status: 'unknown',
                checked_at: checkedAt,
                confidence_score: null,
                is_relevant: false,
                is_specific: false,
                is_official: false,
                reason: 'AI source validation is not configured',
                suggested_source_url: null,
            };
        }

        const extracted = await this.contentExtractorFacade.extractContent(
            item.source_url,
            undefined,
            {
                userId: user.id,
                directoryId: directory.id,
            },
        );

        const pageContent = extracted?.rawContent?.slice(0, 2000) || '';
        const reachabilityStatus = this.resolveReachabilityStatus(
            baseReachabilityStatus,
            pageContent,
        );
        const httpSummary = this.buildHttpSummary(health);

        try {
            const { result } = await this.aiFacade.askJson(
                SOURCE_VALIDATION_PROMPT,
                sourceValidationSchema,
                {
                    variables: {
                        itemName: item.name,
                        itemDescription: item.description || '',
                        candidateUrl: item.source_url,
                        httpSummary,
                        pageContent,
                    },
                    routing: {
                        complexity: 'simple',
                        autoEscalate: true,
                    },
                    temperature: 0,
                },
                {
                    userId: user.id,
                    directoryId: directory.id,
                },
            );

            return {
                reachability_status: reachabilityStatus,
                accuracy_status: result.accuracy_status,
                checked_at: checkedAt,
                confidence_score: result.confidence_score,
                is_relevant: result.is_relevant,
                is_specific: result.is_specific,
                is_official: result.is_official,
                reason: result.reason,
                suggested_source_url: result.suggested_source_url ?? null,
            };
        } catch (error) {
            this.logger.warn(
                `AI source validation failed for ${item.source_url}: ${error instanceof Error ? error.message : String(error)}`,
            );

            return {
                reachability_status: reachabilityStatus,
                accuracy_status: 'unknown',
                checked_at: checkedAt,
                confidence_score: null,
                is_relevant: false,
                is_specific: false,
                is_official: false,
                reason: 'AI could not validate this source',
                suggested_source_url: null,
            };
        }
    }

    private mapReachabilityStatus(health: ItemHealth): ItemSourceValidation['reachability_status'] {
        if (health.status === 'healthy') {
            return 'reachable';
        }

        if (health.status === 'broken') {
            return 'broken';
        }

        return 'unknown';
    }

    private buildHttpSummary(health: ItemHealth): string {
        const parts: string[] = [`status=${health.status}`];

        if (health.status_code) {
            parts.push(`status_code=${health.status_code}`);
        }

        if (health.message) {
            parts.push(`message=${health.message}`);
        }

        return parts.join(', ');
    }

    private buildCommitMessage(trigger: HealthCheckTrigger, itemCount: number): string {
        if (trigger === 'schedule') {
            return `chore: refresh item health for ${itemCount} item${itemCount === 1 ? '' : 's'}`;
        }

        return `chore: re-check item health for ${itemCount} item${itemCount === 1 ? '' : 's'}`;
    }

    private buildManualMessage(
        health: ItemHealth | undefined,
        validation: ItemSourceValidation | undefined,
    ): string {
        const parts: string[] = ['Item source check completed.'];

        if (validation) {
            parts.push(this.buildReachabilitySummary(validation));
            parts.push(this.buildAccuracySummary(validation));
        } else if (health?.status === 'broken') {
            parts.push('Reachability: broken link.');
        } else if (health?.status === 'healthy') {
            parts.push('Reachability: reachable.');
        } else if (health?.status === 'unknown' || health?.status === 'warning') {
            parts.push('Reachability: could not verify.');
        }

        if (validation?.reason && validation.accuracy_status !== 'accurate') {
            parts.push(validation.reason);
        }

        if (
            !validation &&
            health?.message &&
            health.status !== 'healthy' &&
            health.message !== 'Automated check could not verify the source URL'
        ) {
            parts.push(health.message);
        }

        return parts.join(' ');
    }

    private buildReachabilitySummary(validation: ItemSourceValidation): string {
        switch (validation.reachability_status) {
            case 'reachable':
                return 'Reachability: reachable.';
            case 'broken':
                return 'Reachability: broken link.';
            case 'unknown':
            default:
                return 'Reachability: automated check was inconclusive.';
        }
    }

    private buildAccuracySummary(validation: ItemSourceValidation): string {
        switch (validation.accuracy_status) {
            case 'accurate':
                return 'Source accuracy: accurate.';
            case 'generic':
                return 'Source accuracy: too generic.';
            case 'weak':
                return 'Source accuracy: weak.';
            case 'unknown':
            default:
                return 'Source accuracy: unknown.';
        }
    }

    private resolveReachabilityStatus(
        baseReachabilityStatus: ItemSourceValidation['reachability_status'],
        pageContent: string,
    ): ItemSourceValidation['reachability_status'] {
        if (baseReachabilityStatus !== 'unknown') {
            return baseReachabilityStatus;
        }

        if (pageContent.trim().length > 0) {
            return 'reachable';
        }

        return 'unknown';
    }

    private areHealthStatesEqual(previous: ItemHealth | undefined, next: ItemHealth): boolean {
        if (!previous) {
            return false;
        }

        return (
            previous.status === next.status &&
            previous.status_code === next.status_code &&
            previous.message === next.message &&
            previous.failure_count === next.failure_count &&
            previous.checked_via === next.checked_via
        );
    }

    private async loadChecker(): Promise<CheckLinksFn> {
        const module = (await import('check-links')) as { default: CheckLinksFn };
        return module.default;
    }
}
