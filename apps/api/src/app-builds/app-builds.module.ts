import { Module } from '@nestjs/common';
import { AppBuildsModule as AgentAppBuildsModule } from '@ever-works/agent/app-builds';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { AuthModule } from '@src/auth';
import { AppBuildsController } from './app-builds.controller';
import { AppBuildSweepCronService } from './app-build-sweep-cron.service';
import { AppBuildWorkflowRunConsumer } from './app-build-workflow-run.consumer';

/**
 * APW-05 — the API-side Builds module.
 *
 * ## What it holds today (T21, first slice)
 *
 * Only `AppBuildSweepCronService`: the two-minute Builds sweep from the API
 * process when Trigger.dev is not the configured runtime (plan §7.4,
 * `APW05-G20`). `ScheduleModule.forRoot()` is registered once at the API root
 * (`api.module.ts`), which is what makes its `@Cron` fire.
 *
 * `AgentAppBuildsModule` (`@ever-works/agent/app-builds`) provides and exports
 * `AppBuildSweepService` and every collaborator it needs; importing it here is
 * what the cron injects. `TriggerInternalModule` imports the same agent module
 * for its `remoteMap`, and Nest instantiates a static module once, so the API
 * has ONE sweep service whichever door a tick comes through.
 *
 * ## What it will hold (T23, T24)
 *
 * T23 (the Builds controller and its DTOs) and T24 (the `workflow_run`
 * consumer) register here too: their task text says "Create" this file, and it
 * was created first by T21, so they EXTEND it rather than re-create it.
 */
@Module({
    // `DatabaseModule` supplies `WorkRepository` / `WorkMemberRepository` to the
    // locally provided `WorkOwnershipService` (T23's access check). Provided here
    // rather than by importing `WorkModule`, which would drag `AppWorksModule` and
    // the facade graph in and stop `app-builds.module.spec.ts` composing this
    // module standalone — the same local-provider shape `AgentsModule` uses.
    // `AuthModule` — `AppBuildsController`'s `@UseGuards(AuthSessionGuard)` injects
    // `AUTH_PROVIDER`, which is not global; found by the DI reachability spec (lane aw-ai).
    imports: [AgentAppBuildsModule, DatabaseModule, AuthModule],
    // APW-05 T23 — the Builds routes (plan §5).
    controllers: [AppBuildsController],
    // APW-05 T24 — the `workflow_run` consumer, registered on the ingest
    // dispatcher at `onModuleInit` through a non-strict `ModuleRef` lookup
    // (`APW05-G21`: `IngestModule` does not export the dispatcher).
    providers: [AppBuildSweepCronService, WorkOwnershipService, AppBuildWorkflowRunConsumer],
})
export class AppBuildsModule {}
