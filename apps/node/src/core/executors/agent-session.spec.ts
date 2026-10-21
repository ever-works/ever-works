import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import {
	AgentSessionRefusal,
	buildAgentSessionArgv,
	resolveAgentSessionFolder,
	runAgentSessionJob,
	type AgentSessionIo
} from './agent-session';

const UUID = '11111111-1111-4111-8111-111111111111';

function job(payload: Record<string, unknown> = {}): FleetJobView {
	return {
		id: 'job-1',
		kind: 'agent-session',
		payload: {
			fleetSessionId: UUID,
			agentId: UUID,
			agentRunId: UUID,
			nodeId: UUID,
			provider: 'claude-code',
			cwd: '/home/nina/code/app',
			title: 'fix the build',
			firstMessage: 'Fix the failing build',
			cols: 120,
			rows: 32,
			permissionMode: 'acceptEdits',
			leaseTtlSec: 300,
			...payload
		}
	} as unknown as FleetJobView;
}

function io(over: Partial<AgentSessionIo> = {}): AgentSessionIo {
	return {
		workEnabled: true,
		daemon: { request: vi.fn(async () => ({})), onEvent: vi.fn(() => () => undefined) },
		modelCli: { 'claude-code': '/usr/local/bin/claude' },
		containment: {},
		nodeId: UUID,
		homedir: '/home/nina',
		platform: 'linux',
		realpath: async (target) => target,
		scratchFs: {
			createScratchDir: async () => '/tmp/scratch',
			writeFile: async () => undefined,
			remove: async () => undefined,
			mkdir: async () => undefined
		} as never,
		...over
	};
}

async function refusal(promise: Promise<unknown>): Promise<AgentSessionRefusal> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(AgentSessionRefusal);
		return error as AgentSessionRefusal;
	}
	throw new Error('expected a refusal');
}

describe('agent-session executor (FL-04 P2)', () => {
	it('launches Claude Code interactively: no -p, no --output-format, strict empty MCP, fleet settings', () => {
		const { command, typeAfterStart } = buildAgentSessionArgv({
			payload: { provider: 'claude-code', permissionMode: 'acceptEdits', firstMessage: 'Fix it' },
			executable: '/usr/local/bin/claude',
			cwd: '/home/nina/code/app',
			emptyMcpConfigPath: '/tmp/s/mcp.json',
			settingsPath: '/tmp/s/claude-settings.json',
			platform: 'linux'
		});
		expect(command).not.toContain('-p');
		expect(command).not.toContain('--output-format');
		expect(command.slice(0, 3)).toEqual(['/usr/local/bin/claude', '--permission-mode', 'acceptEdits']);
		const mcp = command.indexOf('--mcp-config');
		expect(command[mcp + 1]).toBe('/tmp/s/mcp.json');
		expect(command[mcp + 2]).toBe('--strict-mcp-config');
		expect(command).toContain('--settings');
		expect(command[command.length - 1]).toBe('Fix it');
		expect(typeAfterStart).toBeUndefined();
	});

	it('keeps Codex off the owner configuration (--ignore-user-config)', () => {
		const { command } = buildAgentSessionArgv({
			payload: { provider: 'codex', permissionMode: 'plan', firstMessage: 'Look around' },
			executable: '/usr/bin/codex',
			cwd: '/home/nina/code/app',
			emptyMcpConfigPath: '/tmp/s/mcp.json',
			settingsPath: '/tmp/s/claude-settings.json',
			platform: 'linux'
		});
		expect(command).toContain('--ignore-user-config');
		expect(command[command.indexOf('--sandbox') + 1]).toBe('read-only');
		expect(command).not.toContain('exec');
	});

	it('types the first message into a Windows .cmd CLI instead of its command line', () => {
		const { command, typeAfterStart } = buildAgentSessionArgv({
			payload: { provider: 'claude-code', permissionMode: 'acceptEdits', firstMessage: 'a & b' },
			executable: 'C:\\npm\\claude.cmd',
			cwd: 'C:\\code',
			emptyMcpConfigPath: 'C:\\t\\mcp.json',
			settingsPath: 'C:\\t\\s.json',
			platform: 'win32'
		});
		expect(command).not.toContain('a & b');
		expect(typeAfterStart).toBe('a & b');
	});

	it('keeps the folder inside the home folder', async () => {
		await expect(resolveAgentSessionFolder('~/code/app', io())).resolves.toBe('/home/nina/code/app');
		expect((await refusal(resolveAgentSessionFolder('/etc', io()))).code).toBe('invalid');
		expect((await refusal(resolveAgentSessionFolder('code', io()))).code).toBe('invalid');
	});

	it('refuses without --work, pinned to another node, without the CLI, or with a bad payload', async () => {
		const signal = new AbortController().signal;
		expect((await refusal(runAgentSessionJob(job(), signal, io({ workEnabled: false })))).code).toBe(
			'consent_missing'
		);
		expect((await refusal(runAgentSessionJob(job({ nodeId: '22222222-2222-4222-8222-222222222222' }), signal, io()))).code).toBe(
			'invalid'
		);
		expect((await refusal(runAgentSessionJob(job(), signal, io({ modelCli: {} })))).code).toBe('unsupported_on_node');
		expect((await refusal(runAgentSessionJob(job({ provider: 'shell' }), signal, io()))).code).toBe('invalid');
		expect((await refusal(runAgentSessionJob(job(), signal, io({ daemon: null })))).code).toBe('unsupported_on_node');
	});

	it('never downgrades: a computer that cannot isolate refuses with the reason, and starts nothing', async () => {
		const daemon = { request: vi.fn(async () => ({})), onEvent: vi.fn(() => () => undefined) };
		const error = await refusal(
			runAgentSessionJob(
				job(),
				new AbortController().signal,
				io({ daemon, containment: { modelHomeIsolation: 'inherit' } as never })
			)
		);
		expect(error.code).toBe('unsupported_on_node');
		expect(error.hint).toMatch(/Task-run isolation/);
		expect(daemon.request).not.toHaveBeenCalledWith('start', expect.anything());
	});
});
