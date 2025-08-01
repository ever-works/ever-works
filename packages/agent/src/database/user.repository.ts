import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, Repository } from 'typeorm';
import { User } from '../entities/user.entity';

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
            relations: ['oauthTokens'],
        });
    }

    async findByEmail(email: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { email },
            relations: ['oauthTokens'],
        });
    }

    async findById(id: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { id },
            relations: ['oauthTokens'],
        });
    }

    async update(id: string, userData: Partial<User>): Promise<User> {
        await this.repository.update(id, userData);
        return await this.findById(id);
    }

    async findByIdWithTokens(id: string): Promise<User | null> {
        return await this.repository.findOne({
            where: { id },
            relations: ['oauthTokens'],
        });
    }
}
