import { readFileSync } from 'node:fs';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	OIDC_JWKS_CACHE_SECONDS,
	OIDC_JWKS_MAX_STALE_SECONDS,
	OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS,
	type OidcFetchImpl,
	type OidcHttpResponse
} from '../discovery.js';
import { OidcJwksCache } from '../jwks-cache.js';

/**
 * APW-12 T6 — the signing-key cache against **FR-13** and **ACC-12-08**:
 *
 *   - the key set is cached for **600 s**;
 *   - an unknown `kid` triggers **one** refetch, with a **30 s** cooldown;
 *   - cached keys stay usable for at most **21,600 s** after the last successful
 *     refresh, and beyond that validation **fails closed**;
 *   - a **rotated** key validates after one refresh; a **removed** key is refused
 *     after the next;
 *   - **FR-15**: a 5,000 ms timeout and **one** retry after 1,000 ms.
 *
 * ## The clock
 *
 * Every number above is driven by vitest's fake timers, never by waiting:
 * `vi.setSystemTime` moves the injected-or-default clock (`OidcJwksCacheOptions.now`,
 * a T6 addition whose production default is `Date.now`) and
 * `vi.advanceTimersByTimeAsync` fires the abort timer inside `discovery.ts`, which
 * is a `setTimeout` precisely so a fake clock can drive it. A spec that really
 * waited 21,600 seconds would not be a spec.
 *
 * ## Keys are real keys
 *
 * The tokens here are signed by `jose` with freshly generated ES256 key pairs, and
 * the JWKS documents are `exportJWK` output. Nothing stubs `compactVerify`: the
 * claims this file makes are about *signature verification* under a cached key set,
 * so a fake signature layer would prove nothing about the rotation and removal
 * behaviour ACC-12-08 is about.
 */

const BASE_TIME = Date.parse('2026-09-17T09:00:00.000Z');

/**
 * FR-13's and FR-15's numbers, written as literals rather than read from the module.
 *
 * A behavioural test that moves the clock by the very constant it is meant to pin follows
 * a perturbation of that constant instead of catching it (measured: with
 * `OIDC_JWKS_CACHE_SECONDS` mutated to 6,000, only the transcribed-numbers check at the
 * end of this file reddened). The exported constants are pinned there; the cases here
 * assert the behaviour against FR-13's own words.
 */
const FR13_CACHE_MS = 600_000;
const FR13_COOLDOWN_MS = 30_000;
const FR13_MAX_STALE_MS = 21_600_000;
const FR15_TIMEOUT_MS = 5_000;
const FR15_RETRY_DELAY_MS = 1_000;
const JWKS_URI = 'https://auth.ever.co/oauth/v2/keys';

interface TestKey {
	readonly kid: string;
	readonly jwk: JWK;
	readonly privateKey: CryptoKey;
}

/** A real ES256 key pair, published the way a provider publishes it. */
const makeKey = async (kid: string): Promise<TestKey> => {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = await exportJWK(publicKey);
	return { kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, privateKey };
};

/** A token signed by one of the keys above. */
const signWith = (key: TestKey, claims: Record<string, unknown> = { sub: 'subject-1' }): Promise<string> =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: 'ES256', kid: key.kid })
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(key.privateKey);

/** A key set that was published, then changed the way a provider changes it. */
interface FakeJwks {
	keys: JWK[];
	readonly requests: number[];
	readonly fetch: OidcFetchImpl;
	mode: 'ok' | 'reject' | 'http500' | 'hang' | 'invalid' | 'noKeys';
}

const fakeJwks = (keys: JWK[] = [], mode: FakeJwks['mode'] = 'ok'): FakeJwks => {
	const server: FakeJwks = {
		keys,
		requests: [],
		mode,
		fetch: async (_url, init): Promise<OidcHttpResponse> => {
			server.requests.push(Date.now());
			switch (server.mode) {
				case 'reject':
					throw new Error('connect ECONNREFUSED (transport)');
				case 'http500':
					return { ok: false, status: 500, json: async () => ({}) };
				case 'hang':
					return new Promise<OidcHttpResponse>((_resolve, reject) => {
						init.signal.addEventListener('abort', () =>
							reject(new DOMException('The operation was aborted.', 'AbortError'))
						);
					});
				case 'invalid':
					return { ok: true, status: 200, json: async () => ({ not: 'a key set' }) };
				case 'noKeys':
					return { ok: true, status: 200, json: async () => ({ keys: [] }) };
				default:
					return { ok: true, status: 200, json: async () => ({ keys: server.keys }) };
			}
		}
	};
	return server;
};

const cacheFor = (server: FakeJwks): OidcJwksCache => new OidcJwksCache({ jwksUri: JWKS_URI, fetchImpl: server.fetch });

/** Move the fake clock to `BASE_TIME + ms` without running anything. */
const at = (ms: number): void => vi.setSystemTime(BASE_TIME + ms);

/**
 * Run a call whose first fetch attempt fails, to completion.
 *
 * FR-15's retry waits 1,000 ms on a `setTimeout` inside `discovery.ts`, so a call
 * that fails an attempt only settles once the fake clock moves — the spec advances
 * it instead of waiting, and the cases where the timing *is* the claim advance it by
 * hand so the clock can be asserted.
 *
 * The advance is awaited in `finally`, so it can never outlive the call and keep
 * moving the clock under a later `at(...)`.
 */
const settleFailure = async <T>(work: Promise<T>, ms = FR15_RETRY_DELAY_MS + 100): Promise<T> => {
	const advanced = vi.advanceTimersByTimeAsync(ms);
	try {
		return await work;
	} finally {
		await advanced;
	}
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the 600-second cache (FR-13)', () => {
	it('verifies from the cached set inside 600 s and refetches at 600 s', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		const token = await signWith(key);

		await expect(cache.verify(token)).resolves.toMatchObject({ kid: 'key-a', payload: { sub: 'subject-1' } });
		expect(server.requests).toHaveLength(1);

		// 599,999 ms later the cached set still answers, and nothing is fetched.
		at(FR13_CACHE_MS - 1);
		await cache.verify(token);
		expect(server.requests).toHaveLength(1);
		expect(cache.lastRefreshedAt).toBe(BASE_TIME);

		// At exactly 600,000 ms the cache has expired: the next verification refetches.
		at(FR13_CACHE_MS);
		await cache.verify(token);
		expect(server.requests).toHaveLength(2);
		expect(cache.lastRefreshedAt).toBe(BASE_TIME + FR13_CACHE_MS);
	});

	it('answers the verification and reports when the set was last refreshed', async () => {
		const key = await makeKey('key-a');
		const cache = cacheFor(fakeJwks([key.jwk]));

		expect(cache.lastRefreshedAt).toBeNull();
		expect(cache.keyCount).toBe(0);

		await cache.verify(await signWith(key));

		expect(cache.lastRefreshedAt).toBe(BASE_TIME);
		expect(cache.keyCount).toBe(1);
		expect(cache.lastFetchFailure).toBeNull();
	});
});

describe('an unknown kid: one refresh, 30-second cooldown (FR-13)', () => {
	it('refreshes once for an unknown kid, validates, then refuses further refreshes for 30 s', async () => {
		const [known, rotated, unpublished] = await Promise.all([makeKey('key-a'), makeKey('key-b'), makeKey('key-c')]);
		const server = fakeJwks([known.jwk]);
		const cache = cacheFor(server);

		// The cache is warm with key-a only, and the provider has meanwhile rotated
		// to key-b — the first half of ACC-12-08.
		await cache.verify(await signWith(known));
		expect(server.requests).toHaveLength(1);

		server.keys = [known.jwk, rotated.jwk];
		const rotatedToken = await signWith(rotated);
		at(1_000);
		await expect(cache.verify(rotatedToken)).resolves.toMatchObject({ kid: 'key-b' });
		expect(server.requests).toHaveLength(2);

		// The rotated key now answers from the cache, with no further fetch.
		at(2_000);
		await expect(cache.verify(rotatedToken)).resolves.toMatchObject({ kid: 'key-b' });
		expect(server.requests).toHaveLength(2);

		// A `kid` the provider never published arrives 1.5 s later. It gets no refresh:
		// one per 30 seconds, or a token with an invented `kid` becomes a fetch
		// amplifier against the provider.
		const unpublishedToken = await signWith(unpublished);
		at(2_500);
		await expect(cache.verify(unpublishedToken)).rejects.toMatchObject({ code: 'badSignature' });
		expect(server.requests).toHaveLength(2);

		// At exactly 30 s after the last unknown-kid refresh the refetch is allowed —
		// and it still finds nothing, so the token stays refused.
		at(1_000 + FR13_COOLDOWN_MS);
		await expect(cache.verify(unpublishedToken)).rejects.toMatchObject({ code: 'badSignature' });
		expect(server.requests).toHaveLength(3);
	});

	it('does not count a cache-expiry refresh against the unknown-kid cooldown', async () => {
		const [known, rotated] = await Promise.all([makeKey('key-a'), makeKey('key-b')]);
		const server = fakeJwks([known.jwk]);
		const cache = cacheFor(server);
		await cache.verify(await signWith(known));

		// The 600-second expiry triggers a refresh of its own …
		at(FR13_CACHE_MS);
		await cache.verify(await signWith(known));
		expect(server.requests).toHaveLength(2);

		// … and a rotation one millisecond later still gets its single refresh, which
		// is what ACC-12-08's "validates after one refresh" requires.
		server.keys = [rotated.jwk];
		at(FR13_CACHE_MS + 1);
		await expect(cache.verify(await signWith(rotated))).resolves.toMatchObject({ kid: 'key-b' });
		expect(server.requests).toHaveLength(3);
	});
});

describe('a removed key (ACC-12-08)', () => {
	it('refuses a removed key after the next refresh, and after a further one', async () => {
		const [removed, replacement] = await Promise.all([makeKey('key-a'), makeKey('key-b')]);
		const server = fakeJwks([removed.jwk]);
		const cache = cacheFor(server);
		const removedToken = await signWith(removed);

		await expect(cache.verify(removedToken)).resolves.toMatchObject({ kid: 'key-a' });

		// The provider removes key-a and publishes key-b. The refresh that the rotation
		// forces is the "next refresh" FR-13 means.
		server.keys = [replacement.jwk];
		at(1_000);
		await expect(cache.verify(await signWith(replacement))).resolves.toMatchObject({ kid: 'key-b' });
		expect(server.requests).toHaveLength(2);

		// The removed key is gone from the set and the cooldown is running: refused.
		at(2_000);
		await expect(cache.verify(removedToken)).rejects.toMatchObject({ code: 'badSignature' });

		// And it stays refused once a further refresh has actually happened.
		at(1_000 + FR13_COOLDOWN_MS);
		await expect(cache.verify(removedToken)).rejects.toMatchObject({ code: 'badSignature' });
		expect(server.requests).toHaveLength(3);
	});

	it('treats an empty published set as a successful refresh that verifies nothing', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		const token = await signWith(key);
		await cache.verify(token);

		server.mode = 'noKeys';
		at(FR13_CACHE_MS);
		await expect(cache.verify(token)).rejects.toMatchObject({ code: 'badSignature' });

		// Three fetches: the original, the 600-second expiry refresh that accepted the
		// empty set (a truthful answer, and the extreme of FR-13's "a key Ever ID
		// removes stops validating"), and the single unknown-`kid` refresh that empty
		// set now makes every `kid` eligible for.
		expect(server.requests).toHaveLength(3);
		expect(cache.keyCount).toBe(0);
		expect(cache.lastRefreshedAt).toBe(BASE_TIME + FR13_CACHE_MS);
	});
});

describe('staleness: usable to 21,600 s, then fail closed (FR-13)', () => {
	it('keeps serving cached keys through an outage inside 21,600 s', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		const token = await signWith(key);
		await cache.verify(token);

		// The provider goes away. The 600-second cache expires, the refetches fail, and
		// the keys stay usable because FR-13 says an unreachable provider does not
		// invalidate them — the sign-out notices plan §9.2 honours depend on it.
		server.mode = 'reject';
		at(FR13_CACHE_MS + 1);
		await expect(settleFailure(cache.verify(token))).resolves.toMatchObject({ kid: 'key-a' });
		expect(cache.lastFetchFailure).toBe('network');
		expect(cache.lastRefreshedAt).toBe(BASE_TIME);

		// The trust check runs after FR-15's retry, so it happens 1,000 ms into the call.
		// Starting exactly one retry-delay before the mark therefore puts the check on
		// the boundary itself: age === 21,600,000 ms is still inside the window and the
		// cached key is used.
		at(FR13_MAX_STALE_MS - FR15_RETRY_DELAY_MS);
		await expect(settleFailure(cache.verify(token))).resolves.toMatchObject({ kid: 'key-a' });

		// One millisecond later — 21,600,001 ms at the moment of the check — it fails
		// closed.
		at(FR13_MAX_STALE_MS - FR15_RETRY_DELAY_MS + 1);
		await expect(settleFailure(cache.verify(token))).rejects.toMatchObject({
			name: 'OidcProviderUnavailableError',
			code: 'providerUnavailable',
			reason: 'keysStale'
		});
	});

	it('fails closed with keysUnavailable when no key set was ever fetched', async () => {
		const server = fakeJwks([], 'reject');
		const cache = cacheFor(server);
		const key = await makeKey('key-a');

		await expect(settleFailure(cache.verify(await signWith(key)))).rejects.toMatchObject({
			name: 'OidcProviderUnavailableError',
			reason: 'keysUnavailable'
		});
		expect(cache.lastRefreshedAt).toBeNull();
	});

	it('reports an unusable provider rather than a bad token once the set has aged out', async () => {
		const key = await makeKey('key-a');
		const unknown = await makeKey('key-z');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		await cache.verify(await signWith(key));

		server.mode = 'reject';
		at(FR13_MAX_STALE_MS + 1);

		// A token whose kid is not in the aged-out set: the operator needs "the
		// provider is unusable", not "your token is bad".
		await expect(settleFailure(cache.verify(await signWith(unknown)))).rejects.toMatchObject({
			reason: 'keysStale'
		});
	});

	it('recovers on the next successful refresh after an outage', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		await cache.verify(await signWith(key));

		server.mode = 'reject';
		at(FR13_MAX_STALE_MS + 1);
		await expect(settleFailure(cache.verify(await signWith(key)))).rejects.toMatchObject({ reason: 'keysStale' });

		server.mode = 'ok';
		at(FR13_MAX_STALE_MS + FR13_COOLDOWN_MS);
		await expect(cache.verify(await signWith(key))).resolves.toMatchObject({ kid: 'key-a' });
		expect(cache.lastRefreshedAt).toBe(BASE_TIME + FR13_MAX_STALE_MS + FR13_COOLDOWN_MS);
	});
});

describe('the outbound rule: a 5,000 ms timeout and one retry (FR-15)', () => {
	it('aborts each attempt at 5,000 ms, retries once after 1,000 ms, then fails closed', async () => {
		const server = fakeJwks([], 'hang');
		const cache = cacheFor(server);
		const key = await makeKey('key-a');

		const startedAt = Date.now();
		const pending = cache.verify(await signWith(key)).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(FR15_TIMEOUT_MS);
		// The first attempt is over, the retry has not started yet.
		expect(server.requests).toEqual([startedAt]);

		await vi.advanceTimersByTimeAsync(FR15_RETRY_DELAY_MS + FR15_TIMEOUT_MS);
		const error = (await pending) as { reason?: string };

		expect(server.requests).toEqual([startedAt, startedAt + FR15_TIMEOUT_MS + FR15_RETRY_DELAY_MS]);
		expect(Date.now() - startedAt).toBe(2 * FR15_TIMEOUT_MS + FR15_RETRY_DELAY_MS);
		expect(error.reason).toBe('keysUnavailable');
	});

	it('retries once after 1,000 ms when the first attempt failed fast', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk], 'http500');
		const token = await signWith(key);

		// Fail once, then answer. The wrapper is installed **before** the cache is built,
		// because the cache holds the function it was given.
		const originalFetch = server.fetch;
		server.fetch = async (url, init) => {
			if (server.requests.length === 1) server.mode = 'ok';
			return originalFetch(url, init);
		};
		const cache = cacheFor(server);

		const startedAt = Date.now();
		const pending = cache.verify(token);
		// The retry is a `setTimeout` (FR-15): advance exactly its delay, so the two
		// request timestamps below are the claim and not an artefact of the harness.
		await vi.advanceTimersByTimeAsync(FR15_RETRY_DELAY_MS);
		await expect(pending).resolves.toMatchObject({ kid: 'key-a' });

		expect(server.requests).toEqual([startedAt, startedAt + FR15_RETRY_DELAY_MS]);
	});

	it('never retries a key set that answered', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		await cacheFor(server).verify(await signWith(key));
		expect(server.requests).toHaveLength(1);
	});

	it('treats a body that is not a key set as a failed fetch, keeping the previous set', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);
		const token = await signWith(key);
		await cache.verify(token);

		server.mode = 'invalid';
		at(FR13_CACHE_MS + 1);
		await expect(cache.verify(token)).resolves.toMatchObject({ kid: 'key-a' });
		expect(cache.lastFetchFailure).toBe('invalidDocument');
	});
});

describe('the algorithm allow-list (FR-11, plan §4.3)', () => {
	it('refuses alg=none and HS256 before any key lookup', async () => {
		const key = await makeKey('key-a');
		const server = fakeJwks([key.jwk]);
		const cache = cacheFor(server);

		const unsigned = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdWJqZWN0LTEifQ.';
		await expect(cache.verify(unsigned)).rejects.toMatchObject({ code: 'badAlg' });

		const hmac = await new SignJWT({ sub: 'subject-1' })
			.setProtectedHeader({ alg: 'HS256', kid: 'key-a' })
			.sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes'));

		await expect(cache.verify(hmac)).rejects.toMatchObject({ code: 'badAlg' });

		// Not one key was fetched: the refusal is lexical, before the cache is touched.
		expect(server.requests).toEqual([]);
	});

	it('refuses a token signed by a key the provider never published', async () => {
		const published = await makeKey('key-a');
		const impostor = await makeKey('key-a');
		const cache = cacheFor(fakeJwks([published.jwk]));

		await expect(cache.verify(await signWith(impostor))).rejects.toMatchObject({ code: 'badSignature' });
	});

	it('refuses a string that is not a compact JWS at all', async () => {
		const key = await makeKey('key-a');
		const cache = cacheFor(fakeJwks([key.jwk]));

		await expect(cache.verify('not-a-token')).rejects.toMatchObject({ code: 'badSignature' });
		await expect(cache.verify('a.b')).rejects.toMatchObject({ code: 'badSignature' });
	});

	it('accepts RS256 and EdDSA as well as ES256', async () => {
		for (const alg of ['RS256', 'EdDSA'] as const) {
			const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
			const jwk = await exportJWK(publicKey);
			const token = await new SignJWT({ sub: 'subject-1' })
				.setProtectedHeader({ alg, kid: 'key-a' })
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(privateKey);

			const cache = cacheFor(fakeJwks([{ ...jwk, kid: 'key-a', alg, use: 'sig' }]));
			await expect(cache.verify(token), alg).resolves.toMatchObject({ kid: 'key-a' });
		}
	});
});

describe('the transcribed FR-13 numbers still match EVER_ID_LIMITS', () => {
	const contractsSource = readFileSync(
		new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url),
		'utf-8'
	);

	const limitValue = (key: string): number => {
		const match = new RegExp(`\\b${key}:\\s*([0-9_]+)`, 'u').exec(contractsSource);
		expect(match, `${key} not found in EVER_ID_LIMITS`).not.toBeNull();
		return Number((match as RegExpExecArray)[1].replaceAll('_', ''));
	};

	it('mirrors the cache, the cooldown and the staleness window of FR-13', () => {
		expect(OIDC_JWKS_CACHE_SECONDS).toBe(limitValue('jwksCacheSeconds'));
		expect(OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS).toBe(limitValue('jwksUnknownKidCooldownSeconds'));
		expect(OIDC_JWKS_MAX_STALE_SECONDS).toBe(limitValue('jwksMaxStaleSeconds'));
		// The three numbers FR-13 states in prose, asserted literally so a change to any
		// of them has to change this line too.
		expect([OIDC_JWKS_CACHE_SECONDS, OIDC_JWKS_UNKNOWN_KID_COOLDOWN_SECONDS, OIDC_JWKS_MAX_STALE_SECONDS]).toEqual([
			600, 30, 21_600
		]);
	});
});
