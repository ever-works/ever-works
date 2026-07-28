import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Browser-automation capability — pluggable headless-browser drivers
 * (capability `browser-automation`).
 *
 * The four verbs are deliberately the whole surface:
 *
 *  - `navigate` — go to a URL and report where you actually ended up
 *    (final URL + the full redirect chain, so a caller can audit it).
 *  - `extract`  — pull structured text / HTML / attributes out of the
 *    rendered DOM via CSS selectors.
 *  - `screenshot` — capture the page (or one element) as base64 bytes.
 *  - `act` — a bounded list of interaction steps (click / fill / select
 *    / press / hover / wait) executed in order.
 *
 * ## Security posture (non-negotiable for every implementation)
 *
 * A headless browser reachable from server-side code is an SSRF engine
 * with a JavaScript runtime attached. Implementations MUST therefore:
 *
 *  1. Run **headless by default**. Headed mode is opt-in configuration,
 *     never an implicit default.
 *  2. Enforce a **default-deny navigation allowlist**: with no allowed
 *     hosts configured, EVERY navigation is refused. There is no
 *     "allow anything" fallback.
 *  3. Refuse private / loopback / link-local / cloud-metadata targets
 *     regardless of the allowlist, unless the operator has explicitly
 *     opted into private-network access AND pinned an explicit host
 *     list (never a wildcard).
 *  4. **Never follow a redirect outside the allowlist.** The allowlist
 *     is re-evaluated for every hop, not just the URL the caller typed.
 *  5. Enforce a configurable wall-clock timeout on every operation.
 *
 * Refusals are reported by throwing {@link BrowserNavigationBlockedError}
 * with a stable discriminated `code` — never a silent empty result.
 */

/** Why a URL was refused. Stable, matched by value (never by message). */
export type BrowserBlockReason =
	/** Not parseable as a URL at all. */
	| 'invalid_url'
	/** Scheme other than http/https (file:, data:, chrome:, view-source:, …). */
	| 'scheme_blocked'
	/** URL carried embedded `user:password@` credentials. */
	| 'credentials_in_url'
	/** Literal private / loopback / link-local / cloud-metadata address. */
	| 'private_address'
	/** Host is not covered by the configured allowlist (incl. empty allowlist). */
	| 'not_allowlisted'
	/** Hostname resolved to a private address (DNS-rebinding defence). */
	| 'dns_private_ip'
	/** Hostname could not be resolved — fail closed, never fail open. */
	| 'dns_lookup_failed';

/**
 * Thrown when a browser-automation provider refuses to reach a URL.
 * Matched BY NAME across packages (bundlers break `instanceof` across
 * dual CJS/ESM copies), so the `name` is pinned in the constructor.
 */
export class BrowserNavigationBlockedError extends Error {
	readonly code: BrowserBlockReason;
	/** The refused URL, with any embedded credentials already stripped. */
	readonly url: string;

	constructor(code: BrowserBlockReason, url: string, message?: string) {
		super(message ?? `Navigation to ${url} refused: ${code}`);
		this.name = 'BrowserNavigationBlockedError';
		this.code = code;
		this.url = url;
	}
}

/**
 * Thrown when the provider cannot operate in this runtime (browser
 * binary missing, driver package absent, sandbox forbids launching).
 * Loud + actionable — never a silent no-op.
 */
export class BrowserAutomationNotProvisionedError extends Error {
	constructor(message?: string) {
		super(message ?? 'Browser automation provider is not provisioned in this runtime.');
		this.name = 'BrowserAutomationNotProvisionedError';
	}
}

/**
 * Effective navigation policy for one session. Resolved by the provider
 * from its settings; surfaced on the handle so a caller can assert what
 * it actually got instead of trusting a default.
 */
export interface BrowserNavigationPolicy {
	/**
	 * Host patterns that may be navigated to. Empty means DENY ALL —
	 * that is the safe default, not a misconfiguration to paper over.
	 *
	 * Supported forms: `example.com` (exact host), `*.example.com` (any
	 * subdomain, apex NOT included), either optionally suffixed with
	 * `:<port>` to pin the port, and the bare `*` meaning "any PUBLIC
	 * host" (private/loopback/metadata stay blocked).
	 */
	readonly allowedHosts: readonly string[];
	/**
	 * How non-document (sub-resource) requests are treated:
	 *  - `allowlist`   — subresources must match `allowedHosts` too.
	 *  - `public-only` — subresources may hit any PUBLIC host, but
	 *    private/loopback/metadata targets stay blocked (default: a page
	 *    whose CDN assets are blocked renders as a broken screenshot).
	 */
	readonly subresourcePolicy: 'allowlist' | 'public-only';
	/**
	 * Escape hatch for automating internal staging hosts. Default false.
	 * When true the allowlist MUST be explicit — combining it with the
	 * bare `*` pattern is refused outright rather than silently opening
	 * the whole internal network.
	 */
	readonly allowPrivateNetwork: boolean;
	/** Wall-clock budget applied to navigation and each action. */
	readonly timeoutMs: number;
	/** True unless the operator explicitly opted into a headed browser. */
	readonly headless: boolean;
}

/** A request the provider refused mid-page-load. */
export interface BrowserBlockedRequest {
	readonly url: string;
	readonly reason: BrowserBlockReason;
	/** True when the refused request was a top-level navigation/redirect. */
	readonly navigation: boolean;
}

/** Inputs to open one browser session. */
export interface BrowserSessionSpec {
	/** Resolved plugin settings injected by the caller/facade. */
	readonly settings?: PluginSettings;
	/** Per-session timeout override; clamped to the provider's bounds. */
	readonly timeoutMs?: number;
	readonly viewport?: { readonly width: number; readonly height: number };
	readonly userAgent?: string;
	/** Extra allowlist entries for this session, ANDed with the settings. */
	readonly extraAllowedHosts?: readonly string[];
}

/** Handle to a live session. Opaque to callers apart from these fields. */
export interface BrowserSessionHandle {
	readonly sessionId: string;
	/** The policy actually in force — assert on this, don't assume. */
	readonly policy: BrowserNavigationPolicy;
}

export interface BrowserNavigateResult {
	/** Final URL after every ALLOWED redirect hop. */
	readonly url: string;
	readonly status: number | null;
	readonly title: string;
	/**
	 * Every hop, oldest first, ending at {@link url}. Each entry passed
	 * the allowlist — a hop that did not is an error, not a log line.
	 */
	readonly redirectChain: readonly string[];
	/** Sub-resource requests refused while the page loaded. */
	readonly blockedRequests: readonly BrowserBlockedRequest[];
}

export interface BrowserExtractQuery {
	/** CSS selector. Omitted means the whole document. */
	readonly selector?: string;
	readonly format: 'text' | 'html' | 'attribute';
	/** Attribute name — required when `format` is `attribute`. */
	readonly attribute?: string;
	/** Hard cap on returned nodes (provider clamps to its own maximum). */
	readonly limit?: number;
}

export interface BrowserExtractResult {
	readonly values: readonly string[];
	/** True when more nodes matched than `limit` allowed through. */
	readonly truncated: boolean;
}

export type BrowserActionKind = 'click' | 'fill' | 'select' | 'press' | 'hover' | 'wait';

export interface BrowserActStep {
	readonly kind: BrowserActionKind;
	/** CSS selector — required for every kind except `wait` with `timeoutMs`. */
	readonly selector?: string;
	/** Text for `fill`, option value for `select`. */
	readonly value?: string;
	/** Key name for `press` (e.g. `Enter`, `Control+A`). */
	readonly key?: string;
	/** Per-step override; still clamped by the session timeout. */
	readonly timeoutMs?: number;
}

export interface BrowserActResult {
	/** How many steps ran to completion. */
	readonly performed: number;
	/** URL after the steps — an action may have triggered a navigation. */
	readonly url: string;
	readonly blockedRequests: readonly BrowserBlockedRequest[];
}

export interface BrowserScreenshotRequest {
	readonly fullPage?: boolean;
	readonly format?: 'png' | 'jpeg';
	/** JPEG quality 1-100; ignored for PNG. */
	readonly quality?: number;
	/** Capture one element instead of the viewport/page. */
	readonly selector?: string;
}

export interface BrowserScreenshotResult {
	readonly base64: string;
	readonly contentType: 'image/png' | 'image/jpeg';
	readonly bytes: number;
}

/** Browser-automation plugin interface — capability `browser-automation`. */
export interface IBrowserAutomationPlugin extends IPlugin {
	readonly providerName: string;

	/** Launch/lease a browser context. Headless unless configured otherwise. */
	open(spec?: BrowserSessionSpec): Promise<BrowserSessionHandle>;

	/**
	 * Navigate. MUST re-check the allowlist on every redirect hop and
	 * throw {@link BrowserNavigationBlockedError} rather than land on an
	 * off-allowlist URL.
	 */
	navigate(handle: BrowserSessionHandle, url: string): Promise<BrowserNavigateResult>;

	extract(handle: BrowserSessionHandle, query: BrowserExtractQuery): Promise<BrowserExtractResult>;

	screenshot(handle: BrowserSessionHandle, request?: BrowserScreenshotRequest): Promise<BrowserScreenshotResult>;

	act(handle: BrowserSessionHandle, steps: readonly BrowserActStep[]): Promise<BrowserActResult>;

	/** Route EVERY teardown through here (close context → release browser). */
	close(handle: BrowserSessionHandle): Promise<void>;

	/** Cheap readiness probe — is a browser actually launchable here? */
	probe?(settings?: PluginSettings): Promise<{ ok: boolean; detail?: string }>;
}

/** Type guard — true when a plugin declares the `browser-automation` capability. */
export function isBrowserAutomationPlugin(plugin: IPlugin): plugin is IBrowserAutomationPlugin {
	return plugin.capabilities.includes('browser-automation');
}
