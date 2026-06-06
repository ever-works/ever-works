import { z } from 'zod';
import type { MutableItemData, StepExecutionContext, FacadeOptions, IPromptFacade } from '@ever-works/plugin';
import type { StandardPipelineMetrics } from '../../context/index.js';
import { slugifyText } from '../../utils/text.utils.js';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas.js';
import { getErrorMessage, getErrorStack } from '../../utils/error.utils.js';
import { appendCustomPrompt } from '../../utils/prompt.utils.js';
import { MAX_CLUSTER_SIZE, chunkArray, groupSimilarItems } from './clustering.js';
import { DEDUPLICATOR_PROMPT } from './prompts.constants.js';
import { PROMPT_KEYS } from '../../prompt-keys.js';

type ExtractedItems = z.infer<typeof extractedItemsSchema>;

/**
 * Security (prompt-injection hardening): chat-template control markers that some
 * models interpret as out-of-band role/turn delimiters. Stripped from the
 * serialized item data before it is interpolated into the `<items>` block so
 * injected text inside an item's name/description/source_url cannot spoof a
 * system/user turn. Mirrors the canonical `sanitizeJsonForPrompt` in
 * `category-processing.step.ts` and `prompt.utils.ts`'s `neutralizeCustomPrompt`.
 */
const CHAT_TEMPLATE_MARKER_PATTERN = /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

/**
 * Security (prompt-injection hardening): the literal XML-style delimiter tags
 * that fence the sections of {@link DEDUPLICATOR_PROMPT}. The untrusted item
 * array (whose name/description/source_url originate from imported data repos,
 * scraped web content, or AI generation) is interpolated INSIDE the `<items>`
 * fence as serialized JSON, so a value that prints its own `</items>` (or any
 * sibling fence tag) could forge a boundary and have trailing imperative text
 * parsed as authoritative instructions. Matched (open or close) so the boundary
 * token can be defused wherever it appears.
 */
const PROMPT_FENCE_TOKEN_PATTERN = /<\/?(?:rules|examples|items|task)\b/gi;

/**
 * Security (prompt-injection hardening): defuse a forged fence boundary by
 * inserting a zero-width space right after the opening `<` of any fence tag.
 * This keeps the text human/model-readable while breaking the literal token the
 * boundary keys on. Mirrors `category-processing.step.ts`'s `neutralizeFenceTokens`.
 */
function neutralizeFenceTokens(value: string): string {
	return value.replace(PROMPT_FENCE_TOKEN_PATTERN, (token) => `${token[0]}​${token.slice(1)}`);
}

/**
 * Security (prompt-injection hardening): serialize untrusted item data and
 * neutralize prompt-injection vectors before it is interpolated into the fenced
 * `<items>` block. `JSON.stringify` already escapes real newlines (`\n` becomes
 * the two-character sequence `\n`), so the JSON structure stays intact and
 * legitimate data round-trips unchanged; we additionally strip chat-template
 * control markers and defuse forged fence tokens that would otherwise appear
 * verbatim inside string values and be read by the model as out-of-band
 * delimiters. Mirrors `category-processing.step.ts`'s `sanitizeJsonForPrompt`.
 */
function sanitizeJsonForPrompt(value: unknown): string {
	return neutralizeFenceTokens(JSON.stringify(value).replace(CHAT_TEMPLATE_MARKER_PATTERN, ''));
}

export class AiDeduplicator {
	private readonly CHUNK_DELAY_MS = 500;
	private readonly GROUP_DELAY_MS = 1000;

	private readonly logger: StepExecutionContext['logger'];
	private readonly aiFacade: StepExecutionContext['aiFacade'];
	private readonly promptFacade: IPromptFacade | undefined;
	private readonly facadeOptions: FacadeOptions;

	constructor(execContext: StepExecutionContext) {
		this.logger = execContext.logger;
		this.aiFacade = execContext.aiFacade;
		this.promptFacade = execContext.promptFacade;
		this.facadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};
	}

	async deduplicateWithAI(
		description: string,
		items: MutableItemData[],
		metrics: StandardPipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) return [];

		this.logger.log(`Starting AI deduplication for ${items.length} items`);

		if (items.length <= MAX_CLUSTER_SIZE) {
			return this.processSingleBatch(description, items, metrics, customPrompt);
		}

		return this.processLargeArray(description, items, metrics, customPrompt);
	}

	private async processSingleBatch(
		description: string,
		items: MutableItemData[],
		metrics: StandardPipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		try {
			const resolvedPrompt = (
				this.promptFacade
					? await this.promptFacade.getPrompt(PROMPT_KEYS.DEDUPLICATION, DEDUPLICATOR_PROMPT)
					: DEDUPLICATOR_PROMPT
			) as typeof DEDUPLICATOR_PROMPT;
			const finalPrompt = appendCustomPrompt(resolvedPrompt, customPrompt);
			const { result, usage, cost } = await this.aiFacade.askJson<ExtractedItems>(
				finalPrompt,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						task: description,
						// Security (prompt-injection hardening): item name/description/
						// source_url derive from imported data repos, scraped web content, or
						// AI generation; the serialized JSON is neutralized against fence/
						// role-marker forgery before it enters the <items> block.
						items: sanitizeJsonForPrompt(items.map((item) => ({ ...item })))
					},
					routing: { complexity: 'medium', taskId: 'ai-deduplication' }
				},
				this.facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return (result?.items || []).map(
				(item) =>
					({
						...item,
						slug: slugifyText(item.name),
						category: '',
						tags: [],
						featured: item.featured ?? undefined
					}) as MutableItemData
			);
		} catch (error) {
			this.logger.warn(`Error during AI deduplication batch: ${getErrorMessage(error)}`, getErrorStack(error));
			return items;
		}
	}

	private async processLargeArray(
		description: string,
		items: MutableItemData[],
		metrics: StandardPipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		const startTime = Date.now();
		const groups = groupSimilarItems(items, this.logger);
		this.logger.log(`Grouped ${items.length} items into ${groups.length} clusters`);

		let processedItems: MutableItemData[] = [];
		let totalProcessed = 0;

		for (let gi = 0; gi < groups.length; gi++) {
			const group = groups[gi];
			if (!group || group.length === 0) continue;

			if (group.length > MAX_CLUSTER_SIZE) {
				const chunks = chunkArray(group, MAX_CLUSTER_SIZE);

				for (let ci = 0; ci < chunks.length; ci++) {
					this.logger.debug(
						`Processing group ${gi + 1}/${groups.length}, chunk ${ci + 1}/${chunks.length} (${chunks[ci].length} items)`
					);
					const deduped = await this.processSingleBatch(description, chunks[ci], metrics, customPrompt);
					processedItems = processedItems.concat(deduped);
					totalProcessed += chunks[ci].length;
					this.logger.log(`Progress: ${totalProcessed}/${items.length} items processed`);

					if (ci < chunks.length - 1) await this.delay(this.CHUNK_DELAY_MS);
				}
			} else {
				this.logger.debug(`Processing group ${gi + 1}/${groups.length} (${group.length} items)`);
				const deduped = await this.processSingleBatch(description, group, metrics, customPrompt);
				processedItems = processedItems.concat(deduped);
				totalProcessed += group.length;
			}

			if (gi < groups.length - 1) await this.delay(this.GROUP_DELAY_MS);
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		this.logger.log(`Completed AI deduplication: ${items.length} → ${processedItems.length} items in ${elapsed}s`);

		return processedItems;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private accumulateMetrics(
		metrics: StandardPipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) metrics.steps = {};
		if (!metrics.steps['ai-deduplication']) {
			metrics.steps['ai-deduplication'] = { name: 'AI Deduplication', startTime: Date.now(), success: true };
		}
		const step = metrics.steps['ai-deduplication'];
		if (!step.custom) step.custom = {};
		if (usage) step.custom.totalTokens = ((step.custom.totalTokens as number) || 0) + usage.totalTokens;
		if (cost) step.custom.totalCost = ((step.custom.totalCost as number) || 0) + cost;
	}
}
