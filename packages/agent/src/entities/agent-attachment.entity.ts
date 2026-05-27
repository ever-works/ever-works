import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Agent } from './agent.entity';

/**
 * Agent → Upload edge table. Same shape as {@link TaskAttachment} /
 * {@link MissionAttachment} / {@link WorkProposalAttachment}. Lets
 * users attach reference files / specs to an Agent profile (the
 * `Agent` entity already has an `avatarImageUploadId` for the avatar
 * image; this is a separate, multi-row attachment relation for
 * reference material).
 */
@Entity({ name: 'agent_attachments' })
@Index('uq_agent_attachment', ['agentId', 'uploadId'], { unique: true })
@Index('idx_agent_attachment_upload', ['uploadId'])
export class AgentAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'agentId' })
    agent?: Agent;

    @Column({ type: 'uuid' })
    uploadId: string;

    @CreateDateColumn()
    createdAt: Date;
}
