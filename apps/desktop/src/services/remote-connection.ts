import type { RemoteConnection, RemoteConnectionInput, RemoteProbeResult } from '../shared/ipc-contract';

/**
 * Client mode: resolving and probing a REMOTE Ever Works instance.
 *
 * The desktop shell can either run its own stack (`local-stack`) or act as a
 * native client onto an instance that already runs somewhere else
 * (`remote-client`). Everything in this module is pure/injected so the URL
 * resolution rules and the reachability probe are unit-testable without a
 * network or an Electron runtime.
 */

/** Health endpoint the probe hits, relative to the resolved API base URL. */
export const REMOTE_HEALTH_PATH = '/api/health';

/** Loopback hostnames for which plain `http://` is not flagged as insecure. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export interface ResolvedRemoteConnection {
	ok: true;
	connection: RemoteConnection;
	/** Non-blocking advisories (e.g. plain HTTP to a non-loopback host). */
	warnings: string[];
}

export interface RejectedRemoteConnection {
	ok: false;
	errors: string[];
}

export type RemoteResolution = ResolvedRemoteConnection | RejectedRemoteConnection;

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, '');
}

/**
 * Normalize a user-typed instance URL: trims whitespace, tolerates a missing
 * scheme (assumes `https://`), rejects non-HTTP schemes, and drops trailing
 * slashes so joins stay predictable. Returns `undefined` when unusable.
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
	const trimmed = (raw ?? '').trim();
	if (trimmed === '') {
		return undefined;
	}
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}
	if (url.hostname === '') {
		return undefined;
	}
	// Credentials in the URL would end up persisted in the desktop config file
	// and echoed into logs — refuse them outright rather than silently strip.
	if (url.username !== '' || url.password !== '') {
		return undefined;
	}
	url.hash = '';
	url.search = '';
	return stripTrailingSlashes(url.toString());
}

/**
 * Best-effort API base URL for an instance whose web URL is known.
 *
 * Ever Works deployments front the web app on `app.<domain>` and the API on
 * `api.<domain>`; everything else (self-hosted single-origin installs, local
 * ports) is assumed to serve the API from the same base URL. Always shown to
 * the user as an editable field — this is a default, not a constraint.
 */
export function deriveApiUrl(webUrl: string): string | undefined {
	const normalized = normalizeBaseUrl(webUrl);
	if (!normalized) {
		return undefined;
	}
	const url = new URL(normalized);
	if (url.hostname.startsWith('app.') && url.hostname.length > 'app.'.length) {
		url.hostname = `api.${url.hostname.slice('app.'.length)}`;
		return stripTrailingSlashes(url.toString());
	}
	return stripTrailingSlashes(normalized);
}

/** True when the URL sends traffic in the clear to something that is not loopback. */
export function isInsecureRemote(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname);
	} catch {
		return false;
	}
}

/**
 * Validate + normalize a remote connection the user typed into the wizard.
 * Resolution order for the API URL: explicit value → derived from the web URL.
 */
export function resolveRemoteConnection(input: RemoteConnectionInput | undefined): RemoteResolution {
	const errors: string[] = [];

	const webUrl = normalizeBaseUrl(input?.webUrl);
	if (!webUrl) {
		errors.push('Enter the instance URL, e.g. https://app.example.com (http/https only, no credentials).');
	}

	const apiCandidate = (input?.apiUrl ?? '').trim();
	let apiUrl: string | undefined;
	if (apiCandidate !== '') {
		apiUrl = normalizeBaseUrl(apiCandidate);
		if (!apiUrl) {
			errors.push('The API URL is not a valid http/https URL.');
		}
	} else if (webUrl) {
		apiUrl = deriveApiUrl(webUrl);
	}

	if (errors.length > 0 || !webUrl || !apiUrl) {
		return { ok: false, errors: errors.length > 0 ? errors : ['Could not resolve the remote instance URLs.'] };
	}

	const warnings: string[] = [];
	if (isInsecureRemote(webUrl) || isInsecureRemote(apiUrl)) {
		warnings.push(
			'This instance is reached over plain HTTP — session cookies and API traffic are not encrypted in transit.'
		);
	}

	const label = (input?.label ?? '').trim();
	const connection: RemoteConnection = { webUrl, apiUrl };
	if (label !== '') {
		connection.label = label;
	}
	return { ok: true, connection, warnings };
}

/** Minimal fetch shape the probe needs (injected so tests stay offline). */
export type ProbeFetch = (url: string) => Promise<{
	ok: boolean;
	status: number;
	json?: () => Promise<unknown>;
}>;

function readVersion(payload: unknown): string | undefined {
	if (typeof payload !== 'object' || payload === null) {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	const candidate = record.version ?? record.sha ?? record.build;
	return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
}

/** Build the health URL for a resolved connection. */
export function remoteHealthUrl(connection: RemoteConnection): string {
	return `${stripTrailingSlashes(connection.apiUrl)}${REMOTE_HEALTH_PATH}`;
}

/**
 * Probe a remote instance's health endpoint. Never throws: transport failures
 * come back as `{ ok: false, message }` so the wizard can render them.
 */
export async function probeRemote(connection: RemoteConnection, fetchFn: ProbeFetch): Promise<RemoteProbeResult> {
	const url = remoteHealthUrl(connection);
	try {
		const response = await fetchFn(url);
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				message: `${url} responded with HTTP ${response.status}.`
			};
		}
		let version: string | undefined;
		if (response.json) {
			try {
				version = readVersion(await response.json());
			} catch {
				version = undefined;
			}
		}
		const result: RemoteProbeResult = { ok: true, status: response.status };
		if (version !== undefined) {
			result.version = version;
		}
		return result;
	} catch (error) {
		return { ok: false, message: `Could not reach ${url}: ${(error as Error).message}` };
	}
}

/**
 * Origins the main window may navigate to for a given mode. Local mode keeps
 * the two supervised service origins; client mode swaps in the remote
 * instance's web + API origins so external links still open in the OS browser.
 */
export function allowedOriginsFor(connection: RemoteConnection | undefined, localOrigins: string[]): string[] {
	if (!connection) {
		return [...localOrigins];
	}
	const origins = new Set<string>();
	for (const candidate of [connection.webUrl, connection.apiUrl]) {
		try {
			origins.add(new URL(candidate).origin);
		} catch {
			// Ignore unparseable persisted values — navigation simply stays blocked.
		}
	}
	return [...origins];
}
