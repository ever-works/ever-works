import { Injectable, Inject, Optional } from '@nestjs/common';
import { config } from '../config';
import {
    EverWorksDeployQuotaExceededError,
    type EverWorksDeployQuotaCounter,
} from './types';

/** DI token for the active-deploys counter implementation. */
export const EVER_WORKS_DEPLOY_QUOTA_COUNTER = Symbol('EVER_WORKS_DEPLOY_QUOTA_COUNTER');

/**
 * Enforces the per-user cap on `deployProvider = 'ever-works'` Works.
 *
 * The actual TypeORM query lives in the consuming module (it owns the
 * Work repository) so this service stays repo-agnostic and unit-testable
 * with a plain counter mock.
 */
@Injectable()
export class EverWorksDeployQuotaService {
    constructor(
        @Optional()
        @Inject(EVER_WORKS_DEPLOY_QUOTA_COUNTER)
        private readonly counter: EverWorksDeployQuotaCounter | null,
    ) {}

    /** Effective limit for the current process. */
    getLimit(): number {
        return config.everWorks.deploy.getMaxWorksPerUser();
    }

    /**
     * Throws `EverWorksDeployQuotaExceededError` when the user already has
     * ≥ N active Works on Ever Works Deploy. Resolves silently otherwise.
     */
    async assertWithinQuota(userId: string): Promise<void> {
        if (!this.counter) {
            // No counter wired up — quota cannot be enforced. Fail safely OPEN
            // because the env-level disabled flag is the primary gate; without
            // a counter we assume the wiring is incomplete in a test/dev shell.
            return;
        }
        const count = await this.counter.countActiveDeploys(userId);
        const limit = this.getLimit();
        if (count >= limit) {
            throw new EverWorksDeployQuotaExceededError(count, limit);
        }
    }
}
