import { Injectable, Logger } from '@nestjs/common';
import {
    PLATFORM_DEFAULT_TOOL_GRANT,
    sanitizeToolGrantOverride,
    type ResolvedToolGrants,
    type ToolGrantDecision,
    type ToolGrantOverride,
} from '@ever-works/contracts';
import { decideToolGrant, resolveToolGrantChain, type ToolGrantLayer } from './tool-grant';
import type { ToolGrantEnforcer, ToolGrantResolveInput } from './tool-grant.enforcer';
import { MergePolicyScopeRepository } from './merge-policy.repository';
import {
    ToolGrantRepository,
    type ToolGrantScopeRef,
    type UpsertToolGrantInput,
} from './tool-grant.repository';
import type { ToolGrant } from '../entities/tool-grant.entity';

/**
 * Tool-grant matrix (audit item G4) — the I/O half.
 *
 * ONE resolution function (`resolve`) and ONE decision point (`decide`).
 * Every path that could hand a tool to a model routes through the latter,
 * so "may this tool be called here?" is answered by CONFIGURATION in
 * exactly one place.
 *
 * Scope discovery walks UPWARD from whatever the caller knows, exactly
 * like `MergePolicyService`: an `agentId` yields the Agent's `workId` /
 * `organizationId` / `tenantId`, a Work yields its org + tenant, an org
 * yields its tenant. Explicit ids passed by the caller win over discovered
 * ones (a preview can ask "what would this Agent's grants be under that
 * Work?").
 *
 * The chain walk REUSES `MergePolicyScopeRepository` rather than cloning
 * it. Despite its name that repository is simply the read-only projection
 * of the four scope rows down to `{ id, workId, organizationId, tenantId }`
 * — the identical lattice both matrices resolve over. Two copies of a
 * security-relevant parent walk is how the two drift apart.
 *
 * Never throws for policy reasons: a lookup failure degrades to the
 * permissive platform default with a warning. That is the right posture
 * HERE (unlike the merge policy, whose default is restrictive) because a
 * broken read must not silently strip every Agent of every tool — the
 * per-Agent `permissions` gates still apply underneath, and a total
 * outage caused by the access layer failing closed is worse than the
 * matrix briefly not narrowing.
 */
@Injectable()
export class ToolGrantService implements ToolGrantEnforcer {
    private readonly logger = new Logger(ToolGrantService.name);

    constructor(
        private readonly scopes: MergePolicyScopeRepository,
        private readonly grants: ToolGrantRepository,
    ) {}

    /**
     * Resolve the effective matrix for a scope tuple.
     *
     * Returns the matrix, the most specific scope that contributed
     * (`source`), and the full `chain` least → most specific — including
     * each layer's REJECTED patterns, so a UI can explain "your
     * Agent-level grant asked for `deploy_*`, which its Work never
     * granted, so it was ignored".
     */
    async resolve(input: ToolGrantResolveInput): Promise<ResolvedToolGrants> {
        try {
            const refs = await this.discoverScopeRefs(input);
            const rows = await this.grants.findForScopes(input.userId, refs);
            const byScope = new Map<string, ToolGrant>();
            for (const row of rows) byScope.set(`${row.scopeType}:${row.scopeId}`, row);

            const layers: ToolGrantLayer[] = refs.map((ref) => {
                const row = byScope.get(`${ref.scopeType}:${ref.scopeId}`);
                const layer: ToolGrantLayer = { scope: ref.scopeType, id: ref.scopeId };
                if (row) {
                    layer.grant = { allow: row.allow ?? undefined, deny: row.deny ?? undefined };
                }
                return layer;
            });

            return resolveToolGrantChain(layers);
        } catch (error) {
            this.logger.warn(
                `Tool-grant resolution failed (falling back to the platform default): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                matrix: {
                    allow: [...PLATFORM_DEFAULT_TOOL_GRANT.allow],
                    deny: [...PLATFORM_DEFAULT_TOOL_GRANT.deny],
                },
                source: 'default',
                chain: [],
            };
        }
    }

    /**
     * THE decision point. Resolves the matrix for the scope tuple, then
     * evaluates one tool name against it. Refusals carry a stable `code`
     * and a human `reason` naming the offending pattern.
     */
    async decide(input: ToolGrantResolveInput, toolName: string): Promise<ToolGrantDecision> {
        const resolved = await this.resolve(input);
        return decideToolGrant({ matrix: resolved.matrix, chain: resolved.chain }, toolName);
    }

    // ── Writes ────────────────────────────────────────────────────────

    async list(userId: string): Promise<ToolGrant[]> {
        return this.grants.listForUser(userId);
    }

    /**
     * Create-or-update one scope's grant.
     *
     * The override is sanitized on the way IN (drop-if-unrecognized, never
     * coerce) so a junk pattern can never be stored and later re-read as a
     * permissive `*`. Narrowing against the ancestors is NOT applied here
     * on purpose: a stored row records what the operator asked for, and
     * resolution rejects anything the ancestors never granted at READ
     * time. Otherwise loosening a parent grant later would silently fail
     * to reach children whose rows had been trimmed at write time.
     */
    async upsert(input: Omit<UpsertToolGrantInput, 'grant'> & { grant: ToolGrantOverride }) {
        const grant = sanitizeToolGrantOverride(input.grant);
        return this.grants.upsert({ ...input, grant });
    }

    async remove(userId: string, id: string): Promise<boolean> {
        return this.grants.deleteByIdAndUser(id, userId);
    }

    // ── internals ─────────────────────────────────────────────────────

    /**
     * Walk upward from whatever the caller knows and return the scope refs
     * in LEAST → MOST specific order. (`resolveToolGrantChain` re-sorts
     * defensively, but keeping the walk ordered makes the layers readable
     * in a debugger.)
     */
    private async discoverScopeRefs(input: ToolGrantResolveInput): Promise<ToolGrantScopeRef[]> {
        let workId = input.workId ?? null;
        let organizationId = input.organizationId ?? null;
        let tenantId = input.tenantId ?? null;
        let agentId: string | null = null;

        if (input.agentId) {
            const agent = await this.scopes.findAgent(input.agentId);
            if (agent) {
                agentId = agent.id;
                workId = workId ?? agent.workId ?? null;
                organizationId = organizationId ?? agent.organizationId ?? null;
                tenantId = tenantId ?? agent.tenantId ?? null;
            }
        }

        if (workId) {
            const work = await this.scopes.findWork(workId);
            if (work) {
                organizationId = organizationId ?? work.organizationId ?? null;
                tenantId = tenantId ?? work.tenantId ?? null;
            } else {
                // An unknown Work contributes no layer — but it must not
                // silently vanish the org/tenant the caller passed in.
                workId = null;
            }
        }

        if (organizationId) {
            const org = await this.scopes.findOrganization(organizationId);
            if (org) {
                tenantId = tenantId ?? org.tenantId ?? null;
            } else {
                organizationId = null;
            }
        }

        const refs: ToolGrantScopeRef[] = [];
        if (tenantId) refs.push({ scopeType: 'tenant', scopeId: tenantId });
        if (organizationId) refs.push({ scopeType: 'organization', scopeId: organizationId });
        if (workId) refs.push({ scopeType: 'work', scopeId: workId });
        if (agentId) refs.push({ scopeType: 'agent', scopeId: agentId });
        return refs;
    }
}
