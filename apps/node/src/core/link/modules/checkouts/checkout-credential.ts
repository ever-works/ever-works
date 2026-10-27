import {
	FLEET_PUSH_CREDENTIAL_REVOKE_URL,
	FLEET_PUSH_CREDENTIAL_USERNAME,
	fleetPushRemoteRepositoryId,
	isFleetCheckoutCredentialAccess,
	type FleetCheckoutCredentialAccess,
	type FleetCheckoutCredentialResponse
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14, spec FR-17, FR-22, S4) — the operation-scoped
 * git credential a checkout Ever Works created uses for clone, fetch, pull and
 * push. Never the machine's own credential helper (U8), and never on a
 * `discovered` checkout (FR-23: that is the owner's clone, run as their
 * terminal would).
 *
 * The posture is the Task pool's push credential's, unchanged:
 *
 *  - minted by the platform per operation (`POST /api/fleet/checkouts/:id/
 *    credential`, node-authenticated), narrowed to ONE repository;
 *  - the remote is checked to name exactly that repository on github.com
 *    before the token is used (the host-aware lesson of the push scope);
 *  - it reaches git ONLY through the child's environment
 *    (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`):
 *    never argv, never a config file, never the remote URL — and with every
 *    other credential source switched off for that child (`credential.helper`,
 *    `core.askpass`, hooks, `GIT_ASKPASS`, `SSH_ASKPASS`,
 *    `GIT_CONFIG_PARAMETERS`);
 *  - revoked at GitHub the moment the operation ends.
 */

export interface CheckoutCredentialClient {
	mint(
		checkoutId: string,
		access: FleetCheckoutCredentialAccess,
		signal?: AbortSignal
	): Promise<FleetCheckoutCredentialResponse>;
	revoke(token: string): Promise<void>;
}

export type CheckoutCredentialFetch = (
	input: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class CheckoutCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CheckoutCredentialError';
	}
}

/** Inherited variables a credentialed git child must never see. */
export const CHECKOUT_CREDENTIAL_UNSET_ENV: readonly string[] = ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_PARAMETERS'];

/** Bound on the mint and the revoke. */
const CREDENTIAL_TIMEOUT_MS = 15_000;

/**
 * `url` without its trailing `/`s, by a scan from the end. `/\/+$/` is
 * quadratic on a long run of slashes that does not end the string (CodeQL #284).
 */
export function withoutTrailingSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end -= 1;
	return url.slice(0, end);
}

/** The node-authenticated client over the platform's credential route. */
export function createCheckoutCredentialClient(options: {
	apiUrl: string;
	nodeId: string;
	secret: string;
	fetchFn: CheckoutCredentialFetch;
	userAgent?: string;
	/** Register the token with the node's redacting logger; called once per mint. */
	protect?: (token: string) => void;
	unprotect?: (token: string) => void;
}): CheckoutCredentialClient {
	const base = withoutTrailingSlashes(options.apiUrl);
	return {
		async mint(checkoutId, access, signal) {
			const timeout = AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS);
			const response = await options.fetchFn(
				`${base}/api/fleet/checkouts/${encodeURIComponent(checkoutId)}/credential`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
						'User-Agent': options.userAgent ?? 'ever-works-node'
					},
					body: JSON.stringify({ nodeId: options.nodeId, secret: options.secret, access }),
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout
				}
			);
			if (!response.ok) {
				let reason = `the platform refused a credential (${response.status})`;
				try {
					const body = (await response.json()) as { reason?: unknown };
					if (typeof body?.reason === 'string') reason = body.reason;
				} catch {
					// keep the status-only reason
				}
				throw new CheckoutCredentialError(reason);
			}
			const body = (await response.json()) as Partial<FleetCheckoutCredentialResponse> | null;
			if (
				!body ||
				typeof body.token !== 'string' ||
				!body.token ||
				typeof body.repository !== 'string' ||
				!isFleetCheckoutCredentialAccess(body.access)
			) {
				throw new CheckoutCredentialError('the platform answered a credential this node cannot read');
			}
			options.protect?.(body.token);
			return {
				token: body.token,
				username:
					typeof body.username === 'string' && body.username ? body.username : FLEET_PUSH_CREDENTIAL_USERNAME,
				expiresAt:
					typeof body.expiresAt === 'string'
						? body.expiresAt
						: new Date(Date.now() + 55 * 60_000).toISOString(),
				repository: body.repository,
				access: body.access
			};
		},
		async revoke(token) {
			try {
				await options.fetchFn(FLEET_PUSH_CREDENTIAL_REVOKE_URL, {
					method: 'DELETE',
					headers: {
						Accept: 'application/vnd.github+json',
						Authorization: `Bearer ${token}`,
						'User-Agent': options.userAgent ?? 'ever-works-node',
						'X-GitHub-Api-Version': '2022-11-28'
					},
					signal: AbortSignal.timeout(5_000)
				});
			} catch {
				// Best-effort: the token still expires on GitHub's clock, within the hour.
			} finally {
				options.unprotect?.(token);
			}
		}
	};
}

/**
 * Refuse unless the remote names exactly the repository the token covers, on
 * github.com over https (`fleetPushRemoteRepositoryId` is host-checked).
 */
export function assertCredentialCovers(
	remoteUrl: string,
	credential: Pick<FleetCheckoutCredentialResponse, 'repository'>
): void {
	const repositoryId = fleetPushRemoteRepositoryId(remoteUrl);
	if (!repositoryId) {
		throw new CheckoutCredentialError(
			'this checkout’s remote is not an https GitHub repository URL, so a scoped credential cannot authenticate it'
		);
	}
	if (repositoryId.toLowerCase() !== credential.repository.toLowerCase()) {
		throw new CheckoutCredentialError(`the scoped credential covers ${credential.repository}, not ${repositoryId}`);
	}
}

/**
 * The environment entries that hand git the credential for ONE command, keyed
 * to the exact remote URL, appended after whatever `GIT_CONFIG_COUNT` the
 * process inherited (so an operator's pinned entries keep working and ours are
 * the last word).
 */
export function checkoutCredentialEnv(
	credential: Pick<FleetCheckoutCredentialResponse, 'token' | 'username'>,
	remoteUrl: string,
	inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	const basic = Buffer.from(`${credential.username}:${credential.token}`, 'utf8').toString('base64');
	const parsed = Number.parseInt(String(inherited.GIT_CONFIG_COUNT ?? ''), 10);
	const base = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
	return {
		GIT_CONFIG_COUNT: String(base + 4),
		[`GIT_CONFIG_KEY_${base}`]: 'credential.helper',
		[`GIT_CONFIG_VALUE_${base}`]: '',
		[`GIT_CONFIG_KEY_${base + 1}`]: 'core.askpass',
		[`GIT_CONFIG_VALUE_${base + 1}`]: '',
		[`GIT_CONFIG_KEY_${base + 2}`]: 'core.hooksPath',
		[`GIT_CONFIG_VALUE_${base + 2}`]: '',
		[`GIT_CONFIG_KEY_${base + 3}`]: `http.${remoteUrl}.extraheader`,
		[`GIT_CONFIG_VALUE_${base + 3}`]: `Authorization: Basic ${basic}`
	};
}

/**
 * The environment for an ANONYMOUS network command on a checkout Ever Works
 * made of a public repository: every credential source off (helper, askpass,
 * hooks), no token — so the machine's own login is never offered (spec U8).
 */
export function anonymousGitEnv(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const parsed = Number.parseInt(String(inherited.GIT_CONFIG_COUNT ?? ''), 10);
	const base = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
	return {
		GIT_CONFIG_COUNT: String(base + 3),
		[`GIT_CONFIG_KEY_${base}`]: 'credential.helper',
		[`GIT_CONFIG_VALUE_${base}`]: '',
		[`GIT_CONFIG_KEY_${base + 1}`]: 'core.askpass',
		[`GIT_CONFIG_VALUE_${base + 1}`]: '',
		[`GIT_CONFIG_KEY_${base + 2}`]: 'core.hooksPath',
		[`GIT_CONFIG_VALUE_${base + 2}`]: ''
	};
}

/**
 * Run `body` with a freshly minted credential for one checkout operation and
 * revoke it afterwards, whatever happened. The token never leaves this
 * closure except as the child environment `body` is handed.
 */
export async function withCheckoutCredential<T>(
	client: CheckoutCredentialClient,
	input: { checkoutId: string; access: FleetCheckoutCredentialAccess; remoteUrl: string; signal?: AbortSignal },
	body: (env: Record<string, string>) => Promise<T>
): Promise<T> {
	const credential = await client.mint(input.checkoutId, input.access, input.signal);
	try {
		assertCredentialCovers(input.remoteUrl, credential);
		return await body(checkoutCredentialEnv(credential, input.remoteUrl));
	} finally {
		await client.revoke(credential.token);
	}
}
