import type {
    ModelPolicyFieldSource,
    ModelSelection,
    ResolvedModelPolicyField,
} from '@ever-works/contracts';

export interface ModelSelectionInput {
    /** The provider the call named, if any. */
    requestedProviderId?: string;
    /** The model the call named, if any. */
    requestedModelId?: string;
    /** The Agent the call is for, with its own provider/model pair. Null = not an Agent call. */
    agent: { aiProviderId?: string | null; modelId?: string | null } | null;
    /** What the ladder resolved for the primary model. */
    primary: ResolvedModelPolicyField<ModelSelection | null>;
    /** The call asked for a complexity tier (`simpleModel` / `mediumModel` / …). */
    hasComplexity: boolean;
}

export interface ModelSelectionDecision {
    /** Replace the call's provider with this one. Undefined = keep the call's resolution. */
    providerPluginId?: string;
    /** Replace the call's model with this one. Undefined = keep the call's model. */
    modelId?: string;
    source: ModelPolicyFieldSource | 'request';
}

/**
 * Model accounts (AW-16) — whether the model ladder changes a call's provider
 * and model, and to what. Pure; the one place the rule lives.
 *
 * The rule keeps every existing way to choose a model:
 *
 * 1. A call that is not made for an Agent is never re-routed. Work generation,
 *    chat and everything else keep choosing through the Work's selected
 *    plugin and the plugin's own settings.
 * 2. A call that names a provider or model of its own — anything other than
 *    the Agent's own pair — keeps it. The narrowest choice is the call's.
 * 3. A schedule's own model wins over the Agent's pair (an hourly check on a
 *    fast model while manual runs keep the Agent's).
 * 4. The Agent's pair is used as the call already passes it.
 * 5. The workspace default applies only to an Agent with no pair of its own,
 *    and never replaces a complexity tier the call asked for — only the
 *    provider changes, and that provider's own tier setting answers. (The
 *    facade additionally keeps a Work's selected plugin ahead of it.)
 */
export function decideModelSelection(input: ModelSelectionInput): ModelSelectionDecision {
    if (!input.agent) return { source: 'request' };

    const agentProvider = input.agent.aiProviderId ?? undefined;
    const agentModel = input.agent.modelId ?? undefined;
    const providerFromAgent =
        input.requestedProviderId === undefined || input.requestedProviderId === agentProvider;
    const modelFromAgent =
        input.requestedModelId === undefined || input.requestedModelId === agentModel;
    if (!providerFromAgent || !modelFromAgent) return { source: 'request' };

    const { value, source } = input.primary;
    if (source === 'schedule' && value) {
        return {
            providerPluginId: value.providerPluginId ?? undefined,
            modelId: value.modelId ?? undefined,
            source,
        };
    }
    if (source === 'workspace' && value) {
        if (agentProvider || agentModel) return { source: 'agent' };
        return {
            providerPluginId: value.providerPluginId ?? undefined,
            modelId: input.hasComplexity ? undefined : (value.modelId ?? undefined),
            source,
        };
    }
    return { source: agentProvider || agentModel ? 'agent' : 'default' };
}
