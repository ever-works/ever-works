import { Injectable, Logger } from '@nestjs/common';
import { ItemData } from '../dto/item-data.dto';
import { BadgeEvaluationService } from '../shared/badge-evaluation.service';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { DomainType } from '../interfaces/items-generator.interfaces';
import { getErrorMessage } from '../utils/error.util';

@Injectable()
export class BadgeProcessingService implements IPipelineStep {
    private readonly logger = new Logger(BadgeProcessingService.name);

    public readonly name = ItemsGeneratorStep.BADGES_PROCESSING;

    constructor(private readonly badgeEvaluationService: BadgeEvaluationService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, finalItems, metrics } = context;
        const domainType = context.domainAnalysis?.domain_type ?? DomainType.SOFTWARE;

        if (dto.badge_evaluation_enabled) {
            const processedItems = await this.processBadges(finalItems, domainType, metrics);
            context.finalItems = processedItems;
        }

        context.metrics = {
            ...metrics,
            total_items_in_store: context.finalItems.length,
        };

        return context;
    }

    async processBadges(
        items: ItemData[],
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<ItemData[]> {
        try {
            const eligibleItems = items.filter((item) =>
                this.isEligibleForBadgeEvaluation(item, domainType),
            );

            if (eligibleItems.length === 0) {
                return items;
            }

            const badgeResults = await this.badgeEvaluationService.evaluateItemsBadges(
                eligibleItems,
                domainType,
                metrics,
            );

            return items.map((item) => {
                const badgeResult = badgeResults.get(item.source_url);
                if (badgeResult) {
                    return {
                        ...item,
                        badges: badgeResult.badges,
                    };
                }
                return item;
            });
        } catch (error) {
            this.logger.error(`Failed to process badges: ${getErrorMessage(error)}`);
            return items;
        }
    }

    async processSingleItemBadges(
        item: ItemData,
        domainType: DomainType = DomainType.SOFTWARE,
    ): Promise<ItemData> {
        try {
            if (!this.isEligibleForBadgeEvaluation(item, domainType)) {
                return item;
            }

            const badgeResult = await this.badgeEvaluationService.evaluateItemBadges(
                item,
                domainType,
            );

            if (badgeResult) {
                return {
                    ...item,
                    badges: badgeResult.badges,
                };
            }

            return item;
        } catch (error) {
            this.logger.error(
                `Failed to process badges for ${item.name}: ${getErrorMessage(error)}`,
            );
            return item;
        }
    }

    private isEligibleForBadgeEvaluation(item: ItemData, domainType: DomainType): boolean {
        if (!item.source_url) {
            return false;
        }

        if (domainType === DomainType.SOFTWARE) {
            const repositoryPatterns = [
                /github\.com\/[^\/]+\/[^\/]+/i,
                /gitlab\.com\/[^\/]+\/[^\/]+/i,
                /bitbucket\.org\/[^\/]+\/[^\/]+/i,
                /codeberg\.org\/[^\/]+\/[^\/]+/i,
                /sourceforge\.net\/projects\/[^\/]+/i,
            ];
            return repositoryPatterns.some((pattern) => pattern.test(item.source_url));
        }

        return true;
    }
}
