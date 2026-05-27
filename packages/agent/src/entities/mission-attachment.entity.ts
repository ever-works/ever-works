import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Mission } from './mission.entity';

/**
 * Mission → Upload edge table. Mirrors {@link TaskAttachment} so the
 * Mission/Idea/Agent attachment surfaces share the same shape — easier
 * to reason about and easier to extend later (the `attachments` UI
 * sections under `apps/web/src/components/missions/` etc. all consume
 * an identical row shape).
 *
 * `uploadId` stores the SHA-256 content hash returned as `id` by
 * `POST /api/uploads/file` (and `POST /api/uploads`). Stored as
 * `varchar(64)` because sha256 in hex form is 64 lowercase hex
 * characters — not a UUID, so a `uuid` column would reject every
 * insert (Codex + Greptile P1 on PR #1044). No DB-level FK constraint
 * either: the upload pipeline may GC the storage object independently
 * (anonymous TTL, manual delete) and we don't want the attachment row
 * dropped underneath us; service-layer code validates the hash shape
 * before insert.
 */
@Entity({ name: 'mission_attachments' })
@Index('uq_mission_attachment', ['missionId', 'uploadId'], { unique: true })
@Index('idx_mission_attachment_upload', ['uploadId'])
export class MissionAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    missionId: string;

    @ManyToOne(() => Mission, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'missionId' })
    mission?: Mission;

    @Column({ type: 'varchar', length: 64 })
    uploadId: string;

    @CreateDateColumn()
    createdAt: Date;
}
