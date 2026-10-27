import type { OAuthConfig, OAuthToken } from '@ever-works/plugin';
import { MachineProviderError } from '@ever-works/plugin';

/**
 * Cloud computers (FL-17 P3, T-28, spec FR-31) — "Sign in with DigitalOcean"
 * instead of pasting a token: the provider's OAuth 2 authorization-code flow
 * (`cloud.digitalocean.com/v1/oauth/*`).
 *
 * Env-gated, like the deployment plugins: only when the OPERATOR registered
 * an application with the provider and set both
 * `DIGITALOCEAN_OAUTH_CLIENT_ID` and `DIGITALOCEAN_OAUTH_CLIENT_SECRET` (or the
 * admin-scope `clientId` / `clientSecret` settings) does the plugin advertise
 * the `oauth` capability; the token path keeps working either way.
 *
 * The platform runs the flow (state cookie, callback, token storage on the
 * owner's `plugin:digitalocean-machines` account row); this file only builds
 * the provider's URL and swaps a code — or a refresh token — for an access
 * token. The client secret travels in the POST body, never in a URL, and no
 * secret is ever part of a thrown message.
 */

export const DIGITALOCEAN_OAUTH_BASE = 'https://cloud.digitalocean.com';
export const ENV_DIGITALOCEAN_OAUTH_CLIENT_ID = 'DIGITALOCEAN_OAUTH_CLIENT_ID';
export const ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET = 'DIGITALOCEAN_OAUTH_CLIENT_SECRET';

/** `read write` — what creating, powering and destroying droplets needs. */
export const DIGITALOCEAN_OAUTH_SCOPES: readonly string[] = ['read', 'write'];

const TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;

function envValue(env: Env, key: string): string {
	const value = env[key];
	return typeof value === 'string' ? value.trim() : '';
}

/** True when the operator registered an application (both halves present). */
export function isDigitalOceanOAuthConfigured(env: Env = process.env): boolean {
	return envValue(env, ENV_DIGITALOCEAN_OAUTH_CLIENT_ID).length > 0 && envValue(env, ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET).length > 0;
}

function clientIdOf(config: Partial<OAuthConfig> | undefined, env: Env): string {
	const id = (config?.clientId ?? '').trim() || envValue(env, ENV_DIGITALOCEAN_OAUTH_CLIENT_ID);
	if (!id) {
		throw new MachineProviderError('unauthorized', `DigitalOcean sign-in is not configured: set ${ENV_DIGITALOCEAN_OAUTH_CLIENT_ID}`);
	}
	return id;
}

function clientSecretOf(config: Partial<OAuthConfig> | undefined, env: Env): string {
	const secret = (config?.clientSecret ?? '').trim() || envValue(env, ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET);
	if (!secret) {
		throw new MachineProviderError(
			'unauthorized',
			`DigitalOcean sign-in is not configured: set ${ENV_DIGITALOCEAN_OAUTH_CLIENT_SECRET}`
		);
	}
	return secret;
}

/** The provider's consent page for `state`, returning to `config.redirectUri`. */
export function digitalOceanAuthorizationUrl(
	state: string,
	config: Partial<OAuthConfig> | undefined,
	env: Env = process.env,
	base: string = DIGITALOCEAN_OAUTH_BASE
): string {
	const params = new URLSearchParams({
		client_id: clientIdOf(config, env),
		response_type: 'code',
		state,
		scope: (config?.scopes && config.scopes.length > 0 ? config.scopes : DIGITALOCEAN_OAUTH_SCOPES).join(' ')
	});
	if (config?.redirectUri) params.set('redirect_uri', config.redirectUri);
	if (config?.forceConsent) params.set('prompt', 'consent');
	return `${base}/v1/oauth/authorize?${params.toString()}`;
}

interface TokenAnswer {
	access_token?: unknown;
	token_type?: unknown;
	scope?: unknown;
	expires_in?: unknown;
	refresh_token?: unknown;
}

async function tokenRequest(
	form: Record<string, string>,
	fetchImpl: typeof fetch,
	base: string
): Promise<OAuthToken> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchImpl(`${base}/v1/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: new URLSearchParams(form).toString(),
			signal: controller.signal
		});
	} catch {
		throw new MachineProviderError('unavailable', 'DigitalOcean sign-in could not be reached');
	} finally {
		clearTimeout(timer);
	}
	let body: TokenAnswer | null = null;
	try {
		body = (await response.json()) as TokenAnswer;
	} catch {
		body = null;
	}
	if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
		// Never the body: it may echo the code or the client id.
		throw new MachineProviderError('unauthorized', `DigitalOcean refused the sign-in (HTTP ${response.status})`, response.status);
	}
	const token: { -readonly [K in keyof OAuthToken]: OAuthToken[K] } = {
		accessToken: body.access_token,
		tokenType: typeof body.token_type === 'string' && body.token_type ? body.token_type : 'bearer'
	};
	if (typeof body.scope === 'string') token.scope = body.scope;
	if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)) token.expiresIn = body.expires_in;
	if (typeof body.refresh_token === 'string' && body.refresh_token) token.refreshToken = body.refresh_token;
	return token;
}

/** Swap the callback's `code` for an access (and refresh) token. */
export async function exchangeDigitalOceanCode(
	code: string,
	config: Partial<OAuthConfig> | undefined,
	fetchImpl: typeof fetch = fetch,
	env: Env = process.env,
	base: string = DIGITALOCEAN_OAUTH_BASE
): Promise<OAuthToken> {
	if (typeof code !== 'string' || !code.trim()) {
		throw new MachineProviderError('invalid', 'DigitalOcean returned no sign-in code');
	}
	const form: Record<string, string> = {
		grant_type: 'authorization_code',
		code: code.trim(),
		client_id: clientIdOf(config, env),
		client_secret: clientSecretOf(config, env)
	};
	if (config?.redirectUri) form.redirect_uri = config.redirectUri;
	return tokenRequest(form, fetchImpl, base);
}

/** A fresh access token from a refresh token (the provider's tokens last 30 days). */
export async function refreshDigitalOceanToken(
	refreshToken: string,
	config: Partial<OAuthConfig> | undefined,
	fetchImpl: typeof fetch = fetch,
	env: Env = process.env,
	base: string = DIGITALOCEAN_OAUTH_BASE
): Promise<OAuthToken> {
	if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
		throw new MachineProviderError('invalid', 'no DigitalOcean refresh token');
	}
	return tokenRequest(
		{
			grant_type: 'refresh_token',
			refresh_token: refreshToken.trim(),
			client_id: clientIdOf(config, env),
			client_secret: clientSecretOf(config, env)
		},
		fetchImpl,
		base
	);
}
