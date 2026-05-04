import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { ComparisonGenerationService } from '@ever-works/agent/comparison-generator';
import { WorkRepository } from '@ever-works/agent/database';

@Injectable()
export class ComparisonSchedulerService {
    private readonly logger = new Logger(ComparisonSchedulerService.name);

    constructor(
        private readonly comparisonService: ComparisonGenerationService,
        private readonly workRepository: WorkRepository,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_6_HOURS)
    async handleComparisonGeneration() {
        await this.taskLockService.runExclusive(
            'works:comparison-scheduler',
            async () => {
                try {
                    this.logger.log('Starting scheduled comparison generation');

                    const works = await this.workRepository.findWithComparisonsEnabled();
                    let generated = 0;
                    let skipped = 0;
                    let errors = 0;

                    for (const work of works) {
                        try {
                            const result = await this.comparisonService.generateNextComparison(
                                work.id,
                                work.userId,
                                { respectCadence: true },
                            );

                            if (result.status === 'success') {
                                generated++;
                                this.logger.log(
                                    `Generated comparison for work ${work.id}: ${result.slug}`,
                                );
                            } else if (result.status === 'skipped') {
                                skipped++;
                            }
                        } catch (error) {
                            errors++;
                            const message = error instanceof Error ? error.message : String(error);
                            this.logger.error(
                                `Failed to generate comparison for work ${work.id}: ${message}`,
                            );
                        }
                    }

                    this.logger.log(
                        `Comparison generation completed: ${generated} generated, ${skipped} skipped, ${errors} errors`,
                    );
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Error during comparison generation', stack);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping scheduled comparison generation because another instance holds the task lock',
                    ),
            },
        );
    }
}
