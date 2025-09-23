import { ItemsGeneratorSteps } from '@/lib/api/enums';

export function getStepTranslationKey(step: ItemsGeneratorSteps): string {
    const stepKeys: Record<ItemsGeneratorSteps, string> = {
        [ItemsGeneratorSteps.PROMPT_COMPARISON]: 'promptComparison',
        [ItemsGeneratorSteps.PROMPT_PROCESSING]: 'promptProcessing',
        [ItemsGeneratorSteps.AI_FIRST_ITEMS_GENERATION]: 'aiFirstItemsGeneration',
        [ItemsGeneratorSteps.SEARCH_QUERIES_GENERATION]: 'searchQueriesGeneration',
        [ItemsGeneratorSteps.WEB_SEARCH]: 'webSearch',
        [ItemsGeneratorSteps.CONTENT_RETRIEVAL]: 'contentRetrieval',
        [ItemsGeneratorSteps.CONTENT_FILTERING]: 'contentFiltering',
        [ItemsGeneratorSteps.ITEMS_EXTRACTION]: 'itemsExtraction',
        [ItemsGeneratorSteps.DEDUPLICATION_AND_DATA_AGGREGATION]: 'deduplicationDataAggregation',
        [ItemsGeneratorSteps.CATEGORIES_TAGS_PROCESSING]: 'categoriesTagsProcessing',
        [ItemsGeneratorSteps.SOURCES_VALIDATION]: 'sourcesValidation',
        [ItemsGeneratorSteps.BADGES_PROCESSING]: 'badgesProcessing',
        [ItemsGeneratorSteps.ITEMS_PROCESSING]: 'itemsProcessing',
    };

    return stepKeys[step] || 'processing';
}

export function getStepProgress(step: ItemsGeneratorSteps): number {
    const steps = Object.values(ItemsGeneratorSteps);
    const currentIndex = steps.indexOf(step);

    if (currentIndex === -1) return 0;

    // Calculate percentage based on step position
    return Math.round(((currentIndex + 1) / steps.length) * 100);
}

export function getStepText(step: ItemsGeneratorSteps | undefined, t: Function): string {
    if (!step) {
        return t('steps.processing');
    }

    const stepKey = getStepTranslationKey(step);
    const stepTranslations: Record<string, string> = {
        promptComparison: t('steps.promptComparison'),
        promptProcessing: t('steps.promptProcessing'),
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
        itemsProcessing: t('steps.itemsProcessing'),
    };

    return stepTranslations[stepKey] || t('steps.processing');
}
