import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserUpload } from '../../entities/user-upload.entity';
import { ownershipWhereWith, type OwnershipScope } from '../ownership-scope';

export interface RecordUploadInput {
    userId?: string | null;
    sha256: string;
    workId?: string | null;
    missionId?: string | null;
    ideaId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
    storageProvider: string;
    storagePath: string;
    originalFilename?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
}

/**
 * Ownership / metadata index for files uploaded via
 * `POST /api/uploads/{file,image}`. The bytes live in the Storage plugin; this
 * row records WHO owns the upload (`userId`, NULL = anonymous) and what scope it
 * is optionally associated with, keyed by `sha256` (the upload id clients see).
 */
@Injectable()
export class UserUploadRepository {
    constructor(
        @InjectRepository(UserUpload)
        private readonly repo: Repository<UserUpload>,
    ) {}

    /**
     * Insert the upload-ownership record, deduped within the exact persisted
     * ownership scope. Organization uploads never collapse into another
     * Organization merely because their bytes (and therefore sha256) match.
     * Personal scope deliberately includes legacy null/null rows through the
     * centralized ownership predicate.
     */
    async record(input: RecordUploadInput): Promise<UserUpload> {
        const scope: OwnershipScope = {
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
        };
        const userId = input.userId ?? null;
        const existing = await this.repo.findOne({
            where:
                userId === null
                    ? {
                          userId: null,
                          sha256: input.sha256,
                          tenantId: scope.tenantId,
                          organizationId: scope.organizationId,
                      }
                    : ownershipWhereWith<UserUpload>(userId, scope, {
                          sha256: input.sha256,
                      }),
        });
        if (existing) return existing;
        const entity = this.repo.create(input);
        return this.repo.save(entity);
    }

    /** An upload with this `sha256` owned by `userId`, else null. */
    async findOwnedByUser(
        sha256: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<UserUpload | null> {
        return this.repo.findOne({
            where: ownershipWhereWith<UserUpload>(userId, scope, { sha256 }),
        });
    }

    // ─── Memory Files (folder membership) ────────────────────────────────

    /** The upload row by primary id, owned by `userId`, else null (⇒ 404). */
    async findByIdOwned(id: string, userId: string): Promise<UserUpload | null> {
        return this.repo.findOne({ where: { id, userId } });
    }

    /**
     * The caller's uploads for the /memory Files list. `folderId` filters
     * folder membership (`null` = unfiled/root); leave it `undefined` for
     * no folder filter (search mode). `q` matches the original filename,
     * case-insensitively via LOWER() so it behaves the same on postgres
     * and better-sqlite3.
     */
    async listForMemoryFiles(opts: {
        userId: string;
        folderId?: string | null;
        q?: string;
        limit?: number;
    }): Promise<UserUpload[]> {
        const qb = this.repo.createQueryBuilder('upload');
        qb.where('upload.userId = :userId', { userId: opts.userId });
        if (opts.folderId !== undefined) {
            if (opts.folderId === null) {
                qb.andWhere('upload.folderId IS NULL');
            } else {
                qb.andWhere('upload.folderId = :folderId', { folderId: opts.folderId });
            }
        }
        if (opts.q) {
            qb.andWhere('LOWER(upload.originalFilename) LIKE :q', {
                q: `%${opts.q.toLowerCase()}%`,
            });
        }
        qb.orderBy('upload.updatedAt', 'DESC');
        if (opts.limit !== undefined) qb.take(opts.limit);
        return qb.getMany();
    }

    /** Move one owned upload into a folder (or to the root with `null`). */
    async setFolder(userId: string, id: string, folderId: string | null): Promise<boolean> {
        const result = await this.repo.update({ id, userId }, { folderId });
        return (result.affected ?? 0) > 0;
    }

    /** File a just-created upload (looked up by content hash) into a folder. */
    async setFolderBySha256(
        userId: string,
        sha256: string,
        folderId: string | null,
    ): Promise<boolean> {
        const result = await this.repo.update({ userId, sha256 }, { folderId });
        return (result.affected ?? 0) > 0;
    }

    /** Per-folder file counts, for the Files tree. Missing id = zero. */
    async countByFolderIds(userId: string, folderIds: string[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (folderIds.length === 0) return counts;
        const rows = (await this.repo
            .createQueryBuilder('upload')
            .select('upload.folderId', 'folderId')
            .addSelect('COUNT(*)', 'cnt')
            .where('upload.userId = :userId', { userId })
            .andWhere('upload.folderId IN (:...folderIds)', { folderIds })
            .groupBy('upload.folderId')
            .getRawMany()) as Array<{ folderId: string; cnt: number | string }>;
        for (const row of rows) counts.set(row.folderId, Number(row.cnt));
        return counts;
    }

    /** Unlink every upload filed under the given folders (folder delete). */
    async clearFolders(userId: string, folderIds: string[]): Promise<void> {
        if (folderIds.length === 0) return;
        await this.repo
            .createQueryBuilder()
            .update(UserUpload)
            .set({ folderId: null })
            .where('userId = :userId', { userId })
            .andWhere('folderId IN (:...folderIds)', { folderIds })
            .execute();
    }
}
