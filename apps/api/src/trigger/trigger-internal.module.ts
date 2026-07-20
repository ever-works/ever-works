import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { TriggerInternalController } from './trigger-internal.controller';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';
import { MissionsModule } from '@ever-works/agent/missions';
import { WorkAgentModule } from '@ever-works/agent/work-agent';
import { GoalsModule } from '@ever-works/agent/goals';
import { AgentsModule } from '@ever-works/agent/agents';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { DataSyncModule } from '../data-sync/data-sync.module';
import { TenantJobRuntimeModule } from '../account/tenant-job-runtime/tenant-job-runtime.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
    imports: [
        // EW-742 P3.2 T22 — DatabaseModule exports
        // WebhookSubscriptionRepository (proxied through the
        // remote-proxy controller for the webhook-delivery task's
        // resolveForSubscription path).
        DatabaseModule,
        WorkOperationsModule,
        WorkModule,
        NotificationsModule,
        FacadesModule,
        WorkProposalsModule,
        // EW-742 P3.2 T22 — exposes CredentialVersionService through the
        // remote-proxy controller so the Trigger.dev worker can verify
        // the (providerId, credentialVersion) pair stamped at enqueue time.
        TenantJobRuntimeModule,
        // EW-742 P3.2 T22 — exposes OrganizationRepository for the
        // resolveForOrganization path on the worker-host resolver.
        OrganizationsModule,
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
        // PR-4 — exposes IdeaBuildExecutorService through the
        // remote-proxy controller so the idea-build-execute one-shot
        // task (in packages/tasks) can drive executeBuild() over the
        // internal RPC channel without direct DB access from worker
        // scope. WorkAgentModule exports the service.
        WorkAgentModule,
        // Goals & Metrics PR-8 — exposes GoalEvaluationService through
        // the remote-proxy controller so the goal-evaluate-dispatcher
        // cron task (in packages/tasks) can call evaluateDue() each
        // minute without direct DB access from worker scope.
        GoalsModule,
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
