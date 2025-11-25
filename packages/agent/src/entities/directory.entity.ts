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
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatus,
} from './types';
import type { PRUpdate } from '@src/data-generator';
import { DirectoryGenerationHistory } from './directory-generation-history.entity';
import { TimestampColumn } from './_types';
import { DirectorySchedule } from './directory-schedule.entity';

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
    repoProvider: string; // 'github', 'gitlab', etc.

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

    @OneToOne(() => DirectorySchedule, (schedule) => schedule.directory)
    schedule?: ClassToObject<DirectorySchedule>;

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
    deploymentState?: string;

    @TimestampColumn({ nullable: true })
    deploymentStartedAt?: Date;

    // Repository FIELDS
    @Column('simple-json', { nullable: true })
    lastPullRequest?: { main?: PRUpdate; data?: PRUpdate };

    @Column({ nullable: true })
    itemsCount?: number;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    getDataRepo() {
        return `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return `${this.slug}-website`;
    }

    getMainRepo() {
        return this.slug;
    }

    getRepoOwner(): string {
        const oauthToken = (this.user?.oauthTokens || []).find(
            (token) => token.provider === this.repoProvider,
        );

        return (
            this.owner || oauthToken?.username || oauthToken?.metadata?.login || this.user.username
        );
    }
}

export interface MarkdownReadmeConfig {
    header?: string;
    overwriteDefaultHeader?: boolean;

    footer?: string;
    overwriteDefaultFooter?: boolean;
}
