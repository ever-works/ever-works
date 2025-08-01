import { randomUUID } from 'node:crypto';
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { slugifyText } from '../items-generator/utils/text.utils';
import { OAuthToken } from './oauth-token.entity';

@Entity()
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    username: string;

    @Column()
    email: string;

    @Column()
    password: string;

    @Column({ nullable: true })
    githubId: string;

    @Column({ nullable: true })
    googleId: string;

    @Column({ default: 'local' })
    provider: string;

    @Column({ nullable: true })
    avatar: string;

    @Column({ default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @Column({ default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt: Date;

    @OneToMany(() => OAuthToken, (token) => token.user)
    oauthTokens: OAuthToken[];

    mocked: boolean;

    static async sessionMock() {
        const user = new User();

        user.id = slugifyText(process.env.GIT_NAME || randomUUID());
        user.mocked = true;
        user.username = process.env.GIT_NAME;
        user.email = process.env.GIT_EMAIL;

        return user;
    }

    async getGitToken(): Promise<string | null> {
        if (this.mocked) {
            return process.env.GITHUB_APIKEY || null;
        }

        // Check if oauth tokens are loaded
        if (!this.oauthTokens) {
            return null;
        }

        // Find GitHub token
        const githubToken = this.oauthTokens.find(token => token.provider === 'github');
        
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
