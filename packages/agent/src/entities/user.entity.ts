import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { OAuthToken } from './oauth-token.entity';
import { ClassToObject } from './types';
import { config } from '@src/config';
import { Directory } from './directory.entity';
import { RepoProvider } from '@src/dto';
import { DirectoryGenerationHistory } from './directory-generation-history.entity';
import { UserSubscription } from './user-subscription.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { DirectorySchedule } from './directory-schedule.entity';

@Entity({ name: 'users' })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    username: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ default: 'local' })
    registrationProvider: string; // 'local', 'github', 'google' - how user initially signed up

    @Column({ nullable: true })
    avatar: string;

    // Email verification
    @Column({ default: false })
    emailVerified: boolean;

    @Column({ nullable: true })
    emailVerificationToken: string;

    @Column({ nullable: true })
    emailVerificationExpires: Date;

    // Tokens and API keys
    @Column({ nullable: true })
    vercelToken: string;

    // User status
    @Column({ default: true })
    isActive: boolean;

    @Column({ nullable: true })
    lastLoginAt: Date;

    @Column({ nullable: true })
    lastLoginIp: string;

    // Password reset
    @Column({ nullable: true })
    passwordResetToken: string;

    @Column({ nullable: true })
    passwordResetExpires: Date;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    // Relationships
    @OneToMany(() => OAuthToken, (token) => token.user, { eager: true })
    oauthTokens: ClassToObject<OAuthToken>[];

    @OneToMany(() => Directory, (directory) => directory.user, { lazy: true })
    directories: Promise<ClassToObject<Directory>[]>;

    @OneToMany(() => DirectoryGenerationHistory, (history) => history.user, { lazy: true })
    generationHistory?: Promise<ClassToObject<DirectoryGenerationHistory>[]>;

    @OneToMany(() => UserSubscription, (subscription) => subscription.user, { lazy: true })
    subscriptions?: Promise<ClassToObject<UserSubscription>[]>;

    @OneToMany(() => DirectorySchedule, (schedule) => schedule.user, { lazy: true })
    directorySchedules?: Promise<ClassToObject<DirectorySchedule>[]>;

    @Column({ nullable: true })
    defaultPlanId?: string | null;

    @ManyToOne(() => SubscriptionPlan, { nullable: true, eager: true })
    @JoinColumn({ name: 'defaultPlanId' })
    defaultPlan?: ClassToObject<SubscriptionPlan> | null;

    local: boolean = false;

    getGitToken(provider: RepoProvider = RepoProvider.GITHUB): string | null {
        if (this.local) {
            return config.github.getApiKey() || null;
        }

        // Check if oauth tokens are loaded
        if (!this.oauthTokens) {
            return null;
        }

        // Find GitHub token
        const providerToken = this.oauthTokens.find((token) => token.provider === provider);
        if (!providerToken) {
            return null;
        }

        // Check if token is expired
        if (providerToken.expiresAt && new Date() > providerToken.expiresAt) {
            return null;
        }

        return providerToken.accessToken;
    }

    asCommitter(provider: RepoProvider = RepoProvider.GITHUB) {
        const providerToken = (this.oauthTokens || []).find((token) => token.provider === provider);
        const username = providerToken?.metadata?.login || providerToken?.username || this.username;
        const email = providerToken?.email || this.email;

        return { name: username, email };
    }
}
