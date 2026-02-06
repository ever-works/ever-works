import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, Repository } from 'typeorm';
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
