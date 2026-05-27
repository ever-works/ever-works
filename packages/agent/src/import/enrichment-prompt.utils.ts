import type { ProvidersDto } from '@ever-works/contracts/api';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@src/items-generator/dto';
import type { Work } from '@src/entities/work.entity';

/**
 * Defaults to `'agent-pipeline'` (Vercel-AI-SDK), NOT the standard
 * 15-step pipeline. The agent pipeline is tool-driven and lets the
 * LLM orchestrate `processUrls` / `search` / `modifyItems` calls
 * directly — which matches the step-by-step prompt below. Switching
 * to `standard-pipeline` would require rewriting the prompt.
 */
const DEFAULT_PIPELINE_ID = 'agent-pipeline';

/**
 * Multiplier from "items in the source list" to "items in the final
 * Work". 2.5 → source content is at most ~40% of the final
 * collection (the rest is discovered by `search`). Raising this
 * pushes the generator to do MORE discovery work — slower runs,
 * higher AI cost, but smaller source-dependence.
 *
 * The `maxSourcePct` value computed below is interpolated into the
 * LLM prompt verbatim — the model self-polices source ratio based
 * on the percentage, so tuning this number directly shapes
 * generation behaviour.
 */
const DEFAULT_EXPANSION_FACTOR = 2.5;

/**
 * Hard ceiling on per-import page processing. DoS bound: a malicious
 * or pathological source could otherwise drive the pipeline through
 * infinite link-chasing. Pipeline aborts when it hits this number
 * even if more content is reachable.
 */
const MAX_PIPELINE_PAGES = 1000;

/**
 * Generous fixed target — we don't know source size ahead of time.
 * The pipeline stops when content is exhausted, not when it hits
 * this number. Acts as a "ambition hint" to the LLM rather than
 * a cap; the real cap is {@link MAX_PIPELINE_PAGES}.
 */
const DEFAULT_TARGET_ITEMS = 500;

/**
 * Build a generation DTO for importing from an awesome list URL.
 *
 * The source is treated as a list of research seeds — links to follow and
 * independently describe — never as content to copy verbatim.
 * The pipeline discovers significantly more items beyond the source so that
 * the source represents at most 30-40% of the final work.
 *
 * **The "do NOT copy descriptions" prompt line is load-bearing.**
 * Awesome lists are typically licensed (CC-BY-SA, MIT, etc.) but
 * description text is the most exposed copy-paste risk — verbatim
 * inclusion creates downstream licensing headaches for the generated
 * Work. Don't soften that instruction during prompt-tuning.
 *
 * **`sourceUrl` is interpolated into the prompt without escaping.**
 * Editor-trusted (work owners set it via authenticated form), so
 * not a prompt-injection vector in normal use — but if this is ever
 * called from a less-trusted surface (public submission form,
 * admin-impersonation), the URL should be quoted / sanitised first.
 */
export function buildImportGenerationDto(options: {
    work: Work;
    sourceUrl: string;
    expansionFactor?: number;
    providers?: ProvidersDto;
    model?: string;
    updateWithPullRequest?: boolean;
}): CreateItemsGeneratorDto {
    const {
        work,
        sourceUrl,
        expansionFactor = DEFAULT_EXPANSION_FACTOR,
        providers,
        model,
        updateWithPullRequest = false,
    } = options;

    // Source items should be at most this % of the final collection
    const maxSourcePct = Math.round(100 / expansionFactor);

    const prompt = [
        `Build a comprehensive work using this awesome list as your research starting point: ${sourceUrl}`,
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
        `Extract ALL items from the source list, then discover significantly more beyond it.`,
        `Do not stop early — keep going until all relevant content in the domain is exhausted.`,
    ].join('\n');

    const dto = new CreateItemsGeneratorDto();
    dto.name = work.name ?? work.slug;
    dto.prompt = prompt;
    dto.model = model;
    dto.generation_method = GenerationMethod.CREATE_UPDATE;
    dto.update_with_pull_request = updateWithPullRequest;
    dto.website_repository_creation_method = WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;
    dto.providers = {
        ...providers,
        pipeline: providers?.pipeline ?? DEFAULT_PIPELINE_ID,
    };
    dto.pluginConfig = {
        target_items: DEFAULT_TARGET_ITEMS,
        max_pages_to_process: MAX_PIPELINE_PAGES,
        capture_screenshots: true,
    };

    return dto;
}
