jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class WorkRepository {},
    AuthAccountRepository: class AuthAccountRepository {},
    TemplateRepository: class TemplateRepository {},
    TemplateCustomizationRepository: class TemplateCustomizationRepository {},
    UserTemplatePreferenceRepository: class UserTemplatePreferenceRepository {},
    UserRepository: class UserRepository {},
    WorkKnowledgeDocumentRepository: class WorkKnowledgeDocumentRepository {},
    AgentRepository: class AgentRepository {},
    AgentRunRepository: class AgentRunRepository {},
    WorkUpstreamStateRepository: class WorkUpstreamStateRepository {},
    // APW-06 T71 — the two repositories the isolated App runtime worker proxies because it owns no
    // DataSource. Injection tokens here; the behaviour behind them lives in the agent package.
    WorkDeploymentRepository: class WorkDeploymentRepository {},
    WorkCustomDomainRepository: class WorkCustomDomainRepository {},
    // The worker git facade's installation reads (`trigger-facades.module.ts` proxies it).
    GitHubAppInstallationRepository: class GitHubAppInstallationRepository {},
}));
// APW-02 T28 — the controller imports the App upstream trio from the app-works
// barrel. Loading the real barrel pulls the whole epic's service graph (entities
// → TypeORM, facades → provider plugins) into this suite, so stub it exactly as
// every sibling barrel above is stubbed. The classes are only ever used as
// injection tokens here; the behaviour behind them is asserted where it lives
// (`packages/agent/src/app-works/__tests__/**`).
jest.mock('@ever-works/agent/app-works', () => ({
    AppUpstreamStateService: class AppUpstreamStateService {},
    AppUpstreamSyncDispatcherService: class AppUpstreamSyncDispatcherService {},
    // C10 — the readiness job's RPC target, stubbed for the same reason: the runner
    // reaches the readiness service, the state entity and the git facade, none of
    // which this suite needs in order to assert that the remote target is registered
    // and callable.
    AppForkReadinessRunner: class AppForkReadinessRunner {},
    // APW-01 T15 — the ready handler the readiness run calls once the repository has
    // content. Stubbed for the same reason again: the class reaches APW-03's
    // `AppSpecService`, the Activity writer and the git facade, none of which this
    // suite needs in order to assert the remote target is registered and callable.
    AppSourceInitializerService: class AppSourceInitializerService {},
}));
// APW-03 T12/T13 (wired by APW-02 T28) — same rationale: the app-spec barrel
// reaches the spec state entity and the git facade, neither of which this suite
// needs in order to assert that the remote target is registered.
jest.mock('@ever-works/agent/app-spec', () => ({
    AppSpecService: class AppSpecService {},
    AppSpecModule: class AppSpecModule {},
}));
// APW-05 T19 + C7 — same rationale again: the app-builds barrel reaches the build
// and preparation entities, the Activity writer and the git facade, none of which
// this suite needs in order to assert that the remote target is registered and
// reachable. The classes are injection tokens here only.
jest.mock('@ever-works/agent/app-builds', () => ({
    AppBuildPrepareRunner: class AppBuildPrepareRunner {},
    AppBuildWatchRunner: class AppBuildWatchRunner {},
    // APW-05 T21 — the `app-build-sweep` task's RPC target, stubbed for the same reason.
    AppBuildSweepService: class AppBuildSweepService {},
    AppBuildsModule: class AppBuildsModule {},
}));
// APW-06 §5.1 — the controller imports `AppDeployBuildSourceAdapter` from the app-runtime
// barrel as the Build source the isolated App runtime worker proxies. The real barrel reaches
// the Build entity, the render builder and the cluster facades, none of which this suite needs
// in order to assert that the remote target is registered and reachable; a token here only.
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppDeployBuildSourceAdapter: class AppDeployBuildSourceAdapter {},
}));
// FU-2 post-CI fix: trigger-internal.controller.ts imports the
// AgentScheduleDispatcherService from `@ever-works/agent/agents` and
// TaskRecurrenceDispatcherService from `@ever-works/agent/tasks-domain`
// (added by PR #1019). Loading those barrels transitively pulls in
// the entity classes which reference `@src/*` aliases that aren't
// mapped under the agent package's jest scope. Stub the barrels here
// to avoid the resolution chain.
jest.mock('@ever-works/agent/agents', () => ({
    AgentScheduleDispatcherService: class AgentScheduleDispatcherService {},
    AgentRunService: class AgentRunService {},
    AgentRunSweeperService: class AgentRunSweeperService {},
    // Wave 4 M2 — drain-on-terminal RPC target (run orchestration).
    RunDispatchGateService: class RunDispatchGateService {},
    // Streaming-terminal M9 / D1 — `terminal-transcript-gc` RPC target.
    TerminalTranscriptService: class TerminalTranscriptService {},
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TaskRecurrenceDispatcherService: class TaskRecurrenceDispatcherService {},
    TasksService: class TasksService {},
    TaskChatService: class TaskChatService {},
    TaskRunDenormService: class TaskRunDenormService {},
}));
// Named Conversations — the controller imports ConversationMessageService
// from the conversations barrel; stub it so the entity chain is never loaded.
jest.mock('@ever-works/agent/conversations', () => ({
    ConversationMessageService: class ConversationMessageService {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
    // APW-06 T71 — `app-health-poll`'s distributed guard, proxied by the worker
    // (`app-health-poll.task.ts`). A token here; the lock semantics live in the agent package.
    DistributedTaskLockService: class DistributedTaskLockService {},
}));
jest.mock('@ever-works/agent/work-operations', () => ({
    WorkOperationsService: class WorkOperationsService {},
}));
jest.mock('@ever-works/agent/tasks', () => ({}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
    WorkScheduleDispatcherService: class WorkScheduleDispatcherService {},
    WorkScheduleService: class WorkScheduleService {},
}));
jest.mock('@ever-works/agent/missions', () => ({
    MissionTickService: class MissionTickService {},
}));
// PR-4 — controller now imports IdeaBuildExecutorService from the
// work-agent barrel; mock it so the real barrel (which pulls
// database.config → `@src/config`, unresolvable under apps/api jest)
// is never loaded.
jest.mock('@ever-works/agent/work-agent', () => ({
    IdeaBuildExecutorService: class IdeaBuildExecutorService {},
}));
// PR-8 — the controller now imports GoalEvaluationService from the goals
// barrel. That barrel is the deepest chain yet: goals.service ->
// goal-evaluation.service -> facades/metrics.facade -> usage/plugin-usage.service,
// which imports `@src/database/repositories/plugin-usage.repository`. The
// `@src/*` alias belongs to BOTH packages, and apps/api's jest maps it to
// apps/api/src, where that module does not exist — so the suite died with
// "Could not locate module ... mapped as apps/api/src/$1" before a single test
// ran. Stub the barrel, same as every sibling above.
jest.mock('@ever-works/agent/goals', () => ({
    GoalEvaluationService: class GoalEvaluationService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    NotificationService: class NotificationService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class GitFacadeService {},
    NotificationChannelFacadeService: class NotificationChannelFacadeService {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRepository: class PluginRepository {},
    UserPluginRepository: class UserPluginRepository {},
    WorkPluginRepository: class WorkPluginRepository {},
    // EW-693 T27 (a6) — the worker's allowlist reads, exposed read-only.
    PluginAllowlistRepository: class PluginAllowlistRepository {},
}));
// Event-ingest spine (Wave 6) — the controller imports EventIngestService
// from the ingest barrel; stub it so the real barrel (entity chain →
// TypeORM under apps/api jest) is never loaded.
jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class EventIngestService {},
    EventSourcePullService: class EventSourcePullService {},
    EventIngestModule: class EventIngestModule {},
}));
// Digest briefings (Wave 7) — same rationale as the ingest stub above:
// the controller imports DigestService from the digest barrel.
jest.mock('@ever-works/agent/digest', () => ({
    DigestService: class DigestService {},
    DigestModule: class DigestModule {},
}));
// Credits ledger (pricing Wave 9 M1) — the controller imports
// CreditLedgerService from the subscriptions barrel; stub it so the real
// barrel (repositories → TypeORM entity chain) is never loaded.
jest.mock('@ever-works/agent/subscriptions', () => ({
    SubscriptionsModule: class SubscriptionsModule {},
    CreditLedgerService: class CreditLedgerService {},
}));
jest.mock('@ever-works/agent/model-routing', () => ({
    ModelAccountHealthService: class ModelAccountHealthService {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
}));
jest.mock('../data-sync/data-sync-dispatcher.service', () => ({
    DataSyncDispatcherService: class DataSyncDispatcherService {},
}));
jest.mock('../work-proposals/work-proposals.service', () => ({
    WorkProposalsApiService: class WorkProposalsApiService {},
}));

const getInternalSecretMock = jest.fn<string | undefined, []>();
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            getInternalSecret: () => getInternalSecretMock(),
        },
    },
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import superjson from 'superjson';
import { GitHubAppInstallationRepository } from '@ever-works/agent/database';
import { TriggerInternalController } from './trigger-internal.controller';

describe('TriggerInternalController', () => {
    const VALID_SECRET = 'super-secret-token';

    let workRepository: any;
    let ownershipService: any;
    let workOperationsService: any;
    let cacheManager: any;
    let scheduleDispatcher: any;
    let workScheduleService: any;
    let notificationService: any;
    let gitFacade: any;
    let pluginRepository: any;
    let userPluginRepository: any;
    let workPluginRepository: any;
    let authAccountRepository: any;
    let templateRepository: any;
    let templateCustomizationRepository: any;
    let userTemplatePreferenceRepository: any;
    let userRepository: any;
    let workKnowledgeDocumentRepository: any;
    let missionTickService: any;
    let agentRunService: any;
    let tasksService: any;
    let taskChatService: any;
    // APW-02 T28 — the App upstream trio the Trigger.dev worker reaches.
    let appUpstreamStateService: any;
    let appUpstreamSyncDispatcherService: any;
    let workUpstreamStateRepository: any;
    // APW-03 T12/T13 — the App spec service the worker's `app.spec.*` calls reach.
    let appSpecService: any;
    // APW-06 T71 — the three names the isolated App runtime worker proxies.
    let workDeploymentRepository: any;
    let workCustomDomainRepository: any;
    let distributedTaskLockService: any;
    // APW-05 T19 + C7 — the `app-build-prepare` job's runner, the name the worker
    // proxies because it owns no `DataSource`.
    let appBuildPrepareRunner: any;
    // APW-05 T20 + C17 — the pp-build-watch job's runner, the second half of the pair.
    let appBuildWatchRunner: any;
    // C10 — the `app-fork-readiness` job's runner: the readiness run writes the state
    // row, so it runs API-side and the worker proxies it by name.
    let appForkReadinessRunner: any;
    // APW-01 T15 — the ready handler behind that run's setup hand-off.
    let appSourceInitializerService: any;
    // APW-05 T21 — the `app-build-sweep` task's service: the passes write rows and
    // take the `app-builds:sweep` lock, so they run API-side.
    let appBuildSweepService: any;
    // APW-06 §5.1 — the Build source the isolated App runtime worker's
    // `APP_DEPLOY_BUILD_SOURCE` proxies: it reads `work_builds`, so it runs API-side.
    let appDeployBuildSourceAdapter: any;
    // EW-693 T27 (a6) — the allowlist repository behind the worker's read-only
    // `PluginAllowlistReader`.
    let pluginAllowlistRepository: any;
    // The worker git facade's installation reads (`trigger-facades.module.ts`); unbound
    // unless a case sets it.
    let gitHubAppInstallationRepository: any;
    let controller: TriggerInternalController;

    const buildController = () => {
        const c = new TriggerInternalController(
            workRepository,
            ownershipService,
            workOperationsService,
            cacheManager,
            scheduleDispatcher,
            workScheduleService,
            notificationService,
            gitFacade,
            pluginRepository,
            userPluginRepository,
            workPluginRepository,
            authAccountRepository,
            templateRepository,
            templateCustomizationRepository,
            userTemplatePreferenceRepository,
            userRepository,
            undefined, // dataSyncDispatcher
            undefined, // deployReadyPoller
            workKnowledgeDocumentRepository,
            missionTickService,
            // PR-4 — ideaBuildExecutorService (idea-build-execute task).
            // Not exercised by these tests; undefined is sufficient.
            undefined, // ideaBuildExecutorService
            undefined, // goalEvaluationService
            // Agents/Skills/Tasks PR #1017 — Phase 6 + 17 added 4 new
            // constructor args after missionTickService; tests pass
            // undefined since they don't exercise these paths.
            undefined, // agentScheduleDispatcherService
            agentRunService,
            undefined, // agentRepositoryRef
            undefined, // agentRunRepositoryRef
            undefined, // taskRecurrenceDispatcherService
            tasksService,
            taskChatService,
            undefined, // taskWorkspaceService (Wave 2 — not exercised here)
            undefined, // taskRunDenormService (kanban run cockpit — not exercised here)
            undefined, // notificationChannelFacade
            // EW-742 P3.2 T22 — three new constructor args added by PRs
            // bbc24309 / 5e4e2483 / 41906b71 to expose the worker-host
            // tenant-resolver dependencies through the remote-proxy
            // controller. None of the test cases below exercise these
            // paths, so passing `undefined` is sufficient.
            undefined, // credentialVersionService
            undefined, // organizationRepository
            undefined, // webhookSubscriptionRepository
            // EW-617 G2 / EW-643 - two new constructor args exposing the
            // anonymous-user-cleanup + kb-reconcile services through the
            // remote-proxy controller. Not exercised by these tests.
            undefined, // anonymousUserCleanupService
            undefined, // knowledgeBaseReconcileService
            undefined, // workProposalsApiService (Optional trailing)
            undefined, // agentRunSweeperService (Optional trailing)
            // Wave 3 M2 — quality gates. Not exercised by these tests.
            undefined, // taskGateRunnerService (Optional trailing)
            // Every remaining optional between the gate runner and the APW-02 trio.
            // 🛑 They are positional: stopping at `taskGateRunnerService` would land the
            // three values below on `runDispatchGateService`/`eventIngestService`/
            // `digestService`, and the failures would look like a missing remoteMap entry
            // rather than a shifted argument list (this is exactly how the first draft of
            // this spec failed).
            undefined, // runDispatchGateService
            undefined, // eventIngestService
            undefined, // digestService
            undefined, // creditLedgerService
            undefined, // eventSourcePullService
            undefined, // terminalTranscriptService
            undefined, // fleetJobService
            undefined, // agentEscalationService
            undefined, // taskReviewRejectionService
            undefined, // memoryConsolidationScheduleService
            undefined, // taskPrStatusService
            undefined, // taskGateJudgeService
            undefined, // goalOrchestratorService
            undefined, // creditsSweepService
            undefined, // paygService
            undefined, // modelAccountHealthService
            undefined, // conversationMessageService
            undefined, // skillReadinessService
            undefined, // rosterProvisioningService
            undefined, // memoryFactEmbedService
            undefined, // memoryFactSweepService
            // AW-22 (develop) — the workspace-backup trio. Not exercised by these
            // tests, but POSITIONAL: they sit between `memoryFactSweepService` and
            // the App Works block in the constructor, so omitting them here would
            // land the App values three slots early. See the constructor's own
            // note for why this order and not the other.
            undefined, // workspaceBackupRunner
            undefined, // workspaceBackupService
            undefined, // workspaceBackupRepository
            // APW-02 T28 — the App upstream trio, appended LAST + `@Optional()` per
            // the arity rule above.
            appUpstreamStateService,
            appUpstreamSyncDispatcherService,
            workUpstreamStateRepository,
            // APW-03 T12/T13 — the App spec service (wired by APW-02 T28).
            appSpecService,
            // APW-06 T71 — the three names the isolated App runtime worker proxies, appended
            // LAST + `@Optional()` per the arity rule above.
            workDeploymentRepository,
            workCustomDomainRepository,
            distributedTaskLockService,
            // APW-05 T19 + C7 — the `app-build-prepare` runner, appended LAST + `@Optional()`
            // per the arity rule above.
            appBuildPrepareRunner,
            // APW-05 T20 + C17 — and the `app-build-watch` runner after it, same rule.
            appBuildWatchRunner,
            // C10 — the `app-fork-readiness` runner, appended LAST + `@Optional()` per the
            // arity rule above.
            appForkReadinessRunner,
            // APW-01 T15 — the ready handler, appended after it, same rule.
            appSourceInitializerService,
            // APW-05 T21 — the Builds sweep, appended LAST, same rule.
            appBuildSweepService,
            // APW-06 §5.1 — the worker's Build source, appended after it, same rule.
            appDeployBuildSourceAdapter,
            // EW-693 T27 (a6) — the allowlist repository, appended after it, same rule.
            pluginAllowlistRepository,
            // The worker git facade's installation reads, appended LAST, same rule.
            gitHubAppInstallationRepository,
        );
        c.onModuleInit();
        return c;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        getInternalSecretMock.mockReturnValue(VALID_SECRET);

        workRepository = { name: 'WorkRepository' };
        ownershipService = { ensureAccess: jest.fn() };
        workOperationsService = { name: 'WorkOperationsService' };
        cacheManager = { name: 'CacheManager' };
        scheduleDispatcher = { name: 'WorkScheduleDispatcherService' };
        workScheduleService = { name: 'WorkScheduleService' };
        notificationService = { name: 'NotificationService' };
        gitFacade = { getAccessToken: jest.fn() };
        pluginRepository = { name: 'PluginRepository', echo: jest.fn((v: string) => `echo:${v}`) };
        userPluginRepository = { name: 'UserPluginRepository' };
        workPluginRepository = { name: 'WorkPluginRepository' };
        authAccountRepository = { name: 'AuthAccountRepository' };
        templateRepository = { name: 'TemplateRepository' };
        userTemplatePreferenceRepository = { name: 'UserTemplatePreferenceRepository' };
        workKnowledgeDocumentRepository = { name: 'WorkKnowledgeDocumentRepository' };
        missionTickService = { name: 'MissionTickService', tickDue: jest.fn() };
        agentRunService = { name: 'AgentRunService', execute: jest.fn() };
        tasksService = { name: 'TasksService', getOne: jest.fn() };
        taskChatService = { name: 'TaskChatService', list: jest.fn() };
        // APW-02 T28 — each double carries ONE real method, because "registered in
        // the map" is only half the claim: the RPC hop must reach the method.
        appUpstreamStateService = {
            name: 'AppUpstreamStateService',
            beginSync: jest.fn((workId: string, trigger: string) => ({
                allowed: true,
                reason: null,
                startedAt: `${trigger}:${workId}`,
            })),
        };
        appUpstreamSyncDispatcherService = {
            name: 'AppUpstreamSyncDispatcherService',
            dispatchDue: jest.fn((now: number) => ({ dueCount: 1, dispatched: 1, at: now })),
        };
        workUpstreamStateRepository = {
            name: 'WorkUpstreamStateRepository',
            findByWorkId: jest.fn((workId: string) => ({ workId, relation: 'fork' })),
        };
        appSpecService = {
            name: 'AppSpecService',
            getEffectiveSpec: jest.fn((workId: string) => ({ workId, status: 'valid' })),
        };
        // APW-06 T71 — each double carries ONE real method, for the same reason the APW-02 trio's
        // do: "registered in the map" is only half the claim, the RPC hop must reach the method.
        workDeploymentRepository = {
            name: 'WorkDeploymentRepository',
            markTerminal: jest.fn((id: string, state: string, fields?: unknown) => ({
                id,
                state,
                fields,
            })),
        };
        workCustomDomainRepository = {
            name: 'WorkCustomDomainRepository',
            // The real method (`work-custom-domain.repository.ts:210`), not a plausible-looking
            // name: this double stands in for the API's own repository over the RPC hop.
            findByWork: jest.fn((workId: string) => [{ workId, domain: 'app.example.test' }]),
        };
        distributedTaskLockService = {
            name: 'DistributedTaskLockService',
            isLocked: jest.fn((key: string) => key === 'app-health-poll'),
        };
        // APW-05 T19 + C7 — the real method the RPC hop must reach (`run`, the one
        // member `AppBuildPrepareRunnerSeam` declares), not a plausible-looking name.
        appBuildPrepareRunner = {
            name: 'AppBuildPrepareRunner',
            run: jest.fn((payload: { workId: string; reason: string }) => ({
                status: 'prepared',
                workId: payload.workId,
                reason: payload.reason,
            })),
        };
        appBuildWatchRunner = {
            name: 'AppBuildWatchRunner',
            run: jest.fn((payload: { buildId: string; reason: string }) => ({
                status: 'observed',
                buildId: payload.buildId,
                reason: payload.reason,
            })),
        };
        // C10 — the real method the RPC hop must reach (`run`, the one member the
        // worker's seam declares). The readiness run writes the state row, so it is the
        // API process that performs it.
        appForkReadinessRunner = {
            name: 'AppForkReadinessRunner',
            run: jest.fn((payload: { workId: string; attempt?: number; reason?: string }) => ({
                workId: payload.workId,
                attempt: payload.attempt ?? 1,
                outcome: 'not_found',
                reason: 'state_not_found',
                probes: 0,
                sleeps: [],
                elapsedMs: 0,
            })),
        };
        // APW-01 T15 — the real method the RPC hop must reach (`onDataRepositoryReady`,
        // the one member `AppForkReadyHandler` declares). The handler creates the App
        // spec state row, records the source and runs the follow-ups, none of which a
        // worker can do — so the API process performs it.
        appSourceInitializerService = {
            name: 'AppSourceInitializerService',
            onDataRepositoryReady: jest.fn((payload: { workId: string }) => ({
                result: 'failed',
                reason: payload.workId === 'work-1' ? 'spec_state_unavailable' : 'work_not_found',
            })),
        };

        // APW-05 T21 — the real method the RPC hop must reach (`runSweep`, the one
        // member the task's seam declares). The API reads its own clock, so the
        // worker sends no argument. `sweep` (the lock-free body) and `lostPass` stand
        // for the rest of the real class's prototype — public or TS-private, all of it
        // function-valued — which a prototype-derived allow-list would publish.
        appBuildSweepService = {
            name: 'AppBuildSweepService',
            runSweep: jest.fn(() => ({ skipped: null, redriveRequested: 1, lostMarked: 0 })),
            sweep: jest.fn(),
            lostPass: jest.fn(),
        };

        // APW-06 §5.1 — the two reads `AppDeployBuildSource` declares, and nothing else:
        // `getBuild` (the Build a Deployment names) and `listDeployableBuilds` (the Work's
        // green deployable Builds, newest first).
        appDeployBuildSourceAdapter = {
            name: 'AppDeployBuildSourceAdapter',
            getBuild: jest.fn((workId: string, buildId: string) => ({
                id: buildId,
                commitSha: `${workId}-sha`,
                status: 'succeeded',
                trigger: 'push',
                imageReference: 'ghcr.io/acme/app@sha256:abc',
            })),
            listDeployableBuilds: jest.fn(() => []),
        };

        // EW-693 T27 (a6) — a whole repository, writes included: the reader
        // must expose only `findByPackageName`.
        pluginAllowlistRepository = {
            name: 'PluginAllowlistRepository',
            findByPackageName: jest.fn((packageName: string) =>
                packageName === '@acme/cool-plugin'
                    ? { packageName, versionRange: '^2.0.0', enabled: true, source: 'npm' }
                    : null,
            ),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };
        gitHubAppInstallationRepository = undefined;

        controller = buildController();
    });

    describe('getWorkContext', () => {
        const baseUser = { id: 'user-1', password: 'hashed-secret', email: 'u@e.test' };
        const baseWork = {
            id: 'work-1',
            gitProvider: 'github',
            user: baseUser,
            description: 'A work',
        };

        it('returns context with stripped relations and stripped user password + git token', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue('gh-token');

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect(ownershipService.ensureAccess).toHaveBeenCalledWith('work-1', 'user-1');
            expect(gitFacade.getAccessToken).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
                workId: 'work-1',
            });
            // user relation stripped from work
            expect((result.work as any).user).toBeUndefined();
            expect((result.work as any).id).toBe('work-1');
            // password stripped from user
            expect((result.user as any).password).toBeUndefined();
            expect((result.user as any).id).toBe('user-1');
            expect(result.gitToken).toBe('gh-token');
        });

        it('returns gitToken=undefined when GitFacade returns null', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue(null);

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect(result.gitToken).toBeUndefined();
        });

        it('throws BadRequestException when userId is missing', async () => {
            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', undefined as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.getWorkContext(VALID_SECRET, 'work-1', '')).rejects.toThrow(
                'Missing userId',
            );
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('throws ForbiddenException when secret is missing or wrong', async () => {
            await expect(controller.getWorkContext('', 'work-1', 'user-1')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(controller.getWorkContext('wrong', 'work-1', 'user-1')).rejects.toThrow(
                'Invalid trigger secret',
            );
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        // C-05 / L-09: `ensureSecret` performs constant-time comparison with a
        // length-padded buffer so equal-length AND unequal-length submissions
        // both reach `timingSafeEqual`. A naive `length-only` short-circuit
        // would leak the secret length to an attacker; this test asserts that
        // a same-length-but-wrong secret is still rejected. The constant-time
        // property itself is not observable in JS — but rejecting a same-length
        // mismatch confirms the byte-comparison path is wired correctly and
        // that we are NOT accidentally accepting a wrong secret just because
        // the lengths happened to match.
        it('rejects same-length wrong secret in constant time (no early length-leak)', async () => {
            // VALID_SECRET = 'super-secret-token' is 18 chars. Build a
            // same-length wrong secret so we exercise the equal-length branch
            // of the timingSafeEqual comparison.
            const wrongSameLength = 'aaaaaaaaaaaaaaaaaa';
            expect(wrongSameLength).toHaveLength(VALID_SECRET.length);
            expect(wrongSameLength).not.toBe(VALID_SECRET);

            await expect(
                controller.getWorkContext(wrongSameLength, 'work-1', 'user-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            await expect(
                controller.getWorkContext(wrongSameLength, 'work-1', 'user-1'),
            ).rejects.toThrow('Invalid trigger secret');

            // And the same property holds on the RPC entrypoint.
            await expect(
                controller.callRemote(wrongSameLength, {
                    name: 'PluginRepository',
                    method: 'echo',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toBeInstanceOf(ForbiddenException);

            // Critically: NO downstream side-effects should run on a wrong
            // secret, regardless of length.
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('throws ForbiddenException when no internal secret is configured', async () => {
            getInternalSecretMock.mockReturnValue(undefined);

            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            await expect(
                controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1'),
            ).rejects.toThrow('Trigger internal secret is not configured');
        });

        it('does not strip non-user relations', async () => {
            (ownershipService.ensureAccess as jest.Mock).mockResolvedValue({
                work: { ...baseWork, items: [{ id: 'i1' }] },
            });
            (gitFacade.getAccessToken as jest.Mock).mockResolvedValue(undefined);

            const result = await controller.getWorkContext(VALID_SECRET, 'work-1', 'user-1');

            expect((result.work as any).items).toEqual([{ id: 'i1' }]);
            expect(result.gitToken).toBeUndefined();
        });
    });

    describe('callRemote', () => {
        const buildBody = (
            overrides: Partial<{
                name: string;
                method: string;
                args: unknown[];
            }> = {},
        ) => {
            const args = overrides.args ?? [];
            return {
                name: overrides.name ?? 'PluginRepository',
                method: overrides.method ?? 'echo',
                args: superjson.serialize(args) as any,
            };
        };

        it('dispatches to the registered remote target/method and returns superjson-serialized result', async () => {
            const echoSpy = jest.spyOn(pluginRepository, 'echo');

            const out = await controller.callRemote(VALID_SECRET, buildBody({ args: ['hello'] }));

            expect(echoSpy).toHaveBeenCalledWith('hello');
            const deserialized = superjson.deserialize(out.result as any);
            expect(deserialized).toBe('echo:hello');
        });

        it('preserves rich types via superjson (Date round-trip)', async () => {
            const fixedDate = new Date('2026-05-07T12:00:00.000Z');
            (pluginRepository as any).withDate = jest.fn(async (d: Date) => {
                expect(d).toBeInstanceOf(Date);
                expect(d.toISOString()).toBe(fixedDate.toISOString());
                return d;
            });
            // C-05: the per-service allow-list is built in onModuleInit by
            // walking the instance's prototype chain. We added `withDate` to
            // the stub instance AFTER the beforeEach-built controller, so we
            // need a fresh controller instance for the allow-list to include it.
            controller = buildController();

            const out = await controller.callRemote(VALID_SECRET, {
                name: 'PluginRepository',
                method: 'withDate',
                args: superjson.serialize([fixedDate]) as any,
            });

            const deserialized = superjson.deserialize(out.result as any) as Date;
            expect(deserialized).toBeInstanceOf(Date);
            expect(deserialized.toISOString()).toBe(fixedDate.toISOString());
        });

        it('throws BadRequestException for unknown remote target', async () => {
            await expect(
                controller.callRemote(VALID_SECRET, buildBody({ name: 'NotARealTarget' })),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.callRemote(VALID_SECRET, buildBody({ name: 'NotARealTarget' })),
            ).rejects.toThrow('Unknown remote target: NotARealTarget');
        });

        // C-05: unknown methods are now rejected by the per-service allow-list
        // (built at onModuleInit from the instance's own prototype chain) BEFORE
        // we reach the `typeof fn !== 'function'` check. The allow-list error
        // names the service so an operator can see which target rejected the
        // call.
        it('throws BadRequestException for unknown method on a known target (allow-list)', async () => {
            await expect(
                controller.callRemote(
                    VALID_SECRET,
                    buildBody({ name: 'PluginRepository', method: 'doesNotExist' }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.callRemote(
                    VALID_SECRET,
                    buildBody({ name: 'PluginRepository', method: 'doesNotExist' }),
                ),
            ).rejects.toThrow('Method not in allow-list for PluginRepository: doesNotExist');
        });

        // The worker's `LocalPluginStore` answers `mergeLazyRegistration` (every lazy
        // plugin registration's row write) in memory; a worker that dialled it would
        // pay a round trip per discovered plugin per run. So it is refused here even
        // though the derived allow-list would otherwise hold every repository method.
        it('refuses PluginRepository.mergeLazyRegistration — the worker writes that row locally', async () => {
            const merge = jest.fn();
            (pluginRepository as any).mergeLazyRegistration = merge;
            controller = buildController();

            await expect(
                controller.callRemote(
                    VALID_SECRET,
                    buildBody({
                        name: 'PluginRepository',
                        method: 'mergeLazyRegistration',
                        args: [{ pluginId: 'p', version: '1.0.0' }, {}],
                    }),
                ),
            ).rejects.toThrow(
                'Method not in allow-list for PluginRepository: mergeLazyRegistration',
            );
            expect(merge).not.toHaveBeenCalled();
            // The target's other methods stay callable.
            const out = await controller.callRemote(VALID_SECRET, buildBody({ args: ['still'] }));
            expect(superjson.deserialize(out.result as any)).toBe('echo:still');
        });

        it('throws ForbiddenException with wrong secret (and never invokes the remote)', async () => {
            const echoSpy = jest.spyOn(pluginRepository, 'echo');

            await expect(
                controller.callRemote('wrong', buildBody({ args: ['x'] })),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(echoSpy).not.toHaveBeenCalled();
        });

        it('exposes all 10 expected remote targets after onModuleInit', async () => {
            const expectedTargets = [
                'AuthAccountRepository',
                'PluginRepository',
                'UserPluginRepository',
                'WorkPluginRepository',
                'WorkOperationsService',
                'NotificationService',
                'WorkRepository',
                'CacheManager',
                'WorkScheduleDispatcherService',
                'WorkScheduleService',
            ];

            for (const target of expectedTargets) {
                // C-05: each target's allow-list is built independently so the
                // service name is interpolated into the rejection.
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name: target,
                        method: 'doesNotExist',
                        args: superjson.serialize([]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for ${target}: doesNotExist`);
            }
        });

        it('builds remoteMap fresh on each onModuleInit (no shared state across instances)', async () => {
            const second = buildController();
            (second as any).pluginRepository = { name: 'second' };
            // each controller instance has its own remoteMap pointing at its own injections
            expect((controller as any).remoteMap).not.toBe((second as any).remoteMap);
            expect((controller as any).remoteMap.PluginRepository).toBe(pluginRepository);
        });

        // -------------------------------------------------------------------
        // APW-02 T28 — the App upstream trio
        // -------------------------------------------------------------------

        it('registers the three APW-02 remote targets in remoteMap', () => {
            const map = (controller as any).remoteMap;

            expect(map.AppUpstreamStateService).toBe(appUpstreamStateService);
            expect(map.AppUpstreamSyncDispatcherService).toBe(appUpstreamSyncDispatcherService);
            expect(map.WorkUpstreamStateRepository).toBe(workUpstreamStateRepository);
        });

        it('derives a callable allow-list for each of the three (an unknown method is named)', async () => {
            // `callRemote` answers "Unknown remote target" for a name that is absent and
            // "Method not in allow-list for <name>" for a name that IS registered — so the
            // second message is the proof of registration, not the first.
            for (const name of [
                'AppUpstreamStateService',
                'AppUpstreamSyncDispatcherService',
                'WorkUpstreamStateRepository',
            ]) {
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name,
                        method: 'doesNotExist',
                        args: superjson.serialize([]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for ${name}: doesNotExist`);
            }
        });

        it('reaches beginSync on the state service over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppUpstreamStateService',
                method: 'beginSync',
                args: superjson.serialize(['work-1', 'manual']) as any,
            });

            expect(appUpstreamStateService.beginSync).toHaveBeenCalledWith('work-1', 'manual');
            expect(superjson.deserialize(response.result as any)).toEqual({
                allowed: true,
                reason: null,
                startedAt: 'manual:work-1',
            });
        });

        it('reaches dispatchDue on the dispatcher and findByWorkId on the repository', async () => {
            const dispatchDue = await controller.callRemote(VALID_SECRET, {
                name: 'AppUpstreamSyncDispatcherService',
                method: 'dispatchDue',
                args: superjson.serialize([1_700_000_000_000]) as any,
            });
            const findByWorkId = await controller.callRemote(VALID_SECRET, {
                name: 'WorkUpstreamStateRepository',
                method: 'findByWorkId',
                args: superjson.serialize(['work-1']) as any,
            });

            expect(appUpstreamSyncDispatcherService.dispatchDue).toHaveBeenCalledWith(
                1_700_000_000_000,
            );
            expect(superjson.deserialize(dispatchDue.result as any)).toEqual({
                dueCount: 1,
                dispatched: 1,
                at: 1_700_000_000_000,
            });
            expect(superjson.deserialize(findByWorkId.result as any)).toEqual({
                workId: 'work-1',
                relation: 'fork',
            });
        });

        it('registers AppSpecService so the worker’s app.spec.* calls reach the API', async () => {
            // APW-03 T12/T13, wired by APW-02 T28: without this entry the worker's
            // proxy answers `Unknown remote target: AppSpecService`.
            expect((controller as any).remoteMap.AppSpecService).toBe(appSpecService);

            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppSpecService',
                method: 'getEffectiveSpec',
                args: superjson.serialize(['work-1']) as any,
            });

            expect(appSpecService.getEffectiveSpec).toHaveBeenCalledWith('work-1');
            expect(superjson.deserialize(response.result as any)).toEqual({
                workId: 'work-1',
                status: 'valid',
            });
        });
    });

    // -------------------------------------------------------------------
    // APW-06 T71 — the isolated App runtime worker's remote names
    // -------------------------------------------------------------------

    /**
     * `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts` proxies exactly
     * these three names because it owns no `DataSource`. A name the controller does not carry
     * answers `Unknown remote target: <name>` — in production, on the run that needed it — so the
     * registration is pinned here rather than trusted, the same reason the APW-02 trio is.
     */
    describe('the APW-06 T71 App runtime remote targets', () => {
        const T71_TARGETS = [
            'WorkDeploymentRepository',
            'WorkCustomDomainRepository',
            'DistributedTaskLockService',
        ];

        it('registers all three in remoteMap', () => {
            const map = (controller as any).remoteMap;

            expect(map.WorkDeploymentRepository).toBe(workDeploymentRepository);
            expect(map.WorkCustomDomainRepository).toBe(workCustomDomainRepository);
            expect(map.DistributedTaskLockService).toBe(distributedTaskLockService);
        });

        it('derives a callable allow-list for each (an unknown method is named)', async () => {
            for (const name of T71_TARGETS) {
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name,
                        method: 'doesNotExist',
                        args: superjson.serialize([]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for ${name}: doesNotExist`);
            }
        });

        it('reaches markTerminal on the deployment repository over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'WorkDeploymentRepository',
                method: 'markTerminal',
                args: superjson.serialize([
                    'deployment-1',
                    'ERROR',
                    { lastError: 'worker_failed: boom' },
                ]) as any,
            });

            expect(workDeploymentRepository.markTerminal).toHaveBeenCalledWith(
                'deployment-1',
                'ERROR',
                { lastError: 'worker_failed: boom' },
            );
            expect(superjson.deserialize(response.result as any)).toEqual({
                id: 'deployment-1',
                state: 'ERROR',
                fields: { lastError: 'worker_failed: boom' },
            });
        });

        it('reaches isLocked on the distributed lock service over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'DistributedTaskLockService',
                method: 'isLocked',
                args: superjson.serialize(['app-health-poll']) as any,
            });

            expect(distributedTaskLockService.isLocked).toHaveBeenCalledWith('app-health-poll');
            expect(superjson.deserialize(response.result as any)).toBe(true);
        });

        /**
         * The arity rule, asserted structurally instead of described in a comment.
         *
         * Nest records `@Optional()` as the **indices** it decorates — `OPTIONAL_DEPS_METADATA`,
         * whose value in `@nestjs/common` is the literal `'optional:paramtypes'` (the plain
         * `'optional'` spelling reads as `[]`, which is how this assertion was verified to be
         * live rather than vacuous). This is the decorator's own metadata, not a restatement of
         * it. The three indices must be the LAST three constructor parameters: that is what keeps
         * every positional `new TriggerInternalController(...)` in this file (and any other
         * caller) compiling.
         */
        it('appends the three dependencies LAST and as @Optional()', () => {
            const paramTypes: unknown[] =
                Reflect.getMetadata('design:paramtypes', TriggerInternalController) ?? [];
            const optionalIndices: number[] =
                Reflect.getMetadata('optional:paramtypes', TriggerInternalController) ?? [];

            const last = paramTypes.length - 1;

            expect(paramTypes.length).toBeGreaterThan(3);
            for (const index of [last - 2, last - 1, last]) {
                expect(optionalIndices).toContain(index);
            }
            // And nothing after them: the three are the tail, so a mid-list insertion cannot pass.
            expect(Math.max(...optionalIndices)).toBe(last);
        });
    });

    // -------------------------------------------------------------------
    // APW-05 T19 + C7 — the `app-build-prepare` job's remote target
    // -------------------------------------------------------------------

    /**
     * `packages/tasks/src/tasks/trigger/app-build-prepare.task.ts` proxies exactly this
     * name, because a Trigger worker owns no `DataSource` and the prepare writes rows,
     * takes the §7.2 lock and publishes Activity. T19 landed the runner, the job and
     * the module binding, and reported this registration by name: with the name absent
     * here the proxy's call rejects and the run reports `status: 'failed'`,
     * `reason: 'runnerUnavailable'` — visible, but the QUEUED path would never work,
     * and §7.1's in-process fallback would hide the gap on the local stack only.
     */
    describe('the APW-05 T19 app-build-prepare remote target', () => {
        it('registers AppBuildPrepareRunner so the queued prepare can run at all', () => {
            expect((controller as any).remoteMap.AppBuildPrepareRunner).toBe(appBuildPrepareRunner);
        });

        it('reaches `run` — the one member the task’s seam declares — over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppBuildPrepareRunner',
                method: 'run',
                args: superjson.serialize([
                    { workId: 'work-1', buildId: 'build-1', reason: 'specApplied' },
                ]) as any,
            });

            expect(appBuildPrepareRunner.run).toHaveBeenCalledWith({
                workId: 'work-1',
                buildId: 'build-1',
                reason: 'specApplied',
            });
            expect(superjson.deserialize(response.result as any)).toEqual({
                status: 'prepared',
                workId: 'work-1',
                reason: 'specApplied',
            });
        });

        it('derives a callable allow-list holding `run` and naming an unknown method', async () => {
            // Half the claim is that the name is registered; the other half is that the
            // ONE method the worker calls is callable through it and that the entry is not
            // a blanket proxy for the runner's internals. The allow-list is a `Set` per
            // service (`buildMethodAllowList`), so it is read as one.
            expect([
                ...((controller as any).allowedMethods.AppBuildPrepareRunner as Set<string>),
            ]).toEqual(['run']);

            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'AppBuildPrepareRunner',
                    method: 'doesNotExist',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow('Method not in allow-list for AppBuildPrepareRunner: doesNotExist');
        });
    });

    /**
     * APW-05 T20 + C17 — the same two claims for the watch half.
     *
     * The watch job resolves its runner over this channel for the same reason the prepare
     * job does (a Trigger worker owns no `DataSource`, and an observation writes rows,
     * publishes the `app.build.*` events and deletes the per-run prompted secret), so the
     * name must be registered AND callable. A missing entry is not silent — it is
     * `Unknown remote target: AppBuildWatchRunner` on the run that needed it — but it would
     * only be discovered when a Build needed observing, which is the kind of gap this
     * programme pins in a spec instead of waiting for.
     */
    describe('the APW-05 T20 app-build-watch remote target', () => {
        it('registers AppBuildWatchRunner so the queued observation can run at all', () => {
            expect((controller as any).remoteMap.AppBuildWatchRunner).toBe(appBuildWatchRunner);
        });

        it('reaches `run` — the one member the task’s seam declares — over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppBuildWatchRunner',
                method: 'run',
                args: superjson.serialize([{ buildId: 'build-1', reason: 'event' }]) as any,
            });

            expect(appBuildWatchRunner.run).toHaveBeenCalledWith({
                buildId: 'build-1',
                reason: 'event',
            });
            expect(superjson.deserialize(response.result as any)).toEqual({
                status: 'observed',
                buildId: 'build-1',
                reason: 'event',
            });
        });

        it('derives a callable allow-list holding `run` and naming an unknown method', async () => {
            expect([
                ...((controller as any).allowedMethods.AppBuildWatchRunner as Set<string>),
            ]).toEqual(['run']);

            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'AppBuildWatchRunner',
                    method: 'doesNotExist',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow('Method not in allow-list for AppBuildWatchRunner: doesNotExist');
        });
    });

    // -------------------------------------------------------------------
    // C10 — the `app-fork-readiness` job's remote target
    // -------------------------------------------------------------------

    /**
     * `packages/tasks/src/tasks/trigger/app-fork-readiness.task.ts` proxies exactly this
     * name, and for a reason none of its siblings share: `AppForkReadinessService.run`
     * takes a `deps.sleep` **function**, and `createRemoteProxy` serialises arguments
     * with SuperJSON (`remote-proxy.ts:93-96`), which cannot carry one. The runner
     * supplies the real timer API-side, so the worker's payload is the only thing that
     * crosses the hop — and `run` is the whole surface it needs.
     *
     * This is the half C10 measured as missing: before it there was no
     * `app-fork-readiness` job at all, so a fork create left the row at
     * `readinessReason = 'dispatch_unavailable'` and an App Work could never reach
     * `ready`. A missing entry is not silent — it is
     * `Unknown remote target: AppForkReadinessRunner` on the run that needed it — which
     * is why the registration and the callability are asserted together here.
     */
    describe('the C10 app-fork-readiness remote target', () => {
        it('registers AppForkReadinessRunner so the queued readiness run can happen at all', () => {
            expect((controller as any).remoteMap.AppForkReadinessRunner).toBe(
                appForkReadinessRunner,
            );
        });

        it('reaches `run` — the one member the task’s seam declares — over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppForkReadinessRunner',
                method: 'run',
                args: superjson.serialize([
                    { workId: 'work-1', attempt: 1, reason: 'initial' },
                ]) as any,
            });

            expect(appForkReadinessRunner.run).toHaveBeenCalledWith({
                workId: 'work-1',
                attempt: 1,
                reason: 'initial',
            });
            // The service's own answer, passed through untouched: a readiness attempt
            // that finds no state row is `not_found`/`state_not_found`, NOT a transport
            // failure and not a green run.
            expect(superjson.deserialize(response.result as any)).toEqual({
                workId: 'work-1',
                attempt: 1,
                outcome: 'not_found',
                reason: 'state_not_found',
                probes: 0,
                sleeps: [],
                elapsedMs: 0,
            });
        });

        it('derives a callable allow-list holding `run` and naming an unknown method', async () => {
            // The allow-list is what keeps the entry from being a blanket proxy for the
            // runner's internals (C-05's half of the RPC contract).
            expect([
                ...((controller as any).allowedMethods.AppForkReadinessRunner as Set<string>),
            ]).toEqual(['run']);

            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'AppForkReadinessRunner',
                    method: 'doesNotExist',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow('Method not in allow-list for AppForkReadinessRunner: doesNotExist');
        });
    });

    /**
     * APW-05 T21 (first slice) — `packages/tasks/src/tasks/trigger/app-build-sweep.task.ts`
     * proxies exactly this name, because a Trigger worker owns no `DataSource` and the
     * sweep's passes write `work_builds`, take the `app-builds:sweep` lock (a callback,
     * which cannot cross the hop — so `runSweep` takes it API-side) and finalise a lost
     * Build through the Activity writer. With the name absent the proxy's call rejects
     * with `Unknown remote target: AppBuildSweepService` and every tick reports
     * `failed` — visible, but no stuck Build would ever be re-driven on a Trigger install.
     */
    describe('the APW-05 T21 app-build-sweep remote target', () => {
        it('registers an AppBuildSweepService entry so the scheduled sweep can run at all', () => {
            // Until the entry became a narrow facade (the `PluginAllowlistReader`
            // precedent) this pinned `toBe(appBuildSweepService)`: the whole instance
            // was published, and with it the lock-free `sweep(nowMs)` and every
            // TS-private pass. The entry is now a one-member object over the service.
            const entry = (controller as any).remoteMap.AppBuildSweepService;
            expect(entry).toBeDefined();
            expect(entry).not.toBe(appBuildSweepService);
            expect(Object.keys(entry)).toEqual(['runSweep']);
        });

        it('reaches `runSweep` — the one member the task’s seam declares — over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppBuildSweepService',
                method: 'runSweep',
                args: superjson.serialize([]) as any,
            });

            expect(appBuildSweepService.runSweep).toHaveBeenCalledWith();
            expect(superjson.deserialize(response.result as any)).toEqual({
                skipped: null,
                redriveRequested: 1,
                lostMarked: 0,
            });
        });

        it('never forwards a caller-supplied clock — the API reads its own', async () => {
            // `runSweep(nowMs)` keeps its clock seam for the specs. Over the RPC hop a
            // far-future `nowMs` would fail every open never-adopted requested Build as
            // `lost`, so the entry calls `runSweep()` whatever arguments arrive.
            const farFuture = Date.parse('2099-01-01T00:00:00.000Z');

            await controller.callRemote(VALID_SECRET, {
                name: 'AppBuildSweepService',
                method: 'runSweep',
                args: superjson.serialize([farFuture]) as any,
            });

            expect(appBuildSweepService.runSweep).toHaveBeenCalledTimes(1);
            expect(appBuildSweepService.runSweep).toHaveBeenCalledWith();
        });

        it('derives an allow-list of exactly `runSweep`, refusing `sweep`, the passes and an unknown method', async () => {
            expect([
                ...((controller as any).allowedMethods.AppBuildSweepService as Set<string>),
            ]).toEqual(['runSweep']);

            for (const method of ['sweep', 'lostPass', 'doesNotExist']) {
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name: 'AppBuildSweepService',
                        method,
                        args: superjson.serialize([Date.now()]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for AppBuildSweepService: ${method}`);
            }
            expect(appBuildSweepService.sweep).not.toHaveBeenCalled();
            expect(appBuildSweepService.lostPass).not.toHaveBeenCalled();
        });

        it('answers the loud `Unknown remote target` when the service is not bound', async () => {
            appBuildSweepService = undefined;
            const bare = buildController();

            await expect(
                bare.callRemote(VALID_SECRET, {
                    name: 'AppBuildSweepService',
                    method: 'runSweep',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow('Unknown remote target: AppBuildSweepService');
        });
    });

    /**
     * APW-01 T15 — the ready handler, the RPC target the `app-fork-readiness` run calls
     * once the Work Repository has content.
     *
     * Two claims, and both have to hold together: the name is in `remoteMap` (so the
     * worker's proxy does not answer `Unknown remote target: AppSourceInitializerService`)
     * and `onDataRepositoryReady` — the one member `AppForkReadyHandler` declares — is in
     * the auto-derived allow-list (so the call is not refused before it reaches the
     * method). This is the same pair the C10 block above asserts for the runner, and the
     * reason is the same: before the entry existed there was nothing to call, so the App
     * spec state row could never be created (C32).
     */
    describe('the APW-01 T15 app-source-initializer remote target', () => {
        it('registers AppSourceInitializerService so the ready hand-off can happen at all', () => {
            expect((controller as any).remoteMap.AppSourceInitializerService).toBe(
                appSourceInitializerService,
            );
        });

        it('reaches `onDataRepositoryReady` — the one member the port declares — over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppSourceInitializerService',
                method: 'onDataRepositoryReady',
                args: superjson.serialize([{ workId: 'work-1' }]) as any,
            });

            expect(appSourceInitializerService.onDataRepositoryReady).toHaveBeenCalledWith({
                workId: 'work-1',
            });
            // The service's own answer, passed through untouched: a hand-off that could not
            // create the state row is a NAMED failure, not a green run.
            expect(superjson.deserialize(response.result as any)).toEqual({
                result: 'failed',
                reason: 'spec_state_unavailable',
            });
        });

        it('derives a callable allow-list holding `onDataRepositoryReady` and nothing else', async () => {
            expect([
                ...((controller as any).allowedMethods.AppSourceInitializerService as Set<string>),
            ]).toEqual(['onDataRepositoryReady']);

            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'AppSourceInitializerService',
                    method: 'run',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow('Method not in allow-list for AppSourceInitializerService: run');
        });

        it('answers the loud `Unknown remote target` when the binding is absent', async () => {
            // The fail-closed half: an installation where the handler is not wired must
            // never look like a hand-off that ran.
            const bare = buildController();
            (bare as any).remoteMap.AppSourceInitializerService = undefined;

            await expect(
                bare.callRemote(VALID_SECRET, {
                    name: 'AppSourceInitializerService',
                    method: 'onDataRepositoryReady',
                    args: superjson.serialize([{ workId: 'work-1' }]) as any,
                }),
            ).rejects.toThrow('Unknown remote target: AppSourceInitializerService');
        });
    });

    /**
     * APW-06 §5.1 / plan §6.4 — `TriggerAppRuntimeModule` binds `APP_DEPLOY_BUILD_SOURCE` to a
     * proxy of exactly this name, because the worker owns no `DataSource` and the adapter reads
     * `work_builds`. Without the entry the orchestrator's §5.1 re-check and the render-input
     * builder in the worker could not read the Build a Deployment names: the builder answered
     * `no_green_build` ("could not be read") for every Build-backed Deployment. Its sibling,
     * `APP_DEPLOY_SPEC_SOURCE`, dials the `AppSpecService` entry asserted above.
     */
    describe('the APW-06 §5.1 app-deploy build-source remote target', () => {
        it('registers AppDeployBuildSourceAdapter so the worker can read the Build at all', () => {
            expect((controller as any).remoteMap.AppDeployBuildSourceAdapter).toBe(
                appDeployBuildSourceAdapter,
            );
        });

        it('reaches `getBuild` over the RPC hop and passes the snapshot back untouched', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppDeployBuildSourceAdapter',
                method: 'getBuild',
                args: superjson.serialize(['work-1', 'build-1']) as any,
            });

            expect(appDeployBuildSourceAdapter.getBuild).toHaveBeenCalledWith('work-1', 'build-1');
            expect(superjson.deserialize(response.result as any)).toEqual({
                id: 'build-1',
                commitSha: 'work-1-sha',
                status: 'succeeded',
                trigger: 'push',
                imageReference: 'ghcr.io/acme/app@sha256:abc',
            });
        });

        it('derives an allow-list of exactly the two reads the port declares', async () => {
            expect(
                [
                    ...((controller as any).allowedMethods
                        .AppDeployBuildSourceAdapter as Set<string>),
                ].sort(),
            ).toEqual(['getBuild', 'listDeployableBuilds']);

            const response = await controller.callRemote(VALID_SECRET, {
                name: 'AppDeployBuildSourceAdapter',
                method: 'listDeployableBuilds',
                args: superjson.serialize(['work-1']) as any,
            });
            expect(appDeployBuildSourceAdapter.listDeployableBuilds).toHaveBeenCalledWith('work-1');
            expect(superjson.deserialize(response.result as any)).toEqual([]);

            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'AppDeployBuildSourceAdapter',
                    method: 'doesNotExist',
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow(
                'Method not in allow-list for AppDeployBuildSourceAdapter: doesNotExist',
            );
        });

        it('appends the adapter after the T21 sweep, @Optional(), with only @Optional() after it', () => {
            // The arity rule every App entry above follows, asserted from the decorator's own
            // metadata: a mid-list insertion would shift every positional construction in this
            // file, and a non-optional one would stop an installation without the module booting.
            // It pins the RULE, not "nothing follows the adapter": a later append under the same
            // rule must not turn this red (the way "the LAST parameter" pins did when T21 and
            // this entry were appended after APW-01 T15's handler).
            const paramTypes: unknown[] =
                Reflect.getMetadata('design:paramtypes', TriggerInternalController) ?? [];
            const optionalIndices: number[] =
                Reflect.getMetadata('optional:paramtypes', TriggerInternalController) ?? [];
            const indexOf = (name: string) =>
                paramTypes.findIndex((type) => (type as { name?: string })?.name === name);
            const adapterAt = indexOf('AppDeployBuildSourceAdapter');

            expect(adapterAt).toBeGreaterThan(indexOf('AppBuildSweepService'));
            expect(indexOf('AppBuildSweepService')).toBeGreaterThan(-1);
            for (let index = adapterAt; index < paramTypes.length; index++) {
                expect(optionalIndices).toContain(index);
            }
        });
    });

    // -------------------------------------------------------------------
    // EW-693 T27 (a6) — the worker's allowlist reads
    // -------------------------------------------------------------------

    /**
     * Owner decision: third-party allowlisted packages may run in the worker.
     * The worker's installer checks the allowlist BEFORE any download (FR-11)
     * but owns no DataSource, so it reads the allowlist over this hop — through
     * a reader that exposes ONE method. The repository itself is not a remote
     * target: its write methods would otherwise be callable from a worker.
     */
    describe('the T27 PluginAllowlistReader remote target', () => {
        it('reaches findByPackageName over the RPC hop', async () => {
            const response = await controller.callRemote(VALID_SECRET, {
                name: 'PluginAllowlistReader',
                method: 'findByPackageName',
                args: superjson.serialize(['@acme/cool-plugin']) as any,
            });

            expect(pluginAllowlistRepository.findByPackageName).toHaveBeenCalledWith(
                '@acme/cool-plugin',
            );
            expect(superjson.deserialize(response.result as any)).toMatchObject({
                packageName: '@acme/cool-plugin',
                enabled: true,
            });
        });

        it.each(['create', 'update', 'delete', 'name'])(
            'refuses %s — the reader exposes findByPackageName only',
            async (method) => {
                await expect(
                    controller.callRemote(VALID_SECRET, {
                        name: 'PluginAllowlistReader',
                        method,
                        args: superjson.serialize([]) as any,
                    }),
                ).rejects.toThrow(`Method not in allow-list for PluginAllowlistReader: ${method}`);
                expect(pluginAllowlistRepository.create).not.toHaveBeenCalled();
                expect(pluginAllowlistRepository.update).not.toHaveBeenCalled();
                expect(pluginAllowlistRepository.delete).not.toHaveBeenCalled();
            },
        );

        it('does not expose the repository itself', async () => {
            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'PluginAllowlistRepository',
                    method: 'findByPackageName',
                    args: superjson.serialize(['@acme/cool-plugin']) as any,
                }),
            ).rejects.toThrow('Unknown remote target: PluginAllowlistRepository');
        });

        it('answers the loud "Unknown remote target" when no allowlist repository is bound', async () => {
            pluginAllowlistRepository = undefined;
            const unbound = buildController();

            await expect(
                unbound.callRemote(VALID_SECRET, {
                    name: 'PluginAllowlistReader',
                    method: 'findByPackageName',
                    args: superjson.serialize(['@acme/cool-plugin']) as any,
                }),
            ).rejects.toThrow('Unknown remote target: PluginAllowlistReader');
        });

        it('appends the repository in the @Optional() tail', () => {
            const paramTypes: unknown[] =
                Reflect.getMetadata('design:paramtypes', TriggerInternalController) ?? [];
            const optionalIndices: number[] =
                Reflect.getMetadata('optional:paramtypes', TriggerInternalController) ?? [];
            const at = paramTypes.findIndex(
                (type) => (type as { name?: string })?.name === 'PluginAllowlistRepository',
            );

            // Was `expect(at).toBe(paramTypes.length - 1)` — true until the next append (the
            // worker's `GitHubAppInstallationRepository` reader, 2026-09-26). The rule it
            // guarded is "appended at the tail, never mid-list": it and EVERY parameter after
            // it are `@Optional()`, so no positional construction shifts.
            expect(at).toBeGreaterThan(0);
            for (let index = at; index < paramTypes.length; index += 1) {
                expect(optionalIndices).toContain(index);
            }
        });
    });

    // -------------------------------------------------------------------
    // The worker GitFacadeService's installation reads
    // -------------------------------------------------------------------

    /**
     * `packages/tasks/src/trigger/worker/modules/trigger-facades.module.ts` provides the
     * worker's `GitHubAppInstallationRepository` as `createRemoteProxy(api,
     * 'GitHubAppInstallationRepository')`, because the worker's `GitFacadeService` needs it for
     * GitHub App installation tokens (`getInstallationTokenForWork` → `findByInstallationId`,
     * `getInstallationTokenForOwner` → `findActiveByAccountLogin`) and owns no DataSource.
     * Until 2026-09-26 no `remoteMap` entry had that name, so every such lookup in a worker —
     * the App spec evaluation, the dependency provisioner and the App runtime worker import
     * that module — answered "Unknown remote target"
     * (`apps/api/src/app-works-di-reachability.spec.ts` found it). The entry is a reader with
     * exactly those two reads: the repository's writes (`upsertFromGithub`, `markDeleted`,
     * `markSuspended`, `claimOwnershipIfUnassigned`) and its cross-tenant `listAll` are not
     * reachable over this hop.
     */
    describe('the GitHubAppInstallationRepository remote target (the worker git facade)', () => {
        const installation = {
            id: 'row-1',
            installationId: '4242',
            accountLogin: 'acme',
            suspendedAt: null,
            deletedAt: null,
        };
        let installations: any;

        const buildWithInstallations = () => {
            gitHubAppInstallationRepository = installations;
            return buildController();
        };

        beforeEach(() => {
            installations = {
                findByInstallationId: jest.fn(async (id: string) =>
                    id === installation.installationId ? installation : null,
                ),
                findActiveByAccountLogin: jest.fn(async (login: string) =>
                    login === installation.accountLogin ? installation : null,
                ),
                findById: jest.fn(),
                listAll: jest.fn(),
                upsertFromGithub: jest.fn(),
                markDeleted: jest.fn(),
                markSuspended: jest.fn(),
                claimOwnershipIfUnassigned: jest.fn(),
            };
        });

        it.each([
            ['findByInstallationId', '4242'],
            ['findActiveByAccountLogin', 'acme'],
        ])('reaches %s over the RPC hop', async (method, argument) => {
            const response = await buildWithInstallations().callRemote(VALID_SECRET, {
                name: 'GitHubAppInstallationRepository',
                method,
                args: superjson.serialize([argument]) as any,
            });

            expect(installations[method]).toHaveBeenCalledWith(argument);
            expect(superjson.deserialize(response.result as any)).toMatchObject({
                installationId: '4242',
            });
        });

        it.each([
            'findById',
            'listAll',
            'upsertFromGithub',
            'markDeleted',
            'markSuspended',
            'claimOwnershipIfUnassigned',
        ])('refuses %s — the reader exposes the two installation reads only', async (method) => {
            await expect(
                buildWithInstallations().callRemote(VALID_SECRET, {
                    name: 'GitHubAppInstallationRepository',
                    method,
                    args: superjson.serialize([]) as any,
                }),
            ).rejects.toThrow(
                `Method not in allow-list for GitHubAppInstallationRepository: ${method}`,
            );
            expect(installations[method]).not.toHaveBeenCalled();
        });

        it('answers the loud "Unknown remote target" when no installation repository is bound', async () => {
            await expect(
                controller.callRemote(VALID_SECRET, {
                    name: 'GitHubAppInstallationRepository',
                    method: 'findByInstallationId',
                    args: superjson.serialize(['4242']) as any,
                }),
            ).rejects.toThrow('Unknown remote target: GitHubAppInstallationRepository');
        });

        it('appends the repository LAST and @Optional()', () => {
            const paramTypes: unknown[] =
                Reflect.getMetadata('design:paramtypes', TriggerInternalController) ?? [];
            const optionalIndices: number[] =
                Reflect.getMetadata('optional:paramtypes', TriggerInternalController) ?? [];
            const last = paramTypes.length - 1;

            // The class itself, not `Object`: an `Object` here is a parameter Nest resolves
            // to nothing, and `@Optional()` would hide that.
            expect(paramTypes[last]).toBe(GitHubAppInstallationRepository);
            expect(optionalIndices).toContain(last);
        });
    });
});
