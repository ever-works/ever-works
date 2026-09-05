// Goals & Metrics — PR-8. Public surface of the web-side goals/
// directory: the catalog list, the create form, and the detail
// client, plus the shared presentational helpers.
export { GoalsList } from './GoalsList';
export { GoalCard } from './GoalCard';
export { GoalForm } from './GoalForm';
export { GoalDetailClient } from './GoalDetailClient';
export { Sparkline } from './Sparkline';
export {
    OutcomeBadge,
    GoalKindBadge,
    COMPARATOR_GLYPH,
    formatMetricValue,
    formatDateTime,
} from './goal-ui';
export {
    buildCreateGoalPayload,
    parseDodLines,
    validateGoalFormFields,
    type GoalFormFields,
} from './goal-form-payload';
// Autonomy layer — Definition of Done, limits, orchestrator log, sessions.
export { GoalDodPanel } from './GoalDodPanel';
export { GoalLimitsDialog, type GoalAgentOption } from './GoalLimitsDialog';
export { GoalOrchestratorLog } from './GoalOrchestratorLog';
export { GoalSessionsPanel } from './GoalSessionsPanel';
export { GoalResultsPanel } from './GoalResultsPanel';
export {
    LoopStatusBadge,
    EventKindBadge,
    DodRollup,
    DodProgressBar,
    formatCents,
    formatDuration,
} from './goal-loop-ui';
