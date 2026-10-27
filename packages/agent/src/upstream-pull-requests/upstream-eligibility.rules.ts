import type { UpstreamRateLimitKey, UpstreamRefusalCode } from '@ever-works/contracts';
import type { UpstreamRateLimitRefusal } from './upstream-rate-limits';

/**
 * APW-09 T8 — whether a member may propose a Task upstream (FR-3, FR-4, FR-5, FR-26, FR-41,
 * FR-46), as a pure function over facts the service has already read.
 *
 * Every refusal has its own code (spec §6.5 has the copy). The order is the order a member
 * can act on, and every check that needs no provider comes before every one that does:
 *
 *   1. `disabled`        — the operator kill switch (FR-46) is off.
 *   2. `notFork`         — a private copy or a link: no fork network to propose into (S10, S11).
 *   3. `deniedUpstream`  — the operator deny list (FR-41).
 *   4. `disabled`        — the App spec's `upstreamPullRequests.enabled` is not `true` (FR-1).
 *   5. `sourceNotMerged` — the source Task's pull request did not merge into the fork (FR-3).
 *   6. `activeProposal`  — the Task already has an active record (FR-5); a `409`, not a refusal.
 *   7. `connectionScope` — the member's own connection cannot be used (FR-24).
 *   8. the FR-26 / FR-39 limits.
 *
 * Fail-closed: an unknown relation is `notFork`, an unreadable App spec is "not opted in", an
 * unknown connection is NOT treated as usable. Nothing here relaxes a refusal another door
 * applies (the provider-side reads of FR-4 — archived, collaborators-only, network root — stay
 * the preparation step's, which re-checks before opening).
 */

export interface UpstreamEligibilityFacts {
    readonly killSwitchOn: boolean;
    /** `fork` · `private-copy` · `link`, or `null` when the Work records none. */
    readonly relation: string | null;
    readonly hasUpstream: boolean;
    readonly denied: boolean;
    /** The effective App spec's `upstreamPullRequests.enabled === true`. */
    readonly optedIn: boolean;
    /** Present when a Task was named: `null` = not a Task of this App Work. */
    readonly task?: { readonly prState: string | null } | null;
    readonly activeRecordId?: string | null;
    /** `true` usable, `false` unusable; `undefined` = not checked (the check is skipped). */
    readonly connectionUsable?: boolean;
    readonly limits?: UpstreamRateLimitRefusal | null;
}

export type UpstreamEligibilityDecision =
    | { readonly allowed: true }
    | {
          readonly allowed: false;
          readonly code: UpstreamRefusalCode | 'activeProposal' | 'taskNotOnWork';
          readonly limit?: UpstreamRateLimitKey;
          readonly limitValue?: number;
          readonly nextSlotAt?: string;
          readonly activeId?: string | null;
      };

export function decideUpstreamEligibility(facts: UpstreamEligibilityFacts): UpstreamEligibilityDecision {
    if (!facts.killSwitchOn) return { allowed: false, code: 'disabled' };
    if (facts.relation !== 'fork' || !facts.hasUpstream) return { allowed: false, code: 'notFork' };
    if (facts.denied) return { allowed: false, code: 'deniedUpstream' };
    if (!facts.optedIn) return { allowed: false, code: 'disabled' };
    if (facts.task === null) return { allowed: false, code: 'taskNotOnWork' };
    if (facts.task && facts.task.prState !== 'merged') return { allowed: false, code: 'sourceNotMerged' };
    if (facts.activeRecordId) {
        return { allowed: false, code: 'activeProposal', activeId: facts.activeRecordId };
    }
    if (facts.connectionUsable === false) return { allowed: false, code: 'connectionScope' };
    if (facts.limits) {
        return {
            allowed: false,
            code: facts.limits.code,
            limit: facts.limits.limit,
            limitValue: facts.limits.limitValue,
            ...(facts.limits.nextSlotAt ? { nextSlotAt: facts.limits.nextSlotAt } : {}),
        };
    }
    return { allowed: true };
}
