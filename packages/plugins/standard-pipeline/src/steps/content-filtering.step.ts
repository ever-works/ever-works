import { z } from 'zod';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	WebPageData,
	RelevanceAssessment,
	FacadeOptions
} from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';

const RELEVANCE_ASSESSMENT_PROMPT =
	`You are an expert content analyst. Assess the relevance of the following web page content to the main topic.

Topic: "{topic_name}"
Description: "{topic_description}"

Web Page Content (first {snippet_length} characters):
{snippet}

Critically evaluate: Is this page's primary focus highly relevant to the topic and description above?
- Accept: Pages dedicated to the topic, comprehensive comparisons, core tutorials, official documentation, key project pages.
- Reject: Pages where the topic is only mentioned briefly, listicles covering many unrelated topics, off-topic niche pages (unless the niche is exactly the topic), low-signal forum threads, or purely marketing fluff.

Return a JSON object matching the provided schema.` as const;

const relevanceSchema = z
	.object({
		relevant: z.boolean().describe('Whether the content is highly relevant to the topic'),
		relevance_score: z
			.number()
			.min(0)
			.max(1)
			.describe('A score between 0.0 (not relevant) and 1.0 (highly relevant)'),
		reason: z.string().describe('A brief explanation for the relevance assessment')
	})
	.strict();

type RelevanceResult = z.infer<typeof relevanceSchema>;

/**
 * Content Filtering Step
 *
 * Filters web pages based on content length and AI-assessed relevance.
 */
export class ContentFilteringStep extends BasePipelineStep {
	readonly name = 'Content Filtering';
	readonly stepId = 'content-filtering' as const;
	private readonly BATCH_SIZE = 10;
	private readonly SNIPPET_LENGTH = 3000;

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, webPages, metrics, advancedPrompts } = context;
		const { logger, aiFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		const contentFilteringEnabled = config.content_filtering_enabled !== false;

		if (contentFilteringEnabled) {
			logger.log(`[${directory.slug}] Content Filtering - Starting`);

			const filteredWebPages = await this.filterAndAssessPages(
				directory.slug,
				webPages,
				request.name || directory.name,
				request.prompt || '',
				config,
				metrics,
				advancedPrompts?.relevanceAssessment,
				logger,
				aiFacade,
				facadeOptions
			);

			logger.log(`[${directory.slug}] Filtered down to ${filteredWebPages.length} relevant pages.`);

			context.webPages = filteredWebPages;
		} else {
			logger.debug(`[${directory.slug}] Content Filtering - Skipped`);
		}

		return context;
	}

	private async filterAndAssessPages(
		directorySlug: string,
		webPages: WebPageData[],
		topicName: string,
		topicDescription: string,
		config: Record<string, unknown>,
		metrics: PipelineMetrics,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		facadeOptions: FacadeOptions
	): Promise<WebPageData[]> {
		logger.log(`[${directorySlug}] Starting content filtering for ${webPages.length} pages`);

		const minContentLength = (config.min_content_length_for_extraction as number) || 100;
		const relevanceThreshold = (config.relevance_threshold_content as number) || 0.5;

		const filteredPages = webPages
			.filter((page, index, self) => {
				return index === self.findIndex((t) => t.source_url === page.source_url);
			})
			.filter((page) => {
				const isLongEnough = (page.raw_content?.length ?? 0) >= minContentLength;
				return isLongEnough;
			});

		if (!aiFacade.isConfigured()) {
			return filteredPages;
		}

		logger.log(`[${directorySlug}] ${filteredPages.length} pages passed initial length filter`);

		if (filteredPages.length === 0) {
			return [];
		}

		const assessPageRelevance = async (
			page: WebPageData
		): Promise<{
			page: WebPageData;
			isRelevant: boolean;
			assessment?: RelevanceAssessment;
			error?: unknown;
		}> => {
			try {
				const snippet = this.buildSnippet(page.raw_content);
				const finalPrompt = appendCustomPrompt(RELEVANCE_ASSESSMENT_PROMPT, customPrompt);

				const {
					result: assessmentResult,
					usage,
					cost
				} = await aiFacade.askJson<RelevanceResult>(
					finalPrompt,
					relevanceSchema,
					{
						temperature: 0,
						variables: {
							topic_name: topicName,
							topic_description: topicDescription,
							snippet_length: String(snippet.length),
							snippet
						},
						routing: {
							complexity: 'medium',
							taskId: 'content-filtering'
						}
					},
					facadeOptions
				);

				if (usage) {
					this.accumulateMetrics(metrics, usage, cost);
				}

				const isRelevant = assessmentResult.relevant && assessmentResult.relevance_score >= relevanceThreshold;

				return {
					page,
					isRelevant,
					assessment: {
						relevant: assessmentResult.relevant,
						relevance_score: assessmentResult.relevance_score,
						reason: assessmentResult.reason
					}
				};
			} catch (error) {
				logger.error(
					`[${directorySlug}] Error assessing relevance for ${page.source_url}: ${this.formatError(error)}`,
					getErrorStack(error)
				);
				logger.warn(
					`[${directorySlug}] Keeping page due to relevance assessment error (will rely on later extraction quality): ${page.source_url}`
				);
				return { page, isRelevant: true, error };
			}
		};

		const relevantPages: WebPageData[] = [];

		logger.log(`[${directorySlug}] Processing relevance assessment in batches of ${this.BATCH_SIZE}`);

		for (let i = 0; i < filteredPages.length; i += this.BATCH_SIZE) {
			const batch = filteredPages.slice(i, i + this.BATCH_SIZE);
			const assessmentPromises = batch.map((page) => assessPageRelevance(page));
			const assessmentResults = await Promise.all(assessmentPromises);

			const relevantPagesFromBatch = assessmentResults
				.filter((result) => result.isRelevant)
				.map((result) => result.page);

			relevantPages.push(...relevantPagesFromBatch);

			if (i + this.BATCH_SIZE < filteredPages.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		logger.log(
			`[${directorySlug}] Content filtering complete. ${relevantPages.length} relevant pages found out of ${webPages.length} total pages.`
		);
		return relevantPages;
	}

	private buildSnippet(content: string): string {
		if (!content) return '';
		return content.length > this.SNIPPET_LENGTH ? content.slice(0, this.SNIPPET_LENGTH) : content;
	}
}
