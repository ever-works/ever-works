import { APP_BUILD_CHECK_NAME_PREFIX, APP_BUILD_RESTRICTED_VALUE_LITERAL } from '@ever-works/contracts';

/**
 * APW-05 T8 — the third-party actions the generated workflow is allowed to use,
 * pinned to a commit.
 *
 * Plan §4.5: "`ACTION_PINS` values are 40-character commit hashes with the
 * release tag in a trailing comment; a unit test fails when any pin is not 40 hex
 * characters. Bumping pins bumps `inputsHash`, so every App Work gets a pull
 * request or commit with the new file on its next preparation."
 *
 * ## How these five were resolved (and how to bump them)
 *
 * Each `sha` is the **commit** a release tag pointed at when this file was
 * written, read with `git ls-remote --tags https://github.com/<owner>/<repo>`,
 * peeling annotated tags (`^{}`) so a tag object's hash can never be mistaken for
 * a commit. `resolvedOn` records the day. A bump is: re-run that command, take
 * the newest stable tag's commit, update `sha` + `tag` + `resolvedOn` — nothing
 * else changes, and `inputsHash` moves on its own.
 *
 * The five names are exactly the plan §4.3 generator's set. A sixth action is
 * not "just another entry": §4.5's pin set is what the golden files pin, so a new
 * action is a new decision about what runs inside a customer's repository.
 */
export interface ActionPin {
	/** `owner/repo`, as it appears before the `@` in a `uses:` line. */
	readonly action: string;
	/** The release tag this commit was the tip of, for the trailing comment. */
	readonly tag: string;
	/** The 40-character commit hash that must appear after the `@`. */
	readonly sha: string;
	/** The day `sha` was resolved from the tag. */
	readonly resolvedOn: string;
}

const RESOLVED_ON = '2026-09-18';

export const ACTION_PINS = {
	/** `actions/checkout@v7.0.1`. */
	checkout: {
		action: 'actions/checkout',
		tag: 'v7.0.1',
		sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
		resolvedOn: RESOLVED_ON
	},
	/** `docker/setup-buildx-action@v4.4.1`. */
	setupBuildx: {
		action: 'docker/setup-buildx-action',
		tag: 'v4.4.1',
		sha: 'f87e5991a6d7451dcb8d9637bfbc97413f497069',
		resolvedOn: RESOLVED_ON
	},
	/** `docker/login-action@v4.6.0`. */
	login: {
		action: 'docker/login-action',
		tag: 'v4.6.0',
		sha: 'dbcb813823bdd20940b903addbd779551569679f',
		resolvedOn: RESOLVED_ON
	},
	/** `docker/build-push-action@v7.4.0`. */
	buildPush: {
		action: 'docker/build-push-action',
		tag: 'v7.4.0',
		sha: 'c3c9e263c25d99ce0380d002d59b67737d91b0dc',
		resolvedOn: RESOLVED_ON
	},
	/** `actions/upload-artifact@v7.0.1`. */
	uploadArtifact: {
		action: 'actions/upload-artifact',
		tag: 'v7.0.1',
		sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
		resolvedOn: RESOLVED_ON
	}
} as const satisfies Record<string, ActionPin>;

/** The keys of {@link ACTION_PINS}, in declaration order. */
export type ActionPinKey = keyof typeof ACTION_PINS;

/** A commit hash, and nothing else — plan §4.5's "40 hex characters" (ACC-05-05). */
export const ACTION_PIN_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `owner/repo@<40 hex>  # <tag>` — the exact `uses:` value, comment included. */
export function actionPin(pin: ActionPin): string {
	return `${pin.action}@${pin.sha} # ${pin.tag}`;
}

/** `owner/repo@<40 hex>` — the pin without its trailing comment, for a canonical input. */
export function actionPinReference(pin: ActionPin): string {
	return `${pin.action}@${pin.sha}`;
}

/**
 * The pin set in canonical form: key → `owner/repo@<40 hex>`, keys sorted.
 *
 * This is what `inputs-hash.ts` hashes, so a bump moves `inputsHash` (and
 * `resolvedOn` deliberately does **not**: it records when the hash was read, not
 * what will run).
 */
export function canonicalActionPins(): Record<string, string> {
	const keys = (Object.keys(ACTION_PINS) as ActionPinKey[]).sort();
	const canonical: Record<string, string> = {};
	for (const key of keys) canonical[key] = actionPinReference(ACTION_PINS[key]);
	return canonical;
}

/**
 * Names the generated workflow must never reference in clear text.
 *
 * Exported for the generator's own guard rather than for a caller: the
 * restricted pull-request literal and the check-name prefix are the two strings
 * the golden and generator specs assert against each other.
 */
export const GENERATOR_RESERVED_LITERALS = [APP_BUILD_RESTRICTED_VALUE_LITERAL, APP_BUILD_CHECK_NAME_PREFIX] as const;
