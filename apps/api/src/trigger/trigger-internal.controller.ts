import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    forwardRef,
    Get,
    Headers,
    OnModuleInit,
    Optional,
    Param,
    Post,
    Query,
    Inject,
} from '@nestjs/common';
import { WorkProposalsApiService } from '../work-proposals/work-proposals.service';
import superjson from 'superjson';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@ever-works/agent/config';
import {
    WorkRepository,
    WorkDeploymentRepository,
    WorkCustomDomainRepository,
    AuthAccountRepository,
    OrganizationRepository,
    TemplateRepository,
    TemplateCustomizationRepository,
    UserTemplatePreferenceRepository,
    UserRepository,
    WebhookSubscriptionRepository,
    WorkKnowledgeDocumentRepository,
    WorkUpstreamStateRepository,
} from '@ever-works/agent/database';
import { Work, User } from '@ever-works/agent/entities';
import { CACHE_MANAGER, Cache, DistributedTaskLockService } from '@ever-works/agent/cache';
import { WorkOperationsService } from '@ever-works/agent/work-operations';
import { WorkContextResponse } from '@ever-works/agent/tasks';
import { SkipThrottle } from '@nestjs/throttler';
import {
    AnonymousUserCleanupService,
    DeployReadyPollerService,
    KnowledgeBaseReconcileService,
    WorkOwnershipService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { MissionTickService } from '@ever-works/agent/missions';
import { IdeaBuildExecutorService } from '@ever-works/agent/work-agent';
import { GoalEvaluationService, GoalOrchestratorService } from '@ever-works/agent/goals';
import {
    AgentEscalationService,
    RosterProvisioningService,
    AgentRunService,
    AgentRunSweeperService,
    AgentScheduleDispatcherService,
    RunDispatchGateService,
    TerminalTranscriptService,
} from '@ever-works/agent/agents';
import {
    TaskChatService,
    TaskGateJudgeService,
    TaskGateRunnerService,
    TaskReviewRejectionService,
    TaskPrStatusService,
    TaskRunDenormService,
    TaskWorkspaceService,
    TaskRecurrenceDispatcherService,
    TasksService,
} from '@ever-works/agent/tasks-domain';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import { FleetJobService } from '@ever-works/agent/fleet';
import { ModelAccountHealthService } from '@ever-works/agent/model-routing';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { ConversationMessageService } from '@ever-works/agent/conversations';
import { DataSyncDispatcherService } from '../data-sync/data-sync-dispatcher.service';
import { NotificationService } from '@ever-works/agent/notifications';
import { GitFacadeService, NotificationChannelFacadeService } from '@ever-works/agent/facades';
import { RemoteCallDto } from './dto/remote-call.dto';
import {
    PluginRepository,
    UserPluginRepository,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';
import { EventIngestService, EventSourcePullService } from '@ever-works/agent/ingest';
import { DigestService } from '@ever-works/agent/digest';
import {
    MemoryConsolidationScheduleService,
    MemoryFactEmbedService,
    MemoryFactSweepService,
} from '@ever-works/agent/services';
import { SkillReadinessService } from '@ever-works/agent/skills';
import { WorkspaceBackupRunner, WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import { WorkspaceBackupRepository } from '@ever-works/agent/database';
import {
    CreditLedgerService,
    CreditsSweepService,
    PaygService,
} from '@ever-works/agent/subscriptions';
import {
    AppForkReadinessRunner,
    AppSourceInitializerService,
    AppUpstreamStateService,
    AppUpstreamSyncDispatcherService,
} from '@ever-works/agent/app-works';
import { AppSpecService } from '@ever-works/agent/app-spec';
// APW-05 T19 + C7 — the `app-build-prepare` runner the worker proxies. The class,
// not the port of the same name on `./app-builds.service`: the port is T17's
// provisional seam (`run(payload)`) and is deliberately NOT what the RPC channel
// publishes, so a worker cannot reach the service's internals through it.
// APW-05 T20 + C17 adds its `app-build-watch` sibling from the same barrel.
import { AppBuildPrepareRunner, AppBuildWatchRunner } from '@ever-works/agent/app-builds';

/**
 * C-05 RPC half — methods that must never be reachable via `POST
 * /internal/trigger/remote/call`, regardless of the service being called.
 * Most are Object/Function builtins that an attacker could otherwise use
 * to walk the prototype chain, rebind `this`, or invoke arbitrary code.
 */
const DANGEROUS_METHOD_NAMES = new Set<string>([
    'constructor',
    'prototype',
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toString',
    'toLocaleString',
    'valueOf',
    'apply',
    'call',
    'bind',
    'eval',
]);

const METHOD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Security (deserialization): the legitimate Trigger.dev worker always sends
 * `args` as a SuperJSON envelope — a plain object with exactly a `json` field
 * and an optional `meta` field (see `TriggerInternalApiClient.callRemote`).
 * Before handing the value to `superjson.deserialize`, assert that strict
 * shape so an attacker who learns `TRIGGER_INTERNAL_SECRET` cannot smuggle a
 * crafted envelope (extra top-level keys, a non-object `meta`, or a
 * `__proto__`/`constructor`/`prototype` sentinel at the top level) into the
 * deserializer. This is behaviour-preserving for every real caller because
 * SuperJSON's own output never contains keys other than `json`/`meta`.
 */
const FORBIDDEN_ENVELOPE_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

function assertSuperJsonEnvelope(
    value: unknown,
): asserts value is { json: unknown; meta?: object } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new BadRequestException('Invalid args envelope');
    }
    // Reject prototype-polluting envelopes (own keys only — inherited keys are
    // not iterated here, but the explicit set blocks the sentinel names).
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_ENVELOPE_KEYS.has(key)) {
            throw new BadRequestException('Invalid args envelope');
        }
        if (key !== 'json' && key !== 'meta') {
            throw new BadRequestException('Invalid args envelope');
        }
    }
    if (!('json' in value)) {
        throw new BadRequestException('Invalid args envelope');
    }
    const meta = (value as { meta?: unknown }).meta;
    if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
        throw new BadRequestException('Invalid args envelope');
    }
}

/**
 * C-05 RPC half — at module-init time, build a per-service allow-list of
 * "methods declared directly on this service class" by inspecting the
 * prototype's own property names. Methods inherited from Object / Function
 * / NestJS lifecycle base classes are excluded automatically because they
 * live on a different prototype level.
 *
 * Combined with `DANGEROUS_METHOD_NAMES` and `METHOD_NAME_RE` checks in
 * `callRemote`, this means an attacker who learns `TRIGGER_INTERNAL_SECRET`
 * can only call methods that the platform team deliberately declared on
 * the registered services — not arbitrary prototype-chain methods.
 */
function buildMethodAllowList(instance: object): Set<string> {
    const allowed = new Set<string>();
    if (!instance || typeof instance !== 'object') return allowed;

    const considerName = (name: string) => {
        if (DANGEROUS_METHOD_NAMES.has(name)) return;
        if (!METHOD_NAME_RE.test(name)) return;
        if (name.startsWith('_')) return; // convention: private
        if (typeof (instance as Record<string, unknown>)[name] !== 'function') return;
        allowed.add(name);
    };

    // Own-property methods first — covers arrow-function class fields bound in
    // the constructor (`this.foo = () => ...`), which are how some NestJS
    // services preserve `this` for callbacks. Without this, those methods
    // would not be callable via the allow-list and the call would be rejected
    // even though it's a legitimate method on the registered instance.
    for (const name of Object.getOwnPropertyNames(instance)) considerName(name);

    // Prototype chain — class methods declared with the `method() {}` shorthand
    // live here. Stop at `Object.prototype` so we never expose `constructor`,
    // `hasOwnProperty`, etc.
    let proto: object | null = Object.getPrototypeOf(instance);
    while (proto && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) considerName(name);
        proto = Object.getPrototypeOf(proto);
    }
    return allowed;
}

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
    private remoteMap: Record<string, object> = {};
    private allowedMethods: Record<string, Set<string>> = {};

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly workOperationsService: WorkOperationsService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly scheduleDispatcher: WorkScheduleDispatcherService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly notificationService: NotificationService,
        private readonly gitFacade: GitFacadeService,
        private readonly pluginRepository: PluginRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly templateRepository: TemplateRepository,
        private readonly templateCustomizationRepository: TemplateCustomizationRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
        private readonly userRepository: UserRepository,
        // EW-628 G7 — dispatcher fanned out from the data-repo-sync cron.
        private readonly dataSyncDispatcher: DataSyncDispatcherService,
        // EW-617 G8 — exposed for the deploy-ready-poller cron task.
        private readonly deployReadyPoller: DeployReadyPollerService,
        // EW-641 — exposed for the KB mirror Trigger.dev task so it can
        // read + update WorkKnowledgeDocument rows over the internal
        // RPC channel without direct DB access from worker scope.
        private readonly workKnowledgeDocumentRepository: WorkKnowledgeDocumentRepository,
        // Phase 3 PR J — exposed for the mission-tick Trigger.dev cron
        // so it can drive `tickDue()` over the internal RPC channel.
        private readonly missionTickService: MissionTickService,
        // PR-4 — exposed for the idea-build-execute Trigger.dev task so it
        // can drive executeBuild() over the internal RPC channel.
        private readonly ideaBuildExecutorService: IdeaBuildExecutorService,
        // Goals & Metrics PR-8 — exposed for the goal-evaluate-dispatcher
        // Trigger.dev cron so it can drive `evaluateDue()` over the
        // internal RPC channel.
        private readonly goalEvaluationService: GoalEvaluationService,
        // Agents/Skills/Tasks PR #1017 — Phase 6. Exposed for the
        // `agent-heartbeat-dispatcher` cron + `agent-heartbeat`
        // one-shot worker over the internal RPC channel.
        private readonly agentScheduleDispatcherService: AgentScheduleDispatcherService,
        // Agent runtime execution stays API-owned because the API module
        // binds AI/tool/finalizer facades. Trigger workers call it over RPC.
        private readonly agentRunService: AgentRunService,
        private readonly agentRepositoryRef: AgentRepository,
        private readonly agentRunRepositoryRef: AgentRunRepository,
        // Phase 17 — recurring Task dispatcher.
        private readonly taskRecurrenceDispatcherService: TaskRecurrenceDispatcherService,
        private readonly tasksService: TasksService,
        private readonly taskChatService: TaskChatService,
        // Wave 2 — worktree-per-Task workspace lifecycle for worker RPC.
        private readonly taskWorkspaceService: TaskWorkspaceService,
        // Kanban run cockpit (Wave 2) — latest-run denorm writes from the
        // agent-task-execute worker over the internal RPC channel.
        private readonly taskRunDenormService: TaskRunDenormService,
        // Notifications v2 (EW-663) — exposed for the
        // notification-channel-delivery Trigger task to run a single
        // channel attempt (plugins are loaded here, not in the worker).
        private readonly notificationChannelFacade: NotificationChannelFacadeService,
        // EW-742 P3.2 T22 — exposes CredentialVersionService.resolveSnapshot
        // through the remote-proxy controller so Trigger.dev worker tasks
        // can verify the (providerId, credentialVersion) pair stamped at
        // enqueue time and decide whether to run, fail with
        // CREDENTIAL_DRAINED, or fall back to the instance default.
        private readonly credentialVersionService: CredentialVersionService,
        // EW-742 P3.2 T22 — exposes OrganizationRepository so the
        // worker-side TenantRuntimeBindingResolverService can resolve
        // an org's tenantId for kb-org-overlay-fanout (the only org-
        // scoped dispatcher today).
        private readonly organizationRepository: OrganizationRepository,
        // EW-742 P3.2 T22 — exposes WebhookSubscriptionRepository so
        // the worker-side resolver can derive tenantId for the
        // webhook-delivery task.
        private readonly webhookSubscriptionRepository: WebhookSubscriptionRepository,
        // EW-617 G2 / EW-637 - exposes AnonymousUserCleanupService for the
        // nightly `anonymous-user-cleanup` cron task. Provided by WorkModule,
        // already imported by TriggerInternalModule.
        private readonly anonymousUserCleanupService: AnonymousUserCleanupService,
        // EW-643 Phase 3 slice 4a - exposes KnowledgeBaseReconcileService for
        // the daily `kb-reconcile` cron task. Provided by KnowledgeBaseModule,
        // already imported by TriggerInternalModule.
        private readonly knowledgeBaseReconcileService: KnowledgeBaseReconcileService,
        @Optional()
        @Inject(forwardRef(() => WorkProposalsApiService))
        private readonly workProposalsApiService?: WorkProposalsApiService,
        // Backs the `agent-run-sweeper` cron. Appended LAST and @Optional() so
        // every positional `new TriggerInternalController(...)` in the specs
        // keeps compiling — inserting mid-list silently shifts all later args.
        @Optional()
        private readonly agentRunSweeperService?: AgentRunSweeperService,
        // Wave 3 M2 — acceptance-check runner (quality gates). The
        // agent-task-execute worker calls `runChecks` over the internal RPC
        // channel after the agent loop, before the finalize/PR step. Same
        // appended-last @Optional() posture as the sweeper above.
        @Optional()
        private readonly taskGateRunnerService?: TaskGateRunnerService,
        // Run orchestration (Wave 4 M2) — drain-on-terminal RPC target for
        // the agent-task-execute worker. Appended LAST + @Optional() for
        // the same positional-spec reason as the sweeper above.
        @Optional()
        private readonly runDispatchGateService?: RunDispatchGateService,
        // Event-ingest spine (Wave 6) — backs the `event-ingest-tick`
        // cron: the worker proxy calls `processBatch()` over the internal
        // RPC channel. Appended LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly eventIngestService?: EventIngestService,
        // Digest briefings (Wave 7) — backs the `digest-dispatcher` cron:
        // the worker proxy calls `dispatchDue(period)` over the internal
        // RPC channel. Appended LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly digestService?: DigestService,
        // Credits ledger (pricing Wave 9 M1) — backs the
        // `credits-daily-grant` cron: the worker proxy calls
        // `dispatchDailyGrants()` over the internal RPC channel. Appended
        // LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly creditLedgerService?: CreditLedgerService,
        // Event-ingest pull path (Wave 8) — backs the pull half of the
        // `event-ingest-tick` cron: the worker proxy calls `pullSources()`
        // over the internal RPC channel, landing here where the
        // event-source plugins + settings + cursors are wired. Appended
        // LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly eventSourcePullService?: EventSourcePullService,
        // Streaming-terminal M9 / founder decision D1 — backs the
        // `terminal-transcript-gc` cron: the worker proxy calls
        // `sweepExpired()` over the internal RPC channel, landing here
        // where the chunk repository + plan entitlements are wired.
        // Appended LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly terminalTranscriptService?: TerminalTranscriptService,

        // Fleet job runtime (Desktop PRD M4) — backs the
        // `fleet-job-lease-sweeper` cron: the worker proxy calls
        // `reclaimExpired()` over the internal RPC channel to return
        // lapsed claims to the pool. Appended LAST + @Optional() per the
        // arity rule above.
        private readonly fleetJobService?: FleetJobService,

        // Judgment layer G3 — backs the escalation write from
        // `agent-task-execute` when the quality gate is exhausted or the
        // budget stopped the iterate loop. Appended LAST + @Optional()
        // per the arity rule above.
        @Optional()
        private readonly agentEscalationService?: AgentEscalationService,
        // Orchestration M9 — backs the durable gate-rejection write from
        // `agent-task-execute`, so a LATER resume replays the machine
        // feedback the terminal run already consumed. Appended LAST +
        // @Optional() per the arity rule above.
        @Optional()
        private readonly taskReviewRejectionService?: TaskReviewRejectionService,
        // Memory consolidation cadence (memory upgrades M9) — backs the
        // `memory-consolidation-tick` cron: the worker proxy calls
        // `dispatchDue()` over the internal RPC channel, landing here
        // where the org/tenant repositories, the AI facade and the
        // notification producer are wired. Appended LAST + @Optional()
        private readonly memoryConsolidationScheduleService?: MemoryConsolidationScheduleService,
        // Kanban run cockpit (plan 04 M5/M7) — backs the
        // `task-pr-status-sync` cron: the worker proxy calls
        // `syncDuePrStatuses()` over the internal RPC channel, landing
        // here where the git-provider plugins + credentials are wired.
        // Appended LAST + @Optional() per the arity rule above.
        private readonly taskPrStatusService?: TaskPrStatusService,
        // Judgment layer G2 — backs the acceptance-criteria judge call
        // from `agent-task-execute` after a GREEN gate. Lands here where
        // the AI provider plugins, the budget guard and the usage ledger
        // behind `AiFacadeService` are wired. Appended LAST + @Optional()
        // per the arity rule above.
        @Optional()
        private readonly taskGateJudgeService?: TaskGateJudgeService,
        // Autonomy layer — backs the `goal-advance-dispatcher` cron: the
        // worker proxy calls `advanceDue()` over the internal RPC channel,
        // landing here where the Tasks runtime and the dispatch gate are
        // wired. Appended LAST + @Optional() per the arity rule above —
        // inserting mid-list silently shifts every later positional arg in
        // the controller specs.
        @Optional()
        private readonly goalOrchestratorService?: GoalOrchestratorService,
        // Billing spec §3.2 — backs the `credits-daily-grant` cron: the
        // worker proxy calls `runDailySweep()` over the internal RPC
        // channel (expiries → daily free → plan allowance), landing here
        // where the ledger, entitlement and subscription repositories are
        // wired. Appended LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly creditsSweepService?: CreditsSweepService,
        // Billing spec §3.5 — backs the `credits-meter-flush` cron: the
        // worker proxy calls `flushPending()` over the internal RPC
        // channel. Appended LAST + @Optional() per the arity rule above.
        @Optional()
        private readonly paygService?: PaygService,
        // Model accounts (AW-16) — backs the `model-account-health` cron:
        // the worker proxy calls `probeDueAccounts()` over the internal RPC
        // channel, landing here where the AI provider plugins and their
        // settings are loaded. Appended LAST + @Optional() per the arity rule
        // above.
        @Optional()
        private readonly modelAccountHealthService?: ModelAccountHealthService,
        // Named Conversations — backs the `agent-conversation-reply` task:
        // the worker proxy calls `loadReplyContext`, `agentVisibleBody` and
        // `appendAgentMessage` over the internal RPC channel. Appended LAST +
        // @Optional() per the arity rule above.
        @Optional()
        private readonly conversationMessageService?: ConversationMessageService,
        // Skills shelf — backs the `skill-readiness-sweep` cron: the worker
        // proxy calls `sweepStale()` over the internal RPC channel, landing
        // here where the Skill repositories, the tool-grant matrix and the
        // credential port are wired. Appended LAST + @Optional() per the
        // arity rule above.
        @Optional()
        private readonly skillReadinessService?: SkillReadinessService,
        // AW-20 P1 — backs the `roster-provision` one-shot task: the
        // worker proxy drives `execute()` over the internal RPC channel,
        // landing here where the Agents, collaborator and checklist
        // repositories are wired. Appended LAST + @Optional() per the
        // arity rule above.
        @Optional()
        private readonly rosterProvisioningService?: RosterProvisioningService,
        // Memory facts (AW-07) — backs the `memory-fact-embed` task
        // (`embedFact(factId)`) and the `memory-fact-gc` cron (`sweep()`),
        // landing here where the AI provider and vector-store plugins are
        // loaded. Appended LAST + @Optional() per the arity rule above —
        // placed after develop's trailing optionals so no existing positional
        // index shifts.
        @Optional()
        private readonly memoryFactEmbedService?: MemoryFactEmbedService,
        @Optional()
        private readonly memoryFactSweepService?: MemoryFactSweepService,
        // AW-22 Workspace backup — backs the `workspace-backup` task
        // (`startFromPayload`, then `observeRun` until the row settles, then
        // `notifyFinished` on it — every call short, so none outlives the
        // RPC deadline) and the `workspace-backup-sweeper` cron (`runSweep`).
        // The archive is produced HERE and not in the worker because the runner
        // needs the DataSource, the active storage backend and each Work's
        // data-repo walk, none of which exist in worker scope.
        //
        // ⚠ These three arrived on `develop` appended LAST, and the App Works
        // block below arrived on this branch appended LAST. Both cannot be last.
        // They are ordered this way round because
        // `app-source-initializer.service.spec.ts:1353` asserts, against the
        // SOURCE, that `appSourceInitializerService` is the final `@Optional()`
        // — that is APW-01 T15's own guard against a mid-list insertion, and it
        // is the stricter of the two. `trigger-internal.controller.spec.ts`'s
        // arity assertion is positional (the last three indices must be
        // `@Optional()`), which holds either way. The positional construction in
        // that spec passes `undefined` for these three at exactly this offset.
        @Optional()
        private readonly workspaceBackupRunner?: WorkspaceBackupRunner,
        @Optional()
        private readonly workspaceBackupService?: WorkspaceBackupService,
        @Optional()
        private readonly workspaceBackupRepository?: WorkspaceBackupRepository,
        // APW-02 T28 — the App upstream trio the Trigger.dev worker reaches over
        // the internal RPC channel. All three are appended LAST + `@Optional()`
        // per the arity rule above (every positional
        // `new TriggerInternalController(...)` in the specs keeps compiling), and
        // all three come from the API's `AppWorksModule`, which
        // `TriggerInternalModule` now imports:
        //   - `AppUpstreamStateService` — the two upstream jobs' claim
        //     (`beginSync`/`finishSync`), the readiness probes and the conflict
        //     Task all live API-side (plan §2.4);
        //   - `AppUpstreamSyncDispatcherService` — the `app-upstream-sync-dispatcher`
        //     cron's `dispatchDue()` (plan §6.6);
        //   - `WorkUpstreamStateRepository` — `AppUpstreamSyncService` reads the
        //     Work's coordinates and the two counters §6.3 steps 3 and 9 need from
        //     the epic's own row, and that service runs in the worker, which owns
        //     no DataSource. T26 reported this binding by name
        //     (`app-upstream-sync.service.ts:86-92`); this is it.
        @Optional()
        private readonly appUpstreamStateService?: AppUpstreamStateService,
        @Optional()
        private readonly appUpstreamSyncDispatcherService?: AppUpstreamSyncDispatcherService,
        @Optional()
        private readonly workUpstreamStateRepository?: WorkUpstreamStateRepository,
        // APW-03 T12/T13 — `AppSpecService`, so the worker-side `app.spec.*` calls
        // land on the API process where the state row, the git facade and the
        // Activity log are wired. Without this entry the worker's proxy answers
        // `Unknown remote target: AppSpecService` (a named failure, but a failure
        // nonetheless) and the per-tenant dispatcher's whole point is lost. The
        // API-side path already falls back to running the evaluation in-process
        // (`app-spec.module.ts` docstring, plan §6.1:661-662); this is the worker
        // half of the same job. Appended LAST + `@Optional()` per the arity rule
        // above, exactly as its siblings are.
        @Optional()
        private readonly appSpecService?: AppSpecService,
        // APW-06 T71 — the three names the isolated App runtime worker
        // (`packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts`) proxies, because
        // it owns no `DataSource`. All three are appended LAST + `@Optional()` per the arity rule
        // above, so every positional `new TriggerInternalController(...)` in the specs keeps
        // compiling:
        //   - `WorkDeploymentRepository` — T32's `app-deploy` `onFailure` marks the row
        //     `ERROR (worker_failed)` through it;
        //   - `WorkCustomDomainRepository` — `DeployFacadeService`, which the worker constructs
        //     locally (§6.4:979), takes it NON-optionally;
        //   - `DistributedTaskLockService` — `app-health-poll`'s guard (§9.2:1248). It injects
        //     `@InjectRepository(CacheEntry)` non-optionally, so it can only be a proxy in the
        //     worker; `TriggerInternalModule` provides it and registers `CacheEntry` for it, the
        //     wiring `DataSyncModule`'s docstring documents as the canonical pattern.
        @Optional()
        private readonly workDeploymentRepository?: WorkDeploymentRepository,
        @Optional()
        private readonly workCustomDomainRepository?: WorkCustomDomainRepository,
        @Optional()
        private readonly distributedTaskLockService?: DistributedTaskLockService,
        // APW-05 T19 + C7 — the `app-build-prepare` job's runner, so the worker's
        // RPC call lands here, where the `DataSource` and the Activity writer are.
        // Appended LAST + `@Optional()` per the arity rule above, exactly as its
        // siblings are: an unconfigured installation answers the loud
        // `Unknown remote target: AppBuildPrepareRunner` rather than pretending,
        // and every positional `new TriggerInternalController(...)` in the specs
        // keeps compiling.
        @Optional()
        private readonly appBuildPrepareRunner?: AppBuildPrepareRunner,
        // APW-05 T20 + C17 — the `app-build-watch` job's runner, the second half of the
        // same pair. Appended LAST + `@Optional()` per the arity rule above: with the name
        // absent the worker's proxy answers the loud `Unknown remote target:
        // AppBuildWatchRunner` rather than pretending an observation happened.
        @Optional()
        private readonly appBuildWatchRunner?: AppBuildWatchRunner,
        // C10 — the `app-fork-readiness` job's runner, so the worker's RPC call lands
        // where the `DataSource` and the state row are. This is the half C10 measured as
        // missing: the job did not exist at all, so with the name absent the worker's
        // proxy would answer the loud `Unknown remote target: AppForkReadinessRunner`
        // rather than pretending a readiness run happened. Appended LAST + `@Optional()`
        // per the arity rule above, exactly as its siblings are.
        @Optional()
        private readonly appForkReadinessRunner?: AppForkReadinessRunner,
        // APW-01 T15 — the ready handler. The `app-fork-readiness` run calls
        // `onDataRepositoryReady` over this hop when the worker hosts the run, so the
        // hand-off lands where the `DataSource`, the Activity writer and APW-03's
        // `AppSpecService` are (its `initialize` call is the one C32 measured as missing
        // everywhere). Appended LAST + `@Optional()` per the arity rule above, exactly as
        // its siblings are: with the name absent the worker's proxy answers the loud
        // `Unknown remote target: AppSourceInitializerService` rather than pretending the
        // source was recorded.
        //
        // `onDataRepositoryReady` is deliberately NOT added to `RETRY_SAFE_REMOTE_METHODS`:
        // a transport failure fails the readiness run, the task's retry calls the handler
        // again, and the handler's own content compare makes that safe (plan §6).
        @Optional()
        private readonly appSourceInitializerService?: AppSourceInitializerService,
    ) {}

    onModuleInit() {
        this.remoteMap = {
            AuthAccountRepository: this.authAccountRepository,
            PluginRepository: this.pluginRepository,
            UserPluginRepository: this.userPluginRepository,
            WorkPluginRepository: this.workPluginRepository,
            WorkOperationsService: this.workOperationsService,
            NotificationService: this.notificationService,
            WorkRepository: this.workRepository,
            TemplateRepository: this.templateRepository,
            TemplateCustomizationRepository: this.templateCustomizationRepository,
            UserTemplatePreferenceRepository: this.userTemplatePreferenceRepository,
            UserRepository: this.userRepository,
            CacheManager: this.cacheManager,
            WorkScheduleDispatcherService: this.scheduleDispatcher,
            WorkScheduleService: this.workScheduleService,
            // EW-628 G7 — exposed for the data-repo-sync dispatcher cron.
            DataSyncDispatcherService: this.dataSyncDispatcher,
            // EW-617 G8 — exposed for the deploy-ready-poller cron task.
            DeployReadyPollerService: this.deployReadyPoller,
            // EW-641 — exposed for the KB mirror Trigger.dev task.
            WorkKnowledgeDocumentRepository: this.workKnowledgeDocumentRepository,
            // Phase 3 PR J — exposed for the mission-tick cron.
            MissionTickService: this.missionTickService,
            // PR-4 — exposed for the idea-build-execute one-shot task.
            IdeaBuildExecutorService: this.ideaBuildExecutorService,
            // Goals & Metrics PR-8 — exposed for the goal-evaluate-dispatcher cron.
            GoalEvaluationService: this.goalEvaluationService,
            // Autonomy layer — exposed for the goal-advance-dispatcher cron.
            GoalOrchestratorService: this.goalOrchestratorService,
            // Agents/Skills/Tasks PR #1017 — Phase 6. Exposed for the
            // agent-heartbeat dispatcher cron + agent-heartbeat one-shot.
            AgentScheduleDispatcherService: this.agentScheduleDispatcherService,
            AgentRunSweeperService: this.agentRunSweeperService,
            // Judgment layer G3 — agent-task-execute files escalations here
            // when the gate is exhausted / the budget stopped the loop.
            AgentEscalationService: this.agentEscalationService,
            // AW-20 P1 — exposed for the `roster-provision` one-shot task.
            RosterProvisioningService: this.rosterProvisioningService,
            // Orchestration M9 — agent-task-execute persists the machine
            // gate feedback here so a later resume replays it.
            TaskReviewRejectionService: this.taskReviewRejectionService,
            // Run orchestration (Wave 4 M2) — agent-task-execute calls
            // drainForWork here after every terminal transition.
            RunDispatchGateService: this.runDispatchGateService,
            AgentRunService: this.agentRunService,
            AgentRepository: this.agentRepositoryRef,
            AgentRunRepository: this.agentRunRepositoryRef,
            // Phase 17 — recurring Task dispatcher.
            TaskRecurrenceDispatcherService: this.taskRecurrenceDispatcherService,
            TasksService: this.tasksService,
            TaskChatService: this.taskChatService,
            // Named Conversations — agent-conversation-reply calls
            // `loadReplyContext` / `agentVisibleBody` / `appendAgentMessage`
            // here (allow-list auto-derived).
            ConversationMessageService: this.conversationMessageService,
            TaskWorkspaceService: this.taskWorkspaceService,
            // Wave 3 M2 — agent-task-execute calls `runChecks` here after the
            // agent loop (quality gates; allow-list auto-derived).
            TaskGateRunnerService: this.taskGateRunnerService,
            // Judgment layer G2 — agent-task-execute calls `judge` here
            // after a green gate (allow-list auto-derived).
            TaskGateJudgeService: this.taskGateJudgeService,
            // Kanban run cockpit (Wave 2) — agent-task-execute calls
            // recordQueued/recordStarted/recordTerminal here.
            TaskRunDenormService: this.taskRunDenormService,
            // Notifications v2 (EW-663) — notification-channel-delivery task
            // calls `deliverToChannelOrThrow` here (allow-list auto-derived).
            NotificationChannelFacadeService: this.notificationChannelFacade,
            // EW-742 P3.2 T22 — exposed for the worker-host resolveSnapshot
            // consumption (see TenantRuntimeBindingResolverService in
            // packages/tasks/src/trigger/worker/services/).
            CredentialVersionService: this.credentialVersionService,
            // EW-742 P3.2 T22 — exposed for resolveForOrganization on
            // the worker-host resolver (kb-org-overlay-fanout task).
            OrganizationRepository: this.organizationRepository,
            // EW-742 P3.2 T22 — exposed for resolveForSubscription on
            // the worker-host resolver (webhook-delivery task).
            WebhookSubscriptionRepository: this.webhookSubscriptionRepository,
            // EW-617 G2 / EW-637 - `anonymous-user-cleanup` calls
            // `purgeExpired()` here (allow-list auto-derived).
            AnonymousUserCleanupService: this.anonymousUserCleanupService,
            // EW-643 Phase 3 slice 4a - `kb-reconcile` calls `reconcile()`.
            KnowledgeBaseReconcileService: this.knowledgeBaseReconcileService,
            // Event-ingest spine (Wave 6) — `event-ingest-tick` calls
            // `processBatch()` here (allow-list auto-derived).
            EventIngestService: this.eventIngestService,
            // Event-ingest pull path (Wave 8) — `event-ingest-tick` calls
            // `pullSources()` here (allow-list auto-derived).
            EventSourcePullService: this.eventSourcePullService,
            // Digest briefings (Wave 7) — `digest-dispatcher` calls
            // `dispatchDue(period)` here (allow-list auto-derived).
            DigestService: this.digestService,
            // Credits ledger (pricing Wave 9 M1) — `credits-daily-grant`
            // calls `dispatchDailyGrants()` here (allow-list auto-derived).
            CreditLedgerService: this.creditLedgerService,
            // Billing spec §3.2 — `credits-daily-grant` calls
            // `runDailySweep()` here (allow-list auto-derived).
            CreditsSweepService: this.creditsSweepService,
            // Billing spec §3.5 — `credits-meter-flush` calls
            // `flushPending()` here (allow-list auto-derived).
            PaygService: this.paygService,
            // Streaming-terminal M9 / D1 — `terminal-transcript-gc` calls
            // `sweepExpired()` here (allow-list auto-derived).
            TerminalTranscriptService: this.terminalTranscriptService,

            // Fleet job runtime (Desktop PRD M4) — `fleet-job-lease-sweeper`
            // calls `reclaimExpired()` here (allow-list auto-derived).
            FleetJobService: this.fleetJobService,
            // Memory consolidation cadence (memory upgrades M9) —
            // `memory-consolidation-tick` calls `dispatchDue()` here
            // (allow-list auto-derived).
            MemoryConsolidationScheduleService: this.memoryConsolidationScheduleService,
            // Kanban run cockpit (plan 04 M5/M7) — `task-pr-status-sync`
            // calls `syncDuePrStatuses()` here (allow-list auto-derived).
            TaskPrStatusService: this.taskPrStatusService,
            // Memory facts (AW-07) — `memory-fact-embed` calls `embedFact()`
            // and `memory-fact-gc` calls `sweep()` here (allow-list
            // auto-derived).
            MemoryFactEmbedService: this.memoryFactEmbedService,
            MemoryFactSweepService: this.memoryFactSweepService,
            // Model accounts (AW-16) — `model-account-health` calls
            // `probeDueAccounts()` here (allow-list auto-derived).
            ModelAccountHealthService: this.modelAccountHealthService,
            // Skills shelf — `skill-readiness-sweep` calls `sweepStale()`
            // here (allow-list auto-derived).
            SkillReadinessService: this.skillReadinessService,
            // APW-02 T28 — the App upstream trio. `AppUpstreamStateService` backs
            // the `app-fork-readiness` / `app-upstream-sync` jobs' claim and
            // probes, `AppUpstreamSyncDispatcherService` backs the
            // `app-upstream-sync-dispatcher` cron's `dispatchDue()`, and
            // `WorkUpstreamStateRepository` backs the sync run's read of the
            // epic's own row. Registered unconditionally as their sibling
            // services are: the controller's `callRemote` answers
            // "Unknown remote target" for a name that maps to `undefined`, which
            // is the loud answer a missing binding must have.
            AppUpstreamStateService: this.appUpstreamStateService,
            AppUpstreamSyncDispatcherService: this.appUpstreamSyncDispatcherService,
            WorkUpstreamStateRepository: this.workUpstreamStateRepository,
            // APW-03 T12/T13 — the worker side of `app-spec-evaluate`'s service
            // calls (`AppSpecService.evaluate` / `getEffectiveSpec` /
            // `validateDraft`), registered unconditionally for the same reason the
            // trio above is: a name that maps to nothing answers a loud
            // "Unknown remote target" instead of pretending.
            AppSpecService: this.appSpecService,
            // APW-06 T71 — the three names the isolated App runtime worker proxies. Registered
            // unconditionally, exactly as the App entries above are: a name that maps to `undefined`
            // answers a loud "Unknown remote target" rather than pretending, which is what an
            // operator needs when a provider is missing from the module graph.
            WorkDeploymentRepository: this.workDeploymentRepository,
            WorkCustomDomainRepository: this.workCustomDomainRepository,
            DistributedTaskLockService: this.distributedTaskLockService,
            // APW-05 T19 + C7 — the worker half of `app-build-prepare`. Registered
            // unconditionally for the same reason every App entry above is: a name
            // that maps to `undefined` answers a loud "Unknown remote target"
            // instead of pretending the prepare ran.
            AppBuildPrepareRunner: this.appBuildPrepareRunner,
            // APW-05 T20 + C17 — and the worker half of `app-build-watch`, same rule.
            AppBuildWatchRunner: this.appBuildWatchRunner,
            // C10 — and the worker half of `app-fork-readiness`. Registered
            // unconditionally for the same reason every App entry above is: a name that
            // maps to `undefined` answers a loud "Unknown remote target" instead of
            // pretending the readiness run happened. The run is resolved here because a
            // Trigger worker owns no `DataSource` and the readiness poll writes the state
            // row (FR-17…FR-24a) — the service's own `deps.sleep` cannot cross this hop,
            // which is what `AppForkReadinessRunner` exists to bridge.
            AppForkReadinessRunner: this.appForkReadinessRunner,
            // APW-01 T15 — the worker half of the ready hand-off. Registered
            // unconditionally for the same reason every App entry above is: a name that
            // maps to `undefined` answers a loud "Unknown remote target" instead of
            // pretending the source was recorded in the member's repository.
            AppSourceInitializerService: this.appSourceInitializerService,
            // AW-22 — `workspace-backup` calls `startFromPayload()` on the
            // runner, then `observeRun()` and `notifyFinished()` on the
            // service; the
            // `workspace-backup-sweeper` cron calls `runSweep()`
            // (allow-list auto-derived).
            WorkspaceBackupRunner: this.workspaceBackupRunner,
            WorkspaceBackupService: this.workspaceBackupService,
            WorkspaceBackupRepository: this.workspaceBackupRepository,
            ...(this.workProposalsApiService
                ? { WorkProposalsApiService: this.workProposalsApiService }
                : {}),
        };

        // C-05 RPC half: build a per-service allow-list of callable methods.
        // Only methods declared directly on the service class (or one of its
        // parents in the chain, excluding Object.prototype) are callable
        // via /internal/trigger/remote/call.
        this.allowedMethods = Object.fromEntries(
            Object.entries(this.remoteMap).map(([name, instance]) => [
                name,
                buildMethodAllowList(instance),
            ]),
        );
    }

    @Get('works/:id/context')
    @Public()
    async getWorkContext(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') workId: string,
        @Query('userId') userId: string,
    ): Promise<WorkContextResponse> {
        this.ensureSecret(secret);

        if (!userId) {
            throw new BadRequestException('Missing userId');
        }

        const { work } = await this.ownershipService.ensureAccess(workId, userId);

        const gitToken = await this.gitFacade.getAccessToken({
            userId,
            providerId: work.gitProvider,
            workId: work.id,
        });

        return {
            work: this.stripRelations(work),
            user: this.stripSensitiveUserData(work.user),
            gitToken: gitToken ?? undefined,
        };
    }

    @Post('remote/call')
    @Public()
    async callRemote(@Headers('x-trigger-secret') secret: string, @Body() body: RemoteCallDto) {
        this.ensureSecret(secret);

        // C-05 RPC half: hard input shape. We are NOT relying on Nest's
        // ValidationPipe alone — repeated locally so the security-critical
        // shape is obvious at the callsite.
        if (typeof body?.name !== 'string' || !METHOD_NAME_RE.test(body.name)) {
            throw new BadRequestException(`Invalid remote target: ${body?.name}`);
        }
        if (typeof body?.method !== 'string' || !METHOD_NAME_RE.test(body.method)) {
            throw new BadRequestException(`Invalid method: ${body?.method}`);
        }
        if (DANGEROUS_METHOD_NAMES.has(body.method)) {
            throw new BadRequestException(`Method not callable: ${body.method}`);
        }

        const instance = this.remoteMap[body.name];

        if (!instance) {
            throw new BadRequestException(`Unknown remote target: ${body.name}`);
        }

        // C-05 RPC half: enforce the per-service allow-list built at boot.
        // This is what stops the "arbitrary method on arbitrary service"
        // attack the audit flagged — any method not present in the
        // allow-list is rejected before we look up `fn`.
        const allowed = this.allowedMethods[body.name];
        if (!allowed || !allowed.has(body.method)) {
            throw new BadRequestException(
                `Method not in allow-list for ${body.name}: ${body.method}`,
            );
        }

        const fn = (instance as Record<string, unknown>)[body.method];

        if (typeof fn !== 'function') {
            throw new BadRequestException(`Unknown method: ${body.method}`);
        }

        // Security (deserialization): validate the SuperJSON envelope shape
        // before deserializing so a crafted `args` (extra top-level keys, a
        // non-object `meta`, or a `__proto__`/`constructor`/`prototype`
        // sentinel) cannot reach the deserializer. Legitimate callers always
        // send `{ json, meta? }` (SuperJSON's own output), so this is a no-op
        // for real traffic.
        assertSuperJsonEnvelope(body.args);

        // Deserialize args with SuperJSON (supports Date, Map, Set, etc.)
        const args = superjson.deserialize(body.args as any) as unknown[];

        const result = await (fn as (...a: unknown[]) => unknown).call(instance, ...args);

        // Serialize result with SuperJSON so the caller can restore rich types
        return { result: superjson.serialize(result) };
    }

    private ensureSecret(secret?: string) {
        const expectedSecret = config.trigger.getInternalSecret();

        if (!expectedSecret) {
            throw new ForbiddenException('Trigger internal secret is not configured');
        }

        // Constant-time comparison (C-05 / L-09). Always compares against an
        // equal-length buffer so the timing cost is uniform regardless of the
        // submitted secret's length — a naive `length !== length || compare`
        // short-circuit would let an attacker binary-search the secret length.
        if (typeof secret !== 'string' || secret.length === 0) {
            throw new ForbiddenException('Invalid trigger secret');
        }
        const expectedBuf = Buffer.from(expectedSecret, 'utf8');
        const providedBuf = Buffer.from(secret, 'utf8');
        const lengthsMatch = expectedBuf.length === providedBuf.length;
        const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
        const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);
        if (!lengthsMatch || !bytesMatch) {
            throw new ForbiddenException('Invalid trigger secret');
        }
    }

    // H-06: project an explicit allow-list of User fields. The previous
    // implementation dropped `password` and spread the rest — meaning OAuth
    // `accessToken`/`refreshToken` on `authAccounts` relations, password-reset
    // tokens, and email-verification tokens all flowed to the Trigger.dev worker.
    // The worker only needs identity + a handful of preference flags.
    private stripSensitiveUserData(user: User): WorkContextResponse['user'] {
        return {
            id: user.id,
            email: user.email,
            username: user.username,
            // Preserve the original shape the worker is typed against —
            // `JSON.parse(JSON.stringify(...))` here strips class metadata
            // and any field that happens to be `undefined`.
            ...JSON.parse(
                JSON.stringify({
                    avatar: user.avatar ?? null,
                    emailVerified: user.emailVerified,
                    isActive: user.isActive,
                    registrationProvider: user.registrationProvider,
                    isAnonymous: user.isAnonymous,
                    committerName: user.committerName ?? null,
                    committerEmail: user.committerEmail ?? null,
                }),
            ),
        } as WorkContextResponse['user'];
    }

    private stripRelations(work: Work) {
        const { user, ...rest } = work;
        return JSON.parse(JSON.stringify(rest));
    }
}
