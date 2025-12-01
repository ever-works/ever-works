import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService, ModelRouterService, TaskComplexity } from 'src/ai';

export enum DomainType {
    SOFTWARE = 'software',
    ECOMMERCE = 'ecommerce',
    SERVICES = 'services',
    EDUCATION = 'education',
    HEALTHCARE = 'healthcare',
    ENTERTAINMENT = 'entertainment',
    GENERAL = 'general',
}

export type DomainAnalysis = {
    domain_type: DomainType;
    confidence: number;
    item_noun: string;
    expected_attributes: string[];
    official_source_patterns: string[];
    aggregator_domains: string[];
};

const domainDetectionSchema = z.object({
    domain_type: z.nativeEnum(DomainType),
    confidence: z.number().min(0).max(1),
    item_noun: z.string(),
    expected_attributes: z.array(z.string()),
    official_source_patterns: z.array(z.string()),
    aggregator_domains: z.array(z.string()),
});

@Injectable()
export class DomainDetectionService {
    private readonly logger = new Logger(DomainDetectionService.name);

    constructor(
        private readonly aiService: AiService,
        private readonly modelRouter: ModelRouterService,
    ) {}

    async detectDomain(slug: string, prompt: string, name: string): Promise<DomainAnalysis> {
        const defaultResult: DomainAnalysis = {
            domain_type: DomainType.GENERAL,
            confidence: 0,
            item_noun: 'items',
            expected_attributes: [],
            official_source_patterns: [],
            aggregator_domains: [],
        };

        if (!this.aiService.isAiConfigured()) {
            this.logger.warn(`[${slug}] AI not configured; defaulting domain to GENERAL.`);
            return defaultResult;
        }

        try {
            const llm = this.modelRouter.getModel(TaskComplexity.SIMPLE, { temperature: 0 });
            const promptTemplate = HumanMessagePromptTemplate.fromTemplate(`
You classify a directory's domain and expected item traits.

Directory name: {name}
User prompt: {prompt}

Return the domain type, confidence (0-1), a noun for the items (e.g., tools, products, places),
expected attributes to look for, common official source URL patterns, and aggregator domains to avoid.
`);

            const result = (await promptTemplate
                .pipe(llm.withStructuredOutput(domainDetectionSchema))
                .invoke({ name, prompt })) as DomainAnalysis;

            this.logger.log(
                `[${slug}] Domain detected: ${result.domain_type} (confidence ${result.confidence.toFixed(2)})`,
            );
            return result;
        } catch (error) {
            this.logger.error(
                `[${slug}] Failed domain detection, defaulting to GENERAL: ${error.message}`,
                error.stack,
            );
            return defaultResult;
        }
    }
}
