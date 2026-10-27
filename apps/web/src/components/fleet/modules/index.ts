/**
 * Fleet hub (FL-01, README D9) — where Fleet modules register what renders
 * IN THE BROWSER: Overview blocks (`registerOverviewBlock`), computer actions
 * (`registerComputerAction`) and "Add computer ▾" entries
 * (`registerAddComputerItem`). Each epic adds ONE file beside this one
 * (`./fl-NN-<topic>.ts`) and ONE import line below; every component it
 * registers must be client-safe (no `server-only` import), because this file
 * is imported by client components.
 *
 * Tabs and the session page are rendered on the server: register those in a
 * file imported by `./server.ts` instead.
 *
 * Registered today: FL-03's health metrics block and its "Clear limit now"
 * command (`./fl-03-health`); FL-02's consents card (`./fl-02-link`); FL-04's
 * "New session ▾" header action (`./fl-04-sessions`); FL-10's Servers block
 * (`./fl-10-ports`); FL-12's "Run a command…" menu item and "Last command"
 * Overview block (`./fl-12-commands`); FL-16's "New virtual computer…" entries
 * and a virtual computer's header actions (`./fl-16-virtual`); FL-17's "New cloud
 * computer…" entry, a cloud computer's header actions and its Cloud block
 * (`./fl-17-cloud`); FL-20's usage line on a computer's Overview (`./fl-20-usage`).
 */
import './fl-03-health';
import './fl-02-link';
import './fl-04-sessions';
import './fl-09-runs-here';
import './fl-10-ports';
import './fl-12-commands';
import './fl-16-virtual';
import './fl-17-cloud';
import './fl-20-usage';
