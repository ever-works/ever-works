import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'github_app_user_links' })
@Index(['userId'], { unique: true })
@Index(['githubUserId'], { unique: true })
export class GitHubAppUserLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar' })
    githubUserId: string;

    @Column({ type: 'varchar' })
    githubLogin: string;

    @Column({ type: 'varchar', nullable: true })
    githubNodeId?: string | null;

    @Column({ type: 'text', nullable: true })
    accessToken?: string | null;

    @Column({ type: 'text', nullable: true })
    refreshToken?: string | null;

    @PortableDateColumn({ nullable: true })
    accessTokenExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    refreshTokenExpiresAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    scope?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
