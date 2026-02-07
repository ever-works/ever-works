import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataGeneratorService } from '@ever-works/agent/generators';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { WebsiteGeneratorService } from '@ever-works/agent/generators';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import { CreateItemsGeneratorDto } from '@ever-works/agent/items-generator';
import { DIRECTORY_OPERATIONS } from '@ever-works/agent/directory-operations';
import type { DirectoryOperations } from '@ever-works/agent/directory-operations';
import { NOTIFICATION_OPERATIONS } from '@ever-works/agent/notification-operations';
import type { NotificationOperations } from '@ever-works/agent/notification-operations';
import { ItemsGeneratorMetrics } from '@ever-works/agent/items-generator';

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
        @Optional()
        @Inject(NOTIFICATION_OPERATIONS)
        private readonly notificationOperations?: NotificationOperations,
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

            if (generated.success === false) {
                throw new Error(generated.error.message);
            }

            generationStats = generated.stats;

            if (generated.stats.totalItemsCount > 0) {
                await this.markdownGenerator.initialize(directory, user, {
                    repository_description: dto.repository_description,
                    generation_method: dto.generation_method,
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

            // Notify user of account-level errors
            await this.handleErrorNotification(error, user, directory);

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

    /**
     * Detect account-level errors and notify the user
     */
    private async handleErrorNotification(
        error: unknown,
        user: User,
        directory: Directory,
    ): Promise<void> {
        if (!this.notificationOperations) {
            return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorLower = errorMessage.toLowerCase();

        // Detect AI credits/quota errors
        if (this.isAiCreditsError(errorLower)) {
            const provider = this.detectProvider(errorLower);
            await this.notificationOperations.notifyAiCreditsDepleted(
                user.id,
                provider,
                errorMessage,
            );
            return;
        }

        // Detect AI provider authentication/configuration errors
        if (this.isAiProviderError(errorLower)) {
            const provider = this.detectProvider(errorLower);
            await this.notificationOperations.notifyAiProviderError(
                user.id,
                provider,
                errorMessage,
            );
            return;
        }

        // Detect Git authentication errors
        if (this.isGitAuthError(errorLower)) {
            const provider = this.detectGitProvider(errorLower);
            await this.notificationOperations.notifyGitAuthExpired(user.id, provider);
            return;
        }

        // For other account-level errors (rate limits, configuration issues)
        if (this.isAccountLevelError(errorLower)) {
            await this.notificationOperations.notifyGenerationAccountError(
                user.id,
                directory.id,
                directory.name,
                errorMessage,
            );
        }
    }

    private isAiCreditsError(error: string): boolean {
        return (
            error.includes('insufficient_quota') ||
            error.includes('rate_limit') ||
            error.includes('quota exceeded') ||
            error.includes('credits') ||
            error.includes('billing') ||
            error.includes('exceeded your current quota')
        );
    }

    private isAiProviderError(error: string): boolean {
        return (
            error.includes('invalid_api_key') ||
            error.includes('authentication') ||
            error.includes('unauthorized') ||
            error.includes('api key')
        );
    }

    private isGitAuthError(error: string): boolean {
        return (
            (error.includes('git') || error.includes('github') || error.includes('gitlab')) &&
            (error.includes('authentication') ||
                error.includes('unauthorized') ||
                error.includes('token') ||
                error.includes('expired') ||
                error.includes('permission denied'))
        );
    }

    private isAccountLevelError(error: string): boolean {
        return (
            error.includes('account') ||
            error.includes('subscription') ||
            error.includes('plan limit') ||
            error.includes('not configured')
        );
    }

    private detectProvider(error: string): string {
        if (error.includes('openai')) return 'OpenAI';
        if (error.includes('anthropic') || error.includes('claude')) return 'Anthropic';
        if (error.includes('google') || error.includes('gemini')) return 'Google';
        if (error.includes('groq')) return 'Groq';
        if (error.includes('ollama')) return 'Ollama';
        if (error.includes('openrouter')) return 'OpenRouter';
        return 'AI Provider';
    }

    private detectGitProvider(error: string): string {
        if (error.includes('gitlab')) return 'GitLab';
        if (error.includes('bitbucket')) return 'Bitbucket';
        return 'GitHub';
    }
}
