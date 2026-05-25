import { buildProposalsPrompt, buildSeedPrompt, deriveVerticals } from '../prompts';
import type { InferredProfile } from '../schemas';
import { WorkProposalStatus } from '../../entities/work-proposal.entity';

describe('buildSeedPrompt', () => {
    it('includes OAuth provider when not local', () => {
        const prompt = buildSeedPrompt(
            {
                id: 'u1',
                username: 'ada',
                email: 'ada@example.com',
                registrationProvider: 'github',
                avatar: 'https://avatars.example/u/1',
            } as never,
            ['linkedin'],
        );
        expect(prompt).toMatch(/OAuth provider: github/);
        expect(prompt).toMatch(/Email domain: example\.com/);
        expect(prompt).toMatch(/Linked social profiles: linkedin/);
    });

    it('omits provider when local', () => {
        const prompt = buildSeedPrompt(
            {
                id: 'u1',
                username: 'ada',
                email: 'ada@example.com',
                registrationProvider: 'local',
            } as never,
            [],
        );
        expect(prompt).not.toMatch(/OAuth provider/);
    });
});

describe('buildProposalsPrompt', () => {
    const profile: InferredProfile = {
        expertise: ['typescript'],
        topics: ['ai'],
        confidence: 'high',
        sources: [],
    };

    it('includes existing works and available plugin ids', () => {
        const out = buildProposalsPrompt(profile, ['Past Work'], ['tavily', 'github']);
        expect(out).toMatch(/Past Work/);
        expect(out).toMatch(/tavily, github/);
    });

    it('renders existing Ideas as exclusion+context with status hint (Phase 1 PR C)', () => {
        const out = buildProposalsPrompt(
            profile,
            [],
            ['tavily'],
            [
                {
                    title: 'Cats Directory',
                    slug: 'cats-directory',
                    description: 'A directory of every cat breed with care notes.',
                    status: WorkProposalStatus.ACCEPTED,
                },
                {
                    title: 'Dog Treats',
                    slug: 'dog-treats',
                    description: 'A storefront for handmade dog treats.',
                    status: WorkProposalStatus.DISMISSED,
                },
            ],
        );
        // Header explains the dual exclusion+context role.
        expect(out).toMatch(/existing Ideas/);
        expect(out).toMatch(/do NOT re-suggest/);
        // Each Idea row prefixed by its status — model uses this signal
        // to lean adjacent to ACCEPTED vs avoid replays of DISMISSED.
        expect(out).toMatch(/\[accepted\] "Cats Directory" \(cats-directory\)/);
        expect(out).toMatch(/\[dismissed\] "Dog Treats" \(dog-treats\)/);
    });

    it('truncates each existing-Idea description (token-budget guard)', () => {
        const longDesc = 'lorem '.repeat(50); // ~300 chars
        const out = buildProposalsPrompt(
            profile,
            [],
            ['tavily'],
            [
                {
                    title: 'Long Idea',
                    slug: 'long-idea',
                    description: longDesc,
                    status: WorkProposalStatus.PENDING,
                },
            ],
        );
        // Description is truncated to <= 140 chars in the rendered prompt;
        // the leading "lorem " repeats enough times to fit under the limit.
        const ideaLine = out.split('\n').find((l) => l.includes('long-idea')) ?? '';
        // line shape: "- [pending] "Long Idea" (long-idea) — <desc>"
        const descPart = ideaLine.split('—')[1]?.trim() ?? '';
        expect(descPart.length).toBeLessThanOrEqual(140);
        expect(descPart).not.toMatch(/^lorem$/); // not empty, has content
    });

    it('caps the existing-Ideas list at the prompt limit', () => {
        const many = Array.from({ length: 60 }, (_, i) => ({
            title: `Idea ${i}`,
            slug: `idea-${i}`,
            description: `desc ${i}`,
            status: WorkProposalStatus.PENDING,
        }));
        const out = buildProposalsPrompt(profile, [], ['tavily'], many);
        // First 50 listed, the rest summarized as an omission line.
        expect(out).toMatch(/Idea 49/);
        expect(out).not.toMatch(/Idea 50/);
        expect(out).toMatch(/and 10 older Ideas omitted for brevity/);
    });

    it('renders missionContext with the Mission Goal + KB excerpts (Phase 3 PR J)', () => {
        const out = buildProposalsPrompt(profile, [], ['tavily'], [], {
            description: 'Run the best cats business worldwide.',
            kbExcerpts: ['Cats are a $20B market.', 'Top categories: food, toys, vet.'],
        });
        expect(out).toMatch(/## Mission context/);
        expect(out).toMatch(/Run the best cats business worldwide/);
        expect(out).toMatch(/## Background excerpts from the Mission KB/);
        expect(out).toMatch(/- Cats are a \$20B market\./);
        expect(out).toMatch(/Every proposal you generate MUST advance the Mission/);
    });

    it('omits the missionContext section entirely when not provided (back-compat)', () => {
        const out = buildProposalsPrompt(profile, ['Past Work'], ['tavily']);
        expect(out).not.toMatch(/## Mission context/);
        expect(out).not.toMatch(/## existing Ideas/);
    });
});

describe('deriveVerticals', () => {
    const base: InferredProfile = {
        expertise: [],
        topics: [],
        confidence: 'medium',
        sources: [],
    };

    it('returns "general" when nothing matches', () => {
        expect(deriveVerticals(base)).toEqual(['general']);
    });

    it('maps developer keywords to dev-tools', () => {
        expect(deriveVerticals({ ...base, role: 'Software Engineer' })).toContain('dev-tools');
        expect(deriveVerticals({ ...base, topics: ['ai agents'] })).toContain('dev-tools');
    });

    it('maps marketing keywords to marketing-saas', () => {
        expect(deriveVerticals({ ...base, industry: 'Marketing' })).toContain('marketing-saas');
    });

    it('returns multiple verticals when multiple keywords match', () => {
        const verticals = deriveVerticals({
            ...base,
            role: 'Founder',
            industry: 'developer tools',
        });
        expect(verticals).toEqual(expect.arrayContaining(['dev-tools', 'startup-tools']));
    });
});
