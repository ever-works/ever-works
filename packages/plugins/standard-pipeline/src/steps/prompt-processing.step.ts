import { z } from 'zod';
import type { StepExecutionContext, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

const PROMPT_PROCESSING_PROMPT = `
# Prompt Extraction and Rewriting Task

You extract URLs, categories, priority indicators, featured item specifications, and the core subject from user prompts, then rewrite the prompt to focus only on the core task.

## Extraction Rules

### 1. URLs
Extract only explicitly mentioned URLs from the prompt.

### 2. Categories
Extract categories when explicitly mentioned with phrases like:
- "categories like X, Y, Z"
- "organize into categories: X, Y, Z"
- "categorize as X, Y, Z"

**Do NOT extract:**
- General descriptive terms
- Context examples not intended as categories
- Terms from prompts like "best time tracking for businesses" (where "businesses" is descriptive, not a category)

### 3. Priority Categories
Extract categories with priority indicators:
- "start with X" / "X first" / "X should come first"
- "prioritize X" / "X is priority"
- "most important is X"
- Numbered lists indicating order (1. X, 2. Y)

**Note:** Priority categories should also appear in the regular categories list.

### 4. Featured Items
Extract specifications for items that should be highlighted:
- "highlight X" / "feature X" / "showcase X"
- "X should be featured" / "emphasize X"
- "top X" / "best X" / "leading X"
- "popular X" / "recommended X"
- Specific named items (e.g., "highlight Docker and Kubernetes")
- Company-specific products when mentioned

### 5. Subject Extraction
Extract the core subject/topic that the user wants to build a directory about.
This is the main theme stripped of decorative words like "Awesome", "Best", "Top", "List of", etc.

Examples:
- "Awesome Apple Devices" → "Apple devices"
- "Awesome Vector Databases" → "vector databases"
- "Awesome DevOps" → "DevOps"
- "Awesome MCP" → "MCP"
- "AI Developer Tools" → "AI developer tools"
- "Best Time Tracking Apps" → "time tracking apps"
- "Top React Component Libraries" → "React component libraries"
- "List of Machine Learning Frameworks" → "machine learning frameworks"

The subject should be:
- Lowercase (except for proper nouns/acronyms like "React", "AI", "MCP", "DevOps")
- Singular or plural based on what makes grammatical sense
- Concise but descriptive enough to be useful for searches

## Prompt Rewriting

Remove ALL of the following while preserving the core task:
- URLs and reference instructions
- Category specifications and hints
- Priority indicators
- Featured item specifications
- Categorization instructions (e.g., "use license type as tag")

Combine separated instructions into a single, coherent task description.

**Output:** Clean prompt containing only essential task instructions.

## Input Format

<prompt>
{user_prompt}
</prompt>

## Output Format

Return:
1. Extracted URLs
2. Suggested categories (explicitly mentioned)
3. Priority categories (with priority indicators)
4. Featured item hints
5. Subject (core topic of the directory)
6. Rewritten prompt (core task only)` as const;

const promptProcessingOutputSchema = z.object({
	extractedUrls: z.array(z.string()).describe('List of URLs extracted from the prompt'),
	suggestedCategories: z.array(z.string()).describe('List of category hints extracted from the prompt'),
	priorityCategories: z
		.array(z.string())
		.describe(
			'List of categories that should appear first in the final output, extracted from priority indicators in the prompt'
		),
	featuredItemHints: z
		.array(z.string())
		.describe(
			'List of specifications about which items should be featured/highlighted, extracted from prominence indicators in the prompt'
		),
	subject: z
		.string()
		.describe('The core subject/topic of the directory, stripped of decorative words like "Awesome", "Best", etc.'),
	rewrittenPrompt: z.string().describe('The prompt rewritten without URLs but preserving context')
});

/**
 * Prompt Processing Step
 *
 * Extracts URLs, categories, priority indicators, and the core subject from
 * user prompts, then rewrites the prompt to focus only on the core task.
 */
export class PromptProcessingStep extends BasePipelineStep {
	readonly stepId = 'prompt-processing' as const;
	readonly name = 'Prompt Processing';

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, existing, directory, metrics } = context;
		const { logger, aiFacade, promptFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		logger.log(`[${directory.slug}] Prompt Processing - Starting`);

		const {
			extractedUrls: extractedUrlsFromPrompt,
			suggestedCategories,
			priorityCategories: promptPriorityCategories,
			featuredItemHints,
			subject,
			rewrittenPrompt: prompt
		} = await this.processPrompt(
			context,
			request.prompt || '',
			metrics,
			logger,
			aiFacade,
			facadeOptions,
			promptFacade
		);

		// Merge with request priority categories
		const requestPriorityCategories = (config.priority_categories as string[]) || [];
		const allPriorityCategories = [...requestPriorityCategories, ...promptPriorityCategories].filter(
			(category, index, arr) => arr.indexOf(category) === index
		);

		// Merge with request initial categories
		const requestInitialCategories = (config.initial_categories as string[]) || [];
		const allInitialCategories = [
			...requestInitialCategories,
			...suggestedCategories,
			...allPriorityCategories
		].filter((category, index, arr) => arr.indexOf(category) === index);

		// Update request with processed prompt
		context.request = {
			...request,
			prompt
		};

		// Merge extracted URLs with source URLs from config
		const sourceUrls = (config.source_urls as string[]) || [];
		let extractedUrls = [...extractedUrlsFromPrompt, ...sourceUrls];

		// Filter out already processed URLs for CREATE_UPDATE generation method
		const generationMethod = config.generation_method as string;
		const existingConfig = existing as unknown as {
			existingConfig?: {
				metadata?: {
					last_request_data?: {
						prompt?: string;
						source_urls?: string[];
					};
				};
			};
		};

		if (generationMethod === 'CREATE_UPDATE' && existingConfig.existingConfig?.metadata?.last_request_data) {
			const lastRequestData = existingConfig.existingConfig.metadata.last_request_data;
			extractedUrls = extractedUrls.filter((url) => {
				const lastSourceUrls = lastRequestData.source_urls || [];
				const lastPrompt = lastRequestData.prompt || '';
				return !lastSourceUrls.includes(url) && !lastPrompt.includes(url);
			});
		}

		// Update context state
		context.extractedUrls = extractedUrls;
		context.allInitialCategories = allInitialCategories;
		context.allPriorityCategories = allPriorityCategories;
		context.featuredItemHints = featuredItemHints;
		context.subject = subject;

		logger.log(`[${directory.slug}] Prompt Processing Complete`);
		logger.debug(
			`[${directory.slug}] Extracted ${extractedUrls.length} URLs, ${allInitialCategories.length} categories`
		);

		return context;
	}

	/**
	 * Process a prompt to extract URLs, categories, and other metadata
	 */
	private async processPrompt(
		context: MutableGenerationContext,
		prompt: string,
		metrics: StandardPipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<{
		extractedUrls: string[];
		suggestedCategories: string[];
		priorityCategories: string[];
		featuredItemHints: string[];
		subject: string;
		rewrittenPrompt: string;
	}> {
		if (!prompt) {
			logger.warn('No prompt provided for processing');
			return {
				extractedUrls: [],
				suggestedCategories: [],
				priorityCategories: [],
				featuredItemHints: [],
				subject: '',
				rewrittenPrompt: prompt || ''
			};
		}

		try {
			const resolvedPrompt = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.PROMPT_PROCESSING, PROMPT_PROCESSING_PROMPT)
					: PROMPT_PROCESSING_PROMPT
			) as typeof PROMPT_PROCESSING_PROMPT;

			const { result, usage, cost } = await aiFacade.askJson(
				resolvedPrompt,
				promptProcessingOutputSchema,
				{
					temperature: 0,
					variables: { user_prompt: prompt },
					routing: {
						complexity: 'simple',
						taskId: 'prompt-processing'
					}
				},
				facadeOptions
			);

			// Accumulate metrics
			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			const {
				extractedUrls,
				suggestedCategories,
				priorityCategories,
				featuredItemHints,
				subject,
				rewrittenPrompt
			} = result;

			const validatedUrls = this.validateUrls(extractedUrls);
			const cleanedCategories = this.cleanCategories(suggestedCategories);
			const cleanedPriorityCategories = this.cleanCategories(priorityCategories);
			const cleanedFeaturedItemHints = this.cleanCategories(featuredItemHints);

			return {
				extractedUrls: validatedUrls,
				suggestedCategories: cleanedCategories,
				priorityCategories: cleanedPriorityCategories,
				featuredItemHints: cleanedFeaturedItemHints,
				subject: subject?.trim() || '',
				rewrittenPrompt: validatedUrls.length > 0 ? rewrittenPrompt || prompt : prompt
			};
		} catch (error) {
			logger.error(`Error processing prompt: ${error instanceof Error ? error.message : String(error)}`);

			const fallbackUrls = this.extractUrlsWithRegex(prompt);
			const rewrittenPrompt =
				fallbackUrls.length > 0 ? this.rewritePromptWithoutUrls(prompt, fallbackUrls) : prompt;

			return {
				extractedUrls: fallbackUrls,
				suggestedCategories: [],
				priorityCategories: [],
				featuredItemHints: [],
				subject: this.extractSubjectFallback(prompt),
				rewrittenPrompt
			};
		}
	}

	/**
	 * Extract URLs from text using regex (fallback)
	 */
	private extractUrlsWithRegex(text: string): string[] {
		if (!text) return [];

		const urlRegex = /(https?:\/\/[^\s]+)/g;
		const matches = text.match(urlRegex);

		return this.validateUrls(matches || []);
	}

	/**
	 * Rewrite prompt without URLs
	 */
	private rewritePromptWithoutUrls(prompt: string, urls: string[]): string {
		if (!prompt || urls.length === 0) return prompt;

		let rewritten = prompt;
		urls.forEach((url) => {
			rewritten = rewritten.replace(url, '');
		});

		rewritten = rewritten.replace(/\s+/g, ' ').replace(/\s+\./g, '.').replace(/\s+,/g, ',').trim();

		return rewritten;
	}

	/**
	 * Validate URLs
	 */
	private validateUrls(urls: string[]): string[] {
		if (!urls || urls.length === 0) return [];

		return urls.filter((url) => {
			try {
				new URL(url);
				return true;
			} catch {
				return false;
			}
		});
	}

	/**
	 * Clean and normalize categories
	 */
	private cleanCategories(categories: string[]): string[] {
		if (!categories || categories.length === 0) return [];

		return categories
			.filter(Boolean)
			.map((category) => category.trim())
			.filter((category) => category.length > 0)
			.map((category) => {
				return category
					.replace(/\s+/g, ' ')
					.split(' ')
					.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
					.join(' ');
			})
			.filter((category, index, arr) => arr.indexOf(category) === index);
	}

	/**
	 * Extract subject from prompt (fallback)
	 */
	private extractSubjectFallback(prompt: string): string {
		if (!prompt) return '';

		const prefixPatterns = [
			/^awesome\s+/i,
			/^best\s+/i,
			/^top\s+/i,
			/^list\s+of\s+/i,
			/^collection\s+of\s+/i,
			/^curated\s+/i,
			/^ultimate\s+/i
		];

		let subject = prompt.trim();

		for (const pattern of prefixPatterns) {
			subject = subject.replace(pattern, '');
		}

		const words = subject.split(/\s+/).slice(0, 5);
		return words.join(' ').trim().toLowerCase();
	}
}
