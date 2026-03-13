import { Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { ItemHealthService } from './item-health.service';
import { User } from '@src/entities/user.entity';

export type ItemSourceValidationSchedulerResult = {
    processed: number;
    skipped: number;
    errors: { directoryId: string; message: string }[];
};

@Injectable()
export class ItemSourceValidationSchedulerService {
    private readonly logger = new Logger(ItemSourceValidationSchedulerService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly itemHealthService: ItemHealthService,
    ) {}

    async processAllDirectories(): Promise<ItemSourceValidationSchedulerResult> {
        const directories =
            await this.directoryRepository.findWithScheduledSourceValidationEnabled();

        const result: ItemSourceValidationSchedulerResult = {
            processed: 0,
            skipped: 0,
            errors: [],
        };

        for (const directory of directories) {
            const user = directory.user as User | undefined;
            if (!user) {
                result.skipped += 1;
                this.logger.warn(
                    `Skipping source validation for directory ${directory.id}: missing owner`,
                );
                continue;
            }

            try {
                await this.itemHealthService.runScheduledCheck(directory, user);
                result.processed += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push({ directoryId: directory.id, message });
                this.logger.error(
                    `Source validation failed for directory ${directory.id}`,
                    error instanceof Error ? error.stack : undefined,
                );
            }
        }

        return result;
    }
}
