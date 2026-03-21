import { generateComparison } from '../comparison-writer';
import type { ComparisonAiDependencies } from '../comparison-writer';
import type { ComparisonPair, ComparisonResearch } from '../types';
import type { ItemData } from '@ever-works/contracts';

function makeItem(slug: string, category: string, opts: Partial<ItemData> = {}): ItemData {
    return {
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        description: `Description of ${slug}`,
        source_url: `https://${slug}.example.com`,
        category,
        slug,
        tags: [],
        markdown: '',
        ...opts,
    };
}

function makePair(slugA: string, slugB: string, category = 'hosting'): ComparisonPair {
    return {
        itemA: makeItem(slugA, category),
        itemB: makeItem(slugB, category),
        category,
        pairKey: [slugA, slugB].sort().join('--'),
    };
}

const MOCK_STRUCTURE = {
    title: 'Vercel vs Netlify: Which is Better?',
    summary: 'A comprehensive comparison of Vercel and Netlify.',
    verdict: 'Vercel edges out Netlify for most use cases.',
    verdict_winner: 'item_a' as const,
    dimensions: [
        {
            name: 'Performance',
            item_a_summary: 'Fast edge network',
            item_b_summary: 'Good CDN',
            item_a_score: 9,
            item_b_score: 8,
            winner: 'item_a' as const,
        },
        {
            name: 'Pricing',
            item_a_summary: 'Generous free tier',
            item_b_summary: 'Competitive pricing',
            item_a_score: 8,
            item_b_score: 8,
            winner: 'tie' as const,
        },
        {
            name: 'DX',
            item_a_summary: 'Great developer experience',
            item_b_summary: 'Solid workflow',
            item_a_score: 9,
            item_b_score: 7,
            winner: 'item_a' as const,
        },
    ],
};

const MOCK_MARKDOWN = '## Introduction\nVercel and Netlify are both excellent hosting platforms...';

function makeResearch(): ComparisonResearch {
    return {
        content: 'Source: https://review.com\nVercel is fast...',
        sources: [
            { title: 'Review.com benchmark', url: 'https://review.com' },
            { title: 'Blog.com analysis', url: 'https://blog.com', note: 'accessed March 2026' },
        ],
    };
}

function makeAi(overrides: Partial<ComparisonAiDependencies> = {}): ComparisonAiDependencies {
    return {
        askJson: jest.fn().mockResolvedValue(MOCK_STRUCTURE),
        askText: jest.fn().mockResolvedValue(MOCK_MARKDOWN),
        ...overrides,
    };
}

describe('generateComparison', () => {
    const pair = makePair('vercel', 'netlify');
    const research = makeResearch();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should call askJson then askText (two-pass generation)', async () => {
        const ai = makeAi();

        await generateComparison(pair, research, ai);

        expect(ai.askJson).toHaveBeenCalledTimes(1);
        expect(ai.askText).toHaveBeenCalledTimes(1);

        // askJson should be called before askText
        const askJsonOrder = (ai.askJson as jest.Mock).mock.invocationCallOrder[0];
        const askTextOrder = (ai.askText as jest.Mock).mock.invocationCallOrder[0];
        expect(askJsonOrder).toBeLessThan(askTextOrder);
    });

    it('should return ComparisonGenerationResult with correct shape', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result).toHaveProperty('comparison');
        expect(result).toHaveProperty('markdown');
        expect(result.comparison).toHaveProperty('id');
        expect(result.comparison).toHaveProperty('slug');
        expect(result.comparison).toHaveProperty('title');
        expect(result.comparison).toHaveProperty('item_a_slug');
        expect(result.comparison).toHaveProperty('item_b_slug');
        expect(result.comparison).toHaveProperty('item_a_name');
        expect(result.comparison).toHaveProperty('item_b_name');
        expect(result.comparison).toHaveProperty('category');
        expect(result.comparison).toHaveProperty('summary');
        expect(result.comparison).toHaveProperty('verdict');
        expect(result.comparison).toHaveProperty('verdict_winner');
        expect(result.comparison).toHaveProperty('dimensions');
        expect(result.comparison).toHaveProperty('sources');
        expect(result.comparison).toHaveProperty('generated_at');
    });

    it('should use buildPairKey format for slug', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        // buildPairKey sorts alphabetically: netlify--vercel
        expect(result.comparison.slug).toBe('netlify--vercel');
        expect(result.comparison.id).toBe('netlify--vercel');
    });

    it('should populate comparison fields from AI structure response', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result.comparison.title).toBe(MOCK_STRUCTURE.title);
        expect(result.comparison.summary).toBe(MOCK_STRUCTURE.summary);
        expect(result.comparison.verdict).toBe(MOCK_STRUCTURE.verdict);
        expect(result.comparison.verdict_winner).toBe(MOCK_STRUCTURE.verdict_winner);
        expect(result.comparison.dimensions).toBe(MOCK_STRUCTURE.dimensions);
    });

    it('should set item slugs and names from the pair', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result.comparison.item_a_slug).toBe('vercel');
        expect(result.comparison.item_b_slug).toBe('netlify');
        expect(result.comparison.item_a_name).toBe('Vercel');
        expect(result.comparison.item_b_name).toBe('Netlify');
        expect(result.comparison.category).toBe('hosting');
    });

    it('should include sources from research', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result.comparison.sources).toEqual([
            ...research.sources,
            { title: 'Vercel official source', url: 'https://vercel.example.com' },
            { title: 'Netlify official source', url: 'https://netlify.example.com' },
        ]);
    });

    it('should fall back to item source urls when research sources are empty', async () => {
        const ai = makeAi();
        const emptyResearch = {
            ...research,
            sources: [],
        };

        const result = await generateComparison(pair, emptyResearch, ai);

        expect(result.comparison.sources).toEqual([
            { title: 'Vercel official source', url: 'https://vercel.example.com' },
            { title: 'Netlify official source', url: 'https://netlify.example.com' },
        ]);
    });

    it('should prefer suggested source urls and include markdown links in fallback sources', async () => {
        const ai = makeAi();
        const richPair = {
            ...pair,
            itemA: makeItem('github-com', 'hosting', {
                name: 'GitHub Copilot',
                source_url: 'https://github.com/',
                markdown:
                    'See the [GitHub pricing page](https://github.com/pricing) for plan details. [https://storage.googleapis.com/logo.png](https://storage.googleapis.com/logo.png)',
                source_validation: {
                    reachability_status: 'reachable',
                    accuracy_status: 'accurate',
                    suggested_source_url: 'https://github.com/features/copilot',
                },
            }),
            itemB: makeItem('gitlab-code-suggestions', 'hosting', {
                name: 'GitLab Code Suggestions',
                source_url:
                    'https://docs.gitlab.com/ee/user/project/repository/code_suggestions.html',
                markdown:
                    'Reference: [GitLab Docs](https://docs.gitlab.com/ee/user/project/repository/code_suggestions.html) and [https://pbs.twimg.com/profile_images/x.png](https://pbs.twimg.com/profile_images/x.png)',
            }),
        };

        const result = await generateComparison(richPair, { ...research, sources: [] }, ai);

        expect(result.comparison.sources).toEqual([
            {
                title: 'GitHub Copilot official source',
                url: 'https://github.com/features/copilot',
            },
            {
                title: 'GitHub Copilot original source',
                url: 'https://github.com/',
            },
            {
                title: 'GitHub pricing page',
                url: 'https://github.com/pricing',
            },
            {
                title: 'GitLab Code Suggestions official source',
                url: 'https://docs.gitlab.com/ee/user/project/repository/code_suggestions.html',
            },
        ]);
    });

    it('should set generated_at as ISO string', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result.comparison.generated_at).toBeDefined();
        // Verify it's a valid ISO date string
        const parsed = new Date(result.comparison.generated_at);
        expect(parsed.toISOString()).toBe(result.comparison.generated_at);
    });

    it('should return markdown from askText', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai);

        expect(result.markdown).toBe(MOCK_MARKDOWN);
    });

    it('should pass directory context in prompt when provided', async () => {
        const askJson = jest.fn().mockResolvedValue(MOCK_STRUCTURE);
        const ai = makeAi({ askJson });

        await generateComparison(pair, research, ai, {
            name: 'Hosting Tools',
            description: 'A directory of hosting platforms',
        });

        const prompt = askJson.mock.calls[0][0] as string;
        expect(prompt).toContain('Hosting Tools');
        expect(prompt).toContain('A directory of hosting platforms');
    });

    it('should not include directory context when not provided', async () => {
        const askJson = jest.fn().mockResolvedValue(MOCK_STRUCTURE);
        const ai = makeAi({ askJson });

        await generateComparison(pair, research, ai);

        const prompt = askJson.mock.calls[0][0] as string;
        expect(prompt).not.toContain('Directory Context');
    });

    it('should call askText twice when extendedAnalysis is true', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai, {
            name: 'Test',
            extendedAnalysis: true,
        });

        expect(ai.askJson).toHaveBeenCalledTimes(1);
        expect(ai.askText).toHaveBeenCalledTimes(2);
        expect(result.extendedAnalysisMarkdown).toBe(MOCK_MARKDOWN);
    });

    it('should call askText once when extendedAnalysis is false', async () => {
        const ai = makeAi();

        const result = await generateComparison(pair, research, ai, {
            name: 'Test',
            extendedAnalysis: false,
        });

        expect(ai.askText).toHaveBeenCalledTimes(1);
        expect(result.extendedAnalysisMarkdown).toBeUndefined();
    });

    it('should include item names in extended analysis prompt', async () => {
        const askText = jest.fn().mockResolvedValue(MOCK_MARKDOWN);
        const ai = makeAi({ askText });

        await generateComparison(pair, research, ai, {
            name: 'Test',
            extendedAnalysis: true,
        });

        const extendedPrompt = askText.mock.calls[1][0] as string;
        expect(extendedPrompt).toContain('Vercel');
        expect(extendedPrompt).toContain('Netlify');
    });
});
