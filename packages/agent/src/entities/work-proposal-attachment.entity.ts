import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkProposal } from './work-proposal.entity';

/**
 * Idea (WorkProposal) → Upload edge table. Same shape as
 * {@link TaskAttachment} / {@link MissionAttachment}.
 *
 * "Idea" is the user-facing term — the entity is `WorkProposal`, hence
 * the table name `work_proposal_attachments` and the FK column
 * `workProposalId`. API surfaces still expose this as `/api/me/
 * work-proposals/:id/attachments` to match the existing controller
 * naming.
 */
@Entity({ name: 'work_proposal_attachments' })
@Index('uq_work_proposal_attachment', ['workProposalId', 'uploadId'], { unique: true })
@Index('idx_work_proposal_attachment_upload', ['uploadId'])
export class WorkProposalAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    workProposalId: string;

    @ManyToOne(() => WorkProposal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workProposalId' })
    workProposal?: WorkProposal;

    // SHA-256 content hash (64 lowercase hex) — see MissionAttachment
    // for the rationale + Codex/Greptile P1 reference.
    @Column({ type: 'varchar', length: 64 })
    uploadId: string;

    @CreateDateColumn()
    createdAt: Date;
}
