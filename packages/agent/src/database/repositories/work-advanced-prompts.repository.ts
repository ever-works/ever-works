import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkAdvancedPrompts } from '../../entities/work-advanced-prompts.entity';

@Injectable()
export class WorkAdvancedPromptsRepository {
    constructor(
        @InjectRepository(WorkAdvancedPrompts)
        private readonly repository: Repository<WorkAdvancedPrompts>,
    ) {}

    async findByWorkId(workId: string): Promise<WorkAdvancedPrompts | null> {
        return this.repository.findOne({ where: { workId } });
    }

    async createOrUpdate(
        workId: string,
        data: Partial<
            Omit<WorkAdvancedPrompts, 'id' | 'workId' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<WorkAdvancedPrompts> {
        const existing = await this.findByWorkId(workId);

        if (existing) {
            await this.repository.update(existing.id, data);
            return this.findByWorkId(workId);
        }

        const entity = this.repository.create({ workId, ...data });
        return this.repository.save(entity);
    }

    async delete(workId: string): Promise<boolean> {
        const result = await this.repository.delete({ workId });
        return result.affected > 0;
    }
}
