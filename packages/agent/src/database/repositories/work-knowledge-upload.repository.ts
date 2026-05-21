import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkKnowledgeUpload } from '../../entities/work-knowledge-upload.entity';
import { KbUploadExtractionStatus } from '../../entities/kb-types';

@Injectable()
export class WorkKnowledgeUploadRepository {
    constructor(
        @InjectRepository(WorkKnowledgeUpload)
        private readonly repository: Repository<WorkKnowledgeUpload>,
    ) {}

    async findById(workId: string, uploadId: string): Promise<WorkKnowledgeUpload | null> {
        return this.repository.findOne({ where: { id: uploadId, workId } });
    }

    async findBySha256(workId: string, sha256: string): Promise<WorkKnowledgeUpload | null> {
        return this.repository.findOne({ where: { workId, sha256 } });
    }

    async list(workId: string, status?: KbUploadExtractionStatus): Promise<WorkKnowledgeUpload[]> {
        return this.repository.find({
            where: status ? { workId, extractionStatus: status } : { workId },
            order: { createdAt: 'DESC' },
        });
    }

    async create(data: Partial<WorkKnowledgeUpload>): Promise<WorkKnowledgeUpload> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async update(
        uploadId: string,
        patch: Partial<WorkKnowledgeUpload>,
    ): Promise<WorkKnowledgeUpload | null> {
        await this.repository.update({ id: uploadId }, patch);
        return this.repository.findOne({ where: { id: uploadId } });
    }

    async delete(uploadId: string): Promise<boolean> {
        const result = await this.repository.delete({ id: uploadId });
        return (result.affected ?? 0) > 0;
    }
}
