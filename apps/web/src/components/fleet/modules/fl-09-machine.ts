import { registerComputerTab } from '../registry';

/**
 * Services, Docker, Compose and processes (FL-09) — the computer-page tabs
 * this epic fills (README D9, `components/fleet/registry.ts`):
 *
 *  - **Services** (P1): the machine's service manager, failed first, with
 *    start / stop / restart / at boot behind their confirmations;
 *  - **Processes** (P1): the GPUs above the busiest 300 processes, with Stop
 *    and Kill;
 *  - **Docker** (P2): containers and images through the Docker CLI, Run a
 *    container, pull / remove / remove unused as operations.
 *
 * Both ride `FLEET_MACHINE_FACTS_ENABLED` and need `--manage` on the machine
 * (the registry's tab table says so; the page renders the placeholder for
 * either until both hold). The Overview's Runs here block is client-side:
 * `./fl-09-runs-here`.
 */
registerComputerTab({ id: 'services', load: () => import('../services/ServicesTab') });
registerComputerTab({ id: 'processes', load: () => import('../processes/ProcessesTab') });
registerComputerTab({ id: 'docker', load: () => import('../docker/DockerTab') });
