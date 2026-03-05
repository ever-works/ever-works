import { Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { ApiKeyRepository } from '@ever-works/agent/database';

const API_KEY_PREFIX = 'ew_live_';
const MAX_KEYS_PER_USER = 10;

@Injectable()
export class ApiKeyService {
    constructor(private readonly apiKeyRepository: ApiKeyRepository) {}

    async createKey(userId: string, name: string, expiresAt?: string) {
        const count = await this.apiKeyRepository.countByUserId(userId);
        if (count >= MAX_KEYS_PER_USER) {
            throw new BadRequestException(
                `Maximum of ${MAX_KEYS_PER_USER} API keys allowed per user`,
            );
        }

        if (expiresAt && new Date(expiresAt) <= new Date()) {
            throw new BadRequestException('Expiration date must be in the future');
        }

        const rawBytes = randomBytes(32);
        const rawKey = API_KEY_PREFIX + rawBytes.toString('hex');
        const hashedKey = createHash('sha256').update(rawKey).digest('hex');
        const prefix = rawKey.substring(0, 12);

        const apiKey = await this.apiKeyRepository.create({
            userId,
            name,
            hashedKey,
            prefix,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
        });

        return {
            id: apiKey.id,
            name: apiKey.name,
            key: rawKey,
            prefix: apiKey.prefix,
            expiresAt: apiKey.expiresAt,
            createdAt: apiKey.createdAt,
        };
    }

    async listKeys(userId: string) {
        return this.apiKeyRepository.findByUserId(userId);
    }

    async revokeKey(id: string, userId: string): Promise<boolean> {
        return this.apiKeyRepository.deleteByIdAndUserId(id, userId);
    }

    async validateKey(rawKey: string) {
        const hashedKey = createHash('sha256').update(rawKey).digest('hex');
        const apiKey = await this.apiKeyRepository.findByHashedKey(hashedKey);

        if (!apiKey) {
            return null;
        }

        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
            return null;
        }

        // Fire-and-forget lastUsedAt update
        this.apiKeyRepository.updateLastUsed(apiKey.id).catch(() => {});

        return apiKey;
    }
}
