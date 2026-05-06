import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserTemplatePreference } from '../../entities/user-template-preference.entity';
import type { TemplateKind } from '../../entities/template.entity';

@Injectable()
export class UserTemplatePreferenceRepository {
    constructor(
        @InjectRepository(UserTemplatePreference)
        private readonly repository: Repository<UserTemplatePreference>,
    ) {}

    async findByUserAndKind(
        userId: string,
        kind: TemplateKind,
    ): Promise<UserTemplatePreference | null> {
        return this.repository.findOne({ where: { userId, kind } });
    }

    async upsertDefault(
        userId: string,
        kind: TemplateKind,
        templateId: string,
    ): Promise<UserTemplatePreference> {
        const existing = await this.findByUserAndKind(userId, kind);

        if (existing) {
            await this.repository.update(existing.id, { templateId });
            return this.repository.findOneOrFail({ where: { id: existing.id } });
        }

        return this.repository.save(
            this.repository.create({
                userId,
                kind,
                templateId,
            }),
        );
    }

    async deleteByUserKindAndTemplateId(
        userId: string,
        kind: TemplateKind,
        templateId: string,
    ): Promise<void> {
        await this.repository.delete({ userId, kind, templateId });
    }
}
