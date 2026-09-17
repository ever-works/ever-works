import { Injectable } from '@nestjs/common';
import {
    MODEL_POLICY_SCHEDULE_SOURCES,
    parseModelPolicyScheduleKey,
    resolveModelPolicyLadder,
} from '@ever-works/contracts';
import type {
    ModelPolicyLevel,
    ModelPolicyScheduleSource,
    ResolvedModelPolicy,
} from '@ever-works/contracts';
import { ModelPolicyRepository } from '../database/repositories/model-policy.repository';
import type { ModelPolicy } from '../entities/model-policy.entity';
import {
    WORKSPACE_POLICY_SCOPE_KEY,
    agentPolicyScopeKey,
    schedulePolicyScopeKey,
} from './model-workspace';

/** The Agent a call is for, with its own provider/model pair. */
export interface ModelPolicyAgentRef {
    id: string;
    aiProviderId?: string | null;
    modelId?: string | null;
}

export interface ModelPolicySchedule {
    source: ModelPolicyScheduleSource;
    ownerId: string;
}

export interface ModelPolicyResolveInput {
    workspaceKey: string;
    agent?: ModelPolicyAgentRef | null;
    schedule?: ModelPolicySchedule | null;
}

/**
 * Model accounts (AW-16) — the one place the model ladder is read.
 *
 * Loads every stored policy that could apply to a call in one query and folds
 * them narrowest-first (schedule → Agent → workspace → default) with the pure
 * `resolveModelPolicyLadder` the web uses to explain the same answer. The
 * Agent level's primary model is the Agent's own provider/model pair, read
 * from the Agent row, never a copy.
 */
@Injectable()
export class ModelPolicyResolver {
    constructor(private readonly policies: ModelPolicyRepository) {}

    async resolve(input: ModelPolicyResolveInput): Promise<ResolvedModelPolicy> {
        const scopeKeys = [WORKSPACE_POLICY_SCOPE_KEY];
        if (input.agent) scopeKeys.push(agentPolicyScopeKey(input.agent.id));
        if (input.schedule) {
            scopeKeys.push(schedulePolicyScopeKey(input.schedule.source, input.schedule.ownerId));
        }
        const rows = await this.policies.findByScopes(input.workspaceKey, scopeKeys);
        const byKey = new Map(rows.map((row) => [row.scopeKey, row]));

        const workspaceRow = byKey.get(WORKSPACE_POLICY_SCOPE_KEY) ?? null;
        const agentRow = input.agent
            ? (byKey.get(agentPolicyScopeKey(input.agent.id)) ?? null)
            : null;
        const scheduleRow = input.schedule
            ? (byKey.get(schedulePolicyScopeKey(input.schedule.source, input.schedule.ownerId)) ??
              null)
            : null;

        return resolveModelPolicyLadder({
            workspace: toLevel(workspaceRow),
            agent: input.agent
                ? {
                      ...toLevel(agentRow),
                      primaryModel: {
                          providerPluginId: input.agent.aiProviderId ?? null,
                          modelId: input.agent.modelId ?? null,
                      },
                  }
                : null,
            schedule: toLevel(scheduleRow),
        });
    }
}

/** A stored row as one ladder level. The Agent row's primary is never read from here. */
export function toLevel(row: ModelPolicy | null): ModelPolicyLevel | null {
    if (!row) return null;
    return {
        primaryModel: row.scopeType === 'agent' ? null : (row.primaryModel ?? null),
        fallbackModels: row.fallbackModels ?? null,
        reasoningEffort: row.reasoningEffort ?? null,
        runTimeoutSeconds: row.runTimeoutSeconds ?? null,
        attemptTimeoutSeconds: row.attemptTimeoutSeconds ?? null,
    };
}

/** Parse `${source}:${ownerId}` into a known schedule source, or null. */
export function toModelPolicySchedule(key: string | null | undefined): ModelPolicySchedule | null {
    const parsed = parseModelPolicyScheduleKey(key);
    if (!parsed || !(MODEL_POLICY_SCHEDULE_SOURCES as readonly string[]).includes(parsed.source)) {
        return null;
    }
    return { source: parsed.source as ModelPolicyScheduleSource, ownerId: parsed.ownerId };
}
