import { Injectable, Logger } from '@nestjs/common';
import { AiService, TaskComplexity } from 'src/ai';
import { slugifyText } from '../../utils/text.utils';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas';
import { ItemData } from '../../dto';
import { SharedUtilsService } from './shared-utils.service';
import { DEDUPLICATOR_PROMPT } from './prompts.constants';
import { getErrorMessage, getErrorStack } from '../../utils/error.util';
import { accumulateMetrics, MetricsAccumulator } from '../../utils/metrics.util';
import { appendCustomPrompt } from '../../utils/prompt.util';

@Injectable()
export class AiDeduplicatorService {
    private readonly CHUNK_DELAY_MS = 500;
    private readonly GROUP_DELAY_MS = 1000;

    private readonly logger = new Logger(AiDeduplicatorService.name);

    constructor(
        private readonly aiService: AiService,
        private readonly sharedUtils: SharedUtilsService,
    ) {}

    /**
     * Deduplicates items using AI with chunking for large arrays
     * @param description Description of the directory
     * @param items Items to deduplicate
     * @param metrics Optional metrics accumulator for tracking token usage
     * @param customPrompt Optional custom prompt to append
     */
    async deduplicateWithAI(
        description: string,
        items: ItemData[],
        metrics?: MetricsAccumulator,
        customPrompt?: string | null,
    ): Promise<ItemData[]> {
        if (!items || items.length === 0) return [];

        const startTime = Date.now();
        this.logger.log(`Starting AI deduplication for ${items.length} items`);

        // For small arrays, process directly
        if (items.length <= this.sharedUtils.MAX_CLUSTER_SIZE) {
            return this.processSingleDeduplicationBatch(description, items, metrics, customPrompt);
        }

        // For large arrays, use a chunking strategy
        return this.processLargeDeduplicationArray(
            description,
            items,
            startTime,
            metrics,
            customPrompt,
        );
    }

    /**
     * Process a single batch of items for deduplication
     * @param description Description of the directory
     * @param items Items to deduplicate
     * @param metrics Optional metrics accumulator
     * @param customPrompt Optional custom prompt to append
     */
    private async processSingleDeduplicationBatch(
        description: string,
        items: ItemData[],
        metrics?: MetricsAccumulator,
        customPrompt?: string | null,
    ): Promise<ItemData[]> {
        try {
            const finalPrompt = appendCustomPrompt(DEDUPLICATOR_PROMPT, customPrompt);
            const { result, usage, cost } = await this.aiService.askJson(
                finalPrompt,
                extractedItemsSchema,
                {
                    temperature: 0,
                    variables: {
                        task: description,
                        items: JSON.stringify(items.map((item) => this.sharedUtils.itemMap(item))),
                    },
                    routing: {
                        complexity: TaskComplexity.MEDIUM,
                        taskId: 'ai-deduplication',
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            return result.items.map((item) => {
                return <ItemData>{
                    ...item,
                    slug: slugifyText(item.name),
                    category: '',
                    tags: [],
                };
            });
        } catch (error) {
            // Fallback to the original items if AI deduplication fails
            this.logger.warn(
                `Error during AI deduplication batch: ${getErrorMessage(error)}`,
                getErrorStack(error),
            );
            return items;
        }
    }

    /**
     * Process a large array of items for deduplication using a chunking strategy
     * @param description Description of the directory
     * @param items Items to deduplicate
     * @param startTime Start time for logging
     * @param metrics Optional metrics accumulator
     * @param customPrompt Optional custom prompt to append
     */
    private async processLargeDeduplicationArray(
        description: string,
        items: ItemData[],
        startTime: number,
        metrics?: MetricsAccumulator,
        customPrompt?: string | null,
    ): Promise<ItemData[]> {
        // Group similar items by name similarity to create more efficient chunks
        const groupedItems = this.sharedUtils.groupSimilarItems(items);
        this.logger.log(
            `Grouped ${items.length} items into ${groupedItems.length} clusters for efficient processing`,
        );

        // Process each group in manageable chunks
        const CHUNK_SIZE = this.sharedUtils.MAX_CLUSTER_SIZE;
        let processedItems: ItemData[] = [];
        let totalProcessed = 0;

        // Process each group
        for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex++) {
            const group = groupedItems[groupIndex];

            if (!group || group.length === 0) continue;

            // Process large groups in chunks
            if (group.length > CHUNK_SIZE) {
                // Process the group in chunks (for large group)
                const chunks = this.sharedUtils.chunkArray(group, CHUNK_SIZE);
                let deduplicatedChunks: ItemData[] = [];

                // Process each chunk
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    this.logger.debug(
                        `Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`,
                    );

                    const deduplicatedChunk = await this.processSingleDeduplicationBatch(
                        description,
                        chunk,
                        metrics,
                        customPrompt,
                    );
                    deduplicatedChunks = deduplicatedChunks.concat(deduplicatedChunk);

                    totalProcessed += chunk.length;

                    this.logger.log(`Progress: ${totalProcessed}/${items.length} items processed`);

                    // Add a small delay between chunks to avoid rate limiting
                    if (i < chunks.length - 1) {
                        await this.sharedUtils.addProcessingDelay(this.CHUNK_DELAY_MS);
                    }
                }

                processedItems = processedItems.concat(deduplicatedChunks);
            } else {
                // Process small groups directly
                this.logger.debug(
                    `Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`,
                );
                const deduplicatedGroup = await this.processSingleDeduplicationBatch(
                    description,
                    group,
                    metrics,
                    customPrompt,
                );
                processedItems = processedItems.concat(deduplicatedGroup);

                totalProcessed += group.length;
            }

            // Add a small delay between groups to avoid rate limiting
            if (groupIndex < groupedItems.length - 1) {
                await this.sharedUtils.addProcessingDelay(this.GROUP_DELAY_MS);
            }
        }

        const totalTime = (Date.now() - startTime) / 1000;
        this.logger.log(
            `Completed AI deduplication: ${items.length} items → ${processedItems.length} items in ${totalTime.toFixed(1)}s`,
        );

        return processedItems;
    }
}
