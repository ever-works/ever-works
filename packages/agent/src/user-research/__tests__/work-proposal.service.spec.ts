import { Logger } from '@nestjs/common';
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
        existingProposals?: Array<{
            title: string;
            slugSuggestion: string;
            description?: string;
            status?: string;
        }>;
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
    const works = {
        findByUser: jest.fn().mockResolvedValue([]),
        // Owns work 'w1'; the IDOR guard in acceptInternal reads this.
        // `acceptedFromIdeaId: null` = never stamped, so the provenance
        // path treats the work as unclaimed (first writer wins).
        findById: jest.fn(async (id: string) =>
            id === 'w1'
                ? { id: 'w1', userId: 'u1', acceptedFromIdeaId: null }
                : { id, userId: 'other-user', acceptedFromIdeaId: null },
        ),
        // Provenance back-pointer stamp (works.acceptedFromIdeaId).
        update: jest.fn().mockResolvedValue(null),
    };
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
        findRecentByUser: jest.fn().mockResolvedValue(
            (overrides.existingProposals ?? []).map((proposal) => ({
                description: 'Existing idea description',
                status: 'pending',
                ...proposal,
            })),
        ),
        bulkInsert: jest.fn(async (items) =>
            items.map((item: object, index: number) => ({ ...item, id: `p${index}` })),
        ),
        // acceptInternal path: proposal 'p1' exists for 'u1'; markAccepted
        // succeeds. The IDOR guard sits between these two.
        findByIdForUser: jest.fn(async (id: string) =>
            id === 'p1'
                ? { id: 'p1', userId: 'u1', status: 'pending', acceptedWorkId: null }
                : null,
        ),
        markAccepted: jest.fn().mockResolvedValue(true),
    };
    // Authoritative Idea↔Work provenance repository (review §23.1).
    const ideaWorks = {
        recordLink: jest.fn().mockResolvedValue(undefined),
        listForIdeaWithWork: jest.fn().mockResolvedValue([]),
        listForWork: jest.fn().mockResolvedValue([]),
        countForIdea: jest.fn().mockResolvedValue(0),
    };
    const titler = { generateTitle: jest.fn().mockResolvedValue('Manual idea') };

    const service = new WorkProposalService(
        users as never,
        works as never,
        registry as never,
        aiFacade as never,
        repo as never,
        ideaWorks as never,
        titler as never,
    );

    return { service, aiFacade, repo, works, ideaWorks };
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

describe('WorkProposalService.acceptInternal — workId ownership (IDOR guard)', () => {
    it('accepts when the supplied Work belongs to the caller', async () => {
        const { service, repo, works } = makeService();

        const ok = await service.acceptInternal('u1', 'p1', 'w1');

        expect(ok).toBe(true);
        expect(works.findById).toHaveBeenCalledWith('w1');
        expect(repo.markAccepted).toHaveBeenCalledWith('p1', 'u1', 'w1', ['pending']);
    });

    it('refuses (false, no write) when the supplied Work belongs to ANOTHER user', async () => {
        const { service, repo } = makeService();

        // 'w-foreign' resolves to { userId: 'other-user' } in the works mock.
        const ok = await service.acceptInternal('u1', 'p1', 'w-foreign');

        expect(ok).toBe(false);
        expect(repo.markAccepted).not.toHaveBeenCalled();
    });

    it('refuses when the supplied Work does not exist', async () => {
        const { service, repo, works } = makeService();
        works.findById.mockResolvedValueOnce(null);

        const ok = await service.acceptInternal('u1', 'p1', 'w-missing');

        expect(ok).toBe(false);
        expect(repo.markAccepted).not.toHaveBeenCalled();
    });

    it('refuses when the proposal is not the caller’s (guard order: proposal first)', async () => {
        const { service, repo, works } = makeService();

        const ok = await service.acceptInternal('u1', 'p-foreign', 'w1');

        expect(ok).toBe(false);
        expect(works.findById).not.toHaveBeenCalled();
        expect(repo.markAccepted).not.toHaveBeenCalled();
    });
});

describe('WorkProposalService.acceptInternal — Idea↔Work provenance (review §23.1)', () => {
    it('records an idea_works link (kind "linked") and stamps works.acceptedFromIdeaId when unset', async () => {
        const { service, ideaWorks, works } = makeService();

        const ok = await service.acceptInternal('u1', 'p1', 'w1');

        expect(ok).toBe(true);
        expect(ideaWorks.recordLink).toHaveBeenCalledWith({
            ideaId: 'p1',
            workId: 'w1',
            userId: 'u1',
            kind: 'linked',
        });
        expect(works.update).toHaveBeenCalledWith('w1', { acceptedFromIdeaId: 'p1' });
    });

    it('still records the link but never overwrites an existing acceptedFromIdeaId (first writer wins)', async () => {
        const { service, ideaWorks, works } = makeService();
        works.findById.mockResolvedValueOnce({
            id: 'w1',
            userId: 'u1',
            acceptedFromIdeaId: 'p-earlier',
        });

        const ok = await service.acceptInternal('u1', 'p1', 'w1');

        expect(ok).toBe(true);
        expect(ideaWorks.recordLink).toHaveBeenCalledWith({
            ideaId: 'p1',
            workId: 'w1',
            userId: 'u1',
            kind: 'linked',
        });
        expect(works.update).not.toHaveBeenCalled();
    });

    it('records nothing when the accept is refused (work owned by another user)', async () => {
        const { service, ideaWorks, works } = makeService();

        const ok = await service.acceptInternal('u1', 'p1', 'w-foreign');

        expect(ok).toBe(false);
        expect(ideaWorks.recordLink).not.toHaveBeenCalled();
        expect(works.update).not.toHaveBeenCalled();
    });

    it('records nothing when markAccepted refuses the status transition', async () => {
        const { service, repo, ideaWorks, works } = makeService();
        repo.markAccepted.mockResolvedValueOnce(false);

        const ok = await service.acceptInternal('u1', 'p1', 'w1');

        expect(ok).toBe(false);
        expect(ideaWorks.recordLink).not.toHaveBeenCalled();
        expect(works.update).not.toHaveBeenCalled();
    });

    it('still resolves true and logs a warning when provenance recording fails (best-effort contract)', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
            const { service, ideaWorks, works } = makeService();
            ideaWorks.recordLink.mockRejectedValueOnce(new Error('connection reset'));

            const ok = await service.acceptInternal('u1', 'p1', 'w1');

            // The primary transition (markAccepted) already committed —
            // a provenance failure must not fail the accept.
            expect(ok).toBe(true);
            expect(works.update).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to record Idea↔Work provenance'),
            );
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('WorkProposalService.handleGoalCompletion — provenance link kinds', () => {
    const policy = { maxAutoRetries: 3, backoffSeconds: 60, exponentialBackoffFactor: 2 };

    it('records a "built" link on first success (no previous accepted Work)', async () => {
        const { service, ideaWorks } = makeService();

        const decision = await service.handleGoalCompletion({
            userId: 'u1',
            ideaId: 'p1',
            outcome: { kind: 'success', workId: 'w-new' },
            attempts: 1,
            policy,
        });

        expect(decision).toEqual({ outcome: 'accepted', ideaId: 'p1', workId: 'w-new' });
        expect(ideaWorks.recordLink).toHaveBeenCalledWith({
            ideaId: 'p1',
            workId: 'w-new',
            userId: 'u1',
            kind: 'built',
        });
    });

    it('records a "rebuilt" link when the Idea already had an accepted Work', async () => {
        const { service, repo, ideaWorks } = makeService();
        repo.findByIdForUser.mockResolvedValueOnce({
            id: 'p1',
            userId: 'u1',
            status: 'building',
            acceptedWorkId: 'w-old',
        });

        const decision = await service.handleGoalCompletion({
            userId: 'u1',
            ideaId: 'p1',
            outcome: { kind: 'success', workId: 'w-new' },
            attempts: 1,
            policy,
        });

        expect(decision).toEqual({
            outcome: 'rebuild-accepted',
            ideaId: 'p1',
            workId: 'w-new',
            previousWorkId: 'w-old',
        });
        expect(ideaWorks.recordLink).toHaveBeenCalledWith({
            ideaId: 'p1',
            workId: 'w-new',
            userId: 'u1',
            kind: 'rebuilt',
        });
    });
});

describe('WorkProposalService.listLinkedWorks', () => {
    it('returns null (404-shaped) when the Idea does not exist for the user', async () => {
        const { service, ideaWorks } = makeService();

        const result = await service.listLinkedWorks('u1', 'p-missing');

        expect(result).toBeNull();
        expect(ideaWorks.listForIdeaWithWork).not.toHaveBeenCalled();
    });

    it('delegates to ideaWorks.listForIdeaWithWork for an owned Idea', async () => {
        const { service, ideaWorks } = makeService();
        const links = [
            {
                id: 'l1',
                ideaId: 'p1',
                workId: 'w1',
                kind: 'linked',
                createdAt: new Date('2026-07-01T00:00:00Z'),
                workName: 'AI Agent Frameworks',
                workSlug: 'ai-agent-frameworks',
            },
        ];
        ideaWorks.listForIdeaWithWork.mockResolvedValueOnce(links);

        const result = await service.listLinkedWorks('u1', 'p1');

        expect(ideaWorks.listForIdeaWithWork).toHaveBeenCalledWith('p1', 'u1');
        expect(result).toBe(links);
    });
});
