import { Inject, Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { INSTANCE_STATS_CONFIG, type InstanceStatsRuntimeConfig } from './instance-stats.tokens';

/**
 * The statistics routes answer 404 whenever `EVER_STATS_ENABLED` switches the
 * module off — even if the module ended up in the graph anyway.
 *
 * Normally it does not: `ApiModule` imports the module only when the switch
 * is on (see `instanceStatsModuleImports`). That decision is taken when
 * `ApiModule` is imported, so it depends on the environment being loaded
 * first. This middleware, the scheduler and the sender re-read the switch
 * from the configuration the module reads when it is CREATED (after every
 * `.env` file is loaded), so "off" holds whatever the import order was.
 *
 * Middleware, not a guard: it runs before the global session guard, so every
 * caller — signed in or not — gets the same 404 an absent route gives.
 */
@Injectable()
export class InstanceStatsOffMiddleware implements NestMiddleware {
    constructor(
        @Inject(INSTANCE_STATS_CONFIG) private readonly config: InstanceStatsRuntimeConfig,
    ) {}

    use(
        request: { method?: string; originalUrl?: string; url?: string },
        _response: unknown,
        next: () => void,
    ): void {
        if (this.config.enabled) {
            next();
            return;
        }
        throw new NotFoundException(
            `Cannot ${request.method} ${request.originalUrl ?? request.url}`,
        );
    }
}
