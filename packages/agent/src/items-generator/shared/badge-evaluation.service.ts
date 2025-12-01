import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { BadgeType, BadgeValue, ItemBadges, BadgeEvaluationResult } from '../dto/badge.dto';
import { ItemData } from '../dto/item-data.dto';
import { ModelRouterService, TaskComplexity } from '../../ai';
import pMap from 'p-map';

// Zod schema for badge evaluation
const badgeSchema = z.object({
    type: z.nativeEnum(BadgeType),
    value: z.nativeEnum(BadgeValue),
    details: z.string().nullable().describe('Brief explanation of the evaluation result'),
});

const badgeEvaluationSchema = z.object({
    security: badgeSchema.nullable(),
    license: badgeSchema.nullable(),
    quality: badgeSchema.nullable(),
    evaluation_summary: z.string().describe('Brief summary of the overall badge evaluation'),
});

@Injectable()
export class BadgeEvaluationService {
    private readonly logger = new Logger(BadgeEvaluationService.name);

    constructor(private readonly modelRouter: ModelRouterService) {}

    /**
     * Evaluates badges for a single item based on its source URL and available information
     */
    async evaluateItemBadges(item: ItemData): Promise<BadgeEvaluationResult | null> {
        try {
            this.logger.debug(`Evaluating badges for item: ${item.name}`);

            // Only evaluate badges for items with GitHub URLs or other repository URLs
            if (!this.isRepositoryUrl(item.source_url)) {
                this.logger.debug(
                    `Skipping badge evaluation for non-repository URL: ${item.source_url}`,
                );
                return null;
            }

            const llm = this.modelRouter.getModel(TaskComplexity.MEDIUM, { temperature: 0 });

            const prompt = HumanMessagePromptTemplate.fromTemplate(`
You are an expert software engineer tasked with evaluating repository badges based on available information.

**Item Information:**
- Name: {itemName}
- Description: {itemDescription}
- Source URL: {sourceUrl}

**Badge Evaluation Criteria:**

**SECURITY Badge:**
- "A" = Repository does not have known security vulnerabilities
- "F" = Repository has known security vulnerabilities
- Consider: GitHub security advisories, dependency vulnerabilities, security best practices

**LICENSE Badge:**
- "A" = Repository has a permissive license (MIT, Apache 2.0, BSD, etc.)
- "F" = Repository has a restrictive license (GPL variants) or no license
- Consider: License file presence, license type, commercial usage restrictions

**QUALITY Badge:**
- "A" = Repository appears to be well-maintained and functional
- "F" = Repository appears unmaintained, broken, or has significant issues
- Consider: Recent commits, issue resolution, documentation quality, test coverage

**Instructions:**
1. Based on the repository URL and item information, evaluate each badge type
2. If you cannot determine a badge value with reasonable confidence, omit that badge
3. Provide brief details explaining your evaluation for each badge
4. Focus on publicly available information and reasonable inferences

Evaluate the badges for this repository and return the result in the specified format.
            `);

            const result = await prompt
                .pipe(llm.withStructuredOutput(badgeEvaluationSchema))
                .invoke({
                    itemName: item.name,
                    itemDescription: item.description,
                    sourceUrl: item.source_url,
                });

            const badges: ItemBadges = {};

            // Process each badge type
            if (result.security) {
                badges.security = {
                    type: BadgeType.SECURITY,
                    value: result.security.value,
                    evaluated_at: new Date().toISOString(),
                    details: result.security.details,
                };
            }

            if (result.license) {
                badges.license = {
                    type: BadgeType.LICENSE,
                    value: result.license.value,
                    evaluated_at: new Date().toISOString(),
                    details: result.license.details,
                };
            }

            if (result.quality) {
                badges.quality = {
                    type: BadgeType.QUALITY,
                    value: result.quality.value,
                    evaluated_at: new Date().toISOString(),
                    details: result.quality.details,
                };
            }

            const badgeResult: BadgeEvaluationResult = {
                badges,
                evaluation_summary: result.evaluation_summary,
                evaluated_at: new Date().toISOString(),
            };

            this.logger.debug(
                `Badge evaluation completed for ${item.name}: ${Object.keys(badges).length} badges evaluated`,
            );
            return badgeResult;
        } catch (error) {
            this.logger.error(`Failed to evaluate badges for item ${item.name}:`, error);
            return null;
        }
    }

    /**
     * Evaluates badges for multiple items in batch
     */
    async evaluateItemsBadges(items: ItemData[]): Promise<Map<string, BadgeEvaluationResult>> {
        const results = new Map<string, BadgeEvaluationResult>();

        this.logger.log(`Starting badge evaluation for ${items.length} items`);

        await pMap(
            items,
            async (item) => {
                const result = await this.evaluateItemBadges(item);
                if (result) {
                    results.set(item.source_url, result);
                }
            },
            { concurrency: 10 },
        );

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
}
