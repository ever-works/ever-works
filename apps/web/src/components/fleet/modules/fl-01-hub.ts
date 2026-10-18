import { registerComputerTab } from '../registry';

/**
 * Fleet hub (FL-01) — the computer-page tabs FL-01 itself fills: Overview
 * (what needs a look on this computer, the Overview blocks other epics
 * register, its facts) and Settings (who can do what on it). Every other tab
 * is filled by its own epic's module file beside this one.
 */
registerComputerTab({ id: 'overview', load: () => import('../computer/tabs/OverviewTab') });
registerComputerTab({ id: 'settings', load: () => import('../computer/tabs/SettingsTab') });
