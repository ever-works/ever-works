import { describe, expect, it } from 'vitest';
import type { TerminalFrame, TerminalTransport } from '@ever-works/plugin';
import { PtyLocalPlugin } from '../pty-local.plugin.js';

/**
 * The suite exercises the full pump contract against PLAIN child
 * processes (`node -e …`) so it runs on every platform and in CI with
 * no PTY prebuild and no shell assumptions. When the node-pty prebuild
 * happens to be installed the same contract holds on the PTY path —
 * `isPty` just flips; assertions that depend on the mode read it.
 */

function makeTransport() {
	const published: TerminalFrame[] = [];
	let pushInbound: ((f: TerminalFrame) => void) | null = null;
	let endInbound: (() => void) | null = null;
	const inboundQueue: TerminalFrame[] = [];
	let done = false;

	const transport: TerminalTransport = {
		publish: (frame) => {
			published.push(frame);
		},
		inbound: () => ({
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<TerminalFrame>> {
						if (inboundQueue.length > 0) {
							return Promise.resolve({ value: inboundQueue.shift()!, done: false });
						}
						if (done) {
							return Promise.resolve({ value: undefined, done: true });
						}
						return new Promise((resolve) => {
							pushInbound = (f) => resolve({ value: f, done: false });
							endInbound = () => resolve({ value: undefined, done: true });
						});
					}
				};
			}
		}),
		close: async () => {
			done = true;
			endInbound?.();
		}
	};

	return {
		transport,
		published,
		send(frame: TerminalFrame) {
			if (pushInbound) {
				const push = pushInbound;
				pushInbound = null;
				push(frame);
			} else {
				inboundQueue.push(frame);
			}
		},
		end() {
			done = true;
			endInbound?.();
		}
	};
}

function decodeStdout(frames: TerminalFrame[]): string {
	return frames
		.filter((f): f is Extract<TerminalFrame, { kind: 'stdout' }> => f.kind === 'stdout')
		.map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
		.join('');
}

const NODE = process.execPath;

describe('PtyLocalPlugin', () => {
	it('streams stdout as sequenced frames and publishes the exit frame BEFORE resolving', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();

		const handle = await plugin.spawn(
			{
				runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
				command: [NODE, '-e', 'process.stdout.write("hello-terminal")'],
				cwd: process.cwd(),
				env: {},
				preamble: [{ kind: 'error', message: 'starting…' }]
			},
			h.transport
		);

		const outcome = await handle.exited;
		expect(outcome.reason).toBe('completed');
		expect(outcome.code).toBe(0);

		// Preamble first, then stdout, exit LAST and present.
		expect(h.published[0]).toEqual({ kind: 'error', message: 'starting…' });
		expect(decodeStdout(h.published)).toContain('hello-terminal');
		const exitIdx = h.published.findIndex((f) => f.kind === 'exit');
		expect(exitIdx).toBe(h.published.length - 1);

		// stdout seqs are strictly monotonic from 0.
		const seqs = h.published
			.filter((f): f is Extract<TerminalFrame, { kind: 'stdout' }> => f.kind === 'stdout')
			.map((f) => f.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(seqs[0]).toBe(0);
	});

	it('a non-zero exit is reported as crashed', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();
		const handle = await plugin.spawn(
			{
				runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
				command: [NODE, '-e', 'process.exit(3)'],
				cwd: process.cwd(),
				env: {}
			},
			h.transport
		);
		const outcome = await handle.exited;
		expect(outcome).toMatchObject({ reason: 'crashed' });
		const exit = h.published.find((f) => f.kind === 'exit');
		expect(exit).toMatchObject({ kind: 'exit', reason: 'crashed' });
	});

	it('inbound stdin reaches the child process', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();
		const handle = await plugin.spawn(
			{
				runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
				command: [
					NODE,
					'-e',
					// Echo one line from stdin then exit.
					'process.stdin.once("data",(d)=>{process.stdout.write("echo:"+d.toString().trim());process.exit(0);})'
				],
				cwd: process.cwd(),
				env: {}
			},
			h.transport
		);

		h.send({ kind: 'stdin', data: Buffer.from('ping\n', 'utf8').toString('base64') });

		const outcome = await handle.exited;
		expect(outcome.reason).toBe('completed');
		expect(decodeStdout(h.published)).toContain('echo:ping');
	});

	it('kill() ends the session with reason closed', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();
		const handle = await plugin.spawn(
			{
				runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
				command: [NODE, '-e', 'setInterval(()=>{},1000)'],
				cwd: process.cwd(),
				env: {}
			},
			h.transport
		);
		handle.kill();
		const outcome = await handle.exited;
		expect(outcome.reason).toBe('closed');
	});

	it('pipe floor merges stderr into the stream (no silent failures)', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();
		const handle = await plugin.spawn(
			{
				runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
				command: [NODE, '-e', 'process.stderr.write("warn-line");process.exit(0)'],
				cwd: process.cwd(),
				env: {}
			},
			h.transport
		);
		await handle.exited;
		if (!handle.isPty) {
			expect(decodeStdout(h.published)).toContain('warn-line');
		} else {
			// PTY merges streams natively; content still arrives.
			expect(decodeStdout(h.published)).toContain('warn-line');
		}
	});

	it('throws the stably-named TerminalNotProvisionedError for an empty command', async () => {
		const plugin = new PtyLocalPlugin();
		const h = makeTransport();
		await expect(
			plugin.spawn(
				{
					runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
					command: [],
					cwd: process.cwd(),
					env: {}
				},
				h.transport
			)
		).rejects.toMatchObject({ name: 'TerminalNotProvisionedError' });
	});

	it('probe always reports ok with an honest mode detail', async () => {
		const plugin = new PtyLocalPlugin();
		const probe = await plugin.probe();
		expect(probe.ok).toBe(true);
		expect(probe.detail).toMatch(/PTY|pipe floor/i);
	});

	/**
	 * The node-pty prebuild is declared `optionalDependencies` precisely so a
	 * platform without a binary still installs. That contract only holds if a
	 * MISSING (or broken) addon degrades to the pipe floor instead of failing
	 * the session — these three lock that in so a future dependency move can
	 * never quietly turn "no PTY" into "no terminal".
	 */
	describe('graceful degradation when the node-pty prebuild is unavailable', () => {
		it('spawns through the pipe floor when the addon cannot be loaded', async () => {
			const plugin = new PtyLocalPlugin();
			// Simulate the addon being absent from this runtime.
			(plugin as unknown as { tryLoadPty: () => null }).tryLoadPty = () => null;
			const h = makeTransport();

			const handle = await plugin.spawn(
				{
					runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
					command: [NODE, '-e', 'process.stdout.write("floor-ok")'],
					cwd: process.cwd(),
					env: {}
				},
				h.transport
			);

			expect(handle.isPty).toBe(false);
			const outcome = await handle.exited;
			expect(outcome.reason).toBe('completed');
			expect(decodeStdout(h.published)).toContain('floor-ok');
		});

		it('degrades to the pipe floor when a PRESENT prebuild throws on spawn', async () => {
			const plugin = new PtyLocalPlugin();
			const warnings: string[] = [];
			await plugin.onLoad({
				logger: {
					log: () => {},
					warn: (m: string) => warnings.push(String(m)),
					error: () => {},
					debug: () => {}
				}
			} as never);
			// A JS library installed without its native binary: present, but
			// every spawn throws. Must degrade, never fail the session.
			(plugin as unknown as { tryLoadPty: () => unknown }).tryLoadPty = () => ({
				spawn: () => {
					throw new Error('node-pty native binding missing');
				}
			});
			const h = makeTransport();

			const handle = await plugin.spawn(
				{
					runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
					command: [NODE, '-e', 'process.stdout.write("degraded")'],
					cwd: process.cwd(),
					env: {}
				},
				h.transport
			);

			expect(handle.isPty).toBe(false);
			await handle.exited;
			expect(decodeStdout(h.published)).toContain('degraded');
			expect(warnings.join('\n')).toMatch(/pipe floor/i);
		});

		it('onLoad succeeds and reports pipe-floor mode with no addon present', async () => {
			const plugin = new PtyLocalPlugin();
			(plugin as unknown as { tryLoadPty: () => null }).tryLoadPty = () => null;
			const logs: string[] = [];

			await expect(
				plugin.onLoad({
					logger: {
						log: (m: string) => logs.push(String(m)),
						warn: () => {},
						error: () => {},
						debug: () => {}
					}
				} as never)
			).resolves.toBeUndefined();

			expect(logs.join('\n')).toContain('pipe-floor');
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});
});
