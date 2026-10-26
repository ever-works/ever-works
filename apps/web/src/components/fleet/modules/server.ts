import 'server-only';
import './index';
import './fl-01-hub';
import './fl-09-machine';
import './fl-04-sessions.server';
import './fl-05-sessions.server';
import './fl-14-checkouts';
import './fl-10-ports.server';
import './fl-12-commands.server';
import './fl-13-schedules';
import './fl-08-logs.server';
import './fl-11-files.server';
import './fl-20-usage.server';

/**
 * Fleet hub (FL-01, README D9) — where Fleet modules register what renders ON
 * THE SERVER: hub tabs (`registerHubTab`), computer-page tabs
 * (`registerComputerTab`) and the session page (`registerSessionPage`). A tab
 * component may be a server component (it may read the API before paint) or a
 * client component. Each epic adds ONE file beside this one and ONE import
 * line above. Imported by the hub pages and the computer page only.
 *
 * Registered today: FL-01's own computer tabs (`./fl-01-hub`); FL-04's
 * Sessions tab and session page (`./fl-04-sessions.server`); FL-05's hub Sessions tab
 * (`./fl-05-sessions.server`); FL-14's hub and
 * computer Checkouts tabs (`./fl-14-checkouts`); FL-09's Services and
 * Processes tabs (`./fl-09-machine`); FL-10's Ports tab (`./fl-10-ports.server`); FL-12's
 * hub Commands tab (`./fl-12-commands.server`); FL-13's Schedules tab (`./fl-13-schedules`); FL-08's Logs tab
 * (`./fl-08-logs.server`); FL-11's Files tab (`./fl-11-files.server`); FL-20's hub Usage tab
 * (`./fl-20-usage.server`).
 */
export {};
