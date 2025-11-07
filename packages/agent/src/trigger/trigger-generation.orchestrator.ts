import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import { DIRECTORY_OPERATIONS } from '@src/directory';
import type { DirectoryOperations } from '@src/directory';
import { GenerateStatusType } from '@src/entities/types';
import { ItemsGeneratorMetrics } from '@src/items-generator/dto/items-generator-response.dto';

type GenerationStats = {
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    metrics?: ItemsGeneratorMetrics;
};

export type TriggerGenerationOptions = {
    directory: Directory;
    user: User;
    dto: CreateItemsGeneratorDto;
    historyId: string;
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

    async run({ directory, user, dto, historyId }: TriggerGenerationOptions) {
        const startTime = new Date();

        await Promise.all([
            this.directoryOperations.recordGenerationStartTime(directory.id, startTime),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        await this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
            startedAt: startTime,
            status: GenerateStatusType.GENERATING,
        });

        let hasError = false;
        let generationStats: GenerationStats | null = null;

        try {
            const generated = await this.dataGenerator.initialize(directory, user, dto);

            if (generated !== false && generated?.stats) {
                generationStats = generated.stats as GenerationStats;
            }

            if (generated !== false && (generated.stats?.totalItemsCount ?? 0) > 0) {
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

            await this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                newItemsCount: generationStats?.newItemsCount ?? 0,
                updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                totalItemsCount: generationStats?.totalItemsCount ?? 0,
                metrics: generationStats?.metrics,
            });
        } catch (error) {
            hasError = true;

            await Promise.all([
                this.directoryOperations.recordGenerationFinishTime(directory.id, new Date()),
                this.directoryOperations.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: error instanceof Error ? error.message : String(error),
                }),
            ]);

            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            await this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                status: GenerateStatusType.ERROR,
                finishedAt: endTime,
                durationInSeconds: duration,
                errorMessage: error instanceof Error ? error.message : String(error),
                newItemsCount: generationStats?.newItemsCount ?? 0,
                updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                totalItemsCount: generationStats?.totalItemsCount ?? 0,
                metrics: generationStats?.metrics,
            });

            this.logger.error('Generation failed', error as Error);
            throw error;
        } finally {
            if (!hasError) {
                const endTime = new Date();
                const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

                await Promise.all([
                    this.directoryOperations.recordGenerationFinishTime(directory.id, endTime),
                    this.directoryOperations.updateGenerateStatus(directory.id, {
                        status: GenerateStatusType.GENERATED,
                        step: null,
                    }),
                    this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                        status: GenerateStatusType.GENERATED,
                        finishedAt: endTime,
                        durationInSeconds: duration,
                        newItemsCount: generationStats?.newItemsCount ?? 0,
                        updatedItemsCount: generationStats?.updatedItemsCount ?? 0,
                        totalItemsCount: generationStats?.totalItemsCount ?? 0,
                        metrics: generationStats?.metrics,
                    }),
                ]);
            }

            await this.directoryOperations.emitGenerationCompleted(directory);
        }
    }
}
