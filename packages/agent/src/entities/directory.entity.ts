import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import type {
    ClassToObject,
    CommunityPrState,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatus,
    DirectoryMemberRole,
} from './types';
import type { PRUpdate } from '@src/generators/data-generator';
import { DirectoryGenerationHistory } from './directory-generation-history.entity';
import { TimestampColumn } from './_types';
import { DirectorySchedule } from './directory-schedule.entity';
import { DirectoryCustomDomain } from './directory-custom-domain.entity';
import { DirectoryMember } from './directory-member.entity';

@Entity({ name: 'directories' })
export class Directory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    slug: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.directories, { onDelete: 'CASCADE', eager: true })
    user: ClassToObject<User>;

    @OneToMany(() => DirectoryGenerationHistory, (history) => history.directory, {
        cascade: false,
    })
    generationHistory?: ClassToObject<DirectoryGenerationHistory>[];

    @Column({ nullable: true })
    owner?: string;

    @Column({ default: 'github' })
    gitProvider: string; // 'github', 'gitlab', etc.

    @Column({ default: 'vercel', nullable: true })
    deployProvider?: string; // 'vercel', 'netlify', etc.

    @Column({ nullable: true })
    website: string;

    @Column({ nullable: true })
    companyName: string;

    @Column({ default: false })
    organization: boolean;

    @Column()
    description: string;

    @Column('simple-json', { nullable: true })
    readmeConfig: MarkdownReadmeConfig;

    // Generation FIELDS
    @Column('simple-json', { nullable: true })
    generateStatus?: GenerateStatus;

    @TimestampColumn({ nullable: true })
    generationStartedAt?: Date;

    @TimestampColumn({ nullable: true })
    generationProgressedAt?: Date;

    @TimestampColumn({ nullable: true })
    generationFinishedAt?: Date;

    // Domain Type FIELDS (for smart image routing)
    @Column({ type: 'varchar', length: 20, nullable: true })
    domainType?: string; // 'software' | 'ecommerce' | 'services' | 'general'

    @Column({ type: 'float', nullable: true })
    domainTypeConfidence?: number;

    @Column({ type: 'boolean', default: false })
    domainTypeManuallySet: boolean;

    @OneToOne(() => DirectorySchedule, (schedule) => schedule.directory)
    schedule?: ClassToObject<DirectorySchedule>;

    @OneToMany(() => DirectoryMember, (member) => member.directory)
    members?: ClassToObject<DirectoryMember>[];

    @OneToMany(() => DirectoryCustomDomain, (customDomain) => customDomain.directory)
    customDomains?: ClassToObject<DirectoryCustomDomain>[];

    @Column({ type: 'boolean', default: false })
    scheduledUpdatesEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    scheduledCadence?: DirectoryScheduleCadence | null;

    @TimestampColumn({ nullable: true })
    scheduledNextRunAt?: Date | null;

    @Column({ type: 'varchar', nullable: true })
    scheduledStatus?: DirectoryScheduleStatus | null;

    // Deployment FIELDS
    @Column({ nullable: true })
    deployProjectId?: string;

    @Column({ nullable: true })
    deploymentState?: string;

    @TimestampColumn({ nullable: true })
    deploymentStartedAt?: Date;

    // Repository FIELDS
    @Column('simple-json', { nullable: true })
    lastPullRequest?: { main?: PRUpdate; data?: PRUpdate };

    @Column('simple-json', { nullable: true })
    repoVisibility?: RepoVisibility;

    @Column({ nullable: true })
    itemsCount?: number;

    // Git committer overrides at directory level (optional — fallback to user/default)
    @Column({ type: 'varchar', nullable: true })
    committerName?: string | null;

    @Column({ type: 'varchar', nullable: true })
    committerEmail?: string | null;

    // Import Source FIELDS
    @Column('simple-json', { nullable: true })
    sourceRepository?: SourceRepository;

    // Community PR Processing FIELDS
    @Column({ type: 'boolean', default: false })
    communityPrEnabled: boolean;

    @Column({ type: 'boolean', default: true })
    communityPrAutoClose: boolean;

    @Column('simple-json', { nullable: true })
    communityPrState?: CommunityPrState;

    // Comparison Generation FIELDS
    @Column({ type: 'boolean', default: false })
    comparisonsEnabled: boolean;

    // Website Template Auto-Update FIELDS
    @Column({ type: 'boolean', default: false })
    websiteTemplateAutoUpdate: boolean;

    @Column({ type: 'boolean', default: false })
    websiteTemplateUseBeta: boolean;

    @Column({ type: 'varchar', nullable: true })
    websiteTemplateLastCommit?: string | null;

    @Column({ type: 'varchar', nullable: true })
    websiteTemplateLastError?: string | null;

    @TimestampColumn({ nullable: true })
    websiteTemplateLastUpdatedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    websiteTemplateLastCheckedAt?: Date | null;

    // Source Validation FIELDS
    @Column({ type: 'boolean', default: false })
    sourceValidationEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    sourceValidationCadence?: DirectoryScheduleCadence | null;

    @TimestampColumn({ nullable: true })
    sourceValidationNextRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    sourceValidationLastRunAt?: Date | null;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    getDataRepo() {
        return this.sourceRepository?.relatedRepositories?.data?.repo || `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return this.sourceRepository?.relatedRepositories?.website?.repo || `${this.slug}-website`;
    }

    getMainRepo() {
        return this.sourceRepository?.relatedRepositories?.directory?.repo || this.slug;
    }

    getRepoOwner(type?: 'data' | 'directory' | 'website'): string {
        const relatedOwner =
            type === 'data'
                ? this.sourceRepository?.relatedRepositories?.data?.owner
                : type === 'website'
                  ? this.sourceRepository?.relatedRepositories?.website?.owner
                  : type === 'directory'
                    ? this.sourceRepository?.relatedRepositories?.directory?.owner
                    : undefined;

        return relatedOwner || this.owner || this.user?.username || '';
    }

    /**
     * Resolve the git committer for this directory.
     * Priority: directory-level override → user-level override → user default (username/email)
     */
    resolveCommitter(user: User): { name: string; email: string } {
        const userCommitter = user.asCommitter();
        const name = this.committerName || userCommitter.name;
        const email = this.committerEmail || userCommitter.email;
        return { name, email };
    }

    /**
     * Check if a user is the creator/owner of this directory.
     * Note: This checks the original creator (userId), not the OWNER role in members.
     */
    isCreator(userId: string): boolean {
        return this.userId === userId;
    }

    /**
     * Get member entry for a specific user.
     * Returns undefined if members are not loaded or user is not a member.
     */
    getMember(userId: string): DirectoryMember | undefined {
        if (!this.members) return undefined;
        return this.members.find((m) => m.userId === userId) as DirectoryMember | undefined;
    }

    /**
     * Check if a user has access to this directory (either as creator or as member).
     * Note: Requires members relation to be loaded for member check.
     */
    hasAccess(userId: string): boolean {
        if (this.isCreator(userId)) return true;
        const member = this.getMember(userId);
        return !!member;
    }

    /**
     * Get the role of a user in this directory.
     * Returns 'owner' for the creator, or the member's role if they're a member.
     */
    getUserRole(userId: string): DirectoryMemberRole | null {
        if (this.isCreator(userId)) {
            // Creator always has owner role
            return 'owner' as DirectoryMemberRole;
        }
        const member = this.getMember(userId);
        return member?.role || null;
    }
}

export interface MarkdownReadmeConfig {
    header?: string;
    overwriteDefaultHeader?: boolean;

    footer?: string;
    overwriteDefaultFooter?: boolean;
}

export type ImportSourceType = 'data_repo' | 'awesome_readme' | 'link_existing' | 'works_config';

export type RepositoryTarget = {
    owner?: string;
    repo: string;
};

export type RelatedRepositories = {
    data?: RepositoryTarget;
    directory?: RepositoryTarget;
    website?: RepositoryTarget;
};

export interface SourceRepository {
    url: string;
    owner: string;
    repo: string;
    type: ImportSourceType;
    importedAt: Date;
    relatedRepositories?: RelatedRepositories;
}

export interface RepoVisibility {
    data: boolean; // true = private, false = public
    website: boolean;
    directory: boolean;
}
