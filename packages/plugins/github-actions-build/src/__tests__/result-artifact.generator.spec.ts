import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_BUILD_RESULT_ARTIFACT_FILE } from '@ever-works/contracts';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { normaliseResultDigest, parseResultArtifact } from '../runs/result-artifact.js';
import { generateWorkflow } from '../workflow/generator.js';
import { goldenFixtures } from './fixtures/workflow-fixtures.js';

/**
 * Ledger C35 / outstanding-work A0.5 — the generator's "Write result" step and
 * `parseResultArtifact` must agree.
 *
 * They did not: the step wrote `schema, version, buildId, sha, verification`
 * and a `RepoDigests` digest (`<repo>@sha256:…`), and the parser allowed only
 * `digest, imageRepository, tags, secretCheck, smoke` with a bare digest — so
 * every real result was refused. Worse, the step's jq filter closed its quote at
 * the end of its first line, so the script did not even parse and no result was
 * ever written.
 *
 * This spec closes the loop on the generator's LITERAL output, not on a
 * hand-written copy of it:
 *
 *  1. it generates real workflows from the golden fixtures and pulls the
 *     `Write result` script out of the parsed YAML;
 *  2. `bash -n` parses that script (wherever bash exists — CI and Git Bash);
 *  3. a small shell-word reader evaluates the script's `jq -n` call the way
 *     bash would hand it to jq, with the values a real run has — including the
 *     `repo@sha256:…` digest the Push step records — and the object the filter
 *     builds is fed to `parseResultArtifact`, which must answer `ok`;
 *  4. when `jq` is on PATH the script is RUN for real and its file is parsed.
 */

const SHA = 'c0ffee'.padEnd(40, '0');
const BUILD_ID = '7f1c0f2e-1111-4111-8111-aaaaaaaaaaaa';
const DIGEST_HEX = 'ab'.repeat(32);

/** The `run:` script of the named job's "Write result" step, from the generated file. */
function writeResultScript(workflow: string, job: 'build' | 'verify'): string {
	const parsed = yaml.load(workflow) as {
		jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
	};
	const step = parsed.jobs[job]?.steps.find((candidate) => candidate.name === 'Write result');
	if (!step?.run) throw new Error(`no "Write result" step in the ${job} job`);
	return step.run;
}

/** GitHub's own `${{ … }}` substitution, which happens before bash ever sees the script. */
function substituteExpressions(script: string, expressions: Record<string, string>): string {
	return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression: string) => {
		if (!(expression in expressions)) throw new Error(`unexpected expression \${{ ${expression} }}`);
		return expressions[expression];
	});
}

/**
 * Split one shell command line into words — single quotes literal, double
 * quotes expanding `$NAME`, backslash-newline a continuation — stopping at the
 * first unquoted `>`. The subset of bash the generated jq call uses, and it
 * throws on an unterminated quote exactly where bash would refuse the script.
 */
function shellWords(command: string, env: Record<string, string>): string[] {
	const words: string[] = [];
	let current = '';
	let inWord = false;
	const expand = (text: string) =>
		text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
			if (!(name in env)) throw new Error(`unset variable $${name}`);
			return env[name];
		});
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (ch === '\\' && command[i + 1] === '\n') {
			i += 1;
			continue;
		}
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) throw new Error('unterminated single quote');
			current += command.slice(i + 1, end);
			inWord = true;
			i = end;
			continue;
		}
		if (ch === '"') {
			const end = command.indexOf('"', i + 1);
			if (end < 0) throw new Error('unterminated double quote');
			current += expand(command.slice(i + 1, end));
			inWord = true;
			i = end;
			continue;
		}
		if (ch === '>') break;
		if (ch === ' ' || ch === '\t' || ch === '\n') {
			if (inWord) words.push(current);
			current = '';
			inWord = false;
			continue;
		}
		current += ch;
		inWord = true;
	}
	if (inWord) words.push(current);
	return words;
}

/**
 * Evaluate `jq -n [--arg n v | --argjson n v]… <filter>` for the object-literal
 * filters the generator writes: bare keys, string/number literals, `$name`
 * references, arrays and nested objects.
 */
function evaluateJqCall(words: string[]): unknown {
	expect(words[0]).toBe('jq');
	expect(words[1]).toBe('-n');
	const args: Record<string, unknown> = {};
	let i = 2;
	while (words[i] === '--arg' || words[i] === '--argjson') {
		const [flag, name, value] = [words[i], words[i + 1], words[i + 2]];
		args[name] = flag === '--argjson' ? JSON.parse(value) : value;
		i += 3;
	}
	const filter = words[i];
	expect(words.length).toBe(i + 1);
	const json = filter
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
			if (!(name in args)) throw new Error(`jq: $${name} is not defined`);
			return JSON.stringify(args[name]);
		})
		.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
	return JSON.parse(json);
}

/** The jq command of a "Write result" script (its last command), with shell variables set the way the step sets them. */
function jqCommand(script: string): string {
	const start = script.indexOf('jq -n');
	if (start < 0) throw new Error('no jq call in the script');
	return script.slice(start);
}

function hasCommand(name: string): boolean {
	const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
	return !probe.error && probe.status === 0;
}

const HAS_BASH = hasCommand('bash');
const HAS_JQ = HAS_BASH && hasCommand('jq');

const fixtures = goldenFixtures();
const IMAGE = 'ghcr.io/ever-works/fixture-app';
/** What `docker image inspect --format '{{index .RepoDigests 0}}'` prints after a push. */
const REPO_DIGEST = `${IMAGE}@sha256:${DIGEST_HEX}`;

describe('ledger C35 — the generated "Write result" step and parseResultArtifact agree', () => {
	it('normalises the RepoDigests form to a bare digest, and nothing else', () => {
		expect(normaliseResultDigest(REPO_DIGEST)).toBe(`sha256:${DIGEST_HEX}`);
		expect(normaliseResultDigest(`  sha256:${DIGEST_HEX}\n`)).toBe(`sha256:${DIGEST_HEX}`);
		// Normalising never makes a malformed claim acceptable.
		expect(parseResultArtifact({ digest: `${IMAGE}@sha512:${DIGEST_HEX}` })).toEqual({
			ok: false,
			refusal: 'badDigest'
		});
	});

	for (const [name, input] of Object.entries(fixtures)) {
		const workflow = generateWorkflow(input);
		const parsed = yaml.load(workflow) as { jobs: Record<string, unknown> };

		describe(`fixture "${name}"`, () => {
			it.runIf(HAS_BASH)('the build job script parses (`bash -n`)', () => {
				const script = substituteExpressions(writeResultScript(workflow, 'build'), {
					'inputs.ew_build_id': BUILD_ID,
					'steps.secretcheck.outcome': 'success'
				});
				const check = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
				expect(check.stderr).toBe('');
				expect(check.status).toBe(0);
			});

			it('the build job result — with the RepoDigests digest the Push step records — is accepted', () => {
				const script = substituteExpressions(writeResultScript(workflow, 'build'), {
					'inputs.ew_build_id': BUILD_ID,
					'steps.secretcheck.outcome': 'success'
				});
				const result = evaluateJqCall(
					shellWords(jqCommand(script), {
						EW_SHA: SHA,
						EW_IMAGE: IMAGE,
						digest: REPO_DIGEST,
						secret_check: 'passed'
					})
				);

				const outcome = parseResultArtifact(result);
				expect(outcome).toEqual({
					ok: true,
					result: expect.objectContaining({
						digest: `sha256:${DIGEST_HEX}`,
						imageRepository: IMAGE,
						tags: [`${IMAGE}:sha-${SHA}`],
						secretCheck: 'passed',
						buildId: BUILD_ID,
						sha: SHA,
						schemaVersion: 1,
						smoke: [],
						verificationJobs: []
					})
				});
			});

			it('a failed build job (nothing pushed, `digest: ""`) is still accepted, claiming no image', () => {
				const script = substituteExpressions(writeResultScript(workflow, 'build'), {
					'inputs.ew_build_id': '',
					'steps.secretcheck.outcome': 'failure'
				});
				const result = evaluateJqCall(
					shellWords(jqCommand(script), { EW_SHA: SHA, EW_IMAGE: IMAGE, digest: '', secret_check: 'failed' })
				);
				const outcome = parseResultArtifact(result);
				expect(outcome.ok).toBe(true);
				if (outcome.ok) {
					expect(outcome.result.digest).toBeUndefined();
					expect(outcome.result.buildId).toBeUndefined();
					expect(outcome.result.secretCheck).toBe('failed');
				}
			});

			if ('verify' in parsed.jobs) {
				it.runIf(HAS_BASH)('the verify job script parses (`bash -n`)', () => {
					const script = substituteExpressions(writeResultScript(workflow, 'verify'), {
						'inputs.ew_build_id': BUILD_ID
					});
					const check = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
					expect(check.stderr).toBe('');
					expect(check.status).toBe(0);
				});

				it('the verify job result (reused digest, no digest claim) is accepted', () => {
					const script = substituteExpressions(writeResultScript(workflow, 'verify'), {
						'inputs.ew_build_id': BUILD_ID
					});
					const result = evaluateJqCall(
						shellWords(jqCommand(script), {
							EW_SHA: SHA,
							EW_IMAGE: IMAGE,
							reused_digest: `sha256:${DIGEST_HEX}`,
							local_build: 'false'
						})
					);
					const outcome = parseResultArtifact(result);
					expect(outcome.ok).toBe(true);
					if (outcome.ok) {
						expect(outcome.result.digest).toBeUndefined();
						expect(outcome.result.reusedDigest).toBe(`sha256:${DIGEST_HEX}`);
						expect(outcome.result.localBuild).toBe(false);
					}
				});
			}

			it.runIf(HAS_JQ)('running the build job script for real writes a file the parser accepts', () => {
				const dir = mkdtempSync(join(tmpdir(), 'ew-result-'));
				try {
					writeFileSync(join(dir, 'ew-digest.txt'), `${REPO_DIGEST}\n`);
					const script = substituteExpressions(writeResultScript(workflow, 'build'), {
						'inputs.ew_build_id': BUILD_ID,
						'steps.secretcheck.outcome': 'success'
					});
					const run = spawnSync('bash', ['-c', script], {
						cwd: dir,
						encoding: 'utf8',
						env: { ...process.env, EW_SHA: SHA, EW_IMAGE: IMAGE, EW_SECRET_NAMES: '' }
					});
					expect(run.stderr).toBe('');
					expect(run.status).toBe(0);
					const written = JSON.parse(readFileSync(join(dir, APP_BUILD_RESULT_ARTIFACT_FILE), 'utf8'));
					const outcome = parseResultArtifact(written);
					expect(outcome.ok).toBe(true);
					if (outcome.ok) expect(outcome.result.digest).toBe(`sha256:${DIGEST_HEX}`);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			});
		});
	}

	it('still refuses an unknown schema, a newer version and an unknown verification key', () => {
		const base = { schema: 'ever-works-build-result', version: 1, digest: `sha256:${DIGEST_HEX}` };
		expect(parseResultArtifact({ ...base, schema: 'something-else' })).toEqual({
			ok: false,
			refusal: 'unsupportedSchema'
		});
		expect(parseResultArtifact({ ...base, version: 2 })).toEqual({ ok: false, refusal: 'unsupportedSchema' });
		expect(parseResultArtifact({ ...base, verification: { jobs: [], extra: true } })).toEqual({
			ok: false,
			refusal: 'unknownKeys'
		});
		expect(parseResultArtifact({ ...base, injected: 'x' })).toEqual({ ok: false, refusal: 'unknownKeys' });
	});
});
