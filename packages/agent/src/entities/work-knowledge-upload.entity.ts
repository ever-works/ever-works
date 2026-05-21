import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    OneToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { KbUploadExtractionStatus } from './kb-types';
import { WorkKnowledgeDocument } from './work-knowledge-document.entity';

/**
 * An original uploaded source file backing a KB document.
 *
 * Tracks metadata + extraction lifecycle. The actual file bytes live
 * in the Work's configured Storage plugin (`github-storage`,
 * `aws-s3`, `minio`, `local-fs`) at `storagePath`. The DB row is the
 * source-of-truth for status, dedup, and extraction provenance.
 *
 * Dedup is by `(workId, sha256)` — the same source uploaded twice
 * reuses one row but may be classified into multiple KB documents
 * (see spec §8.3).
 */
@Entity({ name: 'work_knowledge_uploads' })
@Index(['workId', 'extractionStatus'])
@Index(['workId', 'sha256'])
@Index(['workId', 'createdAt'])
export class WorkKnowledgeUpload {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    /** Plugin ID of the Storage plugin that holds the file bytes. */
    @Column({ type: 'varchar', length: 64, name: 'storage_provider' })
    storageProvider: string;

    /** Path inside the storage. e.g. `kb-originals/research/2026-q2/file.pdf`. */
    @Column({ type: 'varchar', length: 1024, name: 'storage_path' })
    storagePath: string;

    @Column({ type: 'varchar', length: 512, name: 'original_filename' })
    originalFilename: string;

    @Column({ type: 'varchar', length: 128, name: 'mime_type' })
    mimeType: string;

    @Column({ type: 'bigint', name: 'file_size' })
    fileSize: number;

    @Column({ type: 'varchar', length: 64 })
    sha256: string;

    /** When a media-format normalization happened (e.g. video→mp4). */
    @Column({ type: 'varchar', length: 64, nullable: true, name: 'normalized_format' })
    normalizedFormat?: string | null;

    @Column({
        type: 'varchar',
        default: KbUploadExtractionStatus.PENDING,
        name: 'extraction_status',
    })
    extractionStatus: KbUploadExtractionStatus;

    @Column({ type: 'varchar', length: 64, nullable: true, name: 'extraction_plugin_id' })
    extractionPluginId?: string | null;

    @Column({ type: 'text', nullable: true, name: 'extraction_error' })
    extractionError?: string | null;

    @Column({ type: 'timestamptz', nullable: true, name: 'extraction_started_at' })
    extractionStartedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true, name: 'extraction_finished_at' })
    extractionFinishedAt?: Date | null;

    /** The KB document this upload was extracted into, if any. */
    @Column({ nullable: true, name: 'extracted_document_id' })
    extractedDocumentId?: string | null;

    @OneToOne(() => WorkKnowledgeDocument, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'extracted_document_id' })
    extractedDocument?: ClassToObject<WorkKnowledgeDocument> | null;

    @Column({ nullable: true, name: 'uploaded_by_id' })
    uploadedById?: string | null;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'uploaded_by_id' })
    uploadedBy?: ClassToObject<User> | null;

    /** Tags from the upload form; copied to the derived KB doc on first extraction. */
    @Column({ type: 'simple-json', nullable: true })
    tags?: string[] | null;

    @Column({ type: 'simple-json', nullable: true })
    categories?: string[] | null;

    /** e.g. EXIF for images, duration for video, page count for PDF. */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
