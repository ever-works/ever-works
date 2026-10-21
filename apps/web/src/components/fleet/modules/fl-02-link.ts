import { registerOverviewBlock } from '../registry';

/**
 * Fleet node link (FL-02) — what this epic adds to the Fleet module registry
 * (README D9, `components/fleet/registry.ts`):
 *
 *  - the consents card ("What build-01 lets Ever Works do", spec §5.2) on
 *    every computer page's Overview tab, right after FL-03's health metrics.
 *    No `flag`: consents arrive in every heartbeat whether or not this
 *    deployment accepts node links (`FLEET_NODE_LINK_ENABLED`), and the card
 *    reads only the heartbeat.
 *
 * The link line itself sits in the computer header (`computer/ComputerHeader.tsx`
 * renders `link/LinkLine.tsx` from `node.link`). Client-safe (imported by
 * client components through `./index`).
 */
export const CONSENTS_BLOCK_ID = 'fl-02.consents';

registerOverviewBlock({
    id: CONSENTS_BLOCK_ID,
    surface: 'computer',
    order: 20,
    epic: 'FL-02',
    load: () => import('../link/ConsentsCard'),
});
