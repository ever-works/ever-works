import type { ComparisonDimension } from '@ever-works/contracts';
import type { ComparisonPair, ComparisonResearch, ComparisonGenerationResult } from './types';
import { buildPairKey } from './pair-selector';

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

function buildStructurePrompt(
    pair: ComparisonPair,
    research: ComparisonResearch,
    directoryContext?: { name?: string; description?: string; customPrompt?: string },
): string {
    const itemADescription = pair.itemA.description || 'No description available';
    const itemBDescription = pair.itemB.description || 'No description available';

    let prompt = `You are an expert technology analyst. Generate a structured comparison between two items.

## Item A: ${pair.itemA.name}
- Description: ${itemADescription}
- Source: ${pair.itemA.source_url || 'N/A'}
- Category: ${pair.category}

## Item B: ${pair.itemB.name}
- Description: ${itemBDescription}
- Source: ${pair.itemB.source_url || 'N/A'}
- Category: ${pair.category}`;

    if (directoryContext?.name) {
        prompt += `\n\n## Directory Context\nThis comparison is for the "${directoryContext.name}" directory.`;
        if (directoryContext.description) {
            prompt += ` ${directoryContext.description}`;
        }
    }

    if (research.content) {
        prompt += `\n\n## Web Research\n${research.content}`;
    }

    if (directoryContext?.customPrompt?.trim()) {
        prompt += `\n\n## Additional User Instructions:\n${directoryContext.customPrompt.trim()}`;
    }

    prompt += `\n\nGenerate a comprehensive, fair, and balanced comparison. Analyze both items across 3-8 relevant dimensions. Score each dimension 1-10. Provide an honest verdict with clear reasoning. The title should be SEO-optimized.`;

    return prompt;
}

function buildMarkdownPrompt(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    customPrompt?: string,
): string {
    let prompt = `Write a detailed comparison article in markdown format. Use the structured data below as the foundation.

## Title: ${structure.title}

## Items
- Item A: ${pair.itemA.name}
- Item B: ${pair.itemB.name}
- Category: ${pair.category}

## Summary
${structure.summary}

## Dimensions
${structure.dimensions.map((d) => `### ${d.name}\n- ${pair.itemA.name}: ${d.item_a_summary} (Score: ${d.item_a_score}/10)\n- ${pair.itemB.name}: ${d.item_b_summary} (Score: ${d.item_b_score}/10)\n- Winner: ${d.winner === 'item_a' ? pair.itemA.name : d.winner === 'item_b' ? pair.itemB.name : 'Tie'}`).join('\n\n')}

## Verdict
${structure.verdict}

## Sources
${research.sources.map((s) => `- ${s}`).join('\n')}`;

    if (customPrompt?.trim()) {
        prompt += `\n\n## Additional User Instructions:\n${customPrompt.trim()}`;
    }

    prompt += `

Write a comprehensive, well-structured markdown article with:
1. An engaging introduction
2. A feature comparison table
3. Detailed dimension-by-dimension analysis
4. Pros and cons for each item
5. A clear verdict section
6. Sources cited at the end

Do NOT include a top-level heading (the title will be rendered separately). Start with the introduction paragraph directly.`;

    return prompt;
}

function buildExtendedAnalysisPrompt(
    pair: ComparisonPair,
    structure: AiComparisonStructure,
    research: ComparisonResearch,
    customPrompt?: string,
): string {
    let prompt = `You are an expert technology analyst. Write an in-depth extended analysis comparing ${pair.itemA.name} and ${pair.itemB.name}.

## Structured Comparison Summary
- Title: ${structure.title}
- Verdict: ${structure.verdict}
- Category: ${pair.category}

## Research
${research.content || 'No additional research available.'}

Write a comprehensive deep-dive markdown document covering the following sections:

1. **Detailed Feature-by-Feature Breakdown** — Go beyond the high-level dimensions and compare specific features, capabilities, and limitations in detail.

2. **Use-Case Analysis** — Provide concrete guidance on when to choose ${pair.itemA.name} vs ${pair.itemB.name}. Cover scenarios like team size, project type, scale, and budget.

3. **Migration Considerations** — What should users know if switching from one to the other? Cover data migration, API compatibility, learning curve, and timeline estimates.

4. **Technical Deep-Dive** — Compare architecture, performance characteristics, scalability, security, and integration capabilities in depth.

5. **Cost & Pricing Analysis** — Compare pricing models, free tiers, hidden costs, and total cost of ownership at different usage levels.

6. **Ecosystem & Community** — Compare third-party integrations, community size, documentation quality, support options, and plugin/extension ecosystems.

7. **Future Outlook** — Based on recent developments, roadmap announcements, and market trends, where is each heading?

Do NOT include a top-level heading. Start directly with the first section. Use markdown formatting with headers, tables, and lists where appropriate.`;

    if (customPrompt?.trim()) {
        prompt += `\n\n## Additional User Instructions:\n${customPrompt.trim()}`;
    }

    return prompt;
}

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
): Promise<ComparisonGenerationResult> {
    const structurePrompt = buildStructurePrompt(pair, research, directoryContext);
    const structure = await ai.askJson<AiComparisonStructure>(
        structurePrompt,
        COMPARISON_JSON_SCHEMA,
    );

    const markdownPrompt = buildMarkdownPrompt(
        pair,
        structure,
        research,
        directoryContext?.customPrompt,
    );
    const markdown = await ai.askText(markdownPrompt);

    let extendedAnalysisMarkdown: string | undefined;
    if (directoryContext?.extendedAnalysis) {
        const extendedPrompt = buildExtendedAnalysisPrompt(
            pair,
            structure,
            research,
            directoryContext?.customPrompt,
        );
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
            sources: research.sources,
            generated_at: new Date().toISOString(),
        },
        markdown,
        extendedAnalysisMarkdown,
    };
}
