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
 * `uploadId` is an opaque FK to a row in `work_knowledge_uploads` —
 * the same upload pipeline backing Task attachments and the broader
 * `POST /api/uploads/file` endpoint. No DB-level FK constraint on
 * `uploadId` so an upload can be GC'd or rolled over without forcing
 * a cascade through every attachment table; service-layer code
 * validates the upload row exists before insert.
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

    @Column({ type: 'uuid' })
    uploadId: string;

    @CreateDateColumn()
    createdAt: Date;
}
