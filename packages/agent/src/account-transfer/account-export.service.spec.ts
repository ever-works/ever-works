// Mock the data-repository module so we don't pull in fs-extra/isomorphic-git
// during unit-test runs. The service only invokes static `DataRepository.create`.
jest.mock('../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));

import { AccountExportService } from './account-export.service';
import { DataRepository } from '../generators/data-generator/data-repository';
import { MASKED_SECRET_PREFIX } from './types';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

/**
 * Pins the `AccountExportService` contract. The exporter is the secrets
 * boundary: real values are NEVER serialised, even when `includeSecrets:true`
 * — only `MASKED:` placeholders are. Each `ExportedWork` row also carries the
 * full data-repo state (items, categories, tags, collections, comparisons,
 * site config, markdown template) which is fetched via a `cloneOrPull` round
 * trip; failures during that fetch are swallowed and logged so a single bad
 * repo never aborts the whole export.
 */
describe('AccountExportService', () => {
    function makeData(overrides: Record<string, jest.Mock> = {}) {
        return {
            getItems: jest.fn().mockResolvedValue([]),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
            getComparisons: jest.fn().mockResolvedValue([]),
            readMarkdownTemplate: jest.fn().mockResolvedValue(null),
            getComparisonMarkdown: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    function makeService(extra: Partial<{ data: ReturnType<typeof makeData> }> = {}) {
        const data = extra.data ?? makeData();
        dataRepoCreateMock.mockReset();
        dataRepoCreateMock.mockResolvedValue(data);

        const userRepository = {
            findById: jest.fn(),
        };
        const workRepository = {
            findByUser: jest.fn().mockResolvedValue([]),
        };
        const workMemberRepository = {
            findByWork: jest.fn().mockResolvedValue([]),
        };
        const workCustomDomainRepository = {
            findByWork: jest.fn().mockResolvedValue([]),
        };
        const userPluginRepository = {
            findByUser: jest.fn().mockResolvedValue([]),
        };
        const workPluginRepository = {
            findByWork: jest.fn().mockResolvedValue([]),
        };
        const advancedPromptsRepository = {
            findByWorkId: jest.fn().mockResolvedValue(null),
        };
        const scheduleRepository = {
            findByWorkId: jest.fn().mockResolvedValue(null),
        };
        const gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/clone'),
        };

        const service = new AccountExportService(
            workRepository as any,
            workMemberRepository as any,
            workCustomDomainRepository as any,
            userPluginRepository as any,
            workPluginRepository as any,
            userRepository as any,
            advancedPromptsRepository as any,
            scheduleRepository as any,
            gitFacade as any,
        );

        return {
            service,
            data,
            mocks: {
                userRepository,
                workRepository,
                workMemberRepository,
                workCustomDomainRepository,
                userPluginRepository,
                workPluginRepository,
                advancedPromptsRepository,
                scheduleRepository,
                gitFacade,
            },
        };
    }

    function makeWork(overrides: Record<string, unknown> = {}) {
        return {
            id: 'work-1',
            slug: 'best-tools',
            name: 'Best Tools',
            description: 'desc',
            owner: 'octocat',
            userId: 'user-1',
            gitProvider: 'github',
            deployProvider: 'vercel',
            readmeConfig: null,
            domainType: null,
            repoVisibility: null,
            scheduledUpdatesEnabled: false,
            scheduledCadence: null,
            communityPrEnabled: false,
            communityPrAutoClose: false,
            comparisonsEnabled: true,
            user: { id: 'user-1' },
            getRepoOwner: () => 'octocat',
            getDataRepo: () => 'best-tools-data',
            ...overrides,
        };
    }

    describe('exportAccountData — top-level envelope', () => {
        it('throws when the user is not found', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue(null);

            await expect(service.exportAccountData('missing')).rejects.toThrow('User not found');
        });

        it('returns the v1 envelope shape with version=1, ISO exportedAt, and includesSecrets', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({
                username: 'octocat',
                email: 'o@e.com',
                avatar: undefined,
            });

            const result = await service.exportAccountData('user-1');

            expect(result.version).toBe(1);
            expect(typeof result.exportedAt).toBe('string');
            expect(new Date(result.exportedAt).toString()).not.toBe('Invalid Date');
            expect(result.includesSecrets).toBe(false); // default
        });

        it('honours includeSecrets:true in the output envelope', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({
                username: 'octocat',
                email: 'o@e.com',
            });

            const result = await service.exportAccountData('user-1', { includeSecrets: true });
            expect(result.includesSecrets).toBe(true);
        });

        it('maps profile (username/email/avatar with avatar normalised to undefined when falsy)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({
                username: 'octo',
                email: 'o@e.com',
                avatar: '',
            });

            const result = await service.exportAccountData('user-1');

            expect(result.data.profile).toEqual({
                username: 'octo',
                email: 'o@e.com',
                avatar: undefined,
            });
        });

        it('preserves a real avatar URL', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({
                username: 'octo',
                email: 'o@e.com',
                avatar: 'https://example.test/a.png',
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.profile.avatar).toBe('https://example.test/a.png');
        });

        it('exports zero works/userPlugins as empty arrays', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });

            const result = await service.exportAccountData('user-1');

            expect(result.data.works).toEqual([]);
            expect(result.data.userPlugins).toEqual([]);
        });
    });

    describe('exportAccountData — userPlugins', () => {
        function setup(includeSecrets: boolean, userPlugins: any[]) {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            mocks.userPluginRepository.findByUser.mockResolvedValue(userPlugins);
            return { service, mocks, includeSecrets };
        }

        it('omits secretSettings entirely when includeSecrets is false (default)', async () => {
            const { service } = setup(false, [
                {
                    pluginId: 'tavily',
                    enabled: true,
                    autoEnableForWorks: false,
                    settings: { region: 'us' },
                    secretSettings: { apiKey: 'sk-abcdefghij1234' },
                },
            ]);

            const result = await service.exportAccountData('user-1');
            expect(result.data.userPlugins).toHaveLength(1);
            expect(result.data.userPlugins[0]).toEqual({
                pluginId: 'tavily',
                enabled: true,
                autoEnableForWorks: false,
                settings: { region: 'us' },
            });
            expect((result.data.userPlugins[0] as any).secretSettings).toBeUndefined();
        });

        it('includes MASKED secretSettings when includeSecrets is true (real values NEVER leak)', async () => {
            const { service } = setup(true, [
                {
                    pluginId: 'tavily',
                    enabled: true,
                    autoEnableForWorks: true,
                    settings: { region: 'us' },
                    secretSettings: { apiKey: 'sk-abcdefghij1234' },
                },
            ]);

            const result = await service.exportAccountData('user-1', { includeSecrets: true });

            expect(result.data.userPlugins[0].secretSettings).toBeDefined();
            const masked = result.data.userPlugins[0].secretSettings as Record<string, string>;
            // MASKED values keep the keys but value MUST start with the prefix
            expect(masked.apiKey.startsWith(MASKED_SECRET_PREFIX)).toBe(true);
            // Real value MUST NOT appear anywhere in the serialised export
            expect(JSON.stringify(result)).not.toContain('sk-abcdefghij1234');
        });

        it('does not attach secretSettings when secretSettings is missing on the source row even with includeSecrets:true', async () => {
            const { service } = setup(true, [
                {
                    pluginId: 'tavily',
                    enabled: true,
                    autoEnableForWorks: false,
                    settings: { region: 'us' },
                    // no secretSettings
                },
            ]);

            const result = await service.exportAccountData('user-1', { includeSecrets: true });
            expect((result.data.userPlugins[0] as any).secretSettings).toBeUndefined();
        });

        it('coerces missing settings to {} (a row with null settings still serialises cleanly)', async () => {
            const { service } = setup(false, [
                {
                    pluginId: 'tavily',
                    enabled: false,
                    autoEnableForWorks: false,
                    settings: null,
                },
            ]);

            const result = await service.exportAccountData('user-1');
            expect(result.data.userPlugins[0].settings).toEqual({});
        });
    });

    describe('exportWork — relations and AdvancedPrompts/schedule branching', () => {
        function setupOneWork(
            extra: {
                prompts?: any;
                schedule?: any;
                members?: any[];
                domains?: any[];
                workPlugins?: any[];
            } = {},
        ) {
            const { service, mocks, ...rest } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            mocks.workRepository.findByUser.mockResolvedValue([makeWork()]);
            mocks.workMemberRepository.findByWork.mockResolvedValue(extra.members ?? []);
            mocks.workCustomDomainRepository.findByWork.mockResolvedValue(extra.domains ?? []);
            mocks.workPluginRepository.findByWork.mockResolvedValue(extra.workPlugins ?? []);
            mocks.advancedPromptsRepository.findByWorkId.mockResolvedValue(extra.prompts ?? null);
            mocks.scheduleRepository.findByWorkId.mockResolvedValue(extra.schedule ?? null);
            return { service, mocks, ...rest };
        }

        it('runs all five relation queries in parallel via Promise.all (each called exactly once with workId)', async () => {
            const { service, mocks } = setupOneWork();

            await service.exportAccountData('user-1');

            expect(mocks.workMemberRepository.findByWork).toHaveBeenCalledWith('work-1');
            expect(mocks.workCustomDomainRepository.findByWork).toHaveBeenCalledWith('work-1');
            expect(mocks.workPluginRepository.findByWork).toHaveBeenCalledWith('work-1');
            expect(mocks.advancedPromptsRepository.findByWorkId).toHaveBeenCalledWith('work-1');
            expect(mocks.scheduleRepository.findByWorkId).toHaveBeenCalledWith('work-1');
        });

        it('emits members[] in the documented {userId, role} shape', async () => {
            const { service } = setupOneWork({
                members: [
                    { userId: 'm1', role: 'owner', extra: 'ignored' },
                    { userId: 'm2', role: 'editor' },
                ],
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].members).toEqual([
                { userId: 'm1', role: 'owner' },
                { userId: 'm2', role: 'editor' },
            ]);
        });

        it('emits customDomains[] {domain, environment, verified, provider} with provider falling back to undefined', async () => {
            const { service } = setupOneWork({
                domains: [
                    {
                        domain: 'a.test',
                        environment: 'prod',
                        verified: true,
                        provider: 'cloudflare',
                    },
                    { domain: 'b.test', environment: 'preview', verified: false, provider: '' },
                ],
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].customDomains).toEqual([
                { domain: 'a.test', environment: 'prod', verified: true, provider: 'cloudflare' },
                { domain: 'b.test', environment: 'preview', verified: false, provider: undefined },
            ]);
        });

        it('emits workPlugins[] with `activeCapabilities` (computed via getActiveCapabilities — dedup + falsy-strip)', async () => {
            const { service } = setupOneWork({
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider', '', 'ai-provider'],
                        settings: { model: 'gpt-4o' },
                        priority: 0,
                    },
                ],
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].workPlugins[0].activeCapabilities).toEqual(['ai-provider']);
        });

        it('omits secretSettings on workPlugins when includeSecrets is false', async () => {
            const { service } = setupOneWork({
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: {},
                        secretSettings: { apiKey: 'sk-abcdefghij1234' },
                        priority: 0,
                    },
                ],
            });

            const result = await service.exportAccountData('user-1');
            expect((result.data.works[0].workPlugins[0] as any).secretSettings).toBeUndefined();
        });

        it('emits MASKED secretSettings on workPlugins when includeSecrets is true', async () => {
            const { service } = setupOneWork({
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: {},
                        secretSettings: { apiKey: 'sk-abcdefghij1234' },
                        priority: 0,
                    },
                ],
            });

            const result = await service.exportAccountData('user-1', { includeSecrets: true });
            const masked = (result.data.works[0].workPlugins[0] as any).secretSettings;
            expect(masked.apiKey.startsWith(MASKED_SECRET_PREFIX)).toBe(true);
            expect(JSON.stringify(result)).not.toContain('sk-abcdefghij1234');
        });

        it('builds advancedPrompts ONLY when ≥1 prompt field is truthy; omits the field entirely otherwise', async () => {
            // All 7 fields null → omit
            const noPrompts = setupOneWork({
                prompts: {
                    relevanceAssessment: null,
                    itemGeneration: null,
                    itemExtraction: null,
                    searchQuery: null,
                    categorization: null,
                    deduplication: null,
                    sourceValidation: null,
                },
            });
            const r1 = await noPrompts.service.exportAccountData('user-1');
            expect(r1.data.works[0].advancedPrompts).toBeUndefined();
        });

        it('includes only the truthy advancedPrompts fields (others stripped)', async () => {
            const { service } = setupOneWork({
                prompts: {
                    relevanceAssessment: 'foo',
                    itemGeneration: '',
                    itemExtraction: null,
                    searchQuery: 'bar',
                    categorization: null,
                    deduplication: null,
                    sourceValidation: null,
                },
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].advancedPrompts).toEqual({
                relevanceAssessment: 'foo',
                searchQuery: 'bar',
            });
        });

        it('includes ALL 7 advancedPrompts fields when all are truthy', async () => {
            const { service } = setupOneWork({
                prompts: {
                    relevanceAssessment: 'a',
                    itemGeneration: 'b',
                    itemExtraction: 'c',
                    searchQuery: 'd',
                    categorization: 'e',
                    deduplication: 'f',
                    sourceValidation: 'g',
                },
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].advancedPrompts).toEqual({
                relevanceAssessment: 'a',
                itemGeneration: 'b',
                itemExtraction: 'c',
                searchQuery: 'd',
                categorization: 'e',
                deduplication: 'f',
                sourceValidation: 'g',
            });
        });

        it('returns advancedPrompts:undefined when prompts row is null (no row at all)', async () => {
            const { service } = setupOneWork({ prompts: null });
            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].advancedPrompts).toBeUndefined();
        });

        it('emits the schedule envelope only when scheduleEntity is non-null', async () => {
            const { service } = setupOneWork({
                schedule: {
                    cadence: 'daily',
                    status: 'active',
                    billingMode: 'plan',
                    alwaysCreatePullRequest: true,
                    maxFailureBeforePause: 5,
                    providerOverrides: { openai: 'gpt-4o' },
                },
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].schedule).toEqual({
                cadence: 'daily',
                status: 'active',
                billingMode: 'plan',
                alwaysCreatePullRequest: true,
                maxFailureBeforePause: 5,
                providerOverrides: { openai: 'gpt-4o' },
            });
        });

        it('coerces falsy providerOverrides on the schedule entity to undefined', async () => {
            const { service } = setupOneWork({
                schedule: {
                    cadence: 'daily',
                    status: 'active',
                    billingMode: 'plan',
                    alwaysCreatePullRequest: false,
                    maxFailureBeforePause: 0,
                    providerOverrides: null,
                },
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].schedule!.providerOverrides).toBeUndefined();
        });

        it('omits the schedule field entirely when no row is found', async () => {
            const { service } = setupOneWork({ schedule: null });
            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].schedule).toBeUndefined();
        });

        it('passes work-level fields through verbatim with falsy → undefined normalisation for owner/deployProvider/readmeConfig/domainType/repoVisibility', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            mocks.workRepository.findByUser.mockResolvedValue([
                makeWork({
                    owner: '',
                    deployProvider: null,
                    readmeConfig: null,
                    domainType: null,
                    repoVisibility: null,
                    scheduledCadence: '',
                }),
            ]);

            const result = await service.exportAccountData('user-1');
            const w = result.data.works[0];
            expect(w.owner).toBeUndefined();
            expect(w.deployProvider).toBeUndefined();
            expect(w.readmeConfig).toBeUndefined();
            expect(w.domainType).toBeUndefined();
            expect(w.repoVisibility).toBeUndefined();
            // scheduledCadence preserves null (different rule from the rest)
            expect(w.scheduledCadence).toBeNull();
        });
    });

    describe('fetchWorkRepoData — repo cloning + parallel reads', () => {
        function setupOneWork(dataOverrides: Record<string, jest.Mock> = {}) {
            const data = makeData(dataOverrides);
            const { service, mocks } = makeService({ data });
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            mocks.workRepository.findByUser.mockResolvedValue([makeWork()]);
            return { service, mocks, data };
        }

        it('clones via the gitFacade with the work-level provider/owner/repo and userId from work.user.id', async () => {
            const { service, mocks } = setupOneWork();

            await service.exportAccountData('user-1');

            expect(mocks.gitFacade.cloneOrPull).toHaveBeenCalledWith(
                { owner: 'octocat', repo: 'best-tools-data' },
                { userId: 'user-1', providerId: 'github' },
            );
        });

        it('falls back to dir.userId when work.user is not loaded (lazy relation)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            mocks.workRepository.findByUser.mockResolvedValue([
                makeWork({ user: undefined, userId: 'fallback-uid' }),
            ]);

            await service.exportAccountData('user-1');

            expect(mocks.gitFacade.cloneOrPull).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ userId: 'fallback-uid' }),
            );
        });

        it('runs the seven data-repo readers in a single Promise.all batch', async () => {
            const { service, data } = setupOneWork();
            await service.exportAccountData('user-1');

            expect(data.getItems).toHaveBeenCalledTimes(1);
            expect(data.getCategories).toHaveBeenCalledTimes(1);
            expect(data.getTags).toHaveBeenCalledTimes(1);
            expect(data.getCollections).toHaveBeenCalledTimes(1);
            expect(data.getConfig).toHaveBeenCalledTimes(1);
            expect(data.getComparisons).toHaveBeenCalledTimes(1);
            expect(data.readMarkdownTemplate).toHaveBeenCalledTimes(1);
        });

        it('per-reader errors fall back to [] / null without aborting the export', async () => {
            const { service } = setupOneWork({
                getItems: jest.fn().mockRejectedValue(new Error('boom')),
                getCategories: jest.fn().mockRejectedValue(new Error('boom')),
                getTags: jest.fn().mockRejectedValue(new Error('boom')),
                getCollections: jest.fn().mockRejectedValue(new Error('boom')),
                getConfig: jest.fn().mockRejectedValue(new Error('boom')),
                getComparisons: jest.fn().mockRejectedValue(new Error('boom')),
                readMarkdownTemplate: jest.fn().mockRejectedValue(new Error('boom')),
            });

            const result = await service.exportAccountData('user-1');
            const w = result.data.works[0];
            expect(w.items).toEqual([]);
            expect(w.categories).toEqual([]);
            expect(w.tags).toEqual([]);
            expect(w.collections).toEqual([]);
            expect(w.siteConfig).toBeUndefined();
            expect(w.comparisons).toEqual([]);
            expect(w.markdownTemplate).toBeUndefined();
        });

        it('falls back to the empty-state object when cloneOrPull rejects (export does not abort)', async () => {
            const { service, mocks } = setupOneWork();
            mocks.gitFacade.cloneOrPull.mockRejectedValue(new Error('clone failed'));

            const result = await service.exportAccountData('user-1');
            const w = result.data.works[0];
            expect(w.items).toEqual([]);
            expect(w.categories).toEqual([]);
            expect(w.tags).toEqual([]);
            expect(w.collections).toEqual([]);
            expect(w.siteConfig).toBeUndefined();
            expect(w.comparisons).toEqual([]);
            expect(w.markdownTemplate).toBeUndefined();
        });

        it('falls back to the empty-state object when DataRepository.create rejects', async () => {
            const { service, mocks } = setupOneWork();
            mocks.userRepository.findById.mockResolvedValue({ username: 'a', email: 'a@a.a' });
            dataRepoCreateMock.mockReset();
            dataRepoCreateMock.mockRejectedValue(new Error('create failed'));

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].items).toEqual([]);
        });

        it('attaches per-comparison markdown via getComparisonMarkdown(slug)', async () => {
            const { service, data } = setupOneWork({
                getComparisons: jest.fn().mockResolvedValue([
                    { id: 'c1', slug: 'a-vs-b', title: 'A vs B' },
                    { id: 'c2', slug: 'c-vs-d', title: 'C vs D' },
                ]),
                getComparisonMarkdown: jest
                    .fn()
                    .mockResolvedValueOnce('# A vs B markdown')
                    .mockResolvedValueOnce('# C vs D markdown'),
            });

            const result = await service.exportAccountData('user-1');

            expect(data.getComparisonMarkdown).toHaveBeenCalledWith('a-vs-b');
            expect(data.getComparisonMarkdown).toHaveBeenCalledWith('c-vs-d');
            expect(result.data.works[0].comparisons).toEqual([
                { id: 'c1', slug: 'a-vs-b', title: 'A vs B', markdown: '# A vs B markdown' },
                { id: 'c2', slug: 'c-vs-d', title: 'C vs D', markdown: '# C vs D markdown' },
            ]);
        });

        it('omits markdown on a comparison when getComparisonMarkdown rejects (per-comparison failure)', async () => {
            const { service } = setupOneWork({
                getComparisons: jest
                    .fn()
                    .mockResolvedValue([{ id: 'c1', slug: 'a-vs-b', title: 'A vs B' }]),
                getComparisonMarkdown: jest.fn().mockRejectedValue(new Error('not-found')),
            });

            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].comparisons).toEqual([
                { id: 'c1', slug: 'a-vs-b', title: 'A vs B', markdown: undefined },
            ]);
        });

        it('emits markdownTemplate ONLY when at least one of header/footer is truthy', async () => {
            // All-empty → omitted
            const empty = setupOneWork({
                readMarkdownTemplate: jest.fn().mockResolvedValue({ header: '', footer: '' }),
            });
            const r1 = await empty.service.exportAccountData('user-1');
            expect(r1.data.works[0].markdownTemplate).toBeUndefined();
        });

        it('emits markdownTemplate when ONLY header is truthy', async () => {
            const { service } = setupOneWork({
                readMarkdownTemplate: jest.fn().mockResolvedValue({ header: 'H', footer: '' }),
            });
            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].markdownTemplate).toEqual({ header: 'H', footer: '' });
        });

        it('coerces siteConfig falsy values to undefined (so empty config is not serialised as null)', async () => {
            const { service } = setupOneWork({
                getConfig: jest.fn().mockResolvedValue(null),
            });
            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].siteConfig).toBeUndefined();
        });

        it('passes a real siteConfig through verbatim when present', async () => {
            const { service } = setupOneWork({
                getConfig: jest.fn().mockResolvedValue({ siteName: 'Best', tagline: 'Tools' }),
            });
            const result = await service.exportAccountData('user-1');
            expect(result.data.works[0].siteConfig).toEqual({ siteName: 'Best', tagline: 'Tools' });
        });
    });
});
