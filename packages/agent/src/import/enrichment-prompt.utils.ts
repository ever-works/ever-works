import type { ProvidersDto } from '@ever-works/contracts/api';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@src/items-generator/dto';
import type { Directory } from '@src/entities/directory.entity';

const DEFAULT_PIPELINE_ID = 'agent-pipeline';
const DEFAULT_EXPANSION_FACTOR = 2.5;
const MAX_PIPELINE_PAGES = 1000;

/**
 * Build a generation DTO for importing from an awesome list URL.
 *
 * Delegates all parsing, extraction, and enrichment to the pipeline plugin.
 * The pipeline fetches the source, uses it as research seed, and builds a
 * significantly larger, fully-enriched directory.
 */
export function buildImportGenerationDto(options: {
    directory: Directory;
    sourceUrl: string;
    expansionFactor?: number;
    providers?: ProvidersDto;
    updateWithPullRequest?: boolean;
}): CreateItemsGeneratorDto {
    const {
        directory,
        sourceUrl,
        expansionFactor = DEFAULT_EXPANSION_FACTOR,
        providers,
        updateWithPullRequest = false,
    } = options;

    // Target at least 100 items scaled by expansion factor
    const targetItems = Math.max(50, Math.round(100 * expansionFactor));
    const maxSourcePct = Math.round(100 / expansionFactor);

    const prompt = [
        `Research and build a comprehensive directory inspired by this awesome list: ${sourceUrl}`,
        ``,
        `The source list is your research starting point — fetch it, study the items, then go significantly beyond it.`,
        `The source should represent at most ${maxSourcePct}% of your final collection.`,
        ``,
        `Target: at least ${targetItems} high-quality, well-researched items total.`,
        `Rewrite all descriptions in your own words — do not copy source text verbatim.`,
        `Expand the taxonomy with new categories and tags beyond those in the source.`,
    ].join('\n');

    const dto = new CreateItemsGeneratorDto();
    dto.name = directory.name ?? directory.slug;
    dto.prompt = prompt;
    dto.generation_method = GenerationMethod.CREATE_UPDATE;
    dto.update_with_pull_request = updateWithPullRequest;
    dto.website_repository_creation_method = WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;
    dto.providers = {
        ...providers,
        pipeline: providers?.pipeline ?? DEFAULT_PIPELINE_ID,
    };
    dto.pluginConfig = {
        target_items: targetItems,
        max_pages_to_process: Math.min(MAX_PIPELINE_PAGES, Math.max(50, targetItems * 2)),
        capture_screenshots: true,
    };

    return dto;
}
