import { Global, Module } from '@nestjs/common';
import { WorkflowsModule as AgentWorkflowsModule } from '@ever-works/agent/services';
import { WORKFLOW_RUN_DISPATCHER } from '@ever-works/agent/tasks';
import { workflowRunTriggerAdapter } from '@ever-works/trigger-tasks';
import { AuthModule } from '../auth/auth.module';
import { WorkflowsController } from './workflows.controller';

/**
 * API surface for saved workflow graphs and their runs (judgment layer
 * G5).
 *
 * Mounts the controller only; the services + repositories live in the
 * agent-side `WorkflowsModule`, which this imports for `WorkflowsService`
 * and `WorkflowRunsService`. `AuthModule` is imported because the
 * controller's `AuthSessionGuard` is resolved through DI — without it the
 * module compiles and then fails to instantiate the guard at boot, which
 * no unit test would catch.
 *
 * ## The dispatcher binding
 *
 * `WORKFLOW_RUN_DISPATCHER` is bound HERE rather than inside the agent
 * package because the adapter carries the `@trigger.dev/sdk` dependency,
 * which `@ever-works/agent` deliberately does not take. Same shape as
 * `IdeaBuildExecutorDispatchModule`.
 *
 * `WorkflowRunsService` injects the token `@Optional()`, so an install
 * without a job runtime still boots and still serves the read routes —
 * `POST :id/run` then records the run as dispatch-failed with the reason
 * rather than leaving a `queued` row nothing will ever pick up.
 *
 * ## `@Global()` is LOAD-BEARING, not decoration
 *
 * The consumer, `WorkflowRunsService`, is declared in the agent-side
 * `WorkflowsModule` that this module IMPORTS. NestJS resolves a
 * provider's dependencies in the injector of the module that DECLARES
 * it — it never walks upward into an importer — so a plain `@Module`
 * binding here is invisible to the service, and the `@Optional()`
 * injection silently resolves to `undefined`.
 *
 * The failure mode is total and silent: every `POST :id/run` takes the
 * "no dispatcher bound" branch, records the run dispatch-failed, and
 * answers 202 — so the feature looks complete while never enqueuing
 * anything. Nothing else catches it. There is no boot error (the token
 * is `@Optional()`), unit tests construct the service with a mock, and
 * CI/e2e have no Trigger.dev configured so a failed run is the expected
 * result there anyway.
 *
 * This is the third time the repo has hit it —
 * `IdeaBuildExecutorDispatchModule` and `TasksModule` (the latter marked
 * "PASS-4 review fix (CRITICAL)") both carry `@Global()` for exactly
 * this reason. `workflows.module.spec.ts` pins it so a fourth is caught
 * by a unit test rather than in production.
 */
@Global()
@Module({
    imports: [AgentWorkflowsModule, AuthModule],
    controllers: [WorkflowsController],
    providers: [{ provide: WORKFLOW_RUN_DISPATCHER, useValue: workflowRunTriggerAdapter }],
    exports: [WORKFLOW_RUN_DISPATCHER],
})
export class WorkflowsModule {}
