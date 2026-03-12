import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { format } from 'date-fns';
import type { ItemData, ItemHealth, ItemHealthStatus } from '@ever-works/contracts';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { GitFacadeService } from '../facades/git.facade';
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

@Injectable()
export class ItemHealthService {
    private readonly logger = new Logger(ItemHealthService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
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
            message: this.buildManualMessage(item.health?.status ?? 'unchecked'),
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
            concurrency: 8,
            timeout: { request: 15000 },
            retry: { limit: 1 },
        });

        let changedCount = 0;
        const checkedItems: ItemData[] = [];

        for (const item of itemsToCheck) {
            const result = results[item.source_url];
            const nextHealth = this.buildItemHealth(item.health, result, options.trigger);

            const updatedItem = await data.updateItem(item.slug!, {
                health: nextHealth,
            });

            if (updatedItem) {
                checkedItems.push(updatedItem);
            } else {
                checkedItems.push({ ...item, health: nextHealth });
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
                status: 'warning',
                checked_at: checkedAt,
                status_code: null,
                message: 'No response received for source URL',
                failure_count: previousFailures + 1,
                checked_via: trigger,
            };
        }

        const status = this.mapHealthStatus(result.status);
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

    private mapHealthStatus(status: CheckLinkResult['status']): ItemHealthStatus {
        switch (status) {
            case 'alive':
                return 'healthy';
            case 'invalid':
                return 'warning';
            case 'dead':
            default:
                return 'broken';
        }
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

        return 'Source URL is unreachable';
    }

    private buildCommitMessage(trigger: HealthCheckTrigger, itemCount: number): string {
        if (trigger === 'schedule') {
            return `chore: refresh item health for ${itemCount} item${itemCount === 1 ? '' : 's'}`;
        }

        return `chore: re-check item health for ${itemCount} item${itemCount === 1 ? '' : 's'}`;
    }

    private buildManualMessage(status: ItemHealthStatus): string {
        switch (status) {
            case 'healthy':
                return 'Item health check completed: source URL is healthy.';
            case 'warning':
                return 'Item health check completed with a warning.';
            case 'broken':
                return 'Item health check completed: source URL is broken.';
            case 'unchecked':
            default:
                return 'Item health check completed.';
        }
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
