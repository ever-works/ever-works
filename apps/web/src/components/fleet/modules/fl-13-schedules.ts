import { registerComputerTab } from '../registry';

/**
 * Schedules on computers (FL-13) — what this epic adds to the Fleet module
 * registry (README D9): every computer page's Schedules tab
 * (`?tab=schedules`). Its slot rides `FLEET_COMMANDS_ENABLED` and the
 * `--manage` consent (`registry.ts`), so with the flag off the tab is hidden.
 * A server component (it reads the visible computers before paint), so this
 * file is imported by `./server.ts`.
 */
registerComputerTab({ id: 'schedules', load: () => import('../schedules/ComputerSchedulesTab') });
