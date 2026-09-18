import { readFileSync, writeFileSync } from 'node:fs';

import {
	APP_BUILD_CHECK_NAME_PREFIX,
	APP_BUILD_CHECKS_MAX,
	APP_BUILD_RESULT_ARTIFACT_FILE,
	APP_BUILD_RESULT_ARTIFACT_NAME,
	APP_BUILD_RESULT_ARTIFACT_RETENTION_DAYS,
	APP_BUILD_RESTRICTED_VALUE_LITERAL,
	APP_BUILD_VERIFY_PLAN_INPUT,
	APP_BUILD_VERIFY_PROMPTED_SECRET,
	APP_BUILD_VERIFY_TIMEOUT_MINUTES,
	BUILD_SERVICE_DEFAULTS,
	BUILD_SERVICE_HOST
} from '@ever-works/contracts';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { ACTION_PINS, actionPin } from '../workflow/action-pins.js';
import {
	canonicalInputsFor,
	generateWorkflow,
	normaliseBuildBlock,
	secretNamesFor,
	yamlString
} from '../workflow/generator.js';
import { computeWorkflowInputsHash } from '../workflow/inputs-hash.js';
import { EMBEDDED_VERIFY_RUNNER_SCRIPT } from '../workflow/verify-runner.sh.js';
import {
	APP_SPEC_HASH,
	bootstrapFixture,
	FORBIDDEN_VALUE_STRINGS,
	goldenFixtures,
	minimalBuild,
	postgresDefaultsFixture,
	PUBLIC_REPOSITORY,
	SECRET_VALUE,
	unrestrictedValuesFixture
} from './fixtures/workflow-fixtures.js';

/**
 * APW-05 T8 — the generated workflow, against ten goldens and against itself.
 *
 * **How the goldens were recorded, and what they prove.** `EW_UPDATE_GOLDEN=1`
 * writes them from these very fixtures (the same module the assertions read), so a
 * golden can never disagree with the inputs it was recorded from — and the
 * *properties* below are asserted independently of the goldens, which is what
 * makes the pair worth having: a golden catches a silent byte change, an assertion
 * catches a wrong byte. Every full-file golden is additionally parsed as YAML,
 * because the file GitHub will run has to be a file GitHub can read: `actionlint`
 * is **not installed on this machine** (checked), so T8's "passes `actionlint`
 * locally" leg is proven by a real YAML parse plus the structural assertions
 * below, and the missing binary is reported as a routed item rather than claimed.
 */
const UPDATE_GOLDEN = process.env.EW_UPDATE_GOLDEN === '1';

/** The checks job's id — R-9's job is T41's, and T8 asserts it is absent. */
const APP_BUILD_CHECKS_JOB = 'checks';

/** Read the golden, or write it when the recorder is running. */
function golden(name: string, actual: string): string {
	const url = new URL(`./golden/${name}.yml`, import.meta.url);
	if (UPDATE_GOLDEN) {
		writeFileSync(url, actual);
		return actual;
	}
	return readFileSync(url, 'utf-8');
}

const fixtures = goldenFixtures();

/** The `jobs.<name>` block of a generated file, verbatim — what the extracted goldens hold. */
function jobSection(file: string, job: string): string {
	const lines = file.split('\n');
	const start = lines.indexOf(`  ${job}:`);
	expect(start, `job ${job} exists`).toBeGreaterThan(-1);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^ {2}[a-z0-9_-]+:$/.test(line));
	return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** The `key: |` block scalar's body, verbatim — dedented to its own content column. */
function blockScalarBody(file: string, key: string, indent: number): string {
	const lines = file.split('\n');
	const marker = `${' '.repeat(indent)}${key}: |`;
	const start = lines.indexOf(marker);
	expect(start, `${key} block exists`).toBeGreaterThan(-1);
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() !== '' && !line.startsWith(' '.repeat(indent + 2))) break;
		body.push(line.slice(indent + 2));
	}
	return body.join('\n');
}

/** The six full files T8 records a golden for. */
const FULL_FILE_GOLDENS: Record<string, () => string> = {
	minimal: () => generateWorkflow(fixtures.minimal),
	args: () => generateWorkflow(fixtures.args),
	services: () => generateWorkflow(fixtures.services),
	'private-larger-runner': () => generateWorkflow(fixtures['private-larger-runner']),
	attestations: () => generateWorkflow(fixtures.attestations),
	'branch-slug': () => generateWorkflow(fixtures['branch-slug'])
};

/** The four added goldens of T8 (`APW05-G02`, `APW05-G08`, XC-01) — two of them fragments. */
const EXTRACTED_GOLDENS: Record<string, () => string> = {
	'verify-bootstrap': () => generateWorkflow(bootstrapFixture()),
	'verify-job': () => jobSection(generateWorkflow(fixtures.services), 'verify'),
	'services-postgres-defaults': () => generateWorkflow(postgresDefaultsFixture()),
	'restricted-values': () => blockScalarBody(generateWorkflow(fixtures.args), 'build-args', 10)
};

const ALL_GOLDENS: Record<string, () => string> = { ...FULL_FILE_GOLDENS, ...EXTRACTED_GOLDENS };

describe('generator — the ten goldens', () => {
	for (const [name, build] of Object.entries(ALL_GOLDENS)) {
		it(`records and reproduces golden/${name}.yml byte for byte`, () => {
			const actual = build();
			expect(actual).toBe(golden(name, actual));
		});
	}

	it('writes LF endings and exactly one trailing newline', () => {
		for (const [name, build] of Object.entries(FULL_FILE_GOLDENS)) {
			const file = build();
			expect(file.includes('\r'), name).toBe(false);
			expect(file.endsWith('\n'), name).toBe(true);
			expect(file.endsWith('\n\n'), name).toBe(false);
		}
	});

	it('opens with the FR-6 header, whose third line carries the inputs fingerprint', () => {
		const file = generateWorkflow(fixtures.minimal);
		const [first, second, third] = file.split('\n');
		expect(first).toBe(
			'# Generated by Ever Works from .works/works.yml. Do not edit: hand edits are never overwritten;'
		);
		expect(second).toBe('# Ever Works proposes changes to this file as pull requests.');
		expect(third).toMatch(/^# ever-works-build generator=1 inputs=sha256:[0-9a-f]{64}$/);
		expect(third).toBe(
			`# ever-works-build generator=1 inputs=${computeWorkflowInputsHash(
				canonicalInputsFor(fixtures.minimal, EMBEDDED_VERIFY_RUNNER_SCRIPT)
			)}`
		);
	});

	it('is valid YAML — the file GitHub will run is a file GitHub can read', () => {
		for (const [name, build] of Object.entries(FULL_FILE_GOLDENS)) {
			const parsed = yaml.load(build()) as Record<string, unknown>;
			expect(parsed, name).toBeTypeOf('object');
			expect(parsed.name, name).toBe('Ever Works build');
			expect(parsed.jobs, name).toBeTypeOf('object');
			expect(parsed.permissions, name).toEqual({});
		}
	});

	it('parses the two extracted goldens as the structures they are', () => {
		const verifyJob = yaml.load(EXTRACTED_GOLDENS['verify-job']()) as Record<string, unknown>;
		expect(Object.keys(verifyJob)).toEqual(['verify']);
		const buildArgs = EXTRACTED_GOLDENS['restricted-values']().split('\n');
		expect(buildArgs.length).toBeGreaterThan(0);
		for (const line of buildArgs) expect(line).toMatch(/^[A-Z_][A-Z0-9_]*=/);
	});
});

describe('generator — byte stability (ACC-05-03)', () => {
	it('produces identical bytes on two runs of every fixture', () => {
		for (const [name, build] of Object.entries(ALL_GOLDENS)) {
			expect(build(), name).toBe(build());
		}
	});

	it('is insensitive to the order the caller hands values in', () => {
		const reordered = { ...fixtures.services, values: [...fixtures.services.values].reverse() };
		expect(canonicalInputsFor(reordered, EMBEDDED_VERIFY_RUNNER_SCRIPT)).toEqual(
			canonicalInputsFor(fixtures.services, EMBEDDED_VERIFY_RUNNER_SCRIPT)
		);
	});

	it('keeps the fingerprint in the header when a secret value rotates', () => {
		// `values` carries names + flags only (plan §4.5): rotating a stored value must
		// not rewrite every App Work's workflow file.
		const rotated = {
			...fixtures.args,
			values: fixtures.args.values.map((value) => ({
				...value,
				value: 'rotated-do-not-print',
				fingerprint: 'v4'
			}))
		};
		expect(generateWorkflow(rotated).split('\n')[2]).toBe(generateWorkflow(fixtures.args).split('\n')[2]);
	});

	it('moves the fingerprint when an attestation, a check command or the verify script changes', () => {
		const baseline = computeWorkflowInputsHash(canonicalInputsFor(fixtures.minimal, EMBEDDED_VERIFY_RUNNER_SCRIPT));
		const withCheck = computeWorkflowInputsHash(
			canonicalInputsFor(
				{
					...fixtures.minimal,
					checks: [{ name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 61 }]
				},
				EMBEDDED_VERIFY_RUNNER_SCRIPT
			)
		);
		expect(withCheck).not.toBe(baseline);
		const otherScript = computeWorkflowInputsHash(
			canonicalInputsFor(fixtures.minimal, 'set -euo pipefail\necho other')
		);
		expect(otherScript).not.toBe(baseline);
		const attested = computeWorkflowInputsHash(
			canonicalInputsFor({ ...fixtures.minimal, settings: { attestations: true } }, EMBEDDED_VERIFY_RUNNER_SCRIPT)
		);
		expect(attested).not.toBe(baseline);
	});
});

describe('generator — no stored value ever appears (ACC-05-05)', () => {
	it('keeps every resolved build value out of every generated file', () => {
		for (const [name, build] of Object.entries(ALL_GOLDENS)) {
			const file = build();
			for (const forbidden of FORBIDDEN_VALUE_STRINGS) {
				expect(file.includes(forbidden), `${name} must not contain a build value`).toBe(false);
			}
		}
	});

	it('names an EW_ build value only as an env key, a secret reference or a name list', () => {
		// The three permitted spellings of a secret NAME: the `env:` key, the
		// `secrets.EW_*` reference, and the bare name in the two name lists
		// (`EW_SECRET_NAMES` and the missing-value loop). Nothing else may name it,
		// and no value may appear at all.
		const file = generateWorkflow(fixtures.args);
		const leftovers = file
			.split('secrets.EW_SENTRY_DSN')
			.join('')
			.split('EW_SENTRY_DSN:')
			.join('')
			.split('"EW_SENTRY_DSN"')
			.join('')
			.split('name in EW_SENTRY_DSN ')
			.join('name in ');
		expect(leftovers).not.toContain('EW_SENTRY_DSN');
		// Non-vacuity: the permitted spellings really are in the file.
		expect(file).toContain('EW_SENTRY_DSN: "${{ secrets.EW_SENTRY_DSN }}"');
		expect(file).toContain('EW_SECRET_NAMES: "EW_SENTRY_DSN"');
		expect(file).toContain('for name in EW_SENTRY_DSN EW_DATABASE_URL; do');
		expect(file).toContain("'ew-restricted' || secrets.EW_SENTRY_DSN }}");
		expect(file).not.toContain(SECRET_VALUE);
	});

	it('excludes build-service-derived values from EW_SECRET_NAMES (plan §4.11)', () => {
		const names = secretNamesFor(fixtures.args.values);
		expect(names).toEqual(['EW_SENTRY_DSN']);
		expect(names).not.toContain('EW_DATABASE_URL');
		expect(generateWorkflow(fixtures.args)).toContain('EW_SECRET_NAMES: "EW_SENTRY_DSN"');
	});

	it('emits an App-spec literal argument verbatim, and only that', () => {
		const body = blockScalarBody(generateWorkflow(fixtures.args), 'build-args', 10);
		expect(body.split('\n')).toEqual([
			'NODE_ENV=production',
			"SENTRY_DSN=${{ github.event_name == 'pull_request' && 'ew-restricted' || secrets.EW_SENTRY_DSN }}",
			"DATABASE_URL=${{ github.event_name == 'pull_request' && 'ew-restricted' || secrets.EW_DATABASE_URL }}"
		]);
	});

	it('checks the image against the secret names only, by name', () => {
		const build = jobSection(generateWorkflow(fixtures.args), 'build');
		expect(build).toContain('      - name: Check the image for secret build values');
		expect(build).toContain('EW_SECRET_IN_IMAGE:${name#EW_}');
		expect(build).toContain('exit 79');
		expect(build).toContain('grep -qF -- "$value"');
	});

	it('pins every third-party action to a 40-character commit (ACC-05-05)', () => {
		const file = generateWorkflow(fixtures.minimal);
		const uses = [...file.matchAll(/uses:\s+(\S+)/g)].map((match) => match[1]);
		expect(uses.length).toBeGreaterThan(0);
		for (const reference of uses) expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
		expect(file).toContain(`uses: ${actionPin(ACTION_PINS.checkout)}`);
		expect(file).toContain(`uses: ${actionPin(ACTION_PINS.buildPush)}`);
	});
});

describe('generator — the pull-request guard (ACC-05-06, APW05-G02)', () => {
	const file = generateWorkflow(fixtures.args);

	it('refuses a pull request whose head repository differs, and excludes verify mode', () => {
		const jobIf = file.split('\n').find((line) => line.startsWith('    if: (github.event_name != '));
		expect(jobIf).toBe(
			"    if: (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && inputs.ew_mode != 'verify'"
		);
	});

	it('puts every `secrets.` reference and every push inside the build job', () => {
		const build = jobSection(file, 'build');
		const verify = jobSection(file, 'verify');
		const elsewhere = file
			.split('\n')
			.filter((line) => line.trim() !== '' && !build.includes(line) && !verify.includes(line))
			.join('\n');
		expect(elsewhere).not.toContain('secrets.');
		expect(verify).not.toContain('docker push');
		expect(verify).not.toContain('--push');
		expect(verify).not.toContain('cache-to');
		expect(verify).toContain('permissions: { contents: read, packages: read }');
		expect(verify).not.toContain('packages: write');
		expect(build).toContain('docker push --all-tags "$EW_IMAGE"');
	});

	it('runs nothing at all for a pull request from another repository', () => {
		expect(jobSection(file, 'verify')).toContain(
			"    if: github.event_name == 'workflow_dispatch' && inputs.ew_mode == 'verify'"
		);
		expect(file).not.toContain('pull_request_target');
	});

	it('names the restricted marker for a pull request and the push path beside it (XC-01)', () => {
		const restricted = blockScalarBody(file, 'build-args', 10);
		const ternaries = restricted.split('\n').filter((line) => line.includes("github.event_name == 'pull_request'"));
		expect(ternaries.length).toBe(2);
		for (const line of ternaries) {
			const [condition, otherwise] = line.split(' || ');
			expect(condition).toContain(`'${APP_BUILD_RESTRICTED_VALUE_LITERAL}'`);
			expect(condition).not.toContain('secrets.');
			expect(otherwise).toMatch(/^secrets\.EW_[A-Z0-9_]+ \}\}$/);
		}
	});

	it('emits the previous, unrestricted form when the owner opts out (XC-01)', () => {
		const unrestricted = blockScalarBody(generateWorkflow(unrestrictedValuesFixture()), 'build-args', 10);
		expect(unrestricted).toContain('SENTRY_DSN=${{ secrets.EW_SENTRY_DSN }}');
		expect(unrestricted).not.toContain(APP_BUILD_RESTRICTED_VALUE_LITERAL);
	});

	it('runs the missing-value check only outside a pull request', () => {
		const checkStep = jobSection(file, 'build').split('      - name: Check build values')[1];
		expect(checkStep).toContain("        if: github.event_name != 'pull_request'");
		expect(checkStep).toContain('EW_MISSING:${name#EW_}');
		expect(checkStep).toContain('exit 78');
	});
});

describe('generator — tags, cache and digests (ACC-05-07, FR-21, FR-26)', () => {
	const file = generateWorkflow(fixtures['branch-slug']);

	it('tags sha-<sha> plus branch-<slug> for a push and pr-<n> for a pull request, and never latest', () => {
		const tags = blockScalarBody(file, 'tags', 10);
		expect(tags.split('\n')).toEqual([
			'${{ env.EW_IMAGE }}:sha-${{ env.EW_SHA }}',
			"${{ env.EW_IMAGE }}:${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'branch-feature-x' }}"
		]);
		// `ubuntu-latest` is the runner, not a tag: the tag list is what must be free
		// of a moving tag (ACC-05-07).
		expect(tags).not.toContain('latest');
		const parsed = yaml.load(file) as { jobs: { build: { steps: Array<{ with?: { tags?: string } }> } } };
		const parsedTags = parsed.jobs.build.steps.map((step) => step.with?.tags).filter(Boolean) as string[];
		// A block scalar keeps its final newline; the two tag lines are what matter.
		expect(parsedTags.map((tag) => tag.trimEnd())).toEqual([
			"${{ env.EW_IMAGE }}:sha-${{ env.EW_SHA }}\n${{ env.EW_IMAGE }}:${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'branch-feature-x' }}"
		]);
		expect(parsedTags.join('\n')).not.toContain('latest');
	});

	it('writes the cache only on a push event', () => {
		const cacheTo = file.split('\n').find((line) => line.trim().startsWith('cache-to:'));
		expect(cacheTo).toBe(
			"          cache-to: ${{ github.event_name == 'push' && format('type=registry,ref={0}:buildcache,mode=max', env.EW_IMAGE) || '' }}"
		);
		expect(file).toContain('cache-from: type=registry,ref=${{ env.EW_IMAGE }}:buildcache');
	});

	it('loads without pushing, so the secret check runs before any byte leaves the runner (FR-21)', () => {
		// The `args` fixture is the one with a stored value, so it is the one with a
		// secret-check step at all.
		const build = jobSection(generateWorkflow(fixtures.args), 'build');
		const loadAt = build.indexOf('load: true');
		const pushFalseAt = build.indexOf('push: false');
		const secretCheckAt = build.indexOf('Check the image for secret build values');
		const pushStepAt = build.indexOf('      - name: Push');
		expect(loadAt).toBeGreaterThan(-1);
		expect(pushFalseAt).toBeGreaterThan(loadAt);
		expect(secretCheckAt).toBeGreaterThan(pushFalseAt);
		expect(pushStepAt).toBeGreaterThan(secretCheckAt);
	});

	it('reads a step outcome only where that step exists (what actionlint caught)', () => {
		// The secret-check step is emitted only when the App Work has secret build
		// values, and `steps.<id>.outcome` may only be referenced when it does —
		// actionlint refuses the file otherwise (`property "secretcheck" is not defined
		// in object type …`), and a customer's run would too.
		const withoutValues = generateWorkflow(fixtures.minimal);
		expect(withoutValues).not.toContain('steps.');
		expect(withoutValues).not.toContain('id: secretcheck');
		expect(withoutValues).toContain('secret_check="not_needed"');

		const withValues = generateWorkflow(fixtures.args);
		expect(withValues).toContain('        id: secretcheck');
		expect(withValues).toContain('[ "${{ steps.secretcheck.outcome }}" != "failure" ] || secret_check="failed"');
	});

	it('captures the pushed digest from the image, as the receipt reads it', () => {
		expect(file).toContain(
			`docker image inspect --format '{{index .RepoDigests 0}}' "$EW_IMAGE:sha-$EW_SHA" > ew-digest.txt`
		);
	});

	it('uploads the result artifact with the plan §3.2 name and retention', () => {
		expect(file).toContain(`          name: "${APP_BUILD_RESULT_ARTIFACT_NAME}"`);
		expect(file).toContain(`          path: "${APP_BUILD_RESULT_ARTIFACT_FILE}"`);
		expect(file).toContain(`          retention-days: ${APP_BUILD_RESULT_ARTIFACT_RETENTION_DAYS}`);
		expect(file).toContain('          if-no-files-found: ignore');
	});
});

describe('generator — concurrency (APW05-G02)', () => {
	const file = generateWorkflow(fixtures.minimal);

	it('cancels in progress only for a pull request', () => {
		expect(file).toContain("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
	});

	it('gives a verification its own group, and the tracked branch its own by ref', () => {
		const group = file.split('\n').find((line) => line.startsWith('  group: '));
		expect(group).toContain("inputs.ew_mode == 'verify' && format('verify-{0}', inputs.ew_build_id)");
		expect(group).toContain("format('ever-works-build-{0}'");
		expect(group).toContain("format('pr-{0}', github.event.pull_request.number) || github.ref_name");
		// The verification group is a different string, so it can never share the
		// tracked-branch group and replace (or be replaced by) the push Build.
		expect(group).toContain("|| format('ever-works-build-{0}', github.event_name");
	});

	it('lets the dispatch input carry the verification plan and the reuse digest', () => {
		expect(file).toContain(`      ${APP_BUILD_VERIFY_PLAN_INPUT}:`);
		expect(file).toContain('      ew_reuse_digest:');
		expect(file).toContain(`      EW_REUSE_DIGEST: "\${{ inputs.ew_reuse_digest }}"`);
	});
});

describe('generator — build services (ACC-05-12, APW05-G08)', () => {
	const file = generateWorkflow(fixtures.services);
	const postgresDefaults = BUILD_SERVICE_DEFAULTS.postgres;

	it('declares the postgres service with the BUILD_SERVICE_DEFAULTS env, port and health', () => {
		const services = jobSection(file, 'build');
		expect(services).toContain('      postgres:');
		expect(services).toContain('        image: "postgres:16"');
		expect(services).toContain('          POSTGRES_USER: "ever-works-build"');
		expect(services).toContain('          POSTGRES_PASSWORD: "ever-works-build"');
		expect(services).toContain('        ports: ["5432:5432"]');
		expect(postgresDefaults.containerPort).toBe(5432);
		// The health command names the database the service actually starts with —
		// which is the fixture's declared one here, and `app` in the defaults case.
		expect(services).toContain('pg_isready -U ever-works-build -d fixture');
	});

	it('lets a declared env entry win per variable while every other default still applies', () => {
		const services = jobSection(file, 'build');
		expect(services).toContain('          POSTGRES_DB: "fixture"');
		expect(services).toContain('          POSTGRES_USER: "ever-works-build"');
		// The YAML is double-quoted and escaped (`yamlString`), so the option the
		// runner receives is read back through a real parser, not by eye.
		const parsed = yaml.load(file) as {
			jobs: { build: { services: Record<string, { env: Record<string, string>; options: string }> } };
		};
		expect(parsed.jobs.build.services.postgres.env).toEqual({
			POSTGRES_DB: 'fixture',
			POSTGRES_PASSWORD: 'ever-works-build',
			POSTGRES_USER: 'ever-works-build'
		});
		expect(parsed.jobs.build.services.postgres.options).toBe(
			'--health-cmd "pg_isready -U ever-works-build -d fixture" --health-interval 10s --health-timeout 5s --health-retries 5'
		);
	});

	it('declares the redis service with its own health command', () => {
		const services = jobSection(file, 'build');
		expect(services).toContain('      redis:');
		expect(services).toContain('        image: "redis:7"');
		expect(services).toContain('        ports: ["6379:6379"]');
		expect(services).toContain('redis-cli ping');
		const parsed = yaml.load(file) as { jobs: { build: { services: Record<string, { options: string }> } } };
		expect(parsed.jobs.build.services.redis.options).toBe(
			'--health-cmd "redis-cli ping" --health-interval 10s --health-timeout 5s --health-retries 5'
		);
	});

	it('reaches the services on the loopback the build shares with them (ACC-05-12)', () => {
		expect(BUILD_SERVICE_HOST).toBe('127.0.0.1');
		const services = jobSection(file, 'build');
		expect(services).toContain('          network: host');
		expect(services).toContain('          allow: network.host');
		expect(services).toContain('--allow-insecure-entitlement network.host');
		expect(blockScalarBody(file, 'build-args', 10)).toContain('PGHOST=127.0.0.1');
		expect(blockScalarBody(file, 'build-args', 10)).toContain('secrets.EW_DATABASE_URL');
	});

	it('adds the health options only for a recognised image, and waits on the port otherwise', () => {
		const unknown = generateWorkflow({
			...fixtures.minimal,
			build: minimalBuild({ services: [{ name: 'smtp', image: 'mailhog/mailhog:v1.0.1', port: 8025, env: [] }] })
		});
		const services = jobSection(unknown, 'build');
		expect(services).toContain('        ports: ["8025:8025"]');
		expect(services).not.toContain('--health-cmd');
		expect(unknown).toContain('      - name: Wait for the build services');
		expect(unknown).toContain('EW_SERVICE_TIMEOUT:$port');
		expect(unknown).not.toContain('sleep');
	});

	it('publishes no port at all when an unrecognised image declares none (§4.5, APW05-G08)', () => {
		const undeclared = generateWorkflow({
			...fixtures.minimal,
			build: minimalBuild({ services: [{ name: 'custom', image: 'acme/custom:1', env: [] }] })
		});
		expect(jobSection(undeclared, 'build')).toContain('        ports: []');
	});

	it('gives an undeclared env the three defaults and the published container port', () => {
		const withDefaults = generateWorkflow(postgresDefaultsFixture());
		const services = jobSection(withDefaults, 'build');
		expect(services).toContain('          POSTGRES_USER: "ever-works-build"');
		expect(services).toContain('          POSTGRES_PASSWORD: "ever-works-build"');
		expect(services).toContain('          POSTGRES_DB: "app"');
		expect(services).toContain('        ports: ["5432:5432"]');
	});
});

describe('generator — timeouts (APW05-G22, FR-24, FR-53)', () => {
	it('keeps the build job at build.resources.timeoutMinutes and adds 30 only to the verify job', () => {
		const file = generateWorkflow(fixtures.minimal);
		const build = jobSection(file, 'build');
		const verify = jobSection(file, 'verify');
		expect(build).toContain(`    timeout-minutes: ${fixtures.minimal.build?.resources.timeoutMinutes}`);
		expect(build).not.toContain('    timeout-minutes: 60');
		expect(verify).toContain(
			`    timeout-minutes: ${(fixtures.minimal.build?.resources.timeoutMinutes ?? 0) + APP_BUILD_VERIFY_TIMEOUT_MINUTES}`
		);
		expect(verify).toContain(`        timeout-minutes: ${APP_BUILD_VERIFY_TIMEOUT_MINUTES}`);
	});

	it('honours a non-default build timeout exactly', () => {
		const custom = generateWorkflow({
			...fixtures.minimal,
			build: minimalBuild({ resources: { cpu: 4, memoryGiB: 12, timeoutMinutes: 45 } })
		});
		expect(jobSection(custom, 'build')).toContain('    timeout-minutes: 45');
		expect(jobSection(custom, 'verify')).toContain(`    timeout-minutes: ${45 + APP_BUILD_VERIFY_TIMEOUT_MINUTES}`);
	});
});

describe('generator — the bootstrap file of plan §4.6 step 0 (APW05-G02)', () => {
	const file = generateWorkflow(bootstrapFixture());

	it('is dispatch-only, with no push or pull_request trigger', () => {
		expect(file).toContain('  workflow_dispatch:');
		expect(file).not.toContain('\n  push:\n');
		expect(file).not.toContain('\n  pull_request:\n');
	});

	it('carries no build job and no checks job — only the verify job', () => {
		expect(file).not.toContain('\n  build:\n');
		expect(file).not.toContain(`\n  ${APP_BUILD_CHECKS_JOB}:\n`);
		expect(file).toContain('\n  verify:\n');
		const jobs = (yaml.load(file) as { jobs: Record<string, unknown> }).jobs;
		expect(Object.keys(jobs)).toEqual(['verify']);
	});

	it('references no EW_ secret other than the one the verification is allowed', () => {
		// Plan §4.6 step 0: "no reference to any `EW_<NAME>` secret other than
		// `EW_VERIFY__PROMPTED`". Today that is vacuous — the embedded verification
		// script is T15's interlock shell and names no secret — so the assertion is
		// the invariant ("every EW_ reference there is, is that one") rather than
		// "there is none", which T15's real script would falsify.
		const ewReferences = [...file.matchAll(/secrets\.(EW_[A-Z0-9_]*)/g)].map((match) => match[1]);
		expect(ewReferences.filter((name) => name !== APP_BUILD_VERIFY_PROMPTED_SECRET)).toEqual([]);
		expect(file).not.toContain('secrets.EW_SENTRY_DSN');
	});

	it('keeps permissions empty at the top and read-only on the verify job', () => {
		expect(file).toContain('permissions: {}');
		expect(jobSection(file, 'verify')).toContain('    permissions: { contents: read, packages: read }');
	});

	it('still pins its actions and keeps the verification window', () => {
		expect(file).toContain(`uses: ${actionPin(ACTION_PINS.checkout)}`);
		expect(jobSection(file, 'verify')).toContain(`    timeout-minutes: ${APP_BUILD_VERIFY_TIMEOUT_MINUTES}`);
	});
});

describe('generator — the verify job and its result', () => {
	const verify = jobSection(generateWorkflow(fixtures.minimal), 'verify');

	it('can neither publish an image nor write the cache (FR-54)', () => {
		expect(verify).not.toContain('docker push');
		expect(verify).not.toContain('--push');
		expect(verify).not.toContain('cache-to');
		expect(verify).toContain('--cache-from "$EW_IMAGE:buildcache"');
		expect(verify).toContain('docker pull "$EW_IMAGE@$EW_REUSE_DIGEST"');
	});

	it('reports reusedDigest | localBuild and claims no digest and no tags', () => {
		expect(verify).toContain('reusedDigest:$reusedDigest,localBuild:$localBuild');
		expect(verify).not.toContain('tags:');
	});

	it('runs the embedded verification script behind the plan guard', () => {
		expect(verify).toContain(`        if: inputs.${APP_BUILD_VERIFY_PLAN_INPUT} != ''`);
		expect(verify).toContain(EMBEDDED_VERIFY_RUNNER_SCRIPT.split('\n')[0]);
	});
});

describe('generator — attestations are the effective value (plan §4.5, APW05-G07)', () => {
	it('grants the two attestation permissions on a public repository', () => {
		expect(jobSection(generateWorkflow(fixtures.attestations), 'build')).toContain(
			'    permissions: { contents: read, packages: write, attestations: write, id-token: write }'
		);
	});

	it('never grants them on a private repository, whatever the setting says', () => {
		const privateAttested = generateWorkflow({
			...fixtures['private-larger-runner'],
			settings: { attestations: true }
		});
		expect(jobSection(privateAttested, 'build')).toContain('    permissions: { contents: read, packages: write }');
		expect(privateAttested).not.toContain('attestations: write');
		expect(privateAttested).not.toContain('id-token: write');
	});
});

describe('generator — the small pure helpers', () => {
	it('always double-quotes and escapes a YAML string', () => {
		expect(yamlString('plain')).toBe('"plain"');
		expect(yamlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
		expect(yamlString('line\nbreak\ttab')).toBe('"line\\nbreak\\ttab"');
		expect(yamlString('bell\u0007')).toBe('"bell\\u0007"');
	});

	it('normalises the build block: defaults applied, nothing invented', () => {
		const normalised = normaliseBuildBlock(minimalBuild());
		expect(normalised.context).toBe('.');
		expect(normalised.dockerfile).toBe('Dockerfile');
		expect(normalised).not.toHaveProperty('target');
		const explicit = normaliseBuildBlock(
			minimalBuild({ context: ' app ', dockerfile: 'docker/Dockerfile', target: 'runtime' })
		);
		expect(explicit.context).toBe('app');
		expect(explicit.dockerfile).toBe('docker/Dockerfile');
		expect(explicit.target).toBe('runtime');
	});

	it('writes the App spec hash into the image labels', () => {
		const file = generateWorkflow(fixtures.minimal);
		expect(file).toContain(`io.ever-works.app-spec-hash=${APP_SPEC_HASH}`);
		expect(file).toContain('org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}');
	});

	it('names the image after the repository, lower-cased', () => {
		const file = generateWorkflow({
			...fixtures.minimal,
			repository: { ...PUBLIC_REPOSITORY, owner: 'Ever-Works' }
		});
		expect(file).toContain('EW_IMAGE: "ghcr.io/ever-works/fixture-app/ever-works-app"');
	});

	it('caps the checks it fingerprints at the contract maximum', () => {
		const checks = Array.from({ length: APP_BUILD_CHECKS_MAX + 5 }, (_, index) => ({
			name: `check-${index}`,
			command: `echo ${index}`,
			required: false,
			timeoutSeconds: 60
		}));
		const canonical = canonicalInputsFor({ ...fixtures.minimal, checks }, EMBEDDED_VERIFY_RUNNER_SCRIPT);
		expect(canonical.checks).toHaveLength(APP_BUILD_CHECKS_MAX);
		expect(canonical.checks[0]).toEqual({
			name: 'check-0',
			required: false,
			timeoutMinutes: 1,
			commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
	});

	it('leaves the checks job to T41 and fingerprints the checks meanwhile', () => {
		const withCheck = generateWorkflow({
			...fixtures.minimal,
			checks: [{ name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 60 }]
		});
		expect(withCheck).not.toContain(APP_BUILD_CHECK_NAME_PREFIX);
		expect(withCheck).not.toContain(`\n  ${APP_BUILD_CHECKS_JOB}:\n`);
	});
});
