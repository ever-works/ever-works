import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from 'src/ai';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { TopicAnalysis } from '../interfaces/items-generator.interfaces';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage } from '../utils/error.util';

const TOPIC_ANALYSIS_PROMPT = `Analyze the directory topic and extract helpful keyword signals.

Name: {name}
Description: {description}

Return keyword variants, related terms, and exclusion terms to guide search and filtering.` as const;

@Injectable()
export class TopicAnalysisService implements IPipelineStep {
    public readonly name = ItemsGeneratorStep.TOPIC_ANALYSIS;
    private readonly logger = new Logger(TopicAnalysisService.name);

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, metrics } = context;
        const { name, prompt } = dto;

        this.logger.log(`[${directory.slug}] Topic Analysis - Starting`);

        const schema = z.object({
            primary_keywords: z.array(z.string()),
            synonyms: z.array(z.string()),
            related_terms: z.array(z.string()),
            exclusion_terms: z.array(z.string()),
            item_types: z.array(z.string()),
        }) as z.ZodSchema<TopicAnalysis>;

        try {
            const { result, usage, cost } = await this.aiService.askJson(
                TOPIC_ANALYSIS_PROMPT,
                schema,
                {
                    temperature: 0.2,
                    variables: { name, description: prompt },
                },
            );

            context.topicKeywords = result;
            accumulateMetrics(metrics, usage, cost);

            this.logger.log(
                `[${directory.slug}] Topic Analysis Complete. Keywords: ${result.primary_keywords.length}`,
            );
        } catch (error) {
            this.logger.error(
                `[${directory.slug}] Topic Analysis failed, using fallback keywords. ${getErrorMessage(error)}`,
            );
            context.topicKeywords = {
                primary_keywords: [name],
                synonyms: [],
                related_terms: [],
                exclusion_terms: [],
                item_types: [],
            };
        }

        return context;
    }
}
