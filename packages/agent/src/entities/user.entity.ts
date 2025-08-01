import { randomUUID } from 'node:crypto';
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { slugifyText } from '../items-generator/utils/text.utils';
import { OAuthToken } from './oauth-token.entity';
import { ClassToObject } from './types';
import { config } from '@src/config';

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

    @Column({ default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @Column({ default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt: Date;

    @OneToMany(() => OAuthToken, (token) => token.user)
    oauthTokens: ClassToObject<OAuthToken>[];

    local: boolean = false;

    static async createLocalUser() {
        const user = new User();

        user.id = randomUUID();
        user.local = true;
        user.username = config.git.getName();
        user.email = config.git.getEmail();

        return user;
    }

    async getGitToken(): Promise<string | null> {
        if (this.local) {
            return config.github.getApiKey() || null;
        }

        // Check if oauth tokens are loaded
        if (!this.oauthTokens) {
            return null;
        }

        // Find GitHub token
        const githubToken = this.oauthTokens.find((token) => token.provider === 'github');

        if (!githubToken) {
            return null;
        }

        // Check if token is expired
        if (githubToken.expiresAt && new Date() > githubToken.expiresAt) {
            return null;
        }

        return githubToken.accessToken;
    }

    asCommitter() {
        return { name: this.username, email: this.email };
    }
}
