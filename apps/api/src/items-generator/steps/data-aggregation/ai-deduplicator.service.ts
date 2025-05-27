import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { AiService } from '../../shared';
import { slugifyText } from '../../utils/text.utils';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas';
import { ItemData } from '../../dto';
import { SharedUtilsService } from './shared-utils.service';
import { DEDUPLICATOR_PROMPT } from './prompts.constants';

@Injectable()
export class AiDeduplicatorService {
    private readonly logger = new Logger(AiDeduplicatorService.name);
    private llm: ChatOpenAI;

    constructor(
        private readonly aiService: AiService,
        private readonly sharedUtils: SharedUtilsService,
    ) {
        this.llm = this.aiService.createLlmWithTemperature(0.0); // Use temperature 0 for deterministic results
    }

    /**
     * Deduplicates items using AI with chunking for large arrays
     * @param description Description of the directory
     * @param items Items to deduplicate
     */
    async deduplicateWithAI(description: string, items: ItemData[]): Promise<ItemData[]> {
        if (!items || items.length === 0) return [];

        const startTime = Date.now();
        this.logger.log(`Starting AI deduplication for ${items.length} items`);

        // For small arrays, process directly
        if (items.length <= this.sharedUtils.MAX_CLUSTER_SIZE) {
            return this.processSingleDeduplicationBatch(description, items);
        }

        // For large arrays, use a chunking strategy
        return this.processLargeDeduplicationArray(description, items, startTime);
    }

    /**
     * Process a single batch of items for deduplication
     * @param description Description of the directory
     * @param items Items to deduplicate
     */
    private async processSingleDeduplicationBatch(
        description: string,
        items: ItemData[],
    ): Promise<ItemData[]> {
        try {
            const prompt = HumanMessagePromptTemplate.fromTemplate(DEDUPLICATOR_PROMPT);

            const result = await prompt
                .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
                .invoke({
                    task: description,
                    items: JSON.stringify(items.map((item) => this.sharedUtils.itemMap(item))),
                });

            return result.items.map((item) => {
                return <ItemData>{
                    ...item,
                    slug: slugifyText(item.name),
                    category: '',
                    tags: [],
                };
            });
        } catch (error) {
            this.logger.error(`Error during AI deduplication batch: ${error.message}`, error.stack);

            // Fallback to the original items if AI deduplication fails
            return items;
        }
    }

    /**
     * Process a large array of items for deduplication using a chunking strategy
     * @param description Description of the directory
     * @param items Items to deduplicate
     * @param startTime Start time for logging
     */
    private async processLargeDeduplicationArray(
        description: string,
        items: ItemData[],
        startTime: number,
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

            // Skip empty groups
            if (!group || group.length === 0) continue;

            // Process large groups in chunks
            if (group.length > CHUNK_SIZE) {
                // Process the group in chunks
                const chunks = this.sharedUtils.chunkArray(group, CHUNK_SIZE);
                let deduplicatedChunks: ItemData[] = [];

                // Process each chunk
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    this.logger.log(
                        `Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`,
                    );

                    const deduplicatedChunk = await this.processSingleDeduplicationBatch(
                        description,
                        chunk,
                    );
                    deduplicatedChunks = deduplicatedChunks.concat(deduplicatedChunk);

                    totalProcessed += chunk.length;
                    const elapsedSeconds = (Date.now() - startTime) / 1000;
                    this.logger.log(
                        `Progress: ${totalProcessed}/${items.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
                    );

                    // Add a small delay between chunks to avoid rate limiting
                    if (i < chunks.length - 1) {
                        await this.sharedUtils.addProcessingDelay(500);
                    }
                }

                processedItems = processedItems.concat(deduplicatedChunks);
            } else {
                // Process small groups directly
                this.logger.log(
                    `Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`,
                );
                const deduplicatedGroup = await this.processSingleDeduplicationBatch(
                    description,
                    group,
                );
                processedItems = processedItems.concat(deduplicatedGroup);

                totalProcessed += group.length;
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                this.logger.log(
                    `Progress: ${totalProcessed}/${items.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
                );
            }

            // Add a small delay between groups to avoid rate limiting
            if (groupIndex < groupedItems.length - 1) {
                await this.sharedUtils.addProcessingDelay(1000);
            }
        }

        const totalTime = (Date.now() - startTime) / 1000;
        this.logger.log(
            `Completed AI deduplication: ${items.length} items → ${processedItems.length} items in ${totalTime.toFixed(1)}s`,
        );

        return processedItems;
    }
}
