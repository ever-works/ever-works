import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { AgentsModule } from '../agents/agents.module';
import { EventIngestModule } from '../ingest/ingest.module';
import { GoalsModule } from '../goals/goals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FacadesModule } from '../facades/facades.module';
import { DigestService } from './digest.service';

/**
 * Digest briefings (Wave 7) — agent-side module owning the digest
 * composer + delivery + dispatcher (`DigestService`). No entity of
 * its own: the composer is a pure read over existing repositories,
 * delivery rides the notifications producer pattern, and the schema
 * surface is the `users.digestFrequency` preference column plus the
 * org-scoped `organizations.digest_settings` opt-in.
 *
 * Consumed by the API's TriggerInternalModule so the
 * `digest-dispatcher` cron (packages/tasks) can drive
 * `dispatchDue(period)` / `dispatchDueOrganizations(period)` over the
 * internal RPC channel.
 */
@Module({
    imports: [
        // UserRepository — preference reads + due-user selection.
        // OrganizationRepository / TenantRepository — org digest opt-in
        // + tenant-owner recipient resolution.
        DatabaseModule,
        // TaskRepository — done / in-review movement + `prUrl` PR lines.
        TasksDomainModule,
        // AgentRunRepository — completed/failed run highlights.
        AgentsModule,
        // IngestedEventRepository — event counts by source (Wave 6 spine).
        EventIngestModule,
        // GoalsService — active-goal progress snapshot (optional section).
        GoalsModule,
        // NotificationService — in-app row + notifications-v2 channel fanout.
        NotificationsModule,
        // AiFacadeService — the ONLY sanctioned path to a model. The
        // narrative summary rides the facade so provider resolution,
        // settings hierarchy, budget guards and usage metering all
        // apply; a missing provider degrades the digest, never fails it.
        FacadesModule,
    ],
    providers: [DigestService],
    exports: [DigestService],
})
export class DigestModule {}
