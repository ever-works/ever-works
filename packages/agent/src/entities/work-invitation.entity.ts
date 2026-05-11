import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';
import {
    ClassToObject,
    InvitationRole,
    WorkInvitationStatus,
    WorkInvitationTransferState,
} from './types';

export type WorkInvitationMetadata = {
    /** GitHub/GitLab/Bitbucket login the claimant must match (owner-claim only). */
    expectedProviderUsername?: string;
    /** Free-form additional context. */
    [k: string]: unknown;
};

@Entity({ name: 'work_invitations' })
@Index(['workId'])
@Index(['tokenHash'], { unique: true })
@Index(['status'])
export class WorkInvitation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ type: 'varchar', length: 320, nullable: true })
    email: string | null;

    @Column({ type: 'varchar', length: 32 })
    role: InvitationRole;

    @Column({ type: 'varchar', length: 64 })
    tokenHash: string;

    @Column({ type: 'timestamp with time zone' })
    tokenExpiresAt: Date;

    @Column()
    invitedById: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'invitedById' })
    invitedBy: ClassToObject<User>;

    @Column({ type: 'varchar', length: 16, default: WorkInvitationStatus.PENDING })
    status: WorkInvitationStatus;

    @Column({ type: 'uuid', nullable: true })
    acceptedByUserId: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'acceptedByUserId' })
    acceptedBy: ClassToObject<User> | null;

    @Column({ type: 'timestamp with time zone', nullable: true })
    acceptedAt: Date | null;

    @Column({ type: 'simple-json', nullable: true })
    transferState: WorkInvitationTransferState | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata: WorkInvitationMetadata | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    isExpired(now: Date = new Date()): boolean {
        return this.tokenExpiresAt.getTime() <= now.getTime();
    }

    isConsumable(now: Date = new Date()): boolean {
        return this.status === WorkInvitationStatus.PENDING && !this.isExpired(now);
    }
}
