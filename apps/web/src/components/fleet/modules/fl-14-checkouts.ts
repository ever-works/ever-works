import { registerComputerTab, registerHubTab } from '../registry';

/**
 * Checkouts on computers (FL-14) — what this epic adds to the Fleet module
 * registry (README D9, `components/fleet/registry.ts`): the hub's Checkouts
 * tab (`/fleet/checkouts`, FL-01's route) and every computer page's Checkouts
 * tab (`?tab=checkouts`). Both ride `FLEET_CHECKOUTS_ENABLED` (the registry's
 * slot names the flag and the `--manage` consent) and are server components,
 * so this file is imported by `./server.ts`.
 */
registerHubTab({ id: 'checkouts', load: () => import('../checkouts/CheckoutsHubTab') });
registerComputerTab({
    id: 'checkouts',
    load: () => import('../checkouts/ComputerCheckoutsTab'),
});
