import { registerComputerTab } from '../registry';

/**
 * Services, Docker, Compose and processes (FL-09) — the computer-page tabs
 * this epic fills (README D9, `components/fleet/registry.ts`):
 *
 *  - **Services** (P1): the machine's service manager, failed first, with
 *    start / stop / restart / at boot behind their confirmations;
 *  - **Processes** (P1): the GPUs above the busiest 300 processes, with Stop
 *    and Kill.
 *
 * Both ride `FLEET_MACHINE_FACTS_ENABLED` and need `--manage` on the machine
 * (the registry's tab table says so; the page renders the placeholder for
 * either until both hold). Docker (P2) registers here too when it lands.
 */
registerComputerTab({ id: 'services', load: () => import('../services/ServicesTab') });
registerComputerTab({ id: 'processes', load: () => import('../processes/ProcessesTab') });
