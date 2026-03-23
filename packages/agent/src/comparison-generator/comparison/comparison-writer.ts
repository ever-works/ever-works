import type { ComparisonDimension, ComparisonSource } from '@ever-works/contracts';
import { substituteVariables } from '@ever-works/plugin';
import type { IPromptFacade, FacadeOptions, TemplateVariables } from '@ever-works/plugin';
import type {
    ComparisonPair,
    ComparisonResearch,
    ComparisonGenerationResult,
    ComparisonProgressCallback,
} from './types';
import { buildPairKey } from './pair-selector';
import { PROMPT_KEYS } from './prompt-keys';

export interface ComparisonAiDependencies {
    readonly askJson: <T>(prompt: string, schema: Record<string, unknown>) => Promise<T>;
    readonly askText: (prompt: string) => Promise<string>;
}

interface AiComparisonStructure {
    readonly title: string;
    readonly summary: string;
    readonly verdict: string;
    readonly verdict_winner: 'item_a' | 'item_b' | 'tie';
    readonly dimensions: ComparisonDimension[];
}

function isLikelyAssetUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
        /\.(png|jpe?g|gif|webp|svg|ico)(\?|$)/i.test(lowerUrl) ||
        lowerUrl.includes('/profile_images/') ||
        lowerUrl.includes('/repo-images/') ||
        lowerUrl.includes('storage.googleapis.com') ||
        lowerUrl.includes('twimg.com')
    );
}

function isUrlLikeText(text: string): boolean {
    return /^https?:\/\//i.test(text.trim());
}

function extractMarkdownLinks(markdown?: string): ComparisonSource[] {
    if (!markdown) return [];

    const matches = markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g);
    return Array.from(matches, (match) => ({
        title: match[1].trim(),
        url: match[2].trim(),
    })).filter((source) => {
        return (
            source.title.length > 0 && !isUrlLikeText(source.title) && !isLikelyAssetUrl(source.url)
        );
    });
}

function getPreferredItemSource(item: ComparisonPair['itemA']): ComparisonSource[] {
    const preferredUrl =
        item.source_validation?.suggested_source_url?.trim() || item.source_url?.trim();
    const sources: ComparisonSource[] = [];

    if (preferredUrl) {
        sources.push({
            title: `${item.name} official source`,
            url: preferredUrl,
        });
    }

    const originalUrl = item.source_url?.trim();
    if (originalUrl && originalUrl !== preferredUrl) {
        sources.push({
            title: `${item.name} original source`,
            url: originalUrl,
        });
    }

    sources.push(...extractMarkdownLinks(item.markdown));
    return sources;
}

function normalizeComparisonSources(
    pair: ComparisonPair,
    research: ComparisonResearch,
): ComparisonSource[] {
    const candidates: ComparisonSource[] = [
        ...research.sources,
        ...getPreferredItemSource(pair.itemA),
        ...getPreferredItemSource(pair.itemB),
    ];

    const deduped = new Map<string, ComparisonSource>();
    for (const candidate of candidates) {
        const url = candidate.url?.trim();
        if (!url) continue;
        if (!deduped.has(url)) {
            deduped.set(url, {
                ...candidate,
                url,
            });
        }
    }

    return Array.from(deduped.values());
}

const COMPARISON_JSON_SCHEMA = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description:
                'SEO-optimized comparison title (e.g., "Vercel vs Netlify: Which Hosting Platform is Better?")',
        },
        summary: {
            type: 'string',
            description: '2-3 sentence overview of the comparison',
        },
        verdict: {
            type: 'string',
            description: 'AI recommendation with clear reasoning (2-4 sentences)',
        },
        verdict_winner: {
            type: 'string',
            enum: ['item_a', 'item_b', 'tie'],
            description: 'Overall winner of the comparison',
        },
        dimensions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Dimension name (e.g., "Performance", "Pricing")',
                    },
                    item_a_summary: {
                        type: 'string',
                        description: 'Summary for Item A on this dimension',
                    },
                    item_b_summary: {
                        type: 'string',
                        description: 'Summary for Item B on this dimension',
                    },
                    item_a_score: { type: 'number', minimum: 1, maximum: 10 },
                    item_b_score: { type: 'number', minimum: 1, maximum: 10 },
                    winner: { type: 'string', enum: ['item_a', 'item_b', 'tie'] },
                },
                required: [
                    'name',
                    'item_a_summary',
                    'item_b_summary',
                    'item_a_score',
                    'item_b_score',
                    'winner',
                ],
            },
            minItems: 3,
            maxItems: 8,
        },
    },
    required: ['title', 'summary', 'verdict', 'verdict_winner', 'dimensions'],
};

// ── Structure Prompt ──────────────────────────────────────────────────

/**
 * Default template for the comparison structure prompt.
 * Variables: {itemAName}, {itemADescription}, {itemASourceUrl}, {itemBName},
 *   {itemBDescription}, {itemBSourceUrl}, {category}, {directoryContextSection},
 *   {researchSection}, {customPromptSection}
 */
export const DEFAULT_STRUCTURE_PROMPT = `You are an expert technology analyst. Generate a structured comparison between two items.

## Item A: {itemAName}
- Description: {itemADescription}
- Source: {itemASourceUrl}
- Category: {category}

## Item B: {itemBName}
- Description: {itemBDescription}
- Source: {itemBSourceUrl}
- Category: {category}
{directoryContextSection}{researchSection}{customPromptSection}
Generate a comprehensive, fair, and balanced comparison. Analyze both items across 3-8 relevant dimensions. Score each dimension 1-10. Provide an honest verdict with clear reasoning. The title should be SEO-optimized.`;

/**
 * Build variables for the structure prompt template.
 */
export function buildStructurePromptVariables(
    pair: ComparisonPair,
    research: ComparisonResearch,
    directoryContext?: { name?: string; description?: string; customPrompt?: string },
): TemplateVariables<typeof DEFAULT_STRUCTURE_PROMPT> {
    let directoryContextSection = '';
    if (directoryContext?.name) {
        directoryContextSection = `\n\n## Directory Context\nThis comparison is for the "${directoryContext.name}" directory.`;
        if (directoryContext.description) {
            directoryContextSection += ` ${directoryContext.description}`;
        }
        directoryContextSection += '\n';
    }

    let researchSection = '';
    if (research.content) {
        researchSection = `\n## Web Research\n${research.content}\n`;
    }

    let customPromptSection = '';
    if (directoryContext?.customPrompt?.trim()) {
        customPromptSection = `\n## Additional User Instructions:\n${directoryContext.customPrompt.trim()}\n`;
    }

    return {
        itemAName: pair.itemA.name,
        itemADescription: pair.itemA.description || 'No description available',
        itemASourceUrl: pair.itemA.source_url || 'N/A',
        itemBName: pair.itemB.name,
        itemBDescription: pair.itemB.description || 'No description available',
        itemBSourceUrl: pair.itemB.source_url || 'N/A',
        category: pair.category,
        directoryContextSection,
        researchSection,
        customPromptSection,
    };
}

function buildStructurePrompt(
    pair: ComparisonPair,
    research: ComparisonResearch,
    directoryContext?: { name?: string; description?: string; customPrompt?: string },
): string {
    return substituteVariables(
        DEFAULT_STRUCTURE_PROMPT,
        buildStructurePromptVariables(pair, research, directoryContext),
    );
}

// ── Markdown Prompt ───────────────────────────────────────────────────

/**
 * Default template for the comparison markdown prompt.
 * Variables: {itemAName}, {itemBName}, {category}, {summary}, {dimensionsText},
 *   {verdict}, {sourcesText}, {customPromptSection}
 */
export const DEFAULT_MARKDOWN_PROMPT = `Write a detailed comparison article in markdown format. Use the structured data below as the foundation.

## Items
- Item A: {itemAName}
- Item B: {itemBName}
- Category: {category}

## Summary
{summary}

## Dimensions
{dimensionsText}

## Verdict
{verdict}

## Sources
{sourcesText}
{customPromptSection}
Write a comprehensive, well-structured markdown article with:
1. An engaging introduction
2. A feature comparison table
3. Detailed dimension-by-dimension analysis
4. Pros and cons for each item
5. A clear verdict section
6. Sources cited at the end

Do NOT include a top-level heading (the title will be rendered separately). Start with the introduction paragraph directly.`;

/**
 * Build variables for the markdown prompt template.
 */
export function buildMarkdownPromptVariables(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    normalizedSources: ComparisonSource[],
    customPrompt?: string,
): TemplateVariables<typeof DEFAULT_MARKDOWN_PROMPT> {
    const dimensionsText = structure.dimensions
        .map(
            (d) =>
                `### ${d.name}\n- ${pair.itemA.name}: ${d.item_a_summary} (Score: ${d.item_a_score}/10)\n- ${pair.itemB.name}: ${d.item_b_summary} (Score: ${d.item_b_score}/10)\n- Winner: ${d.winner === 'item_a' ? pair.itemA.name : d.winner === 'item_b' ? pair.itemB.name : 'Tie'}`,
        )
        .join('\n\n');

    const sourcesText = normalizedSources
        .map((source) =>
            source.note
                ? `- ${source.title} – ${source.url} (${source.note})`
                : `- ${source.title} – ${source.url}`,
        )
        .join('\n');

    let customPromptSection = '';
    if (customPrompt?.trim()) {
        customPromptSection = `\n## Additional User Instructions:\n${customPrompt.trim()}\n`;
    }

    return {
        itemAName: pair.itemA.name,
        itemBName: pair.itemB.name,
        category: pair.category,
        summary: structure.summary,
        dimensionsText,
        verdict: structure.verdict,
        sourcesText,
        customPromptSection,
    };
}

function buildMarkdownPrompt(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    normalizedSources: ComparisonSource[],
    customPrompt?: string,
): string {
    return substituteVariables(
        DEFAULT_MARKDOWN_PROMPT,
        buildMarkdownPromptVariables(pair, structure, research, normalizedSources, customPrompt),
    );
}

// ── Extended Analysis Prompt ──────────────────────────────────────────

/**
 * Default template for the comparison extended analysis prompt.
 * Variables: {itemAName}, {itemBName}, {title}, {verdict}, {category},
 *   {researchContent}, {customPromptSection}
 */
export const DEFAULT_EXTENDED_ANALYSIS_PROMPT = `You are an expert technology analyst. Write an in-depth extended analysis comparing {itemAName} and {itemBName}.

## Structured Comparison Summary
- Title: {title}
- Verdict: {verdict}
- Category: {category}

## Research
{researchContent}

Write a comprehensive deep-dive markdown document covering the following sections:

1. **Detailed Feature-by-Feature Breakdown** — Go beyond the high-level dimensions and compare specific features, capabilities, and limitations in detail.

2. **Use-Case Analysis** — Provide concrete guidance on when to choose {itemAName} vs {itemBName}. Cover scenarios like team size, project type, scale, and budget.

3. **Migration Considerations** — What should users know if switching from one to the other? Cover data migration, API compatibility, learning curve, and timeline estimates.

4. **Technical Deep-Dive** — Compare architecture, performance characteristics, scalability, security, and integration capabilities in depth.

5. **Cost & Pricing Analysis** — Compare pricing models, free tiers, hidden costs, and total cost of ownership at different usage levels.

6. **Ecosystem & Community** — Compare third-party integrations, community size, documentation quality, support options, and plugin/extension ecosystems.

7. **Future Outlook** — Based on recent developments, roadmap announcements, and market trends, where is each heading?

Do NOT include a top-level heading. Start directly with the first section. Use markdown formatting with headers, tables, and lists where appropriate.
{customPromptSection}`;

/**
 * Build variables for the extended analysis prompt template.
 */
export function buildExtendedAnalysisPromptVariables(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    customPrompt?: string,
): TemplateVariables<typeof DEFAULT_EXTENDED_ANALYSIS_PROMPT> {
    let customPromptSection = '';
    if (customPrompt?.trim()) {
        customPromptSection = `\n## Additional User Instructions:\n${customPrompt.trim()}`;
    }

    return {
        itemAName: pair.itemA.name,
        itemBName: pair.itemB.name,
        title: structure.title,
        verdict: structure.verdict,
        category: pair.category,
        researchContent: research.content || 'No additional research available.',
        customPromptSection,
    };
}

function buildExtendedAnalysisPrompt(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    customPrompt?: string,
): string {
    return substituteVariables(
        DEFAULT_EXTENDED_ANALYSIS_PROMPT,
        buildExtendedAnalysisPromptVariables(pair, structure, research, customPrompt),
    );
}

// ── Prompt resolution options ─────────────────────────────────────────

export interface ComparisonPromptOptions {
    readonly promptFacade?: IPromptFacade;
    readonly facadeOptions?: FacadeOptions;
}

// ── Main generation function ──────────────────────────────────────────

/**
 * Generate a full comparison using AI (structured data + markdown article).
 */
export async function generateComparison(
    pair: ComparisonPair,
    research: ComparisonResearch,
    ai: ComparisonAiDependencies,
    directoryContext?: {
        name?: string;
        description?: string;
        customPrompt?: string;
        extendedAnalysis?: boolean;
    },
    promptOptions?: ComparisonPromptOptions,
    onProgress?: ComparisonProgressCallback,
): Promise<ComparisonGenerationResult> {
    const { promptFacade, facadeOptions } = promptOptions ?? {};

    // Resolve structure prompt
    const structureTemplate = (
        promptFacade && facadeOptions
            ? await promptFacade.getPrompt(
                  PROMPT_KEYS.STRUCTURE,
                  DEFAULT_STRUCTURE_PROMPT,
                  facadeOptions,
              )
            : DEFAULT_STRUCTURE_PROMPT
    ) as typeof DEFAULT_STRUCTURE_PROMPT;
    const structurePrompt = substituteVariables(
        structureTemplate,
        buildStructurePromptVariables(pair, research, directoryContext),
    );

    onProgress?.('analyzing');
    const structure = await ai.askJson<AiComparisonStructure>(
        structurePrompt,
        COMPARISON_JSON_SCHEMA,
    );
    const normalizedSources = normalizeComparisonSources(pair, research);

    // Resolve markdown prompt
    const markdownTemplate = (
        promptFacade && facadeOptions
            ? await promptFacade.getPrompt(
                  PROMPT_KEYS.MARKDOWN,
                  DEFAULT_MARKDOWN_PROMPT,
                  facadeOptions,
              )
            : DEFAULT_MARKDOWN_PROMPT
    ) as typeof DEFAULT_MARKDOWN_PROMPT;
    const markdownPrompt = substituteVariables(
        markdownTemplate,
        buildMarkdownPromptVariables(
            pair,
            structure,
            research,
            normalizedSources,
            directoryContext?.customPrompt,
        ),
    );

    onProgress?.('writing');
    const markdown = await ai.askText(markdownPrompt);

    let extendedAnalysisMarkdown: string | undefined;
    if (directoryContext?.extendedAnalysis) {
        // Resolve extended analysis prompt
        const extendedTemplate = (
            promptFacade && facadeOptions
                ? await promptFacade.getPrompt(
                      PROMPT_KEYS.EXTENDED_ANALYSIS,
                      DEFAULT_EXTENDED_ANALYSIS_PROMPT,
                      facadeOptions,
                  )
                : DEFAULT_EXTENDED_ANALYSIS_PROMPT
        ) as typeof DEFAULT_EXTENDED_ANALYSIS_PROMPT;
        const extendedPrompt = substituteVariables(
            extendedTemplate,
            buildExtendedAnalysisPromptVariables(
                pair,
                structure,
                research,
                directoryContext?.customPrompt,
            ),
        );
        onProgress?.('writing_extended');
        extendedAnalysisMarkdown = await ai.askText(extendedPrompt);
    }

    const slugA = pair.itemA.slug;
    const slugB = pair.itemB.slug;
    if (!slugA || !slugB) {
        throw new Error(
            `Cannot generate comparison: missing slug for ${!slugA ? pair.itemA.name : pair.itemB.name}`,
        );
    }

    const slug = buildPairKey(slugA, slugB);

    return {
        comparison: {
            id: slug,
            slug,
            title: structure.title,
            item_a_slug: slugA,
            item_b_slug: slugB,
            item_a_name: pair.itemA.name,
            item_b_name: pair.itemB.name,
            category: pair.category,
            summary: structure.summary,
            verdict: structure.verdict,
            verdict_winner: structure.verdict_winner,
            dimensions: structure.dimensions,
            sources: normalizedSources,
            generated_at: new Date().toISOString(),
        },
        markdown,
        extendedAnalysisMarkdown,
    };
}
