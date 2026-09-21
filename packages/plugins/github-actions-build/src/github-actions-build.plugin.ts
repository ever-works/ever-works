import type {
	BuildAuth,
	BuildRef,
	BuildSnapshot,
	BuildStrategy,
	IBuildPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginManifest,
	PrepareRepositoryInput,
	PrepareRepositoryResult,
	RepositoryWriter,
	StartBuildInput
} from '@ever-works/plugin';
import { APP_BUILD_WORKFLOW_PATH, type AppBuildKind } from '@ever-works/contracts';
import { Octokit } from 'octokit';

import { octokitActionsRunsPort, type ActionsRepositoryRef, type ActionsRunsPort } from './runs/actions-runs.port.js';
import { correlateDispatchedRun } from './runs/run-correlator.js';
import { observeRun } from './runs/run-observer.js';
import { readResultArtifact } from './runs/result-artifact.js';

import { gitHubActionsBuildSettingsSchema, type GitHubActionsBuildSettings } from './settings.schema.js';

/**
 * APW-05 T7 — the `github-actions-build` plugin: the identity the platform's
 * discovery path and the `build` capability need, the settings of plan §4.4, and
 * the members T8–T10 have not reached yet.
 *
 * What exists here:
 *
 *   - the manifest the `everworks.plugin` block in `package.json` also declares
 *     (they must agree — `plugin-manifest-validator.service.ts` extracts the
 *     block from disk and `plugin-class-validator.service.ts` compares the loaded
 *     class against it);
 *   - `settingsSchema` — plan §4.4, with `pullToken` `x-secret` and both
 *     platform-managed markers (`APW05-G07`);
 *   - the two lifecycle hooks the loader calls. Both are **prototype methods on
 *     purpose**: `PluginClassValidatorService.isPluginClass` accepts a class only
 *     when `onLoad` and `onUnload` sit on its prototype, so an arrow-function
 *     property would make this plugin undiscoverable.
 *
 * ## Which `IBuildPlugin` members work, and which still throw (Constitution VI,
 * ## Rule: a capability a plugin claims, it implements — no member pretends)
 *
 * **Four of the five are implemented (T12, 2026-09-21.)** The fifth still throws
 * {@link notImplemented} naming the task that fills it, and it throws rather than
 * returning a plausible answer on purpose: there is no stub that would "succeed"
 * at preparing a repository before the code that does it exists.
 *
 * | Member                | State                                           | Detail                                                                                                    |
 * | --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
 * | `prepareRepository`   | **throws** — T11 and T41 own what is missing    | T8 generator, T9 writer and T10 secret sync landed; the `runs-on` label/class (T11) and the `checks` job (T41) have not. T16 binds the `RepositoryWriter` and T19 calls it |
 * | `startBuild`          | **implemented (T12)**                           | dispatches the generated file on the TRACKED branch with `ew_build_id` / `ew_sha` / `ew_mode` and the two optional inputs, then correlates once |
 * | `getBuild`            | **implemented (T12)**                           | run + jobs → `BuildSnapshot` via `runs/run-observer.ts`, plus the result artifact for a finished run. T43 fills `verification`; T13's classifier fills `failure` |
 * | `cancelBuild`         | **implemented (T12)**                           | resolves the same run `getBuild` would, then the cancel endpoint                                          |
 * | `getLogsUrl`          | **implemented (T12)**                           | the run's own page                                                                                        |
 *
 * What T12 deliberately did NOT do, so nobody reads the table above as more than
 * it says: the **404/422 retry after a bootstrap commit** (a just-written
 * workflow file is briefly undispatchable — `APW05-G02`) is not implemented, and
 * `getBuild` attaches no `failure` block, because the log tail and the classifier
 * are T13's. A digest read from the artifact is reported `confirmed: false`
 * always; confirming it against the registry is `checkImageAccess` (T14).
 *
 * `listRecentRuns?` (T12's run discovery, §7.4a) and `checkImageAccess?` (T14)
 * are still deliberately **not declared**: both are optional on the contract and
 * a caller materialises the member before calling it, so declaring a throwing
 * placeholder would buy nothing and would tell a future reader the capability is
 * wired when it is not.
 */
export class GitHubActionsBuildPlugin implements IBuildPlugin {
	readonly id = 'github-actions-build';
	readonly name = 'GitHub Actions builds';
	readonly version = '1.0.0';

	/**
	 * Plan §4.3: the `build` category — appended to `PLUGIN_CATEGORIES` by APW-05
	 * T3 (`packages/plugin/src/contracts/plugin-manifest.types.ts`), so the
	 * loader's own `isPluginCategory` gate accepts this manifest.
	 */
	readonly category: PluginCategory = 'build';

	/** Plan §4.3: exactly one capability. `isBuildPlugin` resolves this plugin on it. */
	readonly capabilities: readonly string[] = ['build'];

	/** Plan §4.3. `AppBuildKind` — a closed union in `@ever-works/contracts`. */
	readonly buildKind: AppBuildKind = 'github-actions';

	/**
	 * Plan §4.1/R-13: `dockerfile` only.
	 *
	 * `auto` is deliberately absent: the zero-config builder is a provider-internal
	 * choice this plugin does not have, so the strategy gate leaves that Build
	 * unstarted (`strategyNotSupported`) rather than half-built. `image` and `none`
	 * are absent for the same reason — they need no build at all, and the prepare
	 * runner handles them before a build plugin is asked (plan §7.2).
	 */
	readonly supportedStrategies: readonly BuildStrategy[] = ['dockerfile'];

	/** Work-scoped settings, like the other per-Work provider plugins. */
	readonly configurationMode = 'user-required';

	/** Plan §4.4, exactly. */
	readonly settingsSchema: JsonSchema = gitHubActionsBuildSettingsSchema;

	async onLoad(context: PluginContext): Promise<void> {
		// No resources to hold: the GitHub client is bound per call from the
		// facade's auth, and nothing here reaches the network.
		context.logger.log('GitHub Actions build plugin loaded');
	}

	async onUnload(): Promise<void> {
		// Symmetric with onLoad: nothing is held, so nothing is released.
	}

	/**
	 * The Actions API this plugin talks to, bound per call from the caller's auth.
	 *
	 * `protected` and a method, not a constructor seam: the loader constructs a
	 * plugin with **no arguments** (`PluginLoaderService.loadPluginModule` —
	 * `new PluginClass()`), so anything a spec wants to replace has to be
	 * replaceable on the instance. A spec subclasses and overrides this; production
	 * gets Octokit, which is the official SDK and already this package's dependency.
	 *
	 * A fresh client per call, deliberately: `auth.token` is resolved per call by
	 * the facade (plan §4.1) and may be a different member's installation token
	 * from one call to the next. Caching one would be caching a credential.
	 */
	protected actionsPort(auth: BuildAuth): ActionsRunsPort {
		return octokitActionsRunsPort(new Octokit({ auth: auth.token }));
	}

	/** The clock, as a seam, so the correlation window is provable without waiting. */
	protected now(): number {
		return Date.now();
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				"Builds the App Work's container image on GitHub-hosted runners, through the workflow Ever Works writes into the repository's tracked branch",
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: true,
			visibility: 'user-only'
		};
	}

	// IBuildPlugin -----------------------------------------------------------
	// Every member is declared and none pretends: see the class docstring for the
	// task each one waits on.

	async prepareRepository(
		_input: PrepareRepositoryInput,
		_auth: BuildAuth,
		_writer: RepositoryWriter
	): Promise<PrepareRepositoryResult> {
		throw notImplemented('prepareRepository', 'APW-05 T11 (runner selector) and T41 (checks job)');
	}

	/**
	 * APW-05 T12 — dispatch the generated workflow on the App Work's tracked branch.
	 *
	 * ## `providerRunId` is `null` here, and that is not a failure
	 *
	 * `POST .../dispatches` answers **204 with no body**: GitHub says nothing about
	 * the run it just created. So this method dispatches, records the instant, and
	 * makes ONE correlation attempt; the run is usually not listed that fast, and a
	 * `null` id is the normal answer. `app-build-watch` polls `getBuild`, which
	 * correlates again on every poll. Blocking here until a run appeared would hold
	 * the caller's request open for an arbitrary provider delay.
	 *
	 * ## The branch is the tracked branch, never the caller's ref
	 *
	 * FR-14: a Build may only run for the App Work's tracked branch. `input.ref` is
	 * what to BUILD; `repository.trackedBranch` is where the workflow file lives and
	 * the only `ref` a dispatch is allowed to name. Passing `input.ref` would let a
	 * Build run a workflow file from a branch nobody reviewed.
	 */
	async startBuild(
		input: StartBuildInput,
		auth: BuildAuth
	): Promise<{ providerRunId: string | null; dispatchedAt: string }> {
		const port = this.actionsPort(auth);
		const repository: ActionsRepositoryRef = {
			owner: input.repository.owner,
			repo: input.repository.repo
		};

		// Only non-empty inputs are sent: GitHub rejects a `workflow_dispatch` whose
		// inputs object names something the file does not declare, and an empty
		// string is how the generated file spells "absent" in its `if:` guards.
		const inputs: Record<string, string> = {
			ew_build_id: input.buildId,
			ew_sha: input.sha,
			ew_mode: input.mode
		};
		if (input.reuseImageDigest) inputs.ew_reuse_digest = input.reuseImageDigest;
		if (input.verification?.json) inputs.ew_verify_plan = input.verification.json;

		const dispatchedAtMs = this.now();
		await port.dispatchWorkflow({
			repository,
			workflowFile: WORKFLOW_FILE_NAME,
			ref: input.repository.trackedBranch,
			inputs
		});

		const correlated = await correlateDispatchedRun(port, {
			repository,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: input.buildId,
			dispatchedAtMs
		});

		return {
			providerRunId: correlated.providerRunId,
			dispatchedAt: new Date(dispatchedAtMs).toISOString()
		};
	}

	/**
	 * APW-05 T12 — observe one run.
	 *
	 * Correlates first when the ref carries no `providerRunId`: a Build dispatched
	 * moments ago has none, and the watch job's whole purpose is to find it. `null`
	 * means "no such run" — never "I could not tell", which the contract says is a
	 * throw, and which is why a failed API call is not caught here.
	 *
	 * `redact` is APW-07's redactor for this App Work. It is applied to every
	 * excerpt before it leaves this method; today the snapshot carries none (the log
	 * tail is T13's classifier), and it is accepted and threaded so the call site
	 * cannot forget it when T13 lands.
	 */
	async getBuild(ref: BuildRef, auth: BuildAuth, _redact: (text: string) => string): Promise<BuildSnapshot | null> {
		const port = this.actionsPort(auth);
		const repository: ActionsRepositoryRef = {
			owner: ref.repository.owner,
			repo: ref.repository.repo
		};

		const runId = await this.resolveRunId(port, ref, repository);
		if (runId === null) return null;

		const run = await port.getWorkflowRun({ repository, runId });
		if (!run) return null;

		const jobs = await port.listRunJobs({ repository, runId });
		const snapshot = observeRun({ run, jobs, mode: 'build' });

		// The result artifact is read only for a finished run: an unfinished one has
		// not uploaded it, and asking would spend a request per poll to learn that.
		if (snapshot.status !== 'queued' && snapshot.status !== 'running') {
			const artifact = await readResultArtifact(port, { repository, runId });
			if (artifact.ok) {
				return {
					...snapshot,
					// `confirmed: false` without exception. This plugin reads the digest
					// the member's own CI claimed; confirming it against the registry is
					// `checkImageAccess` (T14), and a plugin that marked its own input
					// confirmed would make plan §4.8's "never believed" untrue.
					image: {
						repository: artifact.result.imageRepository ?? '',
						digest: artifact.result.digest,
						tags: [...(artifact.result.tags ?? [])],
						confirmed: false
					},
					...(artifact.result.secretCheck ? { secretCheck: artifact.result.secretCheck } : {})
				};
			}
		}

		return snapshot;
	}

	/**
	 * The run this ref addresses: the one it names, or the one correlation finds.
	 *
	 * Shared by `getBuild`, `cancelBuild` and `getLogsUrl` so all three agree about
	 * which run a ref means — a cancel that addressed a different run from the
	 * observation would stop the wrong Build.
	 */
	private async resolveRunId(
		port: ActionsRunsPort,
		ref: BuildRef,
		repository: ActionsRepositoryRef
	): Promise<number | null> {
		if (ref.providerRunId) {
			const parsed = Number(ref.providerRunId);
			return Number.isFinite(parsed) ? parsed : null;
		}

		const dispatchedAtMs = ref.dispatchedAt ? Date.parse(ref.dispatchedAt) : this.now();
		const correlated = await correlateDispatchedRun(port, {
			repository,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: ref.buildId,
			dispatchedAtMs: Number.isNaN(dispatchedAtMs) ? this.now() : dispatchedAtMs
		});
		return correlated.providerRunId === null ? null : Number(correlated.providerRunId);
	}

	/**
	 * APW-05 T12 — stop the run.
	 *
	 * A ref that resolves to no run is a no-op rather than a throw: the caller asked
	 * for the Build to stop, and a Build with no run has stopped. The port swallows
	 * GitHub's 409 ("not cancellable") for the same reason — a finished run is not a
	 * failed cancel.
	 */
	async cancelBuild(ref: BuildRef, auth: BuildAuth): Promise<void> {
		const port = this.actionsPort(auth);
		const repository: ActionsRepositoryRef = {
			owner: ref.repository.owner,
			repo: ref.repository.repo
		};
		const runId = await this.resolveRunId(port, ref, repository);
		if (runId === null) return;
		await port.cancelWorkflowRun({ repository, runId });
	}

	/** APW-05 T12 — the run's own page, which is where a member reads its logs. */
	async getLogsUrl(ref: BuildRef, auth: BuildAuth): Promise<string | null> {
		const port = this.actionsPort(auth);
		const repository: ActionsRepositoryRef = {
			owner: ref.repository.owner,
			repo: ref.repository.repo
		};
		const runId = await this.resolveRunId(port, ref, repository);
		if (runId === null) return null;
		const run = await port.getWorkflowRun({ repository, runId });
		return run?.html_url ?? null;
	}
}

/**
 * The workflow file a dispatch names.
 *
 * GitHub's `workflow_id` path parameter accepts the FILE NAME, not the path, so
 * this is `APP_BUILD_WORKFLOW_PATH`'s last segment rather than a second literal:
 * the generator writes the file at that path, and the two cannot drift.
 */
export const WORKFLOW_FILE_NAME = APP_BUILD_WORKFLOW_PATH.split('/').pop() as string;

/**
 * The error every unimplemented member throws.
 *
 * One shape and one message format, so a caller can tell "this plugin does not
 * do that yet" from a provider failure — and so the message names the task that
 * will make it true rather than a bare "not implemented".
 */
export function notImplemented(member: string, owner: string): Error {
	return new Error(`github-actions-build: ${member} is not implemented yet — ${owner} owns it.`);
}

/** The settings shape this plugin reads once resolved (plan §4.4). Re-exported for the facade's binding. */
export type { GitHubActionsBuildSettings };

export default GitHubActionsBuildPlugin;
