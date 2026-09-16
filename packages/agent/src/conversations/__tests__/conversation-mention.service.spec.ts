import {
    ConversationMentionService,
    type MentionCandidateSource,
} from '../conversation-mention.service';

const NOVA: MentionCandidateSource = {
    type: 'agent',
    id: 'agent-nova',
    slug: 'nova',
    name: 'Nova',
    status: 'active',
};
const NOVA_PRIME: MentionCandidateSource = {
    type: 'agent',
    id: 'agent-nova-prime',
    slug: 'nova-prime',
    name: 'Nova Prime',
    status: 'active',
};
const ORION: MentionCandidateSource = {
    type: 'agent',
    id: 'agent-orion',
    slug: 'orion-research',
    name: 'Orion',
    status: 'paused',
};

describe('ConversationMentionService', () => {
    let agents: { findByUserIdScoped: jest.Mock };
    let conversations: { findSummariesByUser: jest.Mock };
    let service: ConversationMentionService;

    beforeEach(() => {
        agents = { findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
        conversations = {
            findSummariesByUser: jest.fn().mockResolvedValue({ conversations: [], total: 0 }),
        };
        service = new ConversationMentionService(agents as any, conversations as any);
    });

    describe('parse', () => {
        const candidates = [NOVA, NOVA_PRIME, ORION];

        it('matches a full display name case-insensitively and a full slug', () => {
            const parsed = service.parse('@nOvA check this, then @orion-research', candidates);
            expect(parsed.mentions).toEqual([
                { type: 'agent', id: 'agent-nova', slug: 'nova' },
                { type: 'agent', id: 'agent-orion', slug: 'orion-research' },
            ]);
            expect(parsed.agentIds).toEqual(['agent-nova', 'agent-orion']);
        });

        it('treats a two-word name as one unit and prefers the longest name', () => {
            const parsed = service.parse('Ask @Nova Prime about it', candidates);
            expect(parsed.agentIds).toEqual(['agent-nova-prime']);
            expect(parsed.spans).toEqual([
                {
                    start: 4,
                    length: 'Nova Prime'.length + 1,
                    type: 'agent',
                    id: 'agent-nova-prime',
                },
            ]);
        });

        it('never matches a prefix of a name', () => {
            const parsed = service.parse('@Nov and @Novak, please', candidates);
            expect(parsed.mentions).toEqual([]);
            expect(parsed.spans).toEqual([]);
        });

        it('keeps unresolved tokens in the stored body but strips them from what the Agent sees', () => {
            const body = '@ghost please ask @Nova to review';
            const parsed = service.parse(body, candidates);
            expect(parsed.agentIds).toEqual(['agent-nova']);
            expect(parsed.agentVisibleBody).toBe('please ask @Nova to review');
            // The stored body is the caller's input — parse never mutates it.
            expect(body).toBe('@ghost please ask @Nova to review');
        });

        it('an Agent the sender cannot see behaves exactly like one that does not exist', () => {
            // Orion exists for someone else, but is not in THIS sender's candidates.
            const visible = service.parse('hey @Orion', [NOVA]);
            const nonexistent = service.parse('hey @Zephyr', [NOVA]);
            expect(visible.mentions).toEqual(nonexistent.mentions);
            expect(visible.spans).toEqual(nonexistent.spans);
            expect(visible.agentVisibleBody).toBe('hey');
            expect(nonexistent.agentVisibleBody).toBe('hey');
        });

        it('mentioning the same Agent twice resolves once', () => {
            const parsed = service.parse('@Nova and again @nova', candidates);
            expect(parsed.mentions).toHaveLength(1);
            expect(parsed.spans).toHaveLength(2);
        });

        it('ignores email addresses and the document-reference syntax', () => {
            const parsed = service.parse('mail nova@example.com and read @kb:roadmap', candidates);
            expect(parsed.mentions).toEqual([]);
            expect(parsed.agentVisibleBody).toBe('mail nova@example.com and read @kb:roadmap');
        });

        it('caps resolved mentions at ten; the rest stay plain and are never highlighted', () => {
            const many: MentionCandidateSource[] = Array.from({ length: 12 }, (_, i) => ({
                type: 'agent',
                id: `agent-${i}`,
                slug: `agent-${i}`,
                name: `Agent${String.fromCharCode(65 + i)}`,
                status: 'active',
            }));
            const body = many.map((c) => `@${c.name}`).join(' ');
            const parsed = service.parse(body, many);
            expect(parsed.mentions).toHaveLength(10);
            expect(parsed.overLimit).toBe(2);
            expect(parsed.spans).toHaveLength(10);
            // Over-cap names are real names: they stay in the Agent's body as text.
            expect(parsed.agentVisibleBody).toBe(body);
        });
    });

    describe('loadCandidates', () => {
        it('reads the sender’s visible Agents in the active scope', async () => {
            const scope = { tenantId: 't1', organizationId: 'o1' };
            agents.findByUserIdScoped.mockResolvedValue({
                rows: [{ id: 'a1', slug: 'nova', name: 'Nova', status: 'active' }],
                total: 1,
            });
            await expect(service.loadCandidates('u1', scope)).resolves.toEqual([
                { type: 'agent', id: 'a1', slug: 'nova', name: 'Nova', status: 'active' },
            ]);
            expect(agents.findByUserIdScoped).toHaveBeenCalledWith('u1', { limit: 500 }, scope);
        });

        it('resolves nothing when the lookup fails, instead of failing the send', async () => {
            agents.findByUserIdScoped.mockRejectedValue(new Error('db down'));
            await expect(service.loadCandidates('u1')).resolves.toEqual([]);
        });
    });

    describe('resolveCandidates', () => {
        beforeEach(() => {
            agents.findByUserIdScoped.mockResolvedValue({
                rows: [
                    { id: 'a-nova', slug: 'nova', name: 'Nova', status: 'active' },
                    { id: 'a-supernova', slug: 'supernova', name: 'Supernova', status: 'active' },
                    { id: 'a-novella', slug: 'novella', name: 'Novella', status: 'active' },
                    { id: 'a-orion', slug: 'orion', name: 'Orion', status: 'active' },
                ],
                total: 4,
            });
        });

        it('ranks recently addressed Agents first, then prefix, then substring', async () => {
            conversations.findSummariesByUser.mockResolvedValue({
                conversations: [{ agentId: 'a-supernova' }, { agentId: null }],
                total: 2,
            });
            const result = await service.resolveCandidates('nov', { userId: 'u1' });
            expect(result.map((c) => c.id)).toEqual(['a-supernova', 'a-nova', 'a-novella']);
        });

        it('returns at most eight candidates', async () => {
            agents.findByUserIdScoped.mockResolvedValue({
                rows: Array.from({ length: 12 }, (_, i) => ({
                    id: `a${i}`,
                    slug: `agent-${i}`,
                    name: `Agent ${i}`,
                    status: 'active',
                })),
                total: 12,
            });
            await expect(service.resolveCandidates('', { userId: 'u1' })).resolves.toHaveLength(8);
        });

        it('returns nothing for a query that matches no visible Agent', async () => {
            await expect(service.resolveCandidates('zzz', { userId: 'u1' })).resolves.toEqual([]);
        });
    });
});
