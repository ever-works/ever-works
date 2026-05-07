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
        await this.repository.upsert(
            { userId, kind, templateId },
            { conflictPaths: ['userId', 'kind'] },
        );

        return this.repository.findOneOrFail({ where: { userId, kind } });
    }

    async deleteByUserKindAndTemplateId(
        userId: string,
        kind: TemplateKind,
        templateId: string,
    ): Promise<void> {
        await this.repository.delete({ userId, kind, templateId });
    }
}
