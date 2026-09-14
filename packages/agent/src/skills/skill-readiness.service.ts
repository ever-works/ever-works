import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    SKILL_READINESS_AGENTS_MAX,
    SKILL_READINESS_LIST_RECHECK_MAX,
    SKILL_READINESS_SWEEP_BATCH,
    SKILL_READINESS_SWEEP_PER_USER,
    SKILL_READINESS_TTL_MS,
    normalizeSkillTags,
    type ResolvedToolGrants,
    type SkillReadinessDetail,
    type SkillReadinessState,
    type SkillRequirement,
} from '@ever-works/contracts';
import type { Skill } from '../entities/skill.entity';
import type { SkillBinding } from '../entities/skill-binding.entity';
import type { Agent } from '../entities/agent.entity';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { SkillTagRepository } from '../database/repositories/skill-tag.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import { TOOL_GRANT_ENFORCER, type ToolGrantEnforcer } from '../policy/tool-grant.enforcer';
import { CREDENTIAL_RESOLVER, type CredentialResolver } from '../policy/credential-resolver';
import { filterSkillsByToolGrants } from '../policy/skill-activation';
import { decideToolGrant } from '../policy/tool-grant';
import { requiredCredentialsForTool } from '../policy/tool-credentials';
import { collectCredentialRefs } from '../policy/credential-interpolation';
import {
    carryRunSuppressions,
    decideSkillReadiness,
    declaredToolsOf,
    mcpServerNameOf,
} from './skill-readiness.ladder';

export interface SkillReadinessVerdict {
    readiness: SkillReadinessState;
    detail: SkillReadinessDetail;
}

export interface SkillReadinessSweepSummary {
    scanned: number;
    changed: number;
    failed: number;
    byState: Record<SkillReadinessState, number>;
    durationMs: number;
}

/**
 * Skills shelf — "will this Skill actually be picked up on the next run?"
 *
 * Reads, never writes, everything a verdict depends on — and writes ONLY the
 * three readiness columns on the Skill:
 *
 *   1. its bindings              → none, or every one muted → `needs_setup`
 *   2. what it declares it needs → the frontmatter `allowedTools`, plus every
 *      `{{cred.key}}` its instructions reference
 *        - `mcp__<server>__…` tools  → the stored connection row by name
 *        - declared tool credentials → `requiredCredentialsForTool`
 *        - every credential key      → the credential port's key-set diff
 *      anything unset / not connected → `missing_requirements`
 *   3. the tool-grant matrix for the agents the Skill reaches, through the
 *      same `filterSkillsByToolGrants` the run path uses → every tool refused
 *      for every agent → `blocked_by_access`
 *
 * Nothing here is a hard-coded list of "what a Skill needs": requirements come
 * from what the Skill declares, checked against real state through the
 * existing ports. No outbound network call is made (a remote service being
 * slow can never make the shelf slow), and no credential VALUE is ever kept —
 * the resolver's answer is reduced to "which keys came back" immediately.
 *
 * Every dependency is `@Optional()`: a runtime without the policy module or
 * the MCP registry still gets a verdict, and a failed check yields
 * `check_failed` — never `ready`, and never the `unknown` a Skill carries
 * before anything has checked it.
 */
@Injectable()
export class SkillReadinessService {
    private readonly logger = new Logger(SkillReadinessService.name);
    /** Skill ids a background re-check is already running for (this process). */
    private readonly recheckInFlight = new Set<string>();

    constructor(
        private readonly skills: SkillRepository,
        private readonly bindings: SkillBindingRepository,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly mcpConnections?: McpServerConnectionRepository,
        @Optional()
        @Inject(TOOL_GRANT_ENFORCER)
        private readonly toolGrants?: ToolGrantEnforcer,
        @Optional()
        @Inject(CREDENTIAL_RESOLVER)
        private readonly credentials?: CredentialResolver,
        @Optional() private readonly tags?: SkillTagRepository,
    ) {}

    /** Compute a verdict for one Skill. Never throws. */
    async evaluate(skill: Skill, now: Date = new Date()): Promise<SkillReadinessVerdict> {
        let bindings: SkillBinding[] = [];
        let bindingsFailed = false;
        try {
            bindings = await this.bindings.findBySkillId(skill.id, skill.userId);
        } catch (err) {
            bindingsFailed = true;
            this.logger.warn(`Readiness: binding lookup failed for skill ${skill.id}: ${err}`);
        }
        const active = bindings.filter((binding) => binding.injectIntoAgent);

        const reach = bindingsFailed
            ? { agents: [] as Agent[], failed: false }
            : await this.agentsInReach(skill.userId, active);
        const agents = reach.agents;
        const tools = declaredToolsOf(skill.frontmatter?.allowedTools);
        const requirements: SkillRequirement[] = [];

        const {
            rows: toolRows,
            blockedForEveryAgent,
            blockedAgentIds,
            grantsReadForAgentIds,
        } = await this.checkTools(skill, tools, agents, reach.failed);
        requirements.push(...toolRows);
        requirements.push(...(await this.checkConnections(skill.userId, tools)));
        requirements.push(...(await this.checkCredentials(skill, tools, agents, reach.failed)));

        // A suppression a run recorded for an agent this check did not
        // actually evaluate is kept, not silently cleared (see the ladder).
        const runSuppressions = carryRunSuppressions(skill.readinessDetail?.runSuppressions, {
            declaredTools: tools,
            evaluatedAgentIds: grantsReadForAgentIds,
            blockedAgentIds,
            now,
        });

        return decideSkillReadiness({
            bindingsFailed,
            agentLookupFailed: reach.failed,
            boundTargetCount: bindings.length,
            mutedBindingCount: bindings.length - active.length,
            requirements,
            blockedForEveryAgent,
            evaluatedForAgentIds: agents.map((agent) => agent.id),
            evaluatedAt: now,
            blockedForAgentIds: blockedAgentIds,
            runSuppressions,
        });
    }

    /**
     * Evaluate and persist. Returns null when the Skill is not the caller's
     * (or no longer exists). Never throws for a check failure — only for the
     * write itself, which callers on a user path treat as best-effort.
     */
    async refresh(
        userId: string,
        skillId: string,
    ): Promise<{ skill: Skill; verdict: SkillReadinessVerdict } | null> {
        const skill = await this.skills.findByIdAndUser(skillId, userId);
        if (!skill) return null;
        const verdict = await this.refreshSkill(skill);
        return { skill, verdict };
    }

    /** Evaluate a loaded Skill and write the three readiness columns onto it. */
    async refreshSkill(skill: Skill, now: Date = new Date()): Promise<SkillReadinessVerdict> {
        const verdict = await this.evaluate(skill, now);
        await this.skills.recordReadiness(skill.id, skill.userId, {
            readiness: verdict.readiness,
            readinessDetail: verdict.detail,
            readinessCheckedAt: now,
        });
        skill.readiness = verdict.readiness;
        skill.readinessDetail = verdict.detail;
        skill.readinessCheckedAt = now;
        return verdict;
    }

    /**
     * The hourly sweep: re-check every Skill whose verdict is missing or older
     * than an hour, oldest first, at most 500 per tick and 200 per user. One
     * Skill failing never aborts the tick. Also re-derives the Skill's tag rows
     * from its definition, so a tag write that failed after a Skill write heals
     * within the hour.
     *
     * Counters only in the result — never a body, a tag or a credential key.
     */
    async sweepStale(
        options: { now?: Date; limit?: number; perUser?: number } = {},
    ): Promise<SkillReadinessSweepSummary> {
        const started = Date.now();
        const now = options.now ?? new Date();
        const byState: Record<SkillReadinessState, number> = {
            ready: 0,
            needs_setup: 0,
            missing_requirements: 0,
            blocked_by_access: 0,
            unknown: 0,
            check_failed: 0,
        };
        const batch = await this.skills.findStaleForReadiness(
            new Date(now.getTime() - SKILL_READINESS_TTL_MS),
            options.limit ?? SKILL_READINESS_SWEEP_BATCH,
            options.perUser ?? SKILL_READINESS_SWEEP_PER_USER,
        );

        let changed = 0;
        let failed = 0;
        for (const skill of batch) {
            try {
                const before = skill.readiness;
                const verdict = await this.refreshSkill(skill, now);
                byState[verdict.readiness] += 1;
                if (before !== verdict.readiness) changed += 1;
                if (this.tags) {
                    const { tags } = normalizeSkillTags(skill.frontmatter?.tags);
                    await this.tags.replaceForSkill(skill.id, skill.userId, tags, {
                        tenantId: skill.tenantId ?? null,
                        organizationId: skill.organizationId ?? null,
                    });
                }
            } catch (err) {
                failed += 1;
                this.logger.warn(`Readiness sweep: skill ${skill.id} failed: ${err}`);
            }
        }

        return {
            scanned: batch.length,
            changed,
            failed,
            byState,
            durationMs: Date.now() - started,
        };
    }

    /**
     * The shelf list's background top-up: of the Skills a person is looking
     * at, re-check the ones nothing has checked yet or whose verdict is older
     * than the sweep's hour, at most `max` per call and one at a time. A Skill
     * whose re-check is already running in this process is skipped, so
     * reloading the shelf does not queue the same work twice.
     *
     * Works on copies — the rows the caller is about to serialise are never
     * mutated underneath it. Never throws: every failure is logged and the
     * hourly sweep picks the Skill up again. Resolves with how many Skills it
     * re-checked.
     */
    async recheckVisible(
        skills: readonly Skill[],
        options: { now?: Date; max?: number } = {},
    ): Promise<number> {
        const now = options.now ?? new Date();
        const max = Math.max(0, options.max ?? SKILL_READINESS_LIST_RECHECK_MAX);
        const staleBefore = now.getTime() - SKILL_READINESS_TTL_MS;
        const picked: Skill[] = [];
        for (const skill of skills) {
            if (picked.length >= max) break;
            if (!skill?.id || this.recheckInFlight.has(skill.id)) continue;
            const checkedAt = skill.readinessCheckedAt
                ? new Date(skill.readinessCheckedAt).getTime()
                : Number.NaN;
            const due =
                skill.readiness === 'unknown' ||
                !Number.isFinite(checkedAt) ||
                checkedAt < staleBefore;
            if (!due) continue;
            this.recheckInFlight.add(skill.id);
            picked.push(skill);
        }

        let rechecked = 0;
        for (const skill of picked) {
            try {
                await this.refreshSkill({ ...skill } as Skill, now);
                rechecked += 1;
            } catch (err) {
                this.logger.warn(
                    `Readiness: background re-check failed for skill ${skill.id}: ${err}`,
                );
            } finally {
                this.recheckInFlight.delete(skill.id);
            }
        }
        return rechecked;
    }

    // ── checks ───────────────────────────────────────────────────

    /**
     * The agents a Skill actually reaches through its unmuted bindings, at
     * most 10: agent bindings directly, Work/Mission/Idea bindings through the
     * agents pinned there, a workspace binding through the owner's agents.
     *
     * `failed` is true when a lookup threw part-way: `agents` then holds only
     * the agents resolved before the failure, which is NOT the set the Skill
     * reaches, so the checks treat anything that depends on the missing agents
     * as not checked, never as a verdict.
     */
    private async agentsInReach(
        userId: string,
        active: SkillBinding[],
    ): Promise<{ agents: Agent[]; failed: boolean }> {
        if (!this.agents || active.length === 0) return { agents: [], failed: false };
        const found = new Map<string, Agent>();
        const add = (rows: Agent[]) => {
            for (const agent of rows) {
                if (found.size >= SKILL_READINESS_AGENTS_MAX) return;
                found.set(agent.id, agent);
            }
        };
        try {
            for (const binding of active) {
                if (found.size >= SKILL_READINESS_AGENTS_MAX) break;
                if (binding.targetType === 'agent' && binding.targetId) {
                    const agent = await this.agents.findByIdAndUser(binding.targetId, userId);
                    if (agent) add([agent]);
                }
            }
            for (const binding of active) {
                if (found.size >= SKILL_READINESS_AGENTS_MAX) break;
                const limit = SKILL_READINESS_AGENTS_MAX - found.size;
                if (binding.targetType === 'work' && binding.targetId) {
                    add(
                        (
                            await this.agents.findByUserIdScoped(userId, {
                                workId: binding.targetId,
                                limit,
                            })
                        ).rows,
                    );
                } else if (binding.targetType === 'mission' && binding.targetId) {
                    add(
                        (
                            await this.agents.findByUserIdScoped(userId, {
                                missionId: binding.targetId,
                                limit,
                            })
                        ).rows,
                    );
                } else if (binding.targetType === 'idea' && binding.targetId) {
                    add(
                        (
                            await this.agents.findByUserIdScoped(userId, {
                                ideaId: binding.targetId,
                                limit,
                            })
                        ).rows,
                    );
                } else if (binding.targetType === 'tenant') {
                    add((await this.agents.findByUserIdScoped(userId, { limit })).rows);
                }
            }
        } catch (err) {
            // A partial set is not the set the Skill reaches: an agent that
            // was never resolved might allow (or need) exactly what the
            // resolved ones do not. Report the failure so the checks cannot
            // turn it into a definitive verdict.
            this.logger.warn(`Readiness: agent lookup failed for user ${userId}: ${err}`);
            return { agents: [...found.values()], failed: true };
        }
        return { agents: [...found.values()], failed: false };
    }

    /**
     * Per declared tool: allowed for at least one agent → met; refused for
     * every agent → refused. The Skill-level "blocked" verdict comes from the
     * run path's own `filterSkillsByToolGrants`, so the shelf and the run can
     * never disagree about what suppression means.
     *
     * Also reports, per agent, which ones the Skill is blocked for and whose
     * grants were actually read (`null` when none were), so a run-time
     * suppression is only ever cleared by a check that covered its agent.
     *
     * When the agent lookup failed part-way (`agentLookupFailed`), only what
     * the resolved agents PROVE survives: a tool allowed for one of them is
     * met. A tool refused for all of them is `unknown` (an unresolved agent
     * may allow it), and the Skill is never reported blocked for every agent.
     * With no agent resolved at all, the workspace-level fallback matrix is
     * not consulted, because it is not what those agents run with.
     */
    private async checkTools(
        skill: Skill,
        tools: string[],
        agents: Agent[],
        agentLookupFailed = false,
    ): Promise<{
        rows: SkillRequirement[];
        blockedForEveryAgent: boolean;
        blockedAgentIds: string[];
        grantsReadForAgentIds: string[] | null;
    }> {
        if (tools.length === 0) {
            return {
                rows: [],
                blockedForEveryAgent: false,
                blockedAgentIds: [],
                grantsReadForAgentIds: null,
            };
        }
        if (!this.toolGrants) {
            // No matrix wired — the run path treats every tool as allowed.
            return {
                rows: tools.map((tool) => ({ kind: 'tool', id: tool, status: 'met' })),
                blockedForEveryAgent: false,
                blockedAgentIds: [],
                grantsReadForAgentIds: null,
            };
        }
        const notChecked = (tool: string): SkillRequirement => ({
            kind: 'tool',
            id: tool,
            status: 'unknown',
            reason: 'checkFailed',
        });
        if (agentLookupFailed && agents.length === 0) {
            return {
                rows: tools.map(notChecked),
                blockedForEveryAgent: false,
                blockedAgentIds: [],
                grantsReadForAgentIds: null,
            };
        }

        const scopes: Array<{ agentId: string | null; workId: string | null }> =
            agents.length > 0
                ? agents.map((agent) => ({ agentId: agent.id, workId: agent.workId ?? null }))
                : [{ agentId: null, workId: null }];

        const matrices: Array<{ agentId: string | null; grants: ResolvedToolGrants }> = [];
        try {
            for (const scope of scopes) {
                const grants = await this.toolGrants.resolve({
                    userId: skill.userId,
                    agentId: scope.agentId,
                    workId: scope.workId,
                });
                matrices.push({ agentId: scope.agentId, grants });
            }
        } catch (err) {
            this.logger.warn(
                `Readiness: tool-grant resolution failed for skill ${skill.id}: ${err}`,
            );
            return {
                rows: tools.map(notChecked),
                blockedForEveryAgent: false,
                blockedAgentIds: [],
                grantsReadForAgentIds: null,
            };
        }

        const blockedFor = matrices.map(
            ({ grants }) =>
                filterSkillsByToolGrants([{ slug: skill.slug, allowedTools: tools }], grants)
                    .suppressed.length === 1,
        );
        const blockedForEveryAgent = !agentLookupFailed && blockedFor.every(Boolean);
        const blockedAgentIds: string[] = [];
        matrices.forEach(({ agentId }, index) => {
            if (agentId && blockedFor[index]) blockedAgentIds.push(agentId);
        });

        const rows: SkillRequirement[] = tools.map((tool) => {
            const refusedFor = matrices.filter(
                ({ grants }) =>
                    !decideToolGrant({ matrix: grants.matrix, chain: grants.chain }, tool).allowed,
            );
            if (refusedFor.length < matrices.length)
                return { kind: 'tool', id: tool, status: 'met' };
            if (agentLookupFailed) return notChecked(tool);
            const row: SkillRequirement = {
                kind: 'tool',
                id: tool,
                status: 'refused',
                reason: 'refusedByGrants',
            };
            const agentId = refusedFor[0]?.agentId;
            if (agentId) row.fixTarget = { surface: 'access', ref: agentId };
            return row;
        });
        return {
            rows,
            blockedForEveryAgent,
            blockedAgentIds,
            grantsReadForAgentIds: agents.map((agent) => agent.id),
        };
    }

    /** `mcp__<server>__<tool>` names its connection; read that row, never connect. */
    private async checkConnections(userId: string, tools: string[]): Promise<SkillRequirement[]> {
        const servers: string[] = [];
        for (const tool of tools) {
            const server = mcpServerNameOf(tool);
            if (server && !servers.includes(server)) servers.push(server);
        }
        if (servers.length === 0) return [];

        const rows: SkillRequirement[] = [];
        for (const server of servers) {
            const fixTarget = { surface: 'connections' as const, ref: server };
            if (!this.mcpConnections) {
                rows.push({
                    kind: 'connection',
                    id: server,
                    status: 'unknown',
                    reason: 'checkFailed',
                    fixTarget,
                });
                continue;
            }
            try {
                const connection = await this.mcpConnections.findByUserAndName(userId, server);
                if (!connection) {
                    rows.push({
                        kind: 'connection',
                        id: server,
                        status: 'missing',
                        reason: 'notConnected',
                        fixTarget,
                    });
                } else if (!connection.enabled) {
                    rows.push({
                        kind: 'connection',
                        id: server,
                        status: 'missing',
                        reason: 'disabled',
                        fixTarget,
                    });
                } else {
                    rows.push({ kind: 'connection', id: server, status: 'met' });
                }
            } catch (err) {
                this.logger.warn(`Readiness: connection lookup failed for "${server}": ${err}`);
                rows.push({
                    kind: 'connection',
                    id: server,
                    status: 'unknown',
                    reason: 'checkFailed',
                    fixTarget,
                });
            }
        }
        return rows;
    }

    /**
     * Every credential KEY the Skill needs — declared by its tools, or
     * referenced as `{{cred.key}}` in its instructions — asked of the
     * credential port. Only the returned key SET is looked at; the map (and
     * with it every value) is discarded before this method returns.
     *
     * The keys are resolved for the first agent the Skill reaches. If the
     * agent lookup failed before ANY agent was resolved, that is not the
     * agent a complete lookup would have used, so a key that did not come
     * back is `unknown`, never a false "missing" (a key that did come back is
     * still met).
     */
    private async checkCredentials(
        skill: Skill,
        tools: string[],
        agents: Agent[],
        agentLookupFailed = false,
    ): Promise<SkillRequirement[]> {
        const keys: string[] = [];
        for (const tool of tools) {
            for (const key of requiredCredentialsForTool(tool)) {
                if (!keys.includes(key)) keys.push(key);
            }
        }
        for (const key of collectCredentialRefs(skill.instructionsMd ?? '')) {
            if (!keys.includes(key)) keys.push(key);
        }
        if (keys.length === 0) return [];

        const unknownRows = (): SkillRequirement[] =>
            keys.map((key) => ({
                kind: 'credential',
                id: key,
                status: 'unknown',
                reason: 'checkFailed',
                fixTarget: { surface: 'credentials', ref: key },
            }));
        if (!this.credentials) return unknownRows();

        let available: Set<string>;
        try {
            const resolved = await this.credentials.resolve(
                {
                    userId: skill.userId,
                    agentId: agents[0]?.id ?? null,
                    workId: agents[0]?.workId ?? null,
                    organizationId: skill.organizationId ?? null,
                    tenantId: skill.tenantId ?? null,
                },
                keys,
            );
            // Keys only: the map, and every value in it, goes out of scope here.
            available = new Set(resolved.keys());
        } catch (err) {
            this.logger.warn(`Readiness: credential check failed for skill ${skill.id}: ${err}`);
            return unknownRows();
        }

        const firstAgentUnknown = agentLookupFailed && agents.length === 0;
        return keys.map(
            (key): SkillRequirement =>
                available.has(key)
                    ? { kind: 'credential', id: key, status: 'met' }
                    : firstAgentUnknown
                      ? {
                            kind: 'credential',
                            id: key,
                            status: 'unknown',
                            reason: 'checkFailed',
                            fixTarget: { surface: 'credentials', ref: key },
                        }
                      : {
                            kind: 'credential',
                            id: key,
                            status: 'missing',
                            reason: 'notSet',
                            fixTarget: { surface: 'credentials', ref: key },
                        },
        );
    }
}
