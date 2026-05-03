import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'github_app_installation_repositories' })
@Index(['installationEntityId', 'githubRepoId'], { unique: true })
@Index(['installationEntityId', 'fullName'], { unique: true })
export class GitHubAppInstallationRepository {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    installationEntityId: string;

    @Column({ type: 'varchar' })
    githubRepoId: string;

    @Column({ type: 'varchar' })
    owner: string;

    @Column({ type: 'varchar' })
    repo: string;

    @Column({ type: 'varchar' })
    fullName: string;

    @Column({ type: 'boolean', default: false })
    isPrivate: boolean;

    @Column({ type: 'varchar', nullable: true })
    defaultBranch?: string | null;

    @Column({ type: 'boolean', default: true })
    selected: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
