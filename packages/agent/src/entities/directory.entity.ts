import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ClassToObject, GenerateStatus } from './types';
import type { PRUpdate } from '@src/data-generator';

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

    @Column('simple-json', { nullable: true })
    generateStatus?: GenerateStatus;

    @Column('simple-json', { nullable: true })
    lastPullRequest?: { main?: PRUpdate; data?: PRUpdate };

    @Column({ nullable: true })
    itemsCount?: number;

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
