import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ItemBadges, BadgeEvaluationResult } from '../dto/badge.dto';
import { ItemData } from '../dto/item-data.dto';
import { AiService } from '../../ai';
import { DomainType } from '../interfaces/items-generator.interfaces';
import { GenerationContext } from '../interfaces/pipeline.interface';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage } from '../utils/error.util';

type DomainBadgeConfig = Record<
    string,
    { values: string[]; description: string; required?: boolean }
>;

const DOMAIN_BADGES: Record<DomainType, DomainBadgeConfig> = {
    [DomainType.SOFTWARE]: {
        security: {
            values: ['A', 'F'],
            description: 'A = no known vulnerabilities, F = has vulnerabilities',
        },
        license: {
            values: ['A', 'F'],
            description: 'A = permissive license (MIT/Apache/BSD), F = restrictive/no license',
        },
        quality: {
            values: ['A', 'F'],
            description: 'A = well-maintained, F = unmaintained/broken',
        },
    },
    [DomainType.ECOMMERCE]: {
        verified: { values: ['yes', 'no'], description: 'Is this an official/brand source?' },
        price_range: { values: ['$', '$$', '$$$'], description: 'Indicative price range' },
        availability: {
            values: ['in_stock', 'limited', 'out_of_stock'],
            description: 'Availability signal',
        },
    },
    [DomainType.SERVICES]: {
        availability: {
            values: ['online', 'in_person', 'both'],
            description: 'Service delivery mode',
        },
        booking: { values: ['instant', 'contact'], description: 'How to book' },
        verified: { values: ['yes', 'no'], description: 'Official/verified provider' },
    },
    [DomainType.GENERAL]: {
        verified: { values: ['yes', 'no'], description: 'Official/verified source' },
    },
};

const BADGE_PROMPT = `You are an expert evaluator assigning badges for a directory item.

Item:
- Name: {name}
- Description: {description}
- Source URL: {source_url}
- Domain: {domain_type}

Badges to evaluate:
{badge_criteria}

Return a JSON object with badges and evaluation_summary. Omit badges you cannot determine with confidence.` as const;

@Injectable()
export class BadgeEvaluationService {
    private readonly logger = new Logger(BadgeEvaluationService.name);

    constructor(private readonly aiService: AiService) {}

    async evaluateItemBadges(
        item: ItemData,
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<BadgeEvaluationResult | null> {
        try {
            if (domainType === DomainType.SOFTWARE && !this.isRepositoryUrl(item.source_url)) {
                return null;
            }

            const schema = this.buildSchema(domainType);

            const { result, usage, cost } = await this.aiService.askJson(BADGE_PROMPT, schema, {
                temperature: 0,
                variables: {
                    name: item.name,
                    description: item.description || '',
                    source_url: item.source_url,
                    domain_type: domainType,
                    badge_criteria: this.buildBadgeCriteria(domainType),
                },
            });

            const nowIso = new Date().toISOString();
            const badges: ItemBadges = {};

            if (result.badges) {
                Object.entries(result.badges).forEach(([key, badgeValue]) => {
                    if (badgeValue?.value) {
                        badges[key] = {
                            value: badgeValue.value,
                            evaluated_at: nowIso,
                            details: badgeValue.details ?? null,
                        };
                    }
                });
            }

            accumulateMetrics(metrics, usage, cost);

            return {
                badges,
                evaluation_summary: result.evaluation_summary,
                evaluated_at: nowIso,
                domain_type: domainType,
            };
        } catch (error) {
            this.logger.error(
                `Failed to evaluate badges for ${item.name}: ${getErrorMessage(error)}`,
            );
            return null;
        }
    }

    async evaluateItemsBadges(
        items: ItemData[],
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<Map<string, BadgeEvaluationResult>> {
        const results = new Map<string, BadgeEvaluationResult>();
        const concurrencyLimit = 10;
        const chunks = this.chunkArray(items, concurrencyLimit);

        for (const chunk of chunks) {
            const promises = chunk.map(async (item) => {
                const result = await this.evaluateItemBadges(item, domainType, metrics);
                if (result) {
                    results.set(item.source_url, result);
                }
            });
            await Promise.all(promises);
        }

        return results;
    }

    private isRepositoryUrl(url: string): boolean {
        const patterns = [
            /github\.com\/[^\/]+\/[^\/]+/i,
            /gitlab\.com\/[^\/]+\/[^\/]+/i,
            /bitbucket\.org\/[^\/]+\/[^\/]+/i,
            /codeberg\.org\/[^\/]+\/[^\/]+/i,
            /sourceforge\.net\/projects\/[^\/]+/i,
        ];
        return patterns.some((p) => p.test(url));
    }

    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    private buildSchema(domainType: DomainType) {
        const domainConfig = DOMAIN_BADGES[domainType] || DOMAIN_BADGES[DomainType.GENERAL];
        const badgeShape: Record<string, any> = {};

        for (const [key, def] of Object.entries(domainConfig)) {
            badgeShape[key] = z
                .object({
                    value: z.enum(def.values as [string, ...string[]]),
                    details: z.string().nullable(),
                })
                .nullable();
        }

        return z.object({
            evaluation_summary: z.string(),
            badges: z.object(badgeShape).nullable(),
        });
    }

    private buildBadgeCriteria(domainType: DomainType): string {
        const config = DOMAIN_BADGES[domainType] || DOMAIN_BADGES[DomainType.GENERAL];
        return Object.entries(config)
            .map(([key, def]) => `- ${key}: [${def.values.join(', ')}] - ${def.description}`)
            .join('\n');
    }
}
