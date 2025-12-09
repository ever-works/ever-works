import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from 'src/ai';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { DomainAnalysis, DomainType } from '../interfaces/items-generator.interfaces';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage } from '../utils/error.util';

const DOMAIN_DETECTION_PROMPT = `You are classifying the domain of a directory topic.

Topic name: "{name}"
Topic description: "{description}"

Choose a domain_type from: software, ecommerce, services, general.
Return the classification with a confidence score and any useful cues (expected attributes, official patterns, aggregator domains, item noun).` as const;

const domainDetectionSchema = z.object({
    domain_type: z.nativeEnum(DomainType),
    confidence: z.number().min(0).max(1),
    item_noun: z.string().nullable(),
    expected_attributes: z.array(z.string()).nullable(),
    official_source_patterns: z.array(z.string()).nullable(),
    aggregator_domains: z.array(z.string()).nullable(),
}) as z.ZodSchema<DomainAnalysis>;

@Injectable()
export class DomainDetectionService implements IPipelineStep {
    public readonly name = ItemsGeneratorStep.DOMAIN_DETECTION;
    private readonly logger = new Logger(DomainDetectionService.name);

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, metrics } = context;
        const { name, prompt } = dto;

        this.logger.log(`[${directory.slug}] Domain Detection - Starting`);

        try {
            const { result, usage, cost } = await this.aiService.askJson(
                DOMAIN_DETECTION_PROMPT,
                domainDetectionSchema,
                {
                    temperature: 0.1,
                    variables: { name, description: prompt },
                },
            );

            context.domainAnalysis = result;
            accumulateMetrics(metrics, usage, cost);

            this.logger.log(
                `[${directory.slug}] Domain Detection Complete: ${result.domain_type} (conf=${result.confidence})`,
            );
        } catch (error) {
            this.logger.error(
                `[${directory.slug}] Domain detection failed, defaulting to software. ${getErrorMessage(error)}`,
            );
            context.domainAnalysis = {
                domain_type: DomainType.SOFTWARE,
                confidence: 0,
            };
        }

        return context;
    }
}
