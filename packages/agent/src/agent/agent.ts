import { Logger } from '@nestjs/common';
import { Identifiable, ItemData } from './types';
import { markdown } from './markdown';
import { generateQueries } from './queries';
import { aggregateSearchResults, extractContent, searchWeb } from './tavily';
import { generateItemsSubarray } from './generator';
import { arrayDiff, deduplicateByField } from './utils';
import { deduplicate, extractNewItems } from './deduplicator';
import { categorize } from './categorize';
import { detectType } from './detect';
import { slugifyText } from 'src/items-generator/utils/text.utils';

export interface GenerateOptions {
    maxQueries?: number;
    maxUrls?: number;
}

export class Agent {
    async generateInitialItems(task: string, options: GenerateOptions = {}) {
        Logger.log(`Running task: "${task}"`, 'Agent');
        return this.generateItems(task, [], options);
    }

    async generateNewItems(
        task: string,
        existingItems: Partial<ItemData>[],
        options: GenerateOptions = {},
    ) {
        Logger.log(`Running task: "${task}" to find new items`, 'Agent');
        return this.generateItems(task, existingItems, options);
    }

    /**
     * Generates items based on the task and existing items.
     * Steps:
     * - Detect the type of task - user may ask for software (time tracking apps) or development tools (like JS frameworks) etc.
     * - Generate search queries based on the task.
     * - Search the web for the queries using Tavily API.
     * - Extract content from the search results using Tavily API.
     * - Generate smaller subarrays with items for each extracted content.
     * - Deduplicate the items based on their slug and source URL.
     * - Categorize the items based on their features and descriptions.
     *
     * @param task User's prompt.
     * @param existingItems The existing items from data repo to compare against.
     * @param options The options for generating items.
     * @returns An object containing the generated items, categories, and tags.
     */
    private async generateItems(
        task: string,
        existingItems: Partial<ItemData>[] = [],
        options: GenerateOptions = {},
    ) {
        const type = await detectType(task);
        console.log(type.route); // TODO: you can use it to create some specialized prompts and searches (for example g2.com for software etc).

        const queries = await generateQueries(task, options.maxQueries);
        const searches = await Promise.all(queries.map((q) => searchWeb(q)));
        const urls = aggregateSearchResults(searches.flat(), options.maxUrls);
        const context = await extractContent(urls);

        // For each website we extract content from, we generate subarrays of items -> then we merge subarrays into one array (and later we need to deduplicate items)
        const subarrays = await Promise.all(
            context.map((c) => generateItemsSubarray(task, c.url, c.rawContent)),
        );
        const generated = subarrays.flat();
        const aggregated = deduplicateByField(deduplicateByField(generated, 'slug'), 'source_url');
        Logger.log(`Generated and aggregated ${aggregated.length} items`, 'Agent');
        const deduplicated = await deduplicate(
            task,
            aggregated.map((i) => ({
                name: i.name,
                description: i.description,
                url: i.source_url,
            })),
        );
        console.log(arrayDiff(aggregated, deduplicated, 'slug'));

        // Only filter for new items if we have existing items (initially we pass empty array)
        let itemsToProcess = deduplicated;
        if (existingItems.length > 0) {
            itemsToProcess = await extractNewItems(existingItems, deduplicated);
        }

        const categorized = await categorize(
            task,
            itemsToProcess.map((i) => ({
                name: i.name,
                description: i.description,
                url: i.source_url,
            })),
        );
        const categories = this.mapUnique(categorized.map((item) => item.category as string));
        const tags = this.mapUnique(categorized.flatMap((item) => item.tags as string[]));
        return { queries, urls, items: categorized.map(this.toItemData), categories, tags };
    }

    private mapUnique(names: string[]): Array<Identifiable> {
        const unique = new Set(names);
        return Array.from(unique).map((name) => ({ id: slugifyText(name), name }));
    }

    private toItemData(item: Partial<ItemData>): ItemData {
        return {
            name: item.name,
            description: item.description,
            source_url: item.source_url,
            category: slugifyText(item.category as string),
            tags: item.tags.map((tag) => slugifyText(tag)),
            slug: slugifyText(item.name),
        };
    }

    generateMarkdown(item: Partial<ItemData>) {
        return markdown(item);
    }
}
