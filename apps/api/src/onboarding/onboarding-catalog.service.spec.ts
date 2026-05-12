jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
}));

import { Test } from '@nestjs/testing';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { OnboardingCatalogService } from './onboarding-catalog.service';

interface FakeRegisteredPlugin {
    manifest: {
        id: string;
        name: string;
        category: string;
        description?: string;
        uiHints?: {
            includeInOnboarding?: boolean;
            onboardingPriority?: number;
        };
    };
}

function buildRegistry(entries: FakeRegisteredPlugin[]) {
    return {
        getAll: jest.fn(() => entries),
    } as unknown as PluginRegistryService;
}

describe('OnboardingCatalogService', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    async function makeSvc(entries: FakeRegisteredPlugin[]) {
        const moduleRef = await Test.createTestingModule({
            providers: [
                OnboardingCatalogService,
                { provide: PluginRegistryService, useValue: buildRegistry(entries) },
            ],
        }).compile();
        return moduleRef.get(OnboardingCatalogService);
    }

    it('returns six AI cards with Ever Works marked default', async () => {
        const svc = await makeSvc([]);
        const cat = svc.getCatalog();
        expect(cat.ai).toHaveLength(6);
        const def = cat.ai.find((c) => c.default);
        expect(def?.choice).toBe('ever-works');
        expect(cat.ai.every((c) => c.available)).toBe(true);
        const byok = cat.ai.filter((c) => c.badges.includes('byok'));
        expect(byok.map((c) => c.choice).sort()).toEqual([
            'claude-code',
            'codex',
            'gemini',
            'grok',
            'openrouter',
        ]);
    });

    describe('Storage catalog reflects STORAGE_EVER_WORKS_GIT_ENABLED', () => {
        it('flag off → Ever Works Git is Planned + unavailable', async () => {
            delete process.env.STORAGE_EVER_WORKS_GIT_ENABLED;
            const svc = await makeSvc([]);
            const card = svc.getCatalog().storage.find((c) => c.choice === 'ever-works-git')!;
            expect(card.available).toBe(false);
            expect(card.badges).toContain('planned');
        });

        it('flag on → Ever Works Git is available with default badge only', async () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            const svc = await makeSvc([]);
            const card = svc.getCatalog().storage.find((c) => c.choice === 'ever-works-git')!;
            expect(card.available).toBe(true);
            expect(card.badges).toContain('default');
            expect(card.badges).not.toContain('planned');
        });

        it('always exposes GitLab + generic Git as Planned cards', async () => {
            const svc = await makeSvc([]);
            const gitlab = svc.getCatalog().storage.find((c) => c.choice === 'user-gitlab')!;
            const git = svc.getCatalog().storage.find((c) => c.choice === 'user-git')!;
            expect(gitlab.available).toBe(false);
            expect(git.available).toBe(false);
            expect(gitlab.badges).toContain('planned');
            expect(git.badges).toContain('planned');
        });
    });

    describe('Deploy catalog reflects DEPLOY_EVER_WORKS_ENABLED', () => {
        it('flag off → Ever Works is Planned', async () => {
            delete process.env.DEPLOY_EVER_WORKS_ENABLED;
            const svc = await makeSvc([]);
            const card = svc.getCatalog().deploy.find((c) => c.choice === 'ever-works')!;
            expect(card.available).toBe(false);
            expect(card.badges).toContain('planned');
        });

        it('flag on → Ever Works is available, description shows the quota', async () => {
            process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
            process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER = '5';
            const svc = await makeSvc([]);
            const card = svc.getCatalog().deploy.find((c) => c.choice === 'ever-works')!;
            expect(card.available).toBe(true);
            expect(card.description).toMatch(/5 active works/);
        });
    });

    describe('plugins catalog step', () => {
        it('returns only plugins with includeInOnboarding=true, excluding ones used in choice cards', async () => {
            const svc = await makeSvc([
                {
                    manifest: {
                        id: 'make',
                        name: 'Make.com',
                        category: 'pipeline',
                        description: 'No-code workflow automation',
                        uiHints: { includeInOnboarding: true, onboardingPriority: 2 },
                    },
                },
                {
                    manifest: {
                        id: 'zapier',
                        name: 'Zapier',
                        category: 'pipeline',
                        description: 'Workflow automation',
                        uiHints: { includeInOnboarding: true, onboardingPriority: 2 },
                    },
                },
                {
                    manifest: {
                        id: 'openrouter', // reserved by AI step — should be excluded
                        name: 'OpenRouter',
                        category: 'ai-provider',
                        uiHints: { includeInOnboarding: true, onboardingPriority: 3 },
                    },
                },
                {
                    manifest: {
                        id: 'tavily', // includeInOnboarding=false → excluded
                        name: 'Tavily',
                        category: 'search',
                        uiHints: { includeInOnboarding: false },
                    },
                },
            ]);

            const cat = svc.getCatalog();
            const ids = cat.plugins.map((p) => p.pluginId);
            expect(ids).toEqual(['make', 'zapier']);
        });

        it('sorts plugins by onboardingPriority ascending', async () => {
            const svc = await makeSvc([
                {
                    manifest: {
                        id: 'activepieces',
                        name: 'ActivePieces',
                        category: 'pipeline',
                        uiHints: { includeInOnboarding: true, onboardingPriority: 5 },
                    },
                },
                {
                    manifest: {
                        id: 'sim-ai',
                        name: 'Sim AI',
                        category: 'pipeline',
                        uiHints: { includeInOnboarding: true, onboardingPriority: 1 },
                    },
                },
            ]);
            const cat = svc.getCatalog();
            expect(cat.plugins.map((p) => p.pluginId)).toEqual(['sim-ai', 'activepieces']);
        });
    });
});
