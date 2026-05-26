import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache.entity';

interface RunExclusiveOptions {
    ttlMs?: number;
    refreshIntervalMs?: number;
    maxLifetimeMs?: number;
    onLocked?: () => void;
}

@Injectable()
export class DistributedTaskLockService {
    private readonly logger = new Logger(DistributedTaskLockService.name);
    private static readonly DEFAULT_TTL_MS = 15 * 60 * 1000;
    private static readonly DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
    private static readonly MAX_STALE_LOCK_MS = 24 * 60 * 60 * 1000;

    constructor(
        @InjectRepository(CacheEntry)
        private readonly cacheEntryRepository: Repository<CacheEntry>,
    ) {}

    async runExclusive<T>(
        key: string,
        fn: () => Promise<T>,
        options: RunExclusiveOptions = {},
    ): Promise<{ acquired: boolean; result?: T }> {
        const maxLifetimeMs = Math.min(
            options.maxLifetimeMs ?? DistributedTaskLockService.DEFAULT_MAX_LIFETIME_MS,
            DistributedTaskLockService.MAX_STALE_LOCK_MS,
        );
        const ttlMs = Math.min(
            options.ttlMs ?? DistributedTaskLockService.DEFAULT_TTL_MS,
            maxLifetimeMs,
        );
        const refreshIntervalMs =
            options.refreshIntervalMs ?? Math.max(30_000, Math.floor(ttlMs / 3));
        const hardDeadline = Date.now() + maxLifetimeMs;
        const token = await this.tryAcquire(key, ttlMs, maxLifetimeMs);

        if (!token) {
            options.onLocked?.();
            return { acquired: false };
        }

        const heartbeat = setInterval(() => {
            if (Date.now() >= hardDeadline) {
                clearInterval(heartbeat);
                this.logger.warn(
                    `Distributed task lock "${key}" reached the maximum lifetime of ${maxLifetimeMs}ms; it will be allowed to expire as stale`,
                );
                return;
            }

            this.refresh(key, token, ttlMs, hardDeadline).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Failed to refresh distributed task lock "${key}": ${message}`);
            });
        }, refreshIntervalMs);

        heartbeat.unref?.();

        try {
            return {
                acquired: true,
                result: await fn(),
            };
        } finally {
            clearInterval(heartbeat);
            await this.release(key, token);
        }
    }

    async isLocked(key: string): Promise<boolean> {
        const existingLock = await this.cacheEntryRepository.findOne({
            where: { key: this.buildKey(key), expiresAt: MoreThan(Date.now()) },
            select: ['key'],
        });
        return Boolean(existingLock);
    }

    private buildKey(key: string): string {
        return `task-lock:${key}`;
    }

    private async tryAcquire(
        key: string,
        ttlMs: number,
        maxLifetimeMs: number,
    ): Promise<string | null> {
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const lockKey = this.buildKey(key);
        const now = Date.now();
        const staleBefore = new Date(
            now - Math.min(maxLifetimeMs, DistributedTaskLockService.MAX_STALE_LOCK_MS),
        );

        await this.cacheEntryRepository
            .createQueryBuilder()
            .delete()
            .from(CacheEntry)
            .where('key = :key', { key: lockKey })
            .andWhere('(expiresAt < :now OR createdAt < :staleBefore)', {
                now,
                staleBefore,
            })
            .execute();

        try {
            await this.cacheEntryRepository.insert({
                key: lockKey,
                value: token,
                expiresAt: Math.min(now + ttlMs, now + maxLifetimeMs),
            });
            return token;
        } catch (error) {
            const existingLock = await this.cacheEntryRepository.findOne({
                where: { key: lockKey },
                select: ['key'],
            });

            if (existingLock) {
                return null;
            }

            throw error;
        }
    }

    private async refresh(
        key: string,
        token: string,
        ttlMs: number,
        hardDeadline: number,
    ): Promise<void> {
        const nextExpiry = Math.min(Date.now() + ttlMs, hardDeadline);
        await this.cacheEntryRepository
            .createQueryBuilder()
            .update(CacheEntry)
            .set({ expiresAt: nextExpiry })
            .where('key = :key', { key: this.buildKey(key) })
            .andWhere('value = :value', { value: token })
            .execute();
    }

    private async release(key: string, token: string): Promise<void> {
        await this.cacheEntryRepository
            .createQueryBuilder()
            .delete()
            .from(CacheEntry)
            .where('key = :key', { key: this.buildKey(key) })
            .andWhere('value = :value', { value: token })
            .execute();
    }
}
