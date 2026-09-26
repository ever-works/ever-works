/**
 * Builds — the `build` capability's plugin contract (APW-05 plan §4.1, tasks T2).
 *
 * Owning epic: **APW-05 (Builds)**. Spec:
 * `docs/specs/features/app-works/APW-05-builds/spec.md` — the workflow file the
 * platform owns (FR-6…FR-14), build values as repository secrets (FR-18), the
 * runner selection (FR-23), the digest receipt (FR-25…FR-28), the App checks
 * job (R-9, FR-65…FR-70) and the verification run (FR-52…FR-54). Plan: §2.4
 * (the workflow this contract drives), §4.1 (this file), §4.2 (registration),
 * §4.3–§4.14 (the `github-actions-build` implementation), §7 (the jobs that
 * call it).
 *
 * ## What is declared here, and what is imported instead (Resolution R-1)
 *
 * `BuildRunRef`, `AppBuildVerificationResult`, the `APP_BUILD_*` closed sets and
 * `BUILD_SERVICE_DEFAULTS` are declared in `@ever-works/contracts`
 * (`packages/contracts/src/apps/builds.ts`, APW-05 T1 — landed) because the
 * API, the agent, the build service and the web all read them. A second
 * declaration here would be exactly the drift R-1 exists to prevent, so this
 * file imports and re-exports them and adds only the shapes that are genuinely
 * plugin-facing: the repository/auth refs, the normalised App spec `build`
 * block, the build values, the prepare/start/observe inputs and results, the
 * facade-bound repository writer, and `IBuildPlugin` itself.
 *
 * | Plan §4.1                 | The landed declaration this file reads instead                                                    |
 * | ------------------------- | ------------------------------------------------------------------------------------------------ |
 * | `:585` `BuildStrategy`    | `AppBuildStrategy` (`packages/contracts/src/apps/builds.ts:203`, `APP_BUILD_STRATEGIES` `:200`)   |
 * | `:698` `buildKind`        | `AppBuildKind` (`builds.ts:213`, `APP_BUILD_KINDS` `:210`)                                        |
 * | `:685–696` `BuildRunRef`  | re-exported from `builds.ts:982`                                                                  |
 * | `:677–681` `verification` | `AppBuildVerificationResult` (`builds.ts:1398`)                                                   |
 * | §4.5:810 `BUILD_SERVICE_DEFAULTS` | re-exported from `builds.ts:480` (the one declaration APW-07 reads too)                  |
 *
 * The substitutions are deliberate and narrow nothing: `AppBuildStrategy` and
 * `AppBuildKind` are the same unions the plan spells inline, and `BuildRunRef`,
 * `AppBuildVerificationResult` and `BUILD_SERVICE_DEFAULTS` are the same shapes
 * under the names T1 landed, which its own spec pins. Where the plan's inline
 * member list is the only declaration (the build block, the values, the
 * snapshot's failure/image shapes) it is reproduced verbatim.
 *
 * **Additive only (CONTRACTS R-26).** `build` is appended to
 * `PLUGIN_CAPABILITIES` and to `PLUGIN_CATEGORIES` (§4.2); no existing
 * capability, category, contract or plugin changes, and a plugin that never
 * declares `build` compiles and behaves exactly as before.
 *
 * ## Who calls this
 *
 * `BuildFacadeService` resolves the plugin and supplies `BuildAuth`; the
 * `app-build-prepare` job calls `prepareRepository`, `app-build-watch` calls
 * `getBuild` (with APW-07's redactor, so no unredacted log excerpt ever leaves
 * the plugin), the sweep's discovery pass calls `listRecentRuns?`, and
 * `AppBuildPullTokenService` calls `checkImageAccess?`. The facade — never the
 * caller — binds `RepositoryWriter`, so there is exactly one clone-free commit
 * implementation (APW-03's `commitFiles?`, plan §4.1:749–751).
 */

import type { AppBuildKind, AppBuildStrategy, AppBuildVerificationResult, BuildRunRef } from '@ever-works/contracts';
import type { CreatePROptions, GitBranch, GitPullRequest } from './git-provider.interface.js';
import type { IPlugin } from '../plugin.interface.js';
import { PLUGIN_CAPABILITIES } from '../facade-capabilities.js';

export type { AppBuildVerificationResult, BuildRunRef };

/**
 * The non-secret, throwaway defaults a build service starts with (plan §4.5:810–833).
 *
 * Re-exported from `@ever-works/contracts` (`builds.ts:480`) rather than
 * restated: the plan puts the constant in this file "so the two cannot drift",
 * and its two readers — the workflow generator (§4.5) and APW-07's
 * `AppEnvResolver.resolveForBuild` (§4.7) — reach the same object through it.
 * `resolveBuildServiceEnv`, `resolveBuildServicePort`,
 * `evaluateBuildServicePort` and `resolveBuildServiceKind` travel with it.
 */
export { BUILD_SERVICE_DEFAULTS } from '@ever-works/contracts';

/**
 * How a Build is produced for this App Work (plan §4.1:585, Resolution R-13).
 *
 * `dockerfile` builds the repository's Dockerfile, `image` runs a prebuilt
 * image and needs no build at all, `none` deploys without an image, and `auto`
 * hands the decision to a provider-internal zero-config builder — which the
 * GitHub plugin does **not** support (`supportedStrategies` excludes it, R-13).
 *
 * Aliased to the landed `AppBuildStrategy` instead of restating the union, so a
 * new strategy is added in one place and the plugin contract follows.
 */
export type BuildStrategy = AppBuildStrategy;

/**
 * The provider's own run status for one Build (plan §4.1:590).
 *
 * Deliberately not `AppBuildStatus` (contracts): `blocked` is a platform-side
 * state that no provider ever reports, so a `BuildSnapshot.status` carrying
 * `blocked` would be a plugin inventing a platform decision. `queued` and
 * `running` are non-terminal; the last three are terminal (plan §7.3).
 */
export type BuildRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The repository a Build runs against (plan §4.1:592–598). */
export interface BuildRepositoryRef {
	readonly owner: string;
	readonly repo: string;
	/** Provider visibility; a private repository selects the private runner and needs a pull token (§4.4, §4.12). */
	readonly visibility: 'public' | 'private';
	/** The App Work's tracked branch — the only branch a Build may run for (FR-14). */
	readonly trackedBranch: string;
	/**
	 * True when the App Work created the repository (Fork), false when it linked
	 * an existing one (Link). A linked repository always takes the pull-request
	 * path for workflow changes, whatever the branch protection says — a linked
	 * repository is not ours to write into (Resolution R-4, plan §4.6 step 7).
	 */
	readonly createdByAppWork: boolean;
}

/** The credential a plugin call runs with (plan §4.1:599–601). Resolved by the facade; **never logged**. */
export interface BuildAuth {
	readonly token: string;
}

/**
 * The App spec's `build` block, normalised and already validated (plan §4.1:602–617; APW-03 schema §9).
 *
 * `args` is reproduced inline rather than reused from contracts'
 * `AppVerificationBuildArg`: that type belongs to the verification plan's
 * schema, and coupling the App spec's build block to it would make a
 * verification-schema change ripple into every build plugin.
 */
export interface AppBuildBlock {
	readonly strategy: BuildStrategy;
	readonly dockerfile?: string;
	readonly context?: string;
	readonly target?: string;
	readonly args: ReadonlyArray<{ name: string; value?: string; fromEnv?: string }>;
	readonly services: ReadonlyArray<{
		name: string;
		image: string;
		port?: number;
		env?: ReadonlyArray<{ name: string; value: string }>;
	}>;
	/** `memoryGiB` absent = the runner's own default, which never blocks a Build (FR-23, `APW05-G14`). */
	readonly resources: { cpu: number; memoryGiB?: number; timeoutMinutes: number };
}

/**
 * One build value APW-07's resolver produced for phase `build` (plan §4.1:618–624).
 *
 * `fingerprint` is `v<version>` for a stored value and `sha256(value)` only for a
 * non-secret or build-service value, so `buildInputsHash` can be computed without
 * ever persisting a hash of a stored secret (plan §4.7:905–906). `value` is the
 * resolved value and exists only inside the job and the sealed-box PUT; it is
 * never logged, never returned by an endpoint, and never written to a row.
 */
export interface BuildValue {
	readonly name: string;
	readonly value: string;
	readonly secret: boolean;
	readonly fromBuildService: boolean;
	readonly fingerprint: string;
}

/**
 * Why a write through {@link RepositoryWriter} was refused (plan §4.6 steps 2–3).
 *
 * The two branch points the delivery rules name: `nonFastForward` is a race the
 * writer retries from the branch-protection check (≤ 3 times), `refRejectedByRule`
 * is a protection or a ruleset refusing the ref, which switches to the
 * pull-request path **once** and never loops (plan §4.6:872–879, `APW05-G16`).
 *
 * DECLARED HERE ON PURPOSE, and provisional: APW-03 T22 owns `commitFiles?` and
 * documents its own `nonFastForward` rejection (APW-03 plan §7:717–719), but no
 * typed code vocabulary exists on `develop` yet, and APW-02's
 * `GitProviderErrorReason` (`git-provider.app-forks.ts:43–52`) has `conflict` /
 * `unprocessable` rather than these two names. Until APW-03 lands one, this is
 * the narrowest declaration that lets the writer's supplier and its caller
 * (T9's `workflow-writer.ts`) agree on the same two strings; when APW-03 lands a
 * typed vocabulary, re-point this alias at it rather than adding a third name.
 */
export type RepositoryWriteErrorCode = 'nonFastForward' | 'refRejectedByRule' | 'pullRequestExists';

/** One file in a {@link RepositoryWriter.commitFiles} call (APW-03 plan §7:717–719). */
export interface RepositoryCommitFile {
	readonly path: string;
	readonly content: string;
	readonly encoding: 'utf-8' | 'base64';
}

/**
 * The commit {@link RepositoryWriter.commitFiles} lands (APW-03 plan §7:717–719).
 *
 * `files` is a mutable `Array`, matching APW-03's `commitFiles?` parameter
 * exactly, so the facade's binding passes it through without a copy.
 */
export interface RepositoryCommitInput {
	readonly branch: string;
	/** The commit the caller believes `branch` is at; a mismatch is refused as `nonFastForward`. */
	readonly baseSha: string;
	readonly message: string;
	readonly files: Array<RepositoryCommitFile>;
}

/**
 * The clone-free repository write path a build plugin is given (plan §4.1:714–717, §4.6:872–884).
 *
 * **Provisional, and routed rather than owned.** Plan §4.1:716 passes a
 * `RepositoryWriter` to `prepareRepository` and §4.1:749–751 fixes its four
 * members ("`getFileContent`, `commitFiles`, `createBranch`, `createPullRequest`
 * bound by the facade to `GitFacadeService`"), but the type is declared by no
 * epic: APW-03 T22 declares `IGitProviderPlugin.commitFiles?` (APW-03 plan
 * §7:717–719) and APW-05 T16 binds the writer over `GitFacadeService`, and
 * neither is on `develop` yet. It is declared here — in the file T2 creates —
 * because plan §4.1's `prepareRepository` signature cannot compile without it.
 * When APW-03 T22 lands, this interface becomes the alias of whatever
 * `GitFacadeService` exposes; nothing else moves.
 *
 * Every member is repository-bound: the writer already knows the `owner`,
 * `repo`, auth and Work, so a plugin never passes them and can never write to a
 * repository the caller did not resolve. **No member clones** — that is the
 * whole point of the seam (plan §1.2: writing one file must not clone a 1 GB
 * repository). A refusal is thrown, and the caller branches on
 * {@link RepositoryWriteErrorCode}; `getFileContent` answers `null` for a file
 * that does not exist, which is not an error (plan §4.6 steps 4, 5).
 */
export interface RepositoryWriter {
	/** The current file at `path` on `ref` (default: the tracked branch), or `null` when it does not exist. */
	getFileContent(path: string, ref?: string): Promise<{ content: string; encoding: string } | null>;

	/** Land one commit holding `input.files` on `input.branch`; the plugin never clones and never force-pushes. */
	commitFiles(input: RepositoryCommitInput): Promise<{ commitSha: string }>;

	/** Create `name` from `fromRef`; an existing branch is returned rather than recreated. */
	createBranch(name: string, fromRef: string): Promise<GitBranch>;

	/**
	 * Open a pull request in the bound repository. `owner`/`repo` are omitted: the writer already holds them.
	 *
	 * An OPEN pull request for the same head branch already existing is refused with the code
	 * `pullRequestExists` (GitHub answers 422 "A pull request already exists"). The caller reuses the
	 * open one (plan §4.6 step 3, ACC-05-02) — only the provider can say whether a recorded pull
	 * request is still open, so a stored number is never trusted on its own.
	 */
	createPullRequest(options: Omit<CreatePROptions, 'owner' | 'repo'>): Promise<GitPullRequest>;
}

/** What `prepareRepository` is asked to deliver (plan §4.1:625–636). */
export interface PrepareRepositoryInput {
	readonly workId: string;
	readonly repository: BuildRepositoryRef;
	readonly build: AppBuildBlock;
	/** The hash of the App spec this preparation was generated from; it travels into the workflow's labels (§2.4). */
	readonly appSpecHash: string;
	readonly values: readonly BuildValue[];
	/** The `EW_` names the platform wrote earlier and may now delete (plan §4.7:916–917). */
	readonly previouslyWrittenSecretNames: readonly string[];
	/** The workflow sha256 the platform last wrote, or `null`; a file that differs is a hand edit (FR-9). */
	readonly lastWrittenWorkflowSha256: string | null;
	/**
	 * The workflow pull request the platform recorded (§3.1b), echoed back when the provider reports
	 * that the same head already has an OPEN pull request (`pullRequestExists`), so the reused one
	 * keeps its link. Never used to decide that a pull request is still open. Optional and additive.
	 */
	readonly workflowPullRequestNumber?: number | null;
	readonly workflowPullRequestUrl?: string | null;
	readonly settings: Record<string, unknown>;
	/** `spec.checks[]` (APW-03 schema §17), already validated; empty → no checks job (R-9). */
	readonly checks: ReadonlyArray<{ name: string; command: string; required: boolean; timeoutSeconds: number }>;
}

/** What `prepareRepository` delivered (plan §4.1:637–648). */
export interface PrepareRepositoryResult {
	readonly workflow: {
		state: 'unchanged' | 'committed' | 'pullRequestOpened' | 'pullRequestUpdated' | 'editedByHand';
		readonly commitSha?: string;
		readonly pullRequestUrl?: string;
		/** sha256 of the generated bytes; stored only after a matching read-back (FR-8). */
		readonly contentSha256: string;
	};
	readonly secretsWritten: readonly string[];
	readonly secretsRemoved: readonly string[];
	readonly buildInputsHash: string;
	/**
	 * `reason` is mapped onto `AppBuildBlockedReason` by `AppBuildsService`, which
	 * refuses a reason it does not know rather than storing it (plan §4.5:825–827,
	 * `APW05-G03`). It stays a `string` here, as plan §4.1:647 writes it: a closed
	 * union would make the plugin contract narrower than the platform's mapping.
	 */
	readonly blocked?: { reason: string; detail: Record<string, string | number | string[]> };
}

/**
 * What a verification run must exercise (plan §4.1:649–654, §4.10:1036–1057).
 *
 * `json` is APW-04's plan, already validated against `verify-plan.schema.json`,
 * base64url-encoded into the `ew_verify_plan` dispatch input (≤ 60,000
 * characters). It is value-free by construction: `env` is APW-07's ephemeral
 * recipe, never a resolved value. `promptedNames` names the prompted values the
 * owner already set that the recipe needs — the values are fetched by
 * `AppBuildsService` and written as the one per-run secret, never carried here.
 */
export interface VerificationPlan {
	readonly json: string;
	readonly promptedNames: readonly string[];
}

/** What `startBuild` dispatches (plan §4.1:655–665). */
export interface StartBuildInput {
	readonly workId: string;
	readonly buildId: string;
	readonly repository: BuildRepositoryRef;
	readonly ref: string;
	readonly sha: string;
	readonly mode: 'build' | 'verify';
	/** `sha256:<64>` of an earlier succeeded Build of the same commit, reused instead of building twice (FR-52). */
	readonly reuseImageDigest?: string;
	readonly verification?: VerificationPlan;
	readonly settings: Record<string, unknown>;
}

/** How a Build is addressed when it is observed (plan §4.1:666–671). */
export interface BuildRef {
	readonly repository: BuildRepositoryRef;
	readonly buildId: string;
	/** `null` until the dispatch is correlated to a run by `display_title` (plan §4.8). */
	readonly providerRunId: string | null;
	readonly dispatchedAt?: string;
}

/**
 * One observation of a Build's run (plan §4.1:672–695).
 *
 * Only the `build` job decides `status`; a failed `Ever Works check:` job never
 * flips a Build to `failed` (R-9, FR-69) — its minutes are reported separately
 * in `checksBillableMinutes`, which is a subset of `billableMinutes`.
 *
 * `failure.class` stays a `string` here, as plan §4.1:689 writes it: the closed
 * union (`AppBuildFailureClass`) belongs to the classifier T13 implements, and
 * the plugin reports what it observed.
 */
export interface BuildSnapshot {
	readonly providerRunId: string | null;
	readonly runAttempt: number;
	readonly status: BuildRunStatus;
	readonly conclusion?: string;
	readonly trigger: 'push' | 'pull_request' | 'manual' | 'verification';
	readonly branch: string;
	readonly commitSha: string;
	readonly pullRequestNumber?: number;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly billableMinutes?: number;
	/** Minutes of the `checks` matrix jobs — part of `billableMinutes`, and never a status input (R-9). */
	readonly checksBillableMinutes?: number;
	readonly runnerLabel?: string;
	readonly logsUrl?: string;
	readonly image?: {
		repository: string;
		digest: string;
		tags: string[];
		confirmed: boolean;
		/**
		 * The digest the build job's own `Push` step logged for the image
		 * (plan §4.8's no-token fallback), when the provider could read it.
		 * Lets the platform confirm a digest the registry cannot be asked
		 * about (a private image with no pull token). Optional and additive.
		 */
		pushLogDigest?: string;
	};
	readonly secretCheck?: 'passed' | 'failed' | 'not_needed';
	readonly failure?: { class: string; detail?: Record<string, unknown>; excerpt: string[] };
	readonly verification?: AppBuildVerificationResult;
}

/** What `checkImageAccess?` answers (plan §4.1:736–742, §4.12). */
export interface ImageAccessResult {
	readonly visibility: 'public' | 'private' | 'unknown';
	readonly readable: boolean;
	/** `false` when the token's scopes are broader or narrower than `read:packages` (plan §4.12:1104–1108). */
	readonly tokenScopesOk?: boolean;
	/** The pull token's expiry, when the provider reports one; `null` means "reported, and it does not expire". */
	readonly tokenExpiresAt?: string | null;
	/** The manifest digest, when the registry answered with one. */
	readonly digest?: string;
}

/**
 * A build plugin: one plugin, one way of turning a commit into an image (plan §4.1:710–735).
 *
 * `supportedStrategies` is what the strategy gate reads before anything is
 * dispatched: a plugin that cannot serve the App Work's strategy leaves the
 * Build unstarted rather than half-built (`strategyNotSupported`, plan §7.2).
 * The three optional members are optional for the same reason the rest of this
 * package's optional members are: a Wave-3 `apps-builder` implementation may
 * have no workflow file to list and no GHCR manifest to check, and a caller
 * materialises the member before calling it.
 */
export interface IBuildPlugin extends IPlugin {
	readonly buildKind: AppBuildKind;
	readonly supportedStrategies: readonly BuildStrategy[];
	prepareRepository(
		input: PrepareRepositoryInput,
		auth: BuildAuth,
		writer: RepositoryWriter
	): Promise<PrepareRepositoryResult>;
	startBuild(
		input: StartBuildInput,
		auth: BuildAuth
	): Promise<{ providerRunId: string | null; dispatchedAt: string }>;
	/**
	 * Observe one run. `redact` is APW-07's redactor for this App Work and is
	 * applied to every excerpt before it is returned, so no unredacted log text
	 * ever leaves the plugin (FR-38). `null` means "no such run" — never "I could
	 * not tell", which is a throw.
	 */
	getBuild(ref: BuildRef, auth: BuildAuth, redact: (text: string) => string): Promise<BuildSnapshot | null>;
	cancelBuild(ref: BuildRef, auth: BuildAuth): Promise<void>;
	getLogsUrl(ref: BuildRef, auth: BuildAuth): Promise<string | null>;
	/**
	 * Run discovery (§7.4a): the newest runs of the build workflow, so a push or
	 * pull-request Build is recorded even when no delivery reaches the platform.
	 * `GET /repos/{o}/{r}/actions/workflows/{file}/runs` with `per_page` ≤ 20,
	 * newest first, and `If-None-Match` when an `etag` is supplied; a 304 answers
	 * `{ notModified: true }` with no `runs`.
	 */
	listRecentRuns?(
		input: { repository: { owner: string; name: string }; workflowPath: string; perPage: number; etag?: string },
		auth: BuildAuth
	): Promise<{ notModified: boolean; etag?: string; runs: BuildRunRef[] }>;
	/** Registry access for a private image and the pull token's validity (plan §4.12). */
	checkImageAccess?(input: { imageRepository: string; tag: string; pullToken?: string }): Promise<ImageAccessResult>;
}

/**
 * Is this plugin a build plugin? (plan §4.1:743–745)
 *
 * The capability string is the whole test, exactly as the plan writes it: a
 * `build` plugin is resolved through `PLUGIN_CAPABILITIES.BUILD`, so asking
 * `capabilities.includes(PLUGIN_CAPABILITIES.BUILD)` cannot disagree with the
 * resolution `BuildFacadeService` performs.
 */
export function isBuildPlugin(plugin: IPlugin): plugin is IBuildPlugin {
	return plugin.capabilities.includes(PLUGIN_CAPABILITIES.BUILD);
}
