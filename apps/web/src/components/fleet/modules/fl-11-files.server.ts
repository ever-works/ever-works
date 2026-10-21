import { registerComputerTab } from '../registry';

/**
 * Files on computers (FL-11) — what this epic registers ON THE SERVER (README
 * D9): the computer page's Files tab. The registry slot already carries the
 * flag (`FLEET_MACHINE_FACTS_ENABLED`), the consent (`--manage`) and the
 * family (`files`), so a switched-off deployment, a computer without
 * `--manage` and a desktop node get FL-01's honest placeholder instead. The
 * tab is a client component (it lists folders and streams transfers from the
 * browser). Imported by `./server.ts`.
 */
registerComputerTab({ id: 'files', load: () => import('../files/FilesTab') });
