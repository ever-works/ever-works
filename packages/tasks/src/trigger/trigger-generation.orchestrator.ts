import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataGeneratorService } from '@packages/agent/data-generator';
import { MarkdownGeneratorService } from '@packages/agent/markdown-generator';
import { WebsiteGeneratorService } from '@packages/agent/website-generator';
import { Directory, User, GenerateStatusType } from '@packages/agent/entities';
import { CreateItemsGeneratorDto } from '@packages/agent/items-generator';
import { DIRECTORY_OPERATIONS } from '@packages/agent/directory-operations';
import type { DirectoryOperations } from '@packages/agent/directory-operations';
import { ItemsGeneratorMetrics } from '@packages/agent/items-generator';

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
    historyStartedAt?: string;
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

    async run({ directory, user, dto, historyId, historyStartedAt }: TriggerGenerationOptions) {
        const startTime = this.resolveStartTime(historyStartedAt);

        await Promise.all([
            this.directoryOperations.recordGenerationStartTime(directory.id, startTime),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
            this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                status: GenerateStatusType.GENERATING,
                startedAt: startTime,
            }),
        ]);

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

    private resolveStartTime(historyStartedAt?: string): Date {
        if (!historyStartedAt) {
            return new Date();
        }

        const parsed = new Date(historyStartedAt);

        if (Number.isNaN(parsed.getTime())) {
            this.logger.warn(
                `Invalid historyStartedAt provided (${historyStartedAt}), falling back to current time`,
            );
            return new Date();
        }

        return parsed;
    }

    async handleCancellation({
        directory,
        historyId,
        historyStartedAt,
    }: TriggerGenerationOptions): Promise<void> {
        const finishedAt = new Date();
        const startTime = this.resolveStartTime(historyStartedAt);
        const duration = Math.max(
            0,
            Math.round((finishedAt.getTime() - startTime.getTime()) / 1000),
        );
        const message = 'Generation cancelled';

        await Promise.all([
            this.directoryOperations.recordGenerationFinishTime(directory.id, finishedAt),
            this.directoryOperations.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.CANCELLED,
                error: message,
                step: null,
            }),
            this.directoryOperations.updateGenerationHistory(directory.id, historyId, {
                status: GenerateStatusType.CANCELLED,
                finishedAt,
                durationInSeconds: duration,
                errorMessage: message,
            }),
        ]);

        await this.directoryOperations.emitGenerationCompleted(directory);
    }
}
