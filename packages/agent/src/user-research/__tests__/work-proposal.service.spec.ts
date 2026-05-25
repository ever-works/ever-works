import { WorkProposalSource } from '../../entities/work-proposal.entity';
import { WorkProposalService } from '../work-proposal.service';

function makeDraft(title: string, slugSuggestion: string) {
    return {
        title,
        description: `A curated directory of ${title.toLowerCase()} for teams choosing what to use.`,
        slugSuggestion,
        suggestedCategories: [
            { name: 'Open Source', slug: 'open-source' },
            { name: 'Commercial', slug: 'commercial' },
        ],
        suggestedFields: [{ name: 'Website', type: 'url' }],
        recommendedPlugins: [{ pluginId: 'github', reason: 'Find repository metadata.' }],
        generatedPrompt: `Create a Work of ${title.toLowerCase()} with useful metadata and links.`,
        reasoning: 'Matches the user profile.',
    };
}

function makeService(
    overrides: {
        pendingCount?: number;
        existingProposals?: Array<{ title: string; slugSuggestion: string }>;
        drafts?: ReturnType<typeof makeDraft>[];
    } = {},
) {
    const users = {
        findById: jest.fn().mockResolvedValue({
            id: 'u1',
            inferredInterests: {
                industry: 'Software',
                role: 'Developer tools founder',
                expertise: ['AI agents'],
                topics: ['developer tools', 'AI agents'],
                businessType: 'SaaS',
                confidence: 'high',
                sources: [],
            },
        }),
    };
    const works = { findByUser: jest.fn().mockResolvedValue([]) };
    const registry = {
        getReady: jest.fn().mockReturnValue([{ plugin: { id: 'github' } }]),
        getEnabledPluginsScoped: jest.fn().mockResolvedValue([
            {
                plugin: { id: 'openai' },
                manifest: { defaultForCapabilities: ['ai-provider'] },
            },
        ]),
    };
    const aiFacade = {
        getProviderConfig: jest.fn().mockResolvedValue({
            providerId: 'openai',
            providerName: 'OpenAI',
            baseUrl: 'https://api.openai.test/v1',
            apiKey: 'test-key',
            defaultModel: 'gpt-test',
            routing: {},
        }),
        askJson: jest.fn().mockResolvedValue({
            result: { proposals: overrides.drafts ?? [] },
            usage: { totalTokens: 123 },
        }),
    };
    const repo = {
        countPendingByUser: jest.fn().mockResolvedValue(overrides.pendingCount ?? 0),
        findRecentByUser: jest.fn().mockResolvedValue(overrides.existingProposals ?? []),
        bulkInsert: jest.fn(async (items) =>
            items.map((item: object, index: number) => ({ ...item, id: `p${index}` })),
        ),
    };

    const service = new WorkProposalService(
        users as never,
        works as never,
        registry as never,
        aiFacade as never,
        repo as never,
    );

    return { service, aiFacade, repo };
}

describe('WorkProposalService proposal limits and dedupe', () => {
    it('skips generation before spending tokens when pending proposals are already at the limit', async () => {
        const { service, aiFacade, repo } = makeService({ pendingCount: 6 });

        const result = await service.generate('u1', { source: WorkProposalSource.AUTO_SIGNUP });

        expect(result.status).toBe('skipped-at-limit');
        expect(aiFacade.askJson).not.toHaveBeenCalled();
        expect(repo.bulkInsert).not.toHaveBeenCalled();
    });

    it('caps inserted proposals to the remaining pending slots', async () => {
        const { service, repo } = makeService({
            pendingCount: 5,
            drafts: [
                makeDraft('AI Agent Frameworks', 'ai-agent-frameworks'),
                makeDraft('Developer Documentation Platforms', 'developer-documentation-platforms'),
                makeDraft('Open Source Observability Tools', 'open-source-observability-tools'),
            ],
        });

        const result = await service.generate('u1', { source: WorkProposalSource.USER_REFRESH });

        expect(result.status).toBe('generated');
        expect(repo.bulkInsert).toHaveBeenCalledWith([
            expect.objectContaining({ title: 'AI Agent Frameworks' }),
        ]);
        expect(result.proposals).toHaveLength(1);
    });

    it('drops near-duplicate proposals against recent history', async () => {
        const { service, repo } = makeService({
            existingProposals: [
                { title: 'AI Agent Frameworks', slugSuggestion: 'ai-agent-frameworks' },
            ],
            drafts: [
                makeDraft('Open Source AI Agent Frameworks', 'open-source-ai-agent-frameworks'),
                makeDraft('Developer Documentation Platforms', 'developer-documentation-platforms'),
            ],
        });

        await service.generate('u1', { source: WorkProposalSource.USER_REFRESH });

        expect(repo.bulkInsert).toHaveBeenCalledWith([
            expect.objectContaining({ title: 'Developer Documentation Platforms' }),
        ]);
    });

    it('drops near-duplicate proposals within the same generated batch', async () => {
        const { service, repo } = makeService({
            drafts: [
                makeDraft('AI Agent Frameworks', 'ai-agent-frameworks'),
                makeDraft('Open Source AI Agent Frameworks', 'open-source-ai-agent-frameworks'),
            ],
        });

        await service.generate('u1', { source: WorkProposalSource.USER_REFRESH });

        expect(repo.bulkInsert).toHaveBeenCalledWith([
            expect.objectContaining({ title: 'AI Agent Frameworks' }),
        ]);
    });
});
