import { Injectable, Logger } from '@nestjs/common';
import { formatDate } from 'date-fns';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { AiService } from 'src/ai';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import z from 'zod';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage, getErrorStack } from '../utils/error.util';

const SEARCH_QUERY_PROMPT =
    `You are a directory builder generating search queries to find the most relevant, official sources.

Topic: "{name}"
Description: "{description}"
Target keywords: {keywords}
Today is {date}.

Rules:
- Generate {query_count} distinct, high-intent search queries as an array of strings.
- Prefer queries that surface official resources (homepages, docs, repositories) over listicles.
- Mix broad and long-tail variations to improve recall.` as const;

@Injectable()
export class SearchQueryGenerationService implements IPipelineStep {
    private readonly logger = new Logger(SearchQueryGenerationService.name);

    public readonly name = ItemsGeneratorStep.SEARCH_QUERIES_GENERATION;

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, metrics } = context;

        this.logger.log(`[${directory.slug}] AI-Powered Search Query Generation - Starting`);

        const searchQueries = await this.generateSearchQueries(dto, metrics);
        this.logger.log(`[${directory.slug}] Generated ${searchQueries.length} search queries.`);

        context.searchQueries = searchQueries;

        return context;
    }

    async generateSearchQueries(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        metrics?: GenerationContext['metrics'],
    ): Promise<string[]> {
        const {
            name,
            prompt: description,
            target_keywords: targetKeywords,
            config,
        } = createItemsGeneratorDto;

        this.logger.log(`[${name}] Generating search queries using LLM...`);

        const keywords = targetKeywords || [];

        if (!this.aiService.isAiConfigured()) {
            this.logger.warn(
                `[${name}] OpenAI API Key not configured. Falling back to basic query generation.`,
            );
            const fallbackQueries = [
                `best tools for ${name}`,
                `${name} resources`,
                `${name} libraries`,
                `${name} tutorials`,
                `official documentation ${name}`,
                `community ${name}`,
            ];
            if (targetKeywords && targetKeywords.length > 0) {
                return [
                    ...new Set([
                        ...targetKeywords.map((kw) => `${kw} ${name}`),
                        ...fallbackQueries,
                    ]),
                ].slice(0, config.max_search_queries);
            }
            return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
        }

        const now = new Date();

        const schema = z
            .object({
                queries: z.array(z.string().min(3)),
            })
            .strict() as z.ZodType<{ queries: string[] }>;

        try {
            const { result, usage, cost } = await this.aiService.askJson(
                SEARCH_QUERY_PROMPT,
                schema,
                {
                    temperature: 0.2,
                    variables: {
                        name,
                        description,
                        keywords: keywords.length ? keywords.join(', ') : 'N/A',
                        date: `${formatDate(now, 'cccc')} ${formatDate(now, 'yyyy-MM-dd HH:mm')}`,
                        query_count: String(config.max_search_queries * 2),
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            const queries = (result.queries || []).map((q) => q.trim()).filter((q) => q.length > 3);

            const uniqueQueries = Array.from(new Set(queries));

            this.logger.log(`[${name}] LLM generated ${uniqueQueries.length} unique queries.`);
            return uniqueQueries.slice(0, config.max_search_queries);
        } catch (error) {
            this.logger.error(
                `[${name}] Error generating search queries with LLM: ${getErrorMessage(error)}`,
                getErrorStack(error),
            );
            this.logger.warn(`[${name}] Falling back to basic query generation due to LLM error.`);
            // Fallback to simpler generation if LLM fails
            const fallbackQueries = [
                `best tools for ${name}`,
                `${name} resources`,
                `${name} libraries`,
                `${name} tutorials`,
                `official documentation ${name}`,
                `community ${name}`,
            ];
            if (targetKeywords && targetKeywords.length > 0) {
                return [
                    ...new Set([
                        ...targetKeywords.map((kw) => `${kw} ${name}`),
                        ...fallbackQueries,
                    ]),
                ].slice(0, config.max_search_queries);
            }
            return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
        }
    }
}
