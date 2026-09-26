/**
 * APW-05 T14 remainder — the digest `docker push` printed in the build job's
 * `Push` step, read from the job's log (plan §4.8's no-token fallback).
 *
 * Plan §4.8: *"registry unreadable (private, no token yet) → confirmed only if
 * the artifact digest equals the digest reported by `docker push` in the job
 * log line `digest: sha256:…` of the Push step"*. This file finds that line;
 * `AppBuildsService` decides what it is worth, and only asks when the registry
 * itself answered that it cannot be read.
 *
 * ## Why only Push sections, and why EVERY one of them must agree
 *
 * The log is the member's own CI output on BOTH sides of the Push step: the
 * build before it prints whatever the member's Dockerfile prints, and the
 * "Verify in the runner" step after it runs the member's image and prints its
 * output (once APW-05 T15 replaces the stub). A line reading
 * `sha-<sha>: digest: sha256:… size: …` printed there must not count, and
 * neither may a copy of the Push step's header printed there, so:
 *
 *  - a section starts at a `Push` step header. GitHub logs a `run:` step as
 *    `##[group]Run <first line of its script>`, and the generator's Push script
 *    starts with {@link PUSH_STEP_SCRIPT_FIRST_LINE} (pinned against the
 *    generator by `push-digest.spec.ts`). A digest line outside every such
 *    section is ignored;
 *  - a section ends at the next `##[group]` line, which is the next step's
 *    header (the Push step's own group, its script echo and env block, holds no
 *    nested group);
 *  - only the Build's own `sha-<sha>` tag counts. The other tag is
 *    `branch-<slug>`, whose slug is member-controlled but restricted to
 *    `[a-z0-9._-]`, so it can never spell `sha-<40 hex>: digest:` at the start
 *    of a line;
 *  - the answer is the ONE digest every Push section names for that tag, and
 *    two different digests anywhere — inside one section, or across the real
 *    section and a copy the member printed before OR after it — are a refusal,
 *    not a choice. No position rule ("the last header wins") can tell the real
 *    header from a copy printed after it, so none is used: a copy can only turn
 *    the answer into a refusal, never into a digest the real Push step did not
 *    print. (Were the real section to fall outside the log tail that is read,
 *    a copy would be all that is left; the agent still confirms only a log
 *    digest EQUAL to the artifact's, which the platform's own step wrote.)
 *
 * Every refusal is `undefined`: the Build then stays `digestUnconfirmed`, which
 * is the safe answer and never a failure.
 */

/** The first line of the generated `Push` step's script (`workflow/generator.ts`). */
export const PUSH_STEP_SCRIPT_FIRST_LINE = 'docker push --all-tags "$EW_IMAGE"';

/** How GitHub's runner opens a step's log group. */
const GROUP_PREFIX = '##[group]';

/** The Push step's header line, as the runner logs it. */
const PUSH_STEP_HEADER = `${GROUP_PREFIX}Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`;

/** The runner's per-line timestamp prefix, e.g. `2026-09-21T10:03:01.1234567Z `. */
const RUNNER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

/** `docker push`'s per-tag summary line. */
const PUSH_DIGEST_LINE = /^(\S+): digest: (sha256:[a-f0-9]{64}) size: \d+$/;

/** A full commit sha, as the workflow's `sha-<sha>` tag spells it. */
const FULL_SHA = /^[a-f0-9]{40}$/;

/**
 * The digest the `Push` step logged for the `sha-<sha>` tag, or `undefined`
 * when there is no such line, no Push step, or more than one answer across all
 * Push sections.
 */
export function extractPushLogDigest(log: string, sha: string): string | undefined {
	if (!FULL_SHA.test(sha) || log.length === 0) return undefined;

	const tag = `sha-${sha}`;
	const digests = new Set<string>();
	let inPushSection = false;
	for (const line of log.split(/\r?\n/).map(contentOf)) {
		if (line.startsWith(GROUP_PREFIX)) {
			inPushSection = line === PUSH_STEP_HEADER;
			continue;
		}
		if (!inPushSection) continue;
		const match = PUSH_DIGEST_LINE.exec(line);
		if (match && match[1] === tag) digests.add(match[2]);
	}

	return digests.size === 1 ? [...digests][0] : undefined;
}

/** One log line without its byte-order mark, runner timestamp and trailing whitespace. */
function contentOf(raw: string): string {
	return raw
		.replace(/^\uFEFF/, '')
		.replace(RUNNER_TIMESTAMP, '')
		.trimEnd();
}
