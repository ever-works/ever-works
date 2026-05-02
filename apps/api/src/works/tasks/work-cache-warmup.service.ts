import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_MANAGER, Cache, DistributedTaskLockService } from '@ever-works/agent/cache';
import { WorkRepository } from '@ever-works/agent/database';
import { GenerateStatusType } from '@ever-works/agent/entities';
import { WorkQueryService } from '@ever-works/agent/services';
import {
    getWorkCategoriesTagsCacheKey,
    WORK_CACHE_TTL_MS,
    getWorkConfigCacheKey,
    getWorkCountCacheKey,
    getWorkItemsCacheKey,
} from '../work-cache.constants';
const CACHE_WARMUP_BATCH_SIZE = 25;
const CACHE_WARMUP_CURSOR_KEY = 'work-cache-warmup-offset';
const CACHE_WARMUP_CURSOR_TTL_MS = 1000 * 60 * 60 * 24 * 30;

@Injectable()
export class WorkCacheWarmupService {
    private readonly logger = new Logger(WorkCacheWarmupService.name);

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly workRepository: WorkRepository,
        private readonly workQueryService: WorkQueryService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES)
    async warmWorkCaches() {
        await this.taskLockService.runExclusive(
            'works:cache-warmup',
            async () => {
                try {
                    const totalEligible = await this.workRepository.countForDetailCacheWarmup();

                    if (totalEligible === 0) {
                        return;
                    }

                    const { works, nextOffset, currentOffset } =
                        await this.getWorksForCurrentWindow(totalEligible);

                    if (works.length === 0) {
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

                    for (const work of works) {
                        if (work.generateStatus?.status === GenerateStatusType.GENERATING) {
                            skipped += 1;
                            continue;
                        }

                        if (!work.user?.id) {
                            skipped += 1;
                            continue;
                        }

                        try {
                            const owner = work.user;
                            const [items, config, count, categoriesTags] = await Promise.all([
                                this.workQueryService.workItems(work.id, owner),
                                this.workQueryService.workConfig(work.id, owner),
                                this.workQueryService.workCount(work.id, owner),
                                this.workQueryService.workCategoriesTags(work.id, owner),
                            ]);

                            await Promise.all([
                                this.cacheManager.set(
                                    getWorkItemsCacheKey(work.id, owner.id),
                                    items,
                                    WORK_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getWorkConfigCacheKey(work.id, owner.id),
                                    config,
                                    WORK_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getWorkCountCacheKey(work.id, owner.id),
                                    count,
                                    WORK_CACHE_TTL_MS,
                                ),
                                this.cacheManager.set(
                                    getWorkCategoriesTagsCacheKey(work.id, owner.id),
                                    categoriesTags,
                                    WORK_CACHE_TTL_MS,
                                ),
                            ]);

                            warmed += 1;
                        } catch (error) {
                            errors += 1;
                            const message = error instanceof Error ? error.message : String(error);
                            this.logger.warn(
                                `Failed to warm detail cache for work ${work.id}: ${message}`,
                            );
                        }
                    }

                    await this.cacheManager.set(
                        CACHE_WARMUP_CURSOR_KEY,
                        nextOffset,
                        CACHE_WARMUP_CURSOR_TTL_MS,
                    );

                    this.logger.log(
                        `Work detail cache warm-up completed: ${warmed} warmed, ${skipped} skipped, ${errors} errors, offset ${currentOffset} -> ${nextOffset}, total eligible ${totalEligible}`,
                    );
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Error during work detail cache warm-up', stack);
                }
            },
            {
                ttlMs: 9 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping work cache warm-up because another instance holds the task lock',
                    ),
            },
        );
    }

    private async getWorksForCurrentWindow(totalEligible: number) {
        if (totalEligible <= CACHE_WARMUP_BATCH_SIZE) {
            return {
                works: await this.workRepository.findForDetailCacheWarmup(
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

        const firstBatch = await this.workRepository.findForDetailCacheWarmup(
            CACHE_WARMUP_BATCH_SIZE,
            currentOffset,
        );

        let works = firstBatch;

        if (firstBatch.length < CACHE_WARMUP_BATCH_SIZE) {
            const remainder = CACHE_WARMUP_BATCH_SIZE - firstBatch.length;
            const wrappedBatch = await this.workRepository.findForDetailCacheWarmup(remainder, 0);
            works = [...firstBatch, ...wrappedBatch];
        }

        return {
            works,
            currentOffset,
            nextOffset: (currentOffset + works.length) % totalEligible,
        };
    }
}
