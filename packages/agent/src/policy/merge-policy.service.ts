import { Injectable, Logger } from '@nestjs/common';
import type { MergeDecision, ResolvedMergePolicy } from '@ever-works/contracts';
import { PLATFORM_DEFAULT_MERGE_POLICY } from '@ever-works/contracts';
import { evaluateAgentMerge, resolveMergePolicyChain, type MergePolicyLayer } from './merge-policy';
import type { MergePolicyDecisionInput, MergePolicyEnforcer } from './merge-policy.enforcer';
import { MergePolicyScopeRepository } from './merge-policy.repository';

/** Where a resolution starts. Any subset; more specific ids win. */
export interface MergePolicyResolveInput {
    agentId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
}

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the I/O half.
 *
 * ONE resolution function (`resolve`) and ONE decision point
 * (`canAgentMerge`). Every path that could land a pull request on an
 * agent's behalf routes through the latter, so "may an agent merge?" is
 * answered in exactly one place and is answered by CONFIGURATION, never
 * by a hardcoded invariant.
 *
 * Scope discovery walks upward from whatever the caller knows: an
 * `agentId` yields the Agent's `workId` / `organizationId` / `tenantId`,
 * a Work yields its org + tenant, an org yields its tenant. Explicit ids
 * passed by the caller win over discovered ones (a preview can ask "what
 * would this Agent's policy be under that Work?").
 *
 * Modelled on `RunDispatchGateService`: a small resolution service in
 * front of a policy decision, with an operator kill-switch
 * (`AGENT_MERGE_POLICY_ENFORCEMENT`) consulted at the enforcement site
 * rather than here — this service always tells the truth about the
 * policy.
 */
@Injectable()
export class MergePolicyService implements MergePolicyEnforcer {
    private readonly logger = new Logger(MergePolicyService.name);

    constructor(private readonly scopes: MergePolicyScopeRepository) {}

    /**
     * Resolve the effective policy for a scope tuple.
     *
     * Returns the complete policy, the most specific scope that
     * contributed a field (`source`), and the full `chain` least → most
     * specific so a preview can explain *why* — the difference between a
     * policy surface people trust and one they work around.
     *
     * Never throws: a lookup failure degrades to the platform default with
     * a warning, because a broken policy read must not become a merge that
     * bypasses policy (the default is the safe posture).
     */
    async resolve(input: MergePolicyResolveInput): Promise<ResolvedMergePolicy> {
        try {
            const layers: MergePolicyLayer[] = [];
            let workId = input.workId ?? null;
            let organizationId = input.organizationId ?? null;
            let tenantId = input.tenantId ?? null;

            if (input.agentId) {
                const agent = await this.scopes.findAgent(input.agentId);
                if (agent) {
                    layers.push({ scope: 'agent', id: agent.id, policy: agent.mergePolicy });
                    workId = workId ?? agent.workId ?? null;
                    organizationId = organizationId ?? agent.organizationId ?? null;
                    tenantId = tenantId ?? agent.tenantId ?? null;
                }
            }

            if (workId) {
                const work = await this.scopes.findWork(workId);
                if (work) {
                    layers.push({ scope: 'work', id: work.id, policy: work.mergePolicy });
                    organizationId = organizationId ?? work.organizationId ?? null;
                    tenantId = tenantId ?? work.tenantId ?? null;
                }
            }

            if (organizationId) {
                const org = await this.scopes.findOrganization(organizationId);
                if (org) {
                    layers.push({
                        scope: 'organization',
                        id: org.id,
                        policy: org.mergePolicy,
                    });
                    tenantId = tenantId ?? org.tenantId ?? null;
                }
            }

            if (tenantId) {
                const tenant = await this.scopes.findTenant(tenantId);
                if (tenant) {
                    layers.push({ scope: 'tenant', id: tenant.id, policy: tenant.mergePolicy });
                }
            }

            return resolveMergePolicyChain(layers);
        } catch (error) {
            this.logger.warn(
                `Merge-policy resolution failed (falling back to the platform default): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                policy: {
                    ...PLATFORM_DEFAULT_MERGE_POLICY,
                    allowedMergeMethods: [...PLATFORM_DEFAULT_MERGE_POLICY.allowedMergeMethods],
                    protectedBranches: [...PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches],
                },
                source: 'default',
                chain: [],
            };
        }
    }

    /**
     * THE decision point for agent-driven merges. Resolves the policy for
     * the scope tuple, then evaluates the request against it.
     *
     * Refusals carry a stable `code` and a human `reason` naming the
     * offending value, so a caller can both branch on the code and show
     * the user something actionable.
     */
    async canAgentMerge(input: MergePolicyDecisionInput): Promise<MergeDecision> {
        const resolved = await this.resolve(input);
        return evaluateAgentMerge({
            policy: resolved.policy,
            source: resolved.source,
            gateStatus: input.gateStatus ?? null,
            humanApproved: input.humanApproved ?? false,
            targetBranch: input.targetBranch ?? null,
            mergeMethod: input.mergeMethod ?? null,
        });
    }
}
