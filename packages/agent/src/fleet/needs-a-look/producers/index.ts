// Computer health (FL-03) — the five "needs a look" producers. They register
// into FL-01's registry (`NeedsALookService`) through the
// `NEEDS_A_LOOK_PRODUCERS` token that `FleetModule` binds to this list.
export * from './consent-missing.producer';
export * from './disk-low.producer';
export * from './helper-untrusted.producer';
export * from './node-quarantined.producer';
export * from './node-throttled.producer';
export * from './node-upgrade-required.producer';

import { ConsentMissingProducer } from './consent-missing.producer';
import { DiskLowProducer } from './disk-low.producer';
import { HelperUntrustedProducer } from './helper-untrusted.producer';
import { NodeQuarantinedProducer } from './node-quarantined.producer';
import { NodeThrottledProducer } from './node-throttled.producer';
import { NodeUpgradeRequiredProducer } from './node-upgrade-required.producer';

/** FL-03's producers, in the order the module registers them. */
export const FL03_NEEDS_A_LOOK_PRODUCERS = [
    DiskLowProducer,
    NodeThrottledProducer,
    NodeQuarantinedProducer,
    ConsentMissingProducer,
    HelperUntrustedProducer,
] as const;

/** FL-02's producer (node link & runtime foundations): the version floor. */
export const FL02_NEEDS_A_LOOK_PRODUCERS = [NodeUpgradeRequiredProducer] as const;
