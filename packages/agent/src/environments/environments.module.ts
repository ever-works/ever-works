import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Environment } from '../entities/environment.entity';
import { Agent } from '../entities/agent.entity';
import { EnvironmentRepository } from './environment.repository';
import { EnvironmentsService } from './environments.service';

/**
 * Environments (Settings → Environments) — agent-side module owning the
 * `environments` table's data + service surface. The api-side
 * `EnvironmentsModule` (apps/api/src/environments) imports this one and
 * mounts the controller.
 *
 * `Agent` is forFeature'd here as a RAW repository (delete guard +
 * agent-run resolver) — deliberately NOT an `AgentsModule` import, so
 * this module stays a leaf: `AgentsModule` and `PipelineModule` can both
 * import it without a cycle.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Environment, Agent])],
    providers: [EnvironmentRepository, EnvironmentsService],
    exports: [EnvironmentRepository, EnvironmentsService],
})
export class EnvironmentsModule {}
