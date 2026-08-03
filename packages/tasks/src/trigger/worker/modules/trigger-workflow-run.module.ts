import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    WorkKnowledgeCitationRepository,
    WorkKnowledgeDocumentRepository,
    WorkKnowledgeTagRepository,
    WorkKnowledgeUploadRepository,
} from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import {
    WorkflowGraphExecutorService,
    WorkflowAiDecisionAdapter,
    WorkflowNodeRunnerService,
    WORKFLOW_DECISION_PORT,
    WORKFLOW_NODE_RUNNER,
} from '@ever-works/agent/agents';
import {
    KnowledgeBaseService,
    WorkOwnershipService,
    WorkflowRunExecutorService,
    WorkflowsModule,
} from '@ever-works/agent/services';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';

/**
 * Nest module booted inside the Trigger.dev `workflow-run` task
 * (judgment layer G5).
 *
 * # Why it imports `DatabaseModule` directly
 *
 * Same rationale as {@link TriggerWebhookDeliveryModule}: this worker
 * already shares the API's database — it has to, because it reads the
 * `workflows` row and writes the `workflow_runs` row — so layering an RPC
 * proxy on top would add a network hop with zero correctness benefit.
 *
 * Here it is more than an optimization. The alternative shape (a task
 * that RPCs the walk back to the API) is actively unsafe:
 * `TriggerInternalApiClient` has no timeout and no `AbortSignal` and
 * retries network errors up to 4 attempts with no idempotency key, so a
 * long call dies at the ingress hop (~60s nginx / ~100s Cloudflare) and
 * is re-executed — and a graph's delegate nodes spawn real child agent
 * runs, which would be duplicated side effects.
 *
 * # Why the plugins + facades modules are here
 *
 * An `ai.ask` node and every `llm_decide` edge go through
 * `AiFacadeService`, which takes `PluginRegistryService` and
 * `PluginSettingsService` NON-optionally. Those come only from a
 * `@Global()` plugins module, so without `TriggerPluginsModule.forRoot()`
 * this module does not merely lose AI — it fails to instantiate at boot.
 *
 * DI is still not enough: the registry's maps start EMPTY and are filled
 * only by `PluginBootstrapService`. The task therefore calls
 * `TriggerPluginHydratorService.initialize()` before executing, or every
 * model call throws `NoProviderError` — the same shape as the documented
 * empty-registry production incident.
 *
 * # `agent.delegate` is deliberately NOT bound
 *
 * `SUB_AGENT_DELEGATION_RUNNER` is bound api-side by `TasksModule`,
 * because the real runner creates a child Task and dispatches it through
 * `TaskTransitionService` — it depends on `tasks-domain`, which
 * `packages/agent/src/agents/` may not import (that is what
 * `AGENT_DOMAIN_TOOL_SOURCES` exists to prevent). Binding it here would
 * mean either importing the whole tasks/agents graph into a worker that
 * should boot fast, or proxying a call that WAITS UP TO TEN MINUTES over
 * the very RPC client described above.
 *
 * So a delegate node in a worker-executed graph fails with
 * `delegation-unavailable` — a typed failure code an `on_failure` edge
 * can route on, not a silent no-op. Making delegation work from the
 * worker means moving the runner into `tasks-domain`, which is its own
 * change.
 *
 * # Knowledge Base: six providers, not `KnowledgeBaseModule`
 *
 * Importing `KnowledgeBaseModule` would instantiate ~14 services —
 * three of which take `GitFacadeService` / `AiFacadeService` /
 * `VectorStoreFacadeService` non-optionally — plus `ActivityLogModule`
 * and `NotificationsModule`, all so one node can call `listDocuments`.
 * `KnowledgeBaseService`'s other 14 constructor params are `@Optional()`
 * and construct fine as `undefined`; the only behavioural loss is
 * `semanticSearch`, so `kb.search` degrades to lexical ranking — the
 * documented fallback, not a failure. `TriggerWorkerModule` provides
 * `KnowledgeBaseGitMirrorService` directly for the same reason.
 */
@Module({
    imports: [
        // Real repositories — `workflows`, `workflow_runs`, and the KB
        // tables — against the same database the API writes.
        DatabaseModule,
        // @Global(): PluginRegistryService + PluginSettingsService, which
        // AiFacadeService requires to even be constructed.
        TriggerPluginsModule.forRoot(),
        // NOT optional, and not obvious: `TriggerPluginsModule` provides
        // `PluginContextFactoryService`, whose 6th constructor argument is
        // a NON-optional `@Inject(CACHE_MANAGER)`. Nothing in the plugins
        // module supplies that token, so without this import the context
        // fails to boot with "argument CACHE_MANAGER at index [5] is not
        // available in the TriggerPluginsModule module" — on every run, in
        // production only, because nothing in CI boots this module.
        // `TriggerWorkerModule` imports it for the same reason.
        TriggerRemoteCacheModule.forRoot(),
        // AiFacadeService (+ its optional usage/budget attribution).
        FacadesModule,
        // WorkflowRepository + WorkflowRunRepository.
        WorkflowsModule,
    ],
    providers: [
        // The walk itself. Provided locally rather than by importing
        // AgentsModule, which would pull ~120 providers into a worker
        // cold start to obtain three classes.
        WorkflowGraphExecutorService,
        WorkflowNodeRunnerService,
        { provide: WORKFLOW_NODE_RUNNER, useExisting: WorkflowNodeRunnerService },
        // The `llm_decide` decider. Bound to the facade adapter — never a
        // raw provider SDK — so a decision still goes through the plugin
        // seam, budgets and provider selection.
        WorkflowAiDecisionAdapter,
        { provide: WORKFLOW_DECISION_PORT, useExisting: WorkflowAiDecisionAdapter },
        // `kb.search` support. These four repository CLASSES are
        // deliberately absent from `_repository-inventory.ts` (they are
        // feature-owned), so they must be listed here even though
        // DatabaseModule supplies their `@InjectRepository` tokens.
        WorkKnowledgeDocumentRepository,
        WorkKnowledgeUploadRepository,
        WorkKnowledgeTagRepository,
        WorkKnowledgeCitationRepository,
        // The KB's only authorization boundary — `listDocuments` runs
        // `ensureCanView(workId, userId)` through it. Never make this
        // optional to "fix" a permission failure.
        WorkOwnershipService,
        KnowledgeBaseService,
        WorkflowRunExecutorService,
    ],
    exports: [WorkflowRunExecutorService],
})
export class TriggerWorkflowRunModule {}
