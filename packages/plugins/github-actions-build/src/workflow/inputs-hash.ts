import { APP_BUILD_GENERATOR_VERSION, sha256Hex, type AppBuildRunnerClass } from '@ever-works/contracts';

import { canonicalActionPins } from './action-pins.js';

/**
 * APW-05 T8 — the canonical inputs of a generated workflow and their fingerprint.
 *
 * Plan §4.5: "**Canonical inputs**: `{ generator: 1, trackedBranch, build
 * (normalised: defaults applied, keys sorted), values: names + secret +
 * fromBuildService (never values), runner: { label, class }, settings: {
 * reclaimDisk, attestations }, pins: ACTION_PINS, verifyEnabled, checks: [{ name,
 * required, timeoutMinutes, commandSha256 }] }`. `inputsHash = sha256(canonical
 * JSON)`."
 *
 * ## Why this canonical set is wider than the plan's line, deliberately
 *
 * The line above was written before `XC-01` (2026-09-17) added
 * `allowBuildValuesOnPullRequests`, and it never mentioned the repository, the
 * App spec hash, the bootstrap flag or the embedded verify-runner script — all of
 * which change the generated **bytes**. A fingerprint that stays still while the
 * bytes move is worse than no fingerprint: plan §4.5 relies on it to decide
 * whether an App Work needs a new commit or pull request ("Bumping pins bumps
 * `inputsHash`, so every App Work gets a pull request or commit with the new file
 * on its next preparation"), and §2.4's header line publishes it as the file's
 * identity. So every field below is either the plan's own or one that changes the
 * output, and {@link CANONICAL_INPUT_FIELDS} lists them in one place.
 *
 * `values` keeps the plan's rule exactly: **names, `secret` and
 * `fromBuildService` only — never a value, never a fingerprint.** Two App Works
 * whose `DATABASE_URL` is the same env entry name with different stored values
 * have the same workflow bytes, and that is the point: rotating a secret must not
 * rewrite a workflow file.
 *
 * The JSON form is fixed here rather than left to `JSON.stringify`'s insertion
 * order: keys are written in {@link CANONICAL_INPUT_FIELDS} order, arrays that
 * the caller may hand in unordered (values, build args, services, checks) are
 * sorted by their own key, and the result contains no whitespace — so the same
 * inputs hash the same on every platform (ACC-05-03).
 */

/** One build service, canonicalised (plan §2.4 `services`, §4.5 `BUILD_SERVICE_DEFAULTS`). */
export interface CanonicalBuildService {
	readonly name: string;
	readonly image: string;
	/** The declared published port, when the App spec gives one. */
	readonly port?: number;
	/** The declared `env`, sorted by name — the image defaults are applied at emission, not here. */
	readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** One build argument, canonicalised (plan §2.4 `build-args`). */
export interface CanonicalBuildArg {
	readonly name: string;
	/** A literal value, as written in the App spec. */
	readonly value?: string;
	/** The build-value name this argument reads from the repository secrets. */
	readonly fromEnv?: string;
}

/** The App spec's `build` block, normalised (plan §4.5: "defaults applied, keys sorted"). */
export interface CanonicalBuildBlock {
	readonly strategy: string;
	/** `build.context`, defaulted to `.` — plan §2.4 `context: <build.context>`. */
	readonly context: string;
	/** `build.dockerfile`, defaulted to `Dockerfile`, relative to the repository root. */
	readonly dockerfile: string;
	readonly target?: string;
	readonly args: readonly CanonicalBuildArg[];
	readonly services: readonly CanonicalBuildService[];
	readonly resources: {
		readonly cpu: number;
		readonly memoryGiB?: number;
		readonly timeoutMinutes: number;
	};
}

/** One synced build value's contribution — plan §4.5: "names + secret + fromBuildService (never values)". */
export interface CanonicalBuildValue {
	readonly name: string;
	readonly secret: boolean;
	readonly fromBuildService: boolean;
}

/** One App spec check (R-9, plan §4.5) — the command travels as its digest. */
export interface CanonicalCheck {
	readonly name: string;
	readonly required: boolean;
	/** `ceil(timeoutSeconds / 60)` — the plan's unit. */
	readonly timeoutMinutes: number;
	readonly commandSha256: string;
}

/** The runner the workflow will ask for (plan §4.5 `runner: { label, class }`). */
export interface CanonicalRunner {
	readonly label: string;
	readonly class: AppBuildRunnerClass;
}

/** The two settings that change the emitted bytes (plan §4.4, §4.5) plus XC-01's opt-out. */
export interface CanonicalSettings {
	readonly reclaimDisk: boolean;
	/** The **effective** value: `settings.attestations === true && repository.visibility === 'public'` (plan §4.5, `APW05-G07`). */
	readonly attestations: boolean;
	readonly allowBuildValuesOnPullRequests: boolean;
	readonly verificationPromptedValuesRequireApproval: boolean;
}

/** Everything the fingerprint covers, in the order the canonical JSON writes it. */
export interface CanonicalWorkflowInputs {
	readonly generator: typeof APP_BUILD_GENERATOR_VERSION;
	readonly bootstrap: boolean;
	readonly trackedBranch: string;
	readonly repository: {
		readonly owner: string;
		readonly repo: string;
		readonly visibility: 'public' | 'private';
	};
	readonly appSpecHash: string;
	/** `null` for the bootstrap file of plan §4.6 step 0, which carries no build block. */
	readonly build: CanonicalBuildBlock | null;
	readonly values: readonly CanonicalBuildValue[];
	readonly runner: CanonicalRunner;
	readonly settings: CanonicalSettings;
	readonly pins: Record<string, string>;
	readonly verifyEnabled: boolean;
	readonly checks: readonly CanonicalCheck[];
	/** sha256 of the embedded verify-runner script — a T15 change must move the file. */
	readonly verifyRunnerScriptSha256: string;
}

/**
 * The canonical key order, as data.
 *
 * `canonicalJson` writes exactly these keys in this order; the spec asserts that
 * this list and the emitted header agree, so adding a field cannot half-land.
 */
export const CANONICAL_INPUT_FIELDS = [
	'generator',
	'bootstrap',
	'trackedBranch',
	'repository',
	'appSpecHash',
	'build',
	'values',
	'runner',
	'settings',
	'pins',
	'verifyEnabled',
	'checks',
	'verifyRunnerScriptSha256'
] as const;

/** `ceil(timeoutSeconds / 60)` — the plan's minutes unit for a check (R-9, plan §4.5). */
export function checkTimeoutMinutes(timeoutSeconds: number): number {
	return Math.max(1, Math.ceil(timeoutSeconds / 60));
}

/** A check as the canonical inputs carry it — the command only as its digest. */
export function canonicalCheck(check: {
	readonly name: string;
	readonly command: string;
	readonly required: boolean;
	readonly timeoutSeconds: number;
}): CanonicalCheck {
	return {
		name: check.name,
		required: check.required,
		timeoutMinutes: checkTimeoutMinutes(check.timeoutSeconds),
		commandSha256: sha256Hex(check.command)
	};
}

/**
 * Sort the parts a caller may hand in unordered, so the canonical JSON — and the
 * hash — is order-independent (ACC-05-03).
 *
 * `values` by name (then `secret`, then `fromBuildService`, so two entries that
 * somehow share a name still order deterministically); build args by name;
 * services by name; checks by name.
 */
export function canonicaliseWorkflowInputs(inputs: CanonicalWorkflowInputs): CanonicalWorkflowInputs {
	const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
	return {
		...inputs,
		build:
			inputs.build === null
				? null
				: {
						...inputs.build,
						args: [...inputs.build.args].sort(
							(left, right) =>
								compare(left.name, right.name) ||
								compare(left.value ?? '', right.value ?? '') ||
								compare(left.fromEnv ?? '', right.fromEnv ?? '')
						),
						services: [...inputs.build.services]
							.map((service) => ({
								...service,
								env: [...service.env].sort((left, right) => compare(left.name, right.name))
							}))
							.sort((left, right) => compare(left.name, right.name))
					},
		values: [...inputs.values].sort(
			(left, right) =>
				compare(left.name, right.name) ||
				Number(left.secret) - Number(right.secret) ||
				Number(left.fromBuildService) - Number(right.fromBuildService)
		),
		checks: [...inputs.checks].sort((left, right) => compare(left.name, right.name)),
		pins: canonicalActionPins()
	};
}

/** The canonical JSON of {@link CANONICAL_INPUT_FIELDS}, no whitespace, fixed key order. */
export function canonicalWorkflowJson(inputs: CanonicalWorkflowInputs): string {
	const canonical = canonicaliseWorkflowInputs(inputs);
	const ordered: Record<string, unknown> = {};
	for (const field of CANONICAL_INPUT_FIELDS) ordered[field] = canonical[field];
	return JSON.stringify(ordered);
}

/** `sha256:<64 hex>` over {@link canonicalWorkflowJson} — the header line's fingerprint (plan §2.4, §4.5). */
export function computeWorkflowInputsHash(inputs: CanonicalWorkflowInputs): string {
	return `sha256:${sha256Hex(canonicalWorkflowJson(inputs))}`;
}
