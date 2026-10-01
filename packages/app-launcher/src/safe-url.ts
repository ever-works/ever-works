/**
 * The client-side address guard — the "belt and braces" re-check of plan §6.3,
 * run on every tile immediately before its tab opens.
 *
 * Spec: FR-30 (new tab, no opener, no referrer), FR-31 (nothing is ever added to
 * an opened address) and FR-32 (only `https`; `http://localhost` and
 * `http://127.0.0.1` additionally on a local development installation). The
 * acceptance criteria that read this module are ACC-11-08 and ACC-11-23.
 *
 * **The returned string is the input string.** `new URL('https://x.example')`
 * prints as `https://x.example/`, and ACC-11-23 says the opened address "equals
 * the stored address exactly — no added query, fragment or token". So the URL
 * parser is used to *judge* an address and the original value is what comes
 * back; nothing is normalised, canonicalised, trimmed or appended.
 */

/** How a host opts into FR-32's local-development half. */
export interface SafeUrlOptions {
	/**
	 * Accept `http://localhost` and `http://127.0.0.1` as well as `https`.
	 * Default `false`: outside a local development installation an `http`
	 * address is refused (FR-32).
	 */
	allowLocalhost?: boolean;
}

/**
 * The only two host names FR-32 names for a plain-`http` address. `[::1]` is
 * deliberately absent: the spec lists exactly `localhost` and `127.0.0.1`, and
 * a new module is the wrong place to widen a security allowance.
 */
const LOCAL_HTTP_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * The address to open for `value`, or `null` when nothing may be opened.
 *
 * Refused, in order:
 *  - anything that is not a string, or is empty;
 *  - a string padded with whitespace — accepting it would mean returning a
 *    string other than the registry's (ACC-11-23), so it fails closed instead;
 *  - anything the URL parser rejects (relative paths, protocol-relative
 *    addresses, bare hosts);
 *  - an address carrying credentials (`https://user:pass@host`), because FR-31
 *    and ACC-11-24 put every credential outside a launcher address;
 *  - any scheme other than `https`, including `javascript:`, `data:`, `blob:`
 *    and `file:`;
 *  - `http`, unless {@link SafeUrlOptions.allowLocalhost} is set **and** the
 *    host is exactly `localhost` or `127.0.0.1`.
 *
 * @param value the stored address (`AppLauncherItem.url`).
 * @param options the host's local-development allowance.
 * @returns the input string unchanged, or `null`.
 */
export function safeLauncherUrl(value: unknown, options: SafeUrlOptions = {}): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	if (value.trim() !== value) return null;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.username !== '' || url.password !== '') return null;
	if (url.protocol === 'https:') return value;
	if (url.protocol !== 'http:') return null;
	if (options.allowLocalhost !== true) return null;
	return LOCAL_HTTP_HOSTNAMES.includes(url.hostname) ? value : null;
}

/** Whether {@link safeLauncherUrl} would open `value`. */
export function isSafeLauncherUrl(value: unknown, options: SafeUrlOptions = {}): boolean {
	return safeLauncherUrl(value, options) !== null;
}
