import { Entity, Column, PrimaryGeneratedColumn, Index, ManyToOne } from 'typeorm';
import { User } from './user.entity';
import { ClassToObject } from './types';
import { th } from 'zod/v4/locales';

@Entity({ name: 'directories' })
@Index(['owner'], { unique: true })
export class Directory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    slug: string;

    userId: string;

    @ManyToOne(() => User, (user) => user.directories, { onDelete: 'CASCADE', eager: true })
    user: ClassToObject<User>;

    @Column({ default: 'github' })
    repo_provider: string; // 'github', 'gitlab', etc.

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

    getDataRepo() {
        return `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return `${this.slug}-website`;
    }

    getRepoOwner(): string {
        const oauthToken = this.user.oauthTokens.find(
            (token) => token.provider === this.repo_provider,
        );

        return oauthToken.username || oauthToken.metadata?.login || this.user.username;
    }
}

export interface MarkdownReadmeConfig {
    header?: string;
    overwrite_default_header?: boolean;

    footer?: string;
    overwrite_default_footer?: boolean;
}
