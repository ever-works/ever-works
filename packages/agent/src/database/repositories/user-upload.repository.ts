import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserUpload } from '../../entities/user-upload.entity';

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
     * Insert the upload-ownership record, deduped per `(userId, sha256)` — a
     * repeat upload of the same file by the same user returns the existing row.
     * Best-effort by contract: the bytes are already stored, so the caller must
     * not let a failure here fail the upload (swallow + log).
     */
    async record(input: RecordUploadInput): Promise<UserUpload> {
        const existing = await this.repo.findOne({
            where: { userId: input.userId ?? null, sha256: input.sha256 },
        });
        if (existing) return existing;
        const entity = this.repo.create(input);
        return this.repo.save(entity);
    }

    /** An upload with this `sha256` owned by `userId`, else null. */
    async findOwnedByUser(sha256: string, userId: string): Promise<UserUpload | null> {
        return this.repo.findOne({ where: { sha256, userId } });
    }
}
