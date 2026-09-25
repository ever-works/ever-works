import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { PUSH_STEP_SCRIPT_FIRST_LINE, extractPushLogDigest } from '../runs/push-digest.js';
import { generateWorkflow } from '../workflow/generator.js';
import { goldenFixtures } from './fixtures/workflow-fixtures.js';

/**
 * APW-05 T14 remainder — the digest `docker push` printed in the build job's
 * `Push` step (plan §4.8's no-token fallback).
 *
 * The log is the member's own CI output on both sides of the Push step (the
 * build before it, the member's image in "Verify in the runner" after it), so
 * the rules under test are the ones that keep a line the member printed from
 * being read as the platform's push: only `Push` sections count, a section ends
 * at the next step header, only the Build's own `sha-<sha>` tag counts, and a
 * copy of the Push header printed anywhere can only turn the answer into a
 * refusal — never into a digest the real Push step did not print.
 */

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const SPOOFED = `sha256:${'f'.repeat(64)}`;

/** One GitHub job-log line: the runner's timestamp, a space, the content. */
function line(content: string, second = 0): string {
	return `2026-09-21T10:0${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}.1234567Z ${content}`;
}

/** The `Push` step exactly as the runner logs it: header, script echo, env, then docker's output. */
function pushSection(digestLines: readonly string[]): string[] {
	return [
		line(`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`, 30),
		line(PUSH_STEP_SCRIPT_FIRST_LINE, 30),
		line(`docker image inspect --format '{{index .RepoDigests 0}}' "$EW_IMAGE:sha-$EW_SHA" > ew-digest.txt`, 30),
		line('shell: /usr/bin/bash -e {0}', 30),
		line('env:', 30),
		line('  EW_IMAGE: ghcr.io/acme/their-app/ever-works-app', 30),
		line(`  EW_SHA: ${SHA}`, 30),
		line('##[endgroup]', 30),
		line('The push refers to repository [ghcr.io/acme/their-app/ever-works-app]', 31),
		line('5f70bf18a086: Preparing', 31),
		line('5f70bf18a086: Pushed', 32),
		...digestLines.map((content) => line(content, 33))
	];
}

/** The build step before the push — the part of the log the member's Dockerfile can print into. */
function buildSection(extra: readonly string[] = []): string[] {
	return [
		line('##[group]Run docker/build-push-action@0000000000000000000000000000000000000000', 10),
		line('with:', 10),
		line('##[endgroup]', 10),
		line('#12 [4/5] RUN npm run build', 11),
		...extra.map((content) => line(content, 12)),
		line('#12 DONE 4.2s', 13)
	];
}

/**
 * "Verify in the runner", the step right after the push. Once APW-05 T15 replaces
 * the stub it runs the member's image and prints its output — a second place the
 * member can print into, and one that comes AFTER the real Push step.
 */
function verifySection(extra: readonly string[] = []): string[] {
	return [
		line('##[group]Run set -euo pipefail', 35),
		line('set -euo pipefail', 35),
		line('##[endgroup]', 35),
		...extra.map((content) => line(content, 36))
	];
}

/** The step after the push — the platform's own result write. */
function resultSection(extra: readonly string[] = []): string[] {
	return [
		line('##[group]Run set -euo pipefail', 40),
		line('set -euo pipefail', 40),
		line('##[endgroup]', 40),
		...extra.map((content) => line(content, 41))
	];
}

function logOf(...sections: string[][]): string {
	return `\uFEFF${sections.flat().join('\n')}\n`;
}

describe('extractPushLogDigest (plan §4.8, T14 remainder)', () => {
	it('reads the sha tag’s digest from the Push step', () => {
		const log = logOf(
			buildSection(),
			pushSection([`branch-main: digest: ${DIGEST} size: 1570`, `sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBe(DIGEST);
	});

	it('ignores a digest line the build printed before the Push step', () => {
		// Printed raw, exactly as the real line would read — and still ignored,
		// because it is not inside the Push step's section.
		const log = logOf(
			buildSection([`sha-${SHA}: digest: ${SPOOFED} size: 1570`]),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBe(DIGEST);
	});

	it('refuses, rather than choose, when the build printed a fake Push section naming another digest', () => {
		// Pinned value changed (review of APW-05 T14): this case used to expect
		// DIGEST under a "the LAST Push header wins" rule. That rule cannot tell the
		// real header from a copy printed AFTER it (the next case), so it was
		// replaced by "every Push section must agree". The spoof still never wins;
		// it now costs a refusal instead of being skipped by position.
		const log = logOf(
			buildSection([
				`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`,
				'##[endgroup]',
				`sha-${SHA}: digest: ${SPOOFED} size: 1570`
			]),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('refuses when the member’s image printed a fake Push section AFTER the real one', () => {
		// "Verify in the runner" runs after Push and prints the member's image's
		// output. Under "the last header wins" this copy replaced the real section.
		const log = logOf(
			buildSection(),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			verifySection([
				`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`,
				'##[endgroup]',
				`sha-${SHA}: digest: ${SPOOFED} size: 1570`
			]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('a copy of the Push header that names no digest, or the real one, changes nothing', () => {
		const emptyCopyAfter = logOf(
			buildSection(),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			verifySection([`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`, 'nothing to see']),
			resultSection()
		);
		expect(extractPushLogDigest(emptyCopyAfter, SHA)).toBe(DIGEST);

		const sameDigestBefore = logOf(
			buildSection([`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`, `sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			resultSection()
		);
		expect(extractPushLogDigest(sameDigestBefore, SHA)).toBe(DIGEST);
	});

	it('a digest line the member’s image printed after the Push step, with no header, does not count', () => {
		const log = logOf(
			buildSection(),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]),
			verifySection([`sha-${SHA}: digest: ${SPOOFED} size: 1570`]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBe(DIGEST);
	});

	it('answers undefined when the Push step logged no digest for the sha tag', () => {
		const log = logOf(buildSection(), pushSection([`branch-main: digest: ${DIGEST} size: 1570`]), resultSection());

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('answers undefined when the log has no Push step at all — a matching line elsewhere is not enough', () => {
		const log = logOf(buildSection([`sha-${SHA}: digest: ${SPOOFED} size: 1570`]), resultSection());

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('stops at the next step: a line after the Push section does not count', () => {
		const log = logOf(
			buildSection(),
			pushSection([]),
			resultSection([`sha-${SHA}: digest: ${SPOOFED} size: 1570`])
		);

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('only counts the Build’s own sha tag', () => {
		const other = 'b'.repeat(40);
		const log = logOf(buildSection(), pushSection([`sha-${other}: digest: ${DIGEST} size: 1570`]), resultSection());

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
		expect(extractPushLogDigest(log, other)).toBe(DIGEST);
	});

	it('refuses to choose between two different digests for the same tag', () => {
		const log = logOf(
			buildSection(),
			pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`, `sha-${SHA}: digest: ${SPOOFED} size: 1570`]),
			resultSection()
		);

		expect(extractPushLogDigest(log, SHA)).toBeUndefined();
	});

	it('refuses a malformed digest or a sha that is not 40 lower-case hex characters', () => {
		const log = logOf(buildSection(), pushSection([`sha-${SHA}: digest: sha256:abc size: 1570`]), resultSection());
		expect(extractPushLogDigest(log, SHA)).toBeUndefined();

		const good = logOf(buildSection(), pushSection([`sha-${SHA}: digest: ${DIGEST} size: 1570`]), resultSection());
		expect(extractPushLogDigest(good, '')).toBeUndefined();
		expect(extractPushLogDigest(good, SHA.toUpperCase())).toBeUndefined();
		expect(extractPushLogDigest(good, 'a'.repeat(7))).toBeUndefined();
	});

	it('reads CRLF logs and lines without the runner timestamp', () => {
		const bare = [
			`##[group]Run ${PUSH_STEP_SCRIPT_FIRST_LINE}`,
			'##[endgroup]',
			`sha-${SHA}: digest: ${DIGEST} size: 1570`,
			'##[group]Run set -euo pipefail'
		].join('\r\n');

		expect(extractPushLogDigest(bare, SHA)).toBe(DIGEST);
	});

	it('answers undefined for an empty log — an expired or unreadable one', () => {
		expect(extractPushLogDigest('', SHA)).toBeUndefined();
	});

	it('names the first line of the Push step the generator actually writes', () => {
		// The step header GitHub logs is `Run <first line of the script>`, so the
		// constant this parser keys on must be the generator's own first line. A
		// generator change that moved it would otherwise make every Build fall back
		// to "unconfirmed" silently.
		const workflow = yaml.load(generateWorkflow(goldenFixtures().minimal)) as {
			jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
		};
		const pushSteps = Object.values(workflow.jobs)
			.flatMap((job) => job.steps ?? [])
			.filter((step) => step.name === 'Push');

		expect(pushSteps).toHaveLength(1);
		expect(pushSteps[0].run?.split('\n')[0]).toBe(PUSH_STEP_SCRIPT_FIRST_LINE);
	});
});
