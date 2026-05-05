import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import { UserTemplatePreferenceRepository } from '@src/database/repositories/user-template-preference.repository';
import { GitFacadeService } from '@src/facades/git.facade';
import {
    getDefaultWebsiteTemplateId,
    listWebsiteTemplates,
    type WebsiteTemplateConfig,
} from '@src/generators/website-generator/config/website-template.config';
import { randomUUID } from 'node:crypto';
import type { TemplateKind, TemplateSourceType } from '@src/entities/template.entity';
import { config } from '@src/config';

export interface TemplateCatalogItem {
    id: string;
    kind: TemplateKind;
    sourceType: TemplateSourceType;
    name: string;
    description?: string | null;
    framework?: string | null;
    previewImageUrl?: string | null;
    repositoryUrl?: string | null;
    repositoryOwner: string;
    repositoryName: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
    isActive: boolean;
    isDefault: boolean;
    ownerUserId?: string | null;
}

export interface ForkTemplateResult {
    defaultTemplateId: string;
    template: TemplateCatalogItem;
    repository: {
        owner: string;
        name: string;
        fullName: string;
        url: string;
    };
    created: boolean;
}

@Injectable()
export class TemplateCatalogService implements OnModuleInit {
    private readonly logger = new Logger(TemplateCatalogService.name);

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async onModuleInit() {
        await this.seedBuiltInTemplates();
    }

    async seedBuiltInTemplates(): Promise<void> {
        const builtInTemplates = listWebsiteTemplates().map((template) =>
            this.toBuiltInWebsiteTemplateRecord(template),
        );

        await Promise.all(
            builtInTemplates.map((template) => this.templateRepository.upsert(template)),
        );

        this.logger.debug(`Ensured ${builtInTemplates.length} built-in templates are present`);
    }

    async listTemplatesForUser(
        kind: TemplateKind,
        userId: string,
    ): Promise<{ defaultTemplateId: string | null; templates: TemplateCatalogItem[] }> {
        if (kind === 'website') {
            await this.syncDiscoveredWebsiteTemplatesForUser(userId);
        }

        const [templates, defaultTemplateId] = await Promise.all([
            this.templateRepository.findVisibleByKind(kind, userId),
            this.getDefaultTemplateIdForUser(kind, userId),
        ]);

        return {
            defaultTemplateId,
            templates: templates.map((template) => ({
                id: template.id,
                kind: template.kind,
                sourceType: template.sourceType,
                name: template.name,
                description: template.description,
                framework: template.framework,
                previewImageUrl: template.previewImageUrl,
                repositoryUrl: template.repositoryUrl,
                repositoryOwner: template.repositoryOwner,
                repositoryName: template.repositoryName,
                branch: template.branch,
                syncBranches: template.syncBranches,
                betaBranch: template.betaBranch,
                isActive: template.isActive,
                isDefault: template.id === defaultTemplateId,
                ownerUserId: template.ownerUserId,
            })),
        };
    }

    async addCustomTemplate(
        input: {
            kind: TemplateKind;
            repositoryUrl: string;
            name?: string;
            description?: string;
            framework?: string;
            previewImageUrl?: string;
            branch?: string;
            betaBranch?: string | null;
            syncBranches?: string[];
        },
        userId: string,
    ): Promise<TemplateCatalogItem> {
        const repository = this.parseGitHubRepository(input.repositoryUrl);
        if (!repository) {
            throw new BadRequestException({
                status: 'error',
                message: 'Only valid GitHub repository URLs are supported for custom templates.',
            });
        }

        const existing = await this.templateRepository.findOwnedCustomByRepositoryUrl(
            input.kind,
            userId,
            repository.canonicalUrl,
        );
        if (existing) {
            throw new ConflictException({
                status: 'error',
                message: 'You already added this template repository.',
            });
        }

        const created = await this.templateRepository.upsert({
            id: `custom-${randomUUID()}`,
            kind: input.kind,
            sourceType: 'custom',
            ownerUserId: userId,
            name: input.name?.trim() || this.humanizeRepositoryName(repository.repo),
            description: input.description?.trim() || null,
            framework:
                input.framework?.trim() || this.inferFrameworkFromRepository(repository.repo),
            previewImageUrl: input.previewImageUrl?.trim() || null,
            repositoryUrl: repository.canonicalUrl,
            repositoryOwner: repository.owner,
            repositoryName: repository.repo,
            branch: input.branch?.trim() || 'main',
            syncBranches: input.syncBranches?.length ? input.syncBranches : ['main'],
            betaBranch: input.betaBranch?.trim() || null,
            isActive: true,
            metadata: {},
        });

        const defaultTemplateId = await this.getDefaultTemplateIdForUser(input.kind, userId);

        return this.toCatalogItem(created, defaultTemplateId);
    }

    async setDefaultTemplateForUser(
        kind: TemplateKind,
        templateId: string,
        userId: string,
    ): Promise<{ defaultTemplateId: string }> {
        const template = await this.templateRepository.findVisibleById(templateId, userId);
        if (!template || template.kind !== kind) {
            throw new NotFoundException({
                status: 'error',
                message: 'Template not found for this user and kind.',
            });
        }

        await this.userTemplatePreferenceRepository.upsertDefault(userId, kind, template.id);

        return { defaultTemplateId: template.id };
    }

    async forkTemplateForUser(
        input: {
            kind: TemplateKind;
            templateId: string;
            targetOwner: string;
        },
        userId: string,
    ): Promise<ForkTemplateResult> {
        const template = await this.templateRepository.findVisibleById(input.templateId, userId);
        if (!template || template.kind !== input.kind) {
            throw new NotFoundException({
                status: 'error',
                message: 'Template not found for this user and kind.',
            });
        }

        if (template.sourceType !== 'built_in') {
            throw new BadRequestException({
                status: 'error',
                message: 'Only standard templates can be forked.',
            });
        }

        const providerId = 'github';
        const targetOwner = input.targetOwner.trim();
        if (!targetOwner) {
            throw new BadRequestException({
                status: 'error',
                message: 'A target account or organization is required.',
            });
        }

        const [gitUser, organizations] = await Promise.all([
            this.gitFacade.getUser({ userId, providerId }),
            this.gitFacade.getOrganizations({ userId, providerId }),
        ]);

        const isPersonalTarget = gitUser.login.toLowerCase() === targetOwner.toLowerCase();
        const organization = organizations.find(
            (org) => org.login.toLowerCase() === targetOwner.toLowerCase(),
        );

        if (!isPersonalTarget && !organization) {
            throw new BadRequestException({
                status: 'error',
                message: 'The selected fork target is not available for this GitHub connection.',
            });
        }

        const existingTemplate =
            await this.templateRepository.findOwnedCustomByRepositoryCoordinates(
                input.kind,
                userId,
                targetOwner,
                template.repositoryName,
            );

        if (existingTemplate) {
            await this.userTemplatePreferenceRepository.upsertDefault(
                userId,
                input.kind,
                existingTemplate.id,
            );

            return {
                defaultTemplateId: existingTemplate.id,
                template: this.toCatalogItem(existingTemplate, existingTemplate.id),
                repository: {
                    owner: existingTemplate.repositoryOwner,
                    name: existingTemplate.repositoryName,
                    fullName: `${existingTemplate.repositoryOwner}/${existingTemplate.repositoryName}`,
                    url:
                        existingTemplate.repositoryUrl ||
                        this.gitFacade.getWebUrl(
                            providerId,
                            existingTemplate.repositoryOwner,
                            existingTemplate.repositoryName,
                        ),
                },
                created: false,
            };
        }

        const forkedRepository = await this.gitFacade.forkRepository(
            template.repositoryOwner,
            template.repositoryName,
            {
                organization: isPersonalTarget ? undefined : organization?.login,
            },
            { userId, providerId },
        );

        if (!forkedRepository) {
            throw new BadRequestException({
                status: 'error',
                message: 'Forking the selected template failed.',
            });
        }

        const createdTemplate = await this.templateRepository.upsert({
            id: `custom-${randomUUID()}`,
            kind: input.kind,
            sourceType: 'custom',
            ownerUserId: userId,
            name: template.name,
            description: template.description || null,
            framework: template.framework || null,
            previewImageUrl: template.previewImageUrl || null,
            repositoryUrl:
                forkedRepository.url ||
                this.gitFacade.getWebUrl(providerId, forkedRepository.owner, forkedRepository.name),
            repositoryOwner: forkedRepository.owner,
            repositoryName: forkedRepository.name,
            branch: forkedRepository.defaultBranch || template.branch,
            syncBranches:
                template.syncBranches.length > 0
                    ? template.syncBranches
                    : [forkedRepository.defaultBranch || template.branch],
            betaBranch: template.betaBranch || null,
            isActive: true,
            metadata: {
                forkedFromTemplateId: template.id,
                forkedFromRepositoryUrl: template.repositoryUrl,
                forkedFromOwner: template.repositoryOwner,
                forkedFromRepositoryName: template.repositoryName,
                forkTargetType: isPersonalTarget ? 'personal' : 'organization',
            },
        });

        await this.userTemplatePreferenceRepository.upsertDefault(
            userId,
            input.kind,
            createdTemplate.id,
        );

        return {
            defaultTemplateId: createdTemplate.id,
            template: this.toCatalogItem(createdTemplate, createdTemplate.id),
            repository: {
                owner: forkedRepository.owner,
                name: forkedRepository.name,
                fullName: forkedRepository.fullName,
                url:
                    forkedRepository.url ||
                    this.gitFacade.getWebUrl(
                        providerId,
                        forkedRepository.owner,
                        forkedRepository.name,
                    ),
            },
            created: true,
        };
    }

    async getVisibleTemplateForUser(
        kind: TemplateKind,
        templateId: string,
        userId: string,
    ): Promise<TemplateCatalogItem | null> {
        const template = await this.templateRepository.findVisibleById(templateId, userId);
        if (!template || template.kind !== kind) {
            return null;
        }

        const defaultTemplateId = await this.getDefaultTemplateIdForUser(kind, userId);

        return this.toCatalogItem(template, defaultTemplateId);
    }

    async getDefaultTemplateIdForUser(kind: TemplateKind, userId: string): Promise<string | null> {
        const preference = await this.userTemplatePreferenceRepository.findByUserAndKind(
            userId,
            kind,
        );

        if (preference) {
            const visibleTemplate = await this.templateRepository.findVisibleById(
                preference.templateId,
                userId,
            );
            if (visibleTemplate && visibleTemplate.kind === kind) {
                return visibleTemplate.id;
            }
        }

        if (kind === 'website') {
            return getDefaultWebsiteTemplateId();
        }

        return null;
    }

    private async syncDiscoveredWebsiteTemplatesForUser(userId: string): Promise<void> {
        const providerId = 'github';
        const catalogOwner = config.websiteTemplate.getCatalogOrganization();

        try {
            const hasCredentials = await this.gitFacade.hasValidCredentials({
                userId,
                providerId,
            });

            if (!hasCredentials) {
                return;
            }

            const repositories = await this.gitFacade.listRepositories(
                { userId, providerId },
                1,
                100,
                {
                    owner: catalogOwner,
                    type: 'org',
                },
            );

            const standardTemplates = repositories.filter((repository) =>
                this.isStandardTemplateRepository(repository.name),
            );

            await Promise.all(
                standardTemplates.map((repository) =>
                    this.templateRepository.upsert({
                        id: repository.name.toLowerCase(),
                        kind: 'website',
                        sourceType: 'built_in',
                        name: this.humanizeRepositoryName(repository.name),
                        description: repository.description || null,
                        framework: this.inferFrameworkFromRepository(repository.name),
                        repositoryUrl: repository.url,
                        repositoryOwner: repository.owner,
                        repositoryName: repository.name,
                        branch: repository.defaultBranch || 'main',
                        syncBranches: [repository.defaultBranch || 'main'],
                        betaBranch: null,
                        isActive: true,
                        metadata: {
                            discoveredFromOrganization: catalogOwner,
                            fullName: repository.fullName,
                        },
                    }),
                ),
            );
        } catch (error) {
            this.logger.warn(
                `Failed to sync discovered website templates for user ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private toBuiltInWebsiteTemplateRecord(template: WebsiteTemplateConfig) {
        return {
            id: template.id,
            kind: 'website' as const,
            sourceType: 'built_in' as const,
            name: template.name,
            description: template.description,
            framework: this.inferFramework(template),
            repositoryOwner: template.owner,
            repositoryName: template.repo,
            repositoryUrl: `https://github.com/${template.owner}/${template.repo}`,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: true,
            metadata: {},
        };
    }

    private toCatalogItem(
        template: {
            id: string;
            kind: TemplateKind;
            sourceType: TemplateSourceType;
            name: string;
            description?: string | null;
            framework?: string | null;
            previewImageUrl?: string | null;
            repositoryUrl?: string | null;
            repositoryOwner: string;
            repositoryName: string;
            branch: string;
            syncBranches: string[];
            betaBranch?: string | null;
            isActive: boolean;
            ownerUserId?: string | null;
        },
        defaultTemplateId: string | null,
    ): TemplateCatalogItem {
        return {
            id: template.id,
            kind: template.kind,
            sourceType: template.sourceType,
            name: template.name,
            description: template.description,
            framework: template.framework,
            previewImageUrl: template.previewImageUrl,
            repositoryUrl: template.repositoryUrl,
            repositoryOwner: template.repositoryOwner,
            repositoryName: template.repositoryName,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: template.isActive,
            isDefault: template.id === defaultTemplateId,
            ownerUserId: template.ownerUserId,
        };
    }

    private inferFramework(template: WebsiteTemplateConfig): string | null {
        const normalizedName = `${template.name} ${template.repo}`.toLowerCase();

        if (normalizedName.includes('astro')) {
            return 'Astro';
        }

        if (normalizedName.includes('next')) {
            return 'Next.js';
        }

        return null;
    }

    private inferFrameworkFromRepository(repo: string): string | null {
        const normalizedRepo = repo.toLowerCase();

        if (normalizedRepo.includes('astro')) {
            return 'Astro';
        }

        if (normalizedRepo.includes('next')) {
            return 'Next.js';
        }

        return null;
    }

    private humanizeRepositoryName(repo: string): string {
        return repo
            .split(/[-_]+/g)
            .filter(Boolean)
            .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join(' ');
    }

    private parseGitHubRepository(
        input: string,
    ): { owner: string; repo: string; canonicalUrl: string } | null {
        try {
            const url = new URL(input);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') {
                return null;
            }

            if (url.hostname.toLowerCase() !== 'github.com') {
                return null;
            }

            const segments = url.pathname
                .replace(/\.git$/, '')
                .split('/')
                .filter(Boolean);

            if (segments.length < 2) {
                return null;
            }

            const owner = segments[0].toLowerCase();
            const repo = segments[1].toLowerCase();

            return {
                owner,
                repo,
                canonicalUrl: `https://github.com/${owner}/${repo}`,
            };
        } catch {
            return null;
        }
    }

    private isStandardTemplateRepository(repo: string): boolean {
        return /template$/i.test(repo.trim());
    }
}
