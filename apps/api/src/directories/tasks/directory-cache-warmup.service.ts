import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_MANAGER, Cache, DistributedTaskLockService } from '@ever-works/agent/cache';
import { DirectoryRepository } from '@ever-works/agent/database';
import { GenerateStatusType } from '@ever-works/agent/entities';
import { DirectoryQueryService } from '@ever-works/agent/services';
import {
    getDirectoryCategoriesTagsCacheKey,
    DIRECTORY_CACHE_TTL_MS,
    getDirectoryConfigCacheKey,
    getDirectoryCountCacheKey,
    getDirectoryItemsCacheKey,
} from '../directory-cache.constants';
const CACHE_WARMUP_BATCH_SIZE = 25;
const CACHE_WARMUP_CURSOR_KEY = 'directory-cache-warmup-offset';
const CACHE_WARMUP_CURSOR_TTL_MS = 1000 * 60 * 60 * 24 * 30;

@Injectable()
export class DirectoryCacheWarmupService {
    private readonly logger = new Logger(DirectoryCacheWarmupService.name);

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryQueryService: DirectoryQueryService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES)
    async warmDirectoryCaches() {
        await this.taskLockService.runExclusive(
            'directories:cache-warmup',
            async () => {
                try {
                    const totalEligible =
                        await this.directoryRepository.countForDetailCacheWarmup();

                    if (totalEligible === 0) {
                        return;
                    }

                    const { directories, nextOffset, currentOffset } =
                        await this.getDirectoriesForCurrentWindow(totalEligible);

                    if (directories.length === 0) {
                        await this.cacheManager.set(
                            CACHE_WARMUP_CURSOR_KEY,
                            0,
                            CACHE_WARMUP_CURSOR_TTL_MS,
                        );
                        return;
                    }

                    let warmed = 0;
                    let skipped = 0;
                    let errors = 0;

                    for (const directory of directories) {
                        if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
                            skipped += 1;
                            continue;
                        }

                        if (!directory.user?.id) {
                            skipped += 1;
                            continue;
                        }

                        try {
                            const owner = directory.user;
                            const [items, config, count, categoriesTags] = await Promise.all([
                                this.directoryQueryService.directoryItems(directory.id, owner),
                                this.directoryQueryService.directoryConfig(directory.id, owner),
                                this.directoryQueryService.directoryCount(directory.id, owner),
                                this.directoryQueryService.directoryCategoriesTags(
                                    directory.id,
                                    owner,
                                ),
                            ]);

                            await Promise.all([
                                this.cacheManager.set(
                                    getDirectoryItemsCacheKey(directory.id, owner.id),
                                    items,
                                    DIRECTORY_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getDirectoryConfigCacheKey(directory.id, owner.id),
                                    config,
                                    DIRECTORY_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getDirectoryCountCacheKey(directory.id, owner.id),
                                    count,
                                    DIRECTORY_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getDirectoryCategoriesTagsCacheKey(directory.id, owner.id),
                                    categoriesTags,
                                    DIRECTORY_CACHE_TTL_MS,
                                ),
                            ]);

                            warmed += 1;
                        } catch (error) {
                            errors += 1;
                            const message = error instanceof Error ? error.message : String(error);
                            this.logger.warn(
                                `Failed to warm detail cache for directory ${directory.id}: ${message}`,
                            );
                        }
                    }

                    await this.cacheManager.set(
                        CACHE_WARMUP_CURSOR_KEY,
                        nextOffset,
                        CACHE_WARMUP_CURSOR_TTL_MS,
                    );

                    this.logger.log(
                        `Directory detail cache warm-up completed: ${warmed} warmed, ${skipped} skipped, ${errors} errors, offset ${currentOffset} -> ${nextOffset}, total eligible ${totalEligible}`,
                    );
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Error during directory detail cache warm-up', stack);
                }
            },
            {
                ttlMs: 9 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping directory cache warm-up because another instance holds the task lock',
                    ),
            },
        );
    }

    private async getDirectoriesForCurrentWindow(totalEligible: number) {
        if (totalEligible <= CACHE_WARMUP_BATCH_SIZE) {
            return {
                directories: await this.directoryRepository.findForDetailCacheWarmup(
                    CACHE_WARMUP_BATCH_SIZE,
                    0,
                ),
                currentOffset: 0,
                nextOffset: 0,
            };
        }

        const cachedOffset = await this.cacheManager.get<number | string>(CACHE_WARMUP_CURSOR_KEY);
        const parsedOffset = Number(cachedOffset ?? 0);
        const currentOffset =
            Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset % totalEligible : 0;

        const firstBatch = await this.directoryRepository.findForDetailCacheWarmup(
            CACHE_WARMUP_BATCH_SIZE,
            currentOffset,
        );

        let directories = firstBatch;

        if (firstBatch.length < CACHE_WARMUP_BATCH_SIZE) {
            const remainder = CACHE_WARMUP_BATCH_SIZE - firstBatch.length;
            const wrappedBatch = await this.directoryRepository.findForDetailCacheWarmup(
                remainder,
                0,
            );
            directories = [...firstBatch, ...wrappedBatch];
        }

        return {
            directories,
            currentOffset,
            nextOffset: (currentOffset + directories.length) % totalEligible,
        };
    }
}
