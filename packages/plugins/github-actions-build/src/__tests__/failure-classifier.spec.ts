import { describe, expect, it } from 'vitest';

import {
	BUILD_FAILURE_CLASSES,
	EXCERPT_MAX_LINES,
	EXCERPT_MAX_LINE_CHARS,
	classifyFailure,
	maskSecretShapes
} from '../runs/failure-classifier.js';

/**
 * APW-05 T13 — the failure classifier and the excerpt.
 *
 * Plan §4.9's table is ORDERED, and the two orderings that matter most each
 * have their own case below: `outOfMemory` beating `dockerfileError`, and
 * `missingBuildValue` beating everything. A classifier that got either backwards
 * would send a member to fix the wrong thing — a `RUN` line that is fine, or a
 * build that never started.
 */

const log = (...lines: string[]) => lines.join('\n');

describe('the ordered table (plan §4.9)', () => {
	it('1 · missingBuildValue, from the workflow’s own first step (ACC-05-14)', () => {
		const failure = classifyFailure({
			log: log('Check build values', 'EW_MISSING:DATABASE_URL', 'EW_MISSING:API_KEY', 'exit 78')
		});

		expect(failure.class).toBe('missingBuildValue');
		expect(failure.detail).toEqual({ names: ['DATABASE_URL', 'API_KEY'] });
	});

	it('1 beats everything — a first-step refusal happens before anything is built', () => {
		// Any other signal in the same log is noise from a previous attempt.
		const failure = classifyFailure({
			log: log('EW_MISSING:DATABASE_URL', 'exit code: 137', 'ERROR: failed to solve')
		});

		expect(failure.class).toBe('missingBuildValue');
	});

	it('2 · secretInImage, from §4.11’s check (ACC-05-15)', () => {
		const failure = classifyFailure({
			log: log('Scanning image layers', 'EW_SECRET_IN_IMAGE:STRIPE_KEY')
		});

		expect(failure.class).toBe('secretInImage');
		expect(failure.detail).toEqual({ names: ['STRIPE_KEY'] });
	});

	it('3 · timeout, by conclusion or by the runner’s message, with its minutes', () => {
		expect(classifyFailure({ log: 'anything', jobConclusion: 'timed_out', minutes: 360 })).toMatchObject({
			class: 'timeout',
			detail: { minutes: 360 }
		});
		expect(classifyFailure({ log: log('The job exceeded the maximum execution time of 360 minutes') }).class).toBe(
			'timeout'
		);
	});

	it('4 · workflowInvalid, from a startup failure or zero jobs', () => {
		expect(classifyFailure({ log: '', runConclusion: 'startup_failure' }).class).toBe('workflowInvalid');
		expect(classifyFailure({ log: '', jobCount: 0 }).class).toBe('workflowInvalid');
	});

	it('5 · outOfMemory, from any of its five signals', () => {
		for (const line of [
			'##[error]Process completed with exit code: 137',
			'Killed',
			'FATAL ERROR: JavaScript heap out of memory',
			'Reached heap limit Allocation failed',
			'Error: spawn ENOMEM'
		]) {
			expect([line, classifyFailure({ log: log('building', line) }).class]).toEqual([line, 'outOfMemory']);
		}
	});

	it('6 · diskFull', () => {
		expect(classifyFailure({ log: log('write: No space left on device') }).class).toBe('diskFull');
		expect(classifyFailure({ log: log('Error: ENOSPC: no space left') }).class).toBe('diskFull');
	});

	it('8 · dependencyDownloadFailed, from a transport signal', () => {
		for (const line of [
			'npm ERR! network ETIMEDOUT',
			'fatal: ECONNRESET',
			'getaddrinfo EAI_AGAIN registry.npmjs.org',
			'net/http: TLS handshake timeout',
			'429 Too Many Requests',
			'toomanyrequests: retry later'
		]) {
			expect([line, classifyFailure({ log: line }).class]).toEqual([line, 'dependencyDownloadFailed']);
		}
	});

	it('9 · dockerfileError names the step, the total and the command (≤ 120 chars)', () => {
		const failure = classifyFailure({
			log: log(
				'#11 [builder 2/7] COPY package.json .',
				'#12 [builder 3/7] RUN npm ci --omit=dev',
				'ERROR: failed to solve: process did not complete successfully'
			)
		});

		expect(failure.class).toBe('dockerfileError');
		expect(failure.detail).toEqual({
			dockerfile: 'builder',
			step: 3,
			total: 7,
			command: 'RUN npm ci --omit=dev'
		});
	});

	it('9 · caps the reported command at 120 characters', () => {
		const long = `RUN ${'x'.repeat(400)}`;
		const failure = classifyFailure({
			log: log(`#3 [stage 1/2] ${long}`, 'ERROR: failed to solve: boom')
		});

		expect(String((failure.detail as { command: string }).command)).toHaveLength(120);
	});

	it('10 · verificationFailed, from the artifact’s smoke rows', () => {
		const failure = classifyFailure({
			log: 'Verify in the runner: 2 of 5 checks failed',
			failingStepName: 'Verify in the runner',
			verification: { failed: 2, total: 5 }
		});

		expect(failure).toMatchObject({ class: 'verificationFailed', detail: { failed: 2, total: 5 } });
	});

	it('11 · unknown for anything else', () => {
		expect(classifyFailure({ log: log('something went wrong, somehow') }).class).toBe('unknown');
	});
});

describe('precedence — the two orderings that would send a member to the wrong place', () => {
	it('a log with BOTH `exit code: 137` and a Dockerfile step is `outOfMemory`', () => {
		// A container killed for memory prints both: the step BuildKit reports is
		// the one that was running when the kernel killed it. Calling that a
		// Dockerfile error sends the member to fix a `RUN` line that is fine.
		const failure = classifyFailure({
			log: log(
				'#12 [builder 3/7] RUN npm run build',
				'##[error]Process completed with exit code: 137',
				'ERROR: failed to solve: process did not complete successfully'
			)
		});

		expect(failure.class).toBe('outOfMemory');
	});

	it('a timeout outranks a transport error in the same log', () => {
		const failure = classifyFailure({
			log: log('npm ERR! network ETIMEDOUT'),
			jobConclusion: 'timed_out'
		});

		expect(failure.class).toBe('timeout');
	});

	it('covers every class the table declares', () => {
		// A row added to the table and not to this file would otherwise be
		// unexercised, and the classifier's whole value is that it is exhaustive.
		expect(BUILD_FAILURE_CLASSES).toHaveLength(11);
		expect([...BUILD_FAILURE_CLASSES]).toEqual([
			'missingBuildValue',
			'secretInImage',
			'timeout',
			'workflowInvalid',
			'outOfMemory',
			'diskFull',
			'registryPushDenied',
			'dependencyDownloadFailed',
			'dockerfileError',
			'verificationFailed',
			'unknown'
		]);
	});
});

describe('the excerpt (ACC-05-18)', () => {
	it('ends at the MATCHED line, not at the teardown', () => {
		const failure = classifyFailure({
			log: log(
				...Array.from({ length: 50 }, (_, index) => `building step ${index}`),
				'No space left on device',
				...Array.from({ length: 30 }, (_, index) => `cleanup ${index}`)
			)
		});

		expect(failure.excerpt.at(-1)).toBe('No space left on device');
	});

	it('is at most 20 lines of at most 300 characters', () => {
		const failure = classifyFailure({
			log: log(...Array.from({ length: 80 }, (_, index) => `line ${index} ${'z'.repeat(1_000)}`), 'ENOSPC')
		});

		expect(failure.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_LINES);
		for (const line of failure.excerpt) {
			expect(line.length).toBeLessThanOrEqual(EXCERPT_MAX_LINE_CHARS);
		}
	});

	it('falls back to the LAST lines when nothing matched', () => {
		const failure = classifyFailure({
			log: log(...Array.from({ length: 40 }, (_, index) => `line ${index}`))
		});

		expect(failure.class).toBe('unknown');
		expect(failure.excerpt.at(-1)).toBe('line 39');
	});

	it('applies the App Work’s own redactor — a known value becomes `***`', () => {
		const failure = classifyFailure({ log: log('connecting with s3cr3t-value', 'ENOSPC') }, (text) =>
			text.replace('s3cr3t-value', '***')
		);

		expect(failure.excerpt.join('\n')).toContain('***');
		expect(failure.excerpt.join('\n')).not.toContain('s3cr3t-value');
	});

	it('masks secret SHAPES the redactor never knew about', () => {
		// The second pass. `redact` knows this Work's registered values; the mask
		// catches what a build script printed that nobody registered.
		const failure = classifyFailure({
			log: log('Authorization: Bearer abcdefghijklmnop1234567890', 'ENOSPC')
		});

		expect(failure.excerpt.join('\n')).not.toContain('abcdefghijklmnop1234567890');
	});
});

describe('the secret-shape mask', () => {
	it('masks the shapes that can only be credentials', () => {
		expect(maskSecretShapes('token ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_');
		expect(maskSecretShapes('github_pat_11ABCDEFG0abcdefghij_klmnop')).not.toContain('github_pat_');
		expect(maskSecretShapes('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')).toContain('=***');
		expect(maskSecretShapes('postgres://user:hunter2@db:5432/app')).toContain('***:***@');
		expect(maskSecretShapes('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toContain('Basic ***');
	});

	it('leaves a git sha and a sha256 digest alone — the two most useful strings in a build log', () => {
		// They are longer than the base64 rule's 40-character bound, so a length
		// threshold alone masks both. This case is what disproved the first
		// draft's comment claiming otherwise; they are now excluded BY NAME.
		const sha = 'a'.repeat(40);
		const digest = 'b'.repeat(64);

		expect(maskSecretShapes(`Building ${sha}`)).toBe(`Building ${sha}`);
		expect(maskSecretShapes(`pushed sha256:${digest}`)).toContain(digest);
	});

	it('still masks a long run that is NOT a sha — the exclusion is exact', () => {
		// Same length as a git sha, but not hex: a base64 secret of forty
		// characters must not slip through the exclusion.
		const token = `${'A'.repeat(20)}${'z'.repeat(20)}`;
		expect(token).toHaveLength(40);
		expect(maskSecretShapes(`key ${token}`)).toBe('key ***');
	});

	it('leaves ordinary build output alone', () => {
		const line = '#12 [builder 3/7] RUN npm ci --omit=dev';
		expect(maskSecretShapes(line)).toBe(line);
	});
});
