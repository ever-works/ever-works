import { buildProposalsPrompt, buildSeedPrompt, deriveVerticals } from '../prompts';
import type { InferredProfile } from '../schemas';

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
    it('includes existing works and available plugin ids', () => {
        const profile: InferredProfile = {
            expertise: ['typescript'],
            topics: ['ai'],
            confidence: 'high',
            sources: [],
        };
        const out = buildProposalsPrompt(profile, ['Past Work'], ['tavily', 'github']);
        expect(out).toMatch(/Past Work/);
        expect(out).toMatch(/tavily, github/);
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
