import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { DomainEventFeedService, DomainEventsModule } from '@ever-works/agent/domain-events';
import { InboxModule as AgentInboxModule } from '@ever-works/agent/inbox';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { IntegrationsApiFoundationModule } from '@ever-works/agent/integrations-api';
import { RecordVisibilityModule } from '@ever-works/agent/record-visibility';
import { KnowledgeBaseModule, KnowledgeLibraryModule } from '@ever-works/agent/services';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { AgentTeamsModule } from '@ever-works/agent/teams';
import { UserResearchModule } from '@ever-works/agent/user-research';
import { GoalsModule } from '@ever-works/agent/goals';
import { MissionsModule } from '@ever-works/agent/missions';
import { WorkModule } from '@ever-works/agent/services';
import { IntegrationWhoamiController } from './whoami.controller';
import { IntegrationEventsController } from './events.controller';
import { IntegrationEmailController } from './email.controller';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { IntegrationInboxController } from './inbox.controller';
import { IntegrationKbController } from './kb.controller';
import { IntegrationLinksController } from './links.controller';
import { IntegrationResourcesController } from './resources.controller';
import { IntegrationTasksWriteController } from './tasks-write.controller';
import { IntegrationTaskSetsController } from './tasks-sets.controller';
import { IntegrationTaskCommentsController } from './task-comments.controller';
import { IntegrationBatchController } from './batch.controller';
import { IntegrationTeamsWriteController } from './teams-write.controller';
import { IntegrationWebhooksController } from './webhooks.controller';
import { IntegrationIdeasController } from './ideas.controller';
import { IntegrationGoalsController } from './goals.controller';
import { IntegrationMissionsController } from './missions.controller';
import { IntegrationOrganizationsWriteController } from './organizations-write.controller';
import { IntegrationMembersWriteController } from './members-write.controller';
import { IntegrationWorksWriteController } from './works-write.controller';
import { WebhooksModule } from '../../webhooks/webhooks.module';
import { AuthModule } from '../../auth/auth.module';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { INTEGRATION_FEED_HEAD, type IntegrationFeedHead } from './integration-feed-head';

/**
 * Integration API v1 — `/api/integrations/v1/*`, the stable contract Ever
 * Gauzy (and any later integration) codes against (plan doc 03 Part B,
 * `docs/specs/features/integrations-api-v1/`).
 *
 * EW-P1-2 ships the first route, `GET /whoami`, because it is about the key
 * itself. The resources (members, agents, teams, works, tasks, events,
 * links, batch) are EW-P1-4 and land in this module; the P2 resources
 * (ideas, then goals and missions) follow.
 */
@Module({
    imports: [
        DatabaseModule,
        DomainEventsModule,
        IntegrationsApiFoundationModule,
        // The domain services the write routes delegate to (the app's own rules,
        // events and notifications).
        TasksDomainModule,
        AgentTeamsModule,
        // `visibility` on task writes (EW-P1-3).
        RecordVisibilityModule,
        // Key-owned webhook subscriptions (EW-P1-5).
        WebhooksModule,
        // Ideas (EW-P2-1): `WorkProposalService` (createExternal, dismiss, restore).
        UserResearchModule,
        // Goals (EW-P2-2): `GoalsService` + the orchestrator's Definition of Done.
        GoalsModule,
        // Missions (EW-P2-5): `MissionsService` (createExternal, transitions, Work links).
        MissionsModule,
        // Organizations (EW-P2-6, `org:write`): `OrganizationService.createOrganization`
        // and `IntegrationKeyService.addPin` (AuthModule exports it).
        OrganizationsModule,
        AuthModule,
        // Project Works (Gauzy CR-6, EW-P2-4): `WorkLifecycleService.createProjectWork`.
        WorkModule,
        // The Inbox reply / state routes (EW-P3-1) delegate to the app's own
        // `InboxService` (steer, resume, decide exactly like the Inbox UI).
        AgentInboxModule,
        // The KB routes (EW-P3-2) delegate to the Knowledge Base and the
        // Knowledge library; organization admin comes from the membership service.
        KnowledgeBaseModule,
        KnowledgeLibraryModule,
        OrganizationsModule,
        // `POST /email/inbound` (EW-P4-1) dispatches through the same inbound
        // dispatcher as provider mail (AGENT_INBOUND_EMAIL_DISPATCHER).
        AgentNotificationsModule,
    ],
    controllers: [
        IntegrationWhoamiController,
        // EW-P1-4 — the change feed and the P1 resource reads.
        IntegrationEventsController,
        IntegrationResourcesController,
        IntegrationLinksController,
        IntegrationTasksWriteController,
        IntegrationTaskSetsController,
        IntegrationTaskCommentsController,
        IntegrationTeamsWriteController,
        IntegrationBatchController,
        IntegrationWebhooksController,
        // P2 resources.
        IntegrationIdeasController,
        IntegrationGoalsController,
        IntegrationMissionsController,
        IntegrationOrganizationsWriteController,
        IntegrationWorksWriteController,
        // CR-13 — `POST /members/invite` (Gauzy "invite to Ever Works", `members:write`).
        IntegrationMembersWriteController,
        // EW-P3-1 — the Inbox (`inbox:*`).
        IntegrationInboxController,
        // EW-P3-2 — the Knowledge Base (`kb:*`).
        IntegrationKbController,
        // EW-P4-2 / EW-P4-1 — agent email (`email:*`).
        IntegrationEmailController,
    ],
    providers: [
        IntegrationOnlyGuard,
        IntegrationExceptionFilter,
        // `whoami.feedHead` — the GLOBAL change-feed head (EW-P1-1): feed
        // positions are assigned by the relay across every organization, so
        // there is no per-organization head and the pins are not needed here.
        {
            provide: INTEGRATION_FEED_HEAD,
            useFactory: (feed: DomainEventFeedService): IntegrationFeedHead => ({
                head: () => feed.head(),
            }),
            inject: [DomainEventFeedService],
        },
    ],
})
export class IntegrationsApiV1Module {}
