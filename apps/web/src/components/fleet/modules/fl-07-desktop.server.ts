import { registerComputerTab } from '../registry';

/**
 * Desktop view & control (FL-07) — what this epic registers ON THE SERVER
 * (README D9): the computer page's Desktop tab (`?tab=desktop`). The registry
 * slot already carries the flag (`FLEET_DESKTOP_ENABLED`), the consent
 * (`--attend`) and the family (`desktop`), so a switched-off deployment, a
 * computer without `--attend` and a desktop node get FL-01's honest
 * placeholder instead. The tab is a client component (it holds the live
 * socket). Imported by `./server.ts`.
 */
registerComputerTab({ id: 'desktop', load: () => import('../desktop/DesktopTab') });
