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
        const { dto, directory, finalItems, metrics } = context;
        const domainType = context.domainAnalysis?.domain_type ?? DomainType.SOFTWARE;

        if (dto.badge_evaluation_enabled) {
            this.logger.log(
                `[${directory.slug}] Badge Processing - Starting (domain: ${domainType})`,
            );

            const processedItems = await this.processBadges(finalItems, domainType, metrics);

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
     * For SOFTWARE domains: only repository URLs are eligible
     * For other domains: all items with source URLs are eligible
     */
    async processBadges(
        items: ItemData[],
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<ItemData[]> {
        this.logger.log(
            `Starting badge processing for ${items.length} items (domain: ${domainType})`,
        );

        try {
            // Filter items that are eligible for badge evaluation based on domain
            const eligibleItems = items.filter((item) =>
                this.isEligibleForBadgeEvaluation(item, domainType),
            );

            if (eligibleItems.length === 0) {
                this.logger.log('No items eligible for badge evaluation');
                return items;
            }

            this.logger.log(`${eligibleItems.length} items eligible for badge evaluation`);

            // Evaluate badges for eligible items
            const badgeResults = await this.badgeEvaluationService.evaluateItemsBadges(
                eligibleItems,
                domainType ?? DomainType.SOFTWARE,
                metrics,
            );

            // Apply badge results to items
            const processedItems = items.map((item) => {
                const badgeResult = badgeResults.get(item.source_url);
                if (badgeResult) {
                    return {
                        ...item,
                        badges: badgeResult.badges,
                        domain_badges: badgeResult.domain_badges,
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
            this.logger.error(`Failed to process badges: ${getErrorMessage(error)}`);
            // Return original items if badge processing fails
            return items;
        }
    }

    /**
     * Processes badges for a single item
     */
    async processSingleItemBadges(
        item: ItemData,
        domainType: DomainType = DomainType.SOFTWARE,
    ): Promise<ItemData> {
        this.logger.debug(
            `Processing badges for single item: ${item.name} (domain: ${domainType})`,
        );

        try {
            if (!this.isEligibleForBadgeEvaluation(item, domainType)) {
                this.logger.debug(`Item ${item.name} not eligible for badge evaluation`);
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
                `Failed to process badges for item ${item.name}: ${getErrorMessage(error)}`,
            );
            return item;
        }
    }

    /**
     * Checks if an item is eligible for badge evaluation based on domain type
     * - SOFTWARE domain: only repository URLs are eligible
     * - Other domains: all items with valid source URLs are eligible
     */
    private isEligibleForBadgeEvaluation(item: ItemData, domainType: DomainType): boolean {
        if (!item.source_url) {
            return false;
        }

        // For SOFTWARE domain, only repository URLs are eligible
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

        // For other domains (ECOMMERCE, SERVICES, GENERAL), all items with source URLs are eligible
        return true;
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
