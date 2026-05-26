import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';
import { MissionsModule } from '@ever-works/agent/missions';
import { AgentsModule } from '@ever-works/agent/agents';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { DataSyncModule } from '../data-sync/data-sync.module';

@Module({
    imports: [
        WorkOperationsModule,
        WorkModule,
        NotificationsModule,
        FacadesModule,
        WorkProposalsModule,
        // EW-628 G7 — exposes DataSyncDispatcherService through the
        // remote-proxy controller so the Trigger.dev worker can call it
        // each cron tick without importing the full API stack.
        DataSyncModule,
        // EW-641 — exposes WorkKnowledgeDocumentRepository through the
        // remote-proxy controller so the KB mirror Trigger.dev task can
        // read + update document rows without direct DB access from
        // worker scope.
        KnowledgeBaseModule,
        // Phase 3 PR J — exposes MissionTickService through the
        // remote-proxy controller so the mission-tick cron task (in
        // packages/tasks) can call tickDue() each minute without
        // direct DB access from worker scope.
        MissionsModule,
        // Agents/Skills/Tasks PR #1017 — Phase 6. Exposes
        // AgentScheduleDispatcherService + AgentRepository +
        // AgentRunRepository through the remote-proxy controller so
        // the agent-heartbeat dispatcher + worker can drive them
        // without direct DB access from worker scope.
        AgentsModule,
        // Agents/Skills/Tasks PR #1017 — Phase 17. Exposes
        // TaskRecurrenceDispatcherService through the remote-proxy
        // controller so the task-recurrence-dispatcher cron task
        // can drive `dispatchDue()` over the internal RPC channel.
        TasksDomainModule,
    ],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
