import { describe, expect, it, vi } from 'vitest';
import type { FleetAgentModelExecution } from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';
import {
	buildModelCliCommand,
	MODEL_CLI_OPTIONAL_FLAGS,
	unsupportedOptionalModelCliFlags
} from './executors/model-cli';
import {
	describeCliVersions,
	isModelCliCompatible,
	judgeModelCliHelp,
	ModelCliCompatibilityProbe,
	parseAdvertisedFlags,
	primaryPinnedCliVersion
} from './model-cli-compat';

/**
 * Node lifecycle (self-build slice AR) — the PINNED model CLIs' version and
 * flag compatibility, and the command builder dropping what a binary does
 * not understand.
 *
 * The help texts below are abbreviated literals in the shape the two CLIs
 * print. The property under test is not "we parse today's help perfectly"
 * — it is that an UNRECOGNISABLE help text drops nothing, and that only
 * the optional flags can ever be dropped.
 */

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]              Enable debug mode
  -p, --print                       Print response and exit (useful for pipes)
  --output-format <format>          Output format (only works with --print)
  --permission-mode <mode>          Permission mode to use for the session
  --model <model>                   Model for the current session
  --effort <level>                  Effort level for the session
  --max-budget-usd <amount>         Maximum dollar amount to spend on API calls
  --add-dir <directories...>        Additional directories to allow tool access to
  --mcp-config <configs...>         Load MCP servers from JSON files or strings
  --strict-mcp-config               Only use MCP servers from --mcp-config
  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names to allow
  --dangerously-skip-permissions    Bypass all permission checks
  -h, --help                        Display help for command
`;

/** The same CLI after an upstream release dropped two optional knobs. */
const CLAUDE_HELP_NO_OPTIONALS = CLAUDE_HELP.split('\n')
	.filter((line) => !line.includes('--effort') && !line.includes('--max-budget-usd'))
	.join('\n');

const CODEX_EXEC_HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>     Override a configuration value
  -m, --model <MODEL>          Model the agent should use
  -s, --sandbox <SANDBOX_MODE> Select the sandbox policy
      --dangerously-bypass-approvals-and-sandbox  Skip all confirmation prompts
  -C, --cd <DIR>               Tell the agent to use the specified directory as its working root
      --add-dir <DIR>          Additional directories that should be writable
      --json                   Print events to stdout as JSONL
  -h, --help                   Print help
`;

const execution = (overrides: Partial<FleetAgentModelExecution> = {}): FleetAgentModelExecution =>
	({
		provider: 'claude-code',
		instructions: 'do the thing',
		effort: 'high',
		maxBudgetUsd: 5,
		...overrides
	}) as FleetAgentModelExecution;

const scratch = { instructionsPath: '/tmp/s/instructions.md', resultPath: '/tmp/s/model-output.json' };

describe('parseAdvertisedFlags', () => {
	it('reads standalone flag tokens only', () => {
		const flags = parseAdvertisedFlags(CLAUDE_HELP);
		for (const flag of ['-p', '--print', '--output-format', '--effort', '--max-budget-usd', '--allowedTools']) {
			expect(flags.has(flag)).toBe(true);
		}
		// Prose and fragments never count as flags.
		expect(flags.has('-interactive')).toBe(false);
		expect(parseAdvertisedFlags('use non-interactive mode --add-directories').has('--add-dir')).toBe(false);
	});
});

describe('judgeModelCliHelp', () => {
	it('a full help text is compatible and drops nothing', () => {
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '2.1.3', CLAUDE_HELP);
		expect(isModelCliCompatible(compat)).toBe(true);
		expect(compat.unsupportedOptionalFlags).toEqual([]);
		expect(compat.missingConditionalFlags).toEqual([]);
		expect(compat.supportedFlags).not.toBeNull();
	});

	it('names the optional flags a build no longer advertises', () => {
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '3.0.0', CLAUDE_HELP_NO_OPTIONALS);
		expect(isModelCliCompatible(compat)).toBe(true);
		expect(compat.unsupportedOptionalFlags).toEqual(['--effort', '--max-budget-usd']);
	});

	it('a help that lists some always-passed flags but not all is INCOMPATIBLE', () => {
		const help = CLAUDE_HELP.split('\n')
			.filter((line) => !line.includes('--permission-mode'))
			.join('\n');
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '9.0.0', help);
		expect(isModelCliCompatible(compat)).toBe(false);
		expect(compat.missingRequiredFlags).toEqual(['--permission-mode']);
	});

	it('an UNRECOGNISED help text is "could not tell", never "supports nothing"', () => {
		// The rule that keeps this honest: a help format change must not
		// silently strip --effort from every run on the fleet.
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '9.0.0', 'Usage: claude\nSee docs.');
		expect(compat.supportedFlags).toBeNull();
		expect(compat.note).toContain('not recognised');
		expect(unsupportedOptionalModelCliFlags(execution(), compat.supportedFlags)).toEqual([]);
		expect(judgeModelCliHelp('claude-code', '/bin/claude', null, null).supportedFlags).toBeNull();
	});

	it('reads codex from its exec subcommand help', () => {
		const compat = judgeModelCliHelp('codex', '/bin/codex', '0.48.0', CODEX_EXEC_HELP);
		expect(isModelCliCompatible(compat)).toBe(true);
		expect(compat.missingConditionalFlags).toEqual([]);
	});
});

describe('the command builder drops ONLY optional flags', () => {
	it('drops --effort / --max-budget-usd the pinned build does not advertise', () => {
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '3.0.0', CLAUDE_HELP_NO_OPTIONALS);
		const dropped = unsupportedOptionalModelCliFlags(execution(), compat.supportedFlags);
		expect(dropped).toEqual(['--effort', '--max-budget-usd']);

		const command = buildModelCliCommand({
			execution: execution(),
			executable: '/bin/claude',
			workspacePath: '/w',
			scratch,
			platform: 'linux',
			omitFlags: dropped
		});
		expect(command).not.toContain('--effort');
		expect(command).not.toContain('--max-budget-usd');
		expect(command).toContain('--permission-mode acceptEdits');
	});

	it('keeps them when the build advertises them — byte-for-byte the old command', () => {
		const compat = judgeModelCliHelp('claude-code', '/bin/claude', '2.1.3', CLAUDE_HELP);
		const dropped = unsupportedOptionalModelCliFlags(execution(), compat.supportedFlags);
		expect(dropped).toEqual([]);
		const withOmit = buildModelCliCommand({
			execution: execution(),
			executable: '/bin/claude',
			workspacePath: '/w',
			scratch,
			platform: 'linux',
			omitFlags: dropped
		});
		const legacy = buildModelCliCommand({
			execution: execution(),
			executable: '/bin/claude',
			workspacePath: '/w',
			scratch,
			platform: 'linux'
		});
		expect(withOmit).toBe(legacy);
		expect(legacy).toContain('--effort high');
		expect(legacy).toContain('--max-budget-usd 5');
	});

	it('refuses to drop a containment flag whatever the caller passes', () => {
		const command = buildModelCliCommand({
			execution: execution({ skipPermissions: true }),
			executable: '/bin/claude',
			workspacePath: '/w',
			scratch,
			platform: 'linux',
			omitFlags: ['--permission-mode', '--dangerously-skip-permissions', '--output-format']
		});
		expect(command).toContain('--permission-mode');
		expect(command).toContain('--dangerously-skip-permissions');
		expect(command).toContain('--output-format json');
	});

	it('codex has nothing droppable', () => {
		expect(MODEL_CLI_OPTIONAL_FLAGS.codex).toEqual([]);
		expect(
			unsupportedOptionalModelCliFlags(execution({ provider: 'codex' } as never), new Set(['--json']))
		).toEqual([]);
	});
});

describe('ModelCliCompatibilityProbe', () => {
	function runner(): CommandRunner & { run: ReturnType<typeof vi.fn> } {
		return {
			run: vi.fn(async (_command: string, args: string[]) =>
				args[0] === '--version'
					? { code: 0, stdout: '2.1.3 (Claude Code)\n', stderr: '' }
					: { code: 0, stdout: CLAUDE_HELP, stderr: '' }
			)
		} as never;
	}

	it('probes the PINNED path once per binary identity, and again when the file changes', async () => {
		const run = runner();
		let stamp = { mtimeMs: 1, size: 100 };
		const probe = new ModelCliCompatibilityProbe({ runner: run, statFile: () => stamp });

		const first = await probe.probe('claude-code', '/opt/pinned/claude');
		await probe.probe('claude-code', '/opt/pinned/claude');
		expect(first.version).toBe('2.1.3');
		expect(run.run).toHaveBeenCalledTimes(2);
		expect(run.run).toHaveBeenCalledWith('/opt/pinned/claude', ['--version']);
		expect(run.run).toHaveBeenCalledWith('/opt/pinned/claude', ['--help']);

		stamp = { mtimeMs: 2, size: 100 }; // upgraded in place
		await probe.probe('claude-code', '/opt/pinned/claude');
		expect(run.run).toHaveBeenCalledTimes(4);
	});

	it('falls back to a time-boxed cache when the binary cannot be stamped', async () => {
		const run = runner();
		let now = 0;
		const probe = new ModelCliCompatibilityProbe({ runner: run, now: () => now, unstampedTtlMs: 1_000 });
		await probe.probe('claude-code', '/opt/claude');
		now = 500;
		await probe.probe('claude-code', '/opt/claude');
		expect(run.run).toHaveBeenCalledTimes(2);
		now = 1_500;
		await probe.probe('claude-code', '/opt/claude');
		expect(run.run).toHaveBeenCalledTimes(4);
	});

	it('retries an INCOMPLETE answer soon, even for a stamped binary that did not change (review)', async () => {
		let now = 0;
		let healthy = false;
		const run = {
			run: vi.fn(async (_command: string, args: string[]) => {
				if (!healthy) throw new Error('timed out');
				return args[0] === '--version'
					? { code: 0, stdout: '2.1.3', stderr: '' }
					: { code: 0, stdout: CLAUDE_HELP, stderr: '' };
			})
		};
		const probe = new ModelCliCompatibilityProbe({
			runner: run as never,
			statFile: () => ({ mtimeMs: 1, size: 100 }),
			now: () => now,
			incompleteRetryMs: 60_000
		});

		expect((await probe.probe('claude-code', '/opt/claude')).supportedFlags).toBeNull();
		healthy = true;
		now = 30_000;
		expect((await probe.probe('claude-code', '/opt/claude')).supportedFlags).toBeNull(); // still cached
		now = 61_000;
		const recovered = await probe.probe('claude-code', '/opt/claude');
		expect(recovered.supportedFlags).not.toBeNull();
		expect(recovered.version).toBe('2.1.3');

		// A COMPLETE answer from a stamped file is then kept until the file changes.
		const calls = run.run.mock.calls.length;
		now = 10 * 60 * 60_000;
		await probe.probe('claude-code', '/opt/claude');
		expect(run.run.mock.calls.length).toBe(calls);
	});

	it('asks codex through `exec --help` and quotes a Windows path with spaces', async () => {
		const run = {
			run: vi.fn(async (_command: string, args: string[]) =>
				args[0] === '--version'
					? { code: 0, stdout: 'codex-cli 0.48.0', stderr: '' }
					: { code: 0, stdout: CODEX_EXEC_HELP, stderr: '' }
			)
		};
		const probe = new ModelCliCompatibilityProbe({ runner: run as never, platform: 'win32' });
		const compat = await probe.probe('codex', 'C:\\Program Files\\nodejs\\codex.cmd');
		expect(compat.version).toBe('0.48.0');
		expect(run.run).toHaveBeenCalledWith('"C:\\Program Files\\nodejs\\codex.cmd"', ['exec', '--help']);
	});

	it('never throws: a binary that will not start is "version unknown, could not tell"', async () => {
		const probe = new ModelCliCompatibilityProbe({
			runner: {
				run: async () => {
					throw new Error('ENOENT');
				}
			}
		});
		const compat = await probe.probe('claude-code', '/missing/claude');
		expect(compat).toMatchObject({ version: null, supportedFlags: null });
	});

	it('probes only the providers that are actually pinned', async () => {
		const run = runner();
		const probe = new ModelCliCompatibilityProbe({ runner: run });
		const results = await probe.probeAll({ 'claude-code': '/opt/claude', codex: null });
		expect(results.map((result) => result.provider)).toEqual(['claude-code']);
	});
});

describe('what the heartbeat reports', () => {
	it('one "<provider> <version>" entry per pinned binary, "unknown" when it did not say', () => {
		const results = [
			judgeModelCliHelp('claude-code', '/a', '2.1.3', CLAUDE_HELP),
			judgeModelCliHelp('codex', '/b', null, CODEX_EXEC_HELP)
		];
		expect(describeCliVersions(results)).toEqual(['claude-code 2.1.3', 'codex unknown']);
	});

	it('the legacy single cliVersion comes from the PINNED binary, in its old shape', () => {
		expect(
			primaryPinnedCliVersion([
				judgeModelCliHelp('claude-code', '/a', null, null),
				judgeModelCliHelp('codex', '/b', '0.48.0', CODEX_EXEC_HELP)
			])
		).toBe('codex 0.48.0');
		expect(primaryPinnedCliVersion([judgeModelCliHelp('claude-code', '/a', '2.1.3', CLAUDE_HELP)])).toBe(
			'claude 2.1.3'
		);
		expect(primaryPinnedCliVersion([])).toBeNull();
	});
});
