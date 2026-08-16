import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Goal } from '../entities/goal.entity';
import { GoalEvent } from '../entities/goal-event.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Mission } from '../entities/mission.entity';
import { Task } from '../entities/task.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { FacadesModule } from '../facades/facades.module';
import { AgentsModule } from '../agents/agents.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { GoalEvaluationService } from './goal-evaluation.service';
import { GoalOrchestratorService } from './goal-orchestrator.service';
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
        TypeOrmModule.forFeature([
            Goal,
            GoalMetricSample,
            MissionGoal,
            Mission,
            // Autonomy layer — the orchestrator log plus read-only access to
            // the iteration Tasks and their runs (spend rollup, in-flight
            // detection, the Sessions tab). Every entity here MUST also be
            // in the DataSource ENTITIES array (`_entities-inventory.ts`) —
            // this repo has no `autoLoadEntities`, so a forFeature'd but
            // unregistered entity throws EntityMetadataNotFoundError on the
            // first query.
            GoalEvent,
            Task,
            AgentRun,
        ]),
        FacadesModule,
        // Judgment layer G1/G3 - escalate-on-hard. GoalEvaluationService
        // injects AgentEscalationService (@Optional()); AgentsModule owns
        // and exports it.
        AgentsModule,
        // Autonomy layer — one iteration IS a Task, dispatched down the
        // same path a kanban "Run" click takes. Direction of imports is
        // one-way (goals -> tasks-domain); nothing under tasks-domain
        // imports the goals barrel, so no module cycle is introduced.
        TasksDomainModule,
        ActivityLogModule,
        NotificationsModule,
    ],
    providers: [GoalsService, GoalEvaluationService, GoalOrchestratorService],
    exports: [GoalsService, GoalEvaluationService, GoalOrchestratorService],
})
export class GoalsModule {}
