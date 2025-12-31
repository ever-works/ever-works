import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { AiService, TaskComplexity } from '@src/ai';
import { Category, ItemData, Tag } from '@src/items-generator/dto';
import { slugifyText } from '@src/items-generator/utils/text.utils';
import { accumulateMetrics, MetricsAccumulator } from '@src/items-generator/utils/metrics.util';

const categorySchema = z.object({
    id: z.string().describe('URL-friendly ID for the category, lowercase with hyphens'),
    name: z.string().describe('Human-readable name of the category'),
    description: z.string().nullable().describe('Brief description of what items belong here'),
});

const extractedCategoriesSchema = z.object({
    categories: z.array(categorySchema).describe('List of categories extracted from the README'),
});

const awesomeItemSchema = z.object({
    name: z.string().describe('Name of the item (usually link text)'),
    description: z.string().describe('Description of the item'),
    source_url: z.string().nullable().describe('URL of the item'),
    category: z.string().describe('Category this item belongs to'),
    tags: z.array(z.string()).nullable().describe('Tags extracted from brackets or context'),
});

type AwesomeItem = z.infer<typeof awesomeItemSchema>;

const extractedItemsSchema = z.object({
    items: z.array(awesomeItemSchema).describe('List of items extracted from the section'),
});

export interface ParsedAwesomeData {
    items: ItemData[];
    categories: Category[];
    tags: Tag[];
    metadata: {
        totalItemsFound: number;
        categoriesFound: number;
        parseErrors: string[];
    };
    metrics: {
        total_tokens_used: number;
        total_cost: number;
    };
}

const CATEGORY_EXTRACTION_PROMPT =
    `You are a structured data extractor. Your task is to analyze a GitHub Awesome List README and extract the category/section structure.

<readme_content>
{content}
</readme_content>

<rules>
1. Identify all sections that represent categories of items
2. Categories are typically H2 (##) or H3 (###) headings
3. Ignore meta sections like:
   - Table of Contents / Contents
   - Contributing / Contribution Guidelines
   - License
   - Authors / Maintainers
   - Acknowledgments / Credits
   - Related / See Also
   - Resources (unless it contains actual items)
4. Create URL-friendly IDs from category names (lowercase, hyphens instead of spaces)
5. Include a brief description if the README provides one
6. Return categories in the order they appear
</rules>

Extract all content categories from this README.` as const;

const ITEM_EXTRACTION_PROMPT =
    `You are a structured data extractor. Your task is to extract directory items from an Awesome List README section.

<category_context>
Category: {categoryName}
Category ID: {categoryId}
</category_context>

<section_content>
{sectionContent}
</section_content>

<rules>
1. Each markdown list item (- or *) typically represents one item
2. Extract the item name - usually in bold (**name**) or as link text [name](url)
3. Extract the URL - usually the first link in the item
4. Extract the description - text after the link/name, often after a dash or hyphen
5. Assign the category provided above
6. Look for tags in:
   - Brackets like [JavaScript], [Open Source], [Paid]
   - Parentheses like (MIT License)
   - Explicit labels or badges

Common item formats to recognize:
- **[Name](url)** - Description
- [Name](url) - Description
- **Name** - Description [website](url)
- [Name](url): Description
- **Name** ([website](url)) - Description

Only extract items that have:
- A valid name (not empty)
- A description OR a URL

Skip:
- Section headers
- Empty list items
- Items that are just links to other sections
</rules>

Extract all items from this section.` as const;

@Injectable()
export class AwesomeReadmeParserService {
    private readonly logger = new Logger(AwesomeReadmeParserService.name);

    private readonly MAX_CHUNK_SIZE = 3000;
    private readonly CHUNK_OVERLAP = 200;
    private readonly CATEGORY_CHUNK_SIZE = 8000;
    private readonly BATCH_DELAY_MS = 500;

    private textSplitter: RecursiveCharacterTextSplitter;
    private categoryTextSplitter: RecursiveCharacterTextSplitter;

    constructor(private readonly aiService: AiService) {
        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.MAX_CHUNK_SIZE,
            chunkOverlap: this.CHUNK_OVERLAP,
            separators: ['\n## ', '\n### ', '\n#### ', '\n- ', '\n* ', '\n\n', '\n', '. ', ' ', ''],
        });

        this.categoryTextSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.CATEGORY_CHUNK_SIZE,
            chunkOverlap: this.CHUNK_OVERLAP,
            separators: ['\n## ', '\n### ', '\n\n', '\n'],
        });
    }

    async parseReadme(content: string): Promise<ParsedAwesomeData> {
        const parseErrors: string[] = [];
        const metrics: MetricsAccumulator = {
            total_tokens_used: 0,
            total_cost: 0,
        };

        let categories: Category[];
        try {
            categories = await this.extractCategories(content, metrics);
        } catch (error) {
            this.logger.error('Failed to extract categories', error);
            parseErrors.push(`Category extraction failed: ${error.message}`);
            categories = this.fallbackCategoryExtraction(content);
        }

        const allItems: ItemData[] = [];
        const sections = this.splitIntoSections(content, categories);

        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            try {
                const items = await this.extractItemsFromSection(
                    section.content,
                    section.categoryName,
                    section.categoryId,
                    metrics,
                );
                allItems.push(...items);
            } catch (error) {
                this.logger.error(`Failed to extract items from ${section.categoryName}`, error);
                parseErrors.push(
                    `Item extraction failed for ${section.categoryName}: ${error.message}`,
                );
            }

            if (i < sections.length - 1) {
                await this.delay(this.BATCH_DELAY_MS);
            }
        }

        const tags = this.extractUniqueTags(allItems);
        const uniqueItems = this.deduplicateItems(allItems);

        return {
            items: uniqueItems,
            categories,
            tags,
            metadata: {
                totalItemsFound: uniqueItems.length,
                categoriesFound: categories.length,
                parseErrors,
            },
            metrics: {
                total_tokens_used: metrics.total_tokens_used || 0,
                total_cost: metrics.total_cost || 0,
            },
        };
    }

    private async extractCategories(
        content: string,
        metrics: MetricsAccumulator,
    ): Promise<Category[]> {
        if (content.length <= this.CATEGORY_CHUNK_SIZE) {
            return this.extractCategoriesFromChunk(content, metrics);
        }

        const chunks = await this.categoryTextSplitter.splitText(content);
        const allCategories: Category[] = [];
        const seenIds = new Set<string>();

        for (let i = 0; i < chunks.length; i++) {
            try {
                const chunkCategories = await this.extractCategoriesFromChunk(chunks[i], metrics);
                for (const cat of chunkCategories) {
                    if (!seenIds.has(cat.id)) {
                        seenIds.add(cat.id);
                        allCategories.push(cat);
                    }
                }
            } catch {
                continue;
            }

            if (i < chunks.length - 1) {
                await this.delay(this.BATCH_DELAY_MS);
            }
        }

        return allCategories;
    }

    private async extractCategoriesFromChunk(
        content: string,
        metrics: MetricsAccumulator,
    ): Promise<Category[]> {
        const { result, usage, cost } = await this.aiService.askJson(
            CATEGORY_EXTRACTION_PROMPT,
            extractedCategoriesSchema,
            {
                variables: { content },
                temperature: 0.1,
                routing: {
                    complexity: TaskComplexity.MEDIUM,
                    taskId: 'awesome-category-extraction',
                },
            },
        );

        accumulateMetrics(metrics, usage, cost);

        return result.categories.map((cat) => ({
            id: cat.id || slugifyText(cat.name),
            name: cat.name,
            description: cat.description,
        }));
    }

    private fallbackCategoryExtraction(content: string): Category[] {
        const categories: Category[] = [];
        const headerRegex = /^#{2,3}\s+(.+)$/gm;
        const nonCategoryHeaders = [
            'contents',
            'table of contents',
            'contributing',
            'license',
            'authors',
            'acknowledgments',
            'resources',
            'related',
            'see also',
            'about',
            'introduction',
        ];

        let match: RegExpExecArray | null;
        while ((match = headerRegex.exec(content)) !== null) {
            const name = match[1].trim();
            const normalizedName = name.toLowerCase();

            if (
                !nonCategoryHeaders.some(
                    (nc) => normalizedName === nc || normalizedName.startsWith(`${nc} `),
                )
            ) {
                categories.push({
                    id: slugifyText(name),
                    name,
                });
            }
        }

        return categories;
    }

    private splitIntoSections(
        content: string,
        categories: Category[],
    ): Array<{ categoryName: string; categoryId: string; content: string }> {
        const sections: Array<{ categoryName: string; categoryId: string; content: string }> = [];

        for (let i = 0; i < categories.length; i++) {
            const category = categories[i];
            const nextCategory = categories[i + 1];

            const categoryRegex = new RegExp(
                `^#{2,3}\\s+${this.escapeRegex(category.name)}.*$`,
                'im',
            );
            const match = content.match(categoryRegex);

            if (match && match.index !== undefined) {
                const startIndex = match.index + match[0].length;
                let endIndex: number;

                if (nextCategory) {
                    const nextCategoryRegex = new RegExp(
                        `^#{2,3}\\s+${this.escapeRegex(nextCategory.name)}`,
                        'im',
                    );
                    const nextMatch = content.substring(startIndex).match(nextCategoryRegex);
                    endIndex = nextMatch?.index ? startIndex + nextMatch.index : content.length;
                } else {
                    endIndex = content.length;
                }

                const sectionContent = content.substring(startIndex, endIndex).trim();

                if (sectionContent && /^[-*]\s+/m.test(sectionContent)) {
                    sections.push({
                        categoryName: category.name,
                        categoryId: category.id,
                        content: sectionContent,
                    });
                }
            }
        }

        return sections;
    }

    private async extractItemsFromSection(
        sectionContent: string,
        categoryName: string,
        categoryId: string,
        metrics: MetricsAccumulator,
    ): Promise<ItemData[]> {
        const extractedItems: ItemData[] = [];

        if (sectionContent.length > this.MAX_CHUNK_SIZE) {
            const chunks = await this.textSplitter.splitText(sectionContent);

            for (let i = 0; i < chunks.length; i++) {
                try {
                    const { result, usage, cost } = await this.aiService.askJson(
                        ITEM_EXTRACTION_PROMPT,
                        extractedItemsSchema,
                        {
                            variables: { categoryName, categoryId, sectionContent: chunks[i] },
                            temperature: 0.1,
                            routing: {
                                complexity: TaskComplexity.MEDIUM,
                                taskId: 'awesome-item-extraction-chunk',
                            },
                        },
                    );

                    accumulateMetrics(metrics, usage, cost);

                    for (const item of result.items || []) {
                        extractedItems.push(this.mapToItemData(item, categoryId));
                    }
                } catch {
                    continue;
                }

                if (i < chunks.length - 1) {
                    await this.delay(this.BATCH_DELAY_MS);
                }
            }
        } else {
            const { result, usage, cost } = await this.aiService.askJson(
                ITEM_EXTRACTION_PROMPT,
                extractedItemsSchema,
                {
                    variables: { categoryName, categoryId, sectionContent },
                    temperature: 0.1,
                    routing: {
                        complexity: TaskComplexity.MEDIUM,
                        taskId: 'awesome-item-extraction',
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            for (const item of result.items) {
                extractedItems.push(this.mapToItemData(item, categoryId));
            }
        }

        return this.deduplicateItems(extractedItems);
    }

    private mapToItemData(item: AwesomeItem, categoryId: string): ItemData {
        return {
            name: item.name,
            description: item.description || '',
            source_url: item.source_url || '',
            category: categoryId,
            tags: item.tags || [],
            slug: slugifyText(item.name),
            featured: false,
        };
    }

    private extractUniqueTags(items: ItemData[]): Tag[] {
        const tagSet = new Set<string>();

        for (const item of items) {
            if (item.tags && Array.isArray(item.tags)) {
                for (const tag of item.tags) {
                    if (typeof tag === 'string' && tag.trim()) {
                        tagSet.add(tag.trim().toLowerCase());
                    }
                }
            }
        }

        return Array.from(tagSet).map((tag) => ({
            id: slugifyText(tag),
            name: tag.charAt(0).toUpperCase() + tag.slice(1),
        }));
    }

    private deduplicateItems(items: ItemData[]): ItemData[] {
        const seen = new Map<string, ItemData>();

        for (const item of items) {
            const key = `${item.name.toLowerCase()}-${item.source_url?.toLowerCase() || ''}`;

            if (!seen.has(key)) {
                seen.set(key, item);
            } else {
                const existing = seen.get(key)!;
                if (item.tags && Array.isArray(item.tags)) {
                    const existingTags = (existing.tags || []) as string[];
                    const newTags = item.tags as string[];
                    existing.tags = [...new Set([...existingTags, ...newTags])];
                }
            }
        }

        return Array.from(seen.values());
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
