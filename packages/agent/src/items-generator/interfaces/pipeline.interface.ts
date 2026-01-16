import { Directory } from '../../entities';
import {
    CreateItemsGeneratorDto,
    ItemData,
    Category,
    Tag,
    ItemsGeneratorMetrics,
    Brand,
} from '../dto';
import { ExistingItems } from '../items-generator.service';
import { WebPageData, DomainAnalysis } from './items-generator.interfaces';

/**
 * Per-directory custom prompts that are appended to standard prompts.
 */
export interface AdvancedPromptsContext {
    relevanceAssessment?: string | null;
    itemGeneration?: string | null;
    itemExtraction?: string | null;
    searchQuery?: string | null;
    categorization?: string | null;
    deduplication?: string | null;
    sourceValidation?: string | null;
}

export interface GenerationContext {
    directory: Directory;
    dto: CreateItemsGeneratorDto;
    existing: ExistingItems;

    // State accumulated during steps
    extractedUrls: string[];
    searchQueries: string[];
    webPages: WebPageData[];
    processedSourceUrls: Set<string>;

    // Content cache: source_url -> raw_content (for reuse in markdown generation)
    contentCache: Map<string, string>;

    initialAiItems: ItemData[];
    extractedWebItems: ItemData[];

    aggregatedItems: ItemData[];

    finalItems: ItemData[];
    finalCategories: Category[];
    finalTags: Tag[];
    finalBrands: Brand[];

    // Domain intelligence
    domainAnalysis?: DomainAnalysis;

    metrics: ItemsGeneratorMetrics;

    // Internal state
    allInitialCategories: string[];
    allPriorityCategories: string[];
    featuredItemHints: string[];
    subject?: string;

    // Per-directory advanced prompts (custom prompts appended to standard prompts)
    advancedPrompts?: AdvancedPromptsContext | null;

    // Control
    shouldStop?: boolean;
}

export interface IPipelineStep {
    name: string;
    run(context: GenerationContext): Promise<GenerationContext>;
}
