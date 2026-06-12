import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A first-class record of a file uploaded via `POST /api/uploads/{file,image}`.
 *
 * Plain uploads previously left NO DB trace: `UploadsService.saveFile` stored
 * the bytes in a Storage plugin and returned the `sha256` as the upload `id`
 * (URL `/api/uploads/<userId>/<filename>`), so the only "ownership" was the
 * per-user storage namespace and there was no way to validate that an
 * attachment's `uploadId` referenced a real, caller-owned upload — which let a
 * ghost/foreign `uploadId` persist a dangling attachment edge (the
 * unmapped-500-hunt finding this entity closes).
 *
 * This row makes an upload an OWNABLE, QUERYABLE record:
 *   - `userId` — the owner (NULL for an anonymous upload).
 *   - `sha256` — the content hash returned to clients as the upload id; what
 *     attachments reference. Deduped per `(userId, sha256)`.
 *   - OPTIONAL scope links — `workId` is stamped today (from `?workId=`); the
 *     `missionId` / `ideaId` / `tenantId` / `organizationId` columns let an
 *     upload also be associated with those scopes as the upload surface grows
 *     (additive — the existing work + storage behaviour is unchanged).
 *
 * The file BYTES still live in the Storage plugin at `storagePath`; this is the
 * metadata / ownership index only.
 */
@Entity({ name: 'user_uploads' })
@Index('idx_user_uploads_user_sha', ['userId', 'sha256'])
@Index('idx_user_uploads_sha', ['sha256'])
export class UserUpload {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner. NULL for an anonymous upload. */
    @Column({ type: 'uuid', nullable: true })
    userId?: string | null;

    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'userId' })
    user?: User | null;

    /** Content hash — the upload id returned to clients + referenced by attachments. */
    @Column({ type: 'varchar', length: 64 })
    sha256: string;

    /** Optional scope associations (all nullable — an upload need not belong to any). */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    missionId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    ideaId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Plugin id of the Storage backend holding the bytes. */
    @Column({ type: 'varchar', length: 64, name: 'storage_provider' })
    storageProvider: string;

    /** Object key / path inside the Storage backend. */
    @Column({ type: 'varchar', length: 1024, name: 'storage_path' })
    storagePath: string;

    @Column({ type: 'varchar', length: 512, nullable: true, name: 'original_filename' })
    originalFilename?: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true, name: 'mime_type' })
    mimeType?: string | null;

    @Column({ type: 'bigint', nullable: true, name: 'file_size' })
    fileSize?: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
