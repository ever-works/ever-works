import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER, type Cache } from '../cache';

export interface UserResearchLimitsConfig {
	maxRunsPerDay: number;
	maxSearchesPerDay: number;
	maxFetchesPerDay: number;
	maxTokensPerDay: number;
}

export const DEFAULT_USER_RESEARCH_LIMITS: UserResearchLimitsConfig = {
	maxRunsPerDay: 3,
	maxSearchesPerDay: 30,
	maxFetchesPerDay: 9,
	maxTokensPerDay: 200_000
};

export class UserResearchRateLimitedError extends Error {
	constructor(
		public readonly bucket: keyof UserResearchLimitsConfig,
		public readonly current: number,
		public readonly cap: number
	) {
		super(`User research rate limit exceeded for "${bucket}": ${current}/${cap}`);
		this.name = 'UserResearchRateLimitedError';
	}
}

/**
 * Daily counters for user-research cost control. Backed by NestJS cache-manager
 * with a 36h TTL (covers timezone edge and clock skew). Keys are scoped per
 * userId per UTC day, so a user can't burn through the global quota.
 *
 * When the cache backend is unavailable (rare — e.g. tests without a cache
 * provider), the service degrades to an in-process Map. That's fine: research
 * still works, the cap is just per-process instead of distributed.
 */
@Injectable()
export class UserResearchLimitsService {
	private readonly logger = new Logger(UserResearchLimitsService.name);
	private readonly fallback = new Map<string, number>();
	private readonly ttlMs = 36 * 60 * 60 * 1000;

	constructor(
		@Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
		private readonly config: UserResearchLimitsConfig = DEFAULT_USER_RESEARCH_LIMITS
	) {}

	async assertCanRun(userId: string): Promise<void> {
		const runs = await this.read('runs', userId);
		if (runs >= this.config.maxRunsPerDay) {
			throw new UserResearchRateLimitedError('maxRunsPerDay', runs, this.config.maxRunsPerDay);
		}
	}

	async incrementRuns(userId: string): Promise<number> {
		return this.increment('runs', userId);
	}

	async assertSearchAllowed(userId: string): Promise<void> {
		const used = await this.read('searches', userId);
		if (used >= this.config.maxSearchesPerDay) {
			throw new UserResearchRateLimitedError(
				'maxSearchesPerDay',
				used,
				this.config.maxSearchesPerDay
			);
		}
	}

	async incrementSearches(userId: string): Promise<number> {
		return this.increment('searches', userId);
	}

	async assertFetchAllowed(userId: string): Promise<void> {
		const used = await this.read('fetches', userId);
		if (used >= this.config.maxFetchesPerDay) {
			throw new UserResearchRateLimitedError(
				'maxFetchesPerDay',
				used,
				this.config.maxFetchesPerDay
			);
		}
	}

	async incrementFetches(userId: string): Promise<number> {
		return this.increment('fetches', userId);
	}

	async addTokens(userId: string, delta: number): Promise<number> {
		return this.increment('tokens', userId, delta);
	}

	getConfig(): Readonly<UserResearchLimitsConfig> {
		return this.config;
	}

	private dayKey(): string {
		const d = new Date();
		return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
			d.getUTCDate()
		).padStart(2, '0')}`;
	}

	private key(bucket: string, userId: string): string {
		return `user-research:limits:${userId}:${this.dayKey()}:${bucket}`;
	}

	private async read(bucket: string, userId: string): Promise<number> {
		const k = this.key(bucket, userId);
		if (this.cache) {
			try {
				const v = await this.cache.get<number>(k);
				return typeof v === 'number' ? v : 0;
			} catch (err) {
				this.logger.warn(`limits cache read failed: ${(err as Error).message}`);
			}
		}
		return this.fallback.get(k) ?? 0;
	}

	private async increment(bucket: string, userId: string, delta = 1): Promise<number> {
		const k = this.key(bucket, userId);
		const next = (await this.read(bucket, userId)) + delta;
		if (this.cache) {
			try {
				await this.cache.set(k, next, this.ttlMs);
				return next;
			} catch (err) {
				this.logger.warn(`limits cache write failed: ${(err as Error).message}`);
			}
		}
		this.fallback.set(k, next);
		return next;
	}
}
