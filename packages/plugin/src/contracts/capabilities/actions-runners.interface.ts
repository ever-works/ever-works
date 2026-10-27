import type { IPlugin } from '../plugin.interface.js';

/**
 * Actions runners capability (FL-18, CONTRACTS R-14) — capability
 * `actions-runners`: the platform's one door to GitHub for self-hosted
 * runners on computers of the Fleet.
 *
 * The split of responsibilities:
 *
 *  - The **platform** (the `ActionsRunnersFacadeService` in `@ever-works/agent`)
 *    holds the GitHub App's private key, decides which installation covers a
 *    target, and mints a short-lived installation token narrowed to the ONE
 *    permission each call needs (repository `administration`, organisation
 *    `organization_self_hosted_runners`, `actions` to read jobs or cancel a
 *    run) — for a repository, also narrowed to that repository's id from the
 *    platform's own snapshot.
 *  - The **plugin** receives that token per call and talks to GitHub's REST
 *    API: the runner builds GitHub publishes (with their SHA-256), the
 *    one-time registration and remove tokens, the runners of a target, the
 *    queued and running jobs, cancelling a workflow run. It never holds a
 *    credential between calls and never logs one.
 *  - The **node** downloads, verifies, configures and runs the runner as a
 *    service; it never talks to this plugin.
 */

/** Where a runner is registered. `target` is `owner/repo` (scope `repo`) or `org` (scope `org`). */
export interface ActionsRunnerTarget {
	scope: 'org' | 'repo';
	target: string;
}

/** One runner build GitHub publishes for an OS and architecture. */
export interface ActionsRunnerDownload {
	/** `linux` · `osx` · `win` — GitHub's spelling. */
	os: string;
	/** `x64` · `arm64` · `arm`. */
	architecture: string;
	downloadUrl: string;
	filename: string;
	/** Lower-case hex SHA-256 of the archive, as GitHub publishes it. */
	sha256: string;
}

/** A one-time registration or remove token (GitHub expires it within the hour). */
export interface ActionsRunnerOneTimeToken {
	token: string;
	expiresAt: string | null;
}

/** One runner as GitHub lists it. */
export interface ActionsRunnerRemote {
	id: number;
	name: string;
	os: string | null;
	status: 'online' | 'offline';
	busy: boolean;
	/** Every label, GitHub's own (`self-hosted`, `Linux`, `X64`) included. */
	labels: string[];
}

/** What a rate-limited or conditional read says besides its rows. */
export interface ActionsRunnersReadMeta {
	/** The `ETag` to send back as `If-None-Match` next time. */
	etag: string | null;
	/** True when GitHub answered 304: nothing changed since `etag`; the rows are empty. */
	notModified: boolean;
	/** GitHub's reset instant when it is rate-limiting this token (`x-ratelimit-reset`). */
	rateLimitedUntil: string | null;
	/** `x-ratelimit-remaining`, when GitHub sent it. */
	rateLimitRemaining: number | null;
}

export interface ActionsRunnersPage extends ActionsRunnersReadMeta {
	runners: ActionsRunnerRemote[];
}

/** One queued or in-progress GitHub Actions job (GitHub's own noun — never called a Run here). */
export interface ActionsJob {
	/** `owner/repo`. */
	repository: string;
	runId: number;
	runNumber: number | null;
	jobId: number;
	/** The job's name ("test · ubuntu"). */
	name: string;
	workflowName: string | null;
	/** Every label the job's `runs-on` demands. */
	labels: string[];
	status: 'queued' | 'in_progress';
	runnerName: string | null;
	runnerId: number | null;
	startedAt: string | null;
	/** When the job was created (queued). */
	queuedAt: string | null;
	url: string | null;
}

export interface ActionsJobsPage extends ActionsRunnersReadMeta {
	jobs: ActionsJob[];
}

/** Whether a token can do what a target needs (FR-26, spec S7). */
export interface ActionsRunnersPermissionCheck {
	ok: boolean;
	/** The exact GitHub permission name when it is missing ("Self-hosted runners: Read and write"). */
	missing?: string;
	/** The installation's permission page on GitHub ("Grant access"). */
	grantUrl?: string;
}

/**
 * A GitHub answer the plugin turned into a typed refusal. Matched BY NAME
 * across package boundaries (the FacadeError house pattern); never carries
 * the token.
 */
export class ActionsRunnersApiError extends Error {
	constructor(
		message: string,
		/** `permission` (401 / 403 without rate-limit), `not_found` (404), `rate_limited`, `conflict` (409 / 422), `failed`. */
		readonly code: 'permission' | 'not_found' | 'rate_limited' | 'conflict' | 'failed',
		readonly status: number | null,
		readonly rateLimitedUntil: string | null = null
	) {
		super(message);
		this.name = 'ActionsRunnersApiError';
	}
}

/** True when `error` is an {@link ActionsRunnersApiError} (by name, so a copy across bundles still matches). */
export function isActionsRunnersApiError(error: unknown): error is ActionsRunnersApiError {
	return error instanceof Error && error.name === 'ActionsRunnersApiError' && 'code' in error;
}

/**
 * Actions runners plugin interface — capability `actions-runners`. Every
 * method takes the short-lived installation token for THIS call.
 */
export interface IActionsRunnersPlugin extends IPlugin {
	/** Provider name for facade identification (`github-actions-runners`). */
	readonly providerName: string;

	/** The runner builds GitHub publishes for the target, with their checksums. */
	listDownloads(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerDownload[]>;

	/** A one-time token a runner registers with (`config --token`, given through its environment). */
	mintRegistrationToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken>;

	/** A one-time token a runner deregisters with (`config remove`). */
	mintRemoveToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken>;

	/** The target's self-hosted runners (conditional with `etag`). */
	listRunners(
		target: ActionsRunnerTarget,
		token: string,
		options?: { etag?: string | null }
	): Promise<ActionsRunnersPage>;

	/** Deregister one runner by its GitHub id (the fallback when the node cannot). */
	deleteRunner(target: ActionsRunnerTarget, runnerId: number, token: string): Promise<void>;

	/**
	 * The queued and in-progress jobs of a repository's workflow runs that
	 * target self-hosted runners (an organisation target lists its
	 * repositories' runs through `repositories`).
	 */
	listJobs(
		target: ActionsRunnerTarget,
		token: string,
		options?: { etag?: string | null; repositories?: readonly string[] }
	): Promise<ActionsJobsPage>;

	/** Cancel a whole workflow run (R-37: "Cancel workflow run"). */
	cancelRun(repository: string, runId: number, token: string): Promise<void>;

	/** Whether the token may manage the target's runners (403 → the exact permission name). */
	checkPermission(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnersPermissionCheck>;
}

/**
 * Facade interface — what the platform calls. The implementation lives in
 * `@ever-works/agent` as `ActionsRunnersFacadeService`; `FacadeOptions` is
 * imported there, not here, so this file stays dependency-light.
 */
export interface IActionsRunnersFacade {
	isAvailable(facadeOptions: unknown): Promise<boolean>;
}

/** Type guard — true when a plugin declares the `actions-runners` capability. */
export function isActionsRunnersPlugin(plugin: IPlugin): plugin is IActionsRunnersPlugin {
	return (
		plugin.capabilities.includes('actions-runners') &&
		typeof (plugin as Partial<IActionsRunnersPlugin>).listRunners === 'function' &&
		typeof (plugin as Partial<IActionsRunnersPlugin>).mintRegistrationToken === 'function'
	);
}
