import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Goal } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Mission } from '../entities/mission.entity';
import { FacadesModule } from '../facades/facades.module';
import { GoalEvaluationService } from './goal-evaluation.service';
import { GoalsService } from './goals.service';

/**
 * Goals & Metrics — PR-8 (spec FR-9..FR-14). Agent-side module for
 * the Goal entity family:
 *
 *   - {@link GoalsService} — CRUD + lifecycle (activate/pause),
 *     manual evaluate-now, and the Mission ↔ Goal link surface
 *     (consumed by both the api-side GoalsController and the
 *     MissionsController link endpoints).
 *   - {@link GoalEvaluationService} — dispatcher engine
 *     (`evaluateDue` with CAS claiming + `evaluateOne`), consuming
 *     `MetricsFacadeService` (PR-7) via {@link FacadesModule}.
 *     Exported so the api-side TriggerInternalController can expose
 *     it to the `goal-evaluate-dispatcher` Trigger.dev cron over the
 *     internal RPC channel (the MissionTickService topology).
 *
 * `Mission` is forFeature'd here only for the ownership probe on the
 * link endpoints — mirroring how MissionsModule forFeature's
 * `WorkProposal` for its clone flow.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Goal, GoalMetricSample, MissionGoal, Mission]),
        FacadesModule,
    ],
    providers: [GoalsService, GoalEvaluationService],
    exports: [GoalsService, GoalEvaluationService],
})
export class GoalsModule {}
