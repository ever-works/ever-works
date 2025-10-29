import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import { DIRECTORY_OPERATIONS, DirectoryOperations } from '@src/directory';
import { GenerateStatusType } from '@src/entities/types';

export type TriggerGenerationOptions = {
    directory: Directory;
    user: User;
    dto: CreateItemsGeneratorDto;
};

@Injectable()
export class TriggerGenerationOrchestrator {
    private readonly logger = new Logger(TriggerGenerationOrchestrator.name);

    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
    ) {}

    async run({ directory, user, dto }: TriggerGenerationOptions) {
        const startTime = new Date();

        await Promise.all([
            this.directoryOperations.recordGenerationStartTime(directory.id, startTime),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        let hasError = false;

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto);

            if (generated) {
                await this.markdownGenerator.initialize(directory, user, {
                    repository_description: dto.repository_description,
                    generation_method: generated.generation_method,
                    pr_update: generated.prUpdate,
                });
            }

            await this.websiteGenerator.initialize(
                directory,
                user,
                dto.website_repository_creation_method,
            );
        } catch (error) {
            hasError = true;

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, new Date()),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: error instanceof Error ? error.message : String(error),
                }),
            ]);

            this.logger.error('Generation failed', error as Error);
            throw error;
        } finally {
            if (!hasError) {
                await Promise.all([
                    this.directoryOperations.recordGenerationFinishTime(directory.id, new Date()),
                    this.directoryOperations.updateGenerateStatus(directory.id, {
                        status: GenerateStatusType.GENERATED,
                        step: null,
                    }),
                ]);
            }

            await this.directoryOperations.emitGenerationCompleted(directory);
        }
    }
}
