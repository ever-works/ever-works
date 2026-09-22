import type {
	AppBuildBlock,
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
import { APP_BUILD_WORKFLOW_PATH, computeBuildInputsHash, type AppBuildKind } from '@ever-works/contracts';
import { Octokit } from 'octokit';

import { octokitActionsRunsPort, type ActionsRepositoryRef, type ActionsRunsPort } from './runs/actions-runs.port.js';
import { correlateDispatchedRun } from './runs/run-correlator.js';
import { observeRun } from './runs/run-observer.js';
import { readResultArtifact } from './runs/result-artifact.js';
import { checkImageAccess as checkGhcrAccess, type GhcrAccessResult, type GhcrFetch } from './registry/ghcr-access.js';
import { selectRunner } from './runner/runner-selector.js';
import { generateWorkflow } from './workflow/generator.js';
import { writeWorkflow } from './repo/workflow-writer.js';
import { createBuildValueSecretSync, type RepositorySecretPort } from './repo/secret-sync.js';

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
 * ## Every `IBuildPlugin` member is implemented (Constitution VI, Rule: a
 * ## capability a plugin claims, it implements — no member pretends)
 *
 * **All five, as of 2026-09-22.** T12 did four on 2026-09-21; T11's runner
 * selector landed the next day, T41's checks job turned out to be already
 * written, and §4.6 could then be composed — so `prepareRepository` is the last
 * one and the `notImplemented` list is empty.
 *
 * | Member                | Detail                                                                                                    |
 * | --------------------- | ----------------------------------------------------------------------------------------------------------- |
 * | `prepareRepository`   | §4.6: select the runner (T11), generate the file (T8) with the checks job (T41), deliver it (T9), then sync the build values (T10) — in that order, so nothing reaches a member's repository until it is known the Build could run |
 * | `startBuild`          | dispatches the generated file on the TRACKED branch with `ew_build_id` / `ew_sha` / `ew_mode` and the two optional inputs, then correlates once |
 * | `getBuild`            | run + jobs → `BuildSnapshot` via `runs/run-observer.ts`, plus the result artifact for a finished run. T43 fills `verification` |
 * | `cancelBuild`         | resolves the same run `getBuild` would, then the cancel endpoint                                          |
 * | `getLogsUrl`          | the run's own page                                                                                        |
 *
 * What is deliberately still NOT done, so nobody reads the table above as more
 * than it says:
 *
 *   - the **404/422 retry after a bootstrap commit** (`APW05-G02`) — a
 *     just-written workflow file is briefly undispatchable;
 *   - `getBuild` attaches no `failure` block. `runs/failure-classifier.ts` (T13)
 *     exists and is tested, but nothing fetches the failing job's LOG yet, and a
 *     classifier with no log to read would report `unknown` for everything;
 *   - a digest read from the artifact is reported `confirmed: false` **always**.
 *     Confirming it is `checkImageAccess` (T14, below) and the comparison belongs
 *     to the caller.
 *
 * `checkImageAccess?` (T14) IS declared now, because it does something: it reads
 * the manifest anonymously, then with the pull token, and checks that token's
 * scopes through `GET /user`. It is the confirming half of §4.8's "only ever
 * confirmed, never believed" — `getBuild` still reports an artifact digest as
 * `confirmed: false` always, and the caller does the comparison, because it is
 * the only party holding both the Build row and the `pullToken` setting.
 *
 * `listRecentRuns?` (T12's run discovery, §7.4a) is still deliberately **not
 * declared**: it is optional on the contract and a caller materialises the member
 * before calling it, so declaring a throwing placeholder would buy nothing and
 * would tell a future reader the capability is wired when it is not.
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

	/**
	 * APW-05 §4.6 — put the workflow (and the build values) where a Build can use them.
	 *
	 * Four steps, in this order, and the order is the point: nothing is written to a
	 * member's repository until it is known the Build could run at all.
	 *
	 *  1. **Select the runner** (T11). A declared memory the chosen runner cannot
	 *     give is `runnerTooSmall`, and it BLOCKS here — before a commit, before a
	 *     secret, before anything reaches GitHub. The alternative is writing a
	 *     workflow that is guaranteed to be OOM-killed minutes into its first run.
	 *  2. **Generate the file** (T8), with the checks job (T41) when the spec
	 *     declares checks and the verify job when the App Work can verify.
	 *  3. **Deliver it** (T9): unchanged, committed, or a pull request for a
	 *     repository that is not ours to write into (R-4). A hand-edited file is
	 *     `editedByHand` and is never overwritten.
	 *  4. **Sync the build values** (T10), and only then — a secret written for a
	 *     workflow that was never delivered is a secret nobody will clean up.
	 *
	 * ## The two failure shapes, kept apart
	 *
	 * A `blocked` result is a Build that will not start and a member who is told
	 * why. A THROW is this plugin failing at its own job. `writeWorkflow`'s own
	 * `'blocked'` state is mapped onto `PrepareRepositoryResult.blocked` rather than
	 * passed through, because that state is the writer's and is not one of the five
	 * the contract's `workflow.state` allows — the writer's docstring says so, and
	 * storing it would put a value in the database that no reader understands.
	 *
	 * ## `contentSha256` is stored only after a matching read-back
	 *
	 * `storedWorkflowSha256` is `null` until the writer has PROVEN the tracked
	 * branch holds the generated bytes (FR-8). Reporting the hash of what we sent,
	 * rather than of what is there, is how a failed write becomes an unnoticed
	 * hand-edit detection failure on the next preparation.
	 */
	async prepareRepository(
		input: PrepareRepositoryInput,
		auth: BuildAuth,
		writer: RepositoryWriter
	): Promise<PrepareRepositoryResult> {
		const settings = (input.settings ?? {}) as GitHubActionsBuildSettings;

		// 1 · the runner, before anything is written anywhere.
		const selection = selectRunner({
			visibility: input.repository.visibility,
			resources: resourcesOf(input.build ?? null),
			settings
		});
		if (!selection.ok) {
			return {
				workflow: { state: 'unchanged', contentSha256: '' },
				secretsWritten: [],
				secretsRemoved: [],
				buildInputsHash: computeBuildInputsHash(input.values ?? []),
				blocked: {
					reason: selection.blocked.reason,
					detail: { needed: selection.blocked.needed, max: selection.blocked.max }
				}
			};
		}

		// 2 · the file.
		const content = generateWorkflow({
			trackedBranch: input.repository.trackedBranch,
			repository: {
				owner: input.repository.owner,
				repo: input.repository.repo,
				visibility: input.repository.visibility
			},
			appSpecHash: input.appSpecHash,
			build: input.build ?? null,
			values: input.values ?? [],
			runner: { label: selection.runner.label, class: selection.runner.runnerClass },
			settings: {
				reclaimDisk: settings.reclaimDisk,
				attestations: settings.attestations,
				allowBuildValuesOnPullRequests: settings.allowBuildValuesOnPullRequests,
				verificationPromptedValuesRequireApproval: settings.verificationPromptedValuesRequireApproval
			},
			// A Build that has no `build` block cannot be verified in the runner; the
			// verify job would have nothing to run.
			verifyEnabled: Boolean(input.build),
			checks: input.checks ?? []
		});

		// 3 · the delivery.
		const written = await writeWorkflow(
			{
				repository: {
					owner: input.repository.owner,
					repo: input.repository.repo,
					trackedBranch: input.repository.trackedBranch,
					createdByAppWork: input.repository.createdByAppWork
				},
				content,
				lastWrittenWorkflowSha256: input.lastWrittenWorkflowSha256
			},
			writer
		);

		if (written.state === 'blocked') {
			return {
				workflow: { state: 'unchanged', contentSha256: written.storedWorkflowSha256 ?? '' },
				secretsWritten: [],
				secretsRemoved: [],
				buildInputsHash: computeBuildInputsHash(input.values ?? []),
				blocked: {
					reason: written.blocked?.reason ?? 'workflowWriteFailed',
					detail: { cause: written.blocked?.detail.cause ?? 'unknown' }
				}
			};
		}

		// 4 · the build values, only now that the workflow is really there.
		const sync = createBuildValueSecretSync({ port: this.secretPort(auth, input.repository) });
		const synced = await sync.syncBuildValues({
			values: input.values ?? [],
			previouslyWrittenSecretNames: input.previouslyWrittenSecretNames ?? []
		});

		return {
			workflow: {
				state: written.state,
				...(written.commitSha ? { commitSha: written.commitSha } : {}),
				...(written.pullRequestUrl ? { pullRequestUrl: written.pullRequestUrl } : {}),
				// Only a matching read-back sets this — see the docstring.
				contentSha256: written.storedWorkflowSha256 ?? ''
			},
			secretsWritten: synced.secretsWritten ?? [],
			secretsRemoved: synced.secretsRemoved ?? [],
			buildInputsHash: synced.buildInputsHash ?? computeBuildInputsHash(input.values ?? []),
			...(synced.blocked ? { blocked: synced.blocked } : {})
		};
	}

	/**
	 * The repository-secret operations T10's sync needs, over Octokit.
	 *
	 * A seam for the same reason {@link actionsPort} is one: the loader constructs
	 * this class with no arguments, so a spec replaces it on the instance.
	 */
	protected secretPort(
		auth: BuildAuth,
		repository: { readonly owner: string; readonly repo: string }
	): RepositorySecretPort {
		const octokit = new Octokit({ auth: auth.token });
		const base = { owner: repository.owner, repo: repository.repo };
		return {
			getRepoPublicKey: async () => {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', base);
				return data as { key_id: string; key: string };
			},
			putRepoSecret: async ({ name, encryptedValue, keyId }) => {
				await octokit.request('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
					...base,
					secret_name: name,
					encrypted_value: encryptedValue,
					key_id: keyId
				});
			},
			deleteRepoSecret: async ({ name }) => {
				await octokit.request('DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
					...base,
					secret_name: name
				});
			}
		};
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

	/**
	 * APW-05 T14 — can this installation read the image, and is its pull token the
	 * right shape?
	 *
	 * Declared now that it does something. It stayed undeclared while it did not,
	 * because the contract makes it optional and a caller materialises the member
	 * before calling it — so a throwing placeholder would have told a reader the
	 * capability was wired when it was not.
	 *
	 * This is the **confirming** half of plan §4.8's "only ever confirmed, never
	 * believed". `getBuild` reports the digest the member's own CI claimed with
	 * `confirmed: false`, always; comparing it against the digest this method reads
	 * from the registry is what makes it true, and that comparison belongs to the
	 * caller, which is the only party holding both the Build row and the
	 * installation's `pullToken` setting (`getBuild(ref, auth)` is given neither).
	 */
	async checkImageAccess(input: {
		readonly imageRepository: string;
		readonly tag: string;
		readonly pullToken?: string;
	}): Promise<GhcrAccessResult> {
		return checkGhcrAccess(input, this.registryFetch());
	}

	/**
	 * The registry/API HTTP seam.
	 *
	 * `redirect: 'manual'` is set by `ghcr-access.ts` on every request and passed
	 * straight through here: a 3xx followed with the `Authorization` header still
	 * attached is how a pull token reaches a host that is neither `api.github.com`
	 * nor `ghcr.io`, and that module's spec watches every call for exactly that.
	 */
	protected registryFetch(): GhcrFetch {
		return (url, init) => fetch(url, init as RequestInit);
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
 * `build.resources`, as the runner selector reads it.
 *
 * The contract's own names and no others: `AppBuildBlock.resources` is
 * `{ cpu, memoryGiB?, timeoutMinutes }` (`build.interface.ts:141`). An earlier
 * draft also accepted `memory` and `vcpu` as aliases; they are removed, because
 * a fallback for a spelling the contract does not have tells the next reader
 * that both exist — and quietly accepts a typo that should have failed
 * validation long before it reached a build plugin.
 *
 * `memoryGiB` is optional on the contract, and absent means "the runner's
 * maximum" — it never blocks (APW05-G14), which is what {@link selectRunner}
 * already does with `undefined`. `build` itself is nullable for the bootstrap
 * file of plan §4.6 step 0.
 */
function resourcesOf(build: AppBuildBlock | null | undefined): { memoryGiB?: number; vcpu?: number } | undefined {
	const resources = build?.resources;
	if (!resources) return undefined;
	return {
		...(typeof resources.memoryGiB === 'number' ? { memoryGiB: resources.memoryGiB } : {}),
		...(typeof resources.cpu === 'number' ? { vcpu: resources.cpu } : {})
	};
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
