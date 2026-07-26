import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetNode } from '../entities/fleet-node.entity';
import { FleetJob } from '../entities/fleet-job.entity';
import { FleetNodeRepository } from './fleet-node.repository';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetService } from './fleet.service';
import { FleetJobService } from './fleet-job.service';

/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — agent-side module owning
 * the node registry AND the work that runs on it:
 *
 *   - `FleetService` — one-time enrollment tokens (sha256-at-rest,
 *     single-use CAS consume, 15-min expiry), heartbeat auth
 *     (constant-time, fail-closed) and the owner-scoped node list with
 *     the piggybacked offline sweep + the best-effort merge of the
 *     user's own configured-cluster nodes.
 *   - `FleetJobService` — the lease protocol backing the
 *     `job-runtime-node` provider: atomic CAS claim, capability-tag
 *     filtering, lease TTL + extension, terminal transitions, and the
 *     expired-lease reclaim that runs both inline (per poll) and on the
 *     `fleet-job-lease-sweeper` cron.
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
 * `FleetNode` and `FleetJob` MUST also stay registered in the DataSource
 * ENTITIES array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [TypeOrmModule.forFeature([FleetNode, FleetJob])],
    providers: [FleetNodeRepository, FleetJobRepository, FleetService, FleetJobService],
    exports: [FleetNodeRepository, FleetJobRepository, FleetService, FleetJobService],
})
export class FleetModule {}
