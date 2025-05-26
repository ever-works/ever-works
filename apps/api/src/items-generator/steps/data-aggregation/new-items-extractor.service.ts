import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { AiService } from '../../shared';
import { slugifyText } from '../../utils/text.utils';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas';
import { ItemData } from '../../dto';
import { SharedUtilsService } from './shared-utils.service';
import { EXTRACT_NEW_ITEMS_PROMPT } from './prompts.constants';

@Injectable()
export class NewItemsExtractorService {
    private readonly logger = new Logger(NewItemsExtractorService.name);
    private llm: ChatOpenAI;

    constructor(
        private readonly aiService: AiService,
        private readonly sharedUtils: SharedUtilsService,
    ) {
        this.llm = this.aiService.createLlmWithTemperature(0.0);
    }

    /**
     * Extracts new items that don't exist in the existing items
     * @param existingItems Existing items
     * @param newItems New items to filter
     */
    async extractNewItems(existingItems: ItemData[], newItems: ItemData[]): Promise<ItemData[]> {
        if (!newItems || newItems.length === 0) return [];
        if (!existingItems || existingItems.length === 0) return newItems;

        const startTime = Date.now();
        this.logger.log(
            `Starting new items extraction: comparing ${newItems.length} new items against ${existingItems.length} existing items`,
        );

        // For small arrays, process directly
        if (newItems.length <= this.sharedUtils.MAX_CLUSTER_SIZE) {
            return this.processSingleExtractionBatch(existingItems, newItems);
        }

        // For large arrays, use a chunking strategy
        return this.processLargeExtractionArray(existingItems, newItems, startTime);
    }

    /**
     * Process a single batch of items for extraction
     * @param existingItems Existing items
     * @param newItems New items to filter
     */
    private async processSingleExtractionBatch(
        existingItems: ItemData[],
        newItems: ItemData[],
    ): Promise<ItemData[]> {
        try {
            const prompt = HumanMessagePromptTemplate.fromTemplate(EXTRACT_NEW_ITEMS_PROMPT);

            const result = await prompt
                .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
                .invoke({
                    existing: JSON.stringify(existingItems.map(this.sharedUtils.itemMap)),
                    new: JSON.stringify(newItems.map(this.sharedUtils.itemMap)),
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
            this.logger.error(
                `Error during new items extraction batch: ${error.message}`,
                error.stack,
            );
            // Fallback to the new items if AI extraction fails
            return newItems;
        }
    }

    /**
     * Process a large array of items for extraction using a chunking strategy
     * @param existingItems Existing items
     * @param newItems New items to filter
     * @param startTime Start time for logging
     */
    private async processLargeExtractionArray(
        existingItems: ItemData[],
        newItems: ItemData[],
        startTime: number,
    ): Promise<ItemData[]> {
        // Group similar items by name similarity to create more efficient chunks
        const groupedItems = this.sharedUtils.groupSimilarItems(newItems);
        this.logger.log(
            `Grouped ${newItems.length} new items into ${groupedItems.length} clusters for efficient processing`,
        );

        // Process each group in manageable chunks
        const CHUNK_SIZE = this.sharedUtils.MAX_CLUSTER_SIZE;
        let extractedItems: ItemData[] = [];
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
                let extractedChunks: ItemData[] = [];

                // Process each chunk
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    this.logger.log(
                        `Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`,
                    );

                    const extractedChunk = await this.processSingleExtractionBatch(
                        existingItems,
                        chunk,
                    );
                    extractedChunks = extractedChunks.concat(extractedChunk);

                    totalProcessed += chunk.length;
                    const elapsedSeconds = (Date.now() - startTime) / 1000;
                    this.logger.log(
                        `Progress: ${totalProcessed}/${newItems.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
                    );

                    // Add a small delay between chunks to avoid rate limiting
                    if (i < chunks.length - 1) {
                        await this.sharedUtils.addProcessingDelay(500);
                    }
                }

                extractedItems = extractedItems.concat(extractedChunks);
            } else {
                // Process small groups directly
                this.logger.log(
                    `Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`,
                );
                const extractedGroup = await this.processSingleExtractionBatch(
                    existingItems,
                    group,
                );
                extractedItems = extractedItems.concat(extractedGroup);

                totalProcessed += group.length;
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                this.logger.log(
                    `Progress: ${totalProcessed}/${newItems.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
                );
            }

            // Add a small delay between groups to avoid rate limiting
            if (groupIndex < groupedItems.length - 1) {
                await this.sharedUtils.addProcessingDelay(1000);
            }
        }

        // Final deduplication pass to ensure no duplicates in the result
        extractedItems = this.sharedUtils.deduplicateByField(
            this.sharedUtils.deduplicateByField(extractedItems, 'slug'),
            'source_url',
        );

        const totalTime = (Date.now() - startTime) / 1000;
        this.logger.log(
            `Completed new items extraction: ${newItems.length} items → ${extractedItems.length} new items in ${totalTime.toFixed(1)}s`,
        );

        return extractedItems;
    }
}
