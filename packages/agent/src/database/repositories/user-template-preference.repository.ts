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

    /**
     * Every user whose default template for `kind` is `templateId`. The
     * `(userId, kind)` unique index means each user appears at most once.
     *
     * No production caller: website-template discovery used this to count the
     * Works inheriting an App Blueprint's row before deactivating it, and now
     * RETIRES the row instead (templates-catalog FR-5 c), which needs no count.
     */
    async findUserIdsByKindAndTemplateId(
        kind: TemplateKind,
        templateId: string,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            where: { kind, templateId },
            select: { userId: true },
        });
        return rows.map((row) => row.userId);
    }

    async deleteByUserKindAndTemplateId(
        userId: string,
        kind: TemplateKind,
        templateId: string,
    ): Promise<void> {
        await this.repository.delete({ userId, kind, templateId });
    }
}
