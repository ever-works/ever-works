/**
 * Minimal STRUCTURAL view of the Playwright surface this plugin drives.
 *
 * Typed locally on purpose: `playwright-core` is an optional dependency
 * loaded through a runtime dynamic import, so a deployment without a
 * browser must still type-check, bundle, and load — it degrades to a
 * `BrowserAutomationNotProvisionedError` instead of crashing at import.
 *
 * Only the members actually used are declared; everything Playwright
 * offers beyond them is intentionally out of reach of this plugin.
 */

export interface PwRequest {
	url(): string;
	resourceType(): string;
	isNavigationRequest(): boolean;
	/** Previous hop of a redirect chain, or null at the start. */
	redirectedFrom(): PwRequest | null;
}

export interface PwResponse {
	url(): string;
	status(): number;
	request(): PwRequest;
}

export interface PwRoute {
	request(): PwRequest;
	abort(errorCode?: string): Promise<void>;
	continue(): Promise<void>;
}

export interface PwLocator {
	all(): Promise<PwLocator[]>;
	count(): Promise<number>;
	first(): PwLocator;
	innerText(options?: { timeout?: number }): Promise<string>;
	textContent(options?: { timeout?: number }): Promise<string | null>;
	innerHTML(options?: { timeout?: number }): Promise<string>;
	getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
	click(options?: { timeout?: number }): Promise<void>;
	fill(value: string, options?: { timeout?: number }): Promise<void>;
	selectOption(values: string, options?: { timeout?: number }): Promise<string[]>;
	press(key: string, options?: { timeout?: number }): Promise<void>;
	hover(options?: { timeout?: number }): Promise<void>;
	waitFor(options?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<void>;
	screenshot(options?: { timeout?: number; type?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
}

export interface PwPage {
	route(pattern: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>;
	goto(
		url: string,
		options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }
	): Promise<PwResponse | null>;
	url(): string;
	title(): Promise<string>;
	content(): Promise<string>;
	locator(selector: string): PwLocator;
	setDefaultTimeout(timeout: number): void;
	setDefaultNavigationTimeout(timeout: number): void;
	screenshot(options?: {
		timeout?: number;
		fullPage?: boolean;
		type?: 'png' | 'jpeg';
		quality?: number;
	}): Promise<Buffer>;
	waitForTimeout(timeout: number): Promise<void>;
	close(): Promise<void>;
}

export interface PwBrowserContext {
	newPage(): Promise<PwPage>;
	close(): Promise<void>;
}

export interface PwBrowser {
	newContext(options?: {
		userAgent?: string;
		viewport?: { width: number; height: number } | null;
		ignoreHTTPSErrors?: boolean;
		javaScriptEnabled?: boolean;
	}): Promise<PwBrowserContext>;
	close(): Promise<void>;
	isConnected?(): boolean;
}

export interface PwBrowserType {
	launch(options?: {
		headless?: boolean;
		executablePath?: string;
		channel?: string;
		timeout?: number;
		args?: string[];
	}): Promise<PwBrowser>;
}

export interface PlaywrightModuleLike {
	chromium: PwBrowserType;
}

/**
 * Loader seam. Production resolves `playwright-core` through a runtime
 * dynamic import with a NON-LITERAL specifier so no bundler traces it;
 * tests inject a fake and never launch a real browser.
 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

export const defaultModuleLoader: ModuleLoader = (specifier) => import(specifier);
