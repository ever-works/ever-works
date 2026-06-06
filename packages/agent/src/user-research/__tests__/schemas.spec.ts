import { inferredProfileSchema, workProposalSchema, workProposalsBatchSchema } from '../schemas';

describe('inferredProfileSchema', () => {
    it('accepts a minimal valid profile', () => {
        const out = inferredProfileSchema.safeParse({
            expertise: [],
            topics: [],
            confidence: 'low',
            sources: [],
        });
        expect(out.success).toBe(true);
    });

    it('rejects unknown confidence values', () => {
        const out = inferredProfileSchema.safeParse({
            expertise: [],
            topics: [],
            confidence: 'sure-thing',
            sources: [],
        });
        expect(out.success).toBe(false);
    });

    it('caps expertise + topics + sources arrays', () => {
        const out = inferredProfileSchema.safeParse({
            expertise: Array.from({ length: 11 }, (_, i) => `e${i}`),
            topics: [],
            confidence: 'low',
            sources: [],
        });
        expect(out.success).toBe(false);
    });

    // Security (EW-715 #3): sources[].url must be a public https URL — no
    // SSRF targets reach the persisted profile.
    const profileWithSource = (url: string) => ({
        expertise: [],
        topics: [],
        confidence: 'low' as const,
        sources: [{ url, title: 'a source' }],
    });

    it('accepts public https source URLs', () => {
        expect(
            inferredProfileSchema.safeParse(profileWithSource('https://example.com/article'))
                .success,
        ).toBe(true);
        expect(
            inferredProfileSchema.safeParse(
                profileWithSource('https://docs.ever.works/path?q=1#frag'),
            ).success,
        ).toBe(true);
    });

    it('rejects non-https source URLs', () => {
        expect(
            inferredProfileSchema.safeParse(profileWithSource('http://example.com/article'))
                .success,
        ).toBe(false);
    });

    it('rejects SSRF / cloud-metadata / private-IP source URLs', () => {
        const blocked = [
            'https://169.254.169.254/latest/meta-data/', // AWS/Azure/GCP IMDS
            'https://127.0.0.1/admin', // loopback
            'https://localhost/admin', // loopback hostname
            'https://10.0.0.5/internal', // RFC1918 10/8
            'https://172.16.0.1/internal', // RFC1918 172.16/12
            'https://192.168.1.1/internal', // RFC1918 192.168/16
            'https://[::1]/internal', // IPv6 loopback
            'https://metadata.google.internal/computeMetadata/v1/', // GCP metadata host
        ];
        for (const url of blocked) {
            expect(inferredProfileSchema.safeParse(profileWithSource(url)).success).toBe(false);
        }
    });
});

describe('workProposalSchema', () => {
    const valid = {
        title: 'AI Agent Frameworks',
        description: 'Curated list of open-source AI agent frameworks for developers.',
        slugSuggestion: 'ai-agent-frameworks',
        suggestedCategories: [
            { name: 'Open Source', slug: 'open-source' },
            { name: 'Commercial', slug: 'commercial' },
        ],
        suggestedFields: [{ name: 'github_url', type: 'url' as const }],
        recommendedPlugins: [{ pluginId: 'tavily', reason: 'web search' }],
        generatedPrompt:
            'Create a Work of AI agent frameworks with open-source and commercial categories, links, and summaries.',
        reasoning: 'Matches profile expertise in AI agents.',
    };

    it('accepts a valid proposal', () => {
        expect(workProposalSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects invalid slug formats', () => {
        expect(workProposalSchema.safeParse({ ...valid, slugSuggestion: 'Bad Slug' }).success).toBe(
            false,
        );
        expect(
            workProposalSchema.safeParse({ ...valid, slugSuggestion: 'has_underscore' }).success,
        ).toBe(false);
    });

    it('rejects when only 1 category provided', () => {
        expect(
            workProposalSchema.safeParse({
                ...valid,
                suggestedCategories: [{ name: 'Only', slug: 'only' }],
            }).success,
        ).toBe(false);
    });

    it('rejects when title is too short', () => {
        expect(workProposalSchema.safeParse({ ...valid, title: 'short' }).success).toBe(false);
    });
});

describe('workProposalsBatchSchema', () => {
    const proposal = {
        title: 'AI Agent Frameworks',
        description: 'Curated list of open-source AI agent frameworks for developers.',
        slugSuggestion: 'ai-agent-frameworks',
        suggestedCategories: [
            { name: 'Open Source', slug: 'open-source' },
            { name: 'Commercial', slug: 'commercial' },
        ],
        suggestedFields: [],
        recommendedPlugins: [],
        generatedPrompt:
            'Create a Work of AI agent frameworks with categories, links, summaries, and useful metadata.',
        reasoning: 'reason',
    };

    it('requires at least one proposal', () => {
        expect(workProposalsBatchSchema.safeParse({ proposals: [] }).success).toBe(false);
    });

    it('rejects more than 5 proposals', () => {
        expect(
            workProposalsBatchSchema.safeParse({ proposals: Array(6).fill(proposal) }).success,
        ).toBe(false);
    });
});
