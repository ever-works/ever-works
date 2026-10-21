import { registerComputerTab } from '../registry';

/**
 * Logs on computers (FL-08) — what this epic registers ON THE SERVER (README
 * D9): the computer page's Logs tab. The registry slot already carries the
 * flag (`FLEET_MACHINE_FACTS_ENABLED`), the consent (`--manage`) and the family
 * (`logs`), so a switched-off deployment, a computer without `--manage` and a
 * desktop node get FL-01's honest placeholder instead. The tab is a client
 * component (it lists the sources and opens the viewer socket from the
 * browser). Imported by `./server.ts`.
 */
registerComputerTab({ id: 'logs', load: () => import('../logs/LogsTab') });
