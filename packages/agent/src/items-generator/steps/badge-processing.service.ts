import { Injectable, Logger } from '@nestjs/common';
import { ItemData } from '../dto/item-data.dto';
import { BadgeEvaluationService } from '../shared/badge-evaluation.service';
import {
    IPipelineStep,
    GenerationContext,
} from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';

@Injectable()
export class BadgeProcessingService implements IPipelineStep {
    private readonly logger = new Logger(BadgeProcessingService.name);

    public readonly name = ItemsGeneratorStep.BADGES_PROCESSING;

    constructor(private readonly badgeEvaluationService: BadgeEvaluationService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, finalItems, metrics } = context;

        if (dto.badge_evaluation_enabled) {
            this.logger.log(`[${directory.slug}] Badge Processing for Repository Items - Starting`);

            const processedItems = await this.processBadges(finalItems);

            // Log badge statistics
            const badgeStats = this.getBadgeStatistics(processedItems);
            this.logger.log(
                `[${directory.slug}] Badge processing completed. Statistics: ${JSON.stringify(badgeStats)}`,
            );

            context.finalItems = processedItems;
        }

        context.metrics = {
            ...metrics,
            total_items_in_store: context.finalItems.length,
        };

        return context;
    }

    /**
     * Processes badges for a list of items
     * This step evaluates and assigns badges to items that have repository URLs
     */
    async processBadges(items: ItemData[]): Promise<ItemData[]> {
        this.logger.log(`Starting badge processing for ${items.length} items`);

        try {
            // Filter items that are eligible for badge evaluation (repository URLs)
            const eligibleItems = items.filter((item) => this.isEligibleForBadgeEvaluation(item));

            if (eligibleItems.length === 0) {
                this.logger.log('No items eligible for badge evaluation');
                return items;
            }

            this.logger.log(`${eligibleItems.length} items eligible for badge evaluation`);

            // Evaluate badges for eligible items
            const badgeResults =
                await this.badgeEvaluationService.evaluateItemsBadges(eligibleItems);

            // Apply badge results to items
            const processedItems = items.map((item) => {
                const badgeResult = badgeResults.get(item.source_url);
                if (badgeResult) {
                    return {
                        ...item,
                        badges: badgeResult.badges,
                    };
                }
                return item;
            });

            const itemsWithBadges = processedItems.filter(
                (item) => item.badges && Object.keys(item.badges).length > 0,
            );
            this.logger.log(
                `Badge processing completed. ${itemsWithBadges.length} items now have badges`,
            );

            return processedItems;
        } catch (error) {
            this.logger.error('Failed to process badges:', error);
            // Return original items if badge processing fails
            return items;
        }
    }

    /**
     * Processes badges for a single item
     */
    async processSingleItemBadges(item: ItemData): Promise<ItemData> {
        this.logger.debug(`Processing badges for single item: ${item.name}`);

        try {
            if (!this.isEligibleForBadgeEvaluation(item)) {
                this.logger.debug(`Item ${item.name} not eligible for badge evaluation`);
                return item;
            }

            const badgeResult = await this.badgeEvaluationService.evaluateItemBadges(item);

            if (badgeResult) {
                return {
                    ...item,
                    badges: badgeResult.badges,
                };
            }

            return item;
        } catch (error) {
            this.logger.error(`Failed to process badges for item ${item.name}:`, error);
            return item;
        }
    }

    /**
     * Checks if an item is eligible for badge evaluation
     * Currently only repository URLs are eligible
     */
    private isEligibleForBadgeEvaluation(item: ItemData): boolean {
        if (!item.source_url) {
            return false;
        }

        // Check if the URL is a repository URL
        const repositoryPatterns = [
            /github\.com\/[^\/]+\/[^\/]+/i,
            /gitlab\.com\/[^\/]+\/[^\/]+/i,
            /bitbucket\.org\/[^\/]+\/[^\/]+/i,
            /codeberg\.org\/[^\/]+\/[^\/]+/i,
            /sourceforge\.net\/projects\/[^\/]+/i,
        ];

        return repositoryPatterns.some((pattern) => pattern.test(item.source_url));
    }

    /**
     * Gets badge statistics for a list of items
     */
    getBadgeStatistics(items: ItemData[]): {
        total_items: number;
        items_with_badges: number;
        security_badges: { A: number; F: number };
        license_badges: { A: number; F: number };
        quality_badges: { A: number; F: number };
    } {
        const stats = {
            total_items: items.length,
            items_with_badges: 0,
            security_badges: { A: 0, F: 0 },
            license_badges: { A: 0, F: 0 },
            quality_badges: { A: 0, F: 0 },
        };

        items.forEach((item) => {
            if (item.badges && Object.keys(item.badges).length > 0) {
                stats.items_with_badges++;

                if (item.badges.security) {
                    stats.security_badges[item.badges.security.value]++;
                }

                if (item.badges.license) {
                    stats.license_badges[item.badges.license.value]++;
                }

                if (item.badges.quality) {
                    stats.quality_badges[item.badges.quality.value]++;
                }
            }
        });

        return stats;
    }
}
