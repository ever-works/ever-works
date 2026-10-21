import { resolveBuildServiceKind } from '@ever-works/contracts';

import type { WorkflowGeneratorInput } from './generator.js';

/**
 * Prompt-injection hardening — what the build-workflow generator refuses to write.
 *
 * The workflow `generator.ts` produces is committed to the App Work's repository
 * (straight onto the tracked branch for a repository the App Work created) and is
 * run by GitHub with that repository's secrets. Most of what it interpolates comes
 * from the App spec, and the App spec is not trusted text: an adopted fork's
 * `.works/works.yml` is the upstream author's, any agent may change `build`, and so
 * may the AI provisioner. Three properties of a string make it dangerous there, and
 * quoting cannot neutralise any of them:
 *
 *   1. **`${{` — a GitHub expression.** The Actions runner evaluates `${{ … }}`
 *      inside every YAML value, quoted or not, block scalar or not. A build
 *      argument `${{ secrets.ORG_DEPLOY_KEY }}` hands any repository or
 *      organisation secret to the attacker's Dockerfile; a service env value does
 *      the same for the attacker's service image. `${` alone is refused too: it is
 *      the prefix of every expression and of every shell parameter expansion, and
 *      no App-spec value the generator writes has a reason to carry it (the App
 *      spec's own reference grammar is `{{ … }}`, schema.md §21).
 *   2. **A line break.** A build argument is written as one line of a `|` block
 *      scalar; a value carrying a newline ends that line and the next one is
 *      parsed as YAML — new `with:` keys, a new job, `permissions: write-all`.
 *      YamlDotNet (what the Actions runner parses with) also breaks lines on
 *      U+0085, U+2028 and U+2029, so those count as line breaks here.
 *   3. **Any other control character** (C0, C1, DEL, BOM): never meaningful in a
 *      value the workflow carries, and the class every parser disagrees about.
 *
 * Names the generator writes as YAML keys or inside expressions (`EW_<NAME>`,
 * `secrets.EW_<NAME>`, `services.<name>`, a service's env keys) must additionally
 * match their pattern, so nothing but the characters a plain YAML key and an
 * expression identifier both accept ever reaches the file.
 *
 * The App spec validator refuses the same strings first (`app-spec.schema.ts`,
 * `APP_SPEC_WORKFLOW_SAFE_TEXT_PATTERN`); this guard is the floor that holds for
 * every caller of the generator, whatever validated the input — a refusal here is
 * `specInvalid` (`github-actions-build.plugin.ts`) and nothing is written.
 */

/** Why one input value cannot be written into the workflow. */
export type WorkflowInputRefusalCause =
	/** `${` — a GitHub expression or a shell parameter expansion. */
	| 'expression'
	/** CR, LF, NEL, LS or PS. */
	| 'lineBreak'
	/** A C0/C1 control character, DEL or a BOM. */
	| 'controlCharacter'
	/** A name or a value that is not the shape the file needs it to be. */
	| 'pattern';

/** The first refused value: where it is in the generator input, and why — never the value itself. */
export interface WorkflowInputRefusal {
	/** A path into {@link WorkflowGeneratorInput}, e.g. `build.args[2].value`. */
	readonly field: string;
	readonly cause: WorkflowInputRefusalCause;
}

/** Thrown by `generateWorkflow` for an input {@link findUnsafeWorkflowInput} refuses. */
export class WorkflowInputRefusedError extends Error {
	/** The `blocked.reason` the plugin reports for it (`APP_BUILD_BLOCKED_REASONS`). */
	readonly reason = 'specInvalid' as const;

	constructor(readonly refusal: WorkflowInputRefusal) {
		// The value is deliberately not in the message: it is untrusted text, and a
		// message travels into logs and a member-visible block detail.
		super(`The value at ${refusal.field} cannot be written into the build workflow (${refusal.cause}).`);
		this.name = 'WorkflowInputRefusedError';
	}
}

/** CR, LF, and the three code points YAML 1.1 parsers (YamlDotNet among them) also break lines on. */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

/** C0 (incl. tab), DEL, C1 and the BOM. Line breaks are matched first by {@link LINE_BREAK}. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\ufeff]/;

/** schema.md §0 `EnvName` — a build argument, a `fromEnv` and a build value name. */
export const WORKFLOW_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

/**
 * A build service's env key. Wider than `EnvName` on purpose — some service
 * images are configured by dotted, lower-case names (Elasticsearch's
 * `discovery.type`) — and still only characters a plain YAML key cannot misread.
 */
export const WORKFLOW_SERVICE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

/** schema.md §0 `Name` — a build service is a `services.<name>` key. */
export const WORKFLOW_SERVICE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,30}[a-z0-9])?$/;

/** A repository owner or name, as GitHub spells them. */
const REPOSITORY_COORDINATE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The App spec hash written into the image labels (64 hex in practice; never whitespace or YAML syntax). */
const APP_SPEC_HASH_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;

/**
 * A value substituted into a service's `--health-cmd "…"` option (the postgres
 * `<user>` / `<db>` placeholders). That option string is split by Docker, so a
 * quote or a space there would add `docker create` options of the author's
 * choosing (`--privileged`, a host mount) — only a database identifier's
 * characters are allowed.
 */
const HEALTH_COMMAND_ARGUMENT_PATTERN = /^[A-Za-z0-9_.@-]*$/;

/** Why `value` cannot be written as workflow text, or `null` when it can. */
export function unsafeWorkflowTextCause(value: unknown): WorkflowInputRefusalCause | null {
	if (typeof value !== 'string') return 'pattern';
	if (value.includes('${')) return 'expression';
	if (LINE_BREAK.test(value)) return 'lineBreak';
	if (CONTROL_CHARACTER.test(value)) return 'controlCharacter';
	return null;
}

/** True when `value` may be written as workflow text. */
export function isSafeWorkflowText(value: unknown): boolean {
	return unsafeWorkflowTextCause(value) === null;
}

/** True when `value` is a postgres identifier safe to substitute into `--health-cmd "…"`. */
export function isSafeHealthCommandArgument(value: unknown): boolean {
	return typeof value === 'string' && HEALTH_COMMAND_ARGUMENT_PATTERN.test(value);
}

/**
 * The first value of `input` the generator must not write, or `null`.
 *
 * Every interpolation site of `generator.ts` and `checks-job.ts` is covered,
 * including the ones whose value is platform-derived today (repository
 * coordinates, the runner label, the App spec hash): a guard that trusted its
 * caller for some fields would be one refactor away from trusting it for all.
 * The check command is the one exception — it never travels as text (FR-67,
 * base64 in `commandB64`) — and so is a build value's resolved `value`, which the
 * file never contains (ACC-05-05).
 */
export function findUnsafeWorkflowInput(input: WorkflowGeneratorInput): WorkflowInputRefusal | null {
	const refusals: WorkflowInputRefusal[] = [];
	const text = (field: string, value: unknown): void => {
		const cause = unsafeWorkflowTextCause(value);
		if (cause) refusals.push({ field, cause });
	};
	const shaped = (field: string, value: unknown, pattern: RegExp): void => {
		const cause = unsafeWorkflowTextCause(value);
		if (cause) refusals.push({ field, cause });
		else if (!pattern.test(value as string)) refusals.push({ field, cause: 'pattern' });
	};
	// A number is written raw (`timeout-minutes: 30`, a matrix row's minutes), so
	// only a finite, non-negative JavaScript number may pass — never a string.
	const finiteNumber = (field: string, value: unknown): void => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
			refusals.push({ field, cause: 'pattern' });
		}
	};

	text('trackedBranch', input.trackedBranch);
	shaped('repository.owner', input.repository?.owner, REPOSITORY_COORDINATE_PATTERN);
	shaped('repository.repo', input.repository?.repo, REPOSITORY_COORDINATE_PATTERN);
	shaped('appSpecHash', input.appSpecHash, APP_SPEC_HASH_PATTERN);
	text('runner.label', input.runner?.label);

	(input.values ?? []).forEach((value, index) => {
		shaped(`values[${index}].name`, value?.name, WORKFLOW_ENV_NAME_PATTERN);
	});

	const build = input.build;
	if (build) {
		if (build.context !== undefined) text('build.context', build.context);
		if (build.dockerfile !== undefined) text('build.dockerfile', build.dockerfile);
		if (build.target !== undefined) text('build.target', build.target);
		finiteNumber('build.resources.timeoutMinutes', build.resources?.timeoutMinutes);

		(build.args ?? []).forEach((arg, index) => {
			shaped(`build.args[${index}].name`, arg?.name, WORKFLOW_ENV_NAME_PATTERN);
			if (arg?.value !== undefined) text(`build.args[${index}].value`, arg.value);
			if (arg?.fromEnv !== undefined) {
				shaped(`build.args[${index}].fromEnv`, arg.fromEnv, WORKFLOW_ENV_NAME_PATTERN);
			}
		});

		(build.services ?? []).forEach((service, index) => {
			shaped(`build.services[${index}].name`, service?.name, WORKFLOW_SERVICE_NAME_PATTERN);
			text(`build.services[${index}].image`, service?.image);
			const postgres =
				typeof service?.image === 'string' && resolveBuildServiceKind(service.image) === 'postgres';
			if (service?.port !== undefined) finiteNumber(`build.services[${index}].port`, service.port);
			(service?.env ?? []).forEach((entry, envIndex) => {
				const at = `build.services[${index}].env[${envIndex}]`;
				shaped(`${at}.name`, entry?.name, WORKFLOW_SERVICE_ENV_NAME_PATTERN);
				text(`${at}.value`, entry?.value);
				// The two values the postgres health command substitutes (§4.5).
				if (
					postgres &&
					(entry?.name === 'POSTGRES_USER' || entry?.name === 'POSTGRES_DB') &&
					isSafeWorkflowText(entry?.value) &&
					!isSafeHealthCommandArgument(entry?.value)
				) {
					refusals.push({ field: `${at}.value`, cause: 'pattern' });
				}
			});
		});
	}

	(input.checks ?? []).forEach((check, index) => {
		text(`checks[${index}].name`, check?.name);
		// Written raw into the matrix row's flow mapping, so only a real boolean / number may pass.
		if (typeof check?.required !== 'boolean')
			refusals.push({ field: `checks[${index}].required`, cause: 'pattern' });
		finiteNumber(`checks[${index}].timeoutSeconds`, check?.timeoutSeconds);
	});

	return refusals[0] ?? null;
}

/** Throw {@link WorkflowInputRefusedError} for the first value {@link findUnsafeWorkflowInput} refuses. */
export function assertWorkflowInputSafe(input: WorkflowGeneratorInput): void {
	const refusal = findUnsafeWorkflowInput(input);
	if (refusal) throw new WorkflowInputRefusedError(refusal);
}
