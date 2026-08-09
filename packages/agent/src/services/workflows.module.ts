import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowRepository } from '../database/repositories/workflow.repository';
import { WorkflowsService } from './workflows.service';

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
@Module({
    imports: [TypeOrmModule.forFeature([Workflow])],
    providers: [WorkflowRepository, WorkflowsService],
    exports: [WorkflowRepository, WorkflowsService],
})
export class WorkflowsModule {}
