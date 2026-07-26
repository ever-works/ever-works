import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRun } from '../entities/agent-run.entity';
import { TerminalTranscriptChunk } from '../entities/terminal-transcript-chunk.entity';
import { DatabaseModule } from '../database/database.module';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { TerminalTranscriptChunkRepository } from '../database/repositories/terminal-transcript-chunk.repository';
import { EntitlementsService } from '../subscriptions/credits/entitlements.service';
import { TerminalTranscriptService } from './terminal-transcript.service';

/**
 * Streaming-terminal M9 / founder decision D1 — transcript persistence,
 * redaction and plan-tier retention.
 *
 * Deliberately its own module rather than more providers on
 * `AgentsModule`: the retention lever is a billing entitlement, and
 * bolting that onto AgentsModule would couple every agent surface to it
 * for one feature. Consumers are the api-side `TerminalModule` (publish
 * + replay) and the worker's `TriggerInternalModule` (the nightly
 * `terminal-transcript-gc` sweep).
 *
 * `EntitlementsService` is PROVIDED here rather than imported from
 * `SubscriptionsModule`: this module is re-exported through the
 * `@ever-works/agent/agents` barrel, and pulling SubscriptionsModule in
 * would drag NotificationsModule → auth → services → generators into the
 * import graph of every consumer of that barrel (which breaks apps/api's
 * jest module mapping, and is a lot of module for one number). The
 * service's only dependency is `PlanEntitlementRepository`, which
 * `DatabaseModule` already provides.
 */
@Module({
    imports: [DatabaseModule, TypeOrmModule.forFeature([TerminalTranscriptChunk, AgentRun])],
    providers: [
        TerminalTranscriptChunkRepository,
        AgentRunRepository,
        EntitlementsService,
        TerminalTranscriptService,
    ],
    exports: [TerminalTranscriptService, TerminalTranscriptChunkRepository],
})
export class TerminalTranscriptModule {}
