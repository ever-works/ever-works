import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Skill, type SkillOwnerType } from '../../entities/skill.entity';

export interface ListSkillsFilter {
    ownerType?: SkillOwnerType;
    ownerId?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

/**
 * Skills feature — Phase 8.4 (`features/skills/plan.md §2`).
 *
 * Custom repository for `skills`. Owns CRUD + slug uniqueness +
 * scope-aware lookups. Cross-user reads route through
 * `findByIdAndUser` so the service can 404 instead of leaking
 * existence.
 */
@Injectable()
export class SkillRepository {
    constructor(
        @InjectRepository(Skill)
        private readonly repository: Repository<Skill>,
    ) {}

    async findById(id: string): Promise<Skill | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<Skill | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByOwnerSlug(
        ownerType: SkillOwnerType,
        ownerId: string,
        slug: string,
    ): Promise<Skill | null> {
        return this.repository.findOne({ where: { ownerType, ownerId, slug } });
    }

    async findByUserIdFiltered(
        userId: string,
        filter: ListSkillsFilter = {},
    ): Promise<{ rows: Skill[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('skill')
            .where('skill.userId = :userId', { userId });

        if (filter.ownerType)
            qb.andWhere('skill.ownerType = :ownerType', { ownerType: filter.ownerType });
        if (filter.ownerId) qb.andWhere('skill.ownerId = :ownerId', { ownerId: filter.ownerId });
        if (filter.search) {
            qb.andWhere(
                '(skill.title LIKE :q OR skill.slug LIKE :q OR skill.description LIKE :q)',
                { q: `%${filter.search}%` },
            );
        }

        const total = await qb.getCount();
        qb.orderBy('skill.updatedAt', 'DESC')
            .take(filter.limit ?? 50)
            .skip(filter.offset ?? 0);
        const rows = await qb.getMany();
        return { rows, total };
    }

    async findManyByIds(userId: string, ids: string[]): Promise<Skill[]> {
        if (ids.length === 0) return [];
        return this.repository
            .createQueryBuilder('skill')
            .where('skill.userId = :userId', { userId })
            .andWhere('skill.id IN (:...ids)', { ids })
            .getMany();
    }

    async create(data: Partial<Skill>): Promise<Skill> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async updateById(id: string, data: Partial<Skill>): Promise<void> {
        await this.repository.update(id, data);
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete(id);
    }
}
