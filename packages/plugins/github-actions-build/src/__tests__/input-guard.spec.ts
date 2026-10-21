import type { BuildAuth, PrepareRepositoryInput, RepositoryWriter } from '@ever-works/plugin';
import * as yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin } from '../github-actions-build.plugin.js';
import type { RepositorySecretPort } from '../repo/secret-sync.js';
import { generateWorkflow, type WorkflowGeneratorInput } from '../workflow/generator.js';
import {
	findUnsafeWorkflowInput,
	isSafeWorkflowText,
	unsafeWorkflowTextCause,
	WorkflowInputRefusedError
} from '../workflow/input-guard.js';
import {
	bootstrapFixture,
	goldenFixtures,
	minimalBuild,
	postgresDefaultsFixture,
	unrestrictedValuesFixture
} from './fixtures/workflow-fixtures.js';

/**
 * Prompt-injection hardening — the generator refuses every App-spec string that
 * could become YAML or a GitHub expression in the committed build workflow.
 *
 * The attack this file pins: an App spec is not trusted text (an adopted fork's
 * `.works/works.yml` is the upstream author's; any agent can edit `build`), and
 * the workflow is committed to the App repository and run with its secrets. A
 * build argument is one line of a `|` block scalar, so a newline in its value
 * ends the line and the rest is parsed as workflow YAML; and GitHub evaluates
 * `${{ … }}` inside every value, quoted or not, so `${{ secrets.ANY }}` in a
 * build argument or a service env value hands any repository or organisation
 * secret to the author's Dockerfile or service image.
 *
 * The goldens (`generator.spec.ts`) prove the honest files did not change by a
 * byte; this file proves the hostile ones are never produced at all.
 */

/** A minimal, valid input to mutate one field of. */
function base(overrides: Partial<WorkflowGeneratorInput> = {}): WorkflowGeneratorInput {
	return { ...goldenFixtures().minimal, ...overrides };
}

/** Generate, and return the refusal it threw — failing the test when it generated a file instead. */
function refusalOf(input: WorkflowGeneratorInput): WorkflowInputRefusedError {
	try {
		const file = generateWorkflow(input);
		throw new Error(`expected a refusal, got a ${file.length}-byte workflow`);
	} catch (error) {
		expect(error).toBeInstanceOf(WorkflowInputRefusedError);
		return error as WorkflowInputRefusedError;
	}
}

/** The newline payload: end the build-args block and add a job with every permission. */
const BREAKOUT =
	'production\n  pwn:\n    runs-on: ubuntu-latest\n    permissions: write-all\n    steps:\n      - run: curl evil';

describe('unsafeWorkflowTextCause — the three classes', () => {
	it.each([
		['${{ secrets.ORG_DEPLOY_KEY }}', 'expression'],
		['prefix-${{github.token}}', 'expression'],
		['${HOME}', 'expression'],
		['a\nb', 'lineBreak'],
		['a\rb', 'lineBreak'],
		// YamlDotNet (the Actions runner's parser) breaks lines on these three too.
		['a\u0085b', 'lineBreak'],
		['a\u2028b', 'lineBreak'],
		['a\u2029b', 'lineBreak'],
		['a\tb', 'controlCharacter'],
		['a\u0000b', 'controlCharacter'],
		['a\u001bb', 'controlCharacter'],
		['a\u007fb', 'controlCharacter'],
		['a\u009bb', 'controlCharacter'],
		['\ufeffa', 'controlCharacter']
	])('%j → %s', (value, cause) => {
		expect(unsafeWorkflowTextCause(value)).toBe(cause);
	});

	it.each([
		'production',
		'$HOME is a literal here',
		'price: $5 # not a comment inside a value',
		`quotes "double" and 'single'`,
		'{{ env.FOO }} is the App spec grammar, not a GitHub expression',
		'unicode é ü 漢字 ✓'
	])('lets an honest value through: %j', (value) => {
		expect(isSafeWorkflowText(value)).toBe(true);
	});

	it('refuses a value that is not a string at all', () => {
		expect(unsafeWorkflowTextCause(42)).toBe('pattern');
		expect(unsafeWorkflowTextCause(undefined)).toBe('pattern');
	});
});

describe('generateWorkflow refuses every hostile interpolation site', () => {
	const cases: Array<[string, WorkflowGeneratorInput, string, string]> = [
		[
			'a build argument value that breaks out of the build-args block',
			base({ build: minimalBuild({ args: [{ name: 'NODE_ENV', value: BREAKOUT }] }) }),
			'build.args[0].value',
			'lineBreak'
		],
		[
			'a build argument value that reads an organisation secret',
			base({ build: minimalBuild({ args: [{ name: 'TOKEN', value: '${{ secrets.ORG_DEPLOY_KEY }}' }] }) }),
			'build.args[0].value',
			'expression'
		],
		[
			'a build argument name that is not an EnvName',
			base({ build: minimalBuild({ args: [{ name: 'X: y', value: 'z' }] }) }),
			'build.args[0].name',
			'pattern'
		],
		[
			'a fromEnv that closes the secrets expression and opens another',
			base({ build: minimalBuild({ args: [{ name: 'A', fromEnv: 'A }} ${{ secrets.OTHER' }] }) }),
			'build.args[0].fromEnv',
			'expression'
		],
		[
			'a service env NAME that injects a YAML key',
			base({
				build: minimalBuild({
					services: [
						{
							name: 'cache',
							image: 'redis:7',
							env: [{ name: 'A: b\n        options: --privileged', value: 'x' }]
						}
					]
				})
			}),
			'build.services[0].env[0].name',
			'lineBreak'
		],
		[
			'a service env name with YAML syntax but no newline',
			base({
				build: minimalBuild({
					services: [{ name: 'cache', image: 'redis:7', env: [{ name: 'A: {x', value: 'x' }] }]
				})
			}),
			'build.services[0].env[0].name',
			'pattern'
		],
		[
			'a service env value that hands a secret to the service image',
			base({
				build: minimalBuild({
					services: [
						{
							name: 'db',
							image: 'evil/img:1',
							port: 1,
							env: [{ name: 'LEAK', value: '${{ secrets.ORG_DEPLOY_KEY }}' }]
						}
					]
				})
			}),
			'build.services[0].env[0].value',
			'expression'
		],
		[
			'a postgres user that adds docker options through the health command',
			base({
				build: minimalBuild({
					services: [
						{
							name: 'postgres',
							image: 'postgres:16',
							env: [{ name: 'POSTGRES_USER', value: 'x" --privileged -v /:/host "y' }]
						}
					]
				})
			}),
			'build.services[0].env[0].value',
			'pattern'
		],
		[
			'a service name that is not a Name',
			base({ build: minimalBuild({ services: [{ name: 'Db: x', image: 'redis:7' }] }) }),
			'build.services[0].name',
			'pattern'
		],
		[
			'a service image carrying an expression',
			base({ build: minimalBuild({ services: [{ name: 'db', image: 'redis:${{ secrets.X }}' }] }) }),
			'build.services[0].image',
			'expression'
		],
		[
			'a build context carrying an expression',
			base({ build: minimalBuild({ context: '${{ secrets.X }}' }) }),
			'build.context',
			'expression'
		],
		[
			'a Dockerfile path carrying a newline',
			base({ build: minimalBuild({ dockerfile: 'Dockerfile\n          push: true' }) }),
			'build.dockerfile',
			'lineBreak'
		],
		[
			'a target carrying an expression',
			base({ build: minimalBuild({ target: '${{ github.token }}' }) }),
			'build.target',
			'expression'
		],
		[
			'a build timeout that is not a number',
			base({
				build: minimalBuild({
					resources: { cpu: 2, timeoutMinutes: '30\n    permissions: write-all' as never }
				})
			}),
			'build.resources.timeoutMinutes',
			'pattern'
		],
		[
			'a tracked branch carrying an expression',
			base({ trackedBranch: '${{github.token}}' }),
			'trackedBranch',
			'expression'
		],
		[
			'a runner label carrying an expression',
			base({ runner: { label: '${{ secrets.X }}', class: 'github-public' } }),
			'runner.label',
			'expression'
		],
		[
			'a build value name that would become a YAML key / secret reference',
			base({
				values: [
					{ name: 'A }} ${{ secrets.B', value: 'v', secret: true, fromBuildService: false, fingerprint: 'v1' }
				]
			}),
			'values[0].name',
			'expression'
		],
		[
			'an App spec hash carrying a newline (written raw into the labels block)',
			base({ appSpecHash: 'abc\n          push: true' }),
			'appSpecHash',
			'lineBreak'
		],
		[
			'a repository owner that is not a GitHub owner',
			base({ repository: { owner: 'a b', repo: 'r', visibility: 'public' } }),
			'repository.owner',
			'pattern'
		],
		[
			'a check name carrying an expression',
			base({ checks: [{ name: '${{ github.token }}', command: 'true', required: true, timeoutSeconds: 60 }] }),
			'checks[0].name',
			'expression'
		],
		[
			'a check `required` that is a string (written raw into the matrix row)',
			base({
				checks: [{ name: 'lint', command: 'true', required: 'true }, { x: y' as never, timeoutSeconds: 60 }]
			}),
			'checks[0].required',
			'pattern'
		]
	];

	it.each(cases)('%s', (_label, input, field, cause) => {
		const error = refusalOf(input);
		expect(error.refusal).toEqual({ field, cause });
		expect(error.reason).toBe('specInvalid');
	});

	it('never puts the refused value in the error message', () => {
		const error = refusalOf(
			base({ build: minimalBuild({ args: [{ name: 'TOKEN', value: '${{ secrets.ORG_DEPLOY_KEY }}' }] }) })
		);
		expect(error.message).not.toContain('ORG_DEPLOY_KEY');
		expect(error.message).toContain('build.args[0].value');
	});

	it('refuses a hostile checks-only file too (an `image` Work)', () => {
		const error = refusalOf(
			base({
				build: minimalBuild({ strategy: 'image' }),
				checks: [{ name: 'a\nb', command: 'true', required: true, timeoutSeconds: 60 }]
			})
		);
		expect(error.refusal.field).toBe('checks[0].name');
	});
});

describe('the honest inputs are untouched (the goldens hold them byte for byte)', () => {
	it('passes every golden fixture, the bootstrap file and the two extra fixtures', () => {
		const all = [
			...Object.values(goldenFixtures()),
			bootstrapFixture(),
			postgresDefaultsFixture(),
			unrestrictedValuesFixture()
		];
		for (const input of all) expect(findUnsafeWorkflowInput(input)).toBeNull();
	});

	it('still writes an honest literal with YAML-looking characters verbatim, as one argument', () => {
		const value = `a: b # c "d" 'e' $HOME {x}`;
		const file = generateWorkflow(base({ build: minimalBuild({ args: [{ name: 'NOTE', value }] }) }));
		const parsed = yaml.load(file) as {
			jobs: { build: { steps: Array<{ id?: string; with?: Record<string, unknown> }> } };
		};
		const buildStep = parsed.jobs.build.steps.find((step) => step.id === 'build');
		expect(buildStep?.with?.['build-args']).toBe(`NOTE=${value}\n`);
		expect(Object.keys(parsed.jobs)).toEqual(['build', 'verify']);
	});

	it('still accepts a dotted service env name (Elasticsearch-style) as a plain key', () => {
		const file = generateWorkflow(
			base({
				build: minimalBuild({
					services: [
						{
							name: 'search',
							image: 'elasticsearch:8',
							port: 9200,
							env: [{ name: 'discovery.type', value: 'single-node' }]
						}
					]
				})
			})
		);
		const parsed = yaml.load(file) as {
			jobs: { build: { services: Record<string, { env: Record<string, string> }> } };
		};
		expect(parsed.jobs.build.services.search.env).toEqual({ 'discovery.type': 'single-node' });
	});
});

// ── prepareRepository: a refused spec blocks before anything is written ──────

const AUTH: BuildAuth = { token: 'ghs-not-a-real-token' };

function prepareInput(build: unknown): PrepareRepositoryInput {
	return {
		workId: '11111111-1111-4111-8111-111111111111',
		repository: {
			owner: 'acme',
			repo: 'their-app',
			visibility: 'public',
			trackedBranch: 'main',
			createdByAppWork: true
		},
		build: build as never,
		appSpecHash: `sha256:${'a'.repeat(64)}`,
		values: [],
		previouslyWrittenSecretNames: [],
		lastWrittenWorkflowSha256: null,
		settings: {},
		checks: []
	};
}

class TestPlugin extends GitHubActionsBuildPlugin {
	constructor(private readonly port: RepositorySecretPort) {
		super();
	}
	protected secretPort(): RepositorySecretPort {
		return this.port;
	}
}

describe('prepareRepository — a hostile App spec is `specInvalid`, and nothing reaches the repository', () => {
	it('blocks with the field and the cause, commits nothing and writes no secret', async () => {
		const port = {
			getRepoPublicKey: vi.fn(async () => ({ key_id: '1', key: Buffer.alloc(32, 7).toString('base64') })),
			putRepoSecret: vi.fn(async () => undefined),
			deleteRepoSecret: vi.fn(async () => undefined)
		} satisfies RepositorySecretPort;
		const writer = {
			getFileContent: vi.fn(async () => null),
			commitFiles: vi.fn(async () => ({ commitSha: 'c'.repeat(40) })),
			createBranch: vi.fn(),
			createPullRequest: vi.fn()
		} as unknown as RepositoryWriter & {
			commitFiles: ReturnType<typeof vi.fn>;
			getFileContent: ReturnType<typeof vi.fn>;
		};

		const result = await new TestPlugin(port).prepareRepository(
			prepareInput({
				strategy: 'dockerfile',
				args: [{ name: 'NODE_ENV', value: BREAKOUT }],
				services: [],
				resources: { cpu: 2, timeoutMinutes: 30 }
			}),
			AUTH,
			writer
		);

		expect(result.blocked).toEqual({
			reason: 'specInvalid',
			detail: { field: 'build.args[0].value', cause: 'lineBreak' }
		});
		expect(result.workflow).toEqual({ state: 'unchanged', contentSha256: '' });
		expect(writer.commitFiles).not.toHaveBeenCalled();
		expect(writer.getFileContent).not.toHaveBeenCalled();
		expect(port.putRepoSecret).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain('write-all');
	});

	it('reports the hash already on record, so the next prepare does not read our own file as hand-edited', async () => {
		// The runner stores `contentSha256` of an `unchanged` result as the platform's
		// last write. An empty hash there makes the platform's own workflow look edited
		// by hand once the spec is fixed, and the update goes out as a pull request.
		const onRecord = 'd'.repeat(64);
		const result = await new TestPlugin({
			getRepoPublicKey: vi.fn(),
			putRepoSecret: vi.fn(),
			deleteRepoSecret: vi.fn()
		} as unknown as RepositorySecretPort).prepareRepository(
			{
				...prepareInput({
					strategy: 'dockerfile',
					args: [{ name: 'NODE_ENV', value: BREAKOUT }],
					services: [],
					resources: { cpu: 2, timeoutMinutes: 30 }
				}),
				lastWrittenWorkflowSha256: onRecord
			},
			AUTH,
			{ getFileContent: vi.fn(), commitFiles: vi.fn() } as unknown as RepositoryWriter
		);

		expect(result.blocked?.reason).toBe('specInvalid');
		expect(result.workflow).toEqual({ state: 'unchanged', contentSha256: onRecord });
	});
});
