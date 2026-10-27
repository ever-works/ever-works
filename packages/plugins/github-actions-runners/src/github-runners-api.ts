import {
	ActionsRunnersApiError,
	type ActionsJob,
	type ActionsJobsPage,
	type ActionsRunnerDownload,
	type ActionsRunnerOneTimeToken,
	type ActionsRunnerRemote,
	type ActionsRunnersPage,
	type ActionsRunnersReadMeta,
	type ActionsRunnerTarget
} from '@ever-works/plugin';

/**
 * Actions runners (FL-18, plan §7) — the GitHub REST calls the plugin makes,
 * over native `fetch`, with the short-lived installation token of the call.
 *
 * - Every request names the API version and a `User-Agent`, sends the token
 *   as a bearer header only, follows no redirect for a write, and gives up
 *   after {@link REQUEST_TIMEOUT_MS}.
 * - Reads send `If-None-Match` when the caller has an `ETag` and answer
 *   `notModified` on a 304 (a 304 does not count against the rate limit).
 * - `x-ratelimit-remaining: 0` (or a 429 / `retry-after`) becomes
 *   `rate_limited` with GitHub's reset instant, so the platform backs off.
 * - A failure's message never carries the token, and never GitHub's body
 *   beyond its one-line `message`.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RUNNER_PAGES = 5;
const MAX_RUNS_PER_STATUS = 30;

/** The runners collection of a target: `/repos/{owner}/{repo}/actions/runners` or `/orgs/{org}/actions/runners`. */
export function runnersPath(target: ActionsRunnerTarget): string {
	if (target.scope === 'org') return `/orgs/${encodeURIComponent(target.target)}/actions/runners`;
	const [owner, repo] = splitRepository(target.target);
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runners`;
}

/** `owner/repo` → `[owner, repo]`; throws on anything else (never a path a caller shaped). */
export function splitRepository(repository: string): [string, string] {
	const parts = repository.split('/');
	if (parts.length !== 2 || !/^[A-Za-z0-9-]{1,39}$/.test(parts[0]) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1])) {
		throw new ActionsRunnersApiError('not a repository (owner/repo)', 'failed', null);
	}
	if (parts[1] === '.' || parts[1] === '..') throw new ActionsRunnersApiError('not a repository (owner/repo)', 'failed', null);
	return [parts[0], parts[1]];
}

/** GitHub's rate-limit headers → the instant reads may resume, or null when not rate-limited. */
export function rateLimitedUntilOf(response: Pick<Response, 'status' | 'headers'>, now: number = Date.now()): string | null {
	const remaining = response.headers.get('x-ratelimit-remaining');
	const reset = response.headers.get('x-ratelimit-reset');
	const retryAfter = response.headers.get('retry-after');
	const limited = response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null));
	if (!limited) return null;
	if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(now + Number(retryAfter) * 1000).toISOString();
	if (reset && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000).toISOString();
	return new Date(now + 60_000).toISOString();
}

function remainingOf(response: Pick<Response, 'headers'>): number | null {
	const value = response.headers.get('x-ratelimit-remaining');
	return value && /^\d+$/.test(value) ? Number(value) : null;
}

async function messageOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body?.message === 'string') return body.message.split(/\r?\n/)[0].slice(0, 200);
	} catch {
		// Not JSON: the status says enough.
	}
	return `GitHub answered ${response.status}`;
}

/** Turn a non-2xx answer into the typed refusal (never the token). */
export async function refusalOf(response: Response, what: string): Promise<ActionsRunnersApiError> {
	const rateLimitedUntil = rateLimitedUntilOf(response);
	if (rateLimitedUntil) {
		return new ActionsRunnersApiError(`GitHub is rate-limiting ${what}`, 'rate_limited', response.status, rateLimitedUntil);
	}
	const message = await messageOf(response);
	if (response.status === 401 || response.status === 403) {
		return new ActionsRunnersApiError(`GitHub refused ${what}: ${message}`, 'permission', response.status);
	}
	if (response.status === 404) return new ActionsRunnersApiError(`GitHub has no ${what}: ${message}`, 'not_found', 404);
	if (response.status === 409 || response.status === 422) {
		return new ActionsRunnersApiError(`GitHub could not do ${what}: ${message}`, 'conflict', response.status);
	}
	return new ActionsRunnersApiError(`GitHub failed ${what}: ${message}`, 'failed', response.status);
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class GitHubRunnersApi {
	private readonly fetchImpl: FetchLike;

	constructor(
		fetchImpl?: FetchLike,
		private readonly base: string = GITHUB_API_BASE
	) {
		this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
	}

	private async request(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		token: string,
		options: { etag?: string | null; what: string }
	): Promise<Response> {
		if (typeof token !== 'string' || token.length < 8) {
			throw new ActionsRunnersApiError('no installation token for this call', 'permission', null);
		}
		const headers: Record<string, string> = {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'Ever Works'
		};
		if (options.etag) headers['If-None-Match'] = options.etag;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			return await this.fetchImpl(`${this.base}${path}`, {
				method,
				headers,
				signal: controller.signal,
				redirect: method === 'GET' ? 'follow' : 'error'
			});
		} catch {
			const aborted = controller.signal.aborted;
			throw new ActionsRunnersApiError(
				aborted ? `GitHub did not answer ${options.what} in time` : `GitHub could not be reached for ${options.what}`,
				'failed',
				null
			);
		} finally {
			clearTimeout(timer);
		}
	}

	private meta(response: Response): ActionsRunnersReadMeta {
		return {
			etag: response.headers.get('etag'),
			notModified: response.status === 304,
			rateLimitedUntil: null,
			rateLimitRemaining: remainingOf(response)
		};
	}

	async listDownloads(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerDownload[]> {
		const what = 'the runner downloads';
		const response = await this.request('GET', `${runnersPath(target)}/downloads`, token, { what });
		if (!response.ok) throw await refusalOf(response, what);
		const body = (await response.json()) as unknown;
		if (!Array.isArray(body)) return [];
		const out: ActionsRunnerDownload[] = [];
		for (const raw of body as Array<Record<string, unknown>>) {
			const os = str(raw.os);
			const architecture = str(raw.architecture);
			const downloadUrl = str(raw.download_url);
			const filename = str(raw.filename);
			const sha256 = str(raw.sha256_checksum)?.toLowerCase() ?? null;
			// A build without GitHub's checksum is never offered: the node verifies before it extracts.
			if (!os || !architecture || !downloadUrl || !filename || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) continue;
			out.push({ os, architecture, downloadUrl, filename, sha256 });
		}
		return out;
	}

	private async oneTimeToken(target: ActionsRunnerTarget, token: string, kind: 'registration' | 'remove'): Promise<ActionsRunnerOneTimeToken> {
		const what = kind === 'registration' ? 'a runner registration token' : 'a runner remove token';
		const response = await this.request('POST', `${runnersPath(target)}/${kind}-token`, token, { what });
		if (!response.ok) throw await refusalOf(response, what);
		const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
		const minted = str(body?.token);
		if (!minted) throw new ActionsRunnersApiError(`GitHub did not hand over ${what}`, 'failed', response.status);
		return { token: minted, expiresAt: str(body.expires_at) };
	}

	mintRegistrationToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken> {
		return this.oneTimeToken(target, token, 'registration');
	}

	mintRemoveToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken> {
		return this.oneTimeToken(target, token, 'remove');
	}

	async listRunners(target: ActionsRunnerTarget, token: string, options: { etag?: string | null } = {}): Promise<ActionsRunnersPage> {
		const what = `the runners of ${target.target}`;
		const runners: ActionsRunnerRemote[] = [];
		let first: ActionsRunnersReadMeta | null = null;
		for (let page = 1; page <= MAX_RUNNER_PAGES; page += 1) {
			const response = await this.request('GET', `${runnersPath(target)}?per_page=100&page=${page}`, token, {
				what,
				// Only the first page is conditional: its ETag stands for the list.
				etag: page === 1 ? options.etag : null
			});
			if (response.status === 304) return { ...this.meta(response), etag: options.etag ?? null, runners: [] };
			if (!response.ok) {
				const refusal = await refusalOf(response, what);
				if (refusal.code === 'rate_limited' && page > 1 && first) {
					return { ...first, rateLimitedUntil: refusal.rateLimitedUntil, runners };
				}
				throw refusal;
			}
			if (!first) first = this.meta(response);
			const body = (await response.json()) as { total_count?: unknown; runners?: unknown };
			const rows = Array.isArray(body?.runners) ? (body.runners as Array<Record<string, unknown>>) : [];
			for (const raw of rows) {
				const id = num(raw.id);
				const name = str(raw.name);
				if (id === null || !name) continue;
				const labels = Array.isArray(raw.labels)
					? (raw.labels as Array<Record<string, unknown>>).map((label) => str(label?.name)).filter((label): label is string => !!label)
					: [];
				runners.push({
					id,
					name,
					os: str(raw.os),
					status: raw.status === 'online' ? 'online' : 'offline',
					busy: raw.busy === true,
					labels
				});
			}
			const total = num(body?.total_count) ?? runners.length;
			if (rows.length < 100 || runners.length >= total) break;
		}
		return { ...(first ?? { etag: null, notModified: false, rateLimitedUntil: null, rateLimitRemaining: null }), runners };
	}

	async deleteRunner(target: ActionsRunnerTarget, runnerId: number, token: string): Promise<void> {
		if (!Number.isSafeInteger(runnerId) || runnerId <= 0) {
			throw new ActionsRunnersApiError('not a runner id', 'failed', null);
		}
		const what = `runner ${runnerId}`;
		const response = await this.request('DELETE', `${runnersPath(target)}/${runnerId}`, token, { what });
		// Already gone is what a delete wants.
		if (response.status === 404) return;
		if (!response.ok) throw await refusalOf(response, what);
	}

	async listJobs(
		target: ActionsRunnerTarget,
		token: string,
		options: { etag?: string | null; repositories?: readonly string[] } = {}
	): Promise<ActionsJobsPage> {
		const repositories = target.scope === 'repo' ? [target.target] : [...(options.repositories ?? [])];
		const jobs: ActionsJob[] = [];
		let meta: ActionsRunnersReadMeta = { etag: null, notModified: false, rateLimitedUntil: null, rateLimitRemaining: null };
		for (const repository of repositories) {
			const [owner, repo] = splitRepository(repository);
			const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
			for (const status of ['queued', 'in_progress'] as const) {
				const what = `the ${status === 'queued' ? 'queued' : 'running'} workflow runs of ${repository}`;
				const response = await this.request('GET', `${base}/runs?status=${status}&per_page=${MAX_RUNS_PER_STATUS}`, token, {
					what,
					// One ETag per target: the queued list of the only (or first) repository.
					etag: repositories.length === 1 && status === 'queued' ? options.etag : null
				});
				if (response.status === 304) {
					meta = { ...meta, notModified: true, etag: options.etag ?? null };
					continue;
				}
				if (!response.ok) {
					const refusal = await refusalOf(response, what);
					if (refusal.code === 'rate_limited') return { ...meta, rateLimitedUntil: refusal.rateLimitedUntil, jobs };
					throw refusal;
				}
				if (repositories.length === 1 && status === 'queued') meta = this.meta(response);
				const body = (await response.json()) as { workflow_runs?: unknown };
				const runs = Array.isArray(body?.workflow_runs) ? (body.workflow_runs as Array<Record<string, unknown>>) : [];
				for (const run of runs) {
					const runId = num(run.id);
					if (runId === null) continue;
					const jobsWhat = `the jobs of workflow run ${runId}`;
					const jobsResponse = await this.request('GET', `${base}/runs/${runId}/jobs?filter=latest&per_page=100`, token, {
						what: jobsWhat
					});
					if (!jobsResponse.ok) {
						const refusal = await refusalOf(jobsResponse, jobsWhat);
						if (refusal.code === 'rate_limited') return { ...meta, rateLimitedUntil: refusal.rateLimitedUntil, jobs };
						continue;
					}
					const jobsBody = (await jobsResponse.json()) as { jobs?: unknown };
					const rows = Array.isArray(jobsBody?.jobs) ? (jobsBody.jobs as Array<Record<string, unknown>>) : [];
					for (const raw of rows) {
						const job = toJob(raw, repository, run);
						if (job) jobs.push(job);
					}
				}
			}
		}
		return { ...meta, notModified: meta.notModified && jobs.length === 0, jobs };
	}

	async cancelRun(repository: string, runId: number, token: string): Promise<void> {
		if (!Number.isSafeInteger(runId) || runId <= 0) throw new ActionsRunnersApiError('not a workflow run id', 'failed', null);
		const [owner, repo] = splitRepository(repository);
		const what = `workflow run ${runId} of ${repository}`;
		const response = await this.request(
			'POST',
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/cancel`,
			token,
			{ what }
		);
		if (!response.ok) throw await refusalOf(response, what);
	}

	/** A cheap read of the target's runners: 2xx → allowed; 401 / 403 / 404 → the permission is missing. */
	async canManage(target: ActionsRunnerTarget, token: string): Promise<boolean> {
		const response = await this.request('GET', `${runnersPath(target)}?per_page=1`, token, { what: 'the runner list' });
		if (response.ok) return true;
		const refusal = await refusalOf(response, 'the runner list');
		if (refusal.code === 'permission' || refusal.code === 'not_found') return false;
		throw refusal;
	}
}

/** One job of a workflow run, when it is queued or in progress AND targets self-hosted runners. */
export function toJob(raw: Record<string, unknown>, repository: string, run: Record<string, unknown>): ActionsJob | null {
	const status = raw.status === 'queued' || raw.status === 'in_progress' ? raw.status : null;
	const jobId = num(raw.id);
	const runId = num(raw.run_id) ?? num(run.id);
	if (!status || jobId === null || runId === null) return null;
	const labels = Array.isArray(raw.labels) ? (raw.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
	if (!labels.some((label) => label.toLowerCase() === 'self-hosted')) return null;
	return {
		repository,
		runId,
		runNumber: num(run.run_number),
		jobId,
		name: str(raw.name) ?? `job ${jobId}`,
		workflowName: str(raw.workflow_name) ?? str(run.name),
		labels,
		status,
		runnerName: str(raw.runner_name),
		runnerId: num(raw.runner_id),
		startedAt: status === 'in_progress' ? str(raw.started_at) : null,
		queuedAt: str(raw.created_at) ?? str(run.created_at),
		url: str(raw.html_url)
	};
}
