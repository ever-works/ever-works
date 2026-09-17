import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    MODEL_POLICY_SCHEDULE_SOURCES,
    MODEL_ROUTING_LIMITS,
    REASONING_EFFORTS,
    sanitizeFallbackChain,
} from '@ever-works/contracts';
import type {
    ModelChainEntry,
    ModelPolicyScheduleSource,
    ModelPolicyView,
    ModelSelection,
    ReasoningEffort,
    ResolvedModelPolicy,
} from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ModelPolicyRepository } from '../database/repositories/model-policy.repository';
import { ownershipWhere } from '../database/ownership-scope';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { Agent } from '../entities/agent.entity';
import type { ModelPolicy } from '../entities/model-policy.entity';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { ModelProviderCatalogService } from './model-provider-catalog.service';
import { ModelPolicyResolver, toModelPolicySchedule } from './model-policy.resolver';
import {
    modelPolicyInvalid,
    modelPolicyScopeNotFound,
    modelProviderUnknown,
} from './model-routing.errors';
import {
    WORKSPACE_POLICY_SCOPE_KEY,
    agentPolicyScopeKey,
    modelWorkspaceKey,
    modelWorkspaceOwnerUserId,
    schedulePolicyScopeKey,
    type ModelWorkspaceScope,
} from './model-workspace';

export type ModelPolicyTarget =
    | { type: 'workspace' }
    | { type: 'agent'; agentId: string }
    | { type: 'schedule'; source: ModelPolicyScheduleSource; ownerId: string };

/**
 * A policy write. A field that is absent is left as stored; `null` clears it
 * back to inheriting.
 */
export interface UpsertModelPolicyInput {
    primaryModel?: ModelSelection | null;
    fallbackModels?: ModelChainEntry[] | null;
    reasoningEffort?: ReasoningEffort | null;
    runTimeoutSeconds?: number | null;
    attemptTimeoutSeconds?: number | null;
}

export interface ModelPolicyWriteResult {
    policy: ModelPolicyView;
    /** Fallbacks removed because the new primary is now that model. */
    removedFromFallbacks: ModelChainEntry[];
}

export interface ResolvedModelPolicyRequest {
    agentId?: string | null;
    /** `${source}:${ownerId}`, as the unified schedule list keys a row. */
    scheduleId?: string | null;
}

/**
 * Model accounts (AW-16) — read and write the model ladder at one scope.
 *
 * - Workspace and schedule policies are rows in `model_policies`.
 * - An Agent's PRIMARY model is the Agent's own `aiProviderId` / `modelId`
 *   pair — the same columns the Agent settings have always written — so this
 *   service writes through to them and there is one place an Agent's model
 *   lives. The Agent's fallbacks and effort are its `model_policies` row.
 *
 * Every rule the ladder promises is enforced here, not only in a DTO: at most
 * three fallbacks, never the primary as its own fallback, no repeats, efforts
 * from the four values, timeouts inside their bounds, and a provider that is
 * an installed ai-provider plugin. A model id missing from the provider's
 * visible catalogue is accepted and marked unverified.
 */
@Injectable()
export class ModelPolicyService {
    private readonly logger = new Logger(ModelPolicyService.name);

    constructor(
        private readonly policies: ModelPolicyRepository,
        private readonly resolver: ModelPolicyResolver,
        private readonly providers: ModelProviderCatalogService,
        @InjectRepository(Agent) private readonly agents: Repository<Agent>,
        @Optional() private readonly settingsService?: PluginSettingsService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async get(
        scope: ModelWorkspaceScope,
        target: ModelPolicyTarget,
    ): Promise<ModelPolicyView | null> {
        const workspaceKey = modelWorkspaceKey(scope);
        const agent =
            target.type === 'agent' ? await this.requireAgent(scope, target.agentId) : null;
        const row = await this.policies.findByScope(workspaceKey, scopeKeyOf(target));
        if (!row && !agent) return null;
        if (!row && agent && !agent.aiProviderId && !agent.modelId) return null;
        return toModelPolicyView(target, row, agent);
    }

    async put(
        scope: ModelWorkspaceScope,
        target: ModelPolicyTarget,
        input: UpsertModelPolicyInput,
    ): Promise<ModelPolicyWriteResult> {
        const workspaceKey = modelWorkspaceKey(scope);
        const agent =
            target.type === 'agent' ? await this.requireAgent(scope, target.agentId) : null;
        const scopeKey = scopeKeyOf(target);
        const existing = await this.policies.findByScope(workspaceKey, scopeKey);
        this.assertBounds(target, input);

        const changed: string[] = [];
        let primary: ModelSelection | null =
            target.type === 'agent'
                ? { providerPluginId: agent!.aiProviderId ?? null, modelId: agent!.modelId ?? null }
                : (existing?.primaryModel ?? null);

        if (input.primaryModel !== undefined) {
            primary = await this.normalizePrimary(target, input.primaryModel, scope.userId);
            changed.push('primaryModel');
        }

        let fallbacks = existing?.fallbackModels ?? null;
        let removedFromFallbacks: ModelChainEntry[] = [];
        if (input.fallbackModels !== undefined) {
            if (input.fallbackModels !== null) {
                const requested = await Promise.all(
                    input.fallbackModels.map((entry) => this.normalizeEntry(entry, scope.userId)),
                );
                const sanitized = sanitizeFallbackChain(primary, requested);
                if (sanitized.removedPrimary.length > 0) {
                    throw modelPolicyInvalid(
                        'Your default model is never offered as its own fallback.',
                    );
                }
                if (sanitized.removedDuplicates.length > 0) {
                    throw modelPolicyInvalid('A fallback list cannot name the same model twice.');
                }
                if (sanitized.removedOverflow.length > 0) {
                    throw modelPolicyInvalid(
                        `A policy can have at most ${MODEL_ROUTING_LIMITS.fallbackEntriesPerPolicy} fallbacks.`,
                    );
                }
                fallbacks = sanitized.chain;
            } else {
                fallbacks = null;
            }
            changed.push('fallbackModels');
        } else if (input.primaryModel !== undefined && fallbacks) {
            // Changing the primary to a model already in the chain removes it
            // from the chain — and says so.
            const sanitized = sanitizeFallbackChain(primary, fallbacks);
            removedFromFallbacks = sanitized.removedPrimary;
            if (removedFromFallbacks.length > 0) {
                fallbacks = sanitized.chain;
                changed.push('fallbackModels');
            }
        }

        const agentModel =
            target.type === 'agent' && input.primaryModel !== undefined
                ? {
                      aiProviderId: primary?.providerPluginId ?? null,
                      modelId: primary?.modelId ?? null,
                  }
                : null;

        const row =
            existing ??
            this.policies.create({
                workspaceKey,
                scopeKey,
                scopeType: target.type,
                scopeId: target.type === 'workspace' ? null : scopeIdOf(target),
                scopeVariant: target.type === 'schedule' ? target.source : null,
            });
        row.userId = scope.userId;
        row.ownerUserId = modelWorkspaceOwnerUserId(scope);
        row.tenantId = scope.tenantId;
        row.organizationId = scope.organizationId;
        if (target.type !== 'agent') {
            row.primaryModel = primary as ModelChainEntry | null;
        }
        row.fallbackModels = fallbacks;
        if (input.reasoningEffort !== undefined) {
            row.reasoningEffort = input.reasoningEffort;
            changed.push('reasoningEffort');
        }
        if (input.runTimeoutSeconds !== undefined) {
            row.runTimeoutSeconds = input.runTimeoutSeconds;
            changed.push('runTimeoutSeconds');
        }
        if (input.attemptTimeoutSeconds !== undefined) {
            row.attemptTimeoutSeconds = input.attemptTimeoutSeconds;
            changed.push('attemptTimeoutSeconds');
        }

        // An Agent whose only change was its primary needs no policy row.
        const needsRow =
            target.type !== 'agent' ||
            existing !== null ||
            row.fallbackModels !== null ||
            row.reasoningEffort != null ||
            row.attemptTimeoutSeconds != null;
        // The Agent's own model pair and the policy row commit together.
        const saved = await this.policies.inTransaction(async (tx) => {
            if (agentModel) await tx.setAgentModel(agent!.id, agentModel);
            return needsRow ? tx.save(row) : null;
        });
        if (agentModel) {
            agent!.aiProviderId = agentModel.aiProviderId;
            agent!.modelId = agentModel.modelId;
        }

        await this.logActivity(scope, scopeKey, [...new Set(changed)]);
        return {
            policy: toModelPolicyView(target, saved, agent),
            removedFromFallbacks,
        };
    }

    /**
     * Return a scope to inheriting. For an Agent this also clears its own
     * provider/model pair, so it follows the workspace default again.
     */
    async remove(scope: ModelWorkspaceScope, target: ModelPolicyTarget): Promise<void> {
        const workspaceKey = modelWorkspaceKey(scope);
        const agent =
            target.type === 'agent' ? await this.requireAgent(scope, target.agentId) : null;
        // Clearing the Agent's pair and deleting its policy row commit together.
        await this.policies.inTransaction(async (tx) => {
            if (agent) {
                await tx.setAgentModel(agent.id, { aiProviderId: null, modelId: null });
            }
            await tx.deleteByScope(workspaceKey, scopeKeyOf(target));
        });
        await this.logActivity(scope, scopeKeyOf(target), ['reset']);
    }

    /** The policy the runtime would use, with where each field came from. */
    async resolve(
        scope: ModelWorkspaceScope,
        request: ResolvedModelPolicyRequest,
    ): Promise<ResolvedModelPolicy> {
        const agent = request.agentId ? await this.requireAgent(scope, request.agentId) : null;
        let schedule = null;
        if (request.scheduleId) {
            schedule = toModelPolicySchedule(request.scheduleId);
            if (!schedule) throw modelPolicyInvalid('Unknown schedule.');
        }
        return this.resolver.resolve({
            workspaceKey: modelWorkspaceKey(scope),
            agent: agent
                ? { id: agent.id, aiProviderId: agent.aiProviderId, modelId: agent.modelId }
                : null,
            schedule,
        });
    }

    private assertBounds(target: ModelPolicyTarget, input: UpsertModelPolicyInput): void {
        if (
            input.reasoningEffort != null &&
            !(REASONING_EFFORTS as readonly string[]).includes(input.reasoningEffort)
        ) {
            throw modelPolicyInvalid('Reasoning effort must be minimal, low, medium or high.');
        }
        if (input.runTimeoutSeconds != null) {
            if (target.type === 'agent') {
                throw modelPolicyInvalid(
                    'A run timeout is set for the workspace or a schedule, not an Agent.',
                );
            }
            assertWithin(
                input.runTimeoutSeconds,
                MODEL_ROUTING_LIMITS.runTimeoutSeconds,
                'Run timeout',
            );
        }
        if (input.attemptTimeoutSeconds != null) {
            assertWithin(
                input.attemptTimeoutSeconds,
                MODEL_ROUTING_LIMITS.attemptTimeoutSeconds,
                'Attempt timeout',
            );
        }
        if (
            target.type === 'schedule' &&
            !(MODEL_POLICY_SCHEDULE_SOURCES as readonly string[]).includes(target.source)
        ) {
            throw modelPolicyInvalid('Unknown schedule.');
        }
    }

    private async normalizePrimary(
        target: ModelPolicyTarget,
        selection: ModelSelection | null,
        userId: string,
    ): Promise<ModelSelection | null> {
        if (selection === null) return null;
        const providerPluginId = selection.providerPluginId?.trim() || null;
        const modelId = selection.modelId?.trim() || null;
        if (target.type === 'agent') {
            // An Agent's pair has always allowed either half on its own.
            if (!providerPluginId && !modelId) return null;
            if (providerPluginId && !(await this.providers.getProvider(providerPluginId))) {
                throw modelProviderUnknown(providerPluginId);
            }
            return { providerPluginId, modelId };
        }
        if (!providerPluginId || !modelId) {
            throw modelPolicyInvalid('A default model names both its provider and its model.');
        }
        return this.normalizeEntry({ providerPluginId, modelId }, userId);
    }

    private async normalizeEntry(entry: ModelChainEntry, userId: string): Promise<ModelChainEntry> {
        const providerPluginId = entry?.providerPluginId?.trim();
        const modelId = entry?.modelId?.trim();
        if (!providerPluginId || !modelId) {
            throw modelPolicyInvalid('Every model names both its provider and its model.');
        }
        const provider = await this.providers.getProvider(providerPluginId);
        if (!provider) throw modelProviderUnknown(providerPluginId);
        const known = await this.catalogueHas(provider.plugin, providerPluginId, modelId, userId);
        return known
            ? { providerPluginId, modelId }
            : { providerPluginId, modelId, unverified: true };
    }

    /** False when the id is absent from, or the provider could not list, its catalogue. */
    private async catalogueHas(
        plugin: {
            listModels(settings?: Record<string, unknown>): Promise<readonly { id: string }[]>;
        },
        providerPluginId: string,
        modelId: string,
        userId: string,
    ): Promise<boolean> {
        try {
            const settings = this.settingsService
                ? await this.settingsService.getSettings(providerPluginId, {
                      userId,
                      includeSecrets: true,
                  })
                : {};
            const models = await plugin.listModels(settings);
            return models.some((model) => model.id === modelId);
        } catch {
            return false;
        }
    }

    private async requireAgent(scope: ModelWorkspaceScope, agentId: string): Promise<Agent> {
        const agent = await this.agents.findOne({
            where: ownershipWhere<Agent>(scope.userId, {
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
            }).map((branch) => ({ ...branch, id: agentId })),
            select: {
                id: true,
                userId: true,
                tenantId: true,
                organizationId: true,
                aiProviderId: true,
                modelId: true,
            },
        });
        if (!agent) throw modelPolicyScopeNotFound();
        return agent;
    }

    private async logActivity(
        scope: ModelWorkspaceScope,
        scopeKey: string,
        fields: string[],
    ): Promise<void> {
        if (!this.activityLog || fields.length === 0) return;
        try {
            await this.activityLog.log({
                userId: scope.userId,
                action: ActivityActionType.MODEL_POLICY_UPDATED,
                actionType: ActivityActionType.MODEL_POLICY_UPDATED,
                status: ActivityStatus.COMPLETED,
                summary: `Model defaults (${scopeKey}) — ${fields.join(', ')}`,
                details: { scopeKey, fields, organizationId: scope.organizationId },
            });
        } catch (error) {
            this.logger.warn(`Failed to log model policy activity: ${error}`);
        }
    }
}

function assertWithin(value: number, bounds: { min: number; max: number }, name: string): void {
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
        throw modelPolicyInvalid(
            `${name} must be a whole number of seconds between ${bounds.min} and ${bounds.max}.`,
        );
    }
}

export function scopeKeyOf(target: ModelPolicyTarget): string {
    switch (target.type) {
        case 'workspace':
            return WORKSPACE_POLICY_SCOPE_KEY;
        case 'agent':
            return agentPolicyScopeKey(target.agentId);
        case 'schedule':
            return schedulePolicyScopeKey(target.source, target.ownerId);
    }
}

function scopeIdOf(target: ModelPolicyTarget): string | null {
    if (target.type === 'agent') return target.agentId;
    if (target.type === 'schedule') return target.ownerId;
    return null;
}

function iso(value: Date | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null;
}

/** A stored policy (and, for an Agent, its own model pair) as the wire view. */
export function toModelPolicyView(
    target: ModelPolicyTarget,
    row: ModelPolicy | null,
    agent: Pick<Agent, 'aiProviderId' | 'modelId'> | null,
): ModelPolicyView {
    let primaryModel: ModelSelection | null = null;
    if (target.type === 'agent') {
        primaryModel =
            agent && (agent.aiProviderId || agent.modelId)
                ? { providerPluginId: agent.aiProviderId ?? null, modelId: agent.modelId ?? null }
                : null;
    } else if (row?.primaryModel) {
        primaryModel = row.primaryModel;
    }
    return {
        scopeType: target.type,
        scopeId: scopeIdOf(target),
        scopeVariant: target.type === 'schedule' ? target.source : null,
        primaryModel,
        fallbackModels: row?.fallbackModels ?? null,
        reasoningEffort: row?.reasoningEffort ?? null,
        runTimeoutSeconds: row?.runTimeoutSeconds ?? null,
        attemptTimeoutSeconds: row?.attemptTimeoutSeconds ?? null,
        updatedAt: iso(row?.updatedAt),
    };
}
