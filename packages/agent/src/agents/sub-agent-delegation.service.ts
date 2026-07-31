import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    refuseSubAgentDelegation,
    validateSubAgentDelegationRequest,
    SUB_AGENT_DELEGATION_STATUSES,
    SUB_AGENT_MAX_SUMMARY_CHARS,
    type SubAgentDelegationLimits,
    type SubAgentDelegationRequest,
    type SubAgentDelegationResult,
} from '@ever-works/contracts';
import {
    SUB_AGENT_DELEGATION_RUNNER,
    SUB_AGENT_DELEGATION_DEPTH_RESOLVER,
    type SubAgentDelegationRunner,
    type SubAgentDelegationDepthResolver,
} from './sub-agent-delegation.port';

/**
 * Sub-agent delegation (judgment layer G9) — the one place a parent
 * agent's "do this smaller thing for me" becomes a bounded child run
 * with a typed answer.
 *
 * The service is deliberately thin, because the interesting parts are
 * the CONTRACT rules and they live in `@ever-works/contracts` as pure
 * functions:
 *
 *   1. validate + narrow  — depth cap, sibling fan-out cap, scope
 *                           intersection against the parent, budget
 *                           ceiling. Failing any of these is a REFUSAL
 *                           (typed code, nothing ran), not an error.
 *   2. dispatch           — hand the EFFECTIVE request (narrowed scope)
 *                           to the bound runner.
 *   3. normalize          — whatever the runner returns is coerced back
 *                           into the closed result shape, so a parent
 *                           can always branch on
 *                           `completed | failed | refused | escalated`.
 *
 * Never throws for a delegation's own reasons: a thrown runner becomes
 * `status: 'failed'` with the message as the summary, because a parent
 * that loses the delegation record loses the only trace of what it
 * asked for.
 */
@Injectable()
export class SubAgentDelegationService {
    private readonly logger = new Logger(SubAgentDelegationService.name);

    constructor(
        // Bound by the api-side @Global() module; absent in unit tests and
        // installs without a job runtime. @Optional() + appended LAST per
        // the positional-spec arity rule.
        @Optional()
        @Inject(SUB_AGENT_DELEGATION_RUNNER)
        private readonly runner?: SubAgentDelegationRunner,
        // Judgment layer G9 — server-derived depth. Also @Optional() and
        // appended LAST per the positional-spec arity rule, so the ten
        // positional constructions in the spec keep working unchanged.
        @Optional()
        @Inject(SUB_AGENT_DELEGATION_DEPTH_RESOLVER)
        private readonly depthResolver?: SubAgentDelegationDepthResolver,
    ) {}

    /**
     * Validate a request WITHOUT running it. Exposed so a caller (or a
     * chat tool) can preflight a delegation and show the refusal reason
     * before spending anything.
     */
    preflight(request: SubAgentDelegationRequest, limits: SubAgentDelegationLimits = {}) {
        return validateSubAgentDelegationRequest(request, limits);
    }

    async delegate(
        request: SubAgentDelegationRequest,
        limits: SubAgentDelegationLimits = {},
    ): Promise<SubAgentDelegationResult> {
        const delegationId = request?.delegationId ?? 'unknown';
        // Resolve the TRUE depth before validating. `request.depth` is
        // caller-declared, and a caller that declares 0 on every hop would
        // otherwise recurse forever — the ceiling below is only meaningful
        // against a number the platform wrote itself.
        const effectiveRequest = await this.withResolvedDepth(request);
        const validation = validateSubAgentDelegationRequest(effectiveRequest, limits);
        // `=== false` rather than `!validation.ok`: this package compiles
        // with `strictNullChecks: false`, under which negated-discriminant
        // narrowing silently picks the WRONG union member. An explicit
        // literal comparison narrows correctly in both modes.
        if (validation.ok === false) {
            this.logger.log(
                `Delegation ${delegationId} refused (${validation.refusalCode}): ${validation.message}`,
            );
            return refuseSubAgentDelegation(
                delegationId,
                validation.refusalCode,
                validation.message,
            );
        }

        if (!this.runner) {
            const message = 'no sub-agent delegation runner is bound in this process';
            this.logger.warn(`Delegation ${delegationId} refused: ${message}`);
            return refuseSubAgentDelegation(delegationId, 'no-runner', message);
        }

        const effective = validation.request;
        try {
            const result = await this.runner.run(effective);
            return this.normalize(delegationId, result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Delegation ${delegationId} runner threw: ${message}`);
            return {
                delegationId,
                status: 'failed',
                summary: message.slice(0, SUB_AGENT_MAX_SUMMARY_CHARS),
                output: null,
            };
        }
    }

    /**
     * Replace the caller-declared depth with the server-derived one when
     * it is HIGHER (judgment layer G9).
     *
     * Raise-only, deliberately:
     *
     *  - Raising is the safety direction. A caller under-declaring its
     *    depth is the whole attack — "I am at depth 0" repeated forever —
     *    and the persisted Task chain is the only account of the truth.
     *  - Lowering would be the opposite: a stale or wrong resolver reading
     *    could hand a deep chain a shallow number and REMOVE a bound that
     *    the caller had honestly declared. So a resolver that returns
     *    something smaller is ignored.
     *  - An unresolvable depth (`null`) leaves the request exactly as it
     *    arrived, so this is strictly additive to today's behaviour.
     *
     * Never throws. A resolver outage must not convert a delegation into
     * an error; the declared value simply stands.
     */
    private async withResolvedDepth(
        request: SubAgentDelegationRequest,
    ): Promise<SubAgentDelegationRequest> {
        if (!this.depthResolver || !request || typeof request !== 'object') {
            return request;
        }
        let resolved: number | null = null;
        try {
            resolved = await this.depthResolver.resolveDepth(request);
        } catch (err) {
            this.logger.debug(
                `Delegation ${request.delegationId}: depth resolver failed ` +
                    `(${err instanceof Error ? err.message : String(err)}); ` +
                    'using the declared depth.',
            );
            return request;
        }
        if (!Number.isInteger(resolved) || (resolved as number) < 0) {
            return request;
        }
        const declared = Number.isInteger(request.depth) ? request.depth : 0;
        if ((resolved as number) <= declared) {
            return request;
        }
        this.logger.debug(
            `Delegation ${request.delegationId}: raising declared depth ${declared} ` +
                `to the resolved depth ${resolved}.`,
        );
        return { ...request, depth: resolved as number };
    }

    /**
     * Coerce a runner's answer into the closed result shape. A runner
     * that returns garbage (missing status, wrong delegationId) is a bug
     * in the runner, not a reason to hand the parent an untyped blob.
     */
    private normalize(
        delegationId: string,
        result: SubAgentDelegationResult,
    ): SubAgentDelegationResult {
        if (!result || typeof result !== 'object') {
            return {
                delegationId,
                status: 'failed',
                summary: 'the delegation runner returned nothing',
                output: null,
            };
        }
        const status = SUB_AGENT_DELEGATION_STATUSES.includes(result.status)
            ? result.status
            : 'failed';
        const summary =
            typeof result.summary === 'string' && result.summary.trim().length > 0
                ? result.summary.slice(0, SUB_AGENT_MAX_SUMMARY_CHARS)
                : `delegation ${status}`;
        return {
            ...result,
            // The id is the correlation key — the runner never gets to change it.
            delegationId,
            status,
            summary,
            output: result.output ?? null,
        };
    }
}
