import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'github_app_installations' })
@Index(['installationId'], { unique: true })
export class GitHubAppInstallation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    installationId: string;

    @Column({ type: 'varchar', nullable: true })
    appSlug?: string | null;

    @Column({ type: 'varchar' })
    accountLogin: string;

    @Column({ type: 'varchar' })
    accountType: string;

    @Column({ type: 'varchar' })
    targetType: string;

    @Column({ type: 'varchar', nullable: true })
    createdByUserId?: string | null;

    @Column({ type: 'varchar', nullable: true })
    createdByGithubUserId?: string | null;

    @PortableDateColumn({ nullable: true })
    suspendedAt?: Date | null;

    @Column({ type: 'simple-json', nullable: true })
    rawPayload?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
