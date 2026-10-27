import { ROUTES } from '@/lib/constants';
import {
    registerAddComputerItem,
    registerComputerAction,
    registerOverviewBlock,
} from '../registry';

/**
 * Cloud computers (FL-17) — what this epic adds to the Fleet module registry
 * IN THE BROWSER (README D9, CONTRACTS §11.1 revision 6), behind
 * `FLEET_CLOUD_ENABLED`:
 *
 *  - "New cloud computer…" in the hub's **Add computer ▾** menu, opening the
 *    dialog on the Computers tab (`?add=cloud`);
 *  - a cloud computer's header actions — Power off / Power on, Destroy…
 *    (family `machines`); "Remove from Fleet" stays FL-01's and is shown
 *    disabled with the reason while the machine may bill (R-36);
 *  - the **Cloud** block on a cloud computer's Overview;
 *  - P2: the **Cloud computers** usage block on the hub Overview (spec S8,
 *    FR-23) — hourly now, this month (destroyed machines included), the
 *    projected month and a row per machine, estimates from list prices.
 *
 * The card line in the hub is rendered by FL-01's `ComputerCards`. Client-safe
 * (imported by client components through `./index`).
 */
export const NEW_CLOUD_ITEM_ID = 'fl-17.cloud';
export const CLOUD_ACTIONS_ID = 'fl-17.cloud-actions';
export const CLOUD_BLOCK_ID = 'fl-17.cloud-block';
export const CLOUD_USAGE_BLOCK_ID = 'fl-17.cloud-usage';

registerAddComputerItem({
    id: NEW_CLOUD_ITEM_ID,
    order: 40,
    epic: 'FL-17',
    flag: 'FLEET_CLOUD_ENABLED',
    labelKey: 'fleet.cloud.menu.addItem',
    href: `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=cloud`,
    icon: 'cloud',
});

registerComputerAction({
    id: CLOUD_ACTIONS_ID,
    placement: 'header',
    order: 62,
    epic: 'FL-17',
    flag: 'FLEET_CLOUD_ENABLED',
    family: 'machines',
    load: () => import('../cloud/CloudComputerActions'),
});

registerOverviewBlock({
    id: CLOUD_BLOCK_ID,
    surface: 'computer',
    // Before FL-01's own "needs a look" block (100): a cloud computer's cost is
    // the first thing its page answers (spec S2).
    order: 15,
    epic: 'FL-17',
    flag: 'FLEET_CLOUD_ENABLED',
    load: () => import('../cloud/CloudBlock'),
});

registerOverviewBlock({
    id: CLOUD_USAGE_BLOCK_ID,
    surface: 'hub',
    // After FL-01's own "needs a look" block (100): what the cloud computers cost.
    order: 130,
    epic: 'FL-17',
    flag: 'FLEET_CLOUD_ENABLED',
    load: () => import('../cloud/CloudUsageBlock'),
});
