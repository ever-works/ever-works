import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowRun } from '../entities/workflow-run.entity';
import { WorkflowRepository } from '../database/repositories/workflow.repository';
import { WorkflowRunRepository } from '../database/repositories/workflow-run.repository';
import { WorkflowsService } from './workflows.service';
import { WorkflowRunsService } from './workflow-runs.service';

/**
 * Saved workflow graphs (judgment layer G5).
 *
 * `WorkflowRepository` is provided HERE rather than added to
 * `_repository-inventory.ts`: that list is only for repositories owned
 * by `DatabaseModule` itself, and this one is feature-owned. It needs
 * nothing but `@InjectRepository(Workflow)`, which the `forFeature`
 * below supplies.
 *
 * The entity must ALSO be in the `ENTITIES` array
 * (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a `forFeature`'d-but-unregistered entity throws
 * `EntityMetadataNotFoundError` on the first query, in production, with
 * a green build and green unit tests behind it.
 */
/**
 * `WorkflowRunExecutorService` is deliberately NOT provided here.
 *
 * It needs `WorkflowGraphExecutorService`, which lives in `AgentsModule` —
 * importing that to satisfy one worker-only service would drag the whole
 * agents graph into every consumer of this module, including the API's
 * request path, which never executes a walk. The Trigger.dev
 * `workflow-run` module provides the executor locally instead, which is
 * also what keeps the API structurally unable to await a graph.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Workflow, WorkflowRun])],
    providers: [WorkflowRepository, WorkflowRunRepository, WorkflowsService, WorkflowRunsService],
    exports: [WorkflowRepository, WorkflowRunRepository, WorkflowsService, WorkflowRunsService],
})
export class WorkflowsModule {}
