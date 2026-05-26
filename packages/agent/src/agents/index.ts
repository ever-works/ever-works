// Public surface of the agent-side Agents module (Agents/Skills/Tasks
// — PR #1017 specs, Phase 3 + 4 + 6).
export * from './agents.module';
export * from './agents.service';
export * from './agent-file.service';
export * from './agent-schedule-dispatcher.service';
export * from './agent-export.service';
export * from './prompt-assembler.service';
export * from './agent-run.service';
export * from './agent-run-post-processor';
export * from './agent-ai-dispatch-facade';
export * from './agent-git-facade';
export * from './agent-plugin-tools-facade';
export * from './agent-tools-skill';
export * from './agent-tool.service';
export * from './budget-period';
export * from './heartbeat-cron';
export * from './types';
// Re-export the entity types so api callers don't need a deep import.
export {
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    AGENT_PERMISSIONS_DEFAULT,
    type AgentPermissions,
    type AgentTarget,
} from '../entities/agent.entity';
export { AgentBudget, type AgentBudgetIntervalUnit } from '../entities/agent-budget.entity';
export {
    AgentRun,
    type AgentRunStatus,
    type AgentRunTriggerKind,
} from '../entities/agent-run.entity';
export { AgentRunLog } from '../entities/agent-run-log.entity';
export {
    AgentMembership,
    type AgentMembershipTargetType,
} from '../entities/agent-membership.entity';
// FU-2 — re-export the repositories that the api-side controller
// reaches for directly (run-history pagination, cancel, skill rollup,
// budget rollup). Mirrors the same pattern as `AgentFileService` etc.
export { AgentRepository } from '../database/repositories/agent.repository';
export { AgentRunRepository } from '../database/repositories/agent-run.repository';
export { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
export { PluginUsageRepository } from '../database/repositories/plugin-usage.repository';
// FU-14 — re-export WorkRepository for the AGENT_GIT_FACADE binding
// (it resolves the Work's git config + owner/repo before the commit).
export { WorkRepository } from '../database/repositories/work.repository';
