import { z } from 'zod';
import type { StepExecutionContext, MutableItemData, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { getErrorStack } from '../utils/error.utils.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

/**
 * Security (prompt-injection hardening): chat-template control markers that some
 * models interpret as out-of-band role/turn delimiters. Stripped from every
 * untrusted value before it is interpolated into {@link MARKDOWN_PROMPT} so
 * injected text cannot spoof a system/user turn. Mirrors the sibling
 * `item-extraction.step.ts` / `source-validation.step.ts` and the canonical
 * `sanitizePromptVariable` in `@ever-works/agent`'s `item-health.service.ts`.
 */
const CHAT_TEMPLATE_MARKER_PATTERN = /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

/**
 * Security (prompt-injection hardening): the literal XML-style delimiter tags
 * that fence the sections of {@link MARKDOWN_PROMPT}. The item JSON (whose
 * `name`/`description`/`source_url` were AI-extracted from attacker-controlled
 * page text) is interpolated inside `<item>` and the fetched page body inside
 * `<content>`, so a value that prints its own `</item>`, `</content>`, or a
 * forged `<rules>` block could break the fence and have trailing imperative text
 * parsed as authoritative instructions. Matched (open or close) so the boundary
 * token can be defused wherever it appears.
 */
const PROMPT_FENCE_TOKEN_PATTERN = /<\/?(?:item|content|rules)\b/gi;

/**
 * Security (prompt-injection hardening): defuse a forged fence boundary by
 * inserting a zero-width space right after the opening `<` of any fence tag.
 * This keeps the text human/model-readable while breaking the literal token the
 * boundary keys on. Mirrors `prompt.utils.ts`'s `neutralizeCustomPrompt` and
 * `item-extraction.step.ts`'s `neutralizeFenceTokens`.
 */
function neutralizeFenceTokens(value: string): string {
	return value.replace(PROMPT_FENCE_TOKEN_PATTERN, (token) => `${token[0]}​${token.slice(1)}`);
}

/**
 * Security (prompt-injection hardening): sanitize raw web-page content before it
 * is interpolated into the `<content>` block. Newlines are PRESERVED because
 * legitimate pages are multi-line and the markdown structure is meaningful for
 * summarization — only forged fence tokens and chat-template control markers are
 * neutralized. The caller still applies the 4000-char cap.
 */
function sanitizePageContent(value: string): string {
	return neutralizeFenceTokens(value.replace(CHAT_TEMPLATE_MARKER_PATTERN, ''));
}

/**
 * Security (prompt-injection hardening): the item's `name`, `description`, and
 * `source_url` are AI-extracted from attacker-controlled page text in the prior
 * extraction step, then serialized via `JSON.stringify` into the `<item>` block.
 * Sanitize each string field in place (forged fence tokens neutralized,
 * chat-template markers stripped) BEFORE serialization so the JSON stays
 * well-formed and benign content is unchanged, while an injected
 * `</item><rules>…` payload can no longer break out of the fence. Nested
 * string values (e.g. badge/array fields) are sanitized recursively.
 */
function sanitizePromptValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return neutralizeFenceTokens(value.replace(CHAT_TEMPLATE_MARKER_PATTERN, ''));
	}
	if (Array.isArray(value)) {
		return value.map(sanitizePromptValue);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			out[key] = sanitizePromptValue(val);
		}
		return out;
	}
	return value;
}

export const MARKDOWN_PROMPT = `
You are work website builder and your task is to generate markdown summary for item:
<item>
{item}
</item>

<rules>
1. Many websites will contain marketing language, make sure to extract only relevant information.
2. Exclude anything related to Testimonials, "Why Choose" specific product and other marketing / sales details.
3. No need to include any info about "Support" if item is a product.
4. Make sure we output ALL features (as much as possible) of the item inside "Features" block, not only Key Features.
5. If item is a product/service, make sure to include "Pricing" block with all available plans (if provided content contains it).
</rules>

Based on this website content:
<content>
{content}
</content>` as const;

// Output schema for validation
const markdownOutputSchema = z.object({
	markdown: z.string()
});

type MarkdownOutput = z.infer<typeof markdownOutputSchema>;

/**
 * Markdown Generation Step
 *
 * Generates detailed markdown summaries for items based on their source content.
 */
export class MarkdownGenerationStep extends BasePipelineStep {
	readonly name = 'Markdown Generation';
	readonly stepId = 'markdown-generation' as const;
	private readonly BATCH_SIZE = 10;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { work, finalItems, contentCache, metrics } = context;
		const { logger, aiFacade, contentExtractorFacade, promptFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		if (!finalItems || finalItems.length === 0) {
			return context;
		}

		logger.log(`[${work.slug}] Generating markdown for ${finalItems.length} items`);

		const itemsWithMarkdown = await this.generateMarkdownForItems(
			finalItems,
			contentCache,
			metrics,
			logger,
			aiFacade,
			contentExtractorFacade,
			facadeOptions,
			promptFacade
		);

		context.finalItems = itemsWithMarkdown;
		return context;
	}

	/**
	 * Generates markdown summaries for multiple items.
	 * Items without source_url get empty markdown (no hallucination).
	 */
	private async generateMarkdownForItems(
		items: MutableItemData[],
		contentCache: Map<string, string> | undefined,
		metrics: StandardPipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) {
			return [];
		}

		// Separate items: only items with source_url can get AI-generated markdown
		const itemsWithContent = items.filter((item) => item.source_url);
		const itemsWithoutContent = items.filter((item) => !item.source_url);

		if (itemsWithoutContent.length > 0) {
			logger.log(`Skipping markdown generation for ${itemsWithoutContent.length} items without source URLs`);
		}

		const processedItems: MutableItemData[] = [];

		const resolvedPrompt = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.MARKDOWN_GENERATION, MARKDOWN_PROMPT)
				: MARKDOWN_PROMPT
		) as typeof MARKDOWN_PROMPT;

		// Process items with content in batches
		for (let i = 0; i < itemsWithContent.length; i += this.BATCH_SIZE) {
			const batch = itemsWithContent.slice(i, i + this.BATCH_SIZE);

			const markdownPromises = batch.map(async (item) => {
				const markdown = await this.generateMarkdown(
					item,
					contentCache,
					metrics,
					logger,
					aiFacade,
					contentExtractorFacade,
					facadeOptions,
					resolvedPrompt
				);
				return {
					...item,
					markdown
				};
			});

			const batchResults = await Promise.all(markdownPromises);
			processedItems.push(...batchResults);

			if (i + this.BATCH_SIZE < itemsWithContent.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		// Items without source content get empty markdown (no hallucination)
		for (const item of itemsWithoutContent) {
			processedItems.push({ ...item, markdown: '' });
		}

		return processedItems;
	}

	/**
	 * Generates markdown summary for a given item
	 */
	private async generateMarkdown(
		item: MutableItemData,
		contentCache: Map<string, string> | undefined,
		metrics: StandardPipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		resolvedPrompt: typeof MARKDOWN_PROMPT
	): Promise<string> {
		if (!item || !item.source_url) {
			logger.warn(`Cannot generate markdown: Missing item or source URL`);
			return '';
		}

		try {
			// Check cache first for content
			let rawContent = contentCache?.get(item.source_url);

			if (!rawContent) {
				// Fall back to fetching if not in cache
				const content = await this.extractContentFrom(
					item.source_url,
					logger,
					contentExtractorFacade,
					facadeOptions
				);
				rawContent = content?.rawContent;
			}

			if (!rawContent) {
				logger.warn(`Failed to get content for: "${item.source_url}"`);
				return '';
			}

			if (!aiFacade.isConfigured()) {
				logger.warn('AI provider not configured, skipping markdown generation');
				return '';
			}

			// Generate markdown using the content
			const { result, usage, cost } = await aiFacade.askJson<MarkdownOutput>(
				resolvedPrompt,
				markdownOutputSchema,
				{
					temperature: 0.6,
					variables: {
						// Security (prompt-injection hardening): item fields
						// (name/description/source_url) are AI-extracted from
						// attacker-controlled page text and the page body is fetched
						// from an attacker-controllable URL. Both are fenced inside
						// <item>/<content>; sanitize each so forged fence tokens
						// (</item>, </content>, <rules>) + chat-template markers
						// cannot break out and inject authoritative instructions.
						item: JSON.stringify(sanitizePromptValue(item)),
						content: sanitizePageContent(rawContent).slice(0, 4000)
					},
					routing: {
						complexity: 'simple',
						taskId: 'markdown-generation'
					}
				},
				facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return result.markdown || '';
		} catch (error) {
			logger.error(
				`Error generating markdown for ${item.name}: ${this.formatError(error)}`,
				getErrorStack(error)
			);
			return '';
		}
	}

	/**
	 * Extracts content from a URL using the content extractor facade
	 */
	private async extractContentFrom(
		url: string,
		logger: StepExecutionContext['logger'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions
	): Promise<{ rawContent: string } | null> {
		try {
			const content = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);
			return content ? { rawContent: content.rawContent } : null;
		} catch (error) {
			logger.error(`Error extracting content from ${url}: ${this.formatError(error)}`);
			return null;
		}
	}
}
