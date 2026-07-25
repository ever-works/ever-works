import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetNode } from '../entities/fleet-node.entity';
import { FleetNodeRepository } from './fleet-node.repository';
import { FleetService } from './fleet.service';

/**
 * Fleet (Wave 12, slice 1) — agent-side module owning the node
 * registry: one-time enrollment tokens (sha256-at-rest, single-use CAS
 * consume, 15-min expiry), heartbeat auth (constant-time, fail-closed)
 * and the owner-scoped node list with the piggybacked offline sweep +
 * the best-effort merge of the user's own configured-cluster nodes.
 *
 * `FleetService`'s plugin lookups (`PluginRegistryService` /
 * `PluginSettingsService`) resolve from the GLOBAL `PluginsModule` and
 * are `@Optional()` — the module stays bootable in contexts without the
 * plugin runtime, where cluster merging simply degrades to [].
 *
 * `FleetNode` MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [TypeOrmModule.forFeature([FleetNode])],
    providers: [FleetNodeRepository, FleetService],
    exports: [FleetNodeRepository, FleetService],
})
export class FleetModule {}
