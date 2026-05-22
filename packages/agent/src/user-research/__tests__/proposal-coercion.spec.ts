import { coerceWorkProposal } from '../proposal-coercion';
import type { PermissiveWorkProposalDraft } from '../schemas';

function makeDraft(over: Partial<PermissiveWorkProposalDraft> = {}): PermissiveWorkProposalDraft {
    return {
        title: 'Open Source AI Tools',
        description:
            'A curated directory of AI tools for developers, organized by category and use case.',
        slugSuggestion: 'open-source-ai-tools',
        suggestedCategories: [
            { name: 'Models', slug: 'models' },
            { name: 'Agents', slug: 'agents' },
        ],
        suggestedFields: [
            { name: 'github_url', type: 'url' },
            { name: 'description', type: 'markdown' },
        ],
        recommendedPlugins: [{ pluginId: 'github', reason: 'pulls README' }],
        generatedPrompt:
            'Create a Work of open source AI tools for developers with categories, GitHub URLs, and concise summaries.',
        reasoning: 'Matches user expertise.',
        ...over,
    };
}

describe('coerceWorkProposal', () => {
    it('passes through a clean draft', () => {
        const result = coerceWorkProposal(makeDraft());
        expect(result).not.toBeNull();
        expect(result!.slugSuggestion).toBe('open-source-ai-tools');
        expect(result!.suggestedFields).toHaveLength(2);
        expect(result!.generatedPrompt).toContain('open source AI tools');
    });

    it('slugifies a non-kebab-case slug suggestion (strict regex: no underscores)', () => {
        const result = coerceWorkProposal(makeDraft({ slugSuggestion: 'My_Cool Tools!' }));
        expect(result?.slugSuggestion).toBe('my-cool-tools');
    });

    it('falls back to title-derived slug when the LLM omits the slug', () => {
        const result = coerceWorkProposal(makeDraft({ slugSuggestion: '' }));
        expect(result?.slugSuggestion).toBe('open-source-ai-tools');
    });

    it('aliases sloppy field types (text → string, link → url, etc.)', () => {
        const result = coerceWorkProposal(
            makeDraft({
                suggestedFields: [
                    { name: 'about', type: 'text' },
                    { name: 'site', type: 'link' },
                    { name: 'count', type: 'int' },
                ],
            }),
        );
        expect(result?.suggestedFields).toEqual([
            { name: 'about', type: 'string' },
            { name: 'site', type: 'url' },
            { name: 'count', type: 'number' },
        ]);
    });

    it('drops fields with unrecognized types', () => {
        const result = coerceWorkProposal(
            makeDraft({
                suggestedFields: [
                    { name: 'ok', type: 'string' },
                    { name: 'bad', type: 'datetime' },
                ],
            }),
        );
        expect(result?.suggestedFields).toEqual([{ name: 'ok', type: 'string' }]);
    });

    it('clips an over-long title to the strict max', () => {
        const longTitle = 'A'.repeat(200);
        const result = coerceWorkProposal(makeDraft({ title: longTitle }));
        expect(result?.title.length).toBeLessThanOrEqual(80);
    });

    it('clips an over-long reasoning to 280 chars', () => {
        const reasoning = 'because '.repeat(100);
        const result = coerceWorkProposal(makeDraft({ reasoning }));
        expect(result?.reasoning.length).toBeLessThanOrEqual(280);
    });

    it('drops drafts whose title is too short to be salvaged', () => {
        expect(coerceWorkProposal(makeDraft({ title: 'AI' }))).toBeNull();
    });

    it('drops drafts whose description is too short', () => {
        expect(coerceWorkProposal(makeDraft({ description: 'short' }))).toBeNull();
    });

    it('drops drafts that end up with fewer than 2 valid categories', () => {
        expect(
            coerceWorkProposal(
                makeDraft({ suggestedCategories: [{ name: 'Only One', slug: 'only-one' }] }),
            ),
        ).toBeNull();
    });

    it('caps oversized arrays to schema maximums', () => {
        const cats = Array.from({ length: 12 }, (_, i) => ({
            name: `Cat ${i}`,
            slug: `cat-${i}`,
        }));
        const plugins = Array.from({ length: 10 }, (_, i) => ({
            pluginId: `plugin-${i}`,
            reason: 'r',
        }));
        const result = coerceWorkProposal(
            makeDraft({ suggestedCategories: cats, recommendedPlugins: plugins }),
        );
        expect(result?.suggestedCategories).toHaveLength(8);
        expect(result?.recommendedPlugins).toHaveLength(5);
    });

    it('handles optional fields being absent', () => {
        const result = coerceWorkProposal({
            title: 'Open Source AI Tools',
            description:
                'A curated directory of AI tools for developers, organized by category and use case.',
            slugSuggestion: 'open-source-ai-tools',
            suggestedCategories: [
                { name: 'Models', slug: 'models' },
                { name: 'Agents', slug: 'agents' },
            ],
            suggestedFields: [],
            recommendedPlugins: [],
            reasoning: '',
        });
        expect(result).not.toBeNull();
        expect(result!.suggestedFields).toEqual([]);
        expect(result!.recommendedPlugins).toEqual([]);
        expect(result!.generatedPrompt).toContain('Open Source AI Tools');
        expect(result!.reasoning).toBe('');
    });

    it('salvages malformed primitive/container values from loose LLM output', () => {
        const result = coerceWorkProposal({
            title: 123456789,
            description:
                'A curated Work of AI healthcare startups with funding, focus area, and website details.',
            slugSuggestion: null,
            suggestedCategories: [
                { name: 'Diagnostics', slug: 42 },
                { name: true, slug: 'clinical-ai' },
                'bad category',
            ],
            suggestedFields: [
                { name: 'Website', type: 'link' },
                { name: 123, type: 'datetime' },
            ],
            recommendedPlugins: [{ pluginId: 7, reason: false }, 'bad plugin'],
            generatedPrompt: 123,
            reasoning: 99,
        });

        expect(result).not.toBeNull();
        expect(result!.slugSuggestion).toBe('123456789');
        expect(result!.suggestedCategories).toEqual([
            { name: 'Diagnostics', slug: '42' },
            { name: 'true', slug: 'clinical-ai' },
        ]);
        expect(result!.suggestedFields).toEqual([{ name: 'Website', type: 'url' }]);
        expect(result!.recommendedPlugins).toEqual([{ pluginId: '7', reason: 'false' }]);
        expect(result!.generatedPrompt).toContain('Create a Work about 123456789');
        expect(result!.reasoning).toBe('99');
    });
});
