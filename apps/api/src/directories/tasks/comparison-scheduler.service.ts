import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ComparisonGenerationService } from '@ever-works/agent/comparison-generator';
import { DirectoryRepository } from '@ever-works/agent/database';

@Injectable()
export class ComparisonSchedulerService {
    private readonly logger = new Logger(ComparisonSchedulerService.name);

    constructor(
        private readonly comparisonService: ComparisonGenerationService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    @Cron(CronExpression.EVERY_6_HOURS)
    async handleComparisonGeneration() {
        try {
            this.logger.log('Starting scheduled comparison generation');

            const directories = await this.directoryRepository.findWithComparisonsEnabled();
            let generated = 0;
            let skipped = 0;
            let errors = 0;

            for (const directory of directories) {
                try {
                    const result = await this.comparisonService.generateNextComparison(
                        directory.id,
                        directory.userId,
                    );

                    if (result.status === 'success') {
                        generated++;
                        this.logger.log(
                            `Generated comparison for directory ${directory.id}: ${result.slug}`,
                        );
                    } else if (result.status === 'skipped') {
                        skipped++;
                    }
                } catch (error) {
                    errors++;
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.error(
                        `Failed to generate comparison for directory ${directory.id}: ${message}`,
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
    }
}
