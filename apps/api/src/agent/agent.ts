import { Logger } from "@nestjs/common";
import { Identifable, ItemData } from "./types";
import { markdown } from "./markdown";
import { generateQueries } from "./queries";
import { aggregateSearchResults, extractContent, searchWeb } from "./tavily";
import { generateSubarray } from "./generator";
import { arrayDiff, deduplicateByField } from "./utils";
import { deduplicate, extractNewItems } from "./deduplicator";
import { categorize } from "./categorize";
import slugify from "slugify";
import { router } from "./router";

export interface GenerateOptions {
    maxQueries?: number;
    maxUrls?: number;
}

export class Agent {
    async generateItems(task: string, options: GenerateOptions = {}) {
        Logger.log(`Running task: "${task}"`, 'Agent');
        const result = await router(task);
        console.log(result);

        const queries = await generateQueries(task, options.maxQueries);
        const searches = await Promise.all(queries.map(q => searchWeb(q)));
        const urls = aggregateSearchResults(searches.flat(), options.maxUrls);
        const context = await extractContent(urls);

        const subarrays = await Promise.all(context.map(c => generateSubarray(task, c.url, c.rawContent)));
        const generated = subarrays.flat();
        const aggregated = deduplicateByField(deduplicateByField(generated, 'slug'), 'source_url');
        Logger.log(`Generated and aggregated ${aggregated.length} items`, 'Agent');
        const deduplicated = await deduplicate(task, aggregated.map(i => ({ name: i.name, description: i.description, url: i.source_url })));
        console.log(arrayDiff(aggregated, deduplicated, 'slug'));

        const categorized = await categorize(task, deduplicated);
        const categories = this.mapUnique(categorized.map(item => item.category as string));
        const tags = this.mapUnique(categorized.flatMap(item => item.tags as string[]));
        return { queries, urls, items: categorized.map(this.toItemData), categories, tags };
    }

    private mapUnique(names: string[]): Array<Identifable> {
        const unique = new Set(names);
        return Array.from(unique).map(name => ({ id: slugify(name, { lower: true, trim: true }), name }));
    }

    private toItemData(item: Partial<ItemData>): ItemData {
        return {
            name: item.name,
            description: item.description,
            source_url: item.source_url,
            category: slugify(item.category as string, { lower: true, trim: true }),
            tags: item.tags.map(tag => slugify(tag, { lower: true, trim: true })),
            slug: slugify(item.name, { lower: true, trim: true }),
        };
    }

    async generateNewItems(task: string, existingItems: Partial<ItemData>[], options: GenerateOptions = {}) {
        Logger.log(`Running task: "${task}" to find new items`, 'Agent');
        const result = await router(task);
        console.log(result);

        const queries = await generateQueries(task, options.maxQueries);
        const searches = await Promise.all(queries.map(q => searchWeb(q)));
        const urls = aggregateSearchResults(searches.flat(), options.maxUrls);
        const context = await extractContent(urls);

        const subarrays = await Promise.all(context.map(c => generateSubarray(task, c.url, c.rawContent)));
        const generated = subarrays.flat();
        const aggregated = deduplicateByField(deduplicateByField(generated, 'slug'), 'source_url');
        Logger.log(`Generated and aggregated ${aggregated.length} items`, 'Agent');
        const deduplicated = await deduplicate(task, aggregated.map(i => ({ name: i.name, description: i.description, url: i.source_url })));
        console.log(arrayDiff(aggregated, deduplicated, 'slug'));
        const newItems = await extractNewItems(existingItems, deduplicated);

        const categorized = await categorize(task, newItems.map(i => ({ name: i.name, description: i.description, url: i.source_url })));
        const categories = this.mapUnique(categorized.map(item => item.category as string));
        const tags = this.mapUnique(categorized.flatMap(item => item.tags as string[]));
        return { queries, urls, items: categorized.map(this.toItemData), categories, tags };
    }

    generateMarkdown(item: Partial<ItemData>) {
        return markdown(item);
    }
}
