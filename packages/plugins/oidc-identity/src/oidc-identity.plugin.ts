import type {
	IdentityProviderCheck,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginManifest
} from '@ever-works/plugin';

import {
	OIDC_DISCOVERY_CACHE_SECONDS,
	OIDC_IDENTITY_SIGNING_ALGS,
	OIDC_OUTBOUND_TIMEOUT_MS,
	OidcDiscoveryReader,
	OidcProviderUnavailableError,
	type OidcDiscoveryDocument,
	type OidcDiscoveryFailure,
	type OidcDiscoveryRead,
	type OidcFetchImpl,
	type OidcProviderUnavailableReason
} from './discovery.js';
import {
	oidcIdentitySettingsSchema,
	type OidcIdentityLocalClient,
	type OidcIdentitySettings
} from './settings.schema.js';

/** Every FR-3 check id, in FR-3's own order (spec.md:183-186). */
export const FR3_CHECK_IDS: readonly IdentityProviderCheck['id'][] = [
	'discovery',
	'issuerMatch',
	'endpoints',
	'pkceS256',
	'signingAlg',
	'backchannelLogout',
	'deviceAuthorization'
];

/**
 * The five FR-3 checks that gate availability; the other two only report.
 *
 * FR-3 asks **Test connection** to report "whether back-channel logout and device
 * authorization are supported" — both are optional in OpenID Connect, and a
 * provider without them is a provider Ever Works can still sign people in with
 * (FR-33's notices are the only thing lost). Letting either row turn the plugin
 * off would make an optional feature's absence a sign-in outage, so plan §4.2's
 * `unavailableSince` is written and cleared by these five and by nothing else.
 */
export const FR3_REQUIRED_CHECK_IDS: readonly IdentityProviderCheck['id'][] = [
	'discovery',
	'issuerMatch',
	'endpoints',
	'pkceS256',
	'signingAlg'
];

/**
 * The seams a spec (or a future caller) may inject.
 *
 * Both are optional and both default to the runtime: the plugin loader constructs
 * a plugin with no arguments (`PluginLoaderService.loadPluginModule`,
 * `plugin-loader.service.ts:364`), so nothing here is a production requirement.
 * They exist because T6's two properties — FR-3's 5-second bound and FR-13's
 * 600/30/21,600-second ladder — are only provable against a clock and a socket the
 * test owns; a spec that really waited 21,600 seconds is not a spec.
 */
export interface OidcIdentityPluginOptions {
	/** The outbound HTTP seam; defaults to the runtime `fetch` (see `discovery.ts`). */
	readonly fetchImpl?: OidcFetchImpl;
	/** The clock, in epoch milliseconds; defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * APW-12 T5 — the `oidc-identity` plugin, **scaffold only**.
 *
 * What exists here is the identity the platform's discovery path needs and
 * nothing more:
 *
 *   - the manifest the `everworks.plugin` block in `package.json` also declares
 *     (they must agree — `packages/agent/src/plugins/services/plugin-manifest-validator.service.ts`
 *     extracts the block from disk and `PluginClassValidatorService` compares the
 *     loaded class against it);
 *   - the settings schema of plan §4.2;
 *   - the two lifecycle hooks the loader calls. Both are **prototype methods on
 *     purpose**: `PluginClassValidatorService.isPluginClass`
 *     (`packages/agent/src/plugins/services/plugin-class-validator.service.ts:42-55`)
 *     accepts a class only when `onLoad` and `onUnload` sit on its prototype, so
 *     an arrow-function property would make this plugin undiscoverable.
 *
 * What does NOT exist yet, deliberately: the five sign-in methods of
 * `IIdentityProviderPlugin` (`buildAuthorizationRequest`, `exchangeAuthorizationCode`,
 * `verifyAccessToken`, `verifyLogoutToken`, `buildEndSessionUrl`) and `healthCheck`,
 * which T7/T8 write. T6 landed the two configuration methods —
 * `testConnection` (FR-3) and `getPublicConfig` (FR-2) — plus the discovery reader
 * and the key cache they and the flow share (`src/discovery.ts`,
 * `src/jwks-cache.ts`). The capability string below is the plan §4.2 contract — the
 * manifest is fixed — and the class still does not claim the interface: it
 * implements `IPlugin` and two of the seven methods, so
 * `isIdentityProviderPlugin` (`packages/plugin/src/contracts/capabilities/identity-provider.interface.ts:284`)
 * keeps answering `false` for it — which is what keeps the façade (plan §4.4)
 * fail-closed for the five methods T7/T8 have not written yet. Until then the
 * plugin is inert: `autoEnable: false`, so it is discovered and listed disabled.
 */
export class OidcIdentityPlugin implements IPlugin {
	readonly id = 'oidc-identity';
	readonly name = 'OpenID Connect identity (Ever ID)';
	readonly version = '1.0.0';

	/**
	 * The plan §4.2 category, `'identity'`.
	 *
	 * The assertion is needed only because this package lands **before T4**,
	 * which appends `'identity'` to `PLUGIN_CATEGORIES`
	 * (`packages/plugin/src/contracts/plugin-manifest.types.ts:5-117` — the tuple
	 * currently closes with `'build'`). Until that append lands the loader's own
	 * `isPluginCategory` check rejects the manifest, so this plugin is
	 * discoverable only after T4; the value itself is already exact, and the
	 * assertion is the one place the type union is narrower than the plan.
	 *
	 * **Landed 2026-09-18 (T4).** `'identity'` is now the **last** member of
	 * `PLUGIN_CATEGORIES`, so the loader's `isPluginCategory` accepts this
	 * manifest and discovery finds the package instead of skipping it with
	 * `Invalid category` (T4's report measures it: 103 → 104 plugins). The
	 * paragraph above is kept because that is what this file had to say while
	 * the append was missing, and the cast below stays — it resolves to the
	 * same member, and dropping it would remove an assertion for nothing.
	 */
	readonly category: PluginCategory = 'identity' as PluginCategory;

	/** Plan §4.2: exactly one capability, `identity-provider`. */
	readonly capabilities: readonly string[] = ['identity-provider'];

	/** One issuer set per installation, configured by a platform admin (FR-7, FR-2). */
	readonly configurationMode = 'admin-only';

	readonly settingsSchema: JsonSchema = oidcIdentitySettingsSchema;

	/**
	 * The context `onLoad` was handed — the only way this plugin reads its own
	 * resolved settings (plan §4.1: no method takes a configuration object, so a
	 * caller cannot hand the plugin a different issuer, client id or secret than the
	 * one an administrator saved; FR-7).
	 */
	private context?: PluginContext;

	/** The discovery reader for the currently configured issuer (FR-14's cache lives in it). */
	private discoveryReader?: OidcDiscoveryReader;

	/** Which issuer {@link discoveryReader} was built for — a settings change replaces it. */
	private discoveryIssuerUrl?: string;

	/** FR-14/FR-5: when the provider was first seen unusable, in epoch ms. T32 persists it. */
	private unavailableSinceMs: number | null = null;

	/** Which rule made it unusable — a closed set, never a provider's own text (FR-16). */
	private unavailableReason: OidcProviderUnavailableReason | null = null;

	private readonly fetchImpl?: OidcFetchImpl;
	private readonly now: () => number;

	constructor(options: OidcIdentityPluginOptions = {}) {
		this.fetchImpl = options.fetchImpl;
		this.now = options.now ?? Date.now;
	}

	async onLoad(context: PluginContext): Promise<void> {
		// The context is held, not copied into a settings field: settings are resolved
		// per call (`context.getSettings()`), so an administrator's change takes effect
		// without a reload — which is what FR-5's 60-second bound needs.
		this.context = context;
		context.logger.log(
			'OpenID Connect identity (Ever ID) plugin loaded — discovery, key cache and Test connection are live; the sign-in flow lands in APW-12 T7'
		);
	}

	async onUnload(): Promise<void> {
		// Drop what onLoad held, so a reloaded plugin cannot answer from the previous
		// context's settings — and so the discovery cache does not outlive the
		// configuration it was read for.
		this.context = undefined;
		this.discoveryReader = undefined;
		this.discoveryIssuerUrl = undefined;
	}

	/**
	 * FR-3 — read the provider's discovery document and report every check.
	 *
	 * The rules this method exists to keep, in the order they matter:
	 *
	 *   - **5 seconds, always** (FR-3, ACC-12-03). The read is handed a deadline
	 *     computed when the run starts, so FR-15's single retry can only ever fit
	 *     inside that budget, and the answer is reported at the deadline whether or
	 *     not the provider answered in time.
	 *   - **A row per check, always** — the same seven ids in FR-3's order, an
	 *     unconfigured integration and an unreachable provider included. A short or
	 *     varying list would make spec §6.7's admin surface render differently
	 *     depending on what went wrong.
	 *   - **Never the secret** (FR-16). No `detail` quotes a value the provider sent
	 *     except a numeric HTTP status; every one of them names a field, and the
	 *     settings object — which is where `clientSecret` lives — is never returned,
	 *     logged or embedded.
	 *
	 * The run also writes the availability record plan §4.2 keeps: the five checks
	 * of {@link FR3_REQUIRED_CHECK_IDS} passing clears `unavailableSince`, any of them
	 * failing sets it (FR-14's "until an administrator re-tests"). T32 persists it;
	 * {@link getAvailability} is the in-process view until then.
	 */
	async testConnection(): Promise<IdentityProviderCheck[]> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) {
			// Fail closed, and name the fields rather than the values (FR-4's "field
			// names only", FR-16's no-material rule applied to the admin surface).
			this.recordUnavailable('notConfigured');
			return unavailableRows(
				`Not configured: ${resolved.missing.join(', ')}.`,
				'Not checked — the integration is not configured.'
			);
		}

		const issuerUrl = resolved.settings.issuerUrl;
		// FR-3's bound starts here, not inside the fetch: everything the run does has
		// to fit inside it.
		const deadlineAt = this.now() + OIDC_OUTBOUND_TIMEOUT_MS;
		const read = await this.readerFor(issuerUrl).read({ deadlineAt });

		const checks = read.ok
			? checksFromDocument(read.document, issuerUrl)
			: unavailableRows(
					discoveryFailureDetail(read.failure, read.status),
					'Not checked — the discovery document could not be read.'
				);

		this.applyAvailability(checks);
		this.logChecks(checks);
		return checks;
	}

	/**
	 * FR-2's non-secret projection — what the web needs to render the button and
	 * what a local client needs before it can sign in.
	 *
	 * The contract's five fields and nothing else: the client secret is not among
	 * them (FR-16), and neither is anything that would let a caller address the
	 * provider differently from the configuration an administrator saved (FR-7). The
	 * defaults are FR-2's: display name `Ever ID`, audience `ever-works`, sign-up on.
	 */
	async getPublicConfig(): Promise<{
		issuer: string;
		displayName: string;
		localClients: OidcIdentityLocalClient[];
		apiAudience: string;
		signUpAllowed: boolean;
	}> {
		const resolved = await this.resolveSettings();
		if (!resolved.ok) {
			// The one honest answer for "what should the web show?" on an integration
			// with no issuer, client id or secret. The message is the code: the missing
			// field names are for the admin surface, which reads them from the settings
			// response, not from an error (FR-16).
			throw new OidcProviderUnavailableError('notConfigured');
		}

		const settings = resolved.settings;
		return {
			issuer: settings.issuerUrl,
			displayName: nonEmpty(settings.displayName) ?? 'Ever ID',
			localClients: localClientsOf(settings.localClients),
			apiAudience: nonEmpty(settings.apiAudience) ?? 'ever-works',
			// FR-2's default is on, so only an explicit `false` turns sign-up off.
			signUpAllowed: settings.signUpAllowed !== false
		};
	}

	/**
	 * The in-process availability record plan §4.2 stores under `availability`.
	 *
	 * Additive surface for T32, which persists these into the plugin's settings row so
	 * every replica agrees within 60 seconds (FR-5): this is the same record one
	 * process holds, exposed so the persistence task does not have to re-derive when a
	 * run passed.
	 */
	getAvailability(): {
		unavailableSince: string | null;
		unavailableReason: OidcProviderUnavailableReason | null;
		discoveryRefreshedAt: string | null;
		discoveryCacheSeconds: number;
	} {
		const refreshedAt = this.discoveryReader?.lastRefreshedAt ?? null;
		return {
			unavailableSince: this.unavailableSinceMs === null ? null : new Date(this.unavailableSinceMs).toISOString(),
			unavailableReason: this.unavailableReason,
			discoveryRefreshedAt: refreshedAt === null ? null : new Date(refreshedAt).toISOString(),
			discoveryCacheSeconds: OIDC_DISCOVERY_CACHE_SECONDS
		};
	}

	/**
	 * The settings this plugin reads, or the field names that are missing.
	 *
	 * `context.getSettings()` resolves the admin-tier values, secrets included
	 * (`SettingsSchemaValidatorService`, plan §4.2); a throw from the platform is
	 * treated exactly like an absent configuration, because the fail-closed answer is
	 * the same and neither path may surface the platform's own error text (FR-16).
	 */
	private async resolveSettings(): Promise<
		{ ok: true; settings: OidcIdentitySettings } | { ok: false; missing: string[] }
	> {
		let raw: Record<string, unknown> = {};
		try {
			raw = (await this.context?.getSettings()) ?? {};
		} catch {
			raw = {};
		}

		const missing = REQUIRED_SETTING_KEYS.filter(
			(key) => typeof raw[key] !== 'string' || (raw[key] as string).trim() === ''
		);
		if (missing.length > 0) return { ok: false, missing: [...missing] };
		return { ok: true, settings: raw as unknown as OidcIdentitySettings };
	}

	/** One reader per configured issuer: a settings change starts a fresh cache (FR-14). */
	private readerFor(issuerUrl: string): OidcDiscoveryReader {
		if (this.discoveryReader === undefined || this.discoveryIssuerUrl !== issuerUrl) {
			this.discoveryReader = new OidcDiscoveryReader({ issuerUrl, fetchImpl: this.fetchImpl, now: this.now });
			this.discoveryIssuerUrl = issuerUrl;
		}
		return this.discoveryReader;
	}

	/** Set or clear plan §4.2's `unavailableSince` from the five checks that gate it. */
	private applyAvailability(checks: IdentityProviderCheck[]): void {
		const failed = checks.find((check) => FR3_REQUIRED_CHECK_IDS.includes(check.id) && !check.ok);
		if (failed === undefined) {
			this.unavailableSinceMs = null;
			this.unavailableReason = null;
			return;
		}
		this.recordUnavailable(failed.id === 'issuerMatch' ? 'issuerDrift' : 'discoveryFailed');
	}

	/** FR-14/FR-5: the provider is off from the first failing run until a passing one. */
	private recordUnavailable(reason: OidcProviderUnavailableReason): void {
		// The instant of the *first* failure is kept (FR-5's 60-second bound is about
		// how long the provider has been unusable, not when it was last asked).
		if (this.unavailableSinceMs === null) this.unavailableSinceMs = this.now();
		this.unavailableReason = reason;
	}

	/**
	 * One log line per run, and it carries counts and check **ids** only.
	 *
	 * Ids come from the closed contract set, never from the provider, so nothing a
	 * provider chose to send can reach a log through this path (FR-16).
	 */
	private logChecks(checks: IdentityProviderCheck[]): void {
		const passed = checks.filter((check) => check.ok).length;
		const failing = checks.filter((check) => !check.ok).map((check) => check.id);
		const suffix = failing.length === 0 ? '' : ` — failing: ${failing.join(', ')}`;
		this.context?.logger.log(`Test connection: ${passed}/${checks.length} checks passed${suffix}`);
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'OpenID Connect relying party for Ever ID: browser sign-in, connected identities, delegated reads and back-channel logout',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			// The installation opts in explicitly: discovery lists it disabled (FR-5's
			// kill switch is the plugin toggle, plan §9.2).
			autoEnable: false
		};
	}
}

export default OidcIdentityPlugin;

/** FR-2's three required settings, in the schema's own order (`settings.schema.ts:277`). */
const REQUIRED_SETTING_KEYS = ['issuerUrl', 'clientId', 'clientSecret'] as const;

/**
 * One FR-3 row.
 *
 * `detail` is present **exactly** when `ok` is false: a passing check has nothing
 * to explain, and the contract's `detail?` is what spec §6.7 renders next to the
 * `✓`/`✗`. A failing row always carries one, so an administrator never sees a
 * bare cross.
 */
function row(id: IdentityProviderCheck['id'], ok: boolean, detail?: string): IdentityProviderCheck {
	if (ok) return { id, ok };
	return { id, ok, detail: detail ?? 'The check failed.' };
}

/** The seven rows FR-3 asks for, with `discovery` carrying one detail and the rest another. */
function unavailableRows(discoveryDetail: string, otherDetail: string): IdentityProviderCheck[] {
	return FR3_CHECK_IDS.map((id, index) => row(id, false, index === 0 ? discoveryDetail : otherDetail));
}

/**
 * The FR-3 rows a discovery document answers, in FR-3's order.
 *
 * Every value here comes from the document, and every *detail* is written by this
 * file: nothing a provider sent is echoed back into the admin surface, so a
 * provider cannot put text of its choosing in front of a platform administrator
 * (FR-16's no-material rule, read as far as reflecting arbitrary provider content).
 */
function checksFromDocument(document: OidcDiscoveryDocument, issuerUrl: string): IdentityProviderCheck[] {
	const missingEndpoints = (['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const).filter(
		(name) => typeof document[name] !== 'string' || (document[name] as string).length === 0
	);
	const challengeMethods = Array.isArray(document.code_challenge_methods_supported)
		? document.code_challenge_methods_supported
		: [];
	const signingAlgorithms = Array.isArray(document.id_token_signing_alg_values_supported)
		? document.id_token_signing_alg_values_supported
		: [];

	return [
		row('discovery', true),
		// FR-3's word is "exactly": no trailing-slash normalisation, no case folding.
		// The allow-list (`allowedIssuers`, FR-2) is what makes a planned provider
		// move reversible, and it is checked on the token's `iss` (§4.3), not here.
		row(
			'issuerMatch',
			document.issuer === issuerUrl,
			'The issuer the provider advertises does not match the configured issuer exactly.'
		),
		row(
			'endpoints',
			missingEndpoints.length === 0,
			`The discovery document is missing ${missingEndpoints.join(', ')}.`
		),
		row(
			'pkceS256',
			challengeMethods.includes('S256'),
			'The provider does not advertise S256 code challenge support.'
		),
		row(
			'signingAlg',
			OIDC_IDENTITY_SIGNING_ALGS.some((alg) => signingAlgorithms.includes(alg)),
			'The provider advertises none of RS256, ES256 or EdDSA.'
		),
		// FR-3 asks whether these two are supported; they are reported and never gate
		// availability (see FR3_REQUIRED_CHECK_IDS).
		row(
			'backchannelLogout',
			document.backchannel_logout_supported === true,
			'The provider does not advertise back-channel logout.'
		),
		row(
			'deviceAuthorization',
			typeof document.device_authorization_endpoint === 'string' &&
				document.device_authorization_endpoint.length > 0,
			'The provider does not advertise a device authorization endpoint.'
		)
	];
}

/**
 * Why the discovery read failed, in words an administrator can act on.
 *
 * One line per failure mode of `discovery.ts`, exhaustive on purpose: a new failure
 * mode must be given a sentence rather than falling through to a blank cross. The
 * HTTP status is the only provider-chosen value that appears, and it is a number.
 */
function discoveryFailureDetail(failure: OidcDiscoveryFailure, status?: number): string {
	switch (failure) {
		case 'timeout':
			return 'The discovery document did not answer within 5 seconds.';
		case 'httpStatus':
			return typeof status === 'number'
				? `The discovery document answered HTTP ${status}.`
				: 'The discovery document answered an error status.';
		case 'network':
			return 'The discovery document could not be reached.';
		case 'invalidBody':
			return 'The discovery document is not JSON.';
		case 'invalidDocument':
			return 'The discovery document carries no issuer.';
		case 'invalidIssuer':
			return 'The configured issuer address is not a valid URL.';
	}
}

/** A trimmed string, or `undefined` for anything absent, blank or not a string. */
function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * FR-2's local clients, filtered to the shape the contract publishes.
 *
 * The schema already caps the list at five and constrains `kind`, so this is the
 * reader's fail-closed half: an entry that is not a `{ kind, clientId }` pair is
 * dropped rather than handed to a caller as a client id it might trust. Dropping
 * can only *remove* an allowance, never add one, so it cannot widen access —
 * `verifyAccessToken`'s `allowedAuthorizedParties` (T8, FR-40) is what refuses a
 * token whose `azp` is not in the surviving list.
 */
function localClientsOf(value: unknown): OidcIdentityLocalClient[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry !== 'object' || entry === null) return [];
		const { kind, clientId } = entry as { kind?: unknown; clientId?: unknown };
		if (kind !== 'cli' && kind !== 'node') return [];
		const id = nonEmpty(clientId);
		return id === undefined ? [] : [{ kind, clientId: id }];
	});
}
