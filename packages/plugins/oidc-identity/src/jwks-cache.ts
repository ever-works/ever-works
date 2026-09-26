import type { IdentityTokenRejectionCode } from '@ever-works/plugin';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, errors } from 'jose';
import type { CryptoKey as JoseCryptoKey, JSONWebKeySet, JWSHeaderParameters, KeyObject } from 'jose';

import {
	OIDC_IDENTITY_SIGNING_ALGS,
	OIDC_JWKS_CACHE_SECONDS,
	OIDC_JWKS_MAX_STALE_SECONDS,
	OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS,
	OIDC_OUTBOUND_TIMEOUT_MS,
	OidcProviderUnavailableError,
	fetchJsonWithOneRetry,
	type OidcFetchImpl,
	type OidcOutboundFailure
} from './discovery.js';

/**
 * APW-12 T6 — the signing-key cache of the `identity-provider` capability.
 *
 * Spec FR-13, in its own words and in one place, because every number below is
 * one of its clauses:
 *
 *   - "Signing keys are cached for **600 seconds**";
 *   - "An unknown key ID triggers **at most one refresh per 30 seconds**";
 *   - "While Ever ID is unreachable, cached keys stay usable for at most
 *     **21,600 seconds** after the last successful refresh; after that,
 *     validation **fails closed**";
 *   - "A key Ever ID removes stops validating at the next successful refresh."
 *
 * FR-15 adds the shape of the fetch itself: 5,000 ms timeout, one retry after
 * 1,000 ms. Plan §4.3 is the same table; `EVER_ID_LIMITS.jwksCacheSeconds`,
 * `.jwksUnknownKidCooldownSeconds` and `.jwksMaxStaleSeconds` are the same numbers
 * in `packages/contracts/src/apps/ever-id.ts`, and
 * `src/__tests__/jwks-cache.spec.ts` reads that file off disk and asserts the two
 * agree (this package deliberately does not depend on `@ever-works/contracts` —
 * see `discovery.ts`).
 *
 * ## What is deliberately *not* here
 *
 * Claim validation. `iss`, `aud`, `azp`, `exp`, `iat`, `nonce` and the scope rules
 * of §4.3 belong to the methods that know which kind of token they were handed
 * (T7's `exchangeAuthorizationCode`, T8's `verifyAccessToken` /
 * `verifyLogoutToken`). This class answers one question — "is this signature good
 * under a key Ever ID published, and may we still trust the set we have?" — and
 * answers it with the three codes of the closed vocabulary those methods rethrow:
 * `badAlg`, `badSignature` and `providerUnavailable`.
 *
 * ## Why the ladder is implemented here rather than left to `jose`
 *
 * `jose`'s `createRemoteJWKSet` already defaults to a 600-second cache and a
 * 30-second cooldown, but it *keeps using a stale set indefinitely* when the
 * refetch fails — the opposite of FR-13's 21,600-second fail-closed end. It also
 * owns its own timer, which FR-15's 5,000 ms bound and a fake clock both need to
 * see. So the fetch, the clock and the ladder are ours, and `jose` does the two
 * things it is the dependency for: selecting a key from a JWK Set
 * (`createLocalJWKSet`) and verifying a compact JWS (`compactVerify`).
 */

/**
 * Every code this class can raise, taken from the contract's closed set.
 *
 * Typed as a subset of `IdentityTokenRejectionCode` on purpose: T7/T8 rethrow
 * these as `IdentityTokenRejectedError` with the same code, so a code invented
 * here would not compile.
 */
export type OidcJwksFailureCode = Extract<IdentityTokenRejectionCode, 'badAlg' | 'badSignature'>;

/**
 * The error a refused token raises (FR-11's signature and algorithm rules).
 *
 * `message` is the code and nothing else (FR-16). `providerUnavailable` is not
 * here because it is not about the token: {@link OidcProviderUnavailableError}
 * already carries it, with the reason that produced it.
 */
export class OidcJwksVerificationError extends Error {
	constructor(readonly code: OidcJwksFailureCode) {
		super(code);
		this.name = 'OidcJwksVerificationError';
	}
}

/** Construction options for {@link OidcJwksCache}. */
export interface OidcJwksCacheOptions {
	/** `jwks_uri` from the discovery document (FR-3's third endpoint check). */
	readonly jwksUri: string;
	/** The fetch seam, defaulting to the runtime `fetch` (see `discovery.ts`). */
	readonly fetchImpl?: OidcFetchImpl;
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** FR-15's 5,000 ms per attempt. */
	readonly timeoutMs?: number;
	/** FR-15's 1,000 ms before the single retry. */
	readonly retryDelayMs?: number;
	/** FR-13's 600 seconds. */
	readonly cacheSeconds?: number;
	/** FR-13's 30 seconds, applied to the unknown-`kid` refetch. */
	readonly unknownKidCooldownSeconds?: number;
	/** FR-13's 21,600 seconds: the point past which validation fails closed. */
	readonly maxStaleSeconds?: number;
	/** FR-11's algorithm allow-list; `none` and `HS*` are refused before any lookup. */
	readonly algorithms?: readonly string[];
	/**
	 * Called after every **successful** key fetch, with the epoch-ms instant.
	 *
	 * This is the in-process source of plan §4.2's `availability.jwksRefreshedAt`
	 * (plan §9.2's health view); T32 persists it, and the plugin owns the wiring.
	 */
	readonly onRefreshed?: (refreshedAt: number) => void;
}

/** What {@link OidcJwksCache.verify} answers: the header it verified and the claims it carried. */
export interface OidcJwksVerification {
	readonly header: JWSHeaderParameters;
	readonly payload: Record<string, unknown>;
	/** The `kid` the signature was verified with, when the token named one. */
	readonly kid: string | null;
}

/**
 * The cached signing keys, and the rules that decide when they may still be used
 * (FR-13).
 *
 * One instance per resolved `jwks_uri`. Everything is per-process by design: keys
 * are public material a provider republishes on demand, so a replica that has not
 * fetched yet fetches on first use rather than sharing cache state (contrast the
 * *availability* record, which plan §9.2 keeps in persisted settings precisely
 * because replicas must agree on it).
 */
export class OidcJwksCache {
	private jwks: JSONWebKeySet | null = null;
	private resolveKey: ((header?: JWSHeaderParameters, token?: never) => Promise<JoseCryptoKey>) | null = null;
	private refreshedAtMs: number | null = null;
	private lastAttemptAtMs: number | null = null;
	private lastUnknownKidRefreshAtMs: number | null = null;
	private lastFailure: OidcOutboundFailure | 'invalidDocument' | null = null;
	private availableKeyCount = 0;

	constructor(private readonly options: OidcJwksCacheOptions) {}

	/**
	 * When the last **successful** fetch happened, in epoch ms, or `null`.
	 *
	 * FR-13's staleness clock starts here: an attempt that failed does not move
	 * this value, which is exactly why cached keys survive a provider outage.
	 */
	get lastRefreshedAt(): number | null {
		return this.refreshedAtMs;
	}

	/** When the last fetch was **attempted**, successful or not, or `null`. */
	get lastAttemptAt(): number | null {
		return this.lastAttemptAtMs;
	}

	/** Why the last fetch failed, or `null` when the last one succeeded. */
	get lastFetchFailure(): OidcOutboundFailure | 'invalidDocument' | null {
		return this.lastFailure;
	}

	/** How many keys the cached set holds; `0` until the first successful fetch. */
	get keyCount(): number {
		return this.availableKeyCount;
	}

	/**
	 * Verify a compact JWS against the cached key set, and answer its claims.
	 *
	 * The order is the plan §4.3 order and each step is load-bearing:
	 *
	 *   1. the protected header must parse (a truncated token is `badSignature`);
	 *   2. `alg` must be one of FR-11's three — `none` and `HS256` are refused
	 *      **before** any key lookup, so a token can never talk us into treating a
	 *      public key as a shared secret;
	 *   3. the key comes from the cache, refreshing once under FR-13's rules;
	 *   4. `compactVerify` checks the signature, with the same allow-list handed to
	 *      it so the two can never disagree.
	 *
	 * Claim rules are the caller's (see the class docstring).
	 */
	async verify(token: string): Promise<OidcJwksVerification> {
		const header = decodeProtectedHeaderOrNull(token);
		if (header === null) throw new OidcJwksVerificationError('badSignature');

		const algorithms = this.algorithms();
		const alg = header.alg;
		if (typeof alg !== 'string' || !algorithms.includes(alg)) {
			// FR-11 / §4.3: `none` and `HS*` never reach a key lookup.
			throw new OidcJwksVerificationError('badAlg');
		}

		const key = await this.resolveSigningKey(header, token);
		try {
			const { payload } = await compactVerify(token, key, { algorithms: [...algorithms] });
			return {
				header,
				payload: JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
				kid: typeof header.kid === 'string' ? header.kid : null
			};
		} catch {
			// jose's own error text is never propagated (FR-16); every failure to
			// verify is one code.
			throw new OidcJwksVerificationError('badSignature');
		}
	}

	/**
	 * The key for a token's header, refreshing at most once when the `kid` is unknown
	 * (FR-13).
	 *
	 * A `kid` nobody published cannot be served from the cache, and the two ways out
	 * are ranked: refresh if FR-13's cooldown allows it, and otherwise refuse. A
	 * refusal is `badSignature` — never `providerUnavailable` — while the cached set
	 * is still inside its 21,600 seconds, because the set *is* trustworthy and the
	 * token is simply not signed by anything in it.
	 */
	async resolveSigningKey(
		header: JWSHeaderParameters,
		token: string
	): Promise<JoseCryptoKey | KeyObject | Uint8Array> {
		await this.ensureUsableKeySet();

		const direct = await this.findKey(header, token);
		if (direct !== null) return direct;

		if (this.canRefreshForUnknownKid()) {
			this.lastUnknownKidRefreshAtMs = this.now();
			const refreshed = await this.refresh();
			if (refreshed) {
				const afterRefresh = await this.findKey(header, token);
				if (afterRefresh !== null) return afterRefresh;
			}
		}

		// Nothing matched. `assertTrusted` first, so a set that has aged past
		// FR-13's 21,600 seconds reports "the provider is unusable" rather than "your
		// token is bad" — the two send an operator to different places.
		this.assertTrusted();
		throw new OidcJwksVerificationError('badSignature');
	}

	/**
	 * Fetch the key set now, replacing the cache **only** on success.
	 *
	 * Answers whether a usable set is in place afterwards. A failed fetch leaves the
	 * previous set exactly as it was, which is what FR-13's 21,600-second window
	 * describes; it never clears the cache and it never throws to a caller that has a
	 * token to refuse.
	 */
	async refresh(): Promise<boolean> {
		this.lastAttemptAtMs = this.now();
		const result = await fetchJsonWithOneRetry(
			{ url: this.options.jwksUri },
			{
				fetchImpl: this.options.fetchImpl,
				now: this.options.now,
				timeoutMs: this.options.timeoutMs ?? OIDC_OUTBOUND_TIMEOUT_MS,
				retryDelayMs: this.options.retryDelayMs
			}
		);
		if (!result.ok) {
			this.lastFailure = result.failure ?? 'network';
			return false;
		}

		const jwks = asJwks(result.body);
		if (jwks === null) {
			this.lastFailure = 'invalidDocument';
			return false;
		}

		this.jwks = jwks;
		// Key selection is jose's: it matches JWK `kid` against the header, honours
		// `use`/`key_ops`, and throws rather than guessing when several keys match.
		this.resolveKey = createLocalJWKSet(jwks);
		this.refreshedAtMs = this.now();
		this.availableKeyCount = jwks.keys.length;
		this.lastFailure = null;
		this.options.onRefreshed?.(this.refreshedAtMs);
		return true;
	}

	/**
	 * Make sure the cache is fresh enough to answer from (FR-13's 600 seconds).
	 *
	 * An expired cache is refreshed; a cache that cannot be refreshed stays usable
	 * while {@link assertTrusted} allows it, and throws `providerUnavailable` once it
	 * does not.
	 */
	private async ensureUsableKeySet(): Promise<void> {
		if (this.jwks !== null && this.isCacheFresh()) return;
		// The 600-second expiry is its own rate limit, so this refresh is not subject
		// to the unknown-`kid` cooldown: it can fire at most once per cache period.
		await this.refresh();
		this.assertTrusted();
	}

	/** FR-13's 600 seconds: `age < cacheSeconds`. */
	private isCacheFresh(): boolean {
		if (this.refreshedAtMs === null) return false;
		return this.now() - this.refreshedAtMs < this.cacheSeconds() * 1_000;
	}

	/**
	 * FR-13's 21,600 seconds, and the fail-closed end of the ladder.
	 *
	 * Two distinct refusals, because they are two distinct operational facts: no key
	 * set has ever been fetched (`keysUnavailable` — usually a provider that has
	 * never answered), or the last good fetch is older than plan §4.3's window
	 * (`keysStale` — plan §9.2's "JWKS stale beyond 21,600 s: every validation fails
	 * closed").
	 */
	private assertTrusted(): void {
		if (this.jwks === null || this.refreshedAtMs === null) {
			throw new OidcProviderUnavailableError('keysUnavailable');
		}
		if (this.now() - this.refreshedAtMs > this.maxStaleSeconds() * 1_000) {
			throw new OidcProviderUnavailableError('keysStale');
		}
	}

	/**
	 * FR-13's "at most one refresh per 30 seconds" for an unknown key id.
	 *
	 * Read as the rule it protects: the unknown-`kid` refetch is the one an attacker
	 * can trigger at will by presenting a token with a made-up `kid`, so that trigger
	 * is the one the cooldown bounds. A *successful* cache refresh is not counted
	 * against it, because the 600-second cache already bounds those — counting them
	 * would refuse the first token signed by a freshly rotated key for up to 30
	 * seconds after any refresh, which is the opposite of ACC-12-08 ("a token signed
	 * with a newly rotated key validates after one key refresh").
	 */
	private canRefreshForUnknownKid(): boolean {
		if (this.lastUnknownKidRefreshAtMs === null) return true;
		return this.now() - this.lastUnknownKidRefreshAtMs >= this.unknownKidCooldownSeconds() * 1_000;
	}

	/**
	 * Ask jose for the key matching a header, or `null` when nothing matches.
	 *
	 * `JWKSNoMatchingKey` is the expected "unknown kid" answer and becomes `null` so
	 * the caller can try FR-13's one refresh. Every other jose failure — a malformed
	 * set, several keys matching one header — is a refusal, and none of them ever
	 * surfaces with jose's message attached (FR-16).
	 */
	private async findKey(header: JWSHeaderParameters, token: string): Promise<JoseCryptoKey | null> {
		const resolve = this.resolveKey;
		if (resolve === null) return null;
		try {
			return await resolve(header, token as unknown as never);
		} catch (error) {
			if (error instanceof errors.JWKSNoMatchingKey) return null;
			throw new OidcJwksVerificationError('badSignature');
		}
	}

	private algorithms(): readonly string[] {
		return this.options.algorithms ?? OIDC_IDENTITY_SIGNING_ALGS;
	}

	private cacheSeconds(): number {
		return this.options.cacheSeconds ?? OIDC_JWKS_CACHE_SECONDS;
	}

	private maxStaleSeconds(): number {
		return this.options.maxStaleSeconds ?? OIDC_JWKS_MAX_STALE_SECONDS;
	}

	private unknownKidCooldownSeconds(): number {
		return this.options.unknownKidCooldownSeconds ?? OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

/** The protected header, or `null` when the token is not a compact JWS at all. */
function decodeProtectedHeaderOrNull(token: string): JWSHeaderParameters | null {
	try {
		return decodeProtectedHeader(token);
	} catch {
		return null;
	}
}

/**
 * A JWK Set, or `null`.
 *
 * `keys` must be an array — an empty one **is** a valid set (that is what "Ever ID
 * removed the key" looks like at the extreme), while a missing or non-array `keys`
 * is a body that is not a key set at all, and treating it as one would clear a
 * good cache on the strength of a proxy's error page.
 */
function asJwks(value: unknown): JSONWebKeySet | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const keys = (value as { keys?: unknown }).keys;
	if (!Array.isArray(keys)) return null;
	return value as JSONWebKeySet;
}
