import { describe, expect, it, vi } from 'vitest';
import type {
	ITerminalStreamPlugin,
	TerminalSessionHandle,
	TerminalSpawnInput,
	TerminalTransport
} from '@ever-works/plugin';
import type { TerminalFrame } from '@ever-works/contracts';
import { resolveNodeShell, startNodeTerminalChannel } from './terminal-channel';

const SESSION = '33333333-2222-4333-8444-555555555555';

interface FakeHost {
	host: ITerminalStreamPlugin;
	inputs: TerminalSpawnInput[];
	transports: TerminalTransport[];
	kill: ReturnType<typeof vi.fn>;
	exit: () => void;
}

function fakeHost(options: { isPty?: boolean; spawnError?: Error; neverExits?: boolean } = {}): FakeHost {
	const inputs: TerminalSpawnInput[] = [];
	const transports: TerminalTransport[] = [];
	let resolveExit: (value: { code: number; reason: 'closed' }) => void = () => undefined;
	const exited = new Promise<{ code: number; reason: 'closed' }>((resolve) => (resolveExit = resolve));
	const kill = vi.fn(() => {
		if (!options.neverExits) resolveExit({ code: 0, reason: 'closed' });
	});
	const host = {
		id: 'fake-terminal',
		name: 'Fake terminal',
		version: '1.0.0',
		category: 'utility',
		capabilities: ['terminal-stream'],
		providerName: 'fake-terminal',
		spawn: async (input: TerminalSpawnInput, transport: TerminalTransport): Promise<TerminalSessionHandle> => {
			if (options.spawnError) throw options.spawnError;
			inputs.push(input);
			transports.push(transport);
			return {
				runId: input.runId,
				isPty: options.isPty ?? true,
				write: () => undefined,
				resize: () => undefined,
				kill,
				exited
			};
		}
	} as unknown as ITerminalStreamPlugin;
	return { host, inputs, transports, kill, exit: () => resolveExit({ code: 0, reason: 'closed' }) };
}

const stdout = (text: string): TerminalFrame => ({
	kind: 'stdout',
	seq: 0,
	data: Buffer.from(text).toString('base64')
});

describe('startNodeTerminalChannel', () => {
	it('opens the machine’s shell in the Agent’s file root, keyed by the live view, through the terminal provider', async () => {
		const { host, inputs } = fakeHost({ isPty: true });
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: '/profiles/agent-a/files',
			publish: () => undefined,
			platform: 'linux',
			parentEnv: { SHELL: '/bin/bash', PATH: '/usr/bin' }
		});

		expect(channel.isPty).toBe(true);
		expect(inputs).toHaveLength(1);
		expect(inputs[0].runId).toBe(SESSION);
		expect(inputs[0].cwd).toBe('/profiles/agent-a/files');
		expect(inputs[0].command).toEqual(['/bin/bash']);
		expect(inputs[0].env.TERM).toBe('xterm-256color');
		// The shell must survive a read-only inbound leg: watching never ends it.
		expect(inputs[0].endOnInputClose).toBe(false);
		await channel.stop();
	});

	it('never hands the node’s own credential namespace to the shell', async () => {
		const { host, inputs } = fakeHost();
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: '/files',
			publish: () => undefined,
			platform: 'linux',
			parentEnv: {
				PATH: '/usr/bin',
				EVER_WORKS_NODE_SECRET: 'node-secret-value',
				GITHUB_TOKEN: 'ghp_notforthe_shell_000000000000000000'
			}
		});

		const values = Object.values(inputs[0].env);
		expect(values).not.toContain('node-secret-value');
		expect(values).not.toContain('ghp_notforthe_shell_000000000000000000');
		await channel.stop();
	});

	it('forwards every frame the provider publishes until the channel stops, then drops late ones', async () => {
		const { host, transports } = fakeHost();
		const published: TerminalFrame[] = [];
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: '/files',
			publish: (frame) => published.push(frame),
			platform: 'linux',
			parentEnv: {}
		});

		transports[0].publish(stdout('hello\n'));
		expect(published).toHaveLength(1);

		await transports[0].close();
		transports[0].publish(stdout('after close\n'));
		expect(published).toHaveLength(1);
		await channel.stop();
	});

	it('is read-only while watching: its inbound leg yields no keystroke and finishes when the channel stops', async () => {
		const { host, transports } = fakeHost();
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: '/files',
			publish: () => undefined,
			platform: 'linux',
			parentEnv: {}
		});

		const received: TerminalFrame[] = [];
		const consumed = (async () => {
			for await (const frame of transports[0].inbound()) received.push(frame);
		})();
		await channel.stop();
		await consumed;
		expect(received).toEqual([]);
	});

	it('stops the shell once, however many times it is asked', async () => {
		const { host, kill } = fakeHost();
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: '/files',
			publish: () => undefined,
			platform: 'linux',
			parentEnv: {}
		});

		await channel.stop();
		await channel.stop();
		expect(kill).toHaveBeenCalledTimes(1);
	});

	it('does not hang the end of a view on a shell that ignores the kill', async () => {
		vi.useFakeTimers();
		try {
			const { host } = fakeHost({ neverExits: true });
			const channel = await startNodeTerminalChannel({
				host,
				sessionId: SESSION,
				cwd: '/files',
				publish: () => undefined,
				platform: 'linux',
				parentEnv: {}
			});
			const stopped = channel.stop();
			await vi.advanceTimersByTimeAsync(3000);
			await expect(stopped).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('publishes nothing more once stopped, even from a shell that ignores the kill', async () => {
		vi.useFakeTimers();
		try {
			const { host, transports } = fakeHost({ neverExits: true });
			const published: TerminalFrame[] = [];
			const channel = await startNodeTerminalChannel({
				host,
				sessionId: SESSION,
				cwd: '/files',
				publish: (frame) => published.push(frame),
				platform: 'linux',
				parentEnv: {}
			});
			transports[0].publish(stdout('before\n'));
			expect(published).toHaveLength(1);

			const stopped = channel.stop();
			transports[0].publish(stdout('while stopping\n'));
			await vi.advanceTimersByTimeAsync(3000);
			await stopped;
			transports[0].publish(stdout('after stop\n'));

			expect(published).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces a provider that cannot host a shell as a rejection the executor turns into a banner', async () => {
		const { host } = fakeHost({
			spawnError: Object.assign(new Error('no pty here'), { name: 'TerminalNotProvisionedError' })
		});
		await expect(
			startNodeTerminalChannel({
				host,
				sessionId: SESSION,
				cwd: '/files',
				publish: () => undefined,
				platform: 'linux',
				parentEnv: {}
			})
		).rejects.toThrow('no pty here');
	});

	it('uses PowerShell as the shell on Windows', async () => {
		const { host, inputs } = fakeHost();
		const channel = await startNodeTerminalChannel({
			host,
			sessionId: SESSION,
			cwd: 'C:\\profiles\\agent-a\\files',
			publish: () => undefined,
			platform: 'win32',
			parentEnv: {}
		});
		expect(inputs[0].command).toEqual(resolveNodeShell('win32', {}).command);
		await channel.stop();
	});
});
