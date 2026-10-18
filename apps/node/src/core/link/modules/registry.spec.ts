import { describe, expect, it, vi } from 'vitest';
import { FLEET_NO_CONSENTS, type FleetConsents, type FleetLinkOperationProgressValue } from '@ever-works/contracts';
import { composeNodeLinkModules } from './index';
import { controlModule, createLinkControlState } from './control';
import { createMachineModule } from './machine';
import {
	composeNodeModules,
	MachineVerbError,
	type MachineVerb,
	type NodeChannelContext,
	type NodeModule
} from './registry';
import { manualClock } from '../link-test-kit';

const MANAGE: FleetConsents = { ...FLEET_NO_CONSENTS, manage: true };
const WORK: FleetConsents = { ...FLEET_NO_CONSENTS, work: true };
const env = (consents: FleetConsents) => ({ consents, platform: 'linux', nodeVersion: '0.3.0' });

describe('composeNodeModules', () => {
	it('advertises managed only with --manage (FR-20)', () => {
		const modules = composeNodeModules([controlModule]);
		expect(modules.tags(env(MANAGE))).toEqual(['managed']);
		expect(modules.tags(env(WORK))).toEqual([]);
	});

	it('concatenates tags in module order without duplicates', () => {
		const modules = composeNodeModules([
			controlModule,
			{ id: 'health', tags: () => ['wake', 'managed'] },
			{ id: 'logs', tags: (e) => (e.consents.manage ? ['logs'] : []) }
		]);
		expect(modules.tags(env(MANAGE))).toEqual(['managed', 'wake', 'logs']);
	});

	it('refuses two modules claiming the same id, family, verb or control type', () => {
		const verb: MachineVerb = { stateChanging: false, run: () => null };
		expect(() => composeNodeModules([{ id: 'a' }, { id: 'a' }])).toThrow(/registered twice/);
		expect(() =>
			composeNodeModules([
				{ id: 'a', families: [{ family: 'logs', open: () => ({ ok: true, handler: {} }) }] },
				{ id: 'b', families: [{ family: 'logs', open: () => ({ ok: true, handler: {} }) }] }
			])
		).toThrow(/claimed by two/);
		expect(() =>
			composeNodeModules([
				{ id: 'a', machineVerbs: { 'health.now': verb } },
				{ id: 'b', machineVerbs: { 'health.now': verb } }
			])
		).toThrow(/registered by two/);
		expect(() =>
			composeNodeModules([
				{ id: 'a', controlHandlers: { 'session.answer': () => undefined } },
				{ id: 'b', controlHandlers: { 'session.answer': () => undefined } }
			])
		).toThrow(/handled by two/);
		expect(() => composeNodeModules([{ id: 'a', machineVerbs: { 'Not A Verb': verb } }])).toThrow(
			/not a valid verb/
		);
		expect(() => composeNodeModules([{ id: 'Bad_Id' }])).toThrow(/kebab-case/);
	});

	it('takes the family consent from CONTRACTS unless the module narrows it', () => {
		const modules = composeNodeModules([
			{
				id: 'sessions',
				families: [
					{
						family: 'session',
						consent: (params) => (params.kind === 'agent' ? 'work' : 'manage'),
						open: () => ({ ok: true, handler: {} })
					}
				]
			}
		]);
		expect(modules.familyConsent('session', { kind: 'agent' })).toBe('work');
		expect(modules.familyConsent('session', { kind: 'owner' })).toBe('manage');
		expect(modules.familyConsent('logs', {})).toBe('manage');
		expect(modules.familyConsent('machine', {})).toBe('link');
	});
});

/** A machine channel opened directly, recording what it sends. */
function machineChannel(options: {
	consents?: FleetConsents;
	verbs?: Record<string, MachineVerb>;
	paused?: boolean;
	clock?: ReturnType<typeof manualClock>;
}) {
	const clock = options.clock ?? manualClock();
	const sent: Array<Record<string, unknown>> = [];
	const operations: Array<{ id: string; event: 'progress' | 'done'; value: unknown }> = [];
	const cancels = new Map<string, () => void>();
	const control = createLinkControlState();
	if (options.paused) control.pause();
	const extra: NodeModule = { id: 'facts', machineVerbs: options.verbs ?? {} };
	const modules = composeNodeLinkModules({
		extra: [extra],
		inlineReplyMs: () => 2_000,
		setTimer: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
		clearTimer: (handle) => clock.scheduler.clearTimeout(handle)
	});
	let nextOp = 1;
	const context: NodeChannelContext = {
		channel: 3,
		family: 'machine',
		params: {},
		consents: options.consents ?? MANAGE,
		control,
		nodeVersion: '0.3.0',
		nodeName: 'build-01',
		sendJson: (message) => {
			sent.push(message);
			return true;
		},
		sendBinary: () => true,
		sendControl: () => true,
		close: () => undefined,
		operations: {
			start: (cancel) => {
				const id = `op-${nextOp++}`;
				cancels.set(id, cancel);
				return id;
			},
			progress: (id: string, value: FleetLinkOperationProgressValue) =>
				operations.push({ id, event: 'progress', value }),
			done: (id, value) => operations.push({ id, event: 'done', value })
		}
	};
	const provider = modules.family('machine')!;
	const result = provider.open(context) as {
		ok: true;
		handler: { onJson?(m: Record<string, unknown>): void; onClose?(r: string): void };
	};
	return { clock, sent, operations, cancels, control, handler: result.handler, modules };
}

const settle = async () => {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('the machine family', () => {
	it('replies with the result and echoes the request id (FR-16)', async () => {
		const channel = machineChannel({
			verbs: { 'health.now': { stateChanging: false, run: () => ({ cpuPercent: 31 }) } }
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'health.now', params: {} });
		await settle();
		expect(channel.sent).toEqual([{ requestId: 'r1', result: { cpuPercent: 31 } }]);
	});

	it('answers a verb no module registered with unsupported_on_node, naming it (FR-19, U7)', async () => {
		const channel = machineChannel({});
		channel.handler.onJson?.({ requestId: 'r1', type: 'services.list' });
		await settle();
		expect(channel.sent).toEqual([
			{
				requestId: 'r1',
				error: {
					code: 'unsupported_on_node',
					hint: 'build-01 (node 0.3.0) cannot do this yet: services.list',
					details: { verb: 'services.list', nodeVersion: '0.3.0' }
				}
			}
		]);
	});

	it('refuses a manage verb on a --work node itself, whatever the platform asked (FR-24)', async () => {
		const run = vi.fn();
		const channel = machineChannel({
			consents: WORK,
			verbs: { 'services.list': { stateChanging: false, run } }
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'services.list' });
		await settle();
		expect(run).not.toHaveBeenCalled();
		expect(channel.sent[0]).toMatchObject({
			requestId: 'r1',
			error: { code: 'consent_missing', hint: 'start the node with --manage on build-01' }
		});
	});

	it('runs health.now on any open link (R-31 exception table)', async () => {
		const channel = machineChannel({
			consents: WORK,
			verbs: { 'health.now': { stateChanging: false, run: () => 'ok' } }
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'health.now' });
		await settle();
		expect(channel.sent).toEqual([{ requestId: 'r1', result: 'ok' }]);
	});

	it('refuses state-changing verbs while paused but keeps answering reads (kill switch)', async () => {
		const restart = vi.fn();
		const channel = machineChannel({
			paused: true,
			verbs: {
				'services.action': { stateChanging: true, run: restart },
				'services.list': { stateChanging: false, run: () => [] }
			}
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'services.action' });
		channel.handler.onJson?.({ requestId: 'r2', type: 'services.list' });
		await settle();
		expect(restart).not.toHaveBeenCalled();
		expect(channel.sent).toEqual([
			{ requestId: 'r1', error: { code: 'kill_switch', hint: 'clear it under Settings → Fleet' } },
			{ requestId: 'r2', result: [] }
		]);
	});

	it('turns a request that runs over 2 s into an operation with progress and a result (FR-17)', async () => {
		let resolve!: (value: unknown) => void;
		const channel = machineChannel({
			verbs: {
				'docker.image.pull': {
					stateChanging: true,
					run: (context) => {
						context.progress({ percent: 10, message: 'resolving' });
						return new Promise((done) => {
							resolve = done;
						});
					}
				}
			}
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'docker.image.pull' });
		await settle();
		expect(channel.sent).toEqual([]);
		channel.clock.advance(1_999);
		expect(channel.sent).toEqual([]);
		channel.clock.advance(1);
		expect(channel.sent).toEqual([{ requestId: 'r1', operationId: 'op-1' }]);
		// The progress reported before the switch is carried over.
		expect(channel.operations).toEqual([
			{ id: 'op-1', event: 'progress', value: { percent: 10, message: 'resolving' } }
		]);
		resolve({ digest: 'sha256:abc' });
		await settle();
		expect(channel.operations[1]).toEqual({
			id: 'op-1',
			event: 'done',
			value: { result: { digest: 'sha256:abc' } }
		});
		// The inline reply never comes once it became an operation.
		expect(channel.sent).toHaveLength(1);
	});

	it('aborts a cancelled operation and reports it failed', async () => {
		const channel = machineChannel({
			verbs: {
				'compose.up': {
					stateChanging: true,
					run: (context) =>
						new Promise((_, reject) =>
							context.signal.addEventListener('abort', () => reject(new Error('aborted')))
						)
				}
			}
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'compose.up' });
		await settle();
		channel.clock.advance(2_000);
		channel.cancels.get('op-1')!();
		await settle();
		expect(channel.operations.at(-1)).toEqual({
			id: 'op-1',
			event: 'done',
			value: { error: { code: 'operation_failed', hint: 'cancelled' } }
		});
	});

	it('carries a typed refusal and only the first line of anything else', async () => {
		const channel = machineChannel({
			verbs: {
				'services.action': {
					stateChanging: true,
					run: () => {
						throw new MachineVerbError({ code: 'root_required', hint: 'on build-01 run: sudo visudo' });
					}
				},
				'services.list': {
					stateChanging: false,
					run: async () => {
						throw new Error('systemctl failed\nsecret stack line');
					}
				}
			}
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'services.action' });
		channel.handler.onJson?.({ requestId: 'r2', type: 'services.list' });
		await settle();
		expect(channel.sent).toEqual([
			{ requestId: 'r1', error: { code: 'root_required', hint: 'on build-01 run: sudo visudo' } },
			{ requestId: 'r2', error: { code: 'operation_failed', hint: 'systemctl failed' } }
		]);
	});

	it('answers a malformed request invalid and drops one without an id', async () => {
		const channel = machineChannel({});
		channel.handler.onJson?.({ requestId: 'r1', params: {} });
		channel.handler.onJson?.({ type: 'health.now' });
		await settle();
		expect(channel.sent).toEqual([
			{
				requestId: 'r1',
				error: { code: 'invalid', hint: 'a request needs a requestId, a type and object params' }
			}
		]);
	});

	it('stops waiting for inline requests when the channel closes', async () => {
		let aborted = false;
		const channel = machineChannel({
			verbs: {
				'ports.list': {
					stateChanging: false,
					run: (context) =>
						new Promise((resolve) =>
							context.signal.addEventListener('abort', () => {
								aborted = true;
								resolve([]);
							})
						)
				}
			}
		});
		channel.handler.onJson?.({ requestId: 'r1', type: 'ports.list' });
		await settle();
		channel.handler.onClose?.('normal');
		await settle();
		expect(aborted).toBe(true);
		expect(channel.sent).toEqual([]);
	});

	it('is a resumable channel and part of every composed module list', () => {
		const channel = machineChannel({});
		expect((channel.handler as { resumeKey?: string }).resumeKey).toBe('machine');
		expect(channel.modules.modules.map((module) => module.id).slice(0, 2)).toEqual(['control', 'machine']);
		expect(createMachineModule({ verb: () => undefined }).families?.[0]?.family).toBe('machine');
	});
});
