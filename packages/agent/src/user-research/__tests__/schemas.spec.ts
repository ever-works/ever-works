import {
	inferredProfileSchema,
	workProposalSchema,
	workProposalsBatchSchema
} from '../schemas';

describe('inferredProfileSchema', () => {
	it('accepts a minimal valid profile', () => {
		const out = inferredProfileSchema.safeParse({
			expertise: [],
			topics: [],
			confidence: 'low',
			sources: []
		});
		expect(out.success).toBe(true);
	});

	it('rejects unknown confidence values', () => {
		const out = inferredProfileSchema.safeParse({
			expertise: [],
			topics: [],
			confidence: 'sure-thing',
			sources: []
		});
		expect(out.success).toBe(false);
	});

	it('caps expertise + topics + sources arrays', () => {
		const out = inferredProfileSchema.safeParse({
			expertise: Array.from({ length: 11 }, (_, i) => `e${i}`),
			topics: [],
			confidence: 'low',
			sources: []
		});
		expect(out.success).toBe(false);
	});
});

describe('workProposalSchema', () => {
	const valid = {
		title: 'AI Agent Frameworks',
		description: 'Curated list of open-source AI agent frameworks for developers.',
		slugSuggestion: 'ai-agent-frameworks',
		suggestedCategories: [
			{ name: 'Open Source', slug: 'open-source' },
			{ name: 'Commercial', slug: 'commercial' }
		],
		suggestedFields: [{ name: 'github_url', type: 'url' as const }],
		recommendedPlugins: [{ pluginId: 'tavily', reason: 'web search' }],
		reasoning: 'Matches profile expertise in AI agents.'
	};

	it('accepts a valid proposal', () => {
		expect(workProposalSchema.safeParse(valid).success).toBe(true);
	});

	it('rejects invalid slug formats', () => {
		expect(workProposalSchema.safeParse({ ...valid, slugSuggestion: 'Bad Slug' }).success).toBe(
			false
		);
		expect(
			workProposalSchema.safeParse({ ...valid, slugSuggestion: 'has_underscore' }).success
		).toBe(false);
	});

	it('rejects when only 1 category provided', () => {
		expect(
			workProposalSchema.safeParse({
				...valid,
				suggestedCategories: [{ name: 'Only', slug: 'only' }]
			}).success
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
			{ name: 'Commercial', slug: 'commercial' }
		],
		suggestedFields: [],
		recommendedPlugins: [],
		reasoning: 'reason'
	};

	it('requires at least one proposal', () => {
		expect(workProposalsBatchSchema.safeParse({ proposals: [] }).success).toBe(false);
	});

	it('rejects more than 5 proposals', () => {
		expect(
			workProposalsBatchSchema.safeParse({ proposals: Array(6).fill(proposal) }).success
		).toBe(false);
	});
});
