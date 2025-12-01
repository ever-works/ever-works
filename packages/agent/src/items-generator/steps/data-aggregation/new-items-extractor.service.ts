import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { BaseChatModel, ModelRouterService, TaskComplexity } from 'src/ai';
import { slugifyText } from '../../utils/text.utils';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas';
import { ItemData } from '../../dto';
import { SharedUtilsService } from './shared-utils.service';
import { EXTRACT_NEW_ITEMS_PROMPT } from './prompts.constants';

@Injectable()
export class NewItemsExtractorService {
    private readonly logger = new Logger(NewItemsExtractorService.name);
    private llm: BaseChatModel;

    constructor(
        private readonly modelRouter: ModelRouterService,
        private readonly sharedUtils: SharedUtilsService,
    ) {
        this.llm = this.modelRouter.getModel(TaskComplexity.MEDIUM, { temperature: 0 });
    }

    /**
     * Extracts new items that don't exist in the existing items
     * @param existingItems Existing items
     * @param newItems New items to filter
     */
    async extractNewItems(existingItems: ItemData[], newItems: ItemData[]): Promise<ItemData[]> {
        if (!newItems || newItems.length === 0) return [];
        if (!existingItems || existingItems.length === 0) return newItems;

        this.logger.log(
            `Starting new items extraction: comparing ${newItems.length} new items against ${existingItems.length} existing items`,
        );

        // Phase 1: Fast manual deduplication using multiple strategies
        this.logger.log('Phase 1: Performing fast manual deduplication...');
        const manuallyFiltered = this.sharedUtils.filterNewItemsManually(existingItems, newItems);

        const manualFilteredCount = newItems.length - manuallyFiltered.length;
        this.logger.log(
            `Manual deduplication removed ${manualFilteredCount} duplicates, ${manuallyFiltered.length} items remain for AI processing`,
        );

        // If no items remain after manual filtering, return empty array
        if (manuallyFiltered.length === 0) {
            this.logger.log(
                `Completed new items extraction: ${newItems.length} items → 0 new items (manual filtering only)`,
            );
            return [];
        }

        // Phase 2: AI-based deduplication for remaining items
        this.logger.log('Phase 2: Performing AI-based deduplication for remaining items...');

        // For small arrays, process directly
        if (manuallyFiltered.length <= this.sharedUtils.MAX_CLUSTER_SIZE) {
            const result = await this.processSingleExtractionBatch(existingItems, manuallyFiltered);
            this.logger.log(
                `Completed new items extraction: ${newItems.length} items → ${result.length} new items (through AI processing)`,
            );
            return result;
        }

        // For large arrays, use a chunking strategy
        return this.processLargeExtractionArray(existingItems, manuallyFiltered);
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
            // Find only relevant existing items to reduce AI payload
            const relevantExistingItems = this.sharedUtils.findRelevantExistingItems(
                newItems,
                existingItems,
                40, // Limit to 40 most relevant existing items
            );

            this.logger.log(
                `AI processing: comparing ${newItems.length} new items against ${relevantExistingItems.length} relevant existing items (filtered from ${existingItems.length} total)`,
            );

            const prompt = HumanMessagePromptTemplate.fromTemplate(EXTRACT_NEW_ITEMS_PROMPT);

            const result = await prompt
                .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
                .invoke({
                    existing: JSON.stringify(relevantExistingItems.map(this.sharedUtils.itemMap)),
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

            return newItems;
        }
    }

    /**
     * Process a large array of items for extraction using a chunking strategy
     * @param existingItems Existing items
     * @param newItems New items to filter
     */
    private async processLargeExtractionArray(
        existingItems: ItemData[],
        newItems: ItemData[],
    ): Promise<ItemData[]> {
        // Group similar items by name similarity to create more efficient chunks
        const groupedItems = this.sharedUtils.groupSimilarItems(newItems);
        this.logger.log(
            `Grouped ${newItems.length} new items into ${groupedItems.length} clusters for efficient processing`,
        );

        const relevantExistingItems = this.sharedUtils.findRelevantExistingItems(
            newItems,
            existingItems,
            70, // Limit to 70 most relevant existing items for large batches
        );

        this.logger.log(
            `Pre-filtered existing items: ${relevantExistingItems.length} relevant items (from ${existingItems.length} total) will be used for AI comparison`,
        );

        // Process each group in manageable chunks
        const CHUNK_SIZE = this.sharedUtils.MAX_CLUSTER_SIZE;
        let extractedItems: ItemData[] = [];
        let totalProcessed = 0;

        // Process each group
        for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex++) {
            const group = groupedItems[groupIndex];

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

                    const extractedChunk = await this.processSingleExtractionBatchWithRelevantItems(
                        relevantExistingItems,
                        chunk,
                    );
                    extractedChunks = extractedChunks.concat(extractedChunk);

                    totalProcessed += chunk.length;

                    this.logger.log(
                        `Progress: ${totalProcessed}/${newItems.length} items processed`,
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
                const extractedGroup = await this.processSingleExtractionBatchWithRelevantItems(
                    relevantExistingItems,
                    group,
                );
                extractedItems = extractedItems.concat(extractedGroup);

                totalProcessed += group.length;
                this.logger.log(`Progress: ${totalProcessed}/${newItems.length} items processed.`);
            }

            // Add a small delay between groups to avoid rate limiting
            if (groupIndex < groupedItems.length - 1) {
                await this.sharedUtils.addProcessingDelay(1000);
            }
        }

        this.logger.log(
            `Completed new items extraction: ${newItems.length} items → ${extractedItems.length} new items`,
        );

        return extractedItems;
    }

    /**
     * Process a single batch of items for extraction with pre-filtered relevant existing items
     * @param relevantExistingItems Pre-filtered relevant existing items
     * @param newItems New items to filter
     */
    private async processSingleExtractionBatchWithRelevantItems(
        relevantExistingItems: ItemData[],
        newItems: ItemData[],
    ): Promise<ItemData[]> {
        try {
            this.logger.log(
                `AI processing: comparing ${newItems.length} new items against ${relevantExistingItems.length} pre-filtered relevant existing items`,
            );

            const prompt = HumanMessagePromptTemplate.fromTemplate(EXTRACT_NEW_ITEMS_PROMPT);

            const result = await prompt
                .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
                .invoke({
                    existing: JSON.stringify(relevantExistingItems.map(this.sharedUtils.itemMap)),
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

            return newItems;
        }
    }
}
