import {
	FLEET_PUSH_CREDENTIAL_REVOKE_URL,
	FLEET_PUSH_CREDENTIAL_USERNAME,
	composeFleetPushCommitMessage,
	fleetPushCommitIdentity,
	fleetPushRemoteRepositoryId,
	type FleetJobPushCredentialResponse,
	type FleetPushAttribution,
	type FleetPushCommitIdentity
} from '@ever-works/contracts';
import type { Logger } from '../logger';

/**
 * The node half of scoped push credentials (self-build slice AM, EW-810).
 *
 * ## Where the credential lives, at every instant
 *
 * platform response → ONE private field on the session below →
 * `logger.protect()` → the `pushCredential` object handed to a single
 * `finalize` call → the environment of one `git push` child → gone.
 *
 * It is never on the payload (slice Y: a value that reaches the payload
 * reaches the job row, the lease response, the job view and
 * `fleet_jobs.result`), never on disk, never in argv, never in the
 * model's environment, and never in a log line.
 *
 * ## Why it is acquired at FINALIZE and not at provision
 *
 * The model runs with `acceptEdits` over the whole checkout for twenty
 * minutes; the finalize is seconds long and happens after the model has
 * exited. Minting late means the credential does not exist at any moment
 * an untrusted process is running, which is a stronger guarantee than
 * any cleanup could give — slice Y had to DELETE its `.env` files before
 * the first Git command precisely because they existed while the model
 * did.
 *
 * ## Why there is no fallback
 *
 * A mint that fails throws. The node does not push. The alternative —
 * falling back to whatever the machine's own Git credential helper
 * answers — is the long-lived, unscoped, unrevocable machine PAT this
 * whole slice exists to stop using, so "degrade gracefully" here would
 * mean "change nothing".
 */
export interface PushCredentialClient {
	mintPushCredential(jobId: string, leaseGeneration?: number): Promise<FleetJobPushCredentialResponse>;
}

/** The scoped write credential, as one finalize consumes it. */
export interface ScopedPushCredential {
	readonly username: string;
	readonly token: string;
	readonly remoteUrl: string;
}

/** Who this run's commits are by, and the message they carry. */
export interface PushAttribution {
	readonly attribution: FleetPushAttribution;
	readonly identity: FleetPushCommitIdentity;
	/** The payload's message with the reserved trailer block appended. */
	readonly commitMessage: string;
}

/**
 * What {@link FleetTaskWorkspaceProvisioner} depends on, so the
 * provisioner needs no knowledge of the job channel and a test can drive
 * every refusal without a network.
 */
export interface PushCredentialProvider {
	attribute(commitMessage: string): Promise<PushAttribution>;
	/** Throws {@link PushCredentialError} when this remote may not be written. */
	credentialFor(remoteUrl: string): Promise<ScopedPushCredential>;
}

/** Injected so the revoke is testable without a network. */
export type PushCredentialFetch = (
	input: string,
	init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

/**
 * How long {@link PushCredentialSession.dispose} will wait for GitHub.
 *
 * `dispose()` is awaited in the agent-task handler's terminal `finally`,
 * so a stalled connection to `api.github.com` holds job settlement for
 * however long the HTTP client's own default is — undici's headers
 * timeout, on EVERY run. The revoke is best-effort by contract (the token
 * expires on GitHub's clock within the hour and covers only this job's
 * repositories), so waiting longer than this buys nothing and costs the
 * queue.
 */
export const PUSH_CREDENTIAL_REVOKE_TIMEOUT_MS = 5_000;

export interface PushCredentialSessionOptions {
	jobId: string;
	client: PushCredentialClient;
	logger?: Logger;
	/** The claim generation this run holds; refused server-side when stale. */
	leaseGeneration?: number;
	fetchFn?: PushCredentialFetch;
}

/**
 * Raised when this run may not push. Its message is what the operator
 * reads on the Task, so it always says WHY and never says "retry".
 */
export class PushCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PushCredentialError';
	}
}

/**
 * One job's push credential, minted at most once and dropped for good at
 * {@link PushCredentialSession.dispose}.
 *
 * Minted once rather than per repository because a multi-repo run pushes
 * the mounts and the primary under the SAME claim, seconds apart, and a
 * second mint would only widen the number of live write tokens for no
 * additional narrowing — the platform scopes one token to every
 * repository the job writes.
 */
export class PushCredentialSession implements PushCredentialProvider {
	private response: FleetJobPushCredentialResponse | null = null;
	private inFlight: Promise<FleetJobPushCredentialResponse> | null = null;
	private disposed = false;

	constructor(private readonly options: PushCredentialSessionOptions) {}

	/**
	 * Who this run's commits are by, and the message they carry.
	 *
	 * REFUSES a payload message that already carries a reserved
	 * `Ever-Works-` trailer: see `composeFleetPushCommitMessage`. The
	 * commit message is derived from a Task title, so it is the one place
	 * user-authored text could otherwise claim a machine the run never
	 * used.
	 */
	async attribute(payloadMessage: string): Promise<PushAttribution> {
		const response = await this.load();
		const attribution = response.attribution;
		let commitMessage: string;
		try {
			commitMessage = composeFleetPushCommitMessage({ message: payloadMessage, attribution });
		} catch (error) {
			throw new PushCredentialError(`this run's commit message could not be attributed: ${describeError(error)}`);
		}
		return { attribution, identity: fleetPushCommitIdentity(attribution), commitMessage };
	}

	/**
	 * The scoped credential for ONE remote.
	 *
	 * Throws — never returns null — because every caller of this is about
	 * to write to someone's repository, and "no credential" must not be a
	 * value a caller can accidentally treat as "push anyway".
	 */
	async credentialFor(remoteUrl: string): Promise<ScopedPushCredential> {
		if (this.disposed) {
			throw new PushCredentialError('the push credential for this run has already been released');
		}
		const response = await this.load();
		const push = response.push;
		if (!push?.token) {
			// The platform re-read its own plan and decided this job does
			// not push, while the caller believes it does. A disagreement
			// about whether a write is authorised is refused, never
			// resolved in favour of writing.
			throw new PushCredentialError(
				'the platform issued no push credential for this run (its plan does not authorise a push)'
			);
		}
		// The remote this checkout actually points at must be one the
		// platform scoped the token to. `origin` is read from the worktree
		// by the caller and the allowed set comes from platform state, so
		// this is the one place the two are compared.
		const repositoryId = fleetPushRemoteRepositoryId(remoteUrl);
		if (!repositoryId) {
			throw new PushCredentialError(
				`this run's remote (${describeRemote(remoteUrl)}) is not an https GitHub repository URL, so a scoped push credential cannot authenticate it`
			);
		}
		if (!push.repositories.includes(repositoryId)) {
			throw new PushCredentialError(
				`the scoped push credential for this run does not cover ${repositoryId}; it covers ${
					push.repositories.join(', ') || 'nothing'
				}`
			);
		}
		return {
			username: push.username || FLEET_PUSH_CREDENTIAL_USERNAME,
			token: push.token,
			remoteUrl
		};
	}

	/**
	 * Drop the credential and tell GitHub to stop honouring it.
	 *
	 * Idempotent, best-effort, and — importantly — the token is cleared
	 * from memory BEFORE the `await`, so a revoke that hangs cannot leave
	 * a live reference behind for the rest of the process's life. A revoke
	 * that fails narrows nothing: the token still expires on GitHub's own
	 * clock, within the hour, and covers only this job's repositories.
	 *
	 * "Cleared from memory" now means what it says. Two leaks made it a
	 * claim rather than a fact:
	 *
	 *  - the REDACTOR outlived the session. `job-client` protects the raw
	 *    token on every mint and the node's `protectedValues` set had no
	 *    eviction path, so each run left a live `ghs_…` string reachable
	 *    from a process-lifetime closure. {@link Logger.unprotect} closes
	 *    that, and this is the only place that knows when the value stops
	 *    existing.
	 *  - a mint still IN FLIGHT when disposal ran re-populated
	 *    `this.response` afterwards (see {@link load}), leaving a disposed
	 *    session holding a live `contents: write` token that `dispose()`
	 *    is idempotence-guarded against ever revoking.
	 *
	 * The revoke is also bounded now: it is awaited in the agent-task
	 * handler's terminal `finally`, so an unbounded one holds settlement of
	 * every run behind whatever the HTTP client's default timeout happens
	 * to be.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const token = this.response?.push?.token ?? null;
		this.response = null;
		this.inFlight = null;
		await this.revoke(token);
	}

	/**
	 * DELETE the token at GitHub and forget it locally.
	 *
	 * Split out of {@link dispose} because {@link load} needs it too: a
	 * mint that lands after disposal has produced a live credential nobody
	 * asked for, and the session it would have belonged to is already gone.
	 */
	private async revoke(token: string | null): Promise<void> {
		if (!token) return;
		const fetchFn = this.options.fetchFn ?? defaultFetch();
		const timeout = revokeTimeoutSignal();
		try {
			if (!fetchFn) return;
			await fetchFn(FLEET_PUSH_CREDENTIAL_REVOKE_URL, {
				method: 'DELETE',
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${token}`,
					'User-Agent': 'ever-works-node',
					'X-GitHub-Api-Version': '2022-11-28'
				},
				...(timeout ? { signal: timeout } : {})
			});
		} catch {
			// Best-effort by contract. Never fails a run: the work is
			// already pushed (or already failed) by the time this runs.
		} finally {
			// AFTER the request, because the revoke is the last thing that
			// legitimately holds this value and a failure in it is logged
			// through the same redactor. From here the token exists in no
			// node data structure at all.
			this.options.logger?.unprotect(token);
		}
	}

	private load(): Promise<FleetJobPushCredentialResponse> {
		if (this.response) return Promise.resolve(this.response);
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.options.client
			.mintPushCredential(this.options.jobId, this.options.leaseGeneration)
			.then((response) => {
				// The client already registered the token with the redactor;
				// re-registering here would be free but would also mean this
				// module had a reason to touch the raw value, which it does
				// not beyond handing it to one `git push`.
				//
				// A mint that lands AFTER disposal is not this session's to
				// keep. Storing it would leave a disposed session holding a
				// live `contents: write` token for the owner's repositories
				// that `dispose()` — idempotent by design — can never revoke,
				// so it would survive to GitHub's ~1h expiry. Revoke it here
				// instead and answer the caller with the refusal the disposed
				// session already gives everyone else.
				if (this.disposed) {
					void this.revoke(response?.push?.token ?? null);
					throw new PushCredentialError('the push credential for this run has already been released');
				}
				this.response = response;
				return response;
			})
			.catch((error: unknown) => {
				this.inFlight = null;
				if (error instanceof PushCredentialError) throw error;
				throw new PushCredentialError(
					`this run could not obtain a scoped push credential, so nothing was published: ${
						this.options.logger?.redact(describeError(error)) ?? describeError(error)
					}`
				);
			});
		return this.inFlight;
	}
}

/** `AbortSignal.timeout` where the runtime has it; undefined otherwise. */
function revokeTimeoutSignal(): AbortSignal | undefined {
	if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
	return AbortSignal.timeout(PUSH_CREDENTIAL_REVOKE_TIMEOUT_MS);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A remote URL rendered for an operator-facing message: host and path
 * only, never userinfo. The fleet's clone URLs are token-free by
 * contract, but this text reaches `fleet_jobs.result` and the Task page,
 * and a URL that arrived carrying a credential must not be echoed there.
 */
function describeRemote(remoteUrl: string): string {
	try {
		const url = new URL(remoteUrl);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return 'an unparseable URL';
	}
}

function defaultFetch(): PushCredentialFetch | null {
	const globalFetch = (globalThis as { fetch?: unknown }).fetch;
	if (typeof globalFetch !== 'function') return null;
	return globalFetch.bind(globalThis) as PushCredentialFetch;
}
