import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@ever-works/trigger-tasks';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';
import { SubscriptionsModule } from '@ever-works/agent/subscriptions';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { ItemsGeneratorModule } from '@ever-works/agent/items-generator';
import { ActivityFeedModule } from './activity-feed/activity-feed.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UploadsModule } from '../uploads/uploads.module';
// Run orchestration (Wave 4 M3) — AgentsModule exports AgentRunRepository
// for the per-Work runs-summary endpoint (DatabaseModule does not provide it).
import { AgentsModule } from '@ever-works/agent/agents';
// Wave 7 feature h — the in-platform PR review surface. PrReviewModule
// supplies the SAME reviewer the GitHub webhook bridge runs, and
// EventIngestModule supplies IngestedEventRepository so the diff view can
// read back the `github.pr.review` envelopes a review already recorded.
import { PrReviewModule } from '@ever-works/agent/pr-review';
import { EventIngestModule } from '@ever-works/agent/ingest';
// Campaign activation (roadmap 14.1) — composition module over Works,
// Goals, Agent templates and Tasks; provides CampaignActivationService.
import { CampaignsModule } from '@ever-works/agent/campaigns';
// APW-01 T17 — the App source inspection route. `AppWorksModule` is the only
// module that provides and exports `AppSourceInspectorService` (T12), so this
// import is what makes the controller's constructor resolvable at boot. It is
// the same module `WorkModule` already imports for the create path, and Nest
// instantiates a module once per graph, so the API still has exactly one
// inspector — the same instance the create path's step 6 calls.
import { AppWorksModule as AgentAppWorksModule } from '@ever-works/agent/app-works';
// APW-03 T15 — the two App-spec routes. `AppSpecModule` (T12) provides and
// exports `AppSpecService` and `WorkAppSpecStateRepository`, so this import is
// what makes `WorkAppSpecController`'s constructor resolvable at boot: the
// controller does not re-provide either, so the route, APW-01's create path and
// the evaluation job all read and write ONE state row through ONE service.
import { AppSpecModule as AgentAppSpecModule } from '@ever-works/agent/app-spec';
import { AppDeployRequestModule } from '@ever-works/agent/app-runtime';

// Controllers
import { WorksController } from './works.controller';
import { AppSourceController } from './app-source.controller';
// APW-03 T15 — `GET /api/works/:id/app-spec` and
// `POST /api/works/:id/app-spec/validate`, the two App-spec routes of plan
// §4.1. Both are four segments deep under `api/works`, so no `works/:id/...`
// handler can shadow them.
import { WorkAppDeployController } from './work-app-deploy.controller';
import { WorkAppSpecController } from './work-app-spec.controller';
import { WorkRunsController } from './work-runs.controller';
import { WorkPullRequestsController } from './work-pull-requests.controller';
import { MembersController } from './members.controller';
import { InvitationsController } from './invitations.controller';
import { BulkItemsController } from './bulk-items.controller';
import { KbController } from './kb.controller';
import { OrgKbController } from './org-kb.controller';
import { OrgMemoryController } from './org-memory.controller';
import { WorkTemplatesController } from './work-templates.controller';
import { WorkCampaignsController } from './work-campaigns.controller';
import { ExistingWebsiteLinkController } from './existing-website-link.controller';

// Services
import { WorksTemplateCatalogService } from './works-template-catalog.service';
import { ExistingWebsiteLinkService } from './existing-website-link.service';

// Tasks
import { WorkCleanupService } from './tasks/work-cleanup.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';
import { CommunityPrSchedulerService } from './tasks/community-pr-scheduler.service';
import { ComparisonSchedulerService } from './tasks/comparison-scheduler.service';
import { ItemSourceValidationCronService } from './tasks/item-source-validation-scheduler.service';
import { WorkCacheWarmupService } from './tasks/work-cache-warmup.service';
import { WorkScheduleDispatcherCronService } from './tasks/work-schedule-dispatcher-cron.service';

@Module({
    imports: [
        WorkModule,
        DatabaseModule,
        AuthModule,
        // Global-Memory ingest of chat attachments reads the stored bytes
        // back through UploadsService (the same spine that wrote them),
        // rather than re-uploading them from the browser. UploadsModule
        // does not import WorksModule, so this direction adds no cycle.
        UploadsModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
        SubscriptionsModule,
        ActivityLogModule,
        ItemsGeneratorModule,
        ActivityFeedModule,
        KnowledgeBaseModule,
        // Provides OrganizationMembershipService — the reusable
        // tenant-ownership guard OrgKbController uses to authorize its
        // raw `/api/organizations/:orgId/...` routes.
        OrganizationsModule,
        // Run orchestration (Wave 4 M3) — AgentRunRepository for the
        // per-Work runs-summary endpoint.
        AgentsModule,
        // Wave 7 feature h — on-demand agent PR review + the recorded
        // review history behind `GET /works/:id/pull-requests/...`.
        PrReviewModule,
        EventIngestModule,
        // Campaign activation (roadmap 14.1) — CampaignActivationService
        // for POST /api/works/from-campaign-template.
        CampaignsModule,
        // APW-01 T17 — `AppSourceInspectorService` for
        // `POST /api/works/app-source/inspect`. The inspector's own
        // collaborators (`GitFacadeService`, `WorkRepository`,
        // `DeployFacadeService`, the two unbound ports) come with it: this
        // module does not re-provide them, so the route and the create path
        // read the same inspection.
        AgentAppWorksModule,
        // APW-03 T15 — `AppSpecService` for `GET /api/works/:id/app-spec` and
        // `POST /api/works/:id/app-spec/validate`. It brings its own
        // collaborators (`WorkAppSpecStateRepository`, `GitFacadeService`,
        // `DistributedTaskLockService`, `ActivityLogModule`), so this module
        // re-provides none of them — the routes and the evaluation job therefore
        // share one service instance and one repository.
        AgentAppSpecModule,
        // APW-06 §2.2 — `AppDeployRequestService` for
        // `POST /api/works/:id/deploy`. It brings its own collaborators (the
        // preconditions pass, the runtime-state store, the Deployment store,
        // the Build source and the dispatcher gate), so this module re-provides
        // none of them: the route, `DeployService` and the worker's dequeue all
        // go through one instance and one deploy lock.
        //
        // It also imports `AppSpecModule` for `APP_DEPLOY_SPEC_SOURCE`. That is
        // the SAME module instance `AgentAppSpecModule` above resolves to — Nest
        // caches a static module per class — so the deploy preconditions and
        // `GET /api/works/:id/app-spec` read one `AppSpecService`, which is what
        // keeps "your spec is invalid" on the Deploy tab and the App spec tab
        // from ever disagreeing.
        AppDeployRequestModule,
    ],
    providers: [
        CacheEntryRepository,
        WorksTemplateCatalogService,
        ExistingWebsiteLinkService,
        WorkCleanupService,
        WebsiteTemplateSchedulerService,
        CommunityPrSchedulerService,
        ComparisonSchedulerService,
        ItemSourceValidationCronService,
        WorkCacheWarmupService,
        WorkScheduleDispatcherCronService,
        DistributedTaskLockService,
        // EW-641 1B/b — the KB upload pipeline's storage plugin token
        // (`KB_STORAGE_PLUGIN`) is now provided by the `@Global()`
        // `KbStorageModule` (apps/api/src/uploads/kb-storage.module.ts),
        // imported once at the api.module.ts level. The original
        // in-module provider here only bound the token within
        // `WorksModule`'s scope, which `KnowledgeBaseModule` (imported,
        // not consumer) couldn't see — so `KnowledgeBaseService.storage`
        // silently injected `undefined` and every upload returned 503.
        // See the docstring on `KbStorageModule` for the DI walk.
        //
        // EW-685 T4 full cutover — the three KB dispatcher tokens
        // (`KB_NORMALIZE_MEDIA_DISPATCHER`, `KB_TRANSCRIBE_DISPATCHER`,
        // `KB_REEMBED_WORK_DISPATCHER`) that used to live here as
        // custom Trigger.dev SDK adapters are now bound through the
        // EW-685 binding factory in
        // `packages/tasks/src/trigger/trigger.module.ts` — every
        // `*_DISPATCHER` symbol resolves uniformly through the
        // `JOB_RUNTIME_PROVIDER_REGISTRY`, so a future
        // `EVER_WORKS_JOB_RUNTIME` flip (BullMQ / pg-boss / Temporal)
        // swaps these three the same way it swaps the other eight.
        //
        // The previous KB_REEMBED adapter ran an enqueue-site stamping
        // pass (`RuntimeBindingStamperService.stamp(work.tenantId)`)
        // because the pgvector plugin call site has no tenant context;
        // the worker task's `TenantRuntimeBindingResolverService
        // .resolveForWork` already re-resolves the tenant from
        // `payload.workId`, so dropping the enqueue-side stamping only
        // downgrades graceful-drain detection (ADR-017 §3) for this
        // dispatcher from "fail loudly when rotated past this version"
        // to "run against current credentials" — and the re-embed task
        // is idempotent on `embedding_model` so an operator can
        // re-fire the model flip from the pgvector settings UI to
        // pick up fresh creds if drain ever bit them.
    ],
    controllers: [
        WorksController,
        // APW-01 T17 — `POST /api/works/app-source/inspect`, the App source
        // preview the create form and the create path both depend on. Static
        // and three segments deep, so no `works/:id/...` handler can shadow it.
        AppSourceController,
        // APW-03 T15 — the App spec tab's two routes.
        WorkAppDeployController,
        WorkAppSpecController,
        // Wave 4 M3 — per-Work AgentRun summary counts.
        WorkRunsController,
        // Wave 7 feature h (v1) — open PRs across the Work's repos.
        WorkPullRequestsController,
        MembersController,
        InvitationsController,
        BulkItemsController,
        KbController,
        OrgKbController,
        // Org-wide Memory (Cortex P1) — read-mostly aggregation over the
        // per-Work KB across the active Organization. Shares this module's
        // KnowledgeBaseModule + OrganizationsModule (membership guard) wiring.
        OrgMemoryController,
        WorkTemplatesController,
        // Roadmap 14.1 — the only path that mints a `campaign` Work.
        WorkCampaignsController,
        ExistingWebsiteLinkController,
    ],
})
export class WorksModule {}
