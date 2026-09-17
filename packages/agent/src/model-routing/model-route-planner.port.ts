import type { ModelPolicyFieldSource, ReasoningEffort } from '@ever-works/contracts';

/**
 * Model accounts (AW-16) — injection token + contract for the questions the
 * AI facade asks around every model call: "which provider and model does
 * the ladder want here, which account's credentials answer it, and what
 * actually answered?"
 *
 * Token + contract only (a leaf file with type-only imports — the same
 * circular-dependency dodge as `email/email-send-policy.port.ts`).
 * `AiFacadeService` consumes it via `@Optional() @Inject(...)`;
 * `ModelRoutingModule` binds it to `ModelRoutePlannerService`.
 *
 * Unbound (a bare unit-test context) = no planner, which is exactly the
 * behaviour the facade had before this port existed. A planner that fails or
 * finds nothing configured also leaves the call exactly as it was.
 */

export interface ModelRouteRequest {
    readonly userId: string;
    readonly workId?: string;
    readonly agentId?: string;
    readonly runId?: string;
    /** `${source}:${ownerId}`, as the unified schedule list keys a row. */
    readonly scheduleId?: string;
    /** The provider the call named (routing override or facade override). */
    readonly requestedProviderId?: string;
    /** The model the call named (routing override or completion option). */
    readonly requestedModelId?: string;
    /** True when the call asked for a complexity tier. */
    readonly hasComplexity?: boolean;
    /** A reasoning effort the call itself asked for. */
    readonly requestedEffort?: ReasoningEffort;
}

export interface ModelRoutePlan {
    readonly workspaceKey: string;
    /**
     * The provider the ladder wants, when it replaces the call's own
     * resolution. Undefined = resolve the provider exactly as before.
     */
    readonly providerPluginId?: string;
    /** The model the ladder wants, when it replaces the call's own. Undefined = unchanged. */
    readonly modelId?: string;
    /** Which scope chose the primary. `request` = the call named its own. */
    readonly primarySource: ModelPolicyFieldSource | 'request';
    readonly reasoningEffort: ReasoningEffort;
    readonly runTimeoutSeconds: number;
    /** True when this workspace holds any Model Account worth looking up. */
    readonly accountsAvailable: boolean;
}

export interface ModelAccountSelection {
    readonly accountId: string;
    readonly label: string;
    /** The provider's secret settings, keyed as its schema names them. Never logged. */
    readonly credentials: Readonly<Record<string, string>>;
}

export interface ModelAnswerRecord {
    readonly runId: string;
    readonly plan: ModelRoutePlan | null;
    readonly provider: string;
    readonly model: string;
    readonly account: { readonly accountId: string; readonly label: string } | null;
    readonly durationMs: number;
    readonly requestedEffort?: ReasoningEffort;
}

export interface ModelRoutePlanner {
    /**
     * The ladder's answer for one call, or null when nothing is configured
     * for its workspace (the call then runs exactly as it always has).
     */
    plan(request: ModelRouteRequest): Promise<ModelRoutePlan | null>;

    /** The first usable account for a provider in the plan's workspace, by position. */
    selectAccount(
        plan: ModelRoutePlan,
        providerPluginId: string,
    ): Promise<ModelAccountSelection | null>;

    /** Record what answered a Run and stamp the account as used. Best-effort; never throws. */
    recordAnswer(record: ModelAnswerRecord): Promise<void>;

    /** A call on this account failed. A credential rejection marks it invalid at once. */
    reportFailure(accountId: string, error: unknown): Promise<void>;
}

export const MODEL_ROUTE_PLANNER = 'MODEL_ROUTE_PLANNER' as const;
