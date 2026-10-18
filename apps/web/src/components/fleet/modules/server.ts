import 'server-only';
import './index';
import './fl-01-hub';

/**
 * Fleet hub (FL-01, README D9) — where Fleet modules register what renders ON
 * THE SERVER: hub tabs (`registerHubTab`), computer-page tabs
 * (`registerComputerTab`) and the session page (`registerSessionPage`). A tab
 * component may be a server component (it may read the API before paint) or a
 * client component. Each epic adds ONE file beside this one and ONE import
 * line above. Imported by the hub pages and the computer page only.
 *
 * Registered today: FL-01's own computer tabs (`./fl-01-hub`).
 */
export {};
