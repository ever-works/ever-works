import { Module } from '@nestjs/common';
import { WorkflowsModule as AgentWorkflowsModule } from '@ever-works/agent/services';
import { AuthModule } from '../auth/auth.module';
import { WorkflowsController } from './workflows.controller';

/**
 * API surface for saved workflow graphs (judgment layer G5).
 *
 * Mounts the controller only; the service + repository live in the
 * agent-side `WorkflowsModule`, which this imports for
 * `WorkflowsService`. `AuthModule` is imported because the controller's
 * `AuthSessionGuard` is resolved through DI — without it the module
 * compiles and then fails to instantiate the guard at boot, which no
 * unit test would catch.
 */
@Module({
    imports: [AgentWorkflowsModule, AuthModule],
    controllers: [WorkflowsController],
})
export class WorkflowsModule {}
