import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
                repositoryUrl,
            },
        });
    }

    async upsert(template: Partial<Template> & { id: string }): Promise<Template> {
        const existing = await this.findById(template.id);

        if (existing) {
            await this.repository.update(existing.id, template);
            return this.repository.findOneOrFail({ where: { id: existing.id } });
        }

        return this.repository.save(this.repository.create(template));
    }
}
