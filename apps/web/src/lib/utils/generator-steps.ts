import { ItemsGeneratorStep } from '@/lib/api/enums';

export function getStepTranslationKey(step: ItemsGeneratorStep): string {
    const stepKeys: Record<ItemsGeneratorStep, string> = {
        [ItemsGeneratorStep.PROMPT_COMPARISON]: 'promptComparison',
        [ItemsGeneratorStep.PROMPT_PROCESSING]: 'promptProcessing',
        [ItemsGeneratorStep.DOMAIN_DETECTION]: 'domainDetection',
        [ItemsGeneratorStep.AI_FIRST_ITEMS_GENERATION]: 'aiFirstItemsGeneration',
        [ItemsGeneratorStep.SEARCH_QUERIES_GENERATION]: 'searchQueriesGeneration',
        [ItemsGeneratorStep.WEB_SEARCH]: 'webSearch',
        [ItemsGeneratorStep.CONTENT_RETRIEVAL]: 'contentRetrieval',
        [ItemsGeneratorStep.CONTENT_FILTERING]: 'contentFiltering',
        [ItemsGeneratorStep.ITEMS_EXTRACTION]: 'itemsExtraction',
        [ItemsGeneratorStep.DEDUPLICATION_AND_DATA_AGGREGATION]: 'deduplicationDataAggregation',
        [ItemsGeneratorStep.CATEGORIES_TAGS_PROCESSING]: 'categoriesTagsProcessing',
        [ItemsGeneratorStep.SOURCES_VALIDATION]: 'sourcesValidation',
        [ItemsGeneratorStep.BADGES_PROCESSING]: 'badgesProcessing',
        [ItemsGeneratorStep.MARKDOWN_GENERATION]: 'markdownGeneration',
    };

    return stepKeys[step] || 'processing';
}

export function getStepProgress(step: ItemsGeneratorStep): number {
    const steps = Object.values(ItemsGeneratorStep);
    const currentIndex = steps.indexOf(step);

    if (currentIndex === -1) return 0;

    // Calculate percentage based on step position
    return Math.round(((currentIndex + 1) / steps.length) * 100);
}

export function getStepText(step: ItemsGeneratorStep | undefined, t: Function): string {
    if (!step) {
        return t('steps.processing');
    }

    const stepKey = getStepTranslationKey(step);
    const stepTranslations: Record<string, string> = {
        promptComparison: t('steps.promptComparison'),
        promptProcessing: t('steps.promptProcessing'),
        domainDetection: t('steps.domainDetection'),
        aiFirstItemsGeneration: t('steps.aiFirstItemsGeneration'),
        searchQueriesGeneration: t('steps.searchQueriesGeneration'),
        webSearch: t('steps.webSearch'),
        contentRetrieval: t('steps.contentRetrieval'),
        contentFiltering: t('steps.contentFiltering'),
        itemsExtraction: t('steps.itemsExtraction'),
        deduplicationDataAggregation: t('steps.deduplicationDataAggregation'),
        categoriesTagsProcessing: t('steps.categoriesTagsProcessing'),
        sourcesValidation: t('steps.sourcesValidation'),
        badgesProcessing: t('steps.badgesProcessing'),
        markdownGeneration: t('steps.markdownGeneration'),
    };

    return stepTranslations[stepKey] || t('steps.processing');
}
