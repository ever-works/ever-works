import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DirectoryAdvancedPrompts } from '../../entities/directory-advanced-prompts.entity';

@Injectable()
export class DirectoryAdvancedPromptsRepository {
    constructor(
        @InjectRepository(DirectoryAdvancedPrompts)
        private readonly repository: Repository<DirectoryAdvancedPrompts>,
    ) {}

    async findByDirectoryId(directoryId: string): Promise<DirectoryAdvancedPrompts | null> {
        return this.repository.findOne({ where: { directoryId } });
    }

    async createOrUpdate(
        directoryId: string,
        data: Partial<
            Omit<DirectoryAdvancedPrompts, 'id' | 'directoryId' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<DirectoryAdvancedPrompts> {
        const existing = await this.findByDirectoryId(directoryId);

        if (existing) {
            await this.repository.update(existing.id, data);
            return this.findByDirectoryId(directoryId);
        }

        const entity = this.repository.create({ directoryId, ...data });
        return this.repository.save(entity);
    }

    async delete(directoryId: string): Promise<boolean> {
        const result = await this.repository.delete({ directoryId });
        return result.affected > 0;
    }
}
