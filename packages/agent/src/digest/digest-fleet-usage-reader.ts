import type { FleetUsageDigestLine } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20 P3, spec §0 "daily digest line") — what
 * the person's own computers' model work would have cost at list price over a
 * digest window: "Your machines ran $4.20 of model work yesterday (list price)".
 *
 * A port so the digest composer does not import the fleet usage module: the
 * API binds it to `FleetUsageViewService` in the global `FleetUsageApiModule`.
 * Unbound — or `FLEET_USAGE_SCAN_ENABLED` off, or nothing scanned in the
 * window — the digest simply has no fleet section.
 */
export const DIGEST_FLEET_USAGE_READER = 'DIGEST_FLEET_USAGE_READER' as const;

export interface DigestFleetUsageReader {
    /** The user's computers' model work in `[since, until)`, or null when there is none. */
    fleetUsageForDigest(
        userId: string,
        since: Date,
        until: Date,
    ): Promise<FleetUsageDigestLine | null>;
}
