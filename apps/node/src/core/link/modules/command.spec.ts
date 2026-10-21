import { describe, expect, it } from 'vitest';
import {
	decodeFleetLinkExit,
	FLEET_LINK_FRAME_KINDS,
	type FleetConsents,
	type FleetLinkCloseReason,
	type FleetLinkExtensionMessage,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { createCommandModule } from './command';
import type { CommandExit, CommandRunHandle, CommandRunnerOptions } from './command/command-runner';
import { createLinkControlState } from './control';
import type { NodeChannelContext, NodeChannelHandler } from './registry';

/**
 * The node's `command` family (FL-12, CONTRACTS §3.3, R-24; spec FR-2, FR-7,
 * FR-9, FR-14, U1, U3, U7, U9) against a FAKE runner, so the channel protocol
 * is checked without spawning a shell: the consent refusal, the run reply and
 * the end (`command.output` then `EXIT` then close), cancel from another
 * channel (`EXIT 130`), the kill switch (`EXIT 137`, `kill-switch`), drain,
 * a refused folder, a shell that cannot start, and an end held across a link
 * drop.
 */

const MANAGE: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };
const RUN = '55555555-5555-4555-8555-555555555555';
const COMMAND = '66666666-6666-4666-8666-666666666666';
const HOME = '/home/dana';

class FakeContext implements NodeChannelContext {
	readonly json: Array<Record<string, unknown>> = [];
	readonly binary: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
	closedWith: FleetLinkCloseReason | null = null;
	linkUp = true;
	readonly family = 'command' as const;
	readonly nodeVersion = '0.3.0';
	readonly nodeName = 'build-01';
	readonly operations = { start: () => 'op', progress: () => undefined, done: () => undefined };

	constructor(
		readonly channel: number,
		readonly params: Record<string, unknown>,
		readonly control: ReturnType<typeof createLinkControlState>,
		readonly consents: FleetConsents = MANAGE
	) {}

	sendJson(message: Record<string, unknown>): boolean {
		if (!this.linkUp) return false;
		this.json.push(message);
		return true;
	}

	sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean {
		if (!this.linkUp) return false;
		this.binary.push({ kind, payload });
		return true;
	}

	sendControl(_message: FleetLinkExtensionMessage): boolean {
		return true;
	}

	close(reason: FleetLinkCloseReason): void {
		this.closedWith = reason;
	}

	reply(requestId: string): Record<string, unknown> | undefined {
		return this.json.find((message) => message.requestId === requestId);
	}

	exitCode(): number | null {
		const frame = this.binary.find((entry) => entry.kind === FLEET_LINK_FRAME_KINDS.EXIT);
		return frame ? decodeFleetLinkExit(frame.payload) : null;
	}

	output(): Record<string, unknown> | undefined {
		return this.json.find((message) => message.type === 'command.output');
	}
}

/** A runner the test drives: it records the options and settles when told to. */
function fakeRunner() {
	const calls: CommandRunnerOptions[] = [];
	let settle: (exit: CommandExit) => void = () => undefined;
	let stopped = 0;
	let failStart: Error | null = null;
	const start = (options: CommandRunnerOptions): Promise<CommandRunHandle> => {
		calls.push(options);
		if (failStart) return Promise.reject(failStart);
		const done = new Promise<CommandExit>((resolve) => {
			settle = resolve;
		});
		return Promise.resolve({
			pid: 4242,
			shell: '/bin/zsh -l',
			stop: () => {
				stopped += 1;
				settle({ exitCode: null, signal: 'SIGTERM', bytes: 0, capped: false, timedOut: false });
			},
			done
		});
	};
	return {
		start,
		calls,
		finish: (exitCode: number) => settle({ exitCode, signal: null, bytes: 0, capped: false, timedOut: false }),
		get stopped() {
			return stopped;
		},
		failNextStart(error: Error) {
			failStart = error;
		}
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settled = async () => {
	for (let index = 0; index < 10; index += 1) await tick();
};

function setup(consents: FleetConsents = MANAGE) {
	const runner = fakeRunner();
	const control = createLinkControlState();
	const module = createCommandModule({
		consents,
		nodeName: 'build-01',
		platform: 'linux',
		homedir: HOME,
		env: { SHELL: '/bin/zsh', PATH: '/usr/bin', FLEET_SECRET: 'nope', EVER_WORKS_TOKEN: 'nope' },
		start: runner.start,
		realpath: async (target) => {
			if (target.startsWith('/nowhere')) throw new Error('ENOENT');
			return target;
		}
	});
	const provider = module.families![0];
	const open = async (channel = 1): Promise<{ context: FakeContext; handler: NodeChannelHandler }> => {
		const context = new FakeContext(channel, { commandId: COMMAND, nodeId: 'n1', runId: RUN }, control, consents);
		const result = await provider.open(context);
		if (!result.ok) throw new Error(result.error.code);
		return { context, handler: result.handler };
	};
	return { runner, control, provider, open };
}

const runMessage = (requestId: string, params: Record<string, unknown> = {}) => ({
	requestId,
	type: 'command.run',
	params: { runId: RUN, command: 'uptime', timeoutSec: 600, ...params }
});

describe('the command family', () => {
	it('refuses a channel without --manage', async () => {
		const { provider, control } = setup({ ...MANAGE, manage: false });
		const result = await provider.open(
			new FakeContext(1, { commandId: COMMAND, nodeId: 'n1', runId: RUN }, control, { ...MANAGE, manage: false })
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({
				code: 'consent_missing',
				hint: 'start the node with --manage on build-01'
			});
		}
	});

	it('runs in the login shell from home with a scrubbed environment, then reports the end', async () => {
		const { runner, open } = setup();
		const { context, handler } = await open();
		handler.onJson?.(runMessage('r1'));
		await settled();
		expect(context.reply('r1')).toMatchObject({ result: { pid: 4242, shell: '/bin/zsh -l' } });
		const options = runner.calls[0];
		expect(options.shell).toEqual(['/bin/zsh', '-l']);
		expect(options.cwd).toBe(HOME);
		expect(options.env.FLEET_SECRET).toBeUndefined();
		expect(options.env.EVER_WORKS_TOKEN).toBeUndefined();
		options.onData(new TextEncoder().encode('up 3 days\n'));
		runner.finish(0);
		await settled();
		expect(context.output()).toMatchObject({ head: 'up 3 days\n', exitCode: 0, truncated: false });
		expect(context.output()?.reason).toBeUndefined();
		expect(context.exitCode()).toBe(0);
		expect(context.closedWith).toBe('normal');
	});

	it('cancels from another channel: EXIT 130, cancelled-by-user', async () => {
		const { runner, open } = setup();
		const { context, handler } = await open(1);
		handler.onJson?.(runMessage('r1'));
		await settled();
		const other = await open(2);
		other.handler.onJson?.({ requestId: 'c1', type: 'command.cancel', params: { runId: RUN } });
		await settled();
		expect(other.context.reply('c1')).toMatchObject({ result: { cancelled: true } });
		expect(runner.stopped).toBe(1);
		expect(context.output()).toMatchObject({ reason: 'cancelled-by-user', exitCode: 130 });
		expect(context.exitCode()).toBe(130);
		// Closing the cancel channel does not touch anything else.
		other.handler.onClose?.('normal');
		expect(runner.stopped).toBe(1);
	});

	it('stops a running command on the kill switch and refuses a new one', async () => {
		const { control, open } = setup();
		const { context, handler } = await open(1);
		handler.onJson?.(runMessage('r1'));
		await settled();
		control.pause();
		await settled();
		expect(context.output()).toMatchObject({ reason: 'kill-switch', exitCode: 137 });
		const next = await open(2);
		next.handler.onJson?.(runMessage('r2'));
		await settled();
		expect(next.context.reply('r2')).toMatchObject({ error: { code: 'kill_switch' } });
	});

	it('stops a running command on drain', async () => {
		const { control, open } = setup();
		const { context, handler } = await open(1);
		handler.onJson?.(runMessage('r1'));
		await settled();
		control.startDrain({ type: 'link.drain', graceSec: 60 }, Date.now());
		await settled();
		expect(context.output()).toMatchObject({ reason: 'drain', exitCode: 137 });
	});

	it('refuses a folder outside home and a shell that cannot start', async () => {
		const { runner, open } = setup();
		const first = await open(1);
		first.handler.onJson?.(runMessage('r1', { cwd: '/etc' }));
		await settled();
		expect(first.context.reply('r1')).toMatchObject({ error: { code: 'invalid' } });
		const second = await open(2);
		runner.failNextStart(new Error('spawn /bin/zsh ENOENT\nmore detail'));
		second.handler.onJson?.(runMessage('r2'));
		await settled();
		expect(second.context.reply('r2')).toMatchObject({
			error: { code: 'operation_failed', hint: 'spawn /bin/zsh ENOENT' }
		});
	});

	it('holds the end while the link is down and reports it on resume (U2)', async () => {
		const { runner, open } = setup();
		const { context, handler } = await open();
		handler.onJson?.(runMessage('r1'));
		await settled();
		context.linkUp = false;
		runner.finish(3);
		await settled();
		expect(context.output()).toBeUndefined();
		context.linkUp = true;
		handler.onResume?.();
		expect(context.output()).toMatchObject({ exitCode: 3 });
		expect(context.exitCode()).toBe(3);
	});
});
