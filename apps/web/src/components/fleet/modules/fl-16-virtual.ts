import { ROUTES } from '@/lib/constants';
import { registerAddComputerItem, registerComputerAction } from '../registry';

/**
 * Virtual computers (FL-16) — what this epic adds to the Fleet module registry
 * IN THE BROWSER (README D9, CONTRACTS §11.1 revision 6), behind
 * `FLEET_VIRTUAL_ENABLED`:
 *
 *  - "New virtual computer…" in the hub's **Add computer ▾** menu, opening the
 *    dialog on the Computers tab (`?add=virtual`, "Choose for me");
 *  - "New virtual computer…" in a host's page header (family `machines`),
 *    with that computer preselected;
 *  - a virtual computer's own header actions — Start / Stop, Retry enrolment,
 *    Destroy… (family `machines`).
 *
 * The nested rows (FL-01's cards) and the **Runs here** rows (inside FL-09's
 * block) are rendered by those owners' components. Client-safe (imported by
 * client components through `./index`).
 */
export const NEW_VIRTUAL_ITEM_ID = 'fl-16.virtual';
export const NEW_VIRTUAL_ON_HOST_ACTION_ID = 'fl-16.new-virtual-on-host';
export const VIRTUAL_CHILD_ACTIONS_ID = 'fl-16.virtual-child';

registerAddComputerItem({
    id: NEW_VIRTUAL_ITEM_ID,
    order: 30,
    epic: 'FL-16',
    flag: 'FLEET_VIRTUAL_ENABLED',
    labelKey: 'fleet.virtual.menu.addItem',
    href: `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=virtual`,
    icon: 'virtual',
});

registerComputerAction({
    id: NEW_VIRTUAL_ON_HOST_ACTION_ID,
    placement: 'header',
    order: 60,
    epic: 'FL-16',
    flag: 'FLEET_VIRTUAL_ENABLED',
    family: 'machines',
    load: () => import('../virtual/NewVirtualComputerButton'),
});

registerComputerAction({
    id: VIRTUAL_CHILD_ACTIONS_ID,
    placement: 'header',
    order: 61,
    epic: 'FL-16',
    flag: 'FLEET_VIRTUAL_ENABLED',
    family: 'machines',
    load: () => import('../virtual/VirtualChildActions'),
});
