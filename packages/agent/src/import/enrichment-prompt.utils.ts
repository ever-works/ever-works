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
 * The source is treated as a list of research seeds — links to follow and
 * independently describe — never as content to copy verbatim.
 * The pipeline discovers significantly more items beyond the source so that
 * the source represents at most 30-40% of the final directory.
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

    // Source items should be at most this % of the final collection
    const maxSourcePct = Math.round(100 / expansionFactor);
    // If source has N items, we need to discover at least (expansionFactor-1)*N more
    // Use a high target so the pipeline doesn't stop too early
    const targetItems = Math.max(100, Math.round(100 * expansionFactor));

    const prompt = [
        `Build a comprehensive directory using this awesome list as your research starting point: ${sourceUrl}`,
        ``,
        `## Step 1 — Process source links`,
        `Fetch the source list and pass all item links to \`processUrls\`.`,
        `Workers will independently visit each item's own URL and write original descriptions.`,
        `IMPORTANT: Do NOT copy descriptions or metadata from the source list — those are legally problematic.`,
        `Use the source only as a list of URLs to research.`,
        ``,
        `## Step 2 — Discover more items`,
        `After processing the source, use \`search\` to find additional items in the same domain.`,
        `Look broadly: alternatives, competitors, newer projects, and related tools NOT in the source.`,
        `Source items must represent at most ${maxSourcePct}% of the final collection — you need to discover significantly more.`,
        ``,
        `## Step 3 — Enrich descriptions`,
        `Use \`modifyItems\` to ensure every item has a detailed, original description:`,
        `- What the tool/project does (2-3 sentences in your own words)`,
        `- Key features and use cases`,
        `- Comparisons to alternatives where relevant`,
        `- Screenshots or images where available`,
        ``,
        `## Step 4 — Build original taxonomy`,
        `Create your own categories and tags — do not replicate the source structure.`,
        `The source's categories/tags should be at most 30% of the final taxonomy.`,
        `Add descriptive tags that help users filter and discover items.`,
        ``,
        `Overall target: at least ${targetItems} total items.`,
        `Do not stop early — if more relevant content exists, keep extracting.`,
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
        max_pages_to_process: Math.min(MAX_PIPELINE_PAGES, Math.max(100, targetItems * 3)),
        capture_screenshots: true,
    };

    return dto;
}
