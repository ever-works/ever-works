import {
	APP_BUILD_BRANCH_SLUG_MAX_CHARS,
	APP_BUILD_CHECKS_MAX,
	APP_BUILD_IMAGE_NAME,
	APP_BUILD_RESULT_ARTIFACT_FILE,
	APP_BUILD_RESULT_ARTIFACT_NAME,
	APP_BUILD_RESULT_ARTIFACT_RETENTION_DAYS,
	APP_BUILD_RESTRICTED_VALUE_LITERAL,
	APP_BUILD_SECRET_PREFIX,
	APP_BUILD_VERIFY_PLAN_INPUT,
	APP_BUILD_VERIFY_TIMEOUT_MINUTES,
	BUILD_SERVICE_DEFAULTS,
	evaluateBuildServicePort,
	resolveBuildServiceEnv,
	resolveBuildServiceKind,
	sha256Hex,
	type AppBuildRunnerClass,
	type BuildServiceKind
} from '@ever-works/contracts';
import type { AppBuildBlock, BuildValue } from '@ever-works/plugin';

import { ACTION_PINS, actionPin } from './action-pins.js';
import { checksJob } from './checks-job.js';
import {
	canonicalCheck,
	computeWorkflowInputsHash,
	type CanonicalBuildBlock,
	type CanonicalWorkflowInputs
} from './inputs-hash.js';
import { EMBEDDED_VERIFY_RUNNER_SCRIPT } from './verify-runner.sh.js';

/**
 * APW-05 T8 — canonical inputs in, the workflow file out (plan §2.4, §4.5).
 *
 * The file this produces is the platform's, not the user's: it is written to the
 * tracked branch, hand edits are never overwritten (plan §4.6 step 5, T9), and
 * every value it needs travels as a repository secret (`EW_<NAME>`, plan §4.7,
 * T10) rather than as workflow text. Five properties are load-bearing and are
 * pinned by `src/__tests__/generator.spec.ts` against the ten goldens under
 * `src/__tests__/golden/`:
 *
 *   1. **Byte-stable.** Plan §4.5: a line-array builder plus {@link yamlString},
 *      LF endings, one trailing newline, and every unordered input sorted before
 *      it is hashed or emitted — the same inputs yield identical bytes on every
 *      platform (ACC-05-03).
 *   2. **No stored value ever appears.** A `fromEnv` argument is emitted as a
 *      `secrets.EW_<NAME>` reference; the resolved value only ever exists inside
 *      the job's environment and the sealed-box PUT (ACC-05-05). A literal
 *      `value` argument *is* emitted verbatim — it is written in the App spec, not
 *      resolved from a stored value, which is exactly the distinction plan §2.4's
 *      two `build-args` lines draw.
 *   3. **A pull request from another repository runs nothing.** The `build` job's
 *      `if:` requires the head repository to be the repository, and the only job
 *      that references `secrets.` is that one (ACC-05-06).
 *   4. **`load: true`, `push: false`, then a separate `docker push`.** A secret
 *      found in the image metadata is caught *before* a byte leaves the runner
 *      (FR-21), which is why the secret check sits between the build and the push.
 *   5. **The `verify` job can neither publish an image nor write the cache**
 *      (FR-54): `packages: read`, no `docker push`, no `--push`, no `cache-to`,
 *      and its own `verify-<buildId>` concurrency group so it can never replace —
 *      or be replaced by — the push Build of the head commit (`APW05-G02`).
 *
 * ## The `checks` job
 *
 * T41 landed it: the job is `src/workflow/checks-job.ts`'s (R-9, plan §2.4:276–308,
 * §4.14) and this file only decides **whether** it is emitted — after the `build`
 * job, which is where §2.4's job order puts it (build → verify → checks), and only
 * when the App spec declares at least one check and the file is not the bootstrap
 * file of §4.6 step 0 (which has no App spec to read checks from). `checks` also
 * travels into the canonical inputs, so the fingerprint covers a check-command
 * change as well as the bytes (plan §4.5: "A check command change therefore
 * changes the file and its fingerprint").
 *
 * ## The checks-only file (T42, R-9, FR-70)
 *
 * `image` and `none` never produce a Build (plan §7.2 step 2: "`strategy`
 * `image`/`none` → no Build"), so a file generated for one of them must not carry
 * a `build` job — and §4.14 fixes what it carries instead, exactly: "the header,
 * `on: pull_request` only (no `push`, no `workflow_dispatch`), `permissions: {}`,
 * the same concurrency block and the `checks` job — nothing else". That is
 * {@link checksOnlyWorkflow}, reached through {@link checksOnlyFile}. With no
 * check left there is no workflow content at all, and this function answers the
 * empty string: §4.6 step 8's "with no checks, nothing is written", which
 * `src/repo/workflow-writer.ts` turns into a removal proposed by pull request
 * (FR-70, ACC-05-30).
 *
 * Two details of that file are deliberate and are why they are listed here:
 *
 *   - **No `run-name`.** §4.14's "nothing else" and the normative draft
 *     `docs/specs/features/app-works/APW-05-builds/golden-draft/checks.ever-works-build.yml`
 *     (which carries `run-name` in every other draft and none here) agree: nothing
 *     correlates a checks-only run to a Build, because §4.14's observation records
 *     none for this strategy.
 *   - **Its concurrency group is the draft's, not the full file's** — the one
 *     place where §4.14's prose ("the same concurrency block") and §4.14's own
 *     draft disagree. The draft wins, on a measurement: the full file's group names
 *     `inputs.ew_mode` and `inputs.ew_build_id`, and the `inputs` context exists
 *     only for `workflow_dispatch`/`workflow_call`, so a checks-only file that
 *     carried it would be a file GitHub may refuse. `actionlint` v1.7.12 agrees —
 *     on the shared block it exits 1 with
 *     `checks-only.yml:11:15: property "ew_mode" is not defined in object type {}`
 *     (and `:11:66` for `ew_build_id`); on the draft's group it exits 0. Both
 *     blocks come from ONE helper, {@link concurrencyLines}, so they cannot drift;
 *     `generator.spec.ts` pins each shape from both sides. Routed as a finding
 *     against §4.14's sentence, which is the artefact that should be corrected.
 *
 * ## What this generator deliberately does not emit
 *
 *   - **An attestation step.** Plan §4.5 says a private repository never gets "the
 *     attestation permissions or steps", but §4.3's pin set carries no attestation
 *     action and §2.4's step list no attestation step, so only the two permissions
 *     are emitted. Routed, not invented.
 *
 * ## Three readings this file had to fix
 *
 *   - **The branch tag.** §2.4 writes `format('branch-{0}', '<branch slug>')`; the
 *     slug is known at generation time, so it is emitted as the literal
 *     `'branch-<slug>'` inside the same expression. Same value, one less
 *     indirection, and the golden contains the tag verbatim.
 *   - **The restricted literal** (XC-01). §4.7b:948–952 says "a fixed non-secret
 *     marker, one per value name so a build script can still distinguish 'absent'
 *     from 'present'". The marker is used **verbatim**
 *     (`APP_BUILD_RESTRICTED_VALUE_LITERAL`) rather than suffixed with the name:
 *     the constant is the platform's single definition of the marker, and a
 *     name-carrying variant could be mistaken for a value.
 *   - **The build job's "Verify in the runner" step.** §2.4 emits it guarded by
 *     `inputs.ew_verify_plan != ''`, and `ew_verify_plan` is only ever non-empty
 *     for a `verify`-mode dispatch — which the `build` job excludes. It is emitted
 *     as §2.4 writes it and reported as unreachable rather than quietly dropped.
 */

/** The App Work's repository as the workflow needs it — the emit-time half of plan §4.5's canonical inputs. */
export interface WorkflowRepositoryInput {
	readonly owner: string;
	readonly repo: string;
	readonly visibility: 'public' | 'private';
}

/** The runner the workflow asks for — T11 selects it, this file only prints it (plan §4.5). */
export interface WorkflowRunnerInput {
	readonly label: string;
	readonly class: AppBuildRunnerClass;
}

/** The plan §4.4 settings that change the emitted bytes. */
export interface WorkflowSettingsInput {
	readonly reclaimDisk?: boolean;
	/** Honoured only for a public repository — the effective value is resolved here (plan §4.5, `APW05-G07`). */
	readonly attestations?: boolean;
	readonly allowBuildValuesOnPullRequests?: boolean;
	readonly verificationPromptedValuesRequireApproval?: boolean;
}

/** One App spec check, as `PrepareRepositoryInput.checks` carries it (R-9, plan §4.1). */
export interface WorkflowCheckInput {
	readonly name: string;
	readonly command: string;
	readonly required: boolean;
	readonly timeoutSeconds: number;
}

/** Everything the generator needs (plan §4.5's canonical inputs, plus the emit-time facts). */
export interface WorkflowGeneratorInput {
	readonly trackedBranch: string;
	readonly repository: WorkflowRepositoryInput;
	/** The hash of the App spec this file was generated from — the `io.ever-works.app-spec-hash` label (plan §2.4). */
	readonly appSpecHash: string;
	/** The App spec's `build` block; `null` (or absent) for the bootstrap file of plan §4.6 step 0. */
	readonly build?: AppBuildBlock | null;
	readonly values: readonly BuildValue[];
	readonly runner: WorkflowRunnerInput;
	readonly settings?: WorkflowSettingsInput;
	/** Plan §4.5: true exactly when the file carries the `verify` job that can run for this App Work. */
	readonly verifyEnabled: boolean;
	readonly checks?: readonly WorkflowCheckInput[];
	/** Plan §4.6 step 0: a dispatch-only file with no `build` job and no `checks` job. */
	readonly bootstrap?: boolean;
	/** T15's embedded verification script; defaults to {@link EMBEDDED_VERIFY_RUNNER_SCRIPT}. */
	readonly verifyRunnerScript?: string;
}

/**
 * A YAML double-quoted scalar, always.
 *
 * Plan §4.5: "a `yamlString()` helper that always double-quotes and escapes, so
 * the same inputs yield identical bytes on every platform". Everything the
 * generator interpolates goes through here — including expressions, whose `{`,
 * `}`, `:` and quotes would otherwise depend on the reader's YAML dialect.
 */
export function yamlString(value: string): string {
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		.replace(
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
		);
	return `"${escaped}"`;
}

/** A block scalar's content lines, indented to their parent key's child level. */
function scalarBlock(lines: readonly string[], indent: number): string[] {
	const pad = ' '.repeat(indent);
	return lines.map((line) => (line.length === 0 ? '' : `${pad}${line}`));
}

/**
 * Plan §4.5's branch slug: lower case, `[^a-z0-9._-]` → `-`, runs collapsed,
 * trimmed to {@link APP_BUILD_BRANCH_SLUG_MAX_CHARS}.
 */
export function branchSlug(branch: string): string {
	return branch
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-')
		.replace(/-{2,}/g, '-')
		.slice(0, APP_BUILD_BRANCH_SLUG_MAX_CHARS);
}

/** The image the build publishes (plan §2.4 `EW_IMAGE`, `APP_BUILD_IMAGE_NAME`). */
export function buildImageRepository(repository: WorkflowRepositoryInput): string {
	return `ghcr.io/${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}/${APP_BUILD_IMAGE_NAME}`;
}

/** The `EW_` secret names a build job writes, space separated — `secret` and not build-service derived (§2.4, §4.11). */
export function secretNamesFor(values: readonly BuildValue[]): string[] {
	return values
		.filter((value) => value.secret && !value.fromBuildService)
		.map((value) => `${APP_BUILD_SECRET_PREFIX}${value.name}`)
		.sort();
}

/** The `fromEnv` names the build arguments read, in the order the build block declares them. */
export function fromEnvNames(build: AppBuildBlock): string[] {
	return build.args.map((arg) => arg.fromEnv).filter((name): name is string => typeof name === 'string');
}

/** Normalise the App spec's build block: defaults applied, keys sorted (plan §4.5). */
export function normaliseBuildBlock(build: AppBuildBlock): CanonicalBuildBlock {
	return {
		strategy: build.strategy,
		context: build.context?.trim() || '.',
		dockerfile: build.dockerfile?.trim() || 'Dockerfile',
		...(build.target?.trim() ? { target: build.target.trim() } : {}),
		args: build.args.map((arg) => ({
			name: arg.name,
			...(arg.value === undefined ? {} : { value: arg.value }),
			...(arg.fromEnv === undefined ? {} : { fromEnv: arg.fromEnv })
		})),
		services: build.services.map((service) => ({
			name: service.name,
			image: service.image,
			...(service.port === undefined ? {} : { port: service.port }),
			env: (service.env ?? []).map((entry) => ({ name: entry.name, value: entry.value }))
		})),
		resources: {
			cpu: build.resources.cpu,
			...(build.resources.memoryGiB === undefined ? {} : { memoryGiB: build.resources.memoryGiB }),
			timeoutMinutes: build.resources.timeoutMinutes
		}
	};
}

/** The canonical inputs of one generation — what the header line's fingerprint covers. */
export function canonicalInputsFor(input: WorkflowGeneratorInput, verifyRunnerScript: string): CanonicalWorkflowInputs {
	const bootstrap = input.bootstrap === true;
	const build = input.build ? normaliseBuildBlock(input.build) : null;
	return {
		generator: 1,
		bootstrap,
		trackedBranch: input.trackedBranch,
		repository: input.repository,
		appSpecHash: input.appSpecHash,
		build: bootstrap ? null : build,
		values: input.values.map((value) => ({
			name: value.name,
			secret: value.secret,
			fromBuildService: value.fromBuildService
		})),
		runner: input.runner,
		settings: {
			reclaimDisk: input.settings?.reclaimDisk !== false,
			// Plan §4.5/§4.4: attestations is **effective** — a private repository
			// never gets the permissions, whatever the setting says (`APW05-G07`).
			attestations: input.settings?.attestations === true && input.repository.visibility === 'public',
			allowBuildValuesOnPullRequests: input.settings?.allowBuildValuesOnPullRequests === true,
			verificationPromptedValuesRequireApproval:
				input.settings?.verificationPromptedValuesRequireApproval !== false
		},
		pins: {},
		verifyEnabled: input.verifyEnabled,
		checks: (input.checks ?? []).slice(0, APP_BUILD_CHECKS_MAX).map(canonicalCheck),
		verifyRunnerScriptSha256: sha256Hex(verifyRunnerScript)
	};
}

/** The header every generated file carries — plan §2.4:157–159, FR-6. */
export function workflowHeader(inputsHash: string): string[] {
	return [
		'# Generated by Ever Works from .works/works.yml. Do not edit: hand edits are never overwritten;',
		'# Ever Works proposes changes to this file as pull requests.',
		`# ever-works-build generator=1 inputs=${inputsHash}`
	];
}

/**
 * True when no Build is possible for this App Work, so the file it gets is the
 * checks-only file of §4.14 — or nothing at all (T42, FR-70).
 *
 * The decision is the **strategy**, and it is read from the normalised build block
 * the canonical inputs already carry:
 *
 *   - `image` and `none` are §7.2 step 2's "no Build" strategies;
 *   - a **missing** build block (outside the bootstrap file, which has no App spec
 *     at all) is the same thing, because `app-build-prepare.runner.ts` resolves
 *     `spec.build.strategy` with `?? 'none'` — a Work with no `build` block is a
 *     `none` Work, and a file that carries a `verify` job and a
 *     `workflow_dispatch` trigger for it would contradict §4.14's "nothing else";
 *   - `dockerfile` and `auto` are not: a `dockerfile` Work builds, and an `auto`
 *     Work keeps the file it has (`auto` is refused by every Wave-1 provider,
 *     R-13, and its requested Build is blocked `strategyNotSupported` — but the
 *     strategy is not one §4.14 gives the checks-only file to).
 */
export function checksOnlyFile(input: WorkflowGeneratorInput): boolean {
	if (input.bootstrap === true) return false;
	const strategy = input.build?.strategy ?? null;
	return strategy === null || strategy === 'image' || strategy === 'none';
}

/**
 * Generate the workflow file (plan §2.4).
 *
 * Byte-stable by construction: every branch below is a pure function of
 * {@link WorkflowGeneratorInput}, and the two unordered collections (build args,
 * services) are emitted in their declared order while the fingerprint sorts them
 * again for the hash.
 *
 * Three shapes come out of it, and the first is T42's:
 *
 *   1. **the checks-only file** ({@link checksOnlyFile}) — §4.14, or the empty
 *      string when no check is left (§4.6 step 8);
 *   2. **the bootstrap file** (`bootstrap: true`) — dispatch-only, `verify` alone
 *      (§4.6 step 0);
 *   3. **the full file** — `build`, `verify` and, when the App spec declares any,
 *      `checks`.
 */
export function generateWorkflow(input: WorkflowGeneratorInput): string {
	const verifyRunnerScript = input.verifyRunnerScript ?? EMBEDDED_VERIFY_RUNNER_SCRIPT;
	const canonical = canonicalInputsFor(input, verifyRunnerScript);
	const inputHash = computeWorkflowInputsHash(canonical);
	const build = canonical.build;
	const bootstrap = canonical.bootstrap;
	const slug = branchSlug(canonical.trackedBranch);
	const image = buildImageRepository(canonical.repository);
	const runnerLabel = canonical.runner.label;
	const secretNames = secretNamesFor(input.values);
	// T41's rule, hoisted: a bootstrap file carries no check (§4.6 step 0), and
	// nothing else filters the list.
	const checks = bootstrap ? [] : (input.checks ?? []);

	// T42 (plan §4.14, §4.6 step 8, FR-70): an `image`/`none` Work gets the checks
	// and nothing else — or, with no check left, no workflow content at all.
	if (checksOnlyFile(input)) {
		if (checks.length === 0) return '';
		return checksOnlyWorkflow({ inputHash, trackedBranch: canonical.trackedBranch, checks, runnerLabel });
	}

	const lines: string[] = [...workflowHeader(inputHash)];

	lines.push('name: Ever Works build');
	lines.push(
		`run-name: ${yamlString('Ever Works build ${{ inputs.ew_build_id || github.event.pull_request.head.sha || github.sha }}')}`
	);

	// Triggers. A bootstrap file is dispatch-only (`APW05-G02`): there is no App
	// spec to build from yet, so nothing may start it but a verification.
	lines.push('on:');
	if (!bootstrap) {
		lines.push('  push:');
		lines.push(`    branches: [${yamlString(canonical.trackedBranch)}]`);
		lines.push('  pull_request:');
		lines.push(`    branches: [${yamlString(canonical.trackedBranch)}]`);
		lines.push('    types: [opened, synchronize, reopened]');
	}
	lines.push('  workflow_dispatch:');
	lines.push('    inputs:');
	lines.push('      ew_build_id:');
	lines.push('        type: string');
	lines.push('        required: true');
	lines.push('      ew_sha:');
	lines.push('        type: string');
	lines.push('        required: true');
	lines.push('      ew_mode:');
	lines.push('        type: choice');
	lines.push('        options: [build, verify]');
	lines.push('        default: build');
	lines.push(`      ${APP_BUILD_VERIFY_PLAN_INPUT}:`);
	lines.push('        type: string');
	lines.push('        required: false');
	lines.push(`        default: ${yamlString('')}`);
	lines.push('      ew_reuse_digest:');
	lines.push('        type: string');
	lines.push('        required: false');
	lines.push(`        default: ${yamlString('')}`);

	// Top-level permissions stay empty: every grant is per job, so FR-12 is a grep.
	lines.push('permissions: {}');
	lines.push(...concurrencyLines('dispatch'));

	lines.push('jobs:');
	if (!bootstrap && build) {
		lines.push(...buildJob({ canonical, build, image, slug, runnerLabel, secretNames, verifyRunnerScript }));
	}
	lines.push(...verifyJob({ build, image, runnerLabel, verifyRunnerScript }));
	// T41 (R-9): the `checks` job, after `build` (§2.4's job order is build →
	// verify → checks) and only for a file that has an App spec with checks in it.
	// A bootstrap file carries no check: §4.6 step 0 is dispatched for a
	// verification, and §4.14 gives checks the pull-request trigger alone.
	if (checks.length > 0) {
		lines.push(...checksJob({ checks, trackedBranch: canonical.trackedBranch, runnerLabel }));
	}

	return `${lines.join('\n')}\n`;
}

/**
 * Which shape of concurrency block a file gets.
 *
 * The two differ for one reason and only one: **the `inputs` context exists only
 * for `workflow_dispatch` / `workflow_call`**. A dispatch-bearing file may name
 * `inputs.ew_mode` and `inputs.ew_build_id`; T42's checks-only file must not, and
 * `actionlint` v1.7.12 refuses a file that does
 * (`property "ew_mode" is not defined in object type {}`).
 */
export type ConcurrencyShape = 'dispatch' | 'checksOnly';

/**
 * The concurrency block — ONE definition, one call site per shape.
 *
 * | Shape        | The file                          | `group`                                                                     |
 * | ------------ | --------------------------------- | --------------------------------------------------------------------------- |
 * | `dispatch`   | the full file and the bootstrap   | the `inputs.ew_mode == 'verify'`-aware group of §2.4 / §4.6 step 0          |
 * | `checksOnly` | T42's checks-only file (§4.14)    | the normative draft's group: `ever-works-build-${{ … }}` with no `inputs.`  |
 *
 * 🛑 **A routed conflict, resolved in the draft's favour (measured 2026-09-17).**
 * §4.14's prose says the checks-only file carries "the same concurrency block",
 * while §4.14's own normative draft
 * (`docs/specs/features/app-works/APW-05-builds/golden-draft/checks.ever-works-build.yml`)
 * gives it a **different** group — and the draft wins, because the two plan
 * artefacts already disagree and only the draft describes a file that can run:
 * with no `workflow_dispatch` there is no `inputs` object, so the shared block is
 * meaningless at best. `actionlint` v1.7.12 on the shared block, measured:
 * `checks-only.yml:11:15: property "ew_mode" is not defined in object type {}` and
 * `:11:66` for `ew_build_id`, exit 1; on the block below, exit 0. The full file's
 * block is unchanged, byte for byte.
 *
 * The draft line this reproduces, verbatim in value (and quoted by the package's
 * single {@link yamlString} rule, as every other interpolated value here is):
 *
 *     group: ever-works-build-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('push-{0}', github.sha) }}
 *     cancel-in-progress: true
 */
function concurrencyLines(shape: ConcurrencyShape): string[] {
	if (shape === 'checksOnly') {
		return [
			'concurrency:',
			`  group: ${yamlString(
				"ever-works-build-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('push-{0}', github.sha) }}"
			)}`,
			// `true` as the draft has it: a checks-only file runs for pull requests
			// only, so a newer run of the same pull request always supersedes the one
			// in flight — which is what the full file's `github.event_name ==
			// 'pull_request'` expression amounts to for that trigger set.
			'  cancel-in-progress: true'
		];
	}
	return [
		'concurrency:',
		`  group: ${yamlString(
			"${{ inputs.ew_mode == 'verify' && format('verify-{0}', inputs.ew_build_id) || format('ever-works-build-{0}', github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref_name) }}"
		)}`,
		`  cancel-in-progress: \${{ github.event_name == 'pull_request' }}`
	];
}

/**
 * T42 — the checks-only file of §4.14 (R-9, FR-70).
 *
 * §4.14: "the file carries the header, `on: pull_request` only (no `push`, no
 * `workflow_dispatch`), `permissions: {}`, the same concurrency block and the
 * `checks` job — nothing else." The `checks` job is T41's, imported and emitted
 * through the same call the full file makes, so the two files cannot disagree
 * about a matrix row, a permission or the same-repository guard.
 *
 * The pull-request trigger repeats the full file's `branches`/`types` (FR-11,
 * `opened`, `synchronize`, `reopened`) and the guard that keeps a fork's pull
 * request from running anything is the job's own `if:` — the same expression the
 * `build` job uses (`checks-job.ts`).
 *
 * **The two deviations from §4.14's sentence, and why each is the draft's.**
 *
 *   - **The concurrency block is the checks-only one**, not the full file's — see
 *     {@link concurrencyLines} for the measurement and the reasoning.
 *   - **No `run-name`.** §4.14's "nothing else", and the normative draft
 *     `golden-draft/checks.ever-works-build.yml` omits it while carrying it in
 *     every other draft. Nothing needs a run title here — §4.14's observation
 *     records no Build for an `image`/`none` Work, so no `display_title` is
 *     correlated.
 */
function checksOnlyWorkflow(input: {
	readonly inputHash: string;
	readonly trackedBranch: string;
	readonly checks: readonly WorkflowCheckInput[];
	readonly runnerLabel: string;
}): string {
	const lines: string[] = [...workflowHeader(input.inputHash)];
	lines.push('name: Ever Works build');
	lines.push('on:');
	lines.push('  pull_request:');
	lines.push(`    branches: [${yamlString(input.trackedBranch)}]`);
	lines.push('    types: [opened, synchronize, reopened]');
	lines.push('permissions: {}');
	lines.push(...concurrencyLines('checksOnly'));
	lines.push('jobs:');
	lines.push(
		...checksJob({
			checks: input.checks,
			trackedBranch: input.trackedBranch,
			runnerLabel: input.runnerLabel
		})
	);
	return `${lines.join('\n')}\n`;
}

interface BuildJobInput {
	readonly canonical: CanonicalWorkflowInputs;
	readonly build: CanonicalBuildBlock;
	readonly image: string;
	readonly slug: string;
	readonly runnerLabel: string;
	readonly secretNames: readonly string[];
	readonly verifyRunnerScript: string;
}

/** The `build` job — plan §2.4:178–241. */
function buildJob(job: BuildJobInput): string[] {
	const { canonical, build, image, slug, runnerLabel, secretNames } = job;
	const lines: string[] = [];
	const attestations = canonical.settings.attestations;
	const fromEnv = build.args.map((arg) => arg.fromEnv).filter((name): name is string => typeof name === 'string');
	const restricted = !canonical.settings.allowBuildValuesOnPullRequests;

	lines.push('  build:');
	lines.push(
		`    if: (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && inputs.ew_mode != 'verify'`
	);
	lines.push(`    runs-on: ${yamlString(runnerLabel)}`);
	// FR-24/S20 are exact: this is build.resources.timeoutMinutes and nothing else.
	// Only the `verify` job adds the 30-minute verification window (FR-53, `APW05-G22`).
	lines.push(`    timeout-minutes: ${build.resources.timeoutMinutes}`);
	lines.push(
		`    permissions: { contents: read, packages: write${attestations ? ', attestations: write, id-token: write' : ''} }`
	);

	if (build.services.length > 0) {
		lines.push('    services:');
		for (const service of build.services) lines.push(...serviceLines(service));
	}

	lines.push('    env:');
	lines.push(`      EW_IMAGE: ${yamlString(image)}`);
	lines.push(
		`      EW_SHA: ${yamlString('${{ inputs.ew_sha || github.event.pull_request.head.sha || github.sha }}')}`
	);
	lines.push(`      EW_SECRET_NAMES: ${yamlString(secretNames.join(' '))}`);
	lines.push('    steps:');

	if (fromEnv.length > 0) {
		lines.push('      - name: Check build values');
		// XC-01: a pull request legitimately has no stored value, so the missing
		// check runs only outside one — and only when the restricted path is on.
		if (restricted) lines.push(`        if: github.event_name != 'pull_request'`);
		lines.push('        env:');
		for (const name of fromEnv) {
			lines.push(
				`          ${APP_BUILD_SECRET_PREFIX}${name}: ${yamlString(`\${{ secrets.${APP_BUILD_SECRET_PREFIX}${name} }}`)}`
			);
		}
		lines.push('        run: |');
		const checkNames = fromEnv.map((name) => `${APP_BUILD_SECRET_PREFIX}${name}`).join(' ');
		lines.push(
			...scalarBlock(
				[
					'set -euo pipefail',
					`for name in ${checkNames}; do`,
					'  [ -n "${!name:-}" ] || { echo "EW_MISSING:${name#EW_}"; exit 78; }',
					'done'
				],
				10
			)
		);
	}

	lines.push(`      - uses: ${actionPin(ACTION_PINS.checkout)}`);
	lines.push('        with:');
	lines.push(`          ref: ${yamlString('${{ env.EW_SHA }}')}`);
	lines.push('          fetch-depth: 1');
	lines.push('          persist-credentials: false');
	lines.push('          lfs: false');

	if (canonical.settings.reclaimDisk) {
		lines.push('      - name: Reclaim runner disk');
		lines.push(
			'        run: sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL'
		);
	}

	// Unknown images get no health options from `BUILD_SERVICE_DEFAULTS` (their
	// kind is unrecognised), so the job waits on the declared port itself
	// (plan §4.5, `BUILD_SERVICE_HEALTH_KINDS.waitLoop`).
	const waitPorts = build.services
		.filter((service) => resolveBuildServiceKind(service.image) === null)
		.map((service) => service.port)
		.filter((port): port is number => typeof port === 'number');
	if (waitPorts.length > 0) {
		lines.push('      - name: Wait for the build services');
		lines.push('        run: |');
		lines.push(
			...scalarBlock(
				[
					'set -euo pipefail',
					`for port in ${waitPorts.join(' ')}; do`,
					'  deadline=$((SECONDS + 60))',
					'  until (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; do',
					'    [ "$SECONDS" -lt "$deadline" ] || { echo "EW_SERVICE_TIMEOUT:$port"; exit 78; }',
					'  done',
					'done'
				],
				10
			)
		);
	}

	lines.push(`      - uses: ${actionPin(ACTION_PINS.setupBuildx)}`);
	if (build.services.length > 0) {
		lines.push('        with:');
		lines.push(`          buildkitd-flags: ${yamlString('--allow-insecure-entitlement network.host')}`);
	}

	lines.push(`      - uses: ${actionPin(ACTION_PINS.login)}`);
	lines.push('        with:');
	lines.push('          registry: ghcr.io');
	lines.push(`          username: ${yamlString('${{ github.actor }}')}`);
	lines.push(`          password: ${yamlString('${{ secrets.GITHUB_TOKEN }}')}`);

	lines.push('      - id: build');
	lines.push(`        if: inputs.ew_mode != 'verify'`);
	lines.push(`        uses: ${actionPin(ACTION_PINS.buildPush)}`);
	lines.push('        with:');
	lines.push(`          context: ${yamlString(build.context)}`);
	lines.push(`          file: ${yamlString(`${build.context}/${build.dockerfile}`)}`);
	if (build.target) lines.push(`          target: ${yamlString(build.target)}`);
	// `load` + a separate push is what lets the secret-in-image check run before
	// any byte leaves the runner (FR-21, plan §2.4:310–312).
	lines.push('          load: true');
	lines.push('          push: false');
	lines.push('          provenance: false');
	if (build.services.length > 0) {
		lines.push('          network: host');
		lines.push('          allow: network.host');
	}
	if (build.args.length > 0) {
		lines.push('          build-args: |');
		lines.push(
			...scalarBlock(
				build.args.map((arg) =>
					arg.fromEnv === undefined
						? `${arg.name}=${arg.value ?? ''}`
						: `${arg.name}=${restrictedValueExpression(arg.fromEnv, restricted)}`
				),
				12
			)
		);
	}
	lines.push('          tags: |');
	lines.push(
		...scalarBlock(
			[
				`\${{ env.EW_IMAGE }}:sha-\${{ env.EW_SHA }}`,
				`\${{ env.EW_IMAGE }}:\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'branch-${slug}' }}`
			],
			12
		)
	);
	lines.push('          labels: |');
	lines.push(
		...scalarBlock(
			[
				'org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}',
				'org.opencontainers.image.revision=${{ env.EW_SHA }}',
				`io.ever-works.app-spec-hash=${canonical.appSpecHash}`
			],
			12
		)
	);
	lines.push('          cache-from: type=registry,ref=${{ env.EW_IMAGE }}:buildcache');
	// FR-26: a pull request never writes the cache.
	lines.push(
		`          cache-to: \${{ github.event_name == 'push' && format('type=registry,ref={0}:buildcache,mode=max', env.EW_IMAGE) || '' }}`
	);

	if (secretNames.length > 0) {
		lines.push('      - name: Check the image for secret build values');
		lines.push('        id: secretcheck');
		lines.push(`        if: inputs.ew_mode != 'verify'`);
		lines.push('        env:');
		for (const name of secretNames) {
			lines.push(`          ${name}: ${yamlString(`\${{ secrets.${name} }}`)}`);
		}
		lines.push('        run: |');
		lines.push(
			...scalarBlock(
				[
					'set -euo pipefail',
					`docker image inspect "$EW_IMAGE:sha-$EW_SHA" > "$RUNNER_TEMP/ew-image.json"`,
					`docker history --no-trunc --format '{{.CreatedBy}}' "$EW_IMAGE:sha-$EW_SHA" >> "$RUNNER_TEMP/ew-image.json"`,
					'for name in $EW_SECRET_NAMES; do',
					'  value="${!name:-}"',
					'  [ "${#value}" -ge 8 ] || continue',
					'  if grep -qF -- "$value" "$RUNNER_TEMP/ew-image.json"; then echo "EW_SECRET_IN_IMAGE:${name#EW_}"; exit 79; fi',
					'done',
					'echo "secret-check: passed"'
				],
				10
			)
		);
	}

	lines.push('      - name: Push');
	lines.push(`        if: inputs.ew_mode != 'verify'`);
	lines.push('        run: |');
	lines.push(
		...scalarBlock(
			[
				'docker push --all-tags "$EW_IMAGE"',
				`docker image inspect --format '{{index .RepoDigests 0}}' "$EW_IMAGE:sha-$EW_SHA" > ew-digest.txt`
			],
			10
		)
	);

	lines.push(...verifyInRunnerStep(job.verifyRunnerScript));
	lines.push(...resultStep('build', secretNames.length > 0));
	lines.push(...uploadArtifactStep());
	return lines;
}

/** `<NAME>=<value>` or, with the XC-01 opt-out off, the restricted marker for a pull request (plan §4.7b). */
function restrictedValueExpression(name: string, restricted: boolean): string {
	const secret = `secrets.${APP_BUILD_SECRET_PREFIX}${name}`;
	return restricted
		? `\${{ github.event_name == 'pull_request' && '${APP_BUILD_RESTRICTED_VALUE_LITERAL}' || ${secret} }}`
		: `\${{ ${secret} }}`;
}

/** One `services.<name>` entry — declared env over the image defaults, the published port, and the health options (§4.5). */
function serviceLines(service: CanonicalBuildBlock['services'][number]): string[] {
	const kind: BuildServiceKind | null = resolveBuildServiceKind(service.image);
	const lines: string[] = [`      ${service.name}:`, `        image: ${yamlString(service.image)}`];
	// Declared wins per variable; every other image default still applies (§4.5).
	const env =
		kind === null
			? Object.fromEntries(service.env.map((entry) => [entry.name, entry.value]))
			: resolveBuildServiceEnv(kind, service.env);
	const names = Object.keys(env).sort();
	if (names.length > 0) {
		lines.push('        env:');
		for (const name of names) lines.push(`          ${name}: ${yamlString(env[name])}`);
	}

	const port = evaluateBuildServicePort(service);
	if (!port.ok) {
		// `evaluateBuildServicePort` refuses an unrecognised image with no declared
		// port; the generator has no port to publish, so it publishes none and lets
		// the caller's `buildServicePortRequired` block speak (§4.5:825–827).
		lines.push('        ports: []');
		return lines;
	}
	lines.push(`        ports: [${yamlString(port.published)}]`);

	if (kind === null) return lines;
	const health = BUILD_SERVICE_DEFAULTS[kind].health;
	const command =
		health.kind === 'command'
			? health.command.replace('<user>', env.POSTGRES_USER ?? '').replace('<db>', env.POSTGRES_DB ?? '')
			: `curl -fsS http://localhost:${BUILD_SERVICE_DEFAULTS[kind].containerPort}${health.kind === 'http' ? health.path : ''}`;
	lines.push(
		`        options: ${yamlString(
			`--health-cmd "${command}" --health-interval 10s --health-timeout 5s --health-retries 5`
		)}`
	);
	return lines;
}

interface VerifyJobInput {
	readonly build: CanonicalBuildBlock | null;
	readonly image: string;
	readonly runnerLabel: string;
	readonly verifyRunnerScript: string;
}

/** The `verify` job — plan §2.4:243–274. Emitted in every file; the only job of a bootstrap file. */
function verifyJob(job: VerifyJobInput): string[] {
	const { build, image, runnerLabel, verifyRunnerScript } = job;
	const buildTimeout = build?.resources.timeoutMinutes ?? 0;
	const services = build?.services ?? [];
	const lines: string[] = [];

	lines.push('  verify:');
	lines.push(`    if: github.event_name == 'workflow_dispatch' && inputs.ew_mode == 'verify'`);
	lines.push(`    runs-on: ${yamlString(runnerLabel)}`);
	// FR-53: the verification window is added to THIS job only, never to `build`
	// (FR-24/S20 stay exact — `APW05-G22`). A bootstrap file has no build block, so
	// its verify job carries the 30 minutes alone.
	lines.push(`    timeout-minutes: ${buildTimeout + APP_BUILD_VERIFY_TIMEOUT_MINUTES}`);
	// FR-54: never `packages: write` — a verification can neither publish an image
	// nor write the cache a deployable build reads.
	lines.push('    permissions: { contents: read, packages: read }');
	lines.push('    env:');
	lines.push(`      EW_IMAGE: ${yamlString(image)}`);
	lines.push(`      EW_SHA: ${yamlString('${{ inputs.ew_sha }}')}`);
	lines.push(`      EW_REUSE_DIGEST: ${yamlString('${{ inputs.ew_reuse_digest }}')}`);
	lines.push('    steps:');
	lines.push(`      - uses: ${actionPin(ACTION_PINS.checkout)}`);
	lines.push('        with:');
	lines.push(`          ref: ${yamlString('${{ inputs.ew_sha }}')}`);
	lines.push('          fetch-depth: 1');
	lines.push('          persist-credentials: false');
	lines.push('          lfs: false');
	lines.push(`      - uses: ${actionPin(ACTION_PINS.setupBuildx)}`);
	if (services.length > 0) {
		lines.push('        with:');
		lines.push(`          buildkitd-flags: ${yamlString('--allow-insecure-entitlement network.host')}`);
	}
	lines.push(`      - uses: ${actionPin(ACTION_PINS.login)}`);
	lines.push('        with:');
	lines.push('          registry: ghcr.io');
	lines.push(`          username: ${yamlString('${{ github.actor }}')}`);
	lines.push(`          password: ${yamlString('${{ secrets.GITHUB_TOKEN }}')}`);
	lines.push('      - name: Take the image to verify');
	lines.push('        run: |');
	lines.push(
		...scalarBlock(
			[
				'set -euo pipefail',
				'plan="$RUNNER_TEMP/ew-verify-plan.json"',
				`plan_b64="$(printf '%s' "\${{ inputs.${APP_BUILD_VERIFY_PLAN_INPUT} }}" | tr '_-' '/+')"`,
				'case $(( ${#plan_b64} % 4 )) in 2) plan_b64="${plan_b64}==" ;; 3) plan_b64="${plan_b64}=" ;; esac',
				`printf '%s' "$plan_b64" | base64 -d > "$plan"`,
				`printf 'EW_VERIFY_BUILD=%s\\n' "$(jq -r '.build // empty | @base64' "$plan")" >> "$GITHUB_ENV"`,
				'if [ -n "$EW_REUSE_DIGEST" ]; then',
				'  docker pull "$EW_IMAGE@$EW_REUSE_DIGEST"',
				'  exit 0',
				'fi',
				'[ -n "$EW_VERIFY_BUILD" ] || { echo "EW_VERIFY_NO_BUILD"; exit 78; }',
				`context="$(jq -r '.build.context // "."' "$plan")"`,
				`dockerfile="$(jq -r '.build.dockerfile // "Dockerfile"' "$plan")"`,
				`target="$(jq -r '.build.target // empty' "$plan")"`,
				'buildx_args=(--load --file "$context/$dockerfile" --cache-from "$EW_IMAGE:buildcache" --tag ew-verify:local)',
				'if [ -n "$target" ]; then buildx_args+=(--target "$target"); fi',
				'while IFS= read -r entry; do',
				'  [ -n "$entry" ] || continue',
				'  buildx_args+=(--build-arg "$entry")',
				`done < <(jq -r '(.build.args // [])[] | select(.value != null) | "\\(.name)=\\(.value)"' "$plan")`,
				'docker buildx build "${buildx_args[@]}" "$context"'
			],
			10
		)
	);
	lines.push(...verifyInRunnerStep(verifyRunnerScript));
	lines.push(...resultStep('verify', false));
	lines.push(...uploadArtifactStep());
	return lines;
}

/** The "Verify in the runner" step both jobs carry — §4.10's embedded script, guarded by the plan input (§2.4). */
function verifyInRunnerStep(verifyRunnerScript: string): string[] {
	return [
		'      - name: Verify in the runner',
		`        if: inputs.${APP_BUILD_VERIFY_PLAN_INPUT} != ''`,
		`        timeout-minutes: ${APP_BUILD_VERIFY_TIMEOUT_MINUTES}`,
		'        run: |',
		...scalarBlock(verifyRunnerScript.replace(/\n+$/, '').split('\n'), 10)
	];
}

/**
 * The "Write result" step — §2.4's result write, and the artifact T12 reads.
 *
 * `if: always()`: a failed build still writes what happened, which is what makes a
 * failure diagnosable at all. The `build` job reports the digest it pushed and the
 * secret check's outcome; the `verify` job reports whether it reused a digest or
 * built locally — **no digest claim and no tags**, because it never pushed (FR-54).
 *
 * `secretCheckPresent` is not cosmetic: `steps.<id>.outcome` may only be read when
 * the step carrying that id exists, and the secret-check step is emitted only when
 * the App Work has secret build values. `actionlint` (the tool T8's Done-when
 * names) refuses the file otherwise — `property "secretcheck" is not defined in
 * object type {build: …}` — which is how the reference was caught here rather than
 * in a customer's run.
 */
function resultStep(job: 'build' | 'verify', secretCheckPresent: boolean): string[] {
	const script =
		job === 'build'
			? [
					'set -euo pipefail',
					'digest=""',
					`[ ! -f ew-digest.txt ] || digest="$(tr -d '[:space:]' < ew-digest.txt)"`,
					`secret_check="not_needed"`,
					...(secretCheckPresent
						? [
								`if [ -n "$EW_SECRET_NAMES" ]; then`,
								`  secret_check="passed"`,
								`  [ "\${{ steps.secretcheck.outcome }}" != "failure" ] || secret_check="failed"`,
								`fi`
							]
						: []),
					`jq -n --arg buildId "\${{ inputs.ew_build_id }}" --arg sha "$EW_SHA" \\`,
					`  --arg imageRepository "$EW_IMAGE" --arg digest "$digest" --arg secretCheck "$secret_check" \\`,
					`  --arg tag "$EW_IMAGE:sha-$EW_SHA" \\`,
					`  '{schema:"ever-works-build-result",version:1,buildId:$buildId,sha:$sha,imageRepository:$imageRepository,'`,
					`    digest:$digest,tags:[$tag],secretCheck:$secretCheck,verification:{jobs:[],smoke:[]}}' > ${APP_BUILD_RESULT_ARTIFACT_FILE}`
				]
			: [
					'set -euo pipefail',
					`reused_digest="$EW_REUSE_DIGEST"`,
					`local_build=true`,
					`[ -z "$reused_digest" ] || local_build=false`,
					`jq -n --arg buildId "\${{ inputs.ew_build_id }}" --arg sha "$EW_SHA" \\`,
					`  --arg imageRepository "$EW_IMAGE" --arg reusedDigest "$reused_digest" \\`,
					`  --argjson localBuild "$local_build" \\`,
					`  '{schema:"ever-works-build-result",version:1,buildId:$buildId,sha:$sha,imageRepository:$imageRepository,'`,
					`    reusedDigest:$reusedDigest,localBuild:$localBuild,verification:{jobs:[],smoke:[]}}' > ${APP_BUILD_RESULT_ARTIFACT_FILE}`
				];
	return ['      - name: Write result', '        if: always()', '        run: |', ...scalarBlock(script, 10)];
}

/** The result upload — §2.4's `actions/upload-artifact`, `if: always()` with `if-no-files-found: ignore`. */
function uploadArtifactStep(): string[] {
	return [
		`      - uses: ${actionPin(ACTION_PINS.uploadArtifact)}`,
		'        if: always()',
		'        with:',
		`          name: ${yamlString(APP_BUILD_RESULT_ARTIFACT_NAME)}`,
		`          path: ${yamlString(APP_BUILD_RESULT_ARTIFACT_FILE)}`,
		`          retention-days: ${APP_BUILD_RESULT_ARTIFACT_RETENTION_DAYS}`,
		'          if-no-files-found: ignore'
	];
}
