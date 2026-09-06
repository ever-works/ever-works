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
import { FleetKillSwitch } from '../entities/fleet-kill-switch.entity';
import { FleetAudit } from '../entities/fleet-audit.entity';
import { FleetKillSwitchRepository } from './fleet-kill-switch.repository';
import { FleetKillSwitchService } from './fleet-kill-switch.service';
import { FleetAuditService } from './fleet-audit.service';
import { FleetRunCredentialService } from './fleet-run-credential.service';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyRepository } from '../database/repositories/api-key.repository';

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
 *   - `FleetKillSwitchService` (EW-778) — the GLOBAL STOP FLAG, read
 *     fail-closed by the dispatch gate (via the `RUN_KILL_SWITCH` port
 *     the api-side AgentsModule binds), the run router and every lease;
 *     `FleetAuditService` is the one writer of the `fleet_audit` trail
 *     every panic action records to.
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
            FleetKillSwitch,
            FleetAudit,
            // Self-build slice Z (EW-796) — run-scoped MCP credentials are
            // `api_keys` rows with `kind = 'fleet-run'`, so the bridge
            // reuses the ONE hash/expiry/revoke implementation the
            // platform already has instead of growing a second one.
            ApiKey,
        ]),
    ],
    providers: [
        FleetNodeRepository,
        FleetJobRepository,
        FleetExecutionPreferenceRepository,
        FleetAgentNodeAffinityRepository,
        FleetCostPolicyRepository,
        FleetKillSwitchRepository,
        FleetService,
        FleetJobService,
        FleetExecutionPreferenceService,
        FleetAgentNodeAffinityService,
        FleetCostCeilingService,
        FleetAuditService,
        FleetKillSwitchService,
        // `ApiKeyRepository` is also provided by the api-side
        // `DatabaseModule`; providing it here as well keeps this module
        // self-contained (its own `forFeature([ApiKey])` above backs it)
        // exactly as the fleet repositories are.
        ApiKeyRepository,
        FleetRunCredentialService,
    ],
    exports: [
        FleetNodeRepository,
        FleetJobRepository,
        FleetExecutionPreferenceRepository,
        FleetAgentNodeAffinityRepository,
        FleetCostPolicyRepository,
        FleetKillSwitchRepository,
        FleetService,
        FleetJobService,
        FleetExecutionPreferenceService,
        FleetAgentNodeAffinityService,
        FleetCostCeilingService,
        FleetAuditService,
        FleetKillSwitchService,
        // Exported so the api-side `FleetJobsController` can mint on the
        // node channel and the completion listener can revoke.
        FleetRunCredentialService,
    ],
})
export class FleetModule {}
