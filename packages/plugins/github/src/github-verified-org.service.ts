/**
 * Verified-org membership check for GitHub PR authors.
 *
 * Implements the author half of C-11 in the 2026-05-17 security audit
 * (`docs/specs/security/audits/2026-05-17-ever-works-platform-security-audit.md`).
 *
 * When `COMMUNITY_PR_VERIFIED_ORGS` is set (comma-separated org logins,
 * e.g. `ever-works,ever-co`), the community-PR pipeline only auto-applies
 * PRs whose author is a verified member of at least one of those orgs.
 * This service fronts the GitHub `GET /orgs/{org}/members/{username}`
 * endpoint with a short-TTL in-memory cache so that processing a batch
 * of PRs from the same author does not hit the rate limit.
 *
 * Defensive policy:
 *   - 204 from any configured org    -> orgVerified = true
 *   - 404 from a configured org      -> not a member of that org, keep going
 *   - 429 / 5xx from a configured org-> "couldn't verify"; do NOT set
 *                                       orgVerified = true. Log a warning.
 *   - env unset / no orgs configured -> orgVerified = false (or undefined)
 *
 * The cache is keyed by `${baseUrl}|${username}` so a token rotation
 * (which doesn't change the API base URL) does not leak verifications
 * across separate request lifecycles past the TTL.
 */

import { Octokit, RequestError } from 'octokit';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — small enough to refresh

interface CacheEntry {
	readonly orgVerified: boolean;
	readonly expiresAt: number;
}

/**
 * Parse the `COMMUNITY_PR_VERIFIED_ORGS` env var into a list of org
 * logins. Lower-cased, trimmed, de-duplicated. Empty list when unset.
 */
export function parseVerifiedOrgs(envVal: string | undefined): string[] {
	if (!envVal) return [];
	const set = new Set<string>();
	for (const raw of envVal.split(',')) {
		const v = raw.trim().toLowerCase();
		if (v) set.add(v);
	}
	return [...set];
}

export interface GitHubVerifiedOrgServiceOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
	readonly logger?: {
		readonly warn: (msg: string) => void;
		readonly debug?: (msg: string) => void;
	};
	/**
	 * Octokit factory. Override for tests so unit tests don't need a
	 * real GitHub API server.
	 */
	readonly createOctokit?: (token: string, baseUrl?: string) => Pick<Octokit, 'rest'>;
}

export class GitHubVerifiedOrgService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly logger: NonNullable<GitHubVerifiedOrgServiceOptions['logger']>;
	private readonly createOctokit: (token: string, baseUrl?: string) => Pick<Octokit, 'rest'>;

	constructor(options: GitHubVerifiedOrgServiceOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxEntries = options.maxEntries ?? 1024;
		this.now = options.now ?? (() => Date.now());
		this.logger = options.logger ?? {
			warn: (msg) => console.warn(`[github-verified-org] ${msg}`)
		};
		this.createOctokit =
			options.createOctokit ??
			((token, baseUrl) =>
				new Octokit({
					...(token ? { auth: token } : {}),
					baseUrl: baseUrl || 'https://api.github.com'
				}));
	}

	/**
	 * Returns `true` iff the user is a verified member of at least one
	 * of `verifiedOrgs`. Treats 429 / network errors as "couldn't
	 * verify" → false. Caches the result for `ttlMs`.
	 *
	 * Callers must pass a non-empty `verifiedOrgs`. With an empty list
	 * the answer is unambiguously `false` — the check is disabled.
	 */
	async isVerifiedMember(params: {
		username: string;
		token: string;
		baseUrl?: string;
		verifiedOrgs: readonly string[];
	}): Promise<boolean> {
		if (!params.username || params.verifiedOrgs.length === 0) {
			return false;
		}

		const cacheKey = `${params.baseUrl ?? 'https://api.github.com'}|${params.username}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > this.now()) {
			return cached.orgVerified;
		}

		const octokit = this.createOctokit(params.token, params.baseUrl);

		let verified = false;
		for (const org of params.verifiedOrgs) {
			try {
				const response = await octokit.rest.orgs.checkMembershipForUser({
					org,
					username: params.username
				});
				// Octokit's typed return narrows `status` to the success
				// codes — 204 (caller is a member, target is a member) or
				// 302 (target is a non-public member; redirect points to
				// the public-members endpoint). Either way the user IS a
				// member of `org`, so anything we receive here counts as
				// verified. (404 / 429 / 5xx are thrown by Octokit and
				// handled in the catch block.)
				const status = response.status as number;
				if (status === 204 || status === 302) {
					verified = true;
					break;
				}
			} catch (err) {
				if (err instanceof RequestError) {
					if (err.status === 404) {
						// Not a member of this org. Keep going.
						continue;
					}
					if (err.status === 429 || err.status >= 500) {
						// Rate-limited or upstream broken — be defensive
						// and do NOT mark verified. Log and stop iterating
						// (further calls will likely hit the same fence).
						this.logger.warn(
							`Could not verify GitHub org membership for "${params.username}" in "${org}" (status ${err.status}); treating as untrusted.`
						);
						this.setCache(cacheKey, false);
						return false;
					}
					// Any other status (401/403/etc) — couldn't verify,
					// fall through to "untrusted".
					this.logger.warn(
						`Unexpected status ${err.status} verifying GitHub org membership for "${params.username}" in "${org}"; treating as untrusted.`
					);
					this.setCache(cacheKey, false);
					return false;
				}
				// Non-HTTP error (network, parse, etc).
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.warn(
					`Failed to verify GitHub org membership for "${params.username}" in "${org}": ${msg}; treating as untrusted.`
				);
				this.setCache(cacheKey, false);
				return false;
			}
		}

		this.setCache(cacheKey, verified);
		return verified;
	}

	private setCache(key: string, orgVerified: boolean): void {
		if (this.cache.size >= this.maxEntries) {
			// Simple LRU-ish eviction: drop the oldest insertion.
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, {
			orgVerified,
			expiresAt: this.now() + this.ttlMs
		});
	}

	/**
	 * Test/utility hook — drop all cached verifications.
	 */
	clearCache(): void {
		this.cache.clear();
	}
}
