import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { MODEL_ROUTING_LIMITS, isModelAccountUsable } from '@ever-works/contracts';
import type { AgentRunModelRouting } from '@ever-works/contracts';
import { ModelAccountRepository } from '../database/repositories/model-account.repository';
import { ModelPolicyRepository } from '../database/repositories/model-policy.repository';
import { AgentRun } from '../entities/agent-run.entity';
import { Agent } from '../entities/agent.entity';
import { Work } from '../entities/work.entity';
import { ModelAccountHealthService } from './model-account-health.service';
import { ModelPolicyResolver, toModelPolicySchedule } from './model-policy.resolver';
import { decideModelSelection } from './model-route-planner.rules';
import type {
    ModelAccountSelection,
    ModelAnswerRecord,
    ModelRoutePlan,
    ModelRoutePlanner,
    ModelRouteRequest,
} from './model-route-planner.port';
import { isCredentialRejection } from './model-routing.signals';
import { modelWorkspaceKey, type ModelWorkspaceScope } from './model-workspace';

type RunRow = Pick<
    AgentRun,
    'id' | 'agentId' | 'userId' | 'tenantId' | 'organizationId' | 'triggerKind' | 'modelRouting'
>;
type AgentRow = Pick<
    Agent,
    'id' | 'userId' | 'tenantId' | 'organizationId' | 'aiProviderId' | 'modelId'
>;
type WorkRow = Pick<Work, 'id' | 'userId' | 'tenantId' | 'organizationId'>;

const MINUTE_MS = 60_000;

/** A small TTL + size-bounded memo. The window is the "a change binds within 5 s" promise. */
class TtlMemo<V> {
    private readonly entries = new Map<string, { value: V; expiresAt: number }>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries = 500,
    ) {}

    get(key: string, now = Date.now()): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= now) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: V, now = Date.now()): void {
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    }

    async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
        const cached = this.get(key);
        if (cached !== undefined) return cached;
        const value = await load();
        this.set(key, value);
        return value;
    }
}

/**
 * Model accounts (AW-16) — the planner the AI facade asks around every call.
 *
 * Phase 1 plans exactly ONE attempt: the ladder's primary (or the call's own
 * choice) on the provider's first usable account by position — or, when a
 * workspace has configured nothing, nothing at all, so the call runs exactly
 * as before. There is no failover yet; the facade's existing same-provider
 * tier escalation stays the only retry.
 *
 * Reads are memoised for {@link MODEL_ROUTING_LIMITS.changePropagationMs}
 * (5 s), which is the promise that a policy or order change binds on the next
 * call without restarting anything. The whole-feature probe means a
 * deployment with no accounts and no policies pays two cached existence reads
 * and nothing else.
 */
@Injectable()
export class ModelRoutePlannerService implements ModelRoutePlanner {
    private readonly logger = new Logger(ModelRoutePlannerService.name);
    private readonly ttl = MODEL_ROUTING_LIMITS.changePropagationMs;
    private readonly featureMemo = new TtlMemo<boolean>(this.ttl, 1);
    private readonly workspaceAccountsMemo = new TtlMemo<boolean>(this.ttl);
    private readonly runMemo = new TtlMemo<RunRow | null>(this.ttl);
    private readonly agentMemo = new TtlMemo<AgentRow | null>(this.ttl);
    private readonly workMemo = new TtlMemo<WorkRow | null>(this.ttl);
    /** runId → signature of the routing last written, so each round writes only on change. */
    private readonly recorded = new TtlMemo<string>(60 * MINUTE_MS, 2000);

    constructor(
        private readonly accounts: ModelAccountRepository,
        private readonly policies: ModelPolicyRepository,
        private readonly resolver: ModelPolicyResolver,
        @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
        @InjectRepository(Agent) private readonly agents: Repository<Agent>,
        @InjectRepository(Work) private readonly works: Repository<Work>,
        @Optional() private readonly health?: ModelAccountHealthService,
    ) {}

    async plan(request: ModelRouteRequest): Promise<ModelRoutePlan | null> {
        if (!(await this.featureInUse())) return null;

        const run = request.runId ? await this.loadRun(request.runId) : null;
        const agentId = request.agentId ?? run?.agentId ?? undefined;
        const agent = agentId ? await this.loadAgent(agentId) : null;
        const scope = await this.scopeFor(request, run, agent);
        const workspaceKey = modelWorkspaceKey(scope);
        const schedule = toModelPolicySchedule(
            request.scheduleId ??
                (run?.triggerKind === 'heartbeat' && agentId ? `agent_heartbeat:${agentId}` : null),
        );

        const [resolved, accountsAvailable] = await Promise.all([
            this.resolver.resolve({
                workspaceKey,
                agent: agent
                    ? { id: agent.id, aiProviderId: agent.aiProviderId, modelId: agent.modelId }
                    : null,
                schedule,
            }),
            this.workspaceAccountsMemo.getOrLoad(workspaceKey, () =>
                this.accounts.existsInWorkspace(workspaceKey),
            ),
        ]);

        let decision = decideModelSelection({
            requestedProviderId: request.requestedProviderId,
            requestedModelId: request.requestedModelId,
            agent: agent ? { aiProviderId: agent.aiProviderId, modelId: agent.modelId } : null,
            primary: resolved.primaryModel,
            hasComplexity: !!request.hasComplexity,
        });

        // A Run in flight keeps the routing it resolved when it started: a
        // policy change mid-Run binds on the NEXT Run, never halfway through.
        const pinned = run?.modelRouting ?? null;
        if (
            pinned &&
            decision.source !== 'request' &&
            (pinned.primarySource === 'schedule' || pinned.primarySource === 'workspace')
        ) {
            decision = {
                providerPluginId: pinned.provider,
                modelId: pinned.resolvedModel ?? undefined,
                source: pinned.primarySource,
            };
        }

        const reasoningEffort =
            request.requestedEffort ??
            (pinned && pinned.effort !== 'not-applicable' ? pinned.effort : undefined) ??
            resolved.reasoningEffort.value;
        const runTimeoutSeconds = pinned?.runTimeoutSeconds ?? resolved.runTimeoutSeconds.value;

        const changesCall =
            decision.providerPluginId !== undefined || decision.modelId !== undefined;
        if (!changesCall && !accountsAvailable && !run) return null;

        const plan: ModelRoutePlan = {
            workspaceKey,
            primarySource: decision.source,
            reasoningEffort,
            runTimeoutSeconds,
            accountsAvailable,
        };
        return {
            ...plan,
            ...(decision.providerPluginId !== undefined
                ? { providerPluginId: decision.providerPluginId }
                : {}),
            ...(decision.modelId !== undefined ? { modelId: decision.modelId } : {}),
        };
    }

    async selectAccount(
        plan: ModelRoutePlan,
        providerPluginId: string,
    ): Promise<ModelAccountSelection | null> {
        if (!plan.accountsAvailable) return null;
        const rows = await this.accounts.listInWorkspace(plan.workspaceKey, providerPluginId);
        const now = new Date();
        for (const row of rows) {
            if (
                !isModelAccountUsable(
                    {
                        health: row.health,
                        enabled: row.enabled,
                        credentialExpiresAt: row.credentialExpiresAt ?? null,
                    },
                    now,
                )
            ) {
                continue;
            }
            if (row.cooldownUntil && new Date(row.cooldownUntil).getTime() > now.getTime())
                continue;
            const credentials = nonEmptyCredentials(row.credentials);
            if (!credentials) continue;
            return { accountId: row.id, label: row.label, credentials };
        }
        return null;
    }

    async recordAnswer(record: ModelAnswerRecord): Promise<void> {
        try {
            const routing: AgentRunModelRouting = {
                provider: record.provider,
                model: record.model,
                accountId: record.account?.accountId ?? null,
                accountLabel: record.account?.label ?? null,
                effort: record.requestedEffort ?? record.plan?.reasoningEffort ?? 'medium',
                effortApplied: false,
                runTimeoutSeconds:
                    record.plan?.runTimeoutSeconds ??
                    MODEL_ROUTING_LIMITS.runTimeoutSeconds.default,
                outcome: 'answered',
                attempts: [
                    {
                        provider: record.provider,
                        model: record.model,
                        ...(record.account ? { accountLabel: record.account.label } : {}),
                        result: 'ok',
                        ms: Math.max(0, Math.round(record.durationMs)),
                    },
                ],
                primarySource: record.plan?.primarySource ?? 'default',
                resolvedModel: record.plan?.modelId ?? null,
                recordedAt: new Date().toISOString(),
            };
            const signature = [
                routing.provider,
                routing.model,
                routing.accountId ?? '',
                routing.effort,
                routing.runTimeoutSeconds,
                routing.primarySource,
                routing.resolvedModel ?? '',
            ].join('|');
            if (this.recorded.get(record.runId) !== signature) {
                await this.runs.update({ id: record.runId }, { modelRouting: routing });
                this.recorded.set(record.runId, signature);
                const cachedRun = this.runMemo.get(record.runId);
                if (cachedRun)
                    this.runMemo.set(record.runId, { ...cachedRun, modelRouting: routing });
            }
            if (record.account) {
                const now = new Date();
                await this.accounts.touchLastUsed(
                    record.account.accountId,
                    now,
                    new Date(now.getTime() - MINUTE_MS),
                );
            }
        } catch (error) {
            this.logger.debug(
                `Could not record routing for run ${record.runId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    async reportFailure(accountId: string, error: unknown): Promise<void> {
        if (!this.health || !isCredentialRejection(error)) return;
        try {
            await this.health.applyLiveRejection(accountId);
        } catch (writeError) {
            this.logger.debug(
                `Could not mark model account ${accountId} invalid: ${
                    writeError instanceof Error ? writeError.message : String(writeError)
                }`,
            );
        }
    }

    private async featureInUse(): Promise<boolean> {
        return this.featureMemo.getOrLoad('any', async () => {
            const [accounts, policies] = await Promise.all([
                this.accounts.anyExist(),
                this.policies.anyExist(),
            ]);
            return accounts || policies;
        });
    }

    private loadRun(runId: string): Promise<RunRow | null> {
        return this.runMemo.getOrLoad(runId, () =>
            this.runs.findOne({
                where: { id: runId },
                select: {
                    id: true,
                    agentId: true,
                    userId: true,
                    tenantId: true,
                    organizationId: true,
                    triggerKind: true,
                    modelRouting: true,
                },
            }),
        );
    }

    private loadAgent(agentId: string): Promise<AgentRow | null> {
        return this.agentMemo.getOrLoad(agentId, () =>
            this.agents.findOne({
                where: { id: agentId },
                select: {
                    id: true,
                    userId: true,
                    tenantId: true,
                    organizationId: true,
                    aiProviderId: true,
                    modelId: true,
                },
            }),
        );
    }

    private async scopeFor(
        request: ModelRouteRequest,
        run: RunRow | null,
        agent: AgentRow | null,
    ): Promise<ModelWorkspaceScope> {
        const owner = run ?? agent;
        if (owner) {
            return {
                userId: owner.userId,
                tenantId: owner.tenantId ?? null,
                organizationId: owner.organizationId ?? null,
            };
        }
        if (request.workId) {
            const workId = request.workId;
            const work = await this.workMemo.getOrLoad(workId, () =>
                this.works.findOne({
                    where: { id: workId },
                    select: { id: true, userId: true, tenantId: true, organizationId: true },
                }),
            );
            if (work) {
                return {
                    userId: work.userId,
                    tenantId: work.tenantId ?? null,
                    organizationId: work.organizationId ?? null,
                };
            }
        }
        return { userId: request.userId, tenantId: null, organizationId: null };
    }
}

function nonEmptyCredentials(
    credentials: Record<string, string> | null | undefined,
): Record<string, string> | null {
    if (!credentials) return null;
    const picked: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
        if (typeof value === 'string' && value.length > 0) picked[key] = value;
    }
    return Object.keys(picked).length > 0 ? picked : null;
}
