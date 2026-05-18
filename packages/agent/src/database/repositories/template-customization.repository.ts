import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    TemplateCustomization,
    TemplateCustomizationStatus,
} from '../../entities/template-customization.entity';

export type CreateTemplateCustomizationInput = Pick<
    TemplateCustomization,
    'templateId' | 'userId' | 'baseTemplateId' | 'prompt'
> & {
    providerId?: string | null;
    aiProviderId?: string | null;
    status?: TemplateCustomizationStatus;
};

export type UpdateTemplateCustomizationPatch = Partial<
    Pick<
        TemplateCustomization,
        | 'status'
        | 'branch'
        | 'commitSha'
        | 'errorMessage'
        | 'providerId'
        | 'startedAt'
        | 'completedAt'
    >
>;

@Injectable()
export class TemplateCustomizationRepository {
    constructor(
        @InjectRepository(TemplateCustomization)
        private readonly repository: Repository<TemplateCustomization>,
    ) {}

    async create(input: CreateTemplateCustomizationInput): Promise<TemplateCustomization> {
        const entity = this.repository.create({
            templateId: input.templateId,
            userId: input.userId,
            baseTemplateId: input.baseTemplateId,
            prompt: input.prompt,
            providerId: input.providerId ?? null,
            aiProviderId: input.aiProviderId ?? null,
            status: input.status ?? TemplateCustomizationStatus.PENDING,
        });
        return this.repository.save(entity);
    }

    async updateById(
        id: string,
        patch: UpdateTemplateCustomizationPatch,
    ): Promise<TemplateCustomization | null> {
        await this.repository.update({ id }, patch);
        return this.findById(id);
    }

    findById(id: string): Promise<TemplateCustomization | null> {
        return this.repository.findOne({ where: { id } });
    }

    findByIdForUser(id: string, userId: string): Promise<TemplateCustomization | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    listForTemplate(
        templateId: string,
        userId: string,
        limit = 20,
    ): Promise<TemplateCustomization[]> {
        return this.repository.find({
            where: { templateId, userId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }
}
