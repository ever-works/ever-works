import { randomUUID } from 'node:crypto';
import type {
	BrowserActResult,
	BrowserActStep,
	BrowserBlockedRequest,
	BrowserExtractQuery,
	BrowserExtractResult,
	BrowserNavigateResult,
	BrowserNavigationPolicy,
	BrowserScreenshotRequest,
	BrowserScreenshotResult,
	BrowserSessionHandle,
	BrowserSessionSpec,
	IBrowserAutomationPlugin,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings,
	ValidationError,
	ValidationResult
} from '@ever-works/plugin';
import { BrowserAutomationNotProvisionedError, BrowserNavigationBlockedError } from '@ever-works/plugin';
import {
	MAX_ACT_STEPS,
	MAX_EXTRACT_NODES,
	assertUrlAllowed,
	classifyUrl,
	clampTimeout,
	collectInvalidHostPatterns,
	parseHostPattern,
	redactUrl,
	resolveNavigationPolicy,
	type UrlGuardDeps
} from './navigation-policy.js';
import {
	defaultModuleLoader,
	type ModuleLoader,
	type PlaywrightModuleLike,
	type PwBrowser,
	type PwBrowserContext,
	type PwPage,
	type PwRequest,
	type PwResponse
} from './playwright.types.js';

const PLAYWRIGHT_MODULE = 'playwright-core';

/** Live per-session state. Never handed to callers — the handle is opaque. */
interface Session {
	readonly id: string;
	readonly policy: BrowserNavigationPolicy;
	readonly context: PwBrowserContext;
	readonly page: PwPage;
	/** Requests the route guard refused, drained by each verb's result. */
	blocked: BrowserBlockedRequest[];
}

/**
 * `browser-automation` — first-party headless-browser provider (audit
 * item G22), driving Chromium through Playwright.
 *
 * Four verbs — `navigate`, `extract`, `screenshot`, `act` — behind one
 * security posture that is not optional:
 *
 *  - **Headless by default.** `settings.headless` must be explicitly
 *    `false` to get a headed browser.
 *  - **Default-deny allowlist.** No configured hosts means every
 *    navigation is refused. There is no "allow anything" fallback path.
 *  - **Redirects are re-checked, every hop.** A Playwright route guard
 *    aborts any document request whose URL falls outside the allowlist,
 *    and the post-navigation audit walks `redirectedFrom()` back to the
 *    origin so a hop that somehow slipped through still fails the call
 *    instead of silently returning attacker-controlled content.
 *  - **SSRF guard underneath the allowlist.** Private / loopback /
 *    link-local / cloud-metadata targets are refused on both the lexical
 *    URL and the DNS resolution (rebinding defence), and an unresolvable
 *    host fails CLOSED.
 *  - **Configurable timeout** on navigation and on every action.
 *
 * Playwright itself is an OPTIONAL dependency loaded through a runtime
 * dynamic import: a runtime without a browser degrades to a loud
 * {@link BrowserAutomationNotProvisionedError}, never a module-load crash.
 */
export class BrowserAutomationPlugin implements IPlugin, IBrowserAutomationPlugin {
	readonly id = 'browser-automation';
	readonly name = 'Browser Automation';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities: readonly string[] = ['browser-automation'];
	readonly providerName = 'Playwright (Chromium)';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			allowedHosts: {
				type: 'array',
				title: 'Navigation allowlist',
				description:
					'Hosts the browser may navigate to. Supports "example.com", "*.example.com" (subdomains only), an optional ":port" suffix, and "*" for any PUBLIC host. EMPTY MEANS EVERY NAVIGATION IS REFUSED — this is the default and it is deliberate.',
				items: { type: 'string' },
				default: []
			},
			timeoutMs: {
				type: 'number',
				title: 'Timeout (ms)',
				description: 'Wall-clock budget for navigation and for each action. Clamped to 1000-120000 ms.',
				default: 30000,
				minimum: 1000,
				maximum: 120000
			},
			headless: {
				type: 'boolean',
				title: 'Headless',
				description:
					'Run the browser without a visible window. Leave enabled unless you are debugging locally.',
				default: true
			},
			subresourcePolicy: {
				type: 'string',
				title: 'Sub-resource policy',
				description:
					'"public-only" lets a page load assets from any public host (private/internal targets stay blocked). "allowlist" additionally restricts every asset to the navigation allowlist.',
				enum: ['public-only', 'allowlist'],
				default: 'public-only'
			},
			allowPrivateNetwork: {
				type: 'boolean',
				title: 'Allow private network (advanced)',
				description:
					'Permit navigation to private/internal addresses. Requires an explicit host allowlist — the "*" entry is ignored while this is on, so this can never open the whole internal network.',
				default: false
			},
			executablePath: {
				type: 'string',
				title: 'Chromium executable path',
				description: 'Absolute path to a Chromium binary. Leave empty to use the Playwright-managed browser.'
			},
			channel: {
				type: 'string',
				title: 'Browser channel',
				description: 'Optional Playwright channel (e.g. "chrome", "msedge") instead of the bundled Chromium.'
			}
		}
	};

	private context?: PluginContext;
	private browser: PwBrowser | null = null;
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly loadModule: ModuleLoader = defaultModuleLoader,
		private readonly guardDeps: UrlGuardDeps = {}
	) {}

	// ── IBrowserAutomationPlugin ────────────────────────────────────

	async open(spec?: BrowserSessionSpec): Promise<BrowserSessionHandle> {
		const policy = resolveNavigationPolicy(spec?.settings, spec);
		this.warnOnWildcardWithPrivateNetwork(spec?.settings);

		const browser = await this.ensureBrowser(spec?.settings, policy);
		const context = await browser.newContext({
			userAgent: spec?.userAgent,
			viewport: spec?.viewport ? { width: spec.viewport.width, height: spec.viewport.height } : undefined
		});
		const page = await context.newPage();
		page.setDefaultTimeout(policy.timeoutMs);
		page.setDefaultNavigationTimeout(policy.timeoutMs);

		const session: Session = { id: randomUUID(), policy, context, page, blocked: [] };
		await this.installRouteGuard(session);
		this.sessions.set(session.id, session);

		return { sessionId: session.id, policy };
	}

	async navigate(handle: BrowserSessionHandle, url: string): Promise<BrowserNavigateResult> {
		const session = this.requireSession(handle);

		// Guard BEFORE the browser ever touches the network. The route
		// guard below is the second line, not the first.
		await assertUrlAllowed(url, session.policy, 'document', this.guardDeps);

		session.blocked = [];
		let response: PwResponse | null;
		try {
			response = await session.page.goto(url, {
				timeout: session.policy.timeoutMs,
				waitUntil: 'domcontentloaded'
			});
		} catch (error) {
			// An aborted redirect surfaces as a navigation failure. If the
			// route guard recorded a refusal, report THAT — the caller
			// needs the reason, not "net::ERR_FAILED".
			const refusal = session.blocked.find((entry) => entry.navigation);
			if (refusal) {
				throw new BrowserNavigationBlockedError(refusal.reason, refusal.url);
			}
			throw error;
		}

		const redirectChain = collectRedirectChain(response, url);

		// Belt-and-braces: audit every hop the browser actually took. A
		// hop that got past the route guard must still fail the call
		// rather than hand back off-allowlist content.
		for (const hop of redirectChain) {
			const verdict = classifyUrl(hop, session.policy, 'document');
			if (!verdict.allowed) {
				throw new BrowserNavigationBlockedError(verdict.reason, redactUrl(hop));
			}
		}
		const finalUrl = session.page.url();
		const finalVerdict = classifyUrl(finalUrl, session.policy, 'document');
		if (!finalVerdict.allowed) {
			throw new BrowserNavigationBlockedError(finalVerdict.reason, redactUrl(finalUrl));
		}

		return {
			url: finalUrl,
			status: response ? response.status() : null,
			title: await session.page.title(),
			redirectChain,
			blockedRequests: this.drainBlocked(session)
		};
	}

	async extract(handle: BrowserSessionHandle, query: BrowserExtractQuery): Promise<BrowserExtractResult> {
		const session = this.requireSession(handle);
		const timeout = session.policy.timeoutMs;

		if (query.format === 'attribute' && !query.attribute) {
			throw new TypeError('extract(format: "attribute") requires an `attribute` name.');
		}

		const limit = Math.min(MAX_EXTRACT_NODES, Math.max(1, Math.trunc(query.limit ?? MAX_EXTRACT_NODES)));

		if (!query.selector) {
			// Whole-document shortcut — no selector, no per-node loop.
			if (query.format === 'html') {
				return { values: [await session.page.content()], truncated: false };
			}
			if (query.format === 'text') {
				return { values: [await session.page.locator('body').innerText({ timeout })], truncated: false };
			}
			throw new TypeError('extract(format: "attribute") requires a `selector`.');
		}

		const nodes = await session.page.locator(query.selector).all();
		const selected = nodes.slice(0, limit);
		const values: string[] = [];
		for (const node of selected) {
			if (query.format === 'text') {
				values.push((await node.textContent({ timeout })) ?? '');
			} else if (query.format === 'html') {
				values.push(await node.innerHTML({ timeout }));
			} else {
				values.push((await node.getAttribute(query.attribute as string, { timeout })) ?? '');
			}
		}

		return { values, truncated: nodes.length > selected.length };
	}

	async screenshot(
		handle: BrowserSessionHandle,
		request?: BrowserScreenshotRequest
	): Promise<BrowserScreenshotResult> {
		const session = this.requireSession(handle);
		const timeout = session.policy.timeoutMs;
		const format = request?.format === 'jpeg' ? 'jpeg' : 'png';
		const quality = format === 'jpeg' ? clampQuality(request?.quality) : undefined;

		const buffer = request?.selector
			? await session.page.locator(request.selector).first().screenshot({ timeout, type: format, quality })
			: await session.page.screenshot({
					timeout,
					type: format,
					quality,
					fullPage: request?.fullPage === true
				});

		const bytes = Buffer.from(buffer);
		return {
			base64: bytes.toString('base64'),
			contentType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
			bytes: bytes.byteLength
		};
	}

	async act(handle: BrowserSessionHandle, steps: readonly BrowserActStep[]): Promise<BrowserActResult> {
		const session = this.requireSession(handle);
		// Re-bound rather than narrowed in place: `Array.isArray()` on a
		// `readonly T[]` widens the guarded branch to `any[]`, which would
		// make `step.kind` `any` and silently defeat the exhaustiveness
		// check at the bottom of the switch below. The runtime guard still
		// earns its keep (callers reach this across a plugin boundary and
		// are not all typed), it just must not be the thing that types it.
		const actSteps: readonly BrowserActStep[] = Array.isArray(steps) ? steps : [];
		if (actSteps.length === 0) {
			return { performed: 0, url: session.page.url(), blockedRequests: this.drainBlocked(session) };
		}
		if (actSteps.length > MAX_ACT_STEPS) {
			throw new RangeError(`act() accepts at most ${MAX_ACT_STEPS} steps (received ${actSteps.length}).`);
		}

		let performed = 0;
		for (const step of actSteps) {
			const timeout = clampTimeout(step.timeoutMs, session.policy.timeoutMs);

			if (step.kind === 'wait' && !step.selector) {
				await session.page.waitForTimeout(timeout);
				performed += 1;
				continue;
			}
			if (!step.selector) {
				throw new TypeError(`act() step "${step.kind}" requires a \`selector\`.`);
			}

			const locator = session.page.locator(step.selector).first();
			switch (step.kind) {
				case 'click':
					await locator.click({ timeout });
					break;
				case 'fill':
					await locator.fill(step.value ?? '', { timeout });
					break;
				case 'select':
					if (step.value === undefined) {
						throw new TypeError('act() step "select" requires a `value`.');
					}
					await locator.selectOption(step.value, { timeout });
					break;
				case 'press':
					if (!step.key) {
						throw new TypeError('act() step "press" requires a `key`.');
					}
					await locator.press(step.key, { timeout });
					break;
				case 'hover':
					await locator.hover({ timeout });
					break;
				case 'wait':
					await locator.waitFor({ timeout, state: 'visible' });
					break;
				default: {
					const unknownKind: never = step.kind;
					throw new TypeError(`act() received an unsupported step kind: ${String(unknownKind)}`);
				}
			}
			performed += 1;
		}

		// An action may have navigated. The allowlist applies just the
		// same — a click that lands off-allowlist is a refusal.
		const url = session.page.url();
		const verdict = classifyUrl(url, session.policy, 'document');
		if (!verdict.allowed) {
			throw new BrowserNavigationBlockedError(verdict.reason, redactUrl(url));
		}

		return { performed, url, blockedRequests: this.drainBlocked(session) };
	}

	async close(handle: BrowserSessionHandle): Promise<void> {
		const session = this.sessions.get(handle.sessionId);
		if (!session) return;
		this.sessions.delete(handle.sessionId);
		try {
			await session.page.close();
		} catch {
			// Page may already be gone — teardown is best-effort by design.
		}
		try {
			await session.context.close();
		} catch {
			// Same: never let cleanup mask the caller's real outcome.
		}
		if (this.sessions.size === 0) {
			await this.closeBrowser();
		}
	}

	async probe(settings?: PluginSettings): Promise<{ ok: boolean; detail?: string }> {
		const policy = resolveNavigationPolicy(settings);
		try {
			await this.loadPlaywright();
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
		if (policy.allowedHosts.length === 0) {
			return {
				ok: false,
				detail: 'Playwright is available but the navigation allowlist is empty — every navigation will be refused.'
			};
		}
		return {
			ok: true,
			detail: `Playwright available; ${policy.allowedHosts.length} allowlist entries configured.`
		};
	}

	// ── settings validation ─────────────────────────────────────────

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: ValidationError[] = [];
		const warnings: ValidationError[] = [];

		for (const entry of collectInvalidHostPatterns(settings.allowedHosts)) {
			errors.push({
				path: 'allowedHosts',
				code: 'invalid_host_pattern',
				actual: entry,
				message: `"${entry}" is not a valid host pattern. Use "example.com", "*.example.com", an optional ":port" suffix, or "*".`
			});
		}

		if (settings.allowPrivateNetwork === true) {
			const hasWildcard = toStringList(settings.allowedHosts).some(
				(entry) => parseHostPattern(entry)?.host === '*'
			);
			if (hasWildcard) {
				errors.push({
					path: 'allowPrivateNetwork',
					code: 'wildcard_with_private_network',
					message:
						'Private-network access requires an explicit host allowlist. Remove the "*" entry, or turn private-network access off.'
				});
			}
		}

		if (toStringList(settings.allowedHosts).length === 0 && !process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS) {
			warnings.push({
				path: 'allowedHosts',
				code: 'empty_allowlist',
				message:
					'The allowlist is empty, so every navigation will be refused. Add the hosts you intend to automate.'
			});
		}

		if (settings.headless === false) {
			warnings.push({
				path: 'headless',
				code: 'headed_browser',
				message: 'Headed mode is for local debugging only — server runtimes should keep the browser headless.'
			});
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	// ── route guard ─────────────────────────────────────────────────

	/**
	 * Intercept every request the page makes. Playwright re-fires the
	 * handler for each redirect hop, which is exactly what makes
	 * "never follow a redirect outside the allowlist" enforceable rather
	 * than aspirational.
	 */
	private async installRouteGuard(session: Session): Promise<void> {
		await session.page.route('**/*', async (route) => {
			const request = route.request();
			const url = request.url();
			const navigation = isDocumentRequest(request);
			try {
				await assertUrlAllowed(url, session.policy, navigation ? 'document' : 'subresource', this.guardDeps);
			} catch (error) {
				const reason = error instanceof BrowserNavigationBlockedError ? error.code : 'invalid_url';
				session.blocked.push({ url: redactUrl(url), reason, navigation });
				await route.abort('blockedbyclient');
				return;
			}
			await route.continue();
		});
	}

	private drainBlocked(session: Session): BrowserBlockedRequest[] {
		const drained = session.blocked;
		session.blocked = [];
		return drained;
	}

	// ── browser lifecycle ───────────────────────────────────────────

	private async ensureBrowser(
		settings: PluginSettings | undefined,
		policy: BrowserNavigationPolicy
	): Promise<PwBrowser> {
		if (this.browser && this.browser.isConnected?.() !== false) {
			return this.browser;
		}
		const playwright = await this.loadPlaywright();
		const raw = (settings ?? {}) as Record<string, unknown>;
		const executablePath =
			typeof raw.executablePath === 'string' && raw.executablePath.trim()
				? raw.executablePath.trim()
				: process.env.PLUGIN_BROWSER_AUTOMATION_EXECUTABLE_PATH;
		const channel = typeof raw.channel === 'string' && raw.channel.trim() ? raw.channel.trim() : undefined;

		try {
			this.browser = await playwright.chromium.launch({
				headless: policy.headless,
				timeout: policy.timeoutMs,
				executablePath,
				channel
			});
		} catch (error) {
			throw new BrowserAutomationNotProvisionedError(
				`Chromium failed to launch: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		return this.browser;
	}

	private async loadPlaywright(): Promise<PlaywrightModuleLike> {
		let loaded: unknown;
		try {
			loaded = await this.loadModule(PLAYWRIGHT_MODULE);
		} catch (error) {
			throw new BrowserAutomationNotProvisionedError(
				`Playwright is not installed in this runtime (${
					error instanceof Error ? error.message : String(error)
				}). Install "${PLAYWRIGHT_MODULE}" and a Chromium build to enable browser automation.`
			);
		}
		const candidate = loaded as { chromium?: unknown; default?: { chromium?: unknown } };
		// CJS interop: a required module may arrive wrapped in `default`.
		const chromium = candidate?.chromium ?? candidate?.default?.chromium;
		if (!chromium || typeof (chromium as { launch?: unknown }).launch !== 'function') {
			throw new BrowserAutomationNotProvisionedError(
				`"${PLAYWRIGHT_MODULE}" loaded but exposes no usable chromium launcher.`
			);
		}
		return { chromium } as PlaywrightModuleLike;
	}

	private async closeBrowser(): Promise<void> {
		const browser = this.browser;
		this.browser = null;
		if (!browser) return;
		try {
			await browser.close();
		} catch {
			// Best-effort: a browser that already died is not an error here.
		}
	}

	private requireSession(handle: BrowserSessionHandle): Session {
		const session = this.sessions.get(handle?.sessionId ?? '');
		if (!session) {
			throw new BrowserAutomationNotProvisionedError(
				`Unknown browser session "${handle?.sessionId ?? '<none>'}" — it was never opened, or has already been closed.`
			);
		}
		return session;
	}

	private warnOnWildcardWithPrivateNetwork(settings: PluginSettings | undefined): void {
		const raw = (settings ?? {}) as Record<string, unknown>;
		if (raw.allowPrivateNetwork !== true) return;
		if (!toStringList(raw.allowedHosts).some((entry) => parseHostPattern(entry)?.host === '*')) return;
		this.context?.logger?.warn?.(
			'browser-automation: the "*" allowlist entry is IGNORED while private-network access is enabled — list the internal hosts explicitly.'
		);
	}

	// ── IPlugin lifecycle ───────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log(
			'browser-automation loaded (headless Chromium via Playwright; default-deny navigation allowlist).'
		);
	}

	async onUnload(): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			await this.close({ sessionId: session.id, policy: session.policy });
		}
		await this.closeBrowser();
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const probe = await this.probe();
		return {
			status: probe.ok ? 'healthy' : 'degraded',
			message: probe.detail ?? 'ok',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Headless Chromium automation: navigate, extract, screenshot and act, behind a default-deny navigation allowlist re-checked on every redirect hop.',
			category: this.category,
			capabilities: [...this.capabilities],
			// Distributed through the registry, not baked into the image:
			// the driver needs a Chromium build the base image does not
			// carry, so it is installed on enable.
			builtIn: false,
			distribution: 'registry',
			defaultForCapabilities: ['browser-automation'],
			icon: { type: 'lucide', value: 'Globe', backgroundColor: '#0f172a' }
		};
	}
}

// ── module-local helpers ────────────────────────────────────────────

/**
 * Playwright reports `isNavigationRequest()` for top-level AND iframe
 * document loads. Both are treated as navigations here: an iframe that
 * pulls an internal URL is exactly the SSRF the allowlist exists to stop.
 */
function isDocumentRequest(request: PwRequest): boolean {
	try {
		return request.isNavigationRequest() || request.resourceType() === 'document';
	} catch {
		// A request object can go stale mid-teardown; treat it as the
		// stricter kind rather than waving it through.
		return true;
	}
}

/**
 * Walk `redirectedFrom()` back to the first request, returning the hops
 * oldest-first. Falls back to the requested URL when the response (or
 * the chain) is unavailable.
 */
function collectRedirectChain(response: PwResponse | null, requestedUrl: string): string[] {
	if (!response) return [requestedUrl];
	const chain: string[] = [];
	let cursor: PwRequest | null = response.request();
	const seen = new Set<string>();
	while (cursor) {
		const url = cursor.url();
		// Defensive: a malformed chain must not spin forever.
		if (seen.has(url)) break;
		seen.add(url);
		chain.unshift(url);
		cursor = typeof cursor.redirectedFrom === 'function' ? cursor.redirectedFrom() : null;
	}
	return chain.length > 0 ? chain : [requestedUrl];
}

function clampQuality(value: unknown): number | undefined {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) return undefined;
	return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

function toStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === 'string');
	}
	if (typeof value === 'string') {
		return value
			.split(/[\n,]/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}

export default BrowserAutomationPlugin;
