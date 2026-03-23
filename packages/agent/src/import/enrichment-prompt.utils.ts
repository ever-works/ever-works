import type { ItemData, Category, Tag } from '@ever-works/contracts';
import type { ProvidersDto } from '@ever-works/contracts/api';
import type { ImportEnrichmentConfigDto } from '@src/dto/import-directory.dto';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@src/items-generator/dto';
import type { Directory } from '@src/entities/directory.entity';

/** Resolved enrichment configuration with defaults applied */
export interface ResolvedEnrichmentConfig {
    expansionFactor: number;
    maxImportProportion: number;
    enrichDescriptions: boolean;
    expandTaxonomy: boolean;
}

/** Default pipeline ID — always available internally as a system plugin */
const DEFAULT_PIPELINE_ID = 'agent-pipeline';

/** Pipeline plugins allowed for the import enrichment flow */
const ALLOWED_IMPORT_PIPELINES = new Set(['agent-pipeline', 'claude-code']);

/** Hard cap on pages to process */
const MAX_PIPELINE_PAGES = 1000;

/** Resolve enrichment config with sensible defaults */
export function resolveEnrichmentConfig(
    input?: ImportEnrichmentConfigDto,
): ResolvedEnrichmentConfig {
    const expansionFactor = input?.expansionFactor ?? 2.5;
    return {
        expansionFactor,
        maxImportProportion: input?.maxImportProportion ?? 1 / expansionFactor,
        enrichDescriptions: input?.enrichDescriptions ?? true,
        expandTaxonomy: input?.expandTaxonomy ?? true,
    };
}

/** Build the enrichment-focused prompt for the pipeline */
export function buildEnrichmentPrompt(options: {
    seedCount: number;
    sourceUrl: string;
    targetNewItems: number;
    maxImportPct: number;
    seedCategoryCount: number;
    seedTagCount: number;
    config: ResolvedEnrichmentConfig;
}): string {
    const {
        seedCount,
        sourceUrl,
        targetNewItems,
        maxImportPct,
        seedCategoryCount,
        seedTagCount,
        config,
    } = options;
    const sections: string[] = [];

    sections.push(
        `You are enriching a directory that was seeded from an external repository.`,
        `The workspace contains ${seedCount} seed items from "${sourceUrl}".`,
        ``,
        `IMPORTANT: The seed items are research input only — do NOT treat them as final content.`,
        ``,
    );

    sections.push(
        `GOAL 1 — EXPAND:`,
        `Discover at least ${targetNewItems} NEW items in the same domain via web search.`,
        `Imported items should represent at most ${maxImportPct}% of the final collection.`,
        `Search broadly using multiple queries. Look for alternatives, competitors, and related tools`,
        `that are NOT in the seed list.`,
        ``,
    );

    if (config.enrichDescriptions) {
        sections.push(
            `GOAL 2 — REWRITE:`,
            `Use modifyItems to rewrite ALL existing item descriptions. For each item:`,
            `- Do NOT keep original descriptions verbatim — rewrite and significantly expand them`,
            `- Add: what the tool/project does (2-3 sentences), key features, use cases`,
            `- Add comparisons to alternatives where relevant`,
            `- Add images/screenshots where available`,
            ``,
        );
    }

    if (config.expandTaxonomy) {
        sections.push(
            `GOAL 3 — TAXONOMY:`,
            `Propose new categories beyond the ${seedCategoryCount} existing ones.`,
            `Target: seed categories should be ~30% of the final taxonomy.`,
            `Reorganize items into the expanded taxonomy where it makes sense.`,
            ``,
            `GOAL 4 — TAGS:`,
            `Expand the tag set significantly beyond the ${seedTagCount} current tags.`,
            `Add descriptive, useful tags that help users filter and discover items.`,
            ``,
        );
    }

    return sections.join('\n');
}

/**
 * Build a full CreateItemsGeneratorDto for the enrichment pipeline.
 * This is used by the import flow to delegate to the standard generation path.
 */
export function buildEnrichmentGenerationDto(options: {
    directory: Directory;
    parsedData: { items: ItemData[]; categories: Category[]; tags: Tag[] };
    sourceUrl: string;
    enrichmentConfig?: ImportEnrichmentConfigDto;
    providers?: ProvidersDto;
}): CreateItemsGeneratorDto {
    const { directory, parsedData, sourceUrl, enrichmentConfig, providers } = options;
    const config = resolveEnrichmentConfig(enrichmentConfig);
    const seedCount = parsedData.items.length;
    const targetNewItems = Math.ceil(seedCount * (config.expansionFactor - 1));
    const maxPct = Math.round(config.maxImportProportion * 100);

    const prompt = buildEnrichmentPrompt({
        seedCount,
        sourceUrl,
        targetNewItems,
        maxImportPct: maxPct,
        seedCategoryCount: parsedData.categories.length,
        seedTagCount: parsedData.tags.length,
        config,
    });

    const dto = new CreateItemsGeneratorDto();
    dto.name = directory.name ?? directory.slug;
    dto.prompt = prompt;
    dto.generation_method = GenerationMethod.CREATE_UPDATE;
    dto.update_with_pull_request = false;
    dto.website_repository_creation_method = WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;
    const requestedPipeline = providers?.pipeline ?? DEFAULT_PIPELINE_ID;
    dto.providers = {
        ...providers,
        pipeline: ALLOWED_IMPORT_PIPELINES.has(requestedPipeline) ? requestedPipeline : DEFAULT_PIPELINE_ID,
    };
    dto.pluginConfig = {
        target_items: Math.max(50, targetNewItems),
        max_pages_to_process: Math.min(MAX_PIPELINE_PAGES, Math.max(20, seedCount * 2)),
        capture_screenshots: true,
    };

    return dto;
}
