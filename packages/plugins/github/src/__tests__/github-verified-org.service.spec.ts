import { describe, it, expect, vi } from 'vitest';

// `Octokit` is constructed inside the SUT's default factory; the SUT
// also exposes an injectable `createOctokit` hook that we use directly
// in tests. `libsodium-wrappers` is loaded transitively by the broader
// plugin index — stub it so vitest doesn't fail on its native bindings.
vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

// Mock the entire `octokit` module so the SUT's `instanceof RequestError`
// check matches the errors we throw from the injected `createOctokit`.
// Defined as a class **inside** the factory because `vi.mock` is hoisted
// above top-level statements.
vi.mock('octokit', () => {
	class FakeRequestError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	class FakeOctokit {
		rest = {};
		constructor(public opts: unknown) {}
	}
	return {
		Octokit: FakeOctokit,
		RequestError: FakeRequestError
	};
});

const { GitHubVerifiedOrgService, parseVerifiedOrgs } = await import('../github-verified-org.service.js');
const { RequestError: FakeRequestError } = (await import('octokit')) as unknown as {
	RequestError: new (message: string, status: number) => Error & { status: number };
};

function makeOctokitMock(
	checkMembershipForUser: ReturnType<typeof vi.fn>
): { rest: { orgs: { checkMembershipForUser: ReturnType<typeof vi.fn> } } } {
	return { rest: { orgs: { checkMembershipForUser } } };
}

describe('parseVerifiedOrgs', () => {
	it('returns [] when env var is unset', () => {
		expect(parseVerifiedOrgs(undefined)).toEqual([]);
		expect(parseVerifiedOrgs('')).toEqual([]);
	});

	it('parses comma-separated, trimmed, lowercased, deduped', () => {
		expect(parseVerifiedOrgs(' ever-works , Ever-Co ,ever-works ')).toEqual(['ever-works', 'ever-co']);
	});

	it('drops empty segments', () => {
		expect(parseVerifiedOrgs(',,ever-works,,')).toEqual(['ever-works']);
	});
});

describe('GitHubVerifiedOrgService.isVerifiedMember', () => {
	it('returns false when verifiedOrgs is empty (env-unset case)', async () => {
		const check = vi.fn();
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: []
		});
		expect(out).toBe(false);
		expect(check).not.toHaveBeenCalled();
	});

	it('returns true when the first org returns 204', async () => {
		const check = vi.fn().mockResolvedValueOnce({ status: 204 });
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(true);
		expect(check).toHaveBeenCalledWith({ org: 'ever-works', username: 'octocat' });
	});

	it('returns true if the user is a member of the SECOND configured org', async () => {
		const check = vi
			.fn()
			.mockRejectedValueOnce(new FakeRequestError('not a member', 404))
			.mockResolvedValueOnce({ status: 204 });
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works', 'ever-co']
		});
		expect(out).toBe(true);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('returns false when 404 from every configured org', async () => {
		const check = vi.fn().mockRejectedValue(new FakeRequestError('not a member', 404));
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const out = await svc.isVerifiedMember({
			username: 'stranger',
			token: 't',
			verifiedOrgs: ['ever-works', 'ever-co']
		});
		expect(out).toBe(false);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('returns false on 429 (rate-limited) WITHOUT marking as verified', async () => {
		const check = vi.fn().mockRejectedValueOnce(new FakeRequestError('rate limited', 429));
		const warn = vi.fn();
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never,
			logger: { warn }
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works', 'ever-co']
		});
		expect(out).toBe(false);
		// Stops iterating after rate-limit — does NOT continue to ever-co.
		expect(check).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'));
	});

	it('returns false on 5xx (upstream broken) and logs a warning', async () => {
		const check = vi.fn().mockRejectedValueOnce(new FakeRequestError('upstream broken', 503));
		const warn = vi.fn();
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never,
			logger: { warn }
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(false);
		expect(warn).toHaveBeenCalled();
	});

	it('returns false on non-HTTP network errors and logs a warning', async () => {
		const check = vi.fn().mockRejectedValueOnce(new Error('socket hangup'));
		const warn = vi.fn();
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never,
			logger: { warn }
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket hangup'));
	});

	it('caches the verified=true result for a subsequent call from the same user', async () => {
		const check = vi.fn().mockResolvedValueOnce({ status: 204 });
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		const out = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(true);
		// Second call served from cache — checkMembershipForUser invoked only once.
		expect(check).toHaveBeenCalledTimes(1);
	});

	it('caches verified=false results too (avoids re-checking known non-members)', async () => {
		const check = vi.fn().mockRejectedValue(new FakeRequestError('not a member', 404));
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		await svc.isVerifiedMember({
			username: 'stranger',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		const out = await svc.isVerifiedMember({
			username: 'stranger',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(false);
		// 1 call for the initial check; second call uses cache.
		expect(check).toHaveBeenCalledTimes(1);
	});

	it('expires the cache after ttlMs', async () => {
		const check = vi
			.fn()
			.mockResolvedValueOnce({ status: 204 })
			.mockResolvedValueOnce({ status: 204 });
		let nowMs = 1_000_000;
		const svc = new GitHubVerifiedOrgService({
			ttlMs: 1000,
			now: () => nowMs,
			createOctokit: () => makeOctokitMock(check) as never
		});
		await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		nowMs += 5000; // past TTL
		await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('keys cache by baseUrl + username (GH vs GHE side-by-side)', async () => {
		const check = vi
			.fn()
			.mockResolvedValueOnce({ status: 204 })
			.mockRejectedValueOnce(new FakeRequestError('not a member', 404));
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const a = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		const b = await svc.isVerifiedMember({
			username: 'octocat',
			token: 't',
			baseUrl: 'https://ghe.acme.example/api/v3',
			verifiedOrgs: ['ever-works']
		});
		expect(a).toBe(true);
		expect(b).toBe(false);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('returns false when username is empty (defensive)', async () => {
		const check = vi.fn();
		const svc = new GitHubVerifiedOrgService({
			createOctokit: () => makeOctokitMock(check) as never
		});
		const out = await svc.isVerifiedMember({
			username: '',
			token: 't',
			verifiedOrgs: ['ever-works']
		});
		expect(out).toBe(false);
		expect(check).not.toHaveBeenCalled();
	});
});
