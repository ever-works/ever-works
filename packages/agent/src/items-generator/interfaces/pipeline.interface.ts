import { Directory } from '../../entities';
import { CreateItemsGeneratorDto, ItemData, Category, Tag, ItemsGeneratorMetrics } from '../dto';
import { ExistingItems } from '../items-generator.service';
import { WebPageData } from './items-generator.interfaces';

export interface GenerationContext {
    directory: Directory;
    dto: CreateItemsGeneratorDto;
    existing: ExistingItems;

    // State accumulated during steps
    extractedUrls: string[];
    searchQueries: string[];
    webPages: WebPageData[];
    processedSourceUrls: Set<string>;

    initialAiItems: ItemData[];
    extractedWebItems: ItemData[];

    aggregatedItems: ItemData[];

    finalItems: ItemData[];
    finalCategories: Category[];
    finalTags: Tag[];

    metrics: ItemsGeneratorMetrics;

    // Internal state
    allInitialCategories: string[];
    allPriorityCategories: string[];
    featuredItemHints: string[];

    // Control
    shouldStop?: boolean;
}

export interface IPipelineStep {
    name: string;
    run(context: GenerationContext): Promise<GenerationContext>;
}
