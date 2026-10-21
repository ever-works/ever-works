import { registerComputerTab } from '../registry';

/**
 * Servers and ports (FL-10) — what this epic registers ON THE SERVER (README
 * D9): the computer page's Ports tab (`?tab=ports[&port=3000]`). The tab is a
 * client component that reads the machine live; the registry's own slot
 * carries its flag (`FLEET_MACHINE_FACTS_ENABLED`) and its consent
 * (`--manage`). Imported by `./server.ts`.
 */
registerComputerTab({ id: 'ports', load: () => import('../ports/PortsTab') });
