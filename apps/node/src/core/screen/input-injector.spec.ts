import { describe, expect, it, vi } from 'vitest';
import type { ComputerInputFrame } from '@ever-works/contracts';
import {
	AGENT_CONTROL_MARKER_FILE,
	AGENT_CONTROL_MARKER_MESSAGE,
	createAgentControlMarker
} from './agent-control-marker';
import { ComputerInputInjector } from './input-injector';

/**
 * The last gate before a person's input reaches the Agent's browser. Pinned:
 * nothing is injected unless control is held; only pointer, key, wheel and
 * text frames are, and a blocked shortcut never is; a fuzz of unexpected
 * frames injects nothing and throws nothing; and the Agent is told when a
 * person has control and when they gave it back.
 */

const pointer: ComputerInputFrame = { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' };
const key: ComputerInputFrame = { kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 };
const text: ComputerInputFrame = { kind: 'text', text: 'hello' };
const scroll: ComputerInputFrame = { kind: 'scroll', x: 5, y: 5, dx: 0, dy: 120 };

function harness() {
	const dispatched: ComputerInputFrame[] = [];
	const target = {
		dispatchInput: vi.fn(async (frame: ComputerInputFrame) => {
			dispatched.push(frame);
		})
	};
	const changes: boolean[] = [];
	const injector = new ComputerInputInjector({
		target: () => target,
		onControlChange: (controlled) => {
			changes.push(controlled);
		}
	});
	return { injector, target, dispatched, changes };
}

describe('ComputerInputInjector', () => {
	it('injects nothing while nobody in this view holds control', async () => {
		const { injector, dispatched } = harness();
		for (const frame of [pointer, key, text, scroll]) {
			expect(await injector.inject(frame)).toBe('not-controlled');
		}
		expect(dispatched).toEqual([]);
	});

	it('injects pointer, key, wheel and text in order while control is held, and stops when it is given back', async () => {
		const { injector, dispatched, changes } = harness();
		injector.setControlled(true);
		const outcomes = await Promise.all([pointer, key, text, scroll].map((frame) => injector.inject(frame)));
		expect(outcomes).toEqual(['injected', 'injected', 'injected', 'injected']);
		expect(dispatched).toEqual([pointer, key, text, scroll]);

		injector.setControlled(false);
		expect(await injector.inject(pointer)).toBe('not-controlled');
		expect(dispatched).toHaveLength(4);
		await injector.idle();
		expect(changes).toEqual([true, false]);
	});

	it('never injects input that arrived before control was taken, even when the change overtakes it in the queue', async () => {
		const { injector, dispatched } = harness();
		const early = injector.inject(pointer);
		injector.setControlled(true);
		const late = injector.inject(key);
		expect(await early).toBe('not-controlled');
		expect(await late).toBe('injected');
		expect(dispatched).toEqual([key]);
	});

	it('refuses blocked shortcuts — clipboard, window and tab combinations — even while controlling', async () => {
		const { injector, dispatched } = harness();
		injector.setControlled(true);
		for (const code of ['KeyV', 'KeyC', 'KeyW']) {
			expect(await injector.inject({ kind: 'key', action: 'down', key: 'v', code, modifiers: 2 })).toBe(
				'refused-shortcut'
			);
		}
		expect(await injector.inject({ kind: 'key', action: 'down', key: 'Tab', code: 'Tab', modifiers: 1 })).toBe(
			'refused-shortcut'
		);
		expect(dispatched).toEqual([]);
	});

	it('injects nothing and throws nothing for a fuzz of unexpected frames', async () => {
		const { injector, dispatched } = harness();
		injector.setControlled(true);
		const junk: unknown[] = [
			null,
			undefined,
			42,
			'pointer',
			[],
			{},
			{ kind: 'clipboard', text: 'secret' },
			{ kind: 'drop', files: ['/etc/passwd'] },
			{ kind: 'frame', seq: 1, keyframe: true, width: 1, height: 1, mime: 'image/png', data: 'QUJD' },
			{ kind: 'refresh' },
			{ kind: 'mode', mode: 'controlling' },
			{ kind: 'pointer', action: 'drag', x: 1, y: 1, button: 'left' },
			{ kind: 'pointer', action: 'down', x: -1, y: 1, button: 'left' },
			{ kind: 'key', action: 'down', key: 'a'.repeat(200), code: 'KeyA', modifiers: 0 },
			{ kind: 'text', text: '' },
			{ kind: 'scroll', x: 1, y: 1, dx: 1e9, dy: 0 },
			{ kind: 'text', text: 'x', __proto__: { polluted: true } },
			Object.create(null)
		];
		for (const frame of junk) {
			const outcome = await injector.inject(frame);
			expect(['refused-kind', 'injected']).toContain(outcome);
		}
		// The only one that is a real input frame is the `text` with a prototype key.
		expect(dispatched).toEqual([{ kind: 'text', text: 'x' }]);
	});

	it('says so, without throwing, when there is nothing to drive or the browser refuses', async () => {
		const noTarget = new ComputerInputInjector({ target: () => null });
		noTarget.setControlled(true);
		expect(await noTarget.inject(pointer)).toBe('no-target');

		const noInput = new ComputerInputInjector({ target: () => ({}) });
		noInput.setControlled(true);
		expect(await noInput.inject(pointer)).toBe('no-target');

		const warn = vi.fn();
		const failing = new ComputerInputInjector({
			target: () => ({
				dispatchInput: async () => {
					throw new Error('Target closed');
				}
			}),
			logger: { warn } as never
		});
		failing.setControlled(true);
		expect(await failing.inject(text)).toBe('failed');
		expect(await failing.inject(key)).toBe('failed');
		// A person's keystrokes never reach a log line.
		expect(JSON.stringify(warn.mock.calls)).not.toContain('hello');
	});

	it('survives a control-change hook that fails', async () => {
		const warn = vi.fn();
		const injector = new ComputerInputInjector({
			target: () => ({ dispatchInput: async () => undefined }),
			onControlChange: async () => {
				throw new Error('disk full');
			},
			logger: { warn } as never
		});
		injector.setControlled(true);
		await injector.idle();
		expect(await injector.inject(pointer)).toBe('injected');
		expect(warn).toHaveBeenCalled();
	});
});

describe('createAgentControlMarker', () => {
	it('writes the marker in the Agent’s own profile directory while control is held, and removes it after', async () => {
		const files = new Map<string, string>();
		const fs = {
			writeTextFile: vi.fn(async (path: string, content: string) => {
				files.set(path, content);
			}),
			rm: vi.fn(async (path: string) => {
				files.delete(path);
			})
		};
		const marker = createAgentControlMarker({
			profileDir: '/profiles/abc',
			fs,
			clock: () => new Date('2026-09-14T09:00:00.000Z')
		});

		await marker.set(true);
		const [path] = [...files.keys()];
		expect(path.replace(/\\/g, '/')).toBe(`/profiles/abc/${AGENT_CONTROL_MARKER_FILE}`);
		expect(JSON.parse(files.get(path) as string)).toEqual({
			controlledByPerson: true,
			since: '2026-09-14T09:00:00.000Z',
			message: AGENT_CONTROL_MARKER_MESSAGE
		});

		await marker.set(false);
		expect(files.size).toBe(0);
	});
});
