import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SkillFile } from '../../entities/skill-file.entity';

/**
 * Skills feature — companion files. Custom repository for
 * `skill_files`. Every read is ownership-scoped (`userId` in the
 * WHERE clause) so the service can 404 instead of leaking existence —
 * mirrors `skill.repository.ts`.
 */
@Injectable()
export class SkillFileRepository {
    constructor(
        @InjectRepository(SkillFile)
        private readonly repository: Repository<SkillFile>,
    ) {}

    async findByIdAndUser(id: string, userId: string): Promise<SkillFile | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findBySkillId(skillId: string, userId: string): Promise<SkillFile[]> {
        return this.repository.find({
            where: { skillId, userId },
            order: { filename: 'ASC' },
        });
    }

    async findBySkillAndFilename(
        skillId: string,
        filename: string,
        userId: string,
    ): Promise<SkillFile | null> {
        return this.repository.findOne({ where: { skillId, filename, userId } });
    }

    /** Batch lookup for the prompt-manifest path — one query for N skills. */
    async findBySkillIds(skillIds: string[], userId: string): Promise<SkillFile[]> {
        if (skillIds.length === 0) return [];
        return this.repository.find({
            where: { skillId: In(skillIds), userId },
            order: { filename: 'ASC' },
        });
    }

    async countBySkillId(skillId: string, userId: string): Promise<number> {
        return this.repository.count({ where: { skillId, userId } });
    }

    async create(data: Partial<SkillFile>): Promise<SkillFile> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    // Security: ownership-scoped delete — `userId` is enforced in the WHERE
    // clause so a miscounted service-layer guard cannot delete another
    // user's file row (cross-user IDOR). Mirrors skill.repository.ts.
    async deleteByIdAndUser(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }
}
