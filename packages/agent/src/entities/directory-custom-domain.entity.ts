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
import { Directory } from './directory.entity';
import { ClassToObject, DomainEnvironment } from './types';

/**
 * DirectoryCustomDomain entity stores custom domains associated with a directory.
 *
 * The database is the primary source of truth for domain records.
 * Provider APIs (e.g. Vercel) are used for sync — pushing/removing domains
 * and fetching DNS verification status.
 *
 * If a user switches deployment providers, domain records persist in the DB
 * and can be re-attached to the new provider.
 */
@Entity({ name: 'directory_custom_domains' })
@Unique(['directoryId', 'domain'])
export class DirectoryCustomDomain {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    directoryId: string;

    @ManyToOne(() => Directory, (directory) => directory.customDomains, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    directory: ClassToObject<Directory>;

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
