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
import {
    getDefaultWebsiteTemplateId,
    listWebsiteTemplates,
    type WebsiteTemplateConfig,
} from '@src/generators/website-generator/config/website-template.config';
import { randomUUID } from 'node:crypto';
import type { TemplateKind, TemplateSourceType } from '@src/entities/template.entity';

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

@Injectable()
export class TemplateCatalogService implements OnModuleInit {
    private readonly logger = new Logger(TemplateCatalogService.name);

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
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

        return {
            id: created.id,
            kind: created.kind,
            sourceType: created.sourceType,
            name: created.name,
            description: created.description,
            framework: created.framework,
            previewImageUrl: created.previewImageUrl,
            repositoryUrl: created.repositoryUrl,
            repositoryOwner: created.repositoryOwner,
            repositoryName: created.repositoryName,
            branch: created.branch,
            syncBranches: created.syncBranches,
            betaBranch: created.betaBranch,
            isActive: created.isActive,
            isDefault: created.id === defaultTemplateId,
            ownerUserId: created.ownerUserId,
        };
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
}
