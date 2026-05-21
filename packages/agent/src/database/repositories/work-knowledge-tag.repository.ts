import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkKnowledgeTag } from '../../entities/work-knowledge-tag.entity';

@Injectable()
export class WorkKnowledgeTagRepository {
    constructor(
        @InjectRepository(WorkKnowledgeTag)
        private readonly repository: Repository<WorkKnowledgeTag>,
    ) {}

    async list(workId: string): Promise<WorkKnowledgeTag[]> {
        return this.repository.find({ where: { workId }, order: { slug: 'ASC' } });
    }

    async findBySlug(workId: string, slug: string): Promise<WorkKnowledgeTag | null> {
        return this.repository.findOne({ where: { workId, slug } });
    }

    async findById(workId: string, tagId: string): Promise<WorkKnowledgeTag | null> {
        return this.repository.findOne({ where: { workId, id: tagId } });
    }

    async create(data: Partial<WorkKnowledgeTag>): Promise<WorkKnowledgeTag> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    /**
     * Create-on-first-use: if the slug already exists for this Work,
     * return the existing row instead of throwing. Used by the
     * inline-tag-create-from-autocomplete flow.
     */
    async upsertBySlug(workId: string, slug: string, name: string): Promise<WorkKnowledgeTag> {
        const existing = await this.findBySlug(workId, slug);
        if (existing) {
            return existing;
        }
        return this.create({ workId, slug, name });
    }

    async update(
        tagId: string,
        patch: Partial<WorkKnowledgeTag>,
    ): Promise<WorkKnowledgeTag | null> {
        await this.repository.update({ id: tagId }, patch);
        return this.repository.findOne({ where: { id: tagId } });
    }

    async delete(tagId: string): Promise<boolean> {
        const result = await this.repository.delete({ id: tagId });
        return (result.affected ?? 0) > 0;
    }
}
