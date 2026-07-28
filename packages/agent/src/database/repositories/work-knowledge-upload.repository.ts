import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
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

    /**
     * Global-Memory (organization-scoped) originals.
     *
     * EVERY query below pins `workId: IsNull()`, and that is load-bearing,
     * not defensive. `organizationId` on this table is a Tier C tenancy
     * column that `ScopeStampingSubscriber` stamps on every insert, so
     * Work-scoped rows carry the org id too. A plain
     * `where { organizationId, sha256 }` would therefore happily return a
     * row belonging to some Work — which for `findBySha256ForOrg` means a
     * Memory upload silently deduping against a Work's file and handing
     * the caller back an upload it does not own. `workId IS NULL` is the
     * scope discriminator (see the entity's JSDoc for why it is not an
     * XOR), so it is what these must filter on.
     */
    async findByIdForOrg(
        organizationId: string,
        uploadId: string,
    ): Promise<WorkKnowledgeUpload | null> {
        return this.repository.findOne({
            where: { id: uploadId, organizationId, workId: IsNull() },
        });
    }

    async findBySha256ForOrg(
        organizationId: string,
        sha256: string,
    ): Promise<WorkKnowledgeUpload | null> {
        return this.repository.findOne({
            where: { organizationId, sha256, workId: IsNull() },
        });
    }

    async listPagedForOrg(opts: {
        organizationId: string;
        status?: KbUploadExtractionStatus;
        limit?: number;
        offset?: number;
    }): Promise<{ items: WorkKnowledgeUpload[]; total: number }> {
        const qb = this.repository.createQueryBuilder('upload');
        qb.where('upload.organizationId = :organizationId', {
            organizationId: opts.organizationId,
        }).andWhere('upload.workId IS NULL');
        if (opts.status) {
            qb.andWhere('upload.extractionStatus = :status', { status: opts.status });
        }
        qb.orderBy('upload.createdAt', 'DESC');
        const total = await qb.getCount();
        if (opts.limit !== undefined) qb.take(opts.limit);
        if (opts.offset !== undefined) qb.skip(opts.offset);
        const items = await qb.getMany();
        return { items, total };
    }

    /**
     * EW-643 Phase 3 slice 2b — partial update by id. Used by the media
     * normalize service to persist `metadata.originalSha256` +
     * `metadata.normalizedStoragePath` after ffmpeg succeeds without
     * round-tripping every column the caller didn't touch.
     */
    async updateById(
        workId: string,
        uploadId: string,
        patch: Partial<WorkKnowledgeUpload>,
    ): Promise<void> {
        await this.repository.update({ id: uploadId, workId }, patch);
    }

    async list(workId: string, status?: KbUploadExtractionStatus): Promise<WorkKnowledgeUpload[]> {
        return this.repository.find({
            where: status ? { workId, extractionStatus: status } : { workId },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Paginated list — used by the EW-641 1B/b API surface so the UI
     * can scroll the upload history without pulling the whole table.
     * Existing `list(workId, status?)` is preserved for older callers
     * that just need an in-memory array.
     */
    async listPaged(opts: {
        workId: string;
        status?: KbUploadExtractionStatus;
        limit?: number;
        offset?: number;
    }): Promise<{ items: WorkKnowledgeUpload[]; total: number }> {
        const qb = this.repository.createQueryBuilder('upload');
        qb.where('upload.workId = :workId', { workId: opts.workId });
        if (opts.status) {
            qb.andWhere('upload.extractionStatus = :status', { status: opts.status });
        }
        qb.orderBy('upload.createdAt', 'DESC');
        const total = await qb.getCount();
        if (opts.limit !== undefined) qb.take(opts.limit);
        if (opts.offset !== undefined) qb.skip(opts.offset);
        const items = await qb.getMany();
        return { items, total };
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

    /**
     * EW-643 Phase 3 slice 4a — return uploads stuck in
     * `extractionStatus='running'` whose `extractionStartedAt` is older
     * than the given cutoff. Used by the daily reconcile sweep to flip
     * abandoned rows to `failed` so the workbench surfaces the dead
     * upload to the user instead of hanging forever.
     *
     * `workId` narrows the sweep to a single Work (cheaper for ad-hoc
     * operator runs); omitted = scan everything.
     */
    async findStaleRunning(opts: {
        olderThan: Date;
        workId?: string;
    }): Promise<WorkKnowledgeUpload[]> {
        const where: Record<string, unknown> = {
            extractionStatus: KbUploadExtractionStatus.RUNNING,
            extractionStartedAt: LessThan(opts.olderThan),
        };
        if (opts.workId) where.workId = opts.workId;
        return this.repository.find({ where });
    }

    /**
     * EW-643 Phase 3 slice 4a — flat list of every upload's storagePath
     * (plus `metadata.normalizedStoragePath` when set) for the given
     * `workId`, or for ALL works when `workId` is omitted. The reconcile
     * sweep uses this to cross-reference against the storage listing
     * and detect orphan objects whose row was deleted out of band.
     *
     * Returns only the two columns it needs so we don't materialize the
     * whole `metadata` blob per row across the entire table.
     */
    async listStoragePaths(workId?: string): Promise<
        Array<{
            id: string;
            workId: string;
            storagePath: string;
            normalizedStoragePath: string | null;
        }>
    > {
        const qb = this.repository.createQueryBuilder('upload');
        qb.select(['upload.id', 'upload.workId', 'upload.storagePath', 'upload.metadata']);
        if (workId) qb.where('upload.workId = :workId', { workId });
        const rows = await qb.getMany();
        return rows.map((r) => ({
            id: r.id,
            workId: r.workId,
            storagePath: r.storagePath,
            normalizedStoragePath:
                ((r.metadata as Record<string, unknown> | null | undefined)?.[
                    'normalizedStoragePath'
                ] as string | null | undefined) ?? null,
        }));
    }
}
