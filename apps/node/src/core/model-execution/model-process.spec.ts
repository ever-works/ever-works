import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	MODEL_EXECUTION_EXCERPT_BYTES,
	MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
	ModelExecutionRequestError,
	executeModelProcess,
	type ModelExecutionIo,
	type ModelExecutionProvider,
	type ModelExecutionRequest
} from './model-process';

const FAKE_CLAUDE_CREDENTIAL = 'claude-oauth-test-value-123456789';
const FAKE_CODEX_CREDENTIAL = 'codex-access-test-value-123456789';

const STUB_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [capturePath, mode, markerPath, ...providerArgs] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const selectedEnv = {};
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'CI', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN',
    'CODEX_API_KEY', 'OPENAI_API_KEY', 'DATABASE_PASSWORD', 'GH_TOKEN', 'NODE_OPTIONS'
  ]) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) selectedEnv[key] = process.env[key];
  }
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: providerArgs,
    cwd: process.cwd(),
    input,
    env: selectedEnv
  }));

  const isCodex = providerArgs[0] === 'exec';
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY ||
    process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY || '';

  if (mode === 'success') {
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    }
    return;
  }

  if (mode === 'long-success') {
    const text = 'y'.repeat(${512 * 1024});
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
    }
    return;
  }

  if (mode === 'model-error') {
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'model tool failed' } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model tool failed' }));
    }
    return;
  }

  if (mode === 'nonzero') {
    process.stderr.write('CLI process failed');
    process.exitCode = 7;
    return;
  }

  if (mode === 'malformed') {
    process.stdout.write('this is not machine-readable output');
    return;
  }

  if (mode === 'secret') {
    process.stderr.write('diagnostic credential=' + credential);
    if (isCodex) {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'credential=' + credential } }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'credential=' + credential }));
    }
    return;
  }

  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(${2 * 1024 * 1024}));
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'hang-tree') {
    spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(markerPath) + ', "orphaned"), 800)'], {
      stdio: 'ignore'
    });
    setInterval(() => {}, 1000);
  }
});
`;

interface Harness {
	root: string;
	workspacePath: string;
	capturePath: string;
	markerPath: string;
	io: ModelExecutionIo;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness(mode: string, parentEnv: NodeJS.ProcessEnv = process.env): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'ever works model process '));
	roots.push(root);
	const workspacePath = join(root, 'task workspace with spaces');
	const stubPath = join(root, 'stub cli with spaces.cjs');
	const capturePath = join(root, 'capture.json');
	const markerPath = join(root, 'orphan-marker.txt');
	await mkdir(workspacePath, { recursive: true });
	await writeFile(stubPath, STUB_SOURCE, 'utf8');

	const command = {
		executable: process.execPath,
		prefixArgs: [stubPath, capturePath, mode, markerPath]
	};
	return {
		root,
		workspacePath,
		capturePath,
		markerPath,
		io: {
			commands: { 'claude-code': command, codex: command },
			parentEnv
		}
	};
}

function request(
	provider: ModelExecutionProvider,
	workspacePath: string,
	overrides: Partial<ModelExecutionRequest> = {}
): ModelExecutionRequest {
	const base = {
		workspacePath,
		instructions: 'Edit the project and report the verified result.',
		model: provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-codex',
		credentialEnv:
			provider === 'claude-code'
				? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
				: { CODEX_ACCESS_TOKEN: FAKE_CODEX_CREDENTIAL },
		timeoutMs: 5_000
	};
	return { ...base, ...overrides, provider } as ModelExecutionRequest;
}

async function readCapture(harness: Harness): Promise<{
	argv: string[];
	cwd: string;
	input: string;
	env: Record<string, string>;
}> {
	return JSON.parse(await readFile(harness.capturePath, 'utf8'));
}

function envValue(env: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
	return key ? env[key] : undefined;
}

describe('executeModelProcess — real process boundary', () => {
	it.each(['claude-code', 'codex'] as const)(
		'runs %s without a shell, in a path with spaces, with instructions on stdin',
		async (provider) => {
			const harness = await createHarness('success', {
				Path: process.env.Path ?? process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				DATABASE_PASSWORD: 'must-not-leak',
				GH_TOKEN: 'must-not-leak',
				NODE_OPTIONS: '--require must-not-run.js',
				CLAUDE_CODE_OAUTH_TOKEN: 'ambient-claude-must-not-win',
				OPENAI_API_KEY: 'ambient-openai-must-not-win'
			});

			const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);

			expect(result).toMatchObject({ status: 'succeeded', provider, exitCode: 0, summary: 'done' });
			const capture = await readCapture(harness);
			expect(capture.cwd).toBe(harness.workspacePath);
			expect(capture.input).toBe('Edit the project and report the verified result.');
			expect(capture.argv.join('\n')).not.toContain(capture.input);
			expect(capture.argv.join('\n')).not.toContain(
				provider === 'claude-code' ? FAKE_CLAUDE_CREDENTIAL : FAKE_CODEX_CREDENTIAL
			);
			expect(envValue(capture.env, 'PATH')).toBeTruthy();
			expect(capture.env.DATABASE_PASSWORD).toBeUndefined();
			expect(capture.env.GH_TOKEN).toBeUndefined();
			expect(capture.env.NODE_OPTIONS).toBeUndefined();
		}
	);

	it('builds the supported non-interactive Claude Code argv and grants only its selected credential', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				options: { effort: 'high', maxBudgetUsd: 5, permissionMode: 'acceptEdits' }
			}),
			harness.io
		);
		const capture = await readCapture(harness);
		expect(capture.argv).toEqual([
			'--print',
			'--output-format',
			'json',
			'--no-session-persistence',
			'--safe-mode',
			'--strict-mcp-config',
			'--permission-mode',
			'acceptEdits',
			'--model',
			'sonnet',
			'--effort',
			'high',
			'--max-budget-usd',
			'5'
		]);
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_CLAUDE_CREDENTIAL);
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CLAUDE_CONFIG_DIR).toBeTruthy();
	});

	it('builds the supported non-interactive Codex argv and grants only its selected credential', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('codex', harness.workspacePath, { options: { sandbox: 'workspace-write' } }),
			harness.io
		);
		const capture = await readCapture(harness);
		expect(capture.argv).toEqual([
			'exec',
			'--json',
			'--ephemeral',
			'--ignore-user-config',
			'--color',
			'never',
			'--sandbox',
			'workspace-write',
			'--model',
			'gpt-5.6-codex',
			'--',
			'-'
		]);
		expect(capture.env.CODEX_ACCESS_TOKEN).toBe(FAKE_CODEX_CREDENTIAL);
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_HOME).toBeTruthy();
	});

	it('maps a selected OpenAI platform key to the Codex exec-only credential name', async () => {
		const harness = await createHarness('success');
		await executeModelProcess(
			request('codex', harness.workspacePath, {
				credentialEnv: { OPENAI_API_KEY: FAKE_CODEX_CREDENTIAL }
			}),
			harness.io
		);
		const capture = await readCapture(harness);

		expect(capture.env.CODEX_API_KEY).toBe(FAKE_CODEX_CREDENTIAL);
		expect(capture.env.OPENAI_API_KEY).toBeUndefined();
		expect(capture.env.CODEX_ACCESS_TOKEN).toBeUndefined();
	});

	it.each(['claude-code', 'codex'] as const)('distinguishes a structured %s model failure', async (provider) => {
		const harness = await createHarness('model-error');
		const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'model-failed', exitCode: 0 });
		expect(result.summary).toContain('model tool failed');
	});

	it('distinguishes a nonzero CLI process exit', async () => {
		const harness = await createHarness('nonzero');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'process-failed', exitCode: 7 });
		expect(result.stderrExcerpt).toContain('CLI process failed');
	});

	it.each(['claude-code', 'codex'] as const)('distinguishes malformed %s machine output', async (provider) => {
		const harness = await createHarness('malformed');
		const result = await executeModelProcess(request(provider, harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'malformed-output', exitCode: 0 });
	});

	it('terminates and reports output that exceeds the hard byte bound', async () => {
		const harness = await createHarness('oversized');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);
		expect(result).toMatchObject({ status: 'output-limit', outputTruncated: true });
		expect(Buffer.byteLength(result.stdoutExcerpt ?? '', 'utf8')).toBeLessThanOrEqual(
			MODEL_EXECUTION_OUTPUT_LIMIT_BYTES
		);
	});

	it('redacts the selected credential from parsed output and diagnostics', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(request('claude-code', harness.workspacePath), harness.io);
		const serialized = JSON.stringify(result);
		expect(result.status).toBe('succeeded');
		expect(serialized).not.toContain(FAKE_CLAUDE_CREDENTIAL);
		expect(serialized).toContain('[redacted]');
	});

	it('never exempts a short selected credential from diagnostic redaction', async () => {
		const harness = await createHarness('secret');
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, {
				credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'xy' }
			}),
			harness.io
		);

		expect(JSON.stringify(result)).not.toContain('credential=xy');
	});

	it('bounds a successful model summary independently of the parser input ceiling', async () => {
		const harness = await createHarness('long-success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), harness.io);

		expect(result.status).toBe('succeeded');
		expect(Buffer.byteLength(result.summary ?? '', 'utf8')).toBeLessThanOrEqual(MODEL_EXECUTION_EXCERPT_BYTES);
	});

	it('kills the whole spawned process tree on timeout so no grandchild survives', async () => {
		const harness = await createHarness('hang-tree');
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { timeoutMs: 75 }),
			harness.io
		);
		expect(result.status).toBe('timed-out');
		await new Promise((resolve) => setTimeout(resolve, 950));
		await expect(access(harness.markerPath)).rejects.toThrow();
	});

	it('kills the process tree and reports cancellation when its AbortSignal fires', async () => {
		const harness = await createHarness('hang-tree');
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await executeModelProcess(
			request('claude-code', harness.workspacePath, { signal: controller.signal }),
			harness.io
		);
		expect(result.status).toBe('cancelled');
	});

	it('reports cancellation when the signal races with process spawn', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				spawnFn: ((...args: Parameters<typeof spawn>) => {
					controller.abort();
					return spawn(...args);
				}) as typeof spawn
			}
		);

		expect(result.status).toBe('cancelled');
	});

	it('distinguishes an executable spawn failure', async () => {
		const harness = await createHarness('success');
		const result = await executeModelProcess(request('codex', harness.workspacePath), {
			...harness.io,
			commands: { codex: { executable: join(harness.root, 'missing cli.exe') } }
		});
		expect(result).toMatchObject({ status: 'spawn-failed', exitCode: null });
	});
});

describe('executeModelProcess — request refusal', () => {
	it.each([
		['claude-code', { dangerouslySkipPermissions: 'false' }],
		['codex', { dangerouslyBypassApprovalsAndSandbox: 'false' }]
	] as const)('refuses a non-boolean dangerous opt-in for %s', async (provider, options) => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request(provider, harness.workspacePath, { options } as Partial<ModelExecutionRequest>),
				harness.io
			)
		).rejects.toThrow(/dangerous.*boolean/i);
	});

	it('refuses both credentials instead of relying on provider precedence', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request('claude-code', harness.workspacePath, {
					credentialEnv: {
						CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL,
						ANTHROPIC_API_KEY: 'anthropic-api-test-value-123456789'
					}
				}),
				harness.io
			)
		).rejects.toBeInstanceOf(ModelExecutionRequestError);
	});

	it('refuses a credential belonging to the other provider', async () => {
		const harness = await createHarness('success');
		await expect(
			executeModelProcess(
				request('codex', harness.workspacePath, {
					credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_CREDENTIAL }
				}),
				harness.io
			)
		).rejects.toThrow(/credential.*codex/i);
	});

	it('does not spawn when cancellation already happened', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		controller.abort();
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			harness.io
		);
		expect(result).toMatchObject({ status: 'cancelled', exitCode: null, durationMs: 0 });
		await expect(access(harness.capturePath)).rejects.toThrow();
	});

	it('does not spawn when cancellation happens during asynchronous workspace validation', async () => {
		const harness = await createHarness('success');
		const controller = new AbortController();
		let spawned = false;
		const result = await executeModelProcess(
			request('codex', harness.workspacePath, { signal: controller.signal }),
			{
				...harness.io,
				directoryExists: async () => {
					controller.abort();
					return true;
				},
				spawnFn: (() => {
					spawned = true;
					throw new Error('process must not be spawned after cancellation');
				}) as never
			}
		);

		expect(result.status).toBe('cancelled');
		expect(spawned).toBe(false);
	});
});
