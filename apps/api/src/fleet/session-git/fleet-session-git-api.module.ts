import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import {
    FLEET_SESSION_PR_FACTS,
    FleetCheckoutsModule,
    FleetModule,
    FleetSessionGitModule,
    FleetSessionsModule,
} from '@ever-works/agent/fleet';
import { FleetCheckoutsEnabledGuard } from '../checkouts/fleet-checkouts-enabled.guard';
import { FleetApiModule } from '../fleet.module';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsEnabledGuard } from '../sessions/fleet-sessions-enabled.guard';
import { FleetPrEnrichmentService } from './fleet-pr-enrichment.service';
import { FleetPullRequestService } from './fleet-pull-request.service';
import { FleetSessionActionsController } from './fleet-session-actions.controller';
import { FleetSessionGitController } from './fleet-session-git.controller';
import { FleetSessionGitCronService } from './fleet-session-git-cron.service';

/**
 * Session git & actions (FL-06) — the API half:
 *
 *   - `FleetSessionGitController` — `/api/fleet/checkouts/:id/changes` and
 *     `/api/fleet/checkouts/:id/pull-request`;
 *   - `FleetPrEnrichmentService` — the pull request beside the git line,
 *     through the GitHub App (the installation credentials are the API's);
 *   - `FleetSessionGitCronService` — the minute tick (git-line cadence and
 *     enrichment).
 *
 * `@Global()` so FL-04's sessions controller reaches `FleetSessionGitService`
 * (the branch proposal) without importing this module, the same way the
 * sessions and checkouts API modules publish their ports. `FleetApiModule`
 * supplies `FleetPushCredentialService` (the installation-scope resolver);
 * `FacadesModule` the git facade.
 */
@Global()
@Module({
    imports: [
        FleetModule,
        FleetSessionsModule,
        FleetCheckoutsModule,
        FleetSessionGitModule,
        FleetApiModule,
        FacadesModule,
        // P2: the Agent (its "may open pull requests") and its Run (the Task it works on).
        DatabaseModule,
    ],
    controllers: [FleetSessionGitController, FleetSessionActionsController],
    providers: [
        FleetPrEnrichmentService,
        // P2: the relevance rules read the enrichment's facts through the agent-side port.
        { provide: FLEET_SESSION_PR_FACTS, useExisting: FleetPrEnrichmentService },
        FleetPullRequestService,
        FleetSessionGitCronService,
        DistributedTaskLockService,
        FleetEnabledGuard,
        FleetSessionsEnabledGuard,
        FleetCheckoutsEnabledGuard,
    ],
    exports: [
        FleetSessionGitModule,
        FleetPrEnrichmentService,
        FLEET_SESSION_PR_FACTS,
        FleetPullRequestService,
    ],
})
export class FleetSessionGitApiModule {}
