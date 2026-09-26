import type { LauncherStrings } from './types.js';

/**
 * The element's default English strings — spec §6.1, §6.2 and §6.5's final copy,
 * verbatim, plus plan §8's key names.
 *
 * Every one is overridable through the `strings` property; a host that
 * translates the launcher passes the whole table and these are never rendered
 * (FR-42, and README §7 rule 11 for the Ever Works host).
 */
export const DEFAULT_LAUNCHER_STRINGS: LauncherStrings = {
	controlLabel: 'App Launcher',
	controlTooltip: 'Ever apps and your apps',
	panelTitle: 'App Launcher',
	sectionPinned: 'Pinned',
	sectionPlatforms: 'Ever apps',
	sectionWorks: 'Your apps',
	chipCurrent: "You're here",
	chipBeta: 'Beta',
	chipDeploying: 'Deploying',
	chipLastDeployFailed: 'Last deploy failed',
	viewAll: 'View all {count}',
	footerHelper: 'Opens in a new tab. You may need to sign in.',
	manageLink: 'Manage apps',
	emptyWorks: 'Apps you deploy show up here.',
	emptyWorksCreateApp: 'Create an App Work',
	emptyWorksGoToWorks: 'Go to Works',
	catalogError: "Ever apps couldn't be loaded.",
	worksError: "Your apps couldn't be loaded.",
	retry: 'Try again',
	signInPrompt: 'Sign in with Ever ID to see your apps here.',
	signIn: 'Sign in',
	manageInEverWorks: 'Manage apps in Ever Works'
};
