import { randomUUID } from 'node:crypto';
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import { slugifyText } from '../items-generator/utils/text.utils';

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

    mocked: boolean;

    static async sessionMock() {
        const user = new User();

        user.id = slugifyText(process.env.GIT_NAME || randomUUID());
        user.mocked = true;
        user.username = process.env.GIT_NAME;
        user.email = process.env.GIT_EMAIL;

        return user;
    }

    async getGitToken() {
        if (this.mocked) {
            return process.env.GITHUB_APIKEY;
        }

        return process.env.GITHUB_APIKEY;
    }

    asCommitter() {
        return { name: this.username, email: this.email };
    }
}
