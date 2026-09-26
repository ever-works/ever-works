import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WebsiteTemplateResolverService } from '@src/generators/website-generator/website-template-resolver.service';
import { TemplateCatalogService } from './template-catalog.service';

describe('TemplateCatalogService', () => {
    let templateRepository: any;
    let customizationRepository: any;
    let userTemplatePreferenceRepository: any;
    let workRepository: any;
    let gitFacade: any;
    let service: TemplateCatalogService;

    beforeEach(() => {
        templateRepository = {
            findVisibleByKind: jest.fn(),
            findVisibleById: jest.fn(),
            findOwnedCustomById: jest.fn(),
            findOwnedCustomByRepositoryUrl: jest.fn(),
            findOwnedCustomByRepositoryCoordinates: jest.fn(),
            findBuiltInByRepositoryCoordinates: jest.fn(),
            findAllBuiltInByRepositoryCoordinates: jest.fn().mockResolvedValue([]),
            hasRecentDiscoveredBuiltInTemplates: jest.fn(),
            findById: jest.fn(),
            upsert: jest.fn(),
            updateById: jest.fn(),
        };
        customizationRepository = {
            findLatestForTemplates: jest.fn().mockResolvedValue(new Map()),
        };
        userTemplatePreferenceRepository = {
            findByUserAndKind: jest.fn(),
            upsertDefault: jest.fn(),
            deleteByUserKindAndTemplateId: jest.fn(),
            findUserIdsByKindAndTemplateId: jest.fn().mockResolvedValue([]),
        };
        workRepository = {
            countByUserAndWebsiteTemplateId: jest.fn(),
            countByUserAndInheritedWebsiteTemplateSelection: jest.fn(),
            countByWebsiteTemplateId: jest.fn().mockResolvedValue(0),
            countByUsersAndInheritedWebsiteTemplateSelection: jest.fn().mockResolvedValue(0),
        };
        gitFacade = {
            hasValidCredentials: jest.fn().mockResolvedValue(false),
            getAccessToken: jest.fn().mockResolvedValue(null),
            listRepositories: jest.fn(),
            listPublicRepositories: jest.fn(),
            getUser: jest.fn(),
            getOrganizations: jest.fn(),
            forkRepository: jest.fn(),
            getWebUrl: jest.fn(),
        };

        service = new TemplateCatalogService(
            templateRepository,
            customizationRepository,
            userTemplatePreferenceRepository,
            workRepository,
            gitFacade,
        );
    });

    it('updates editable metadata for a custom template', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'Old Name',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: null,
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        templateRepository.updateById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'New Name',
            description: 'New description',
            framework: 'Astro',
            previewImageUrl: 'https://example.com/preview.png',
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'develop',
            syncBranches: ['develop'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
            templateId: 'custom-1',
        });
        templateRepository.findVisibleById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            isActive: true,
        });

        const result = await service.updateCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
                name: 'New Name',
                description: 'New description',
                framework: 'Astro',
                previewImageUrl: 'https://example.com/preview.png',
                branch: 'develop',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith(
            'custom-1',
            expect.objectContaining({
                name: 'New Name',
                description: 'New description',
                framework: 'Astro',
                previewImageUrl: 'https://example.com/preview.png',
                branch: 'develop',
                syncBranches: ['develop'],
            }),
        );
        expect(result.name).toBe('New Name');
        expect(result.isDefault).toBe(true);
    });

    it('preserves omitted metadata fields during partial custom template updates', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'Old Name',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: 'https://example.com/old.png',
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        templateRepository.updateById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'Renamed',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: 'https://example.com/old.png',
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        await service.updateCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
                name: 'Renamed',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith(
            'custom-1',
            expect.objectContaining({
                name: 'Renamed',
                description: 'Old description',
                framework: 'Next.js',
                previewImageUrl: 'https://example.com/old.png',
                branch: 'main',
                syncBranches: ['main'],
            }),
        );
    });

    it('rejects archiving a custom template that is still assigned to works', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(2);

        await expect(
            service.archiveCustomTemplateForUser(
                {
                    kind: 'website',
                    templateId: 'custom-1',
                },
                'user-1',
            ),
        ).rejects.toThrow(ConflictException);

        expect(templateRepository.updateById).not.toHaveBeenCalled();
    });

    it('rejects archiving a custom template that is the current default for inheriting works', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(0);
        workRepository.countByUserAndInheritedWebsiteTemplateSelection.mockResolvedValue(3);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
            templateId: 'custom-1',
        });
        templateRepository.findVisibleById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            isActive: true,
        });

        await expect(
            service.archiveCustomTemplateForUser(
                {
                    kind: 'website',
                    templateId: 'custom-1',
                },
                'user-1',
            ),
        ).rejects.toThrow(ConflictException);

        expect(templateRepository.updateById).not.toHaveBeenCalled();
    });

    it('archives an unused custom template', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(0);
        workRepository.countByUserAndInheritedWebsiteTemplateSelection.mockResolvedValue(0);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.archiveCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith('custom-1', {
            isActive: false,
        });
        expect(userTemplatePreferenceRepository.deleteByUserKindAndTemplateId).toHaveBeenCalledWith(
            'user-1',
            'website',
            'custom-1',
        );
        expect(result).toEqual({
            templateId: 'custom-1',
            archived: true,
        });
    });

    it('does not sync discovered templates during a normal list read when discovery is fresh', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.listTemplatesForUser('website', 'user-1');

        expect(gitFacade.listRepositories).not.toHaveBeenCalled();
        expect(gitFacade.listPublicRepositories).not.toHaveBeenCalled();
        expect(result).toEqual({
            defaultTemplateId: 'classic',
            templates: [],
        });
    });

    it('syncs discovered templates during a list read when discovery is stale', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(false);
        gitFacade.getAccessToken.mockResolvedValue(null);
        gitFacade.listPublicRepositories.mockResolvedValueOnce([]);
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.listTemplatesForUser('website', 'user-1');

        expect(gitFacade.listPublicRepositories).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            defaultTemplateId: 'classic',
            templates: [],
        });
    });

    it('refreshes discovered standard templates for website catalogs', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        gitFacade.getAccessToken.mockResolvedValue(null);
        const firstPageRepositories = Array.from({ length: 100 }, (_, index) => ({
            name: `repo-${index}`,
            owner: 'ever-works',
            url: `https://github.com/ever-works/repo-${index}`,
            fullName: `ever-works/repo-${index}`,
            defaultBranch: 'main',
            description: `Repository ${index}`,
        }));
        firstPageRepositories[0] = {
            name: 'astro-blog-template',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/astro-blog-template',
            fullName: 'ever-works/astro-blog-template',
            defaultBranch: 'main',
            description: 'Astro blog template',
        };
        firstPageRepositories[1] = {
            name: 'docs',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/docs',
            fullName: 'ever-works/docs',
            defaultBranch: 'main',
            description: 'Docs',
        };
        gitFacade.listPublicRepositories
            .mockResolvedValueOnce(firstPageRepositories)
            .mockResolvedValueOnce([]);
        templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue({
            id: 'astro-blog',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'astro-blog-template',
            isActive: true,
        });
        templateRepository.findById.mockResolvedValue({
            id: 'astro-blog-template',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'astro-blog-template',
            isActive: true,
        });
        templateRepository.findVisibleByKind.mockResolvedValue([
            {
                id: 'astro-blog',
                kind: 'website',
                sourceType: 'built_in',
                name: 'Astro Blog',
                description: 'Astro blog template',
                framework: null,
                previewImageUrl: null,
                repositoryUrl: 'https://github.com/ever-works/astro-blog-template',
                repositoryOwner: 'ever-works',
                repositoryName: 'astro-blog-template',
                branch: 'main',
                syncBranches: ['main'],
                betaBranch: null,
                isActive: true,
                ownerUserId: null,
                metadata: { discoveredFromOrganization: 'ever-works' },
            },
        ]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.refreshTemplatesForUser('website', 'user-1');

        expect(templateRepository.upsert).toHaveBeenCalledTimes(1);
        expect(gitFacade.listPublicRepositories).toHaveBeenCalledTimes(2);
        expect(gitFacade.listPublicRepositories).toHaveBeenNthCalledWith(
            1,
            'github',
            1,
            100,
            expect.objectContaining({
                owner: 'ever-works',
                type: 'org',
            }),
        );
        expect(templateRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'astro-blog',
                sourceType: 'built_in',
                repositoryName: 'astro-blog-template',
            }),
        );
        expect(templateRepository.updateById).toHaveBeenCalledWith('astro-blog-template', {
            isActive: false,
        });
        expect(result.templates[0]).toEqual(
            expect.objectContaining({
                id: 'astro-blog',
                originType: 'standard',
            }),
        );
    });

    it('seedBuiltInTemplates deactivates orphan built-in rows pointing at the same repo', async () => {
        templateRepository.upsert.mockResolvedValue(undefined);
        // Phase 8 PR X — the curated catalog now seeds Mission Templates
        // alongside Website Templates, so the per-curated dedup loop
        // also calls findAllBuiltInByRepositoryCoordinates for each
        // Mission repo. The mock returns ONLY the matching curated id
        // for each (owner, repo) so non-orphan curated rows aren't
        // erroneously deactivated.
        // Curated rows keyed by their OWN kind — the real
        // findAllBuiltInByRepositoryCoordinates filters by (kind, owner, repo),
        // so a work/mission template that happens to share a repo with a
        // website template must NOT surface the website rows. Modeling the kind
        // filter here keeps the cross-kind seeds (listWorkTemplates /
        // listMissionTemplates reuse directory-web* repos) from spuriously
        // deactivating the curated website rows.
        const CURATED_BY_REPO: Record<string, { id: string; kind: string }> = {
            'ever-works/directory-web-template': { id: 'classic', kind: 'website' },
            'ever-works/directory-web-minimal-template': { id: 'minimal', kind: 'website' },
            'ever-works/starter-business-mission-template': {
                id: 'starter-business',
                kind: 'mission',
            },
            'ever-works/starter-content-mission-template': {
                id: 'starter-content',
                kind: 'mission',
            },
        };
        templateRepository.findAllBuiltInByRepositoryCoordinates.mockImplementation(
            async (kind: string, owner: string, repo: string) => {
                if (
                    kind === 'website' &&
                    owner === 'ever-works' &&
                    repo === 'directory-web-minimal-template'
                ) {
                    return [
                        {
                            id: 'minimal',
                            kind: 'website',
                            sourceType: 'built_in',
                            repositoryOwner: owner,
                            repositoryName: repo,
                            isActive: true,
                        },
                        {
                            id: 'directory-web-minimal-template',
                            kind: 'website',
                            sourceType: 'built_in',
                            repositoryOwner: owner,
                            repositoryName: repo,
                            isActive: true,
                        },
                    ];
                }
                const curated = CURATED_BY_REPO[`${owner}/${repo}`];
                if (!curated || curated.kind !== kind) return [];
                return [
                    {
                        id: curated.id,
                        kind,
                        sourceType: 'built_in',
                        repositoryOwner: owner,
                        repositoryName: repo,
                        isActive: true,
                    },
                ];
            },
        );

        await service.seedBuiltInTemplates();

        expect(templateRepository.updateById).toHaveBeenCalledWith(
            'directory-web-minimal-template',
            { isActive: false },
        );
        expect(templateRepository.updateById).not.toHaveBeenCalledWith(
            'minimal',
            expect.anything(),
        );
        expect(templateRepository.updateById).not.toHaveBeenCalledWith(
            'classic',
            expect.anything(),
        );
    });

    it('skips discovered repos already covered by a curated built-in template', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        gitFacade.getAccessToken.mockResolvedValue(null);
        gitFacade.listPublicRepositories
            .mockResolvedValueOnce([
                {
                    name: 'directory-web-minimal-template',
                    owner: 'ever-works',
                    url: 'https://github.com/ever-works/directory-web-minimal-template',
                    fullName: 'ever-works/directory-web-minimal-template',
                    defaultBranch: 'develop',
                    description: 'Minimal template',
                },
            ])
            .mockResolvedValueOnce([]);
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        await service.refreshTemplatesForUser('website', 'user-1');

        expect(templateRepository.findBuiltInByRepositoryCoordinates).not.toHaveBeenCalledWith(
            'website',
            'ever-works',
            'directory-web-minimal-template',
        );
        expect(templateRepository.upsert).not.toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryOwner: 'ever-works',
                repositoryName: 'directory-web-minimal-template',
            }),
        );
    });

    it('skips discovered templates whose repo-name id collides with a different built-in record', async () => {
        const warnSpy = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);

        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        gitFacade.getAccessToken.mockResolvedValue(null);
        gitFacade.listPublicRepositories
            .mockResolvedValueOnce([
                {
                    name: 'astro-template',
                    owner: 'ever-works',
                    url: 'https://github.com/ever-works/astro-template',
                    fullName: 'ever-works/astro-template',
                    defaultBranch: 'main',
                    description: 'Astro template',
                },
            ])
            .mockResolvedValueOnce([]);
        templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue(null);
        templateRepository.findById.mockResolvedValue({
            id: 'astro-template',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'other-org',
            repositoryName: 'astro-template',
            isActive: true,
        });
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        await service.refreshTemplatesForUser('website', 'user-1');

        expect(templateRepository.upsert).not.toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'astro-template',
                repositoryOwner: 'ever-works',
                repositoryName: 'astro-template',
            }),
        );
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                'Skipping discovered template "ever-works/astro-template" because id "astro-template" is already used',
            ),
        );
    });

    describe('App Blueprint repositories are not website templates', () => {
        // ever-works/cal-template and ever-works/umami-template are App Blueprints
        // (topic `ever-works-app-blueprint`, `.works/works.yml` with `kind: app`)
        // whose names end in "template". Name matching alone saved them as
        // built-in WEBSITE templates ("Cal Template", "Umami Template") in the
        // Create-Work picker; the topic is what tells them apart.
        const websiteTemplateRepository = {
            name: 'astro-blog-template',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/astro-blog-template',
            fullName: 'ever-works/astro-blog-template',
            defaultBranch: 'main',
            description: 'Astro blog template',
            topics: ['astro', 'website-template'],
        };
        // The Blueprint repository as a provider that does not report topics sees it.
        const blueprintRepositoryWithoutTopics = {
            name: 'cal-template',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/cal-template',
            fullName: 'ever-works/cal-template',
            defaultBranch: 'main',
            description: 'Cal.com App Blueprint',
        };
        const appBlueprintRepository = {
            ...blueprintRepositoryWithoutTopics,
            topics: ['ever-works-app-blueprint', 'ever-works'],
        };
        const discoveredBlueprintRow = {
            id: 'cal-template',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'cal-template',
            isActive: true,
            metadata: {
                discoveredFromOrganization: 'ever-works',
                fullName: 'ever-works/cal-template',
            },
        };

        beforeEach(() => {
            templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
            gitFacade.getAccessToken.mockResolvedValue(null);
            templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue(null);
            templateRepository.findById.mockResolvedValue(null);
            templateRepository.findVisibleByKind.mockResolvedValue([]);
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);
        });

        it('saves only the website template when the listing also carries an App Blueprint', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                websiteTemplateRepository,
                appBlueprintRepository,
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.upsert).toHaveBeenCalledTimes(1);
            expect(templateRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'astro-blog-template',
                    kind: 'website',
                    sourceType: 'built_in',
                    repositoryName: 'astro-blog-template',
                }),
            );
            expect(templateRepository.upsert).not.toHaveBeenCalledWith(
                expect.objectContaining({ repositoryName: 'cal-template' }),
            );
        });

        it('saves only the website template on the authenticated listing path too', async () => {
            gitFacade.getAccessToken.mockResolvedValue('gho_user_token');
            gitFacade.listRepositories.mockResolvedValueOnce([
                appBlueprintRepository,
                websiteTemplateRepository,
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(gitFacade.listPublicRepositories).not.toHaveBeenCalled();
            expect(templateRepository.upsert).toHaveBeenCalledTimes(1);
            expect(templateRepository.upsert).not.toHaveBeenCalledWith(
                expect.objectContaining({ repositoryName: 'cal-template' }),
            );
        });

        // The only write retirement makes: the row's `metadata` gains the
        // retirement marker, and `isActive` is not in the patch at all.
        const retiredMetadataPatch = {
            metadata: expect.objectContaining({
                discoveredFromOrganization: 'ever-works',
                fullName: 'ever-works/cal-template',
                retiredReason: 'app_blueprint',
                retiredAt: expect.any(String),
            }),
        };

        // PIN CHANGED (Greptile P1s on https://github.com/ever-works/ever-works/pull/2511).
        // This test used to expect `updateById('cal-template', { isActive: false })`.
        // Deactivating was the defect: the website resolver only resolves ACTIVE
        // rows, so a Work created, switched or defaulted onto the row between
        // the usage check and the update was left on a row that no longer
        // resolves. The row is RETIRED instead (templates-catalog FR-5 c): it
        // stays active, so every Work already using it keeps resolving, but it
        // is never listed and never accepted as a new selection.
        it('retires, and does not deactivate, a row an earlier discovery saved for a repository that is now an App Blueprint', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                websiteTemplateRepository,
                appBlueprintRepository,
            ]);
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockImplementation(
                async (kind: string, owner: string, repo: string) =>
                    kind === 'website' && owner === 'ever-works' && repo === 'cal-template'
                        ? [discoveredBlueprintRow]
                        : [],
            );

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.findAllBuiltInByRepositoryCoordinates).toHaveBeenCalledWith(
                'website',
                'ever-works',
                'cal-template',
            );
            expect(templateRepository.updateById).toHaveBeenCalledWith(
                'cal-template',
                retiredMetadataPatch,
            );
            expect(templateRepository.updateById).not.toHaveBeenCalledWith(
                'cal-template',
                expect.objectContaining({ isActive: expect.anything() }),
            );
            expect(templateRepository.updateById).toHaveBeenCalledTimes(1);
        });

        // PINS CHANGED (Greptile P1s on https://github.com/ever-works/ever-works/pull/2511).
        // This block used to pin "a row Works still use stays active AND
        // offered, with a warning; the discovery after they are reassigned
        // deactivates it", counting usage first. That encoded both defects:
        // (1) a row kept for old Works stayed in every user's picker, so NEW
        // Works could keep selecting it; (2) count-then-deactivate was not
        // atomic, so a Work landing on the row between the count and the
        // update pointed at a row the resolver no longer resolves. Retiring
        // changes neither `isActive` nor what resolves, so it needs no usage
        // count and has no such window: a row in use is retired like any other,
        // and the usage reads are no longer made.
        describe('while Works still use the Blueprint row', () => {
            beforeEach(() => {
                gitFacade.listPublicRepositories.mockResolvedValueOnce([
                    websiteTemplateRepository,
                    appBlueprintRepository,
                ]);
                templateRepository.findAllBuiltInByRepositoryCoordinates.mockImplementation(
                    async (kind: string, owner: string, repo: string) =>
                        kind === 'website' && owner === 'ever-works' && repo === 'cal-template'
                            ? [discoveredBlueprintRow]
                            : [],
                );
            });

            it('retires the row while Works name it explicitly, without counting them', async () => {
                workRepository.countByWebsiteTemplateId.mockImplementation(async (id: string) =>
                    id === 'cal-template' ? 2 : 0,
                );

                await service.refreshTemplatesForUser('website', 'user-1');

                expect(templateRepository.updateById).toHaveBeenCalledWith(
                    'cal-template',
                    retiredMetadataPatch,
                );
                expect(templateRepository.updateById).not.toHaveBeenCalledWith(
                    'cal-template',
                    expect.objectContaining({ isActive: expect.anything() }),
                );
                expect(workRepository.countByWebsiteTemplateId).not.toHaveBeenCalled();
                // The ordinary website template is still discovered.
                expect(templateRepository.upsert).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'astro-blog-template' }),
                );
            });

            it('retires the row while a user default points at it and that user has inheriting Works', async () => {
                userTemplatePreferenceRepository.findUserIdsByKindAndTemplateId.mockImplementation(
                    async (kind: string, templateId: string) =>
                        kind === 'website' && templateId === 'cal-template' ? ['user-7'] : [],
                );
                workRepository.countByUsersAndInheritedWebsiteTemplateSelection.mockImplementation(
                    async (userIds: string[]) => (userIds.includes('user-7') ? 1 : 0),
                );

                await service.refreshTemplatesForUser('website', 'user-1');

                expect(templateRepository.updateById).toHaveBeenCalledWith(
                    'cal-template',
                    retiredMetadataPatch,
                );
                expect(
                    userTemplatePreferenceRepository.findUserIdsByKindAndTemplateId,
                ).not.toHaveBeenCalled();
                expect(
                    workRepository.countByUsersAndInheritedWebsiteTemplateSelection,
                ).not.toHaveBeenCalled();
                // Retiring never touches anyone's saved default.
                expect(userTemplatePreferenceRepository.upsertDefault).not.toHaveBeenCalled();
                expect(
                    userTemplatePreferenceRepository.deleteByUserKindAndTemplateId,
                ).not.toHaveBeenCalled();
            });

            it('retires the row the same way when a user default points at it but no Work inherits that default', async () => {
                userTemplatePreferenceRepository.findUserIdsByKindAndTemplateId.mockResolvedValue([
                    'user-7',
                ]);
                workRepository.countByUsersAndInheritedWebsiteTemplateSelection.mockResolvedValue(
                    0,
                );

                await service.refreshTemplatesForUser('website', 'user-1');

                expect(templateRepository.updateById).toHaveBeenCalledWith(
                    'cal-template',
                    retiredMetadataPatch,
                );
                expect(templateRepository.updateById).toHaveBeenCalledTimes(1);
            });

            it('leaves the row as it is when retiring it fails, and still saves the website templates', async () => {
                templateRepository.updateById.mockRejectedValue(new Error('db down'));
                const warn = jest.spyOn((service as any).logger, 'warn');

                await service.refreshTemplatesForUser('website', 'user-1');

                expect(templateRepository.upsert).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'astro-blog-template' }),
                );
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('"cal-template"'));
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
            });
        });

        it('does not rewrite a row that is already retired', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([appBlueprintRepository]);
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockResolvedValue([
                {
                    ...discoveredBlueprintRow,
                    metadata: {
                        ...discoveredBlueprintRow.metadata,
                        retiredReason: 'app_blueprint',
                        retiredAt: '2026-09-26T00:00:00.000Z',
                    },
                },
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.updateById).not.toHaveBeenCalled();
        });

        it('keeps a retirement when a provider that does not report topics rediscovers the repository', async () => {
            // Unreported topics cannot say the repository stopped being a
            // Blueprint, so the name-only fallback (FR-5 b) must not put a row
            // a topic-reporting discovery retired back into the picker.
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                blueprintRepositoryWithoutTopics,
            ]);
            templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue({
                ...discoveredBlueprintRow,
                metadata: {
                    ...discoveredBlueprintRow.metadata,
                    retiredReason: 'app_blueprint',
                    retiredAt: '2026-09-26T00:00:00.000Z',
                },
            });

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'cal-template',
                    isActive: true,
                    metadata: expect.objectContaining({
                        discoveredFromOrganization: 'ever-works',
                        retiredReason: 'app_blueprint',
                        retiredAt: '2026-09-26T00:00:00.000Z',
                    }),
                }),
            );
        });

        it('lifts a retirement once the provider reports topics without the Blueprint topic', async () => {
            // A REPORTED topic list is evidence: the repository is no longer
            // a Blueprint, so the name rule makes it a website template again.
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                { ...appBlueprintRepository, topics: ['website-template'] },
            ]);
            templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue({
                ...discoveredBlueprintRow,
                metadata: {
                    ...discoveredBlueprintRow.metadata,
                    retiredReason: 'app_blueprint',
                    retiredAt: '2026-09-26T00:00:00.000Z',
                },
            });

            await service.refreshTemplatesForUser('website', 'user-1');

            const upserted = templateRepository.upsert.mock.calls[0][0];
            expect(upserted).toEqual(expect.objectContaining({ id: 'cal-template' }));
            expect(upserted.metadata).not.toHaveProperty('retiredReason');
            expect(upserted.metadata).not.toHaveProperty('retiredAt');
        });

        // Greptile P1 #2 end to end: after discovery retires the row, the
        // Works already on it — by id, and through an inherited user default —
        // still resolve, because the row the resolver reads is still active.
        // Against a stateful store shared by discovery and the resolver.
        it('leaves a retired row resolvable for a Work naming it and for an inherited default, and out of the listing', async () => {
            const store = new Map<string, any>([
                [
                    'cal-template',
                    {
                        ...discoveredBlueprintRow,
                        name: 'Cal Template',
                        description: 'Cal.com App Blueprint',
                        branch: 'main',
                        syncBranches: ['main'],
                        betaBranch: null,
                    },
                ],
            ]);
            const builtInActive = (row: any) => row.sourceType === 'built_in' && row.isActive;
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockImplementation(
                async (kind: string, owner: string, repo: string) =>
                    [...store.values()].filter(
                        (row) =>
                            row.kind === kind &&
                            row.sourceType === 'built_in' &&
                            row.repositoryOwner === owner &&
                            row.repositoryName === repo,
                    ),
            );
            templateRepository.updateById.mockImplementation(async (id: string, patch: any) => {
                store.set(id, { ...store.get(id), ...patch });
                return store.get(id);
            });
            templateRepository.upsert.mockImplementation(async (row: any) => {
                store.set(row.id, { ...store.get(row.id), ...row });
                return store.get(row.id);
            });
            templateRepository.findById.mockImplementation(
                async (id: string) => store.get(id) ?? null,
            );
            templateRepository.findVisibleById.mockImplementation(async (id: string) => {
                const row = store.get(id);
                return row && builtInActive(row) ? row : null;
            });
            templateRepository.findVisibleByKind.mockImplementation(async (kind: string) =>
                [...store.values()].filter((row) => row.kind === kind && builtInActive(row)),
            );
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                websiteTemplateRepository,
                appBlueprintRepository,
            ]);

            const listed = await service.refreshTemplatesForUser('website', 'user-1');

            const resolver = new WebsiteTemplateResolverService(templateRepository, {
                findByUserAndKind: jest.fn(async (userId: string, kind: string) =>
                    userId === 'user-7' && kind === 'website'
                        ? { templateId: 'cal-template' }
                        : null,
                ),
            } as any);
            await expect(
                resolver.resolveForWork({ userId: 'user-1', websiteTemplateId: 'cal-template' }),
            ).resolves.toEqual(
                expect.objectContaining({
                    id: 'cal-template',
                    owner: 'ever-works',
                    repo: 'cal-template',
                }),
            );
            await expect(
                resolver.resolveForWork({ userId: 'user-7', websiteTemplateId: null }),
            ).resolves.toEqual(
                expect.objectContaining({ id: 'cal-template', repo: 'cal-template' }),
            );
            expect(listed.templates.map((template) => template.id)).toEqual([
                'astro-blog-template',
            ]);
        });

        it('still saves the website templates when looking up the rows of a Blueprint repository fails', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                websiteTemplateRepository,
                appBlueprintRepository,
            ]);
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockRejectedValue(
                new Error('db down'),
            );
            const warn = jest.spyOn((service as any).logger, 'warn');

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.updateById).not.toHaveBeenCalled();
            expect(templateRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'astro-blog-template' }),
            );
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('ever-works/cal-template'));
        });

        it('leaves an already-inactive discovered Blueprint row alone', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([appBlueprintRepository]);
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockResolvedValue([
                { ...discoveredBlueprintRow, isActive: false },
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.updateById).not.toHaveBeenCalled();
        });

        it('never deactivates a curated WEBSITE_TEMPLATES row, even if its repository carries the topic', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                {
                    name: 'directory-web-minimal-template',
                    owner: 'ever-works',
                    url: 'https://github.com/ever-works/directory-web-minimal-template',
                    fullName: 'ever-works/directory-web-minimal-template',
                    defaultBranch: 'develop',
                    description: 'Minimal template',
                    topics: ['ever-works-app-blueprint'],
                },
            ]);
            templateRepository.findAllBuiltInByRepositoryCoordinates.mockResolvedValue([
                {
                    id: 'minimal',
                    kind: 'website',
                    sourceType: 'built_in',
                    repositoryOwner: 'ever-works',
                    repositoryName: 'directory-web-minimal-template',
                    isActive: true,
                    metadata: {},
                },
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.updateById).not.toHaveBeenCalled();
            expect(templateRepository.upsert).not.toHaveBeenCalled();
        });

        it('treats a repository whose provider reported no topics exactly as before', async () => {
            // `topics` undefined = "not reported" (git-provider contract), never
            // "not a Blueprint" and never "a Blueprint": today's name rule applies.
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                blueprintRepositoryWithoutTopics,
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'cal-template',
                    kind: 'website',
                    sourceType: 'built_in',
                    repositoryName: 'cal-template',
                    isActive: true,
                }),
            );
            expect(templateRepository.findAllBuiltInByRepositoryCoordinates).not.toHaveBeenCalled();
            expect(templateRepository.updateById).not.toHaveBeenCalled();
        });

        it('treats a repository with an empty topic list exactly as before', async () => {
            gitFacade.listPublicRepositories.mockResolvedValueOnce([
                { ...appBlueprintRepository, topics: [] },
            ]);

            await service.refreshTemplatesForUser('website', 'user-1');

            expect(templateRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'cal-template', repositoryName: 'cal-template' }),
            );
            expect(templateRepository.updateById).not.toHaveBeenCalled();
        });
    });

    // A retired row (FR-5 c) is kept ONLY so the Works already on it keep
    // resolving. Greptile P1 #1 on https://github.com/ever-works/ever-works/pull/2511:
    // a row kept for old Works must not stay in every user's picker, and no
    // path may make it a NEW selection.
    describe('retired website-template rows', () => {
        const retiredRow = {
            id: 'cal-template',
            kind: 'website',
            sourceType: 'built_in',
            ownerUserId: null,
            name: 'Cal Template',
            description: 'Cal.com App Blueprint',
            framework: null,
            previewImageUrl: null,
            repositoryUrl: 'https://github.com/ever-works/cal-template',
            repositoryOwner: 'ever-works',
            repositoryName: 'cal-template',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {
                discoveredFromOrganization: 'ever-works',
                fullName: 'ever-works/cal-template',
                retiredReason: 'app_blueprint',
                retiredAt: '2026-09-26T00:00:00.000Z',
            },
        };
        const listedRow = {
            ...retiredRow,
            id: 'astro-blog-template',
            name: 'Astro Blog Template',
            description: 'Astro blog template',
            repositoryUrl: 'https://github.com/ever-works/astro-blog-template',
            repositoryName: 'astro-blog-template',
            metadata: {
                discoveredFromOrganization: 'ever-works',
                fullName: 'ever-works/astro-blog-template',
            },
        };
        const blueprintRefusal = /"cal-template".*is an App Blueprint, not a website template/;

        beforeEach(() => {
            templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);
        });

        it('leaves a retired row out of the picker listing', async () => {
            templateRepository.findVisibleByKind.mockResolvedValue([listedRow, retiredRow]);

            const result = await service.listTemplatesForUser('website', 'user-1');

            expect(result.templates.map((template) => template.id)).toEqual([
                'astro-blog-template',
            ]);
            expect(customizationRepository.findLatestForTemplates).toHaveBeenCalledWith(
                ['astro-blog-template'],
                'user-1',
            );
        });

        it('refuses a retired row as the user default, with a 400 that says why', async () => {
            templateRepository.findVisibleById.mockResolvedValue(retiredRow);

            const attempt = service.setDefaultTemplateForUser('website', 'cal-template', 'user-1');

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(blueprintRefusal);
            expect(userTemplatePreferenceRepository.upsertDefault).not.toHaveBeenCalled();
        });

        it('still sets a listed built-in row as the user default', async () => {
            templateRepository.findVisibleById.mockResolvedValue(listedRow);

            await expect(
                service.setDefaultTemplateForUser('website', 'astro-blog-template', 'user-1'),
            ).resolves.toEqual({ defaultTemplateId: 'astro-blog-template' });
            expect(userTemplatePreferenceRepository.upsertDefault).toHaveBeenCalledWith(
                'user-1',
                'website',
                'astro-blog-template',
            );
        });

        it('refuses to fork a retired row (the fork would become the user default)', async () => {
            templateRepository.findVisibleById.mockResolvedValue(retiredRow);
            gitFacade.getUser.mockResolvedValue({ login: 'acme-user' });
            gitFacade.getOrganizations.mockResolvedValue([]);

            const attempt = service.forkTemplateForUser(
                { kind: 'website', templateId: 'cal-template', targetOwner: 'acme-user' },
                'user-1',
            );

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(blueprintRefusal);
            expect(gitFacade.forkRepository).not.toHaveBeenCalled();
            expect(templateRepository.upsert).not.toHaveBeenCalled();
            expect(userTemplatePreferenceRepository.upsertDefault).not.toHaveBeenCalled();
        });

        it('still returns a retired row by id, marked retired, for callers checking an existing reference', async () => {
            templateRepository.findVisibleById.mockResolvedValue(retiredRow);

            await expect(
                service.getVisibleTemplateForUser('website', 'cal-template', 'user-1'),
            ).resolves.toEqual(
                expect.objectContaining({ id: 'cal-template', retiredReason: 'app_blueprint' }),
            );
        });

        it('marks a listed row as not retired', async () => {
            templateRepository.findVisibleById.mockResolvedValue(listedRow);

            await expect(
                service.getVisibleTemplateForUser('website', 'astro-blog-template', 'user-1'),
            ).resolves.toEqual(expect.objectContaining({ retiredReason: null }));
        });

        it('keeps answering a retired default as the default, since inheriting Works still resolve it', async () => {
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
                templateId: 'cal-template',
            });
            templateRepository.findVisibleById.mockResolvedValue(retiredRow);

            await expect(service.getDefaultTemplateIdForUser('website', 'user-7')).resolves.toBe(
                'cal-template',
            );
        });

        // FR-5 f. Review follow-up on PR #2511: the listing kept answering the
        // retired row as `defaultTemplateId` while leaving it out of
        // `templates`, so every "Default (…)" option named a template the
        // server would not apply to a new Work.
        describe('a retired saved default, for NEW selections (FR-5 f)', () => {
            const classicRow = {
                ...listedRow,
                id: 'classic',
                name: 'Classic',
                repositoryName: 'directory-web-template',
                metadata: {},
            };

            beforeEach(() => {
                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
                    templateId: 'cal-template',
                });
                templateRepository.findVisibleById.mockImplementation(
                    async (id: string) =>
                        [retiredRow, listedRow, classicRow].find((row) => row.id === id) ?? null,
                );
                templateRepository.findVisibleByKind.mockResolvedValue([
                    classicRow,
                    listedRow,
                    retiredRow,
                ]);
            });

            it('lists the system default as the default, never the unlisted retired row', async () => {
                const result = await service.listTemplatesForUser('website', 'user-7');

                expect(result.defaultTemplateId).toBe('classic');
                expect(result.templates.map((template) => template.id)).toContain(
                    result.defaultTemplateId,
                );
                expect(
                    result.templates
                        .filter((template) => template.isDefault)
                        .map((template) => template.id),
                ).toEqual(['classic']);
            });

            it('still lists a saved default that is not retired as the default', async () => {
                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
                    templateId: 'astro-blog-template',
                });

                const result = await service.listTemplatesForUser('website', 'user-7');

                expect(result.defaultTemplateId).toBe('astro-blog-template');
                expect(
                    result.templates
                        .filter((template) => template.isDefault)
                        .map((template) => template.id),
                ).toEqual(['astro-blog-template']);
            });

            it('returns the retired saved default, marked, for callers refusing a Work newly inheriting it', async () => {
                await expect(
                    service.getRetiredDefaultTemplateForUser('website', 'user-7'),
                ).resolves.toEqual(
                    expect.objectContaining({
                        id: 'cal-template',
                        repositoryOwner: 'ever-works',
                        repositoryName: 'cal-template',
                        retiredReason: 'app_blueprint',
                    }),
                );
            });

            it('returns no retired default when the saved default is listed, or there is none', async () => {
                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValueOnce({
                    templateId: 'astro-blog-template',
                });
                await expect(
                    service.getRetiredDefaultTemplateForUser('website', 'user-7'),
                ).resolves.toBeNull();

                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValueOnce(null);
                await expect(
                    service.getRetiredDefaultTemplateForUser('website', 'user-7'),
                ).resolves.toBeNull();
            });

            it.each([
                [undefined, 'classic'],
                ['default', 'classic'],
                ['directory', 'classic'],
                ['awesome-repo', 'classic'],
                ['website', 'web'],
                ['landing-page', 'web'],
                ['blog', 'web'],
            ])(
                'gives a new %s Work the template a user with no saved default gets (%s), to pin',
                async (workKind, expected) => {
                    await expect(
                        service.getWebsiteTemplateIdForNewWork('user-7', workKind),
                    ).resolves.toBe(expected);
                },
            );

            it('lets a new Work inherit (null) when the saved default is listed, or there is none', async () => {
                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValueOnce({
                    templateId: 'astro-blog-template',
                });
                await expect(
                    service.getWebsiteTemplateIdForNewWork('user-7', 'website'),
                ).resolves.toBeNull();

                userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValueOnce(null);
                await expect(
                    service.getWebsiteTemplateIdForNewWork('user-7', 'website'),
                ).resolves.toBeNull();
            });
        });
    });

    it('rejects updates for custom templates the user does not own', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue(null);

        await expect(
            service.updateCustomTemplateForUser(
                {
                    kind: 'website',
                    templateId: 'custom-1',
                },
                'user-1',
            ),
        ).rejects.toThrow(NotFoundException);
    });

    it('swallows startup seed errors during module init', async () => {
        const warnSpy = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);
        templateRepository.upsert.mockRejectedValue(new Error('db unavailable'));

        await expect(service.onModuleInit()).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                'Failed to seed built-in templates during startup: db unavailable',
            ),
        );
    });

    // APW-02 P0 (Wave 0 PR 0.2) — the fork request can now answer immediately, but nothing in P0
    // resolves a pending fork: `WorkUpstreamState` and the `app-fork-readiness` job are APW-02 P1
    // (T12/T24), and this epic's P0 gate ships no migration, job or route. So the create path must
    // keep the provider's blocking default (fork creation stays exactly as it behaves today) while
    // the capability itself is covered by the provider and facade specs. Whoever lands the
    // readiness poller flips the guard below deliberately.
    describe('forkTemplateForUser', () => {
        const builtInTemplate = {
            id: 'website-basic',
            kind: 'website',
            sourceType: 'built_in',
            isActive: true,
            name: 'Basic',
            description: null,
            framework: null,
            previewImageUrl: null,
            repositoryUrl: 'https://github.com/ever-works/basic-template',
            repositoryOwner: 'ever-works',
            repositoryName: 'basic-template',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            metadata: {},
        };

        beforeEach(() => {
            templateRepository.findVisibleById.mockResolvedValue(builtInTemplate);
            templateRepository.findOwnedCustomByRepositoryCoordinates.mockResolvedValue(null);
            templateRepository.upsert.mockImplementation(async (row: any) => row);
            gitFacade.getUser.mockResolvedValue({ login: 'acme-user' });
            gitFacade.getOrganizations.mockResolvedValue([]);
            gitFacade.getWebUrl.mockReturnValue('https://github.com/acme-user/basic-template');
        });

        /**
         * The App Works brief's steps 1 and 2, through the path that already
         * existed — see the note in `forkTemplateForUser` about the
         * `sourceType !== 'built_in'` refusal this replaces.
         */
        describe('any repository, not only the curated ones (App Works steps 1-2)', () => {
            const customTemplate = {
                ...builtInTemplate,
                id: 'custom-abc',
                sourceType: 'custom',
                name: 'Some OSS project',
                repositoryUrl: 'https://github.com/someone-else/their-app',
                repositoryOwner: 'someone-else',
                repositoryName: 'their-app',
            };

            it('forks a CUSTOM template — a repository added by URL — into the caller’s account', async () => {
                templateRepository.findVisibleById.mockResolvedValue(customTemplate);
                gitFacade.forkRepository.mockResolvedValue({
                    owner: 'acme-user',
                    name: 'their-app',
                    fullName: 'acme-user/their-app',
                    defaultBranch: 'main',
                    isPrivate: false,
                    url: 'https://github.com/acme-user/their-app',
                    cloneUrl: 'https://github.com/acme-user/their-app.git',
                    isFork: true,
                    forkReadiness: 'ready',
                });

                const result = await service.forkTemplateForUser(
                    { kind: 'website', templateId: 'custom-abc', targetOwner: 'acme-user' },
                    'user-1',
                );

                expect(gitFacade.forkRepository).toHaveBeenCalledWith(
                    'someone-else',
                    'their-app',
                    expect.objectContaining({ organization: undefined }),
                    { userId: 'user-1', providerId: 'github' },
                );
                expect(result.created).toBe(true);
                expect(result.repository.fullName).toBe('acme-user/their-app');
            });

            it('refuses only when the target ALREADY owns it — nothing to fork', async () => {
                // The brief says "fork it if it is not yours". If it IS yours,
                // the honest answer is not a fork; GitHub refuses to fork a
                // repository into the account that owns it.
                templateRepository.findVisibleById.mockResolvedValue({
                    ...customTemplate,
                    repositoryOwner: 'acme-user',
                });

                await expect(
                    service.forkTemplateForUser(
                        { kind: 'website', templateId: 'custom-abc', targetOwner: 'acme-user' },
                        'user-1',
                    ),
                ).rejects.toThrow(/nothing to fork/i);

                expect(gitFacade.forkRepository).not.toHaveBeenCalled();
            });

            it('still forks a BUILT-IN template whose owner happens to match the target', async () => {
                // The ownership refusal is scoped to `custom` on purpose: a
                // built-in template is curated under the catalog organisation,
                // and a member who happens to belong to that organisation must
                // still be able to fork it, which is what shipped before.
                templateRepository.findVisibleById.mockResolvedValue({
                    ...builtInTemplate,
                    repositoryOwner: 'acme-user',
                });
                gitFacade.forkRepository.mockResolvedValue({
                    owner: 'acme-user',
                    name: 'basic-template',
                    fullName: 'acme-user/basic-template',
                    defaultBranch: 'main',
                    isPrivate: false,
                    url: 'https://github.com/acme-user/basic-template',
                    cloneUrl: 'https://github.com/acme-user/basic-template.git',
                    isFork: true,
                    forkReadiness: 'ready',
                });

                await expect(
                    service.forkTemplateForUser(
                        { kind: 'website', templateId: 'website-basic', targetOwner: 'acme-user' },
                        'user-1',
                    ),
                ).resolves.toBeTruthy();
            });
        });

        it('does NOT ask for a non-blocking fork — P0 has no readiness poller to finish it', async () => {
            gitFacade.forkRepository.mockResolvedValue({
                owner: 'acme-user',
                name: 'basic-template',
                fullName: 'acme-user/basic-template',
                defaultBranch: 'main',
                isPrivate: false,
                url: 'https://github.com/acme-user/basic-template',
                cloneUrl: 'https://github.com/acme-user/basic-template.git',
                isFork: true,
                forkReadiness: 'ready',
            });

            const result = await service.forkTemplateForUser(
                { kind: 'website', templateId: 'website-basic', targetOwner: 'acme-user' },
                'user-1',
            );

            expect(gitFacade.forkRepository).toHaveBeenCalledWith(
                'ever-works',
                'basic-template',
                { organization: undefined },
                { userId: 'user-1', providerId: 'github' },
            );
            expect(result.created).toBe(true);
            expect(result.forkReadiness).toBe('ready');
            expect(result.repository.fullName).toBe('acme-user/basic-template');
        });

        it('reports ready for an existing fork resolved by the blocking path', async () => {
            gitFacade.forkRepository.mockResolvedValue({
                owner: 'acme-user',
                name: 'basic-template',
                fullName: 'acme-user/basic-template',
                defaultBranch: 'main',
                isPrivate: false,
                url: 'https://github.com/acme-user/basic-template',
                cloneUrl: 'https://github.com/acme-user/basic-template.git',
                isFork: true,
                forkReadiness: 'ready',
            });

            const result = await service.forkTemplateForUser(
                { kind: 'website', templateId: 'website-basic', targetOwner: 'acme-user' },
                'user-1',
            );

            // Already-forked is success, and the caller never had to wait on a second request.
            expect(gitFacade.forkRepository).toHaveBeenCalledTimes(1);
            expect(result.forkReadiness).toBe('ready');
        });

        it('passes the provider readiness through verbatim when a provider reports one', async () => {
            gitFacade.forkRepository.mockResolvedValue({
                owner: 'acme-user',
                name: 'basic-template',
                fullName: 'acme-user/basic-template',
                defaultBranch: 'main',
                isPrivate: false,
                url: 'https://github.com/acme-user/basic-template',
                cloneUrl: 'https://github.com/acme-user/basic-template.git',
                isFork: true,
                forkReadiness: 'pending',
            });

            const result = await service.forkTemplateForUser(
                { kind: 'website', templateId: 'website-basic', targetOwner: 'acme-user' },
                'user-1',
            );

            // The result type carries readiness so a future poller can act on it; this caller does
            // not manufacture a pending one.
            expect(result.forkReadiness).toBe('pending');
        });
    });
});
