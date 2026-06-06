import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository, Raw } from 'typeorm';
import { Template, TemplateKind } from '../../entities/template.entity';

@Injectable()
export class TemplateRepository {
    constructor(
        @InjectRepository(Template)
        private readonly repository: Repository<Template>,
    ) {}

    async findById(id: string): Promise<Template | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findVisibleByKind(kind: TemplateKind, userId: string): Promise<Template[]> {
        return this.repository.find({
            where: [
                { kind, sourceType: 'built_in', isActive: true },
                { kind, ownerUserId: userId, sourceType: 'custom', isActive: true },
            ],
            order: {
                sourceType: 'DESC',
                name: 'ASC',
            },
        });
    }

    async findVisibleById(id: string, userId: string): Promise<Template | null> {
        return this.repository.findOne({
            where: [
                { id, sourceType: 'built_in', isActive: true },
                { id, ownerUserId: userId, sourceType: 'custom', isActive: true },
            ],
        });
    }

    async findOwnedCustomById(id: string, userId: string): Promise<Template | null> {
        return this.repository.findOne({
            where: {
                id,
                ownerUserId: userId,
                sourceType: 'custom',
            },
        });
    }

    async findOwnedCustomByRepositoryUrl(
        kind: TemplateKind,
        userId: string,
        repositoryUrl: string,
    ): Promise<Template | null> {
        return this.repository.findOne({
            where: {
                kind,
                ownerUserId: userId,
                sourceType: 'custom',
                isActive: true,
                repositoryUrl,
            },
        });
    }

    async findOwnedCustomByRepositoryCoordinates(
        kind: TemplateKind,
        userId: string,
        repositoryOwner: string,
        repositoryName: string,
    ): Promise<Template | null> {
        return this.repository.findOne({
            where: {
                kind,
                ownerUserId: userId,
                sourceType: 'custom',
                isActive: true,
                repositoryOwner,
                repositoryName,
            },
        });
    }

    async findBuiltInByRepositoryCoordinates(
        kind: TemplateKind,
        repositoryOwner: string,
        repositoryName: string,
    ): Promise<Template | null> {
        return this.repository.findOne({
            where: {
                kind,
                sourceType: 'built_in',
                repositoryOwner,
                repositoryName,
            },
            order: {
                id: 'ASC',
            },
        });
    }

    async findAllBuiltInByRepositoryCoordinates(
        kind: TemplateKind,
        repositoryOwner: string,
        repositoryName: string,
    ): Promise<Template[]> {
        return this.repository.find({
            where: {
                kind,
                sourceType: 'built_in',
                repositoryOwner,
                repositoryName,
            },
            order: {
                id: 'ASC',
            },
        });
    }

    async hasRecentDiscoveredBuiltInTemplates(
        kind: TemplateKind,
        catalogOwner: string,
        updatedSince: Date,
    ): Promise<boolean> {
        // Security: `catalogOwner` is embedded into a LIKE pattern bind value. Even
        // though it travels as a parameter (no raw SQL injection), unescaped LIKE
        // metacharacters (`%`, `_`, `\`) would let a tainted/misconfigured owner value
        // match unintended metadata rows and silently suppress the discovery-freshness
        // gate. Escape them and pin the escape char so only an exact owner string
        // matches. For normal org names (no metacharacters) the pattern is unchanged.
        const escapedOwner = catalogOwner
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');
        return this.repository.exists({
            where: {
                kind,
                sourceType: 'built_in',
                isActive: true,
                updatedAt: MoreThanOrEqual(updatedSince),
                metadata: Raw((alias) => `${alias} LIKE :ownerMarker ESCAPE '\\'`, {
                    ownerMarker: `%"discoveredFromOrganization":"${escapedOwner}"%`,
                }),
            },
        });
    }

    async upsert(template: Partial<Template> & { id: string }): Promise<Template> {
        await this.repository.upsert(template, { conflictPaths: ['id'] });
        return this.repository.findOneOrFail({ where: { id: template.id } });
    }

    async updateById(id: string, template: Partial<Template>): Promise<Template> {
        await this.repository.update(id, template);
        return this.repository.findOneOrFail({ where: { id } });
    }
}
