import { describe, expect, it, vi } from 'vitest';

import {
	GHCR_HOST,
	GHCR_TOKEN_USERNAME,
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
 * ever sent to `api.github.com/user` or `ghcr.io/token`**. It is a credential that
 * can read every private package the account can, so a request built from anything
 * other than a literal base — or a redirect followed with the header still
 * attached — is a credential leak, and the only way to know is to watch every call.
 *
 * The registry is modelled the way GHCR really answers (checked live, anonymously,
 * on 2026-09-25): a manifest `HEAD` with no bearer is 401 even for a PUBLIC image;
 * `GET /token?service=ghcr.io&scope=repository:<name>:pull` issues `{ token }`
 * anonymously for a public image and 403 for one it cannot show; only the `HEAD`
 * carrying that registry-issued bearer answers 200. The previous fake answered an
 * anonymous `HEAD` with 200, which GHCR never does, and so hid that every public
 * image read as private.
 */

const TOKEN = 'ghp-not-a-real-token';
const IMAGE = 'ghcr.io/acme/their-app';
const TAG = 'sha-abcdef0';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A response, with only the headers this module reads, and a JSON body for the token endpoint. */
function response(status: number, headers: Record<string, string | null> = {}, body: unknown = null) {
	return {
		status,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		json: async (): Promise<unknown> => {
			if (body === null) throw new SyntaxError('Unexpected end of JSON input');
			return body;
		}
	};
}

/** What GHCR's token endpoint hands out anonymously, and for the pull token. */
const ANONYMOUS_REGISTRY_TOKEN = 'registry-token-anonymous';
const PAT_REGISTRY_TOKEN = 'registry-token-for-the-pat';

/** The Basic credential a Docker client presents at `/token` for the pull token. */
const PAT_BASIC = `Basic ${Buffer.from(`${GHCR_TOKEN_USERNAME}:${TOKEN}`).toString('base64')}`;

type Call = { url: string; method: string; headers: Record<string, string>; redirect: string };

/**
 * GHCR and the GitHub API, answering by URL and by the `Authorization` header —
 * the way the real hosts do — with every call recorded.
 */
function fakeGhcr(options: {
	readonly visibility: 'public' | 'private';
	/** Whether the pull token can read the (private) package. Default true. */
	readonly patCanRead?: boolean;
	/** `x-oauth-scopes` on `GET /user`; `null` is a fine-grained token. Default `read:packages`. */
	readonly scopes?: string | null;
	/** Overrides `/token`'s answer, for the 3xx and malformed-body cases. */
	readonly tokenEndpoint?: (authorization: string | undefined) => ReturnType<typeof response> | undefined;
}): GhcrFetch & { calls: Call[] } {
	const calls: Call[] = [];
	const impl = (async (url: string, init: { method: string; headers: Record<string, string>; redirect: string }) => {
		calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
		const authorization = init.headers.authorization;

		if (url === `${GITHUB_API_HOST}/user`) {
			const scopes = options.scopes === undefined ? REQUIRED_PULL_TOKEN_SCOPE : options.scopes;
			return response(200, scopes === null ? {} : { 'x-oauth-scopes': scopes });
		}

		if (url.startsWith(`${GHCR_HOST}/token?`)) {
			const override = options.tokenEndpoint?.(authorization);
			if (override) return override;
			if (authorization === undefined) {
				return options.visibility === 'public'
					? response(200, {}, { token: ANONYMOUS_REGISTRY_TOKEN })
					: response(403, {}, { errors: [{ code: 'DENIED' }] });
			}
			if (authorization === PAT_BASIC) {
				return options.patCanRead === false
					? response(403, {}, { errors: [{ code: 'DENIED' }] })
					: response(200, {}, { token: PAT_REGISTRY_TOKEN });
			}
			return response(401, {}, { errors: [{ code: 'UNAUTHORIZED' }] });
		}

		if (url.startsWith(`${GHCR_HOST}/v2/`)) {
			const publicRead =
				options.visibility === 'public' && authorization === `Bearer ${ANONYMOUS_REGISTRY_TOKEN}`;
			const privateRead = options.patCanRead !== false && authorization === `Bearer ${PAT_REGISTRY_TOKEN}`;
			if (publicRead || privateRead) return response(200, { 'docker-content-digest': DIGEST });
			return response(401, { 'www-authenticate': `Bearer realm="${GHCR_HOST}/token",service="ghcr.io"` });
		}

		throw new Error(`no answer configured for ${url}`);
	}) as GhcrFetch & { calls: Call[] };
	impl.calls = calls;
	return impl;
}

/** True when a header value carries the pull token, raw or inside a Basic credential. */
function carriesPullToken(headers: Record<string, string>): boolean {
	return Object.values(headers).some((value) => {
		if (value.includes(TOKEN)) return true;
		const basic = /^Basic (.+)$/.exec(value);
		return basic ? Buffer.from(basic[1], 'base64').toString('utf-8').includes(TOKEN) : false;
	});
}

/** A fetch that answers by URL, and records every call. */
function recordingFetch(
	answers: Array<[RegExp, ReturnType<typeof response>]>
): GhcrFetch & { calls: Array<{ url: string; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const impl = (async (url: string, init: { method: string; headers: Record<string, string>; redirect: string }) => {
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
	it('a public image is `public` and readable through the anonymous registry token, with its digest', async () => {
		// Previously pinned as ONE bare HEAD with no Authorization answering 200. GHCR
		// answers that request 401 for every image, public or not (checked live), so
		// the pin encoded the defect: every public image read as private.
		const fetchImpl = fakeGhcr({ visibility: 'public' });

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).toEqual({
			visibility: 'public',
			readable: true,
			digest: DIGEST
		});
		expect(fetchImpl.calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
			`GET ${GHCR_HOST}/token`,
			`HEAD ${GHCR_HOST}/v2/acme/their-app/manifests/${TAG}`
		]);
		// The anonymous token request carries no credential, and the HEAD carries only
		// what the registry issued.
		expect(fetchImpl.calls[0].headers.authorization).toBeUndefined();
		expect(fetchImpl.calls[1].headers.authorization).toBe(`Bearer ${ANONYMOUS_REGISTRY_TOKEN}`);
	});

	it('asks for exactly a pull scope on exactly this repository', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'public' });
		await checkImageAccess({ imageRepository: 'ghcr.io/Acme/Their-App', tag: TAG }, fetchImpl);

		const tokenUrl = new URL(fetchImpl.calls[0].url);
		expect(`${tokenUrl.origin}${tokenUrl.pathname}`).toBe(`${GHCR_HOST}/token`);
		expect(tokenUrl.searchParams.get('service')).toBe('ghcr.io');
		expect(tokenUrl.searchParams.get('scope')).toBe('repository:acme/their-app:pull');
	});

	it('answers `public` without a token even when one is configured — the token is never tried', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'public' });

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result).toEqual({ visibility: 'public', readable: true, digest: DIGEST });
		expect(fetchImpl.calls.some((call) => carriesPullToken(call.headers))).toBe(false);
	});

	it('ACC-05-21: a private manifest with no token is `private`, not readable', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'private' });

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).toEqual({
			visibility: 'private',
			readable: false
		});
	});

	it('a private manifest the token CAN read is readable, and reports the scope verdict', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'private' });

		expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl)).toEqual({
			visibility: 'private',
			readable: true,
			tokenScopesOk: true,
			tokenExpiresAt: null,
			digest: DIGEST
		});
	});

	it('exchanges the pull token at /token as Basic, and sends the registry only the token it issued', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'private' });

		await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		const exchanges = fetchImpl.calls.filter((call) => call.url.startsWith(`${GHCR_HOST}/token?`));
		expect(exchanges.map((call) => call.headers.authorization)).toEqual([undefined, PAT_BASIC]);

		const manifestReads = fetchImpl.calls.filter((call) => call.url.startsWith(`${GHCR_HOST}/v2/`));
		expect(manifestReads.map((call) => call.headers.authorization)).toEqual([`Bearer ${PAT_REGISTRY_TOKEN}`]);
		// The raw PAT as a registry bearer is what the previous code sent; GHCR
		// issues its own token for that, and the PAT never reaches /v2.
		for (const call of manifestReads) expect(carriesPullToken(call.headers)).toBe(false);
	});

	it('a pull token /token refuses is `readable: false`, with the scope verdict still from /user', async () => {
		const fetchImpl = fakeGhcr({
			visibility: 'private',
			tokenEndpoint: (authorization) =>
				authorization === PAT_BASIC ? response(401, {}, { errors: [{ code: 'UNAUTHORIZED' }] }) : undefined
		});

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result).toEqual({
			visibility: 'private',
			readable: false,
			tokenScopesOk: true,
			tokenExpiresAt: null
		});
		// No token was issued, so no authenticated manifest read was attempted with anything.
		expect(fetchImpl.calls.filter((call) => call.url.startsWith(`${GHCR_HOST}/v2/`))).toEqual([]);
	});

	it('a 401 on the AUTHENTICATED manifest is `readable: false`, not a throw', async () => {
		const fetchImpl = fakeGhcr({
			visibility: 'private',
			// /token issues a token for the PAT, but the manifest still refuses it.
			tokenEndpoint: (authorization) =>
				authorization === PAT_BASIC ? response(200, {}, { token: 'a-token-the-manifest-refuses' }) : undefined
		});

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result.readable).toBe(false);
		expect(result.visibility).toBe('private');
	});

	it('reports a broken token alongside an unreadable image, so the member sees the cause', async () => {
		const fetchImpl = fakeGhcr({ visibility: 'private', patCanRead: false, scopes: 'read:packages, repo' });

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result.tokenScopesOk).toBe(false);
		expect(result.readable).toBe(false);
	});

	it('accepts `access_token` as well as `token` from the token endpoint', async () => {
		const fetchImpl = fakeGhcr({
			visibility: 'public',
			tokenEndpoint: (authorization) =>
				authorization === undefined ? response(200, {}, { access_token: ANONYMOUS_REGISTRY_TOKEN }) : undefined
		});

		expect((await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).readable).toBe(true);
	});

	it('treats a token answer with no usable token as no token, not a throw', async () => {
		for (const body of [null, {}, { token: '' }, { token: 42 }]) {
			const fetchImpl = fakeGhcr({
				visibility: 'public',
				tokenEndpoint: (authorization) => (authorization === undefined ? response(200, {}, body) : undefined)
			});
			expect(await checkImageAccess({ imageRepository: IMAGE, tag: TAG }, fetchImpl)).toEqual({
				visibility: 'private',
				readable: false
			});
			expect(fetchImpl.calls.filter((call) => call.url.startsWith(`${GHCR_HOST}/v2/`))).toEqual([]);
		}
	});
});

describe('the token goes to exactly two endpoints', () => {
	it('sends the pull token only to api.github.com/user and ghcr.io/token, and follows no redirect', async () => {
		// Extended deliberately rather than loosened: the PAT now reaches ghcr.io's
		// token endpoint (as Basic, the Docker registry flow), and nowhere else on
		// ghcr.io — never a /v2 manifest read.
		const fetchImpl = fakeGhcr({ visibility: 'private' });

		await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(fetchImpl.calls.length).toBeGreaterThan(0);
		for (const call of fetchImpl.calls) {
			expect(call.url.startsWith(GITHUB_API_HOST) || call.url.startsWith(GHCR_HOST)).toBe(true);
			// Nothing follows a redirect: a 3xx with the Authorization header still
			// attached is how a credential reaches a third host.
			expect(call.redirect).toBe('manual');
			if (carriesPullToken(call.headers)) {
				const endpoint = call.url.split('?')[0];
				expect([`${GITHUB_API_HOST}/user`, `${GHCR_HOST}/token`]).toContain(endpoint);
			}
		}
		// Non-vacuity: the token did travel, to both of the endpoints it may reach.
		const carried = fetchImpl.calls
			.filter((call) => carriesPullToken(call.headers))
			.map((call) => call.url.split('?')[0]);
		expect(carried.sort()).toEqual([`${GHCR_HOST}/token`, `${GITHUB_API_HOST}/user`].sort());
	});

	it('does not follow a 3xx from the token endpoint, and reads nothing it pointed at', async () => {
		const elsewhere = 'https://registry.attacker.example/token';
		const fetchImpl = fakeGhcr({
			visibility: 'private',
			tokenEndpoint: () => response(302, { location: elsewhere }, { token: 'never-read' })
		});

		const result = await checkImageAccess({ imageRepository: IMAGE, tag: TAG, pullToken: TOKEN }, fetchImpl);

		expect(result.readable).toBe(false);
		expect(fetchImpl.calls.every((call) => !call.url.startsWith('https://registry.attacker.example'))).toBe(true);
		expect(fetchImpl.calls.every((call) => call.redirect === 'manual')).toBe(true);
		// A 3xx is not a token: nothing was read from ghcr.io/v2 with anything.
		expect(fetchImpl.calls.filter((call) => call.url.startsWith(`${GHCR_HOST}/v2/`))).toEqual([]);
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
