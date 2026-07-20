// Goals & Metrics — PR-8 public surface. Re-exports the Goal entity
// family (entities + enums + types) so callers don't need deep
// imports from `../entities/*` — same idiom as the missions barrel.
export * from './goals.service';
export * from './goal-evaluation.service';
export * from './goals.module';
export * from './types';
export {
    Goal,
    GoalStatus,
    GoalOutcome,
    type GoalComparator,
    type GoalMetricSource,
    type GoalWindow,
} from '../entities/goal.entity';
export { GoalMetricSample } from '../entities/goal-metric-sample.entity';
export { MissionGoal } from '../entities/mission-goal.entity';
