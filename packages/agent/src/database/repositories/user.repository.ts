import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, LessThan, Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { config } from '../../config';
import { randomUUID } from 'node:crypto';

@Injectable()
export class UserRepository {
    constructor(
        @InjectRepository(User)
        private readonly repository: Repository<User>,
    ) {}

    async create(userData: Partial<User>): Promise<User> {
        const user = this.repository.create(userData);
        return await this.repository.save(user);
    }

    async findOne(options: FindOneOptions<User>): Promise<User | null> {
        return await this.repository.findOne(options);
    }

    async findByUsername(username: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { username },
        });
    }

    async findByEmail(email: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { email },
        });
    }

    async findById(id: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { id },
        });
    }

    async update(id: string, userData: Partial<User>): Promise<User> {
        await this.repository.update(id, userData);
        return await this.findById(id);
    }

    async clearPasswordResetToken(id: string, token: string): Promise<boolean> {
        const result = await this.repository.update(
            {
                id,
                passwordResetToken: token,
            },
            {
                passwordResetToken: null,
                passwordResetExpires: null,
            },
        );

        return (result.affected || 0) > 0;
    }

    /**
     * EW-617 G2: anonymous user TTL cleanup.
     * Returns all rows where `isAnonymous=true AND anonymousExpiresAt < now`.
     * Caller (Trigger.dev nightly task) is expected to delete them; ON DELETE
     * CASCADE on `work.userId` removes the orphan Works.
     */
    async findExpiredAnonymous(now: Date = new Date()): Promise<User[]> {
        return await this.repository.find({
            where: {
                isAnonymous: true,
                anonymousExpiresAt: LessThan(now),
            },
        });
    }

    /**
     * EW-617 G2: hard-delete an anonymous user. Cascades to its Works via
     * `work.user` ON DELETE CASCADE. Safe to call only after the row has been
     * verified `isAnonymous=true` to avoid wiping a real account by mistake.
     */
    async deleteAnonymous(id: string): Promise<void> {
        await this.repository.delete({ id, isAnonymous: true });
    }

    async createOrGetLocalUser(): Promise<User> {
        const username = config.github.getOwner() || config.git.getName();
        const email = config.git.getEmail();

        if (!username.trim()) {
            throw new Error(
                'Git provider username or Git name cannot both be empty. Please ensure you have configured these environment variables.',
            );
        }

        if (!email.trim()) {
            throw new Error(
                'Git email cannot be empty. Please ensure that you have configured this environment variable.',
            );
        }

        let user = await this.repository.findOne({
            where: [{ email }, { username }],
        });

        if (!user) {
            user = await this.create({
                username,
                email,
                password: randomUUID(),
                emailVerified: true,
            });
        }

        user.local = true;

        return user;
    }
}
