/**
 * APW-05 T12 — the narrow Actions API this plugin needs, and nothing else.
 *
 * ## Why a port, when `octokit` is already a dependency
 *
 * The same reason `RepositorySecretPort` is one (`repo/secret-sync.ts:58`): a
 * fake is a few lines, so every rule in `run-correlator.ts` and
 * `run-observer.ts` — the adoption window, the minutes rounding, "only the
 * `build` job decides status" — is provable against recorded GitHub shapes
 * without a socket, a token or a recorded-cassette harness. The port is the
 * seam; {@link octokitActionsRunsPort} is the one implementation, and it is a
 * thin call-through with no logic of its own to test.
 *
 * Octokit rather than hand-rolled `fetch`: it is the official SDK, it is already
 * in this package's dependencies, and it handles the redirect-following that
 * `GET actions/jobs/{id}/logs` needs (plan §4.8's logs tail).
 *
 * ## Shapes are the subset this plugin reads
 *
 * Each interface below names only the fields the correlator, the observer or the
 * artifact reader actually use. That is deliberate: a wider type would invite a
 * reader to assume a field is handled when nothing reads it, and GitHub's run
 * payload is large enough that "the fields we use" is genuinely useful
 * documentation.
 */

/** One workflow run, as this plugin reads it (`GET /repos/{o}/{r}/actions/runs/{id}`). */
export interface ActionsRun {
	readonly id: number;
	/** `queued` · `in_progress` · `completed` — GitHub's own vocabulary, mapped by the observer. */
	readonly status: string | null;
	readonly conclusion: string | null;
	readonly run_attempt?: number | null;
	/** What the generated workflow's `run-name:` produced — the correlation key (plan §4.8). */
	readonly display_title?: string | null;
	readonly name?: string | null;
	readonly event?: string | null;
	readonly head_branch?: string | null;
	readonly head_sha?: string | null;
	readonly html_url?: string | null;
	readonly created_at?: string | null;
	readonly run_started_at?: string | null;
	readonly updated_at?: string | null;
	readonly pull_requests?: ReadonlyArray<{ readonly number?: number | null }> | null;
}

/** One job of a run (`GET /repos/{o}/{r}/actions/runs/{id}/jobs`). */
export interface ActionsJob {
	readonly id: number;
	readonly name: string;
	readonly status?: string | null;
	readonly conclusion?: string | null;
	readonly started_at?: string | null;
	readonly completed_at?: string | null;
	readonly html_url?: string | null;
	readonly labels?: readonly string[] | null;
	readonly steps?: ReadonlyArray<{
		readonly name?: string | null;
		readonly number?: number | null;
		readonly conclusion?: string | null;
	}> | null;
}

/** One artifact of a run (`GET /repos/{o}/{r}/actions/runs/{id}/artifacts`). */
export interface ActionsArtifact {
	readonly id: number;
	readonly name: string;
	readonly size_in_bytes?: number | null;
	readonly expired?: boolean | null;
}

/** The repository coordinates every call below takes. */
export interface ActionsRepositoryRef {
	readonly owner: string;
	readonly repo: string;
}

/**
 * The Actions operations APW-05 T12 needs.
 *
 * Every method may reject; the plugin turns a rejection into a throw, never into
 * a `null` "no such run" — those are different answers and the contract
 * (`IBuildPlugin.getBuild`) says so in its own docstring.
 */
export interface ActionsRunsPort {
	/**
	 * `POST /repos/{o}/{r}/actions/workflows/{file}/dispatches` — 204, no body.
	 *
	 * GitHub answers a dispatch with no run id: the run is found afterwards, by
	 * `display_title`, which is what {@link ActionsRunsPort.listWorkflowRuns} and
	 * the correlator are for.
	 */
	dispatchWorkflow(input: {
		readonly repository: ActionsRepositoryRef;
		readonly workflowFile: string;
		readonly ref: string;
		readonly inputs: Record<string, string>;
	}): Promise<void>;

	/** `GET /repos/{o}/{r}/actions/workflows/{file}/runs`, newest first. */
	listWorkflowRuns(input: {
		readonly repository: ActionsRepositoryRef;
		readonly workflowFile: string;
		readonly perPage: number;
		readonly headSha?: string;
		readonly event?: string;
	}): Promise<readonly ActionsRun[]>;

	/** `GET /repos/{o}/{r}/actions/runs/{id}`. `null` when GitHub answers 404. */
	getWorkflowRun(input: {
		readonly repository: ActionsRepositoryRef;
		readonly runId: number;
	}): Promise<ActionsRun | null>;

	/** `GET /repos/{o}/{r}/actions/runs/{id}/jobs` (all attempts of the latest run attempt). */
	listRunJobs(input: {
		readonly repository: ActionsRepositoryRef;
		readonly runId: number;
	}): Promise<readonly ActionsJob[]>;

	/** `POST /repos/{o}/{r}/actions/runs/{id}/cancel`. A run that is already finished is not an error. */
	cancelWorkflowRun(input: { readonly repository: ActionsRepositoryRef; readonly runId: number }): Promise<void>;

	/** `GET /repos/{o}/{r}/actions/runs/{id}/artifacts`. */
	listRunArtifacts(input: {
		readonly repository: ActionsRepositoryRef;
		readonly runId: number;
	}): Promise<readonly ActionsArtifact[]>;

	/**
	 * `GET /repos/{o}/{r}/actions/artifacts/{id}/zip`, following the redirect.
	 *
	 * Answers the raw zip bytes. The caller enforces the size cap BEFORE
	 * unzipping (plan §4.8: "≤ 64 KB, refuse larger") — this port does not,
	 * because a port that silently truncated would make the cap untestable.
	 */
	downloadArtifactZip(input: {
		readonly repository: ActionsRepositoryRef;
		readonly artifactId: number;
	}): Promise<Uint8Array>;
}

/** The subset of Octokit's surface this adapter uses, so the adapter is typed without importing Octokit's generics. */
interface OctokitLike {
	request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

/**
 * The one real implementation: a call-through onto Octokit's generic `request`.
 *
 * Generic `request` rather than the typed `rest.actions.*` namespace on purpose —
 * the typed namespace pins response shapes to the `@octokit/openapi-types`
 * version installed, and this package reads seven fields across four endpoints.
 * The route strings below ARE the documentation, and they match plan §4.8 line
 * for line.
 */
export function octokitActionsRunsPort(octokit: OctokitLike): ActionsRunsPort {
	const asArray = <T>(data: unknown, key: string): readonly T[] => {
		const bag = data as Record<string, unknown> | null;
		const list = bag?.[key];
		return Array.isArray(list) ? (list as T[]) : [];
	};

	return {
		async dispatchWorkflow({ repository, workflowFile, ref, inputs }) {
			await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
				owner: repository.owner,
				repo: repository.repo,
				workflow_id: workflowFile,
				ref,
				inputs
			});
		},

		async listWorkflowRuns({ repository, workflowFile, perPage, headSha, event }) {
			const params: Record<string, unknown> = {
				owner: repository.owner,
				repo: repository.repo,
				workflow_id: workflowFile,
				per_page: perPage
			};
			if (headSha) params.head_sha = headSha;
			if (event) params.event = event;

			const { data } = await octokit.request(
				'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
				params
			);
			return asArray<ActionsRun>(data, 'workflow_runs');
		},

		async getWorkflowRun({ repository, runId }) {
			try {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
					owner: repository.owner,
					repo: repository.repo,
					run_id: runId
				});
				return (data ?? null) as ActionsRun | null;
			} catch (error) {
				// A 404 is "no such run", which the contract says is `null`. Every
				// other status is a failure to observe, which is a throw.
				if ((error as { status?: number }).status === 404) return null;
				throw error;
			}
		},

		async listRunJobs({ repository, runId }) {
			const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
				owner: repository.owner,
				repo: repository.repo,
				run_id: runId,
				per_page: 100
			});
			return asArray<ActionsJob>(data, 'jobs');
		},

		async cancelWorkflowRun({ repository, runId }) {
			try {
				await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {
					owner: repository.owner,
					repo: repository.repo,
					run_id: runId
				});
			} catch (error) {
				// 409 is GitHub's "this run is not cancellable" — it has already
				// finished. Cancelling a finished run is a no-op, not a failure,
				// and the caller asked for it to stop, which it has.
				if ((error as { status?: number }).status === 409) return;
				throw error;
			}
		},

		async listRunArtifacts({ repository, runId }) {
			const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
				owner: repository.owner,
				repo: repository.repo,
				run_id: runId,
				per_page: 100
			});
			return asArray<ActionsArtifact>(data, 'artifacts');
		},

		async downloadArtifactZip({ repository, artifactId }) {
			const { data } = await octokit.request(
				'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}',
				{
					owner: repository.owner,
					repo: repository.repo,
					artifact_id: artifactId,
					archive_format: 'zip'
				}
			);
			return new Uint8Array(data as ArrayBuffer);
		}
	};
}
