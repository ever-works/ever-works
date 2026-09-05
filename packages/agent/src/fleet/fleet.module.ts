import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import { FleetNode } from '../entities/fleet-node.entity';
import { FleetJob } from '../entities/fleet-job.entity';
import { FleetExecutionPreference } from '../entities/fleet-execution-preference.entity';
import { FleetNodeRepository } from './fleet-node.repository';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetService } from './fleet.service';
import { FleetJobService } from './fleet-job.service';
import { FleetExecutionPreferenceRepository } from './fleet-execution-preference.repository';
import { FleetExecutionPreferenceService } from './fleet-execution-preference.service';
import { FleetAgentNodeAffinityRepository } from './fleet-agent-node-affinity.repository';
import { FleetAgentNodeAffinityService } from './fleet-agent-node-affinity.service';
import { FleetCostPolicy } from '../entities/fleet-cost-policy.entity';
import { FleetCostPolicyRepository } from './fleet-cost-policy.repository';
import { FleetCostCeilingService } from './fleet-cost-ceiling.service';

/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — agent-side module owning
 * the node registry AND the work that runs on it:
 *
 *   - `FleetService` — one-time enrollment tokens (sha256-at-rest,
 *     single-use CAS consume, 15-min expiry), heartbeat auth
 *     (constant-time, fail-closed) and the owner-scoped node list with
 *     the piggybacked offline sweep + the best-effort merge of the
 *     user's own configured-cluster nodes.
 *   - `FleetExecutionPreferenceService` — the per Work / Goal / account
 *     choice of local runner vs cloud that `FleetRunRouterService` reads
 *     on every dispatch (the RULE itself is the pure
 *     `resolveFleetExecutionMode` in `@ever-works/contracts`).
 *   - `FleetJobService` — the lease protocol backing the
 *     `job-runtime-node` provider: atomic CAS claim, capability-tag
 *     filtering, lease TTL + extension, terminal transitions, and the
 *     expired-lease reclaim that runs both inline (per poll) and on the
 *     `fleet-job-lease-sweeper` cron.
 *   - `FleetCostCeilingService` (EW-777) — the per-node and fleet-wide
 *     DAILY model-spend ceilings, evaluated by the API-side reconciler
 *     after every fleet completion; crossing one drains the node(s)
 *     through the same disable + requeue pair the drain endpoint uses and
 *     files one Inbox notice per day (the `INBOX_PRODUCER` token is
 *     `@Optional()` — bound by the api-side @Global() InboxModule).
 *
 * Both authenticate nodes through the SAME credential helper
 * (`fleet-node-credential.ts`), so enroll / heartbeat / lease can never
 * drift apart on what "verified" means.
 *
 * `FleetService`'s plugin lookups (`PluginRegistryService` /
 * `PluginSettingsService`) resolve from the GLOBAL `PluginsModule` and
 * are `@Optional()` — the module stays bootable in contexts without the
 * plugin runtime, where cluster merging simply degrades to [].
 *
 * Every entity above MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([
            Agent,
            FleetNode,
            FleetJob,
            FleetExecutionPreference,
            FleetAgentNodeAffinity,
            FleetCostPolicy,
        ]),
    ],
    providers: [
        FleetNodeRepository,
        FleetJobRepository,
        FleetExecutionPreferenceRepository,
        FleetAgentNodeAffinityRepository,
        FleetCostPolicyRepository,
        FleetService,
        FleetJobService,
        FleetExecutionPreferenceService,
        FleetAgentNodeAffinityService,
        FleetCostCeilingService,
    ],
    exports: [
        FleetNodeRepository,
        FleetJobRepository,
        FleetExecutionPreferenceRepository,
        FleetAgentNodeAffinityRepository,
        FleetCostPolicyRepository,
        FleetService,
        FleetJobService,
        FleetExecutionPreferenceService,
        FleetAgentNodeAffinityService,
        FleetCostCeilingService,
    ],
})
export class FleetModule {}
