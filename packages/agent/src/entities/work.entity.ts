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
    WorkScheduleCadence,
    WorkScheduleStatus,
    GenerateStatus,
    WorkMemberRole,
} from './types';
import type {
    ImportSourceType,
    RelatedRepositories,
    RepoVisibility,
    RepositoryRole,
    RepositoryTarget,
    SourceRepository as ContractSourceRepository,
    WorksConfigSnapshot as ContractWorksConfigSnapshot,
} from '@ever-works/contracts/api';
import type { PRUpdate } from '@src/generators/data-generator';
import { WorkGenerationHistory } from './work-generation-history.entity';
import { TimestampColumn } from './_types';
import { WorkSchedule } from './work-schedule.entity';
import { WorkCustomDomain } from './work-custom-domain.entity';
import { WorkMember } from './work-member.entity';

@Entity({ name: 'works' })
export class Work {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    slug: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.works, { onDelete: 'CASCADE', eager: true })
    user: ClassToObject<User>;

    @OneToMany(() => WorkGenerationHistory, (history) => history.work, {
        cascade: false,
    })
    generationHistory?: ClassToObject<WorkGenerationHistory>[];

    @Column({ nullable: true })
    owner?: string;

    @Column({ default: 'github' })
    gitProvider: string; // 'github', 'gitlab', etc.

    @Column({ default: 'user-github' })
    storageProvider: string; // 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git'

    @Column({ default: 'vercel', nullable: true })
    deployProvider?: string; // 'ever-works' | 'vercel' | 'k8s' | 'netlify' | ...

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

    @OneToOne(() => WorkSchedule, (schedule) => schedule.work)
    schedule?: ClassToObject<WorkSchedule>;

    @OneToMany(() => WorkMember, (member) => member.work)
    members?: ClassToObject<WorkMember>[];

    @OneToMany(() => WorkCustomDomain, (customDomain) => customDomain.work)
    customDomains?: ClassToObject<WorkCustomDomain>[];

    @Column({ type: 'boolean', default: false })
    scheduledUpdatesEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    scheduledCadence?: WorkScheduleCadence | null;

    @TimestampColumn({ nullable: true })
    scheduledNextRunAt?: Date | null;

    @Column({ type: 'varchar', nullable: true })
    scheduledStatus?: WorkScheduleStatus | null;

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

    // Git committer overrides at work level (optional — fallback to user/default)
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

    @Column({ type: 'varchar', nullable: true, default: null })
    websiteTemplateId?: string | null;

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
    sourceValidationCadence?: WorkScheduleCadence | null;

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
        return this.getRelatedRepository('data').repo;
    }

    getWebsiteRepo() {
        return this.getRelatedRepository('website').repo;
    }

    getMainRepo() {
        return this.getRelatedRepository('work').repo;
    }

    getRepoOwner(type: RepositoryRole = 'data'): string {
        return this.getRelatedRepository(type).owner;
    }

    private getRelatedRepository(type: RepositoryRole): Required<RepositoryTarget> {
        const related = this.sourceRepository?.relatedRepositories?.[type];
        const owner = related?.owner || this.owner || this.user?.username || '';
        const repo = related?.repo || this.getDefaultRepositoryName(type);

        return { owner, repo };
    }

    private getDefaultRepositoryName(type: RepositoryRole): string {
        if (type === 'website') {
            return `${this.slug}-website`;
        }

        if (type === 'work') {
            return this.slug;
        }

        return `${this.slug}-data`;
    }

    /**
     * Resolve the git committer for this work.
     * Priority: work-level override → user-level override → user default (username/email)
     */
    resolveCommitter(user: User): { name: string; email: string } {
        const userCommitter = user.asCommitter();
        const name = this.committerName || userCommitter.name;
        const email = this.committerEmail || userCommitter.email;
        return { name, email };
    }

    /**
     * Check if a user is the creator/owner of this work.
     * Note: This checks the original creator (userId), not the OWNER role in members.
     */
    isCreator(userId: string): boolean {
        return this.userId === userId;
    }

    /**
     * Get member entry for a specific user.
     * Returns undefined if members are not loaded or user is not a member.
     */
    getMember(userId: string): WorkMember | undefined {
        if (!this.members) return undefined;
        return this.members.find((m) => m.userId === userId) as WorkMember | undefined;
    }

    /**
     * Check if a user has access to this work (either as creator or as member).
     * Note: Requires members relation to be loaded for member check.
     */
    hasAccess(userId: string): boolean {
        if (this.isCreator(userId)) return true;
        const member = this.getMember(userId);
        return !!member;
    }

    /**
     * Get the role of a user in this work.
     * Returns 'owner' for the creator, or the member's role if they're a member.
     */
    getUserRole(userId: string): WorkMemberRole | null {
        if (this.isCreator(userId)) {
            // Creator always has owner role
            return 'owner' as WorkMemberRole;
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

export type {
    ImportSourceType,
    RelatedRepositories,
    RepoVisibility,
    RepositoryRole,
    RepositoryTarget,
};

export type WorksConfigSnapshot = ContractWorksConfigSnapshot & {
    additionalAgentsCount?: number;
};

export type SourceRepositoryAuth =
    | {
          mode: 'github_app_installation';
          providerId: 'github';
          installationId: string;
          installationRepositoryId?: string;
          repoFullName?: string;
      }
    | {
          mode: 'none';
      };

export type SourceRepository = ContractSourceRepository<Date> & {
    worksConfig?: WorksConfigSnapshot;
    auth?: SourceRepositoryAuth;
};
