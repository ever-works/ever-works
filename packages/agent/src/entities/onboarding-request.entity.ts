import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

export type OnboardingStatus =
    | 'received'
    | 'validating'
    | 'validated'
    | 'queued'
    | 'generating'
    | 'deployed'
    | 'failed'
    | 'rejected';

@Entity({ name: 'onboarding_requests' })
@Index(['githubIdentityHash', 'repoUrlCanonical'], { unique: true })
@Index(['repoUrlCanonical'])
@Index(['workId'])
@Index(['accountId'])
export class OnboardingRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 64 })
    githubIdentityHash: string;

    @Column({ type: 'varchar', length: 512 })
    repoUrlCanonical: string;

    @Column({ type: 'varchar', length: 320, nullable: true })
    contactEmail: string | null;

    @Column({ type: 'varchar', length: 256, nullable: true })
    agentId: string | null;

    @Column({ type: 'uuid', nullable: true })
    accountId: string | null;

    @Column({ type: 'uuid', nullable: true })
    workId: string | null;

    @Column({ type: 'varchar', length: 64 })
    status: OnboardingStatus;

    @Column({ type: 'varchar', length: 128, nullable: true })
    failureCode: string | null;

    @Column({ type: 'simple-json', nullable: true })
    failureDetail: unknown;

    @Column({ type: 'varchar', length: 64, nullable: true })
    idempotencyKey: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    webhookUrl: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    subdomain: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
