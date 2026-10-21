import type { FleetCheckoutPullRequestFacts } from '@ever-works/contracts';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';

/**
 * Session git & actions (FL-06, plan §4) — the pull-request facts the
 * relevance rules read (open review comments, mergeability, the default
 * branch). They are resolved through the GitHub App by the API's enrichment
 * service and kept there for a minute, never stored; this package reads them
 * through this port. Unbound (a worker, a test), the rules see "unknown" —
 * fix-comments and resolve-conflicts stay hidden, which is the safe reading.
 */
export interface FleetSessionPrFactsPort {
    /** Cached for a minute; asks the provider once on a miss. Never throws. */
    cachedFacts(row: FleetCheckout): Promise<FleetCheckoutPullRequestFacts>;
    /** Forget a checkout's facts (after its pull request was opened or updated). */
    invalidate(checkoutId: string): void;
}

export const FLEET_SESSION_PR_FACTS = 'FLEET_SESSION_PR_FACTS' as const;
