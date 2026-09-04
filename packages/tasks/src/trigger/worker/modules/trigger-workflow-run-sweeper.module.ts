import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkflowsModule } from '@ever-works/agent/services';

/**
 * Lean Nest module for the two `workflow_runs` recovery paths: the
 * `workflow-run` task's `onFailure` hook and the `workflow-run-sweeper`
 * schedule.
 *
 * # Why not `TriggerWorkflowRunModule`
 *
 * That module boots the plugin registry, the AI facade and six knowledge-base
 * providers, because the WALK needs them. Neither recovery path executes a
 * node — both only need `WorkflowRunRepository` to move a row to `failed`. On
 * the `onFailure` path the cost is not merely cold-start latency: that hook
 * runs after the task has already failed, sometimes because the machine is out
 * of memory, and `TriggerPluginHydratorService` reaches over the network. A
 * recovery path must not be able to fail for the same reason as the thing it
 * is recovering.
 *
 * # Why not `TriggerInternalModule`
 *
 * That module reaches the API over `TriggerInternalApiClient` remote proxies.
 * Same rationale `TriggerWorkflowRunModule` documents for going DB-direct: the
 * worker already shares the API's database — it must, since it writes the
 * `workflow_runs` row — so an RPC hop adds a failure mode with no correctness
 * benefit. That matters more on a recovery path, where the API being
 * unreachable is a plausible reason the run died in the first place.
 *
 * `WorkflowsModule` supplies `WorkflowRunRepository` and
 * `WorkflowRunSweeperService`; both of its other services construct from a
 * single repository each, and its `WORKFLOW_RUN_DISPATCHER` injection is
 * `@Optional()`, so nothing here needs the api-side binding.
 */
@Module({
    imports: [DatabaseModule, WorkflowsModule],
    exports: [WorkflowsModule],
})
export class TriggerWorkflowRunSweeperModule {}
