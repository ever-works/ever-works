import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { BadgeType, BadgeValue, ItemBadges, BadgeEvaluationResult } from '../dto/badge.dto';
import { ItemData } from '../dto/item-data.dto';
import { AiService } from '../../ai';
import { DomainType } from '../interfaces/items-generator.interfaces';
import { GenerationContext } from '../interfaces/pipeline.interface';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage } from '../utils/error.util';

// Base software badge schema
const badgeSchema = z.object({
    type: z.nativeEnum(BadgeType),
    value: z.nativeEnum(BadgeValue),
    details: z.string().nullable().describe('Brief explanation of the evaluation result'),
});

const domainBadgeValueSchema = z.object({
    value: z.string(),
    details: z.string().nullable(),
});

const softwareBadgeSchema = z.object({
    security: badgeSchema.nullable(),
    license: badgeSchema.nullable(),
    quality: badgeSchema.nullable(),
    evaluation_summary: z.string(),
    domain_badges: z.record(domainBadgeValueSchema),
});

// Type for the software badge AI result
type SoftwareBadgeResult = z.infer<typeof softwareBadgeSchema>;

// Type for domain-specific badge results (non-software)
interface DomainBadgeResult {
    evaluation_summary: string;
    domain_badges?: Record<string, { value: string; details?: string | null }>;
}

// Union type for any badge evaluation result from AI
type BadgeSchemaResult = SoftwareBadgeResult | DomainBadgeResult;

// Type guard for software badges
function isSoftwareBadgeResult(result: BadgeSchemaResult): result is SoftwareBadgeResult {
    return 'security' in result || 'license' in result || 'quality' in result;
}

type DomainBadgeConfig = Record<
    string,
    { values: string[]; description: string; required?: boolean }
>;

const DOMAIN_BADGES: Record<DomainType, DomainBadgeConfig> = {
    [DomainType.SOFTWARE]: {
        security: { values: Object.values(BadgeValue), description: 'Security grade' },
        license: { values: Object.values(BadgeValue), description: 'License permissiveness' },
        quality: { values: Object.values(BadgeValue), description: 'Repository health' },
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

const SOFTWARE_BADGE_PROMPT =
    `You are an expert software engineer tasked with evaluating repository badges based on available information.

Item:
- Name: {name}
- Description: {description}
- Source URL: {source_url}

Badges:
- SECURITY: "A" = no known security vulnerabilities, "F" = has known vulnerabilities.
- LICENSE: "A" = permissive license (MIT/Apache/BSD), "F" = restrictive/no license.
- QUALITY: "A" = well-maintained and functional, "F" = unmaintained/broken.

Provide a JSON object matching the schema. If uncertain, omit the badge.` as const;

const DOMAIN_BADGE_PROMPT =
    `You are an expert evaluator tasked with assigning domain-specific badges for a directory item.

Item:
- Name: {name}
- Description: {description}
- Source URL: {source_url}
- Domain type: {domain_type}

Badges to produce (if confidently inferable):
{badge_criteria}

Return a JSON object with domain_badges and an evaluation_summary. If you cannot determine a badge with confidence, omit it.` as const;

@Injectable()
export class BadgeEvaluationService {
    private readonly logger = new Logger(BadgeEvaluationService.name);

    constructor(private readonly aiService: AiService) {}

    /**
     * Evaluates badges for a single item based on its source URL and available information
     */
    async evaluateItemBadges(
        item: ItemData,
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<BadgeEvaluationResult | null> {
        try {
            this.logger.debug(`Evaluating badges for item: ${item.name} (domain: ${domainType})`);

            // For SOFTWARE domain, only evaluate items with repository URLs
            if (domainType === DomainType.SOFTWARE && !this.isRepositoryUrl(item.source_url)) {
                this.logger.debug(
                    `Skipping badge evaluation for non-repository URL in SOFTWARE domain: ${item.source_url}`,
                );
                return null;
            }

            const nowIso = new Date().toISOString();

            const schema = this.buildSchemaForDomain(domainType);

            const { result, usage, cost } =
                domainType === DomainType.SOFTWARE
                    ? await this.aiService.askJson(SOFTWARE_BADGE_PROMPT, schema, {
                          temperature: 0,
                          variables: {
                              name: item.name,
                              description: item.description || '',
                              source_url: item.source_url,
                          },
                      })
                    : await this.aiService.askJson(DOMAIN_BADGE_PROMPT, schema, {
                          temperature: 0,
                          variables: {
                              name: item.name,
                              description: item.description || '',
                              source_url: item.source_url,
                              domain_type: domainType,
                              badge_criteria: this.buildBadgeCriteria(domainType),
                          },
                      });

            const badges: ItemBadges = {};

            // Process software badge types (only if this is a software domain result)
            if (isSoftwareBadgeResult(result)) {
                if (result.security) {
                    badges.security = {
                        type: BadgeType.SECURITY,
                        value: result.security.value,
                        evaluated_at: nowIso,
                        details: result.security.details,
                    };
                }

                if (result.license) {
                    badges.license = {
                        type: BadgeType.LICENSE,
                        value: result.license.value,
                        evaluated_at: nowIso,
                        details: result.license.details,
                    };
                }

                if (result.quality) {
                    badges.quality = {
                        type: BadgeType.QUALITY,
                        value: result.quality.value,
                        evaluated_at: nowIso,
                        details: result.quality.details,
                    };
                }
            }

            const badgeResult: BadgeEvaluationResult = {
                badges,
                evaluation_summary: result.evaluation_summary,
                evaluated_at: nowIso,
                domain_type: domainType,
                domain_badges: this.extractDomainBadges(result),
            };

            accumulateMetrics(metrics, usage, cost);

            this.logger.debug(
                `Badge evaluation completed for ${item.name}: ${Object.keys(badges).length} badges evaluated`,
            );
            return badgeResult;
        } catch (error) {
            this.logger.error(
                `Failed to evaluate badges for item ${item.name}: ${getErrorMessage(error)}`,
            );
            return null;
        }
    }

    /**
     * Evaluates badges for multiple items in batch
     */
    async evaluateItemsBadges(
        items: ItemData[],
        domainType: DomainType = DomainType.SOFTWARE,
        metrics?: GenerationContext['metrics'],
    ): Promise<Map<string, BadgeEvaluationResult>> {
        const results = new Map<string, BadgeEvaluationResult>();

        this.logger.log(`Starting badge evaluation for ${items.length} items`);

        // Process items in parallel with a reasonable concurrency limit
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

        this.logger.log(`Badge evaluation completed. ${results.size} items have badges`);
        return results;
    }

    /**
     * Checks if a URL is a repository URL that should be evaluated for badges
     */
    private isRepositoryUrl(url: string): boolean {
        const repositoryPatterns = [
            /github\.com\/[^\/]+\/[^\/]+/i,
            /gitlab\.com\/[^\/]+\/[^\/]+/i,
            /bitbucket\.org\/[^\/]+\/[^\/]+/i,
            /codeberg\.org\/[^\/]+\/[^\/]+/i,
            /sourceforge\.net\/projects\/[^\/]+/i,
        ];

        return repositoryPatterns.some((pattern) => pattern.test(url));
    }

    /**
     * Utility method to chunk array for batch processing
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    private buildSchemaForDomain(domainType: DomainType) {
        if (domainType === DomainType.SOFTWARE) {
            return softwareBadgeSchema;
        }

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
            domain_badges: z.object(badgeShape).nullable(),
        });
    }

    private buildBadgeCriteria(domainType: DomainType): string {
        const domainConfig = DOMAIN_BADGES[domainType] || DOMAIN_BADGES[DomainType.GENERAL];
        return Object.entries(domainConfig)
            .map(([key, def]) => `- ${key}: one of [${def.values.join(', ')}]. ${def.description}`)
            .join('\n');
    }

    private extractDomainBadges(result: BadgeSchemaResult) {
        if (!result.domain_badges) {
            return undefined;
        }

        const evaluated_at = new Date().toISOString();
        const domainBadges: Record<
            string,
            { value: string; evaluated_at: string; details?: string | null }
        > = {};

        Object.entries(result.domain_badges).forEach(([key, badgeValue]) => {
            if (badgeValue?.value) {
                domainBadges[key] = {
                    value: badgeValue.value,
                    evaluated_at,
                    details: badgeValue.details ?? null,
                };
            }
        });

        return Object.keys(domainBadges).length > 0 ? domainBadges : undefined;
    }
}
