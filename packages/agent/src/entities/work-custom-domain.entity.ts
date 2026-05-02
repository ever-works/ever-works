import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Unique,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject, DomainEnvironment } from './types';

/**
 * WorkCustomDomain entity stores custom domains associated with a work.
 *
 * The database is the primary source of truth for domain records.
 * Provider APIs (e.g. Vercel) are used for sync — pushing/removing domains
 * and fetching DNS verification status.
 *
 * If a user switches deployment providers, domain records persist in the DB
 * and can be re-attached to the new provider.
 */
@Entity({ name: 'directory_custom_domains' })
@Unique(['workId', 'domain'])
export class WorkCustomDomain {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'directoryId' })
    workId: string;

    @ManyToOne(() => Work, (work) => work.customDomains, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    work: ClassToObject<Work>;

    @Column()
    domain: string;

    @Column({ type: 'varchar', default: DomainEnvironment.PRODUCTION })
    environment: DomainEnvironment;

    @Column({ type: 'boolean', default: false })
    verified: boolean;

    @Column({ nullable: true })
    provider?: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
