/**
 * APW-05 T14 — can this installation READ the image, and is its pull token the
 * right shape?
 *
 * Two questions, and they are asked of two different hosts:
 *
 *  - **the registry** (`ghcr.io`) — a manifest `HEAD` for `sha-<sha>`, first
 *    anonymously and then with the token. Anonymous 200 means the package is
 *    public; anonymous 401/404 and authenticated 200 means private-but-readable;
 *    neither means not readable, which is `image_unresolvable` downstream;
 *  - **the API** (`api.github.com`) — `GET /user`, read only for its
 *    `x-oauth-scopes` header, which is the only way to tell a classic token's
 *    scopes without trying an operation and seeing what breaks.
 *
 * ## The token is sent to exactly two hosts, and the spec proves it
 *
 * `api.github.com` and `ghcr.io`. A pull token is a credential that can read
 * every private package an account can, so a redirect followed to a third host
 * with the `Authorization` header still attached is a credential leak. Every
 * request below is built from a literal base and `redirect: 'manual'`; nothing
 * takes a URL from a response.
 *
 * ## Why the scope check is `read:packages` EXACTLY, and why an absent header
 * ## is a refusal
 *
 * Broader is a refusal because a build pull token has one job, and a token that
 * can also `repo` is one leak away from being a write credential on every
 * repository the account can reach. Narrower cannot pull at all.
 *
 * A **missing** `x-oauth-scopes` header means a fine-grained personal access
 * token: GitHub does not report fine-grained permissions through that header, so
 * the shape cannot be verified at all — and "I could not check" is not "it is
 * fine". It is refused with its own code (`pullTokenFineGrained`) so the message
 * can tell the member to use a classic token rather than leaving them to guess
 * why a correct-looking token was rejected.
 */

/** GitHub's REST host. The only host the token's scopes are checked against. */
export const GITHUB_API_HOST = 'https://api.github.com';

/** GitHub's container registry. The only other host a token ever reaches. */
export const GHCR_HOST = 'https://ghcr.io';

/** The one scope a pull token may carry, exactly (plan §4.12). */
export const REQUIRED_PULL_TOKEN_SCOPE = 'read:packages';

/** The OCI manifest types a `HEAD` must accept for GHCR to answer at all. */
const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

/** Why a pull token was refused. */
export type PullTokenRefusal = 'pullTokenTooBroad' | 'pullTokenFineGrained' | 'pullTokenCannotRead';

/** What {@link checkPullToken} answers. */
export type PullTokenCheck =
	| {
			readonly ok: true;
			/** The token's expiry when GitHub reports one; `null` means "reported, and it does not expire". */
			readonly expiresAt: string | null;
	  }
	| { readonly ok: false; readonly refusal: PullTokenRefusal };

/** What {@link checkImageAccess} answers — the plugin's `ImageAccessResult`, plus nothing. */
export interface GhcrAccessResult {
	readonly visibility: 'public' | 'private' | 'unknown';
	readonly readable: boolean;
	readonly tokenScopesOk?: boolean;
	readonly tokenExpiresAt?: string | null;
	readonly digest?: string;
}

/** The one HTTP seam, so every rule here is provable without a socket. */
export type GhcrFetch = (
	url: string,
	init: { readonly method: string; readonly headers: Record<string, string>; readonly redirect: 'manual' }
) => Promise<{
	readonly status: number;
	readonly headers: { get(name: string): string | null };
}>;

/**
 * Check a pull token's shape through `GET /user`.
 *
 * Reads two headers and nothing else. The response BODY is never read: it
 * carries the account's profile, and this check has no business with it.
 */
export async function checkPullToken(token: string, fetchImpl: GhcrFetch): Promise<PullTokenCheck> {
	const response = await fetchImpl(`${GITHUB_API_HOST}/user`, {
		method: 'GET',
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28'
		},
		redirect: 'manual'
	});

	if (response.status === 401 || response.status === 403) {
		return { ok: false, refusal: 'pullTokenCannotRead' };
	}

	const raw = response.headers.get('x-oauth-scopes');
	if (raw === null) {
		// Fine-grained token: GitHub reports no scopes for one, so the shape
		// cannot be verified. "I could not check" is not "it is fine".
		return { ok: false, refusal: 'pullTokenFineGrained' };
	}

	const scopes = raw
		.split(',')
		.map((scope) => scope.trim())
		.filter((scope) => scope.length > 0);

	if (scopes.length !== 1 || scopes[0] !== REQUIRED_PULL_TOKEN_SCOPE) {
		// Broader is a leak waiting to happen; narrower cannot pull. Both are
		// `pullTokenTooBroad`'s code because the remedy is the same sentence:
		// issue a classic token with exactly `read:packages`.
		return { ok: false, refusal: 'pullTokenTooBroad' };
	}

	return { ok: true, expiresAt: response.headers.get('github-authentication-token-expiration') };
}

/** What {@link checkImageAccess} needs. */
export interface CheckImageAccessInput {
	/** `ghcr.io/<owner>/<repo>`, as the Build recorded it. */
	readonly imageRepository: string;
	/** The tag to look for — `sha-<sha>` for a Build. */
	readonly tag: string;
	/** The installation's pull token, when it has one. */
	readonly pullToken?: string;
}

/**
 * Can the image be read, and by whom?
 *
 * Anonymous first, always: a public package is readable by everyone and the
 * answer must not depend on whether a token happens to be configured. Only when
 * anonymous fails is the token tried, and only then is the token's shape
 * checked — a public image needs no token and reporting one as broken would be
 * noise.
 */
export async function checkImageAccess(input: CheckImageAccessInput, fetchImpl: GhcrFetch): Promise<GhcrAccessResult> {
	const path = manifestPath(input.imageRepository, input.tag);
	if (!path) {
		return { visibility: 'unknown', readable: false };
	}

	const anonymous = await fetchImpl(`${GHCR_HOST}${path}`, {
		method: 'HEAD',
		headers: { accept: MANIFEST_ACCEPT },
		redirect: 'manual'
	});

	if (anonymous.status === 200) {
		const digest = anonymous.headers.get('docker-content-digest');
		return {
			visibility: 'public',
			readable: true,
			...(digest ? { digest } : {})
		};
	}

	if (!input.pullToken) {
		// Not readable anonymously and no token to try: private as far as this
		// installation is concerned, and not readable. ACC-05-21.
		return { visibility: 'private', readable: false };
	}

	const tokenCheck = await checkPullToken(input.pullToken, fetchImpl);
	const authenticated = await fetchImpl(`${GHCR_HOST}${path}`, {
		method: 'HEAD',
		headers: { accept: MANIFEST_ACCEPT, authorization: `Bearer ${input.pullToken}` },
		redirect: 'manual'
	});

	const readable = authenticated.status === 200;
	const digest = readable ? authenticated.headers.get('docker-content-digest') : null;

	return {
		visibility: 'private',
		readable,
		tokenScopesOk: tokenCheck.ok,
		tokenExpiresAt: tokenCheck.ok ? tokenCheck.expiresAt : null,
		...(digest ? { digest } : {})
	};
}

/**
 * The registry path for one tag, or `null` when the repository is not a GHCR
 * reference this plugin wrote.
 *
 * Refusing an unfamiliar host is the point: `checkImageAccess` sends a
 * credential, and a repository string that names some other registry must never
 * cause one to be sent there. The caller gets `visibility: 'unknown'`, which is
 * the honest answer for an image this plugin cannot speak for.
 */
export function manifestPath(imageRepository: string, tag: string): string | null {
	const repository = (imageRepository ?? '').trim().toLowerCase();
	const reference = (tag ?? '').trim();
	if (repository.length === 0 || reference.length === 0) return null;

	const prefix = 'ghcr.io/';
	if (!repository.startsWith(prefix)) return null;

	const name = repository.slice(prefix.length);
	// `<owner>/<repo>` at least; GHCR allows deeper paths.
	if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/.test(name)) return null;
	if (!/^[A-Za-z0-9._-]+$/.test(reference)) return null;

	return `/v2/${name}/manifests/${reference}`;
}
