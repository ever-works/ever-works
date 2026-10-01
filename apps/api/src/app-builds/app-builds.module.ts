import { Module } from '@nestjs/common';
import { AppBuildsModule as AgentAppBuildsModule } from '@ever-works/agent/app-builds';
import { AppBuildSweepCronService } from './app-build-sweep-cron.service';

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
    imports: [AgentAppBuildsModule],
    providers: [AppBuildSweepCronService],
})
export class AppBuildsModule {}
