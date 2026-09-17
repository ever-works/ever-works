import { Module } from '@nestjs/common';
import { SafetyModule as AgentSafetyModule } from '@ever-works/agent/safety';
import { DatabaseModule } from '@ever-works/agent/database';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { SafetyController } from './safety.controller';
import { SafetyRefusalPruneService } from './safety-refusal-prune.service';
import { HumanActorGuard } from './guards/human-actor.guard';

/**
 * Safety rails and the trust ladder (AW-24) — thin API module over the
 * agent-side `SafetyModule`, which owns the resolution, the narrow-only merge
 * and the single enforcement point.
 *
 * Mirrors `ToolGrantsApiModule` / `MergePolicyApiModule`: the controller is
 * here, every decision is there. `DatabaseModule` supplies `TenantRepository`
 * for the one owner check the write path runs.
 *
 * `HumanActorGuard` is provided (not global) and applied by the controller,
 * because "only a person, in an interactive session" is a property of these
 * three writes rather than of the API as a whole.
 *
 * `DistributedTaskLockService` is provided directly rather than imported,
 * matching `BudgetsModule` and `DataSyncModule`: it is not exported by the
 * imported `DatabaseModule`, so the nightly prune needs its own binding.
 */
@Module({
    imports: [AgentSafetyModule, DatabaseModule],
    controllers: [SafetyController],
    providers: [HumanActorGuard, SafetyRefusalPruneService, DistributedTaskLockService],
    exports: [AgentSafetyModule],
})
export class SafetyApiModule {}
