import { Injectable, Inject, Optional } from '@nestjs/common';
import { config } from '../config';
import {
    EverWorksDeployMisconfiguredError,
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
            // Security: fail CLOSED when the deploy feature is actually enabled
            // but the quota counter DI is missing. In that state the per-user cap
            // (the primary abuse/DoS control for the shared k8s deploy path) would
            // otherwise be silently unenforced, letting a user spin up unlimited
            // namespaces. We still fail OPEN (no-op) when the feature is disabled,
            // since the env flag is the primary gate and an absent counter then
            // just means an incomplete test/dev shell.
            if (config.everWorks.deploy.isEnabled()) {
                throw new EverWorksDeployMisconfiguredError(
                    'deploy quota counter is not wired up; refusing to create an Ever Works Deploy Work ' +
                        'because the per-user cap cannot be enforced',
                );
            }
            return;
        }
        const count = await this.counter.countActiveDeploys(userId);
        const limit = this.getLimit();
        if (count >= limit) {
            throw new EverWorksDeployQuotaExceededError(count, limit);
        }
    }
}
