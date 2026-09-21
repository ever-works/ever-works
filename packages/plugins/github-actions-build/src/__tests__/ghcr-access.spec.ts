import { describe, expect, it, vi } from 'vitest';

import {
	GHCR_HOST,
	GITHUB_API_HOST,
	REQUIRED_PULL_TOKEN_SCOPE,
	checkImageAccess,
	checkPullToken,
	manifestPath,
	type GhcrFetch
} from '../registry/ghcr-access.js';

/**
 * APW-05 T14 — registry access and the pull token.
 *
 * The case that matters most is the last describe block: **a pull token is only
 * ever sent to `api.github.com` or `ghcr.io`**. It is a credential that can read
 * every private package the account can, so a request built from anything other
 * than a literal base — or a redirect followed with the header still attached —
 * is a credential leak, and the only way to know is to watch every call.
 */

const TOKEN = 'ghp-not-a-real-token';
const IMAGE = 'ghcr.io/acme/their-app';
const TAG = 'sha-abcdef0';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A response, with only the two headers this module reads. */
function response(status: number, headers: Record<string, string | null> = {}) {
	return {
		status,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
	};
}

/** A fetch that answers by URL, and records every call. */
function recordingFetch(
	answers: Array<[RegExp, ReturnType<typeof response>]>
): GhcrFetch & { calls: Array<{ url: string; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const impl = (async (url: string, init: { headers: Record<string, string> }) => {
		calls.push({ url, headers: init.headers });
		const match = answers.find(([pattern]) => pattern.test(url));
		if (!match) throw new Error(`no answer configured for ${url}`);
		return match[1];
	}) as GhcrFetch & { calls: typeof calls };
	impl.calls = calls;
	return impl;
}

describe('the pull token check (GET /user, headers only)', () => {
	it(`accepts exactly \`${REQUIRED_PULL_TOKEN_SCOPE}\``, async () => {
		const fetchImpl = recordingFetch([[/api\.github\.com/, response(200, { 'x-oauth-scopes': 'read:packages' })]]);

		expect(await checkPullToken(TOKEN, fetchImpl)).toEqual({ ok: true, expiresAt: null });
	});

	it('refuses a BROADER token — `read:packages, repo`', async () => {
		// A build pull token has one job. One that can also `repo` is one leak
		// away from being a write credential on every repository the account can
		// reach.
		const fetchImpl = recordingFetch([
			[/api\.github\.com/, response(200, { 'x-oauth-scopes': 'read:packages, repo' })]
		]);

		expect(await checkPullToken(TOKEN, fetchImpl)).toEqual({
			ok: false,
			refusal: 'pullTokenTooBroad'
		});
	});

	it('refuses a NARROWER token too — it cannot pull at all', async () => {
		const fetchImpl = recordingFetch([[/api\.github\.com/, response(200, { 'x-oauth-scopes': 'read:user' })]]);

		expect((await checkPullToken(TOKEN, fetchImpl)).ok).toBe(false);
	});

	it('refuses an ABSENT scopes header — a fine-grained token cannot be verified', async () => {
		// GitHub reports no scopes for a fine-grained token, so the shape cannot
		// be checked at all. "I could not check" is not "it is fine", and the
		// distinct code is what lets the message say "use a classic token"
		// instead of leaving the member to guess.
		const fetchImpl = recordingFetch([[/api\.github\.com/, response(200, {})]]);

		expect(await checkPullToken(TOKEN, fetchImpl)).toEqual({
			ok: false,
			refusal: 'pullTokenFineGrained'
		});
	});

	it('refuses a token GitHub itself rejects', async () => {
		for (const status of [401, 403]) {
			const fetchImpl = recordingFetch([[/api\.github\.com/, response(status)]]);
			expect(await checkPullToken(TOKEN, fetchImpl)).toEqual({
				ok: false,
				refusal: 'pullTokenCannotRead'
			});
		}
	});

	it('reports the expiry when GitHub sends one', async () => {
		const fetchImpl = recordingFetch([
			[
				/api\.github\.com/,
				response(200, {
					'x-oauth-scopes': 'read:packages',
					'github-authentication-token-expiration': '2026-12-31 23:59:59 UTC'
				})
			]
		]);

		expect(await checkPullToken(TOKEN, fetchImpl)).toEqual({
			ok: true,
			expiresAt: '2026-12-31 23:59:59 UTC'
		});
	});
});

describe('image access', () => {
	it('a public manifest answers anonymously — `public`, readable, with its digest', async () => {
		const fetchImpl = recordingFetch([[/ghcr\.io/, response(200, { 'docker-content-digest': DIGEST })]]);

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).toEqual({
			visibility: 'public',
			readable: true,
			digest: DIGEST
		});
		// Anonymous FIRST, always: a public package is readable by everyone and
		// the answer must not depend on whether a token happens to be set.
		expect(fetchImpl.calls).toHaveLength(1);
		expect(fetchImpl.calls[0].headers.authorization).toBeUndefined();
	});

	it('ACC-05-21: a private manifest with no token is `private`, not readable', async () => {
		const fetchImpl = recordingFetch([[/ghcr\.io/, response(401)]]);

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).toEqual({
			visibility: 'private',
			readable: false
		});
	});

	it('a private manifest the token CAN read is readable, and reports the scope verdict', async () => {
		let ghcrCall = 0;
		const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
			if (url.startsWith(GITHUB_API_HOST)) {
				return response(200, { 'x-oauth-scopes': 'read:packages' });
			}
			ghcrCall += 1;
			// Anonymous first (401), then authenticated (200).
			return ghcrCall === 1 ? response(401) : response(200, { 'docker-content-digest': DIGEST });
		}) as GhcrFetch;

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl)).toEqual({
			visibility: 'private',
			readable: true,
			tokenScopesOk: true,
			tokenExpiresAt: null,
			digest: DIGEST
		});
	});

	it('a 401 on the AUTHENTICATED manifest is `readable: false`, not a throw', async () => {
		const fetchImpl = (async (url: string) =>
			url.startsWith(GITHUB_API_HOST)
				? response(200, { 'x-oauth-scopes': 'read:packages' })
				: response(401)) as GhcrFetch;

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result.readable).toBe(false);
		expect(result.visibility).toBe('private');
	});

	it('reports a broken token alongside an unreadable image, so the member sees the cause', async () => {
		const fetchImpl = (async (url: string) =>
			url.startsWith(GITHUB_API_HOST)
				? response(200, { 'x-oauth-scopes': 'read:packages, repo' })
				: response(401)) as GhcrFetch;

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result.tokenScopesOk).toBe(false);
		expect(result.readable).toBe(false);
	});
});

describe('the token goes to exactly two hosts', () => {
	it('never builds a URL outside api.github.com or ghcr.io', async () => {
		const fetchImpl = (async (url: string) =>
			url.startsWith(GITHUB_API_HOST)
				? response(200, { 'x-oauth-scopes': 'read:packages' })
				: response(200, { 'docker-content-digest': DIGEST })) as GhcrFetch & {
			calls?: unknown;
		};
		const spy = vi.fn(fetchImpl);

		await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, spy as never);

		for (const [url, init] of spy.mock.calls as Array<[string, { redirect: string }]>) {
			expect(url.startsWith(GITHUB_API_HOST) || url.startsWith(GHCR_HOST)).toBe(true);
			// And nothing follows a redirect: a 3xx with the Authorization header
			// still attached is how a credential reaches a third host.
			expect(init.redirect).toBe('manual');
		}
	});

	it('refuses an image repository that is not GHCR, rather than sending a token there', async () => {
		const spy = vi.fn(async () => response(200));

		const result = await checkImageAccess(
			{ imageRepository: 'registry.example.com/acme/app', tag: TAG, pullToken: TOKEN },
			spy as never
		);

		expect(result).toEqual({ visibility: 'unknown', readable: false });
		// The important half: nothing was dialled at all.
		expect(spy).not.toHaveBeenCalled();
	});

	it('refuses a malformed repository or tag before any request', () => {
		expect(manifestPath('', TAG)).toBeNull();
		expect(manifestPath(IMAGE, '')).toBeNull();
		expect(manifestPath('ghcr.io/no-repo-part', TAG)).toBeNull();
		expect(manifestPath(IMAGE, 'tag with spaces')).toBeNull();
		// A path traversal in the tag must never reach the registry path.
		expect(manifestPath(IMAGE, '../../other')).toBeNull();
		expect(manifestPath(IMAGE, TAG)).toBe(`/v2/acme/their-app/manifests/${TAG}`);
	});

	it('lower-cases the repository, because GHCR rejects anything else', () => {
		expect(manifestPath('ghcr.io/Acme-Org/Their-App', TAG)).toBe(`/v2/acme-org/their-app/manifests/${TAG}`);
	});
});
