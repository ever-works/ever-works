import { BrowserAutomationPlugin } from './browser-automation.plugin.js';

export { BrowserAutomationPlugin };
export * from './navigation-policy.js';
export type {
	ModuleLoader,
	PlaywrightModuleLike,
	PwBrowser,
	PwBrowserContext,
	PwLocator,
	PwPage,
	PwRequest,
	PwResponse,
	PwRoute
} from './playwright.types.js';

// The loader rejects a plugin without a default export at onLoad
// ("Exported value is not a valid plugin") — this line is load-bearing.
export default BrowserAutomationPlugin;
