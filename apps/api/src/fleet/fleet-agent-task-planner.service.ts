import { Injectable, Logger, Optional } from '@nestjs/common';
import { PromptAssemblerService } from '@ever-works/agent/agents';
import { config } from '@ever-works/agent/config';
import {
    AgentRepository,
    ownershipRelationScopeOf,
    SkillBindingRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import type { Agent, Task } from '@ever-works/agent/entities';
import { PluginSettingsService } from '@ever-works/agent/plugins';
import {
    resolveAcceptanceChecks,
    TaskRepository,
    TaskWorkspaceService,
    type AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import {
    FLEET_AGENT_EXECUTION_MAX_BUDGET_USD,
    FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES,
    FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC,
    FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC,
    FLEET_AGENT_EXECUTION_MODEL_PATTERN,
    isFleetAgentExecutionEffort,
    isFleetAgentExecutionMode,
    isFleetAgentExecutionPermissionMode,
    isFleetAgentExecutionProvider,
    type FleetAgentExecutionEffort,
    type FleetAgentExecutionMode,
    type FleetAgentExecutionPermissionMode,
    type FleetAgentExecutionProvider,
    type FleetAgentModelExecution,
    type FleetTaskWorkspaceSpec,
    type TaskAcceptanceCheck,
} from '@ever-works/contracts';
import type { FleetAgentTaskPlan, FleetAgentTaskPlanner } from './fleet-agent-task.dispatcher';

/** Plugin id whose per-tenant settings overlay the instance defaults. */
export const FLEET_NODE_RUNTIME_PLUGIN_ID = 'job-runtime-node';

/**
 * Chat-template control markers some models treat as out-of-band turn
 * delimiters. Same set the prompt assembler and the cloud task executor
 * strip; Task title/description are user-authored (and, for
 * email-spawned Tasks, attacker-authored), and here they land in a
 * prompt a CLI with write access to a repository reads.
 */
const CHAT_TEMPLATE_MARKER_PATTERN =
    /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

function neutralizeControlTokens(value: string): string {
    return value.replace(CHAT_TEMPLATE_MARKER_PATTERN, '');
}

/** The resolved per-tenant execution settings (instance env ← plugin settings). */
export interface FleetAgentExecutionSettings {
    mode: FleetAgentExecutionMode;
    provider: FleetAgentExecutionProvider;
    model?: string;
    effort?: FleetAgentExecutionEffort;
    permissionMode: FleetAgentExecutionPermissionMode;
    timeoutSec: number;
    maxBudgetUsd?: number;
    skipPermissions: boolean;
}

export class FleetAgentTaskPlanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FleetAgentTaskPlanError';
    }
}

/**
 * Agent execution v2 — the PLANNER: turns "run this Task on the owner's
 * fleet" into the exact job a node can execute without model access,
 * platform credentials or a platform tool surface of its own.
 *
 * Runs on the dispatch path, after the router decided the run goes to
 * the fleet and before the job row is written. Answers three questions:
 *
 *   1. **Does this tenant want model execution at all?** The instance
 *      default (`FLEET_NODE_AGENT_EXECUTION_*`) overlaid with the
 *      tenant's own `job-runtime-node` plugin settings. `command`, the
 *      default, returns `null` and the router writes the legacy job
 *      byte-for-byte as before.
 *   2. **Where does the node work?** The Task's Work repository, base
 *      ref and task branch, resolved by the SAME service the cloud path
 *      uses (`TaskWorkspaceService`), so a branch cut on a node is the
 *      branch a cloud re-run would reuse. Token-free by construction.
 *   3. **What does the node tell the CLI?** The agent's assembled
 *      system prompt (identity, role, skills — through the ONE prompt
 *      assembler every run uses), the Task brief in the same shape the
 *      cloud executor sends, a workspace section that explains the
 *      worktree and that the NODE commits/pushes, the acceptance checks
 *      the node will grade, and a short output contract.
 *
 * A plan that cannot be built THROWS. The dispatcher lets it propagate
 * so the transition service records the reason on the run row, where a
 * human reads it — a run that silently degraded to the legacy command
 * (or to nothing) would be the exact failure mode this program removes.
 */
@Injectable()
export class FleetAgentTaskPlannerService implements FleetAgentTaskPlanner {
    private readonly logger = new Logger(FleetAgentTaskPlannerService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly agents: AgentRepository,
        private readonly works: WorkRepository,
        private readonly taskWorkspace: TaskWorkspaceService,
        // Every collaborator below is @Optional() so the planner degrades
        // (fewer prompt segments, instance-level settings) rather than
        // failing to construct in a module graph that lacks it.
        @Optional() private readonly promptAssembler?: PromptAssemblerService,
        @Optional() private readonly skillBindings?: SkillBindingRepository,
        @Optional() private readonly pluginSettings?: PluginSettingsService,
    ) {}

    /**
     * Instance defaults overlaid with the tenant's plugin settings. Every
     * overlay value goes through the contracts' guards; a setting that
     * fails validation is ignored (and logged) rather than coerced.
     */
    async resolveSettings(userId: string): Promise<FleetAgentExecutionSettings> {
        const settings: FleetAgentExecutionSettings = {
            mode: config.fleetNode.getAgentExecutionMode(),
            provider: config.fleetNode.getAgentExecutionProvider(),
            permissionMode: config.fleetNode.getAgentExecutionPermissionMode(),
            timeoutSec: config.fleetNode.getAgentExecutionTimeoutSeconds(),
            skipPermissions: config.fleetNode.isAgentExecutionSkipPermissionsEnabled(),
        };
        const model = config.fleetNode.getAgentExecutionModel();
        if (model) settings.model = model;
        const effort = config.fleetNode.getAgentExecutionEffort();
        if (effort) settings.effort = effort;
        const budget = config.fleetNode.getAgentExecutionMaxBudgetUsd();
        if (budget !== undefined) settings.maxBudgetUsd = budget;

        if (!this.pluginSettings) return settings;
        let resolved: Record<string, { value: unknown; source?: string } | undefined>;
        try {
            resolved = await this.pluginSettings.getResolvedSettings(FLEET_NODE_RUNTIME_PLUGIN_ID, {
                userId,
            });
        } catch (err) {
            this.logger.debug(
                `job-runtime-node settings unavailable for user ${userId} — using instance defaults: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return settings;
        }
        // Only NON-default sources overlay: a plugin-level default is the
        // schema's own fallback, and must not outrank the operator env.
        const read = (key: string): unknown => {
            const entry = resolved?.[key];
            if (!entry || entry.source === 'default' || entry.source === 'env') return undefined;
            return entry.value;
        };
        const mode = read('agentExecutionMode');
        if (isFleetAgentExecutionMode(mode)) settings.mode = mode;
        const provider = read('agentExecutionProvider');
        if (isFleetAgentExecutionProvider(provider)) settings.provider = provider;
        const overlayModel = read('agentExecutionModel');
        if (typeof overlayModel === 'string') {
            const trimmed = overlayModel.trim();
            if (trimmed && FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(trimmed))
                settings.model = trimmed;
        }
        const overlayEffort = read('agentExecutionEffort');
        if (isFleetAgentExecutionEffort(overlayEffort)) settings.effort = overlayEffort;
        const permissionMode = read('agentExecutionPermissionMode');
        if (isFleetAgentExecutionPermissionMode(permissionMode))
            settings.permissionMode = permissionMode;
        const timeout = Number(read('agentExecutionTimeoutSeconds'));
        if (Number.isFinite(timeout) && timeout > 0) {
            settings.timeoutSec = Math.min(
                Math.max(Math.round(timeout), FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC),
                FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC,
            );
        }
        // Same ceiling the wire contract enforces — a budget the node would
        // refuse must never be planned. Refused, not clamped: a silently
        // lowered cap is a decision the operator never saw.
        const overlayBudget = Number(read('agentExecutionMaxBudgetUsd'));
        if (
            Number.isFinite(overlayBudget) &&
            overlayBudget > 0 &&
            overlayBudget <= FLEET_AGENT_EXECUTION_MAX_BUDGET_USD
        ) {
            settings.maxBudgetUsd = overlayBudget;
        }
        const skip = read('agentExecutionSkipPermissions');
        if (typeof skip === 'boolean') settings.skipPermissions = skip;
        return settings;
    }

    async plan(payload: AgentTaskExecuteDispatchPayload): Promise<FleetAgentTaskPlan | null> {
        const settings = await this.resolveSettings(payload.userId);
        if (settings.mode !== 'model-cli') {
            return null;
        }

        const task = await this.tasks.findById(payload.taskId);
        if (!task || task.userId !== payload.userId) {
            throw new FleetAgentTaskPlanError(`Task ${payload.taskId} was not found for its owner`);
        }
        const agent = await this.agents.findByIdAndUser(
            payload.agentId,
            payload.userId,
            ownershipRelationScopeOf(task),
        );
        if (!agent) {
            throw new FleetAgentTaskPlanError(
                `Agent ${payload.agentId} was not found for task ${task.id}`,
            );
        }

        const workspace = await this.taskWorkspace.describeFleetWorkspace({
            task,
            userId: payload.userId,
        });
        if (!workspace) {
            throw new FleetAgentTaskPlanError(
                `Task ${task.slug ?? task.id} has no repository to work in — attach it to a Work with a Git repository before routing it to the fleet`,
            );
        }

        const work = task.workId ? await this.works.findById(task.workId) : null;
        const acceptanceChecks = safeResolveChecks(task, work);
        const instructions = await this.composeInstructions({
            agent,
            task,
            workspace,
            acceptanceChecks,
        });

        const execution: FleetAgentModelExecution = {
            provider: settings.provider,
            instructions,
            permissionMode: settings.permissionMode,
            timeoutSec: settings.timeoutSec,
            envPassthrough: config.fleetNode.getAgentTaskEnvPassthrough(),
        };
        if (settings.model) execution.model = settings.model;
        if (settings.effort) execution.effort = settings.effort;
        if (settings.maxBudgetUsd !== undefined) execution.maxBudgetUsd = settings.maxBudgetUsd;
        if (settings.skipPermissions) execution.skipPermissions = true;

        const canCommit = agent.permissions?.canCommitToRepo !== false;
        return {
            execution,
            workspace,
            acceptanceChecks,
            git: {
                commit: canCommit,
                push: canCommit,
                commitMessage: `feat(task): ${task.slug ?? task.id} agent run output`,
            },
        };
    }

    /**
     * The full prompt the CLI reads on stdin. System prompt through the
     * shared assembler when it is available (identity, role, skills…),
     * then the Task brief in the cloud executor's shape, then the
     * fleet-specific sections. Trimmed tail-first on the SYSTEM part
     * only when the whole thing would not fit the job payload: the Task
     * and the workspace facts are the parts a run cannot do without.
     */
    private async composeInstructions(input: {
        agent: Agent;
        task: Task;
        workspace: FleetTaskWorkspaceSpec;
        acceptanceChecks: TaskAcceptanceCheck[];
    }): Promise<string> {
        const { agent, task, workspace, acceptanceChecks } = input;
        const taskBrief = [
            `Task ${task.slug ?? task.id}: ${neutralizeControlTokens(task.title ?? '')}`,
            task.description ? `Description: ${neutralizeControlTokens(task.description)}` : null,
            `Status: ${task.status}`,
            `Priority: ${task.priority}`,
            task.labels?.length
                ? `Labels: ${task.labels.map(neutralizeControlTokens).join(', ')}`
                : null,
        ]
            .filter(Boolean)
            .join('\n');
        const scopeContext = `Task scope: mission=${task.missionId ?? 'none'}, idea=${task.ideaId ?? 'none'}, work=${task.workId ?? 'none'}`;

        let systemMessage = '';
        let userMessage = taskBrief;
        if (this.promptAssembler) {
            const assembled = this.promptAssembler.assemble({
                agent,
                kind: 'task',
                immediateInput: taskBrief,
                scopeContext,
                skills: await this.resolveSkills(agent),
            });
            systemMessage = assembled.systemMessage;
            userMessage = assembled.userMessage;
        } else {
            systemMessage = [agent.soulMd, agent.agentsMd]
                .filter((part) => part && part.trim())
                .join('\n\n');
        }

        const checksSection =
            acceptanceChecks.length === 0
                ? 'No acceptance checks are declared for this Task.'
                : [
                      'After you finish, the node runs these commands in the repository root; every required one must exit 0:',
                      ...acceptanceChecks.map(
                          (check) =>
                              `- ${neutralizeControlTokens(check.name || check.id)}: \`${neutralizeControlTokens(check.command)}\`${
                                  check.cwd ? ` (in ${neutralizeControlTokens(check.cwd)})` : ''
                              }${check.required === false ? ' — informational' : ''}`,
                      ),
                  ].join('\n');

        const fleetSections = [
            '# WORKSPACE (fleet node)',
            [
                `You are running on one of the owner's own machines, inside an isolated Git worktree of \`${workspace.repositoryId}\`.`,
                `The current directory is the repository root, checked out on branch \`${workspace.branch}\` (cut from \`${workspace.baseRef}\`).`,
                'Make your changes here. Do NOT commit, push, switch branches, or touch other repositories: when you finish, the node commits everything you left in the working tree to this branch and pushes it, and the platform opens the pull request.',
                'You have no platform tools in this session. If the Task cannot be completed as written, do not guess — leave the working tree unchanged and explain exactly what is missing in your final message.',
            ].join('\n'),
            '# ACCEPTANCE CHECKS',
            checksSection,
            '# OUTPUT CONTRACT',
            'Your final message is recorded as the run summary. State what you changed, which files, how you verified it, and anything a reviewer must know. Keep it under 300 words.',
        ].join('\n\n');

        const tail = `# TASK\n${userMessage}\n\n${fleetSections}`;
        // The Task brief and the workspace facts are never truncated; when
        // they alone do not fit, the run cannot be planned honestly — fail
        // HERE (recorded on the run row) rather than enqueue a job the node
        // would refuse during execution validation.
        if (byteLength(tail) > FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES) {
            throw new FleetAgentTaskPlanError(
                `Task ${task.slug ?? task.id} is too large for fleet model instructions (${byteLength(tail)} bytes of task/workspace content; limit ${FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES})`,
            );
        }
        const budget = FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES - byteLength(tail) - 2;
        const system = budget > 0 ? truncateToBytes(systemMessage, budget) : '';
        if (system.length < systemMessage.length) {
            this.logger.warn(
                `Fleet instructions for task ${task.id}: system prompt truncated to fit the job payload (${byteLength(systemMessage)} → ${byteLength(system)} bytes)`,
            );
        }
        return system ? `${system}\n\n${tail}` : tail;
    }

    /** Active skills in the assembler's shape; best-effort, never fatal. */
    private async resolveSkills(
        agent: Agent,
    ): Promise<Array<{ slug: string; body: string; priority: number }> | undefined> {
        if (!this.skillBindings) return undefined;
        try {
            const rows = await this.skillBindings.resolveActive({
                userId: agent.userId,
                agentId: agent.id,
                workId: agent.workId ?? undefined,
                missionId: agent.missionId ?? undefined,
                ideaId: agent.ideaId ?? undefined,
                forAgentRun: true,
            });
            return rows.map(({ binding, skill }) => ({
                slug: skill.slug,
                body: skill.instructionsMd ?? '',
                priority: binding.priority,
            }));
        } catch (err) {
            this.logger.warn(
                `Skill resolution failed for agent ${agent.id} — fleet instructions carry no skills: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return undefined;
        }
    }
}

/** Checks resolution must never stop a dispatch — an unreadable Work grades nothing. */
function safeResolveChecks(
    task: Task,
    work: Parameters<typeof resolveAcceptanceChecks>[1],
): TaskAcceptanceCheck[] {
    try {
        return resolveAcceptanceChecks(task, work);
    } catch {
        return [];
    }
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

/** Cut a string so its UTF-8 size fits `maxBytes`, never splitting a code point. */
function truncateToBytes(value: string, maxBytes: number): string {
    if (byteLength(value) <= maxBytes) return value;
    const buffer = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes));
    return buffer.toString('utf8').replace(/�+$/u, '');
}
