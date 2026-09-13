import { describe, expect, it, vi } from 'vitest';
import { FLEET_PUSH_CREDENTIAL_REVOKE_URL, type FleetJobPushCredentialResponse } from '@ever-works/contracts';
import { PushCredentialError, PushCredentialSession, type PushCredentialFetch } from './push-credential';

/**
 * The node half of scoped push credentials (self-build slice AM, EW-810).
 *
 * What these cases are for, in order of what a review will look for:
 * the token never leaves memory, every REFUSAL fails closed, and the
 * credential is gone — at GitHub, not merely dropped — on every exit path
 * the process can still execute.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'ghs_0123456789abcdefghijklmnopqrstuvwxyz';
const REMOTE = 'https://github.com/ever-works/ever-works.git';

const response = (overrides: Partial<FleetJobPushCredentialResponse> = {}): FleetJobPushCredentialResponse => ({
	attribution: {
		nodeId: NODE_ID,
		nodeName: 'studio-win',
		agentId: AGENT_ID,
		agentName: 'Refactor Bot',
		agentEmail: 'refactor-bot@agents.ever.works',
		jobId: JOB_ID,
		runId: RUN_ID
	},
	push: {
		token: TOKEN,
		username: 'x-access-token',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		repositories: ['ever-works/ever-works']
	},
	...overrides
});

const sessionWith = (
	answer: FleetJobPushCredentialResponse | (() => Promise<FleetJobPushCredentialResponse>),
	fetchFn?: PushCredentialFetch
) => {
	const mint = vi.fn(typeof answer === 'function' ? answer : async () => answer);
	const session = new PushCredentialSession({
		jobId: JOB_ID,
		client: { mintPushCredential: mint },
		...(fetchFn ? { fetchFn } : {})
	});
	return { session, mint };
};

describe('PushCredentialSession — minting', () => {
	it('mints ONCE for a job, however many repositories it publishes', async () => {
		// A multi-repo run publishes its mounts and its primary branch
		// seconds apart under the same claim, and the platform already
		// scopes one token to every repository the job writes. A second
		// mint would only widen the number of live write credentials.
		const { session, mint } = sessionWith(response());

		await session.attribute('feat: x');
		await session.credentialFor(REMOTE);
		await session.credentialFor(REMOTE);

		expect(mint).toHaveBeenCalledTimes(1);
	});

	it('does not re-mint concurrently either', async () => {
		let resolveMint: (value: FleetJobPushCredentialResponse) => void = () => undefined;
		const { session, mint } = sessionWith(
			() => new Promise<FleetJobPushCredentialResponse>((resolve) => (resolveMint = resolve))
		);

		const first = session.credentialFor(REMOTE);
		const second = session.credentialFor(REMOTE);
		resolveMint(response());
		await Promise.all([first, second]);

		expect(mint).toHaveBeenCalledTimes(1);
	});

	it('carries the platform attribution into the commit message and identity', async () => {
		const { session } = sessionWith(response());

		const attributed = await session.attribute('feat(task): do a thing');

		expect(attributed.commitMessage).toBe(
			[
				'feat(task): do a thing',
				'',
				`Ever-Works-Node: studio-win (${NODE_ID})`,
				`Ever-Works-Agent: Refactor Bot (${AGENT_ID})`,
				`Ever-Works-Job: ${JOB_ID}`,
				`Ever-Works-Run: ${RUN_ID}`
			].join('\n')
		);
		// Author is the Agent, committer is the machine — the whole answer
		// to "which agent and which node produced this change".
		expect(attributed.identity).toEqual({
			authorName: 'Refactor Bot',
			authorEmail: 'refactor-bot@agents.ever.works',
			committerName: 'Ever Works node studio-win',
			committerEmail: `node-${NODE_ID}@nodes.ever.works`
		});
	});
});

describe('PushCredentialSession — refusals (all fail closed)', () => {
	it('refuses a commit message that already claims a machine', async () => {
		// `git.commitMessage` is payload text derived from a Task title,
		// and the node's own validation permits newlines. Appending our
		// trailers after a forged block would leave a reader unable to tell
		// which the platform wrote.
		const { session } = sessionWith(response());

		await expect(session.attribute('feat: x\n\nEver-Works-Node: someone-elses-laptop (deadbeef)')).rejects.toThrow(
			PushCredentialError
		);
	});

	it('refuses when the platform issued no credential for a run that wants to push', async () => {
		const { session } = sessionWith(response({ push: null }));

		await expect(session.credentialFor(REMOTE)).rejects.toThrow(/no push credential/);
	});

	it('refuses a remote the credential was not scoped to', async () => {
		// The token covers `ever-works/ever-works`. A checkout pointed at
		// anything else must not be offered it — this is the difference
		// between a scope and a decoration.
		const { session } = sessionWith(response());

		await expect(session.credentialFor('https://github.com/someone-else/private.git')).rejects.toThrow(
			/does not cover someone-else\/private/
		);
	});

	it.each([
		['git@github.com:ever-works/ever-works.git'],
		['ssh://git@github.com/ever-works/ever-works.git'],
		['http://github.com/ever-works/ever-works.git'],
		['file:///tmp/ever-works.git'],
		['not a url']
	])('refuses the non-https remote %s', async (remote) => {
		const { session } = sessionWith(response());

		await expect(session.credentialFor(remote)).rejects.toThrow(/not an https GitHub repository URL/);
	});

	// REGRESSION — the scope check never looked at the HOST (slice AM
	// review, F1/F4).
	//
	// `fleetPushRemoteRepositoryId` validated the scheme, the userinfo, the
	// query and the path-segment count and never read `url.host`, so every
	// URL below answered `ever-works/ever-works` — the exact value the
	// legitimate remote answers — and sailed through
	// `push.repositories.includes(repositoryId)` right here. The plugin then
	// keyed `http.<that URL>.extraheader` to the installation token, and Git
	// sends an extraheader on its FIRST request to a host, unprompted and
	// before any challenge, so a `404` from an attacker-chosen host was
	// still enough to disclose a live `contents: write` credential for the
	// owner's repositories.
	//
	// Reachable two ways: a model with acceptEdits writing
	// `url.<evil>.insteadOf` into the pool config (which `git remote get-url
	// origin` DOES apply, so this method sees the rewritten URL), and with
	// no attacker at all — a non-GitHub repo connection whose `owner/repo`
	// happens to match an installation row.
	it.each([
		['https://evil.tld/ever-works/ever-works.git'],
		['https://github.com.evil.tld/ever-works/ever-works'],
		['https://api.github.com/ever-works/ever-works'],
		['https://github.com:8443/ever-works/ever-works'],
		['https://gitlab.com/ever-works/ever-works.git']
	])('refuses %s even though its owner/repo matches the scope', async (remote) => {
		const { session } = sessionWith(response());

		await expect(session.credentialFor(remote)).rejects.toThrow(/not an https GitHub repository URL/);
	});

	it('still serves the real remote, however it is cased', async () => {
		// The host pin must not cost the legitimate path: `URL` lower-cases
		// the host and drops a default `:443`.
		const { session } = sessionWith(response());

		await expect(session.credentialFor('https://GitHub.com/Ever-Works/ever-works.git')).resolves.toMatchObject({
			token: TOKEN
		});
	});

	it('never echoes a credential that was already embedded in the remote it refuses', async () => {
		// This text becomes the run's failure reason and reaches
		// `fleet_jobs.result` and the Task page.
		const { session } = sessionWith(response());

		await expect(
			session.credentialFor('https://x-access-token:ghp_leaked_secret_value@github.com/ever-works/ever-works')
		).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining('ghp_leaked_secret_value')
			}) as Error
		);
	});

	it('turns a mint failure into a refusal that says nothing was published', async () => {
		const { session } = sessionWith(async () => {
			throw new Error('The platform could not issue a scoped push credential for this run');
		});

		await expect(session.credentialFor(REMOTE)).rejects.toThrow(/nothing was published/);
	});

	it('refuses after the session has been released', async () => {
		const { session } = sessionWith(response());
		await session.credentialFor(REMOTE);

		await session.dispose();

		await expect(session.credentialFor(REMOTE)).rejects.toThrow(/already been released/);
	});
});

describe('PushCredentialSession — the credential is gone on every exit path', () => {
	it('revokes at GitHub with the token itself and drops it from memory', async () => {
		const calls: Array<{ url: string; init: { method: string; headers: Record<string, string> } }> = [];
		const fetchFn: PushCredentialFetch = async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 204 };
		};
		const { session } = sessionWith(response(), fetchFn);
		await session.credentialFor(REMOTE);

		await session.dispose();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(FLEET_PUSH_CREDENTIAL_REVOKE_URL);
		expect(calls[0]!.init.method).toBe('DELETE');
		expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('clears the token BEFORE awaiting the revoke, so a hung revoke leaves no live reference', async () => {
		let released = false;
		const fetchFn: PushCredentialFetch = async () => {
			// While this is in flight, the session must already have
			// forgotten the token — a revoke that never returns must not
			// keep a write credential reachable for the rest of the run.
			await expect(session.credentialFor(REMOTE)).rejects.toThrow(/already been released/);
			released = true;
			return { ok: true, status: 204 };
		};
		const { session } = sessionWith(response(), fetchFn);
		await session.credentialFor(REMOTE);

		await session.dispose();

		expect(released).toBe(true);
	});

	it('is idempotent and never revokes twice', async () => {
		const fetchFn = vi.fn(async () => ({ ok: true, status: 204 }));
		const { session } = sessionWith(response(), fetchFn);
		await session.credentialFor(REMOTE);

		await session.dispose();
		await session.dispose();

		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed revoke — the token still expires on GitHub’s clock', async () => {
		const fetchFn: PushCredentialFetch = async () => {
			throw new Error('network down');
		};
		const { session } = sessionWith(response(), fetchFn);
		await session.credentialFor(REMOTE);

		await expect(session.dispose()).resolves.toBeUndefined();
	});

	it('revokes nothing when no credential was ever minted', async () => {
		const fetchFn = vi.fn(async () => ({ ok: true, status: 204 }));
		const { session } = sessionWith(response({ push: null }), fetchFn);
		await session.attribute('feat: commit-only run');

		await session.dispose();

		expect(fetchFn).not.toHaveBeenCalled();
	});

	// REGRESSION — the revoke could hang for as long as the HTTP client's
	// own default (slice AM review, F7).
	//
	// `dispose()` is awaited in the agent-task handler's terminal `finally`,
	// so an unbounded revoke holds job settlement behind a stalled
	// connection to api.github.com on EVERY run — even though the revoke is
	// documented as best-effort.
	it('bounds the revoke with a timeout signal', async () => {
		const seen: { signal?: AbortSignal }[] = [];
		const fetchFn: PushCredentialFetch = async (_url, init) => {
			seen.push(init);
			return { ok: true, status: 204 };
		};
		const { session } = sessionWith(response(), fetchFn);
		await session.credentialFor(REMOTE);

		await session.dispose();

		expect(seen).toHaveLength(1);
		expect(seen[0].signal).toBeInstanceOf(AbortSignal);
		expect(seen[0].signal?.aborted).toBe(false);
	});

	// REGRESSION — disposal racing an in-flight mint (slice AM review, F11).
	//
	// `dispose()` used to read the token from `this.response` (still null
	// while the mint was in flight), see nothing to revoke, and set
	// `disposed = true`. The mint's `.then` then assigned `this.response`,
	// so a DISPOSED session held a live `contents: write` installation token
	// for the owner's repositories which `dispose()` — idempotent by design —
	// could never revoke, and which stayed valid until GitHub's ~1h expiry.
	// That is exactly the "lifetime that outlives the run" this module's
	// header rules out.
	it('revokes a mint that lands AFTER disposal instead of storing it', async () => {
		let settleMint: (value: FleetJobPushCredentialResponse) => void = () => undefined;
		const revoked: string[] = [];
		const fetchFn: PushCredentialFetch = async (_url, init) => {
			revoked.push(String(init.headers.Authorization));
			return { ok: true, status: 204 };
		};
		const { session } = sessionWith(
			() =>
				new Promise<FleetJobPushCredentialResponse>((resolve) => {
					settleMint = resolve;
				}),
			fetchFn
		);

		// Start the mint, then dispose while it is still in flight.
		const pending = session.credentialFor(REMOTE);
		await session.dispose();
		expect(revoked).toEqual([]);

		settleMint(response());
		// The caller gets the same refusal a disposed session gives everyone
		// else — never a credential the session cannot revoke.
		await expect(pending).rejects.toThrow(PushCredentialError);
		await expect(pending).rejects.toThrow(/already been released/);

		// And the token that did get minted is dead at GitHub rather than
		// orphaned for an hour.
		expect(revoked).toEqual([`Bearer ${TOKEN}`]);
	});
});

/**
 * REGRESSION — the redactor outlived the credential (slice AM review, F3).
 *
 * `job-client` calls `logger.protect(push.token)` on every mint, and the
 * node's `protectedValues` set had an `add` path only: no `unprotect`, no
 * eviction, no per-job scoping. So after `dispose()` had nulled
 * `this.response` and DELETEd the token at GitHub, the raw `ghs_…` string
 * was still reachable from the logger closure held by the one
 * `FleetJobClient` a node process constructs. Forty agent-tasks across a
 * multi-day uptime meant forty raw write credentials in heap — recoverable
 * from a crash dump or a heap snapshot, and the recent ones still live.
 */
describe('PushCredentialSession — the redactor does not outlive the token', () => {
	it('unprotects the token once the revoke has run', async () => {
		const protectedValues: string[] = [];
		const logger = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			protect: (value?: string | null) => {
				if (typeof value === 'string') protectedValues.push(value);
			},
			unprotect: (value?: string | null) => {
				const index = protectedValues.indexOf(String(value));
				if (index >= 0) protectedValues.splice(index, 1);
			},
			redact: (text: string) => text
		};
		// The client protects on mint; this session is what knows when the
		// value stops existing.
		logger.protect(TOKEN);

		const session = new PushCredentialSession({
			jobId: JOB_ID,
			client: { mintPushCredential: async () => response() },
			logger,
			fetchFn: async () => ({ ok: true, status: 204 })
		});
		await session.credentialFor(REMOTE);
		expect(protectedValues).toEqual([TOKEN]);

		await session.dispose();

		expect(protectedValues).toEqual([]);
	});

	it('unprotects even when the revoke itself fails', async () => {
		// A network failure narrows nothing at GitHub, but it must not
		// leave the value pinned in this process either.
		const protectedValues = new Set<string>([TOKEN]);
		const session = new PushCredentialSession({
			jobId: JOB_ID,
			client: { mintPushCredential: async () => response() },
			logger: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				protect: (value?: string | null) => {
					if (typeof value === 'string') protectedValues.add(value);
				},
				unprotect: (value?: string | null) => {
					protectedValues.delete(String(value));
				},
				redact: (text: string) => text
			},
			fetchFn: async () => {
				throw new Error('network down');
			}
		});
		await session.credentialFor(REMOTE);

		await session.dispose();

		expect([...protectedValues]).toEqual([]);
	});
});
